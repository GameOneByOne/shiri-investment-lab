-- Lossless conversion: retain ALL existing dates and instruments, including archives.
set lock_timeout='10s';
lock table market.price_daily in share mode;
alter table market.securities add column id smallint generated always as identity;
alter table market.securities add constraint securities_id_key unique(id);
create function market.valid_price_block(y smallint,ds smallint[],ps integer[]) returns boolean
language sql immutable strict security invoker set search_path='' as $$
 select coalesce(array_ndims(ds)=1 and array_ndims(ps)=1 and array_lower(ds,1)=1 and array_lower(ps,1)=1
 and cardinality(ds) between 1 and 366 and cardinality(ds)=cardinality(ps)
 and not exists(select 1 from generate_subscripts(ds,1) i where ds[i] is null or ps[i] is null or ps[i]<=0
 or ds[i]<1 or ds[i]>extract(doy from make_date(y,12,31)) or (i>1 and ds[i]<=ds[i-1])),false)
$$;
revoke all on function market.valid_price_block(smallint,smallint[],integer[]) from public;
grant execute on function market.valid_price_block(smallint,smallint[],integer[]) to service_role;
create table market.price_yearly(
 security_id smallint not null references market.securities(id),
 trade_year smallint not null check(trade_year between 1990 and 2200),
 price_scale smallint not null check(price_scale in (100,1000)),
 days smallint[] not null,
 close_units integer[] not null,
 primary key(security_id,trade_year),
 check(market.valid_price_block(trade_year,days,close_units))
);
alter table market.price_yearly enable row level security;
create policy public_yearly_prices on market.price_yearly for select to anon,authenticated using
 (exists(select 1 from market.securities s where s.id=security_id and s.enabled));
grant select on market.price_yearly to anon,authenticated;
grant all on market.price_yearly to service_role;
grant usage,select on sequence market.securities_id_seq to service_role;
-- Reject instead of rounding prices that would lose precision or exceed int32.
do $$ begin
 if exists(select 1 from market.price_daily p join market.securities s using(symbol)
 where p.close*(case when s.kind='ETF' then 1000 else 100 end)<>trunc(p.close*(case when s.kind='ETF' then 1000 else 100 end))
 or p.close*(case when s.kind='ETF' then 1000 else 100 end)>2147483647) then raise exception 'Prices cannot be represented losslessly'; end if;
end $$;
insert into market.price_yearly(security_id,trade_year,price_scale,days,close_units)
select s.id,extract(year from p.trade_date)::smallint,(case when s.kind='ETF' then 1000 else 100 end)::smallint,
 array_agg(extract(doy from p.trade_date)::smallint order by p.trade_date),
 array_agg((p.close*(case when s.kind='ETF' then 1000 else 100 end))::integer order by p.trade_date)
from market.price_daily p join market.securities s using(symbol)
group by s.id,extract(year from p.trade_date),s.kind;
-- Compare every original date and price, grouped into exact arrays. No sampling.
do $$ begin
 if exists(
 select 1 from (
 select s.id,extract(year from p.trade_date)::smallint y,
 array_agg(extract(doy from p.trade_date)::smallint order by p.trade_date) ds,
 array_agg((p.close*(case when s.kind='ETF' then 1000 else 100 end))::integer order by p.trade_date) ps
 from market.price_daily p join market.securities s using(symbol) group by s.id,extract(year from p.trade_date),s.kind
 ) old full join market.price_yearly n on n.security_id=old.id and n.trade_year=old.y
 where old.id is null or n.security_id is null or old.ds is distinct from n.days or old.ps is distinct from n.close_units
 ) then raise exception 'Annual migration verification failed'; end if;
