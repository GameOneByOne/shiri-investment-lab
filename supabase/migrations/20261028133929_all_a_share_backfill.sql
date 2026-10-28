-- Bounded rolling window: never materialize the entire market's payload queue.
alter table market.securities add column nightly boolean not null default true;
alter table market.collection_tasks add column available_at timestamptz not null default now();
create table market.bulk_control (
  id boolean primary key default true check(id),
  state text not null default 'cataloguing',
  started_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  cutoff date not null default (now() at time zone 'Asia/Shanghai')::date,
  catalog_page integer not null default 1, catalog_total integer, catalog_complete boolean not null default false,
  catalog_lease timestamptz, catalog_next_at timestamptz not null default now(),
  catalog_failures integer not null default 0,
  next_request_at timestamptz not null default now(), blocked_until timestamptz,
  consecutive_failures integer not null default 0,
  capacity_bytes bigint not null default 398458880 check(capacity_bytes between 33554432 and 400000000),
  database_bytes bigint, last_error text, source text not null default 'https://82.push2.eastmoney.com/api/qt/clist/get'
);
create table market.bulk_members (
  symbol text primary key references market.securities(symbol), ordinal integer not null unique,
  listed_date date not null, exchange text not null check(exchange in ('sh','sz','bj')),
  status text not null default 'queued' check(status in ('queued','collecting','completed','partial','failed')),
  run_id uuid unique references market.collection_runs(id),
  requests_total integer not null, requests_done integer not null default 0, requests_failed integer not null default 0,
  price_rows integer not null default 0, dividend_rows integer not null default 0,
  started_at timestamptz, finished_at timestamptz, error text
);
create index bulk_members_status on market.bulk_members(status,ordinal);
create table market.bulk_progress (
  id boolean primary key default true check(id), snapshot jsonb not null, updated_at timestamptz not null default now()
);
alter table market.bulk_control enable row level security;
alter table market.bulk_members enable row level security;
alter table market.bulk_progress enable row level security;
create policy service_bulk_control on market.bulk_control to service_role using(true) with check(true);
create policy service_bulk_members on market.bulk_members to service_role using(true) with check(true);
create policy service_bulk_progress on market.bulk_progress to service_role using(true) with check(true);
create policy public_bulk_progress on market.bulk_progress for select to anon,authenticated using(true);
grant all on market.bulk_control,market.bulk_members,market.bulk_progress to service_role;
grant select on market.bulk_progress to anon,authenticated;

create function public.market_bulk_progress() returns jsonb language sql stable security invoker set search_path='' as $$
  select snapshot||jsonb_build_object('snapshotAt',updated_at) from market.bulk_progress where id
$$;

create function public.market_bulk_refresh_progress() returns void language plpgsql security invoker set search_path='' as $$
declare c market.bulk_control; data jsonb;
begin
  select * into c from market.bulk_control where id;
  if c.id is null then return; end if;
  select jsonb_build_object(
    'state',c.state,'startedAt',c.started_at,'cutoff',c.cutoff,'historyStart','2020-01-01',
    'catalogue',jsonb_build_object('source',c.source,'nextPage',c.catalog_page,'expectedStocks',c.catalog_total,
      'discoveredStocks',count(*),'complete',c.catalog_complete,'nextAttemptAt',c.catalog_next_at),
    'stocks',jsonb_build_object('total',c.catalog_total,'queued',count(*) filter(where status='queued'),
      'collecting',count(*) filter(where status='collecting'),'completed',count(*) filter(where status='completed'),
      'partial',count(*) filter(where status='partial'),'failed',count(*) filter(where status='failed')),
    'requests',jsonb_build_object('totalKnown',coalesce(sum(requests_total),0),
      'completed',coalesce(sum(requests_done),0)+(select count(*) from market.collection_tasks t join market.bulk_members m on m.run_id=t.run_id where m.status='collecting' and t.status='completed'),
      'failed',coalesce(sum(requests_failed),0)+(select count(*) from market.collection_tasks t join market.bulk_members m on m.run_id=t.run_id where m.status='collecting' and t.status='failed')),
    'published',jsonb_build_object('priceRows',coalesce(sum(price_rows),0),'dividendRows',coalesce(sum(dividend_rows),0)),
    'capacity',jsonb_build_object('databaseBytes',c.database_bytes,'pauseAtBytes',c.capacity_bytes,'plan','free'),
    'blockedUntil',c.blocked_until,'lastError',c.last_error,
    'recentFailures',coalesce((select jsonb_agg(x) from (select symbol,status,error,finished_at from market.bulk_members
      where status in ('partial','failed') order by finished_at desc limit 10) x),'[]'::jsonb),
    'ratePolicy',jsonb_build_object('concurrency',1,'minimumIntervalSeconds',6,'maximumAttempts',3,'restrictionCooldownHours',24)
  ) into data from market.bulk_members;
  insert into market.bulk_progress(id,snapshot) values(true,data)
    on conflict(id) do update set snapshot=excluded.snapshot,updated_at=now();
