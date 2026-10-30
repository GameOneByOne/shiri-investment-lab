-- Modest pacing change; retain single flight, six-second floor and all cooldowns.
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
  if c.catalog_lease>now() or c.blocked_until>now() or c.next_request_at>now() or exists(select 1 from market.collection_tasks where status='running' and lease_until>now()) then return null; end if;
  select t.* into task from market.collection_tasks t left join market.bulk_members m on m.run_id=t.run_id
    where t.attempts<3 and t.available_at<=now() and (t.status='pending' or (t.status='running' and t.lease_until<now()))
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
CREATE OR REPLACE FUNCTION public.market_available(p_query text DEFAULT ''::text, p_after text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with available as (
    select s.symbol,s.name,s.kind,p.first_date as "firstDate",p.last_date as "lastDate"
    from market.securities s join market.price_series p on p.symbol=s.symbol and p.adjust=s.adjust
    where s.enabled and p.row_count>0 and (s.kind='指数' or exists(select 1 from market.dividend_series d where d.symbol=s.symbol)) and position(lower(left(trim(coalesce(p_query,'')),40)) in lower(s.name||s.symbol||s.pinyin))>0
  ), page as (
    select * from available where p_after is null or symbol>p_after order by symbol limit 51
  ), visible as (select * from page order by symbol limit 50)
  select jsonb_build_object('results',coalesce((select jsonb_agg(to_jsonb(v) order by symbol) from visible v),'[]'::jsonb),
    'total',(select count(*) from available),
    'nextCursor',case when (select count(*) from page)>50 then (select max(symbol) from visible) else null end)
$function$
;
create function public.market_ready() returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('total',count(*),'results',coalesce(jsonb_agg(
    jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'firstDate',p.first_date,'lastDate',p.last_date)
    order by s.name,s.symbol),'[]'::jsonb))
  from market.securities s join market.price_series p on p.symbol=s.symbol and p.adjust='none'
  where s.enabled and p.row_count>0 and (s.kind='指数' or exists(select 1 from market.dividend_series d where d.symbol=s.symbol))
$$;
revoke all on function public.market_ready() from public;
grant execute on function public.market_ready() to anon,authenticated,service_role;
notify pgrst,'reload schema';
CREATE OR REPLACE FUNCTION public.market_bulk_catalog_fail(p_page integer, p_error text, p_restricted boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  update market.bulk_control set catalog_lease=null,catalog_failures=catalog_failures+1,last_error=left(p_error,300),
    catalog_next_at=now()+case when p_restricted then interval '24 hours' else least(interval '3 hours',interval '30 minutes'*power(2,least(catalog_failures,4))) end
    where id and catalog_page=p_page;
  perform public.market_bulk_refresh_progress();
end $function$
;
-- The user requested a modest speed increase. Only shorten connection-error backoff.
-- Never shorten HTTP restriction cooldowns or capacity/manual pauses.
update market.bulk_control set catalog_next_at=greatest(now()+interval '1 minute',catalog_next_at-interval '3 hours')
where id and not catalog_complete and catalog_failures>=5 and catalog_next_at>now()
and state not in ('paused_manual','paused_capacity') and coalesce(blocked_until,now())<=now()
and last_error ~ 'error sending request|fetch failed|connection' and last_error !~ 'HTTP (403|429)|Retry-After';


