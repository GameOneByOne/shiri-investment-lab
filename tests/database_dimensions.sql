-- Administrator integration test. All test data is rolled back.
begin;
do $$
declare
  sec jsonb:='{"symbol":"sh999997","name":"dimension fixture","kind":"股票","start":"2024-01-01"}';
  q jsonb:='[{"date":"2024-01-02","open":9,"close":9,"high":9,"low":9,"volumeRaw":100,"amountCny":1000,"turnoverRate":0.01}]';
  raw jsonb:='[{"date":"2024-01-02","open":10,"close":10,"high":10,"low":10}]';
  hfq jsonb:='[{"date":"2024-01-02","open":100,"close":100,"high":100,"low":100}]';
  events jsonb:='[{"sourceId":"2024:1","reportDate":"2024-12-31","planDate":"2025-03-01","recordDate":"2025-05-05","exDate":"2025-05-06","payDate":null,"status":"implemented","statusText":"实施分配","cashPer10":12.3,"bonusSharesPer10":null,"transferSharesPer10":null,"currency":"CNY","taxBasis":"pretax","planText":"10派12.3元","source":"eastmoney_stock","sourceUrl":"https://data.eastmoney.com/","raw":{}},{"sourceId":"2025:1","reportDate":"2025-12-31","planDate":"2026-03-01","status":"proposed","statusText":"预案","cashPer10":null,"currency":"CNY","taxBasis":"pretax","planText":"待定","source":"eastmoney_stock","sourceUrl":"https://data.eastmoney.com/","raw":{}}]';
  d jsonb; rejected boolean:=false; rid uuid; tid uuid;
begin
  perform public.market_publish_prices(sec,'none',raw);
  perform public.market_publish_prices(sec,'hfq',hfq);
  perform public.market_publish_prices(sec,'qfq',q);
  assert (public.market_prices('sh999997','2024-01-01','2024-01-03','none')->'bars'->0->>'close')::numeric=10;
  assert (public.market_prices('sh999997','2024-01-01','2024-01-03','hfq')->'bars'->0->>'close')::numeric=100;
  assert (public.market_history('sh999997','2024-01-01','2024-01-03')->'bars'->0->>'close')::numeric=9;
  assert (select close from market.daily_bars where symbol='sh999997')=9,'Compatibility mirror changed price basis';
  perform public.market_publish_dividends(sec,events);
  d:=public.market_dividends('sh999997','2024-01-01','2026-10-27');
  assert d->>'status'='collected';
  assert (d->'events'->0->>'cashPerUnit')::numeric=1.23,'Per-ten dividend conversion failed';
  assert d->'events'->0->'payDate'='null'::jsonb,'Unknown payment date was fabricated';
  assert d->'events'->1->'cashPerUnit'='null'::jsonb,'Unknown cash amount became zero';
  assert public.market_dividends('sh000001')->>'status'='not_applicable';
  begin perform public.market_publish_dividends(sec,events-0);
  exception when others then
    if sqlerrm='Snapshot would discard implemented dividend records' then rejected:=true; else raise; end if;
  end;
  assert rejected and (select count(*) from market.dividend_events where symbol='sh999997')=2,'Incomplete dividend history replaced published records';
  rejected:=false;
  begin perform public.market_publish_prices(sec,'hfq',jsonb_set(hfq,'{0,low}','999'));
  exception when check_violation then rejected:=true; end;
  assert rejected and (select close from market.price_daily where symbol='sh999997' and adjust='hfq')=100,'Failed snapshot altered data';
  -- Other price modes and the dividend task do not delay a completed qfq series.
  insert into market.collection_runs default values returning id into rid;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust,status,attempts)
    values(rid,'sh999997',2024,sec,'2024-12-31','prices','qfq','running',1) returning id into tid;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
    values(rid,'sh999997',2024,sec,'2024-12-31','prices','hfq');
  perform public.market_complete_task(tid,1,q);
  assert (select last_run_id from market.price_series where symbol='sh999997' and adjust='qfq')=rid;
  assert (select status from market.collection_runs where id=rid)='running';
  assert not has_function_privilege('anon','public.market_publish_prices(jsonb,text,jsonb,uuid)','execute');
  assert not has_function_privilege('anon','public.market_publish_dividends(jsonb,jsonb,uuid)','execute');
  assert not has_table_privilege('anon','market.dividend_events','insert');
end $$;
set local role anon;
do $$ begin
  assert jsonb_array_length(public.market_data_status('sh999997')->'prices')=3;
  assert jsonb_array_length(public.market_dividends('sh999997','2024-01-01','2026-10-27')->'events')=2;
end $$;
rollback;