end $$;

-- Called before claiming work. Check the real database footprint every minute.
create function public.market_bulk_pump() returns void language plpgsql security invoker set search_path='' as $$
declare c market.bulk_control; m market.bulk_members; rid uuid; cutoff date; sec jsonb; endyear integer;
begin
  perform pg_advisory_xact_lock(8627340102);
  select * into c from market.bulk_control where id for update;
  if c.id is null then return; end if;
  update market.bulk_control set database_bytes=pg_database_size(current_database()),updated_at=now() where id returning * into c;
  -- A completed run is summarized durably before its staging rows are removed.
  for m in select b.* from market.bulk_members b join market.collection_runs r on r.id=b.run_id where b.status='collecting' and r.status<>'running' loop
    update market.bulk_members set status=case when r.status='success' then 'completed' when exists(select 1 from market.price_series where symbol=m.symbol and last_run_id=m.run_id) then 'partial' else 'failed' end,
      requests_done=(select count(*) from market.collection_tasks where run_id=m.run_id and status='completed'),
      requests_failed=(select count(*) from market.collection_tasks where run_id=m.run_id and status='failed'),
      price_rows=(select coalesce(sum(row_count),0) from market.price_series where symbol=m.symbol),
      dividend_rows=(select coalesce(sum(row_count),0) from market.dividend_series where symbol=m.symbol),
      error=nullif(r.errors::text,'[]'),finished_at=now()
      from market.collection_runs r where r.id=m.run_id and market.bulk_members.symbol=m.symbol;
    delete from market.collection_tasks where run_id=m.run_id;
  end loop;
  if c.database_bytes>=c.capacity_bytes then
    update market.bulk_control set state='paused_capacity',last_error='Free-plan safety threshold reached; no further bulk downloads will be started' where id;
  elsif c.state not in ('paused_manual','paused_capacity') then
    if c.blocked_until>now() then
      update market.bulk_control set state='paused_provider' where id;
    else
      update market.bulk_control set state=case when c.catalog_complete then 'running' else 'cataloguing' end where id;
      if c.catalog_complete and (select count(*) from market.bulk_members where status='collecting')<2 then
        select * into m from market.bulk_members where status='queued' order by ordinal for update skip locked limit 1;
        if m.symbol is not null then
          cutoff:=c.cutoff; endyear:=extract(year from cutoff)::integer;
          select jsonb_build_object('symbol',symbol,'name',name,'kind',kind,'pinyin',pinyin,'start',start_date) into sec from market.securities where symbol=m.symbol;
          insert into market.collection_runs default values returning id into rid;
          insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
            select rid,m.symbol,y,sec,cutoff,'prices',a from generate_series(extract(year from (sec->>'start')::date)::integer,endyear) y
            cross join unnest(array['none','qfq','hfq']) a;
          insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
            values(rid,m.symbol,endyear,sec,cutoff,'dividends','none');
          update market.bulk_members set status='collecting',run_id=rid,started_at=now() where symbol=m.symbol;
        end if;
      end if;
      if c.catalog_complete and not exists(select 1 from market.bulk_members where status in ('queued','collecting')) then
        update market.bulk_control set state=case when exists(select 1 from market.bulk_members where status in ('partial','failed')) then 'completed_with_errors' else 'completed' end where id;
      end if;
    end if;
  end if;
  perform public.market_bulk_refresh_progress();
