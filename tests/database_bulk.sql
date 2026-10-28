-- Integration checks on the actual queue, with all fixtures rolled back.
begin;
do $$
declare page jsonb; task jsonb; other jsonb; sid uuid;
begin
  assert not exists(select 1 from market.bulk_control),'Run fixtures before campaign activation';
  insert into market.bulk_control(id) values(true);
  assert (public.market_bulk_catalog_claim()->>'page')::integer=1;
  select jsonb_agg(jsonb_build_object('symbol','sh'||n::text,'name','bulk fixture','listed','2010-01-01','start','2020-01-01','exchange','sh')) into page from generate_series(600100,600199) n;
  perform public.market_bulk_catalog_complete(1,4000,page);
  assert (select count(*) from market.bulk_members)=100;
  assert not (select catalog_complete from market.bulk_control),'Partial catalogue was counted as complete';
  perform public.market_bulk_pump();
  assert (select count(*) from market.bulk_members where status='collecting')=1;
  assert (select count(*) from market.collection_tasks t join market.bulk_members m on m.run_id=t.run_id)=22;
  task:=public.market_claim_task();
  assert task->>'bulk'='true';
  assert public.market_claim_task() is null,'Concurrent source request was permitted';
  sid:=(task->>'id')::uuid;
  perform public.market_complete_task(sid,1,'[{"date":"2020-01-02","open":10,"close":10,"high":10,"low":10}]');
  assert not exists(select 1 from market.price_series where symbol=task->>'symbol'),'An incomplete multi-year snapshot was published';
  update market.bulk_control set next_request_at=now()-interval '1 second';
  task:=public.market_claim_task();
  perform public.market_fail_task((task->>'id')::uuid,1,'Market source HTTP 429');
  assert (select blocked_until>now()+interval '23 hours' from market.bulk_control),'429 did not trigger source cooldown';
  assert (select available_at>now()+interval '14 minutes' from market.collection_tasks where id=(task->>'id')::uuid),'Retry was not delayed';
  assert public.market_claim_task() is null;
  update market.bulk_control set blocked_until=null,next_request_at=now(),state='paused_capacity';
  assert public.market_claim_task() is null,'Capacity pause still claimed bulk work';
  perform public.market_bulk_pump();
  assert (select state='paused_capacity' from market.bulk_control),'Capacity pause resumed without explicit action';
  assert (public.market_bulk_progress()->'catalogue'->>'discoveredStocks')::integer=100;
  assert not has_function_privilege('anon','public.market_bulk_catalog_complete(integer,integer,jsonb)','execute');
  assert not has_table_privilege('anon','market.bulk_control','update');
end $$;
set local role anon;
do $$ begin
  assert public.market_bulk_progress()->>'state'='paused_capacity';
end $$;
rollback;
