-- Fresh fetch timestamps do not prove that a snapshot covered today's target.
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
 and p.last_date<least(make_date(y,12,31),v_cutoff)
 and not exists(select 1 from market.collection_tasks verified
   where verified.run_id=p.last_run_id and verified.symbol=s.symbol and verified.year=y
   and verified.dataset='prices' and verified.status='completed'
   and verified.end_date>=least(make_date(y,12,31),v_cutoff))
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
 and not exists(select 1 from market.dividend_series d join market.collection_tasks verified on verified.run_id=d.last_run_id and verified.symbol=d.symbol
   where d.symbol=s.symbol and verified.dataset='dividends' and verified.status='completed' and verified.end_date>=v_cutoff)
 and not exists(select 1 from market.collection_tasks t where t.symbol=s.symbol and t.dataset='dividends' and t.status in ('pending','running'));

 update market.bulk_control set cutoff=greatest(cutoff,v_cutoff) where id;
 if not exists(select 1 from market.collection_tasks where run_id=rid) then
 update market.collection_runs set status='success',finished_at=now() where id=rid;end if;
 return rid;
end $$;