end $$;

create function public.market_bulk_catalog_claim() returns jsonb language plpgsql security invoker set search_path='' as $$
declare c market.bulk_control;
begin
  select * into c from market.bulk_control where id for update;
  if c.id is null or c.catalog_complete or c.state in ('paused_manual','paused_capacity') or c.blocked_until>now()
    or c.catalog_next_at>now() or c.catalog_lease>now() then return null; end if;
  update market.bulk_control set catalog_lease=now()+interval '2 minutes' where id;
  return jsonb_build_object('page',c.catalog_page,'source',c.source);
end $$;

create function public.market_bulk_catalog_complete(p_page integer,p_total integer,p_stocks jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare c market.bulk_control; n integer; expected integer;
begin
  select * into c from market.bulk_control where id for update;
  if c.catalog_page<>p_page or c.catalog_lease is null or c.catalog_complete then raise exception 'Stale catalogue page'; end if;
  if p_total not between 4000 and 12000 or (c.catalog_total is not null and c.catalog_total<>p_total) then raise exception 'Catalogue total changed'; end if;
  expected:=least(100,p_total-(p_page-1)*100);
  if jsonb_typeof(p_stocks) is distinct from 'array' or jsonb_array_length(p_stocks)<>expected or expected<1 then raise exception 'Incomplete catalogue page'; end if;
  if exists(select 1 from jsonb_to_recordset(p_stocks) s(symbol text,name text,listed date,start date,exchange text)
    where s.symbol !~ '^(sh6|sz[03]|bj[489])[0-9]{5}$' or s.symbol is null or s.name is null or s.listed is null or s.listed>c.cutoff
    or s.start is distinct from greatest(date '2020-01-01',s.listed) or s.exchange is distinct from left(s.symbol,2))
    then raise exception 'Invalid catalogue identity'; end if;
  if exists(select 1 from jsonb_to_recordset(p_stocks) s(symbol text) join market.bulk_members b using(symbol)) then raise exception 'Duplicate catalogue member'; end if;
  insert into market.securities(symbol,name,kind,start_date,adjust,enabled,nightly)
    select symbol,name,'股票',start,'qfq',false,false from jsonb_to_recordset(p_stocks) s(symbol text,name text,start date)
    on conflict(symbol) do update set name=excluded.name;
  insert into market.bulk_members(symbol,ordinal,listed_date,exchange,requests_total)
    select s->>'symbol',(p_page-1)*100+ord::integer,(s->>'listed')::date,s->>'exchange',
      (extract(year from c.cutoff)::integer-extract(year from (s->>'start')::date)::integer+1)*3+1
    from jsonb_array_elements(p_stocks) with ordinality x(s,ord);
  select count(*) into n from market.bulk_members;
  if p_page*100>=p_total and n<>p_total then raise exception 'Catalogue universe incomplete'; end if;
  update market.bulk_control set catalog_page=p_page+1,catalog_total=p_total,catalog_complete=n=p_total,
    catalog_lease=null,catalog_next_at=now()+interval '60 seconds',catalog_failures=0,last_error=null where id;
  perform public.market_bulk_refresh_progress();
end $$;

create function public.market_bulk_catalog_fail(p_page integer,p_error text,p_restricted boolean default false) returns void
language plpgsql security invoker set search_path='' as $$
begin
  update market.bulk_control set catalog_lease=null,catalog_failures=catalog_failures+1,last_error=left(p_error,300),
    catalog_next_at=now()+case when p_restricted then interval '24 hours' else least(interval '6 hours',interval '30 minutes'*power(2,least(catalog_failures,4))) end
    where id and catalog_page=p_page;
  perform public.market_bulk_refresh_progress();
end $$;

-- Both the nightly eight-symbol worker and the bulk worker share this gate.
create or replace function public.market_claim_task() returns jsonb language plpgsql security invoker set search_path='' as $$
declare task market.collection_tasks; c market.bulk_control; isbulk boolean;
begin
  perform pg_advisory_xact_lock(8627340103);
  update market.collection_tasks set status='failed',error='Worker lease expired after 3 attempts'
    where status='running' and lease_until<now() and attempts>=3;
  perform public.market_close_finished_runs();
  select * into c from market.bulk_control where id for update;
  if c.blocked_until>now() or c.next_request_at>now() or exists(select 1 from market.collection_tasks where status='running' and lease_until>now()) then return null; end if;
  select t.* into task from market.collection_tasks t left join market.bulk_members m on m.run_id=t.run_id
    where t.attempts<3 and t.available_at<=now() and (t.status='pending' or (t.status='running' and t.lease_until<now()))
      and (m.symbol is null or c.state in ('running','cataloguing'))
    order by (m.symbol is not null),t.attempts,t.run_id,t.dataset desc,t.adjust,t.year for update of t skip locked limit 1;
  if task.id is null then return null; end if;
  isbulk:=exists(select 1 from market.bulk_members where run_id=task.run_id);
  -- Keep the oldest lease stale-safe; never publish a late worker attempt.
  update market.collection_tasks set status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes' where id=task.id returning * into task;
  update market.bulk_control set next_request_at=now()+interval '6 seconds'+random()*interval '2 seconds' where id;
  return (to_jsonb(task)-'bars'-'error')||jsonb_build_object('bulk',isbulk);
end $$;

create or replace function public.market_fail_task(p_id uuid,p_attempt integer,p_error text) returns void
language plpgsql security invoker set search_path='' as $$
declare restricted boolean:=p_error ~ 'HTTP (403|429)|Retry-After'; changed integer;
begin
  update market.collection_tasks set status=case when attempts>=3 then 'failed' else 'pending' end,
    error=left(p_error,300),lease_until=null,available_at=now()+least(interval '6 hours',interval '15 minutes'*power(2,least(attempts-1,4)))
    where id=p_id and status='running' and attempts=p_attempt;
  get diagnostics changed=row_count;
  if changed=0 then return; end if;
  update market.bulk_control set consecutive_failures=consecutive_failures+1,last_error=left(p_error,300),
    blocked_until=case when restricted then now()+interval '24 hours' when consecutive_failures>=2 then now()+interval '1 hour' else blocked_until end where id;
  perform public.market_close_finished_runs();
end $$;

-- Use the existing strict publisher, then release staging once that mode is live.
create or replace function public.market_complete_task(p_id uuid,p_attempt integer,p_bars jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare task market.collection_tasks; all_bars jsonb;
begin
  select * into task from market.collection_tasks where id=p_id for update;
  if task.status is distinct from 'running' or task.attempts<>p_attempt then raise exception 'Stale task attempt'; end if;
  if jsonb_typeof(p_bars) is distinct from 'array' then raise exception 'Invalid task payload'; end if;
  if task.dataset='prices' and exists(select 1 from jsonb_to_recordset(p_bars) b(date date)
    where b.date is null or extract(year from b.date)<>task.year or b.date>task.end_date or b.date<(task.security->>'start')::date) then raise exception 'Invalid year snapshot'; end if;
  update market.collection_tasks set status='completed',bars=p_bars,lease_until=null,error=null where id=p_id;
  perform pg_advisory_xact_lock(hashtextextended(task.run_id::text||task.symbol||task.dataset||task.adjust,0));
  if task.dataset='dividends' then
    perform public.market_publish_dividends(task.security,p_bars,task.run_id);
    update market.collection_tasks set bars=null where id=p_id;
  elsif not exists(select 1 from market.collection_tasks where run_id=task.run_id and symbol=task.symbol and dataset=task.dataset and adjust=task.adjust and status<>'completed') then
    select jsonb_agg(b.value order by b.value->>'date') into all_bars from market.collection_tasks t cross join lateral jsonb_array_elements(t.bars) b
      where t.run_id=task.run_id and t.symbol=task.symbol and t.dataset=task.dataset and t.adjust=task.adjust;
    perform public.market_publish_prices(task.security,task.adjust,all_bars,task.run_id);
    update market.collection_tasks set bars=null where run_id=task.run_id and symbol=task.symbol and dataset=task.dataset and adjust=task.adjust;
    if task.adjust='qfq' then update market.securities set enabled=true where symbol=task.symbol; end if;
  end if;
  update market.bulk_control set consecutive_failures=0 where id;
  perform public.market_close_finished_runs();
end $$;

-- New bulk symbols are not silently added to the old full-history nightly job.
create or replace function public.market_enqueue() returns uuid language plpgsql security invoker set search_path='' as $$
declare rid uuid; cutoff date;
begin
  perform pg_advisory_xact_lock(8627340101);
  if exists(select 1 from market.collection_runs r where r.status='running' and not exists(select 1 from market.bulk_members b where b.run_id=r.id)) then return null; end if;
  cutoff:=(now() at time zone 'Asia/Shanghai')::date;
  if extract(hour from now() at time zone 'Asia/Shanghai')<16 then cutoff:=cutoff-1; end if;
  insert into market.collection_runs default values returning id into rid;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
    select rid,s.symbol,y,jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,'start',s.start_date),cutoff,'prices',m
    from market.securities s cross join lateral generate_series(extract(year from s.start_date)::integer,extract(year from cutoff)::integer) y
    cross join lateral unnest(case when s.kind='指数' then array['none'] else array['none','qfq','hfq'] end) m where s.enabled and s.nightly;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
    select rid,s.symbol,extract(year from cutoff)::integer,jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,'start',s.start_date),cutoff,'dividends','none'
    from market.securities s where s.enabled and s.nightly and s.kind<>'指数';
  return rid;