end $$;
create or replace function public.market_prices(p_symbol text,p_start date,p_end date,p_adjust text default 'none') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_symbol is null or p_symbol !~ '^(sh|sz|bj)[0-9]{6}$' or p_adjust is distinct from 'none'
 or p_start is null or p_end is null or p_start<date '2021-01-01' or p_end<p_start
 or p_end>(now() at time zone 'Asia/Shanghai')::date then raise exception '请输入有效的代码、日期和复权口径。' using errcode='22023'; end if;
 select jsonb_build_object('symbol',s.symbol,'source',m.source,'adjust','none','cached',true,'fetchedAt',m.fetched_at,
 'firstDate',min(b.trade_date),'lastDate',max(b.trade_date),
 'bars',jsonb_agg(jsonb_build_object('date',b.trade_date,'close',b.close) order by b.trade_date)) into result
 from market.securities s join market.price_series m on m.symbol=s.symbol and m.adjust='none'
 join market.price_yearly a on a.security_id=s.id and a.trade_year between extract(year from p_start) and extract(year from p_end)
 cross join lateral (select make_date(a.trade_year,1,1)+u.d-1 as trade_date,u.c::numeric/a.price_scale as close
 from unnest(a.days,a.close_units) u(d,c)) b
 where s.symbol=p_symbol and s.enabled and b.trade_date between p_start and p_end group by s.symbol,m.source,m.fetched_at;
 if result is null then raise exception '所选口径或区间暂无已采集行情。' using errcode='22023'; end if;
 return result;
end $$;
create or replace function public.market_publish_prices(p_security jsonb,p_adjust text,p_bars jsonb,p_run_id uuid default null) returns integer
language plpgsql security invoker set search_path='' as $$
declare sym text:=p_security->>'symbol'; sid smallint; scale_factor smallint; n integer; history_start date;
begin
 if sym is null or sym !~ '^(sh|sz|bj)[0-9]{6}$' or p_adjust is distinct from 'none'
 or jsonb_typeof(p_bars) is distinct from 'array' or jsonb_array_length(p_bars) not between 1 and 20000
 or p_security->>'kind' not in ('股票','ETF','指数') then raise exception 'Invalid price snapshot'; end if;
 perform pg_advisory_xact_lock(hashtextextended(sym,0));
 scale_factor:=case when p_security->>'kind'='ETF' then 1000 else 100 end;
 history_start:=greatest((p_security->>'start')::date,date '2021-01-01');
 if exists(select 1 from jsonb_to_recordset(p_bars) b(date date,close numeric) where b.date is null or b.close is null or b.close<=0
 or b.close*scale_factor>2147483647 or b.close*scale_factor<>trunc(b.close*scale_factor)
 or b.date<history_start or b.date>(now() at time zone 'Asia/Shanghai')::date)
 or (select count(*)<>count(distinct b.date) from jsonb_to_recordset(p_bars)b(date date)) then
 raise exception 'Invalid price precision, date or duplicate'; end if;
 if exists(select 1 from market.securities where symbol=sym and kind is distinct from p_security->>'kind') then raise exception 'Security kind cannot change during price publication'; end if;
 select id into sid from market.securities where symbol=sym;
 if exists(select 1 from market.price_yearly a cross join lateral unnest(a.days) u(d)
 where a.security_id=sid and make_date(a.trade_year,1,1)+u.d-1>=history_start
 and not exists(select 1 from jsonb_to_recordset(p_bars) b(date date) where b.date=make_date(a.trade_year,1,1)+u.d-1)) then
 raise exception 'Snapshot would discard previously published dates'; end if;
 insert into market.securities(symbol,name,kind,pinyin,start_date,adjust,refreshed_at)
 values(sym,p_security->>'name',p_security->>'kind',coalesce(p_security->>'pinyin',''),history_start,'none',now())
 on conflict(symbol) do update set name=excluded.name,kind=excluded.kind,pinyin=excluded.pinyin,start_date=excluded.start_date,refreshed_at=now()
 returning id into sid;
 -- Preserve archived years and dates before the new collection start. Merge under a per-symbol transaction lock.
 insert into market.price_yearly(security_id,trade_year,price_scale,days,close_units)
 select sid,extract(year from d)::smallint,scale_factor,array_agg(extract(doy from d)::smallint order by d),array_agg(v order by d)
 from (
 select distinct on (d) d,v from (
 select make_date(a.trade_year,1,1)+u.d-1 d,(u.c::numeric/a.price_scale*scale_factor)::integer v,0 priority
 from market.price_yearly a cross join lateral unnest(a.days,a.close_units) u(d,c) where a.security_id=sid
 union all select b.date,(b.close*scale_factor)::integer,1 from jsonb_to_recordset(p_bars)b(date date,close numeric)
 ) all_rows order by d,priority desc
 ) merged group by extract(year from d)
 on conflict(security_id,trade_year) do update set price_scale=excluded.price_scale,days=excluded.days,close_units=excluded.close_units;
 insert into market.price_series(symbol,adjust,first_date,last_date,row_count,fetched_at,last_run_id)
 select sym,'none',min(make_date(a.trade_year,1,1)+a.days[1]-1),max(make_date(a.trade_year,1,1)+a.days[cardinality(a.days)]-1),sum(cardinality(a.days))::integer,now(),p_run_id
 from market.price_yearly a where a.security_id=sid
 on conflict(symbol,adjust) do update set first_date=excluded.first_date,last_date=excluded.last_date,row_count=excluded.row_count,fetched_at=now(),last_run_id=p_run_id;
 return jsonb_array_length(p_bars);
