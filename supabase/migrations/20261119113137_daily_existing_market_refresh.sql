
-- Midnight queue coordinator. Existing workers, sources and request intervals stay unchanged.
create table market.daily_refresh_log(
 market text not null check(market in ('CN','HK','US')),
 target_date date not null,
 checked_at timestamptz not null default now(),
 tasks_added integer not null default 0,
 run_id uuid,
 status text not null,
 primary key(market,target_date)
);
alter table market.daily_refresh_log enable row level security;
revoke all on market.daily_refresh_log from public,anon,authenticated;
grant select,insert,update on market.daily_refresh_log to service_role;

create function market.refresh_cutoff(p_market text,p_at timestamptz default now())
returns date language plpgsql stable security invoker set search_path='' as $$
declare local_time timestamp; result date;
begin
 if p_market not in ('CN','HK','US') or p_market is null then raise exception 'Unsupported market';end if;
 local_time:=p_at at time zone case when p_market='US' then 'America/New_York' else 'Asia/Shanghai' end;
 result:=local_time::date-case when extract(hour from local_time)<case p_market when 'CN' then 16 when 'HK' then 17 else 18 end then 1 else 0 end;
 -- Holidays are verified by the source. Never invent a bar for the target date.
 result:=result-case extract(isodow from result) when 6 then 1 when 7 then 2 else 0 end;
 return result;
end $$;
revoke all on function market.refresh_cutoff(text,timestamptz) from public,anon,authenticated;
grant execute on function market.refresh_cutoff(text,timestamptz) to service_role;

create or replace function public.market_enqueue()
returns uuid language plpgsql security invoker set search_path='' as $$
declare rid uuid; v_cutoff date:=market.refresh_cutoff('CN'); gate market.bulk_control;
begin
 perform pg_advisory_xact_lock(8627340101);
 select * into gate from market.bulk_control where id for update;
 if gate.id is null or gate.state in ('paused_manual','paused_capacity')
 or pg_database_size(current_database())>=gate.capacity_bytes or gate.blocked_until>now() then return null;end if;

 -- Coalesce queued current-year requests to the latest target; leave active leases and backoff intact.
 update market.collection_tasks t set end_date=least(make_date(t.year,12,31),v_cutoff)
 where t.status='pending' and t.dataset='prices'
 and t.year between extract(year from v_cutoff-7) and extract(year from v_cutoff)
 and t.end_date<least(make_date(t.year,12,31),v_cutoff)
 and exists(select 1 from market.price_series p where p.symbol=t.symbol and p.adjust='none' and p.row_count>0);

 insert into market.collection_runs default values returning id into rid;
 insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
 select rid,s.symbol,y,
 jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,
 'start',greatest(s.start_date,date '2023-01-01')),
 least(make_date(y,12,31),v_cutoff),'prices','none'
 from market.securities s join market.price_series p on p.symbol=s.symbol and p.adjust='none'
 cross join generate_series(extract(year from v_cutoff-7)::integer,extract(year from v_cutoff)::integer) y
 where s.enabled and p.row_count>0 and (s.kind in ('ETF','指数') or (s.kind='股票' and s.name !~* 'ST'))
 and s.start_date<=least(make_date(y,12,31),v_cutoff)
 and coalesce((p.fetched_at at time zone 'Asia/Shanghai')::date,date '1900-01-01')<v_cutoff
 and not exists(select 1 from market.collection_tasks t where t.symbol=s.symbol
   and t.year=y and t.dataset='prices' and t.adjust='none' and t.status in ('pending','running'));

 -- Keep the configured stock/ETF dividend refresh; broad daily refresh only adds raw close requests.
 insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
 select rid,s.symbol,extract(year from v_cutoff)::integer,
 jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,
 'start',greatest(s.start_date,date '2023-01-01')),v_cutoff,'dividends','none'
 from market.securities s where s.enabled and s.nightly and s.kind in ('股票','ETF')
 and (s.kind='ETF' or s.name !~* 'ST')
 and exists(select 1 from market.price_series p where p.symbol=s.symbol and p.adjust='none' and p.row_count>0)
 and not exists(select 1 from market.dividend_series d where d.symbol=s.symbol and (d.fetched_at at time zone 'Asia/Shanghai')::date>=v_cutoff)
 and not exists(select 1 from market.collection_tasks t where t.symbol=s.symbol and t.dataset='dividends' and t.status in ('pending','running'));

 update market.bulk_control set cutoff=greatest(cutoff,v_cutoff) where id;
 if not exists(select 1 from market.collection_tasks where run_id=rid) then
 update market.collection_runs set status='success',finished_at=now() where id=rid;end if;
 return rid;
end $$;