end $$;

revoke all on function public.market_bulk_pump(),public.market_bulk_refresh_progress(),public.market_bulk_catalog_claim(),
  public.market_bulk_catalog_complete(integer,integer,jsonb),public.market_bulk_catalog_fail(integer,text,boolean) from public,anon,authenticated;
grant execute on function public.market_bulk_pump(),public.market_bulk_refresh_progress(),public.market_bulk_catalog_claim(),
  public.market_bulk_catalog_complete(integer,integer,jsonb),public.market_bulk_catalog_fail(integer,text,boolean) to service_role;
revoke all on function public.market_bulk_progress() from public;
grant execute on function public.market_bulk_progress() to anon,authenticated,service_role;

-- Progress rows and member/run summaries survive staging cleanup.
select cron.schedule('shiri-queue-cleanup','30 12 * * *',$$
  delete from market.collection_tasks where run_id in (select id from market.collection_runs where finished_at<now()-interval '2 days');
  delete from market.collection_runs r where r.finished_at<now()-interval '30 days' and not exists(select 1 from market.bulk_members b where b.run_id=r.id);
  delete from cron.job_run_details where end_time<now()-interval '7 days';
$$);
-- Activation is a separate, explicit operation after verification.

create or replace function public.market_config() returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('lastCompleteDate',(select max(trade_date) from market.daily_bars where symbol='sh000001'),
    'popular',coalesce((select jsonb_agg(jsonb_build_object('symbol',symbol,'name',name,'kind',kind) order by symbol)
      from market.securities where enabled and nightly),'[]'::jsonb))
$$;