end $$;
create or replace function public.market_available(p_query text default '',p_after text default null) returns jsonb
language sql stable security invoker set search_path='' as $$
 with available as (select s.symbol,s.name,s.kind,x.first_date as "firstDate",x.last_date as "lastDate"
 from market.securities s join market.price_series p on p.symbol=s.symbol and p.adjust='none'
 cross join lateral (select min(make_date(a.trade_year,1,1)+a.days[1]-1) first_date,
 max(make_date(a.trade_year,1,1)+a.days[cardinality(a.days)]-1) last_date
 from market.price_yearly a where a.security_id=s.id and a.trade_year>=2023) x
 where s.enabled and s.kind='股票' and s.symbol ~ '^(sh6|sz[03]|bj[489])[0-9]{5}$' and s.name !~* 'ST' and p.row_count>0 and x.first_date is not null
 and exists(select 1 from market.dividend_series d where d.symbol=s.symbol) and position(lower(left(trim(coalesce(p_query,'')),40)) in lower(s.name||s.symbol||s.pinyin))>0),
 page as(select * from available where p_after is null or symbol>p_after order by symbol limit 51),
 visible as(select * from page order by symbol limit 50)
 select jsonb_build_object('results',coalesce((select jsonb_agg(to_jsonb(v) order by symbol) from visible v),'[]'::jsonb),
 'total',(select count(*) from available),'nextCursor',case when (select count(*) from page)>50 then(select max(symbol) from visible)else null end)
$$;
create or replace function public.market_ready() returns jsonb language sql stable security invoker set search_path='' as $$
 with available as(select s.symbol,s.name,s.kind,x.first_date as "firstDate",x.last_date as "lastDate"
 from market.securities s join market.price_series p on p.symbol=s.symbol and p.adjust='none'
 cross join lateral (select min(make_date(a.trade_year,1,1)+a.days[1]-1) first_date,
 max(make_date(a.trade_year,1,1)+a.days[cardinality(a.days)]-1) last_date
 from market.price_yearly a where a.security_id=s.id and a.trade_year>=2023) x
 where s.enabled and s.kind='股票' and s.symbol ~ '^(sh6|sz[03]|bj[489])[0-9]{5}$' and s.name !~* 'ST' and p.row_count>0 and x.first_date is not null
 and exists(select 1 from market.dividend_series d where d.symbol=s.symbol))
 select jsonb_build_object('total',count(*),'results',coalesce(jsonb_agg(to_jsonb(a) order by a.name,a.symbol),'[]'::jsonb)) from available a
$$;
create or replace function public.market_search(p_query text default '') returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('results',public.market_available(p_query)->'results')
$$;
CREATE OR REPLACE FUNCTION public.market_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('lastCompleteDate',(select last_date from market.price_series where symbol='sh000001' and adjust='none'),
    'historyStart','2023-01-01','storage','yearly-v1','popular',coalesce((select jsonb_agg(jsonb_build_object('symbol',symbol,'name',name,'kind',kind) order by symbol)
      from market.securities where enabled and nightly and kind='股票' and name !~* 'ST'),'[]'::jsonb))
$function$
;

