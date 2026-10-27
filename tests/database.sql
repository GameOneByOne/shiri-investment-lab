-- Run as database administrator. Everything below is rolled back.
begin;
do $$
declare
  security jsonb := '{"symbol":"sh999998","name":"integration fixture","kind":"股票","start":"2024-01-01"}';
  bars jsonb := '[{"date":"2024-01-02","open":10,"close":11,"high":12,"low":9},{"date":"2024-01-03","open":11,"close":12,"high":13,"low":10}]';
  rejected boolean:=false;
  result jsonb;
begin
  perform public.market_publish(security,bars);
  result:=public.market_history('sh999998','2024-01-01','2024-01-31');
  assert jsonb_array_length(result->'bars')=2,'Read API lost rows';
  begin
    perform public.market_publish(security,bars-1);
  exception when others then
    if sqlerrm='Snapshot would discard previously published dates' then rejected:=true; else raise; end if;
  end;
  assert rejected,'Incomplete snapshot was published';
  assert (select count(*) from market.daily_bars where symbol='sh999998')=2,'Failed publication altered data';
  rejected:=false;
  begin
    perform public.market_publish(security,jsonb_set(bars,'{1,close}','999'));
  exception when check_violation then rejected:=true;
  end;
  assert rejected,'Invalid OHLC was published';
  assert (select close from market.daily_bars where symbol='sh999998' and trade_date='2024-01-03')=12,'Transaction did not preserve previous prices';
  assert not has_function_privilege('anon','public.market_publish(jsonb,jsonb)','execute'),'Anonymous publish privilege';
  assert not has_function_privilege('anon','public.market_claim_task()','execute'),'Anonymous queue privilege';
  assert not has_table_privilege('anon','market.daily_bars','insert'),'Anonymous market write privilege';
  assert not has_table_privilege('anon','market.job_secret','select'),'Anonymous job token privilege';
end $$;
set local role anon;
do $$
begin
  assert jsonb_array_length(public.market_history('sh999998','2024-01-01','2024-01-31')->'bars')=2,'Anonymous read denied';
end $$;
rollback;