create function public.market_daily_refresh(p_market text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare m text; target date; gate market.bulk_control; control market.global_control;
 n integer; rid uuid; state text; results jsonb:='[]'::jsonb;
begin
 if p_market is not null and p_market not in ('CN','HK','US') then raise exception 'Unsupported market';end if;
 for m in select unnest(case when p_market is null then array['CN','HK','US'] else array[p_market] end)
 loop
  target:=market.refresh_cutoff(m);n:=0;rid:=null;state:='queued';
  select * into gate from market.bulk_control where id;
  if gate.id is null or gate.state in ('paused_manual','paused_capacity') then state:='skipped_pause';
  elsif pg_database_size(current_database())>=gate.capacity_bytes then state:='skipped_capacity';
  elsif gate.blocked_until>now() then state:='skipped_cooldown';
  end if;
  if state='queued' and m<>'CN' then
   select * into control from market.global_control where market=m;
   if control.market is null then state:='skipped_unconfigured';
   elsif control.state in ('paused_manual','paused_capacity','catalogue_failed') then state:='skipped_pause';
   elsif control.blocked_until>now() then state:='skipped_cooldown';end if;
  end if;
  if state='queued' then
   if m='CN' then
    rid:=public.market_enqueue();
    select count(*) into n from market.collection_tasks where run_id=rid;
   else n:=public.market_global_enqueue(m);end if;
   if n=0 then state:='no_new_tasks';end if;
  end if;
  insert into market.daily_refresh_log(market,target_date,tasks_added,run_id,status)
  values(m,target,n,rid,state)
  on conflict(market,target_date) do update set checked_at=now(),
  tasks_added=market.daily_refresh_log.tasks_added+excluded.tasks_added,
  run_id=coalesce(excluded.run_id,market.daily_refresh_log.run_id),status=excluded.status;
  results:=results||jsonb_build_array(jsonb_build_object('market',m,'targetDate',target,'tasksAdded',n,'status',state));
 end loop;
 return results;
end $$;
revoke all on function public.market_daily_refresh(text) from public,anon,authenticated;
grant execute on function public.market_daily_refresh(text) to service_role;

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
  if c.id is null or c.state in ('paused_manual','paused_capacity') or pg_database_size(current_database())>=c.capacity_bytes or (c.source='https://www.bse.cn/nqxxController/nqxxCnzq.do' and not c.catalog_complete and c.catalog_failures<3 and c.catalog_next_at<=now()) or c.catalog_lease>now() or c.blocked_until>now() or c.next_request_at>now() or exists(select 1 from market.collection_tasks where status='running' and lease_until>now()) then return null; end if;
  select t.* into task from market.collection_tasks t left join market.bulk_members m on m.run_id=t.run_id
    where (t.dataset='dividends' or t.year>=2023) and exists(select 1 from market.securities s where s.symbol=t.symbol and ((s.enabled and s.kind in ('ETF','指数')) or (s.kind='股票' and s.name !~* 'ST' and s.symbol ~ '^(sh6|sz[03]|bj[489])[0-9]{5}$'))) and t.attempts<3 and t.available_at<=now() and (t.status='pending' or (t.status='running' and t.lease_until<now()))
      and (m.symbol is null or c.state in ('running','cataloguing'))
    order by (m.symbol is not null),t.attempts,t.run_id,t.dataset desc,t.adjust,t.year for update of t skip locked limit 1;
  if task.id is null then return null; end if;
  isbulk:=exists(select 1 from market.bulk_members where run_id=task.run_id);
  -- Keep the oldest lease stale-safe; never publish a late worker attempt.
  update market.collection_tasks set status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes' where id=task.id returning * into task;
  update market.bulk_control set next_request_at=now()+interval '6 seconds'+random()*interval '1 second' where id;
  return (to_jsonb(task)-'bars'-'error')||jsonb_build_object('bulk',isbulk);
end $function$;

CREATE OR REPLACE FUNCTION public.market_global_claim(p_market text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare sch text:=market.global_schema(p_market); c market.global_control; gate market.bulk_control; task record; lease uuid:=gen_random_uuid();
begin
 -- Same lock ordering for all global writers. A-share claim also locks bulk_control.
 select * into gate from market.bulk_control where id for update;
 select * into c from market.global_control where market=p_market for update;
 if gate.state in ('paused_manual','paused_capacity') or c.state in ('paused_manual','paused_capacity','catalogue_failed') then return null; end if;
 if pg_database_size(current_database())>=gate.capacity_bytes then
  update market.global_control set state='paused_capacity',last_error='Shared database safety threshold reached',updated_at=now() where market in ('HK','US');return null;
 end if;
 if c.blocked_until>now() or gate.blocked_until>now() or c.next_request_at>now() or gate.next_request_at>now()
 or gate.catalog_lease>now() or c.lease_until>now()
 or exists(select 1 from market.global_control where lease_until>now())
 or exists(select 1 from market.collection_tasks where status='running' and lease_until>now()) then return null; end if;
 if c.lease_id is not null then
  execute format('update %I.collection_tasks set status=case when attempts>=3 then ''failed'' else ''queued'' end,lease_id=null,lease_until=null,error=''Worker lease expired'' where status=''running'' and lease_until<now()',sch);
 end if;
 if c.catalogue_next_at<=now() and c.catalogue_attempts<3 then
  update market.global_control set lease_id=lease,lease_until=now()+interval '2 minutes',lease_dataset='catalogue',
   lease_symbol=null,lease_year=null,catalogue_attempts=catalogue_attempts+1,updated_at=now() where market=p_market;
  update market.bulk_control set next_request_at=now()+interval '2 minutes' where id;
  return jsonb_build_object('market',p_market,'dataset','catalogue','lease_id',lease);
 end if;
 if c.catalogue_at is null then return null; end if;
 if c.cutoff<market.global_cutoff(p_market) then perform public.market_global_enqueue(p_market);end if;
 execute format($q$select t.*,s.provider_symbol from %I.collection_tasks t join %I.securities s using(symbol)
 where s.in_catalogue and s.provider_symbol is not null and t.status='queued' and t.attempts<3 and t.available_at<=now()
 order by (s.enabled and t.year=extract(year from $1::date)) desc,t.attempts,case when t.symbol in ('AAPL','NVDA','KO','00700','00005','00941') then 0 else 1 end,t.symbol,t.year
 for update of t skip locked limit 1$q$,sch,sch) into task using c.cutoff;
 if task.symbol is null then return null; end if;
 execute format('update %I.collection_tasks set status=''running'',attempts=attempts+1,lease_id=$1,lease_until=now()+interval ''2 minutes'' where symbol=$2 and year=$3 returning attempts',sch)
 into task.attempts using lease,task.symbol,task.year;
 update market.global_control set state='running',lease_id=lease,lease_until=now()+interval '2 minutes',lease_dataset='year',
  lease_symbol=task.symbol,lease_year=task.year,updated_at=now() where market=p_market;
 -- A-share worker sees this reservation and cannot overlap the provider request.
 update market.bulk_control set next_request_at=now()+interval '2 minutes' where id;
 return jsonb_build_object('market',p_market,'dataset','year','lease_id',lease,'symbol',task.symbol,
  'provider_symbol',task.provider_symbol,'year',task.year,'end_date',task.end_date,'attempts',task.attempts);
end $function$;

CREATE OR REPLACE FUNCTION public.market_global_enqueue(p_market text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare sch text:=market.global_schema(p_market); v_cutoff date; n integer; gate market.bulk_control; c market.global_control;
begin
 select * into gate from market.bulk_control where id for update;
 select * into c from market.global_control where market=p_market for update;
 if gate.id is null or c.market is null or gate.state in ('paused_manual','paused_capacity')
 or c.state in ('paused_manual','paused_capacity','catalogue_failed')
 or pg_database_size(current_database())>=gate.capacity_bytes
 or gate.blocked_until>now() or c.blocked_until>now() then return 0;end if;
 v_cutoff:=market.global_cutoff(p_market);
 update market.global_control set cutoff=v_cutoff,updated_at=now() where market=p_market;
 execute format($q$insert into %I.collection_tasks(symbol,year,end_date)
 select s.symbol,y::smallint,least(make_date(y,12,31),$1) from %I.securities s
 cross join generate_series(2023,extract(year from $1)::integer) y where s.in_catalogue and s.provider_symbol is not null
 on conflict(symbol,year) do update set end_date=excluded.end_date,status='queued',
 attempts=case when collection_tasks.status='completed' then 0 else collection_tasks.attempts end,
 available_at=case when collection_tasks.status='completed' then now() else collection_tasks.available_at end,
 error=case when collection_tasks.status='completed' then null else collection_tasks.error end
 where collection_tasks.status in ('completed','queued') and collection_tasks.year between extract(year from $1::date-7) and extract(year from $1::date) and collection_tasks.end_date<excluded.end_date$q$,sch,sch) using v_cutoff;
 get diagnostics n=row_count;
 -- Published data remains readable while refresh tasks run; completion still verifies corporate actions.
 return n;
end $function$;

create or replace function market.global_cutoff(p_market text)
returns date language sql stable strict security invoker set search_path='' as $$
select market.refresh_cutoff(p_market);
$$;
-- Replace 21:00 refresh with 00:05 Shanghai. Cron uses GMT/UTC on this project.
select cron.alter_job(job_id:=jobid,active:=false) from cron.job where jobname='shiri-nightly-21-shanghai';
select cron.schedule('shiri-daily-refresh-0005-shanghai','5 16 * * *','select public.market_daily_refresh();');
-- 08:05 Shanghai is after 18:00 New York in both winter and summer.
select cron.schedule('shiri-us-refresh-0805-shanghai','5 0 * * *',$$select public.market_daily_refresh('US');$$);