CREATE OR REPLACE FUNCTION public.market_enqueue()
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare rid uuid; cutoff date;
begin
  perform pg_advisory_xact_lock(8627340101);
  if exists(select 1 from market.collection_runs r where r.status='running' and not exists(select 1 from market.bulk_members b where b.run_id=r.id)) then return null; end if;
  cutoff:=(now() at time zone 'Asia/Shanghai')::date;
  if extract(hour from now() at time zone 'Asia/Shanghai')<16 then cutoff:=cutoff-1; end if;
  insert into market.collection_runs default values returning id into rid;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
    select rid,s.symbol,y,jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,'start',greatest(s.start_date,date '2023-01-01')),cutoff,'prices',m
    from market.securities s cross join lateral generate_series(extract(year from greatest(s.start_date,date '2023-01-01'))::integer,extract(year from cutoff)::integer) y
    cross join lateral unnest(array['none']) m where s.enabled and s.nightly and s.kind='股票' and s.symbol ~ '^(sh6|sz[03]|bj[489])[0-9]{5}$' and s.name !~* 'ST';
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
    select rid,s.symbol,extract(year from cutoff)::integer,jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,'start',greatest(s.start_date,date '2023-01-01')),cutoff,'dividends','none'
    from market.securities s where s.enabled and s.nightly and s.kind='股票' and s.symbol ~ '^(sh6|sz[03]|bj[489])[0-9]{5}$' and s.name !~* 'ST' and s.kind<>'指数';
  return rid;
end $function$
;

CREATE OR REPLACE FUNCTION public.market_bulk_pump()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
      if (select count(*) from market.bulk_members where status='collecting')<2 then
        select * into m from market.bulk_members where in_universe and status='queued' and exists(select 1 from market.securities s where s.symbol=market.bulk_members.symbol and s.kind='股票' and s.name !~* 'ST' and s.symbol ~ '^(sh6|sz[03]|bj[489])[0-9]{5}$') order by ordinal for update skip locked limit 1;
        if m.symbol is not null then
          cutoff:=c.cutoff; endyear:=extract(year from cutoff)::integer;
          select jsonb_build_object('symbol',symbol,'name',name,'kind',kind,'pinyin',pinyin,'start',greatest(start_date,date '2023-01-01')) into sec from market.securities where symbol=m.symbol;
          insert into market.collection_runs default values returning id into rid;
          insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
            select rid,m.symbol,y,sec,cutoff,'prices',a from generate_series(extract(year from (sec->>'start')::date)::integer,endyear) y
            cross join unnest(array['none']) a;
          insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
            values(rid,m.symbol,endyear,sec,cutoff,'dividends','none');
          update market.bulk_members set status='collecting',run_id=rid,started_at=now() where symbol=m.symbol;
        end if;
      end if;
      if c.catalog_complete and not exists(select 1 from market.bulk_members where in_universe and status in ('queued','collecting')) then
        update market.bulk_control set state=case when exists(select 1 from market.bulk_members where in_universe and status in ('partial','failed')) then 'completed_with_errors' else 'completed' end where id;
      end if;
    end if;
  end if;
  perform public.market_bulk_refresh_progress();
end $function$
;

