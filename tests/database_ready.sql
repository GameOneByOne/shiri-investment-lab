-- No upstream requests. Fixture data and policy checks are rolled back.
begin;
do $$
declare sec jsonb:='{"symbol":"sh999996","name":"ready fixture","kind":"股票","start":"2024-01-01"}';
 rid uuid; task jsonb;
begin
 perform public.market_publish_prices(sec,'none','[{"date":"2024-01-02","close":10}]');
 assert not exists(select 1 from jsonb_array_elements(public.market_ready()->'results') e where e->>'symbol'='sh999996'),'Incomplete dividends appeared in direct picker';
 assert (public.market_available('ready fixture')->>'total')::integer=0;
 perform public.market_publish_dividends(sec,'[]');
 assert (public.market_available('ready fixture')->>'total')::integer=1,'Confirmed zero dividends were excluded';
 assert exists(select 1 from jsonb_array_elements(public.market_ready()->'results') e where e->>'symbol'='sh999996');
 insert into market.collection_runs default values returning id into rid;
 insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
 values(rid,'sh999996',2024,sec,'2024-12-31','prices','none');
 update market.bulk_control set blocked_until=null,catalog_lease=null,next_request_at=now()-interval '1 second';
 task:=public.market_claim_task();
 assert task is not null;
 assert (select next_request_at>=now()+interval '6 seconds' and next_request_at<now()+interval '7 seconds' from market.bulk_control),'Minimum source interval was weakened';
 assert public.market_claim_task() is null,'Concurrent/early request was permitted';
 perform public.market_bulk_catalog_fail(2,'HTTP 429',true);
 assert (select catalog_next_at>=now()+interval '24 hours' from market.bulk_control),'Restriction cooldown was reduced';
 assert not has_function_privilege('anon','public.market_claim_task()','execute');
end $$;
set local role anon;
do $$ begin
 assert exists(select 1 from jsonb_array_elements(public.market_ready()->'results') e where e->>'symbol'='sh999996');
 assert not exists(select 1 from jsonb_array_elements(public.market_ready()->'results') e
   join market.securities s on s.symbol=e->>'symbol' where s.kind<>'指数' and not exists(select 1 from market.dividend_series d where d.symbol=s.symbol));
end $$;
rollback;
