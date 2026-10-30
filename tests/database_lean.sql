-- Current-schema integration checks; fixtures and all effects roll back.
begin;
do $$
declare sec jsonb:='{"symbol":"sh999997","name":"lean fixture","kind":"股票","start":"2021-01-01"}';
 bars jsonb:='[{"date":"2021-01-04","close":10},{"date":"2021-01-05","close":11}]';
 events jsonb:='[{"sourceId":"2020-report-2021-payment","reportDate":"2020-12-31","planDate":"2021-03-01","recordDate":"2021-05-05","exDate":"2021-05-06","status":"implemented","statusText":"实施分配","cashPer10":12.3,"bonusSharesPer10":0,"transferSharesPer10":0,"currency":"CNY","taxBasis":"pretax","planText":"10派12.3元","source":"eastmoney_stock","sourceUrl":"https://data.eastmoney.com/"}]';
 rejected boolean:=false; tid uuid; rid uuid;
begin
 assert (select count(*) from information_schema.columns where table_schema='market' and table_name='price_daily')=3;
 assert to_regclass('market.daily_bars') is null;
 assert not exists(select 1 from market.price_daily where trade_date<'2021-01-01');
 assert not exists(select 1 from market.price_series where adjust<>'none');
 perform public.market_publish_prices(sec,'none',bars);
 perform public.market_publish_dividends(sec,events);
 assert (public.market_history('sh999997','2021-01-01','2021-01-31')->'bars'->0)='{"date":"2021-01-04","close":10}'::jsonb;
 assert jsonb_array_length(public.market_dividends('sh999997')->'events')=1,'2020 report paid in 2021 was lost';
 begin perform public.market_publish_prices(sec,'qfq',bars); exception when others then rejected:=true; end;
 assert rejected,'Adjusted data was accepted'; rejected:=false;
 begin perform public.market_publish_prices(sec,'none',bars-1); exception when others then rejected:=true; end;
 assert rejected,'Incomplete history was accepted'; rejected:=false;
 begin perform public.market_publish_prices(sec,'none',jsonb_set(bars,'{1,close}','-1')); exception when check_violation then rejected:=true; end;
 assert rejected and (select close from market.price_daily where symbol='sh999997' and trade_date='2021-01-05')=11;
 insert into market.collection_runs default values returning id into rid;
 insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust,status,attempts)
 values(rid,'sh999997',2021,sec,'2021-12-31','prices','none','running',1) returning id into tid;
 perform public.market_complete_task(tid,1,bars);
 assert (select t.bars is null from market.collection_tasks t where t.id=tid),'Published staging was retained';
 assert not has_function_privilege('anon','public.market_publish_prices(jsonb,text,jsonb,uuid)','execute');
 assert not has_table_privilege('anon','market.price_daily','insert');
 assert not has_table_privilege('anon','market.job_secret','select');
end $$;
set local role anon;
do $$ begin
 assert jsonb_array_length(public.market_history('sh999997','2021-01-01','2021-01-31')->'bars')=2;
 assert public.market_dividends('sh999997')->>'status'='collected';
 assert (public.market_available('lean fixture')->>'total')::integer=1;
end $$;
rollback;
