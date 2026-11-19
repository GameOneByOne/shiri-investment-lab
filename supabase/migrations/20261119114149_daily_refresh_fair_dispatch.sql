CREATE OR REPLACE FUNCTION public.market_daily_refresh(p_market text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
   if n=0 then state:='no_new_tasks';rid:=null;end if;
  end if;
  insert into market.daily_refresh_log(market,target_date,tasks_added,run_id,status)
  values(m,target,n,rid,state)
  on conflict(market,target_date) do update set checked_at=now(),
  tasks_added=market.daily_refresh_log.tasks_added+excluded.tasks_added,
  run_id=coalesce(excluded.run_id,market.daily_refresh_log.run_id),status=excluded.status;
  results:=results||jsonb_build_array(jsonb_build_object('market',m,'targetDate',target,'tasksAdded',n,'status',state));
 end loop;
 return results;
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

 -- Minute-aligned workers otherwise race for the same gate and can starve CN indefinitely.
 -- Reserve one of three dispatch windows for pending daily CN prices; no new worker or faster requests.
 if extract(minute from now())::integer % 3=0 and exists(
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
