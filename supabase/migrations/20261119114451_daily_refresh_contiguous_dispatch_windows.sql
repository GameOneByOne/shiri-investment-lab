-- A contiguous window lets an earlier global lease drain before CN's next cron tick.
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

 -- Minute-aligned workers otherwise race for the same gate and can starve CN indefinitely.
 -- Reserve two consecutive windows in four for pending daily CN prices; no new worker or faster requests.
 if extract(minute from now())::integer % 4 in (0,1) and exists(
  select 1 from market.collection_tasks t where t.status='pending' and t.dataset='prices'
  and t.year>=extract(year from market.refresh_cutoff('CN'))
  and t.attempts<3 and t.available_at<=now()
  and exists(select 1 from market.price_series p where p.symbol=t.symbol and p.adjust='none' and p.row_count>0)
 ) then return null;end if;
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