CREATE OR REPLACE FUNCTION public.market_bulk_refresh_progress()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c market.bulk_control; data jsonb;
begin
  select * into c from market.bulk_control where id;
  if c.id is null then return; end if;
  select jsonb_build_object(
    'state',c.state,'startedAt',c.started_at,'cutoff',c.cutoff,'historyStart','2023-01-01','scope','non_st_a_shares','storage','yearly-v1',
    'catalogue',jsonb_build_object('source',c.source,'sourceLabel',case when c.catalog_manifest->>'source'='official_exchanges' then '沪深交易所名单已核实；北交所名单逐页补齐' else '东方财富名单' end,'nextPage',c.catalog_page,'expectedStocks',c.catalog_total,
      'discoveredStocks',count(*) filter(where catalogue_verified),'complete',c.catalog_complete,'nextAttemptAt',c.catalog_next_at),
    'stocks',jsonb_build_object('total',c.catalog_total,'queued',count(*) filter(where status='queued'),
      'collecting',count(*) filter(where status='collecting'),'completed',count(*) filter(where status='completed'),
      'partial',count(*) filter(where status='partial'),'failed',count(*) filter(where status='failed')),
    'requests',jsonb_build_object('totalKnown',coalesce(sum(requests_total),0),
      'completed',coalesce(sum(requests_done),0)+(select count(*) from market.collection_tasks t join market.bulk_members m on m.run_id=t.run_id where m.status='collecting' and t.status='completed'),
      'failed',coalesce(sum(requests_failed),0)+(select count(*) from market.collection_tasks t join market.bulk_members m on m.run_id=t.run_id where m.status='collecting' and t.status='failed')),
    'published',jsonb_build_object('priceRows',(select coalesce(sum(p.row_count),0) from market.price_series p join market.bulk_members m on m.symbol=p.symbol and m.run_id=p.last_run_id),'dividendRows',(select coalesce(sum(p.row_count),0) from market.dividend_series p join market.bulk_members m on m.symbol=p.symbol and m.run_id=p.last_run_id)),
    'capacity',jsonb_build_object('databaseBytes',c.database_bytes,'pauseAtBytes',c.capacity_bytes,'plan','free'),
    'blockedUntil',c.blocked_until,'lastError',c.last_error,
    'recentFailures',coalesce((select jsonb_agg(x) from (select symbol,status,error,finished_at from market.bulk_members
      where in_universe and status in ('partial','failed') order by finished_at desc limit 10) x),'[]'::jsonb),
    'ratePolicy',jsonb_build_object('concurrency',1,'minimumIntervalSeconds',6,'maximumAttempts',3,'restrictionCooldownHours',24)
  ) into data from market.bulk_members where in_universe;
  insert into market.bulk_progress(id,snapshot) values(true,data)
    on conflict(id) do update set snapshot=excluded.snapshot,updated_at=now();
end $function$
;


-- Keep all collection timers stopped throughout migration and until explicitly resumed.
select cron.alter_job(job_id:=jobid,active:=false) from cron.job where jobname in ('shiri-nightly-21-shanghai','shiri-collection-worker','shiri-bulk-coordinator');
update market.bulk_control set state='paused_manual',updated_at=now() where id;
select public.market_bulk_refresh_progress();
analyze market.price_yearly;
notify pgrst,'reload schema';

CREATE OR REPLACE FUNCTION public.market_claim_task()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare task market.collection_tasks; c market.bulk_control; isbulk boolean;
begin
  perform pg_advisory_xact_lock(8627340103);
  update market.collection_tasks set status='failed',error='Worker lease expired after 3 attempts'
    where status='running' and lease_until<now() and attempts>=3;
  perform public.market_close_finished_runs();
  select * into c from market.bulk_control where id for update;
  if (c.source='https://www.bse.cn/nqxxController/nqxxCnzq.do' and not c.catalog_complete and c.catalog_next_at<=now()) or c.catalog_lease>now() or c.blocked_until>now() or c.next_request_at>now() or exists(select 1 from market.collection_tasks where status='running' and lease_until>now()) then return null; end if;
  select t.* into task from market.collection_tasks t left join market.bulk_members m on m.run_id=t.run_id
    where (t.dataset='dividends' or t.year>=2023) and exists(select 1 from market.securities s where s.symbol=t.symbol and s.kind='股票' and s.name !~* 'ST' and s.symbol ~ '^(sh6|sz[03]|bj[489])[0-9]{5}$') and t.attempts<3 and t.available_at<=now() and (t.status='pending' or (t.status='running' and t.lease_until<now()))
      and (m.symbol is null or c.state in ('running','cataloguing'))
    order by (m.symbol is not null),t.attempts,t.run_id,t.dataset desc,t.adjust,t.year for update of t skip locked limit 1;
  if task.id is null then return null; end if;
  isbulk:=exists(select 1 from market.bulk_members where run_id=task.run_id);
  -- Keep the oldest lease stale-safe; never publish a late worker attempt.
  update market.collection_tasks set status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes' where id=task.id returning * into task;
  update market.bulk_control set next_request_at=now()+interval '6 seconds'+random()*interval '1 second' where id;
  return (to_jsonb(task)-'bars'-'error')||jsonb_build_object('bulk',isbulk);
end $function$
;

