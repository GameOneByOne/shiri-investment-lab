CREATE OR REPLACE FUNCTION public.market_bulk_catalog_claim()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c market.bulk_control;
begin
  select * into c from market.bulk_control where id for update;
  if c.id is null or c.catalog_complete or c.state in ('paused_manual','paused_capacity') or c.blocked_until>now()
    or c.next_request_at>now() or c.catalog_next_at>now() or c.catalog_lease>now() or exists(select 1 from market.collection_tasks where status='running' and lease_until>now()) then return null; end if;
  update market.bulk_control set catalog_lease=now()+interval '2 minutes',next_request_at=now()+interval '6 seconds'+random()*interval '1 second' where id;
  return jsonb_build_object('page',c.catalog_page,'source',c.source);
end $function$
;
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

