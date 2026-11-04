-- Run against the annual schema. Every fixture and write rolls back.
begin;
do $$
declare sec jsonb:='{"symbol":"sh999996","name":"年度迁移测试","kind":"股票","start":"2021-01-01"}';
 bars jsonb:='[{"date":"2021-01-04","close":10.01},{"date":"2023-01-03","close":11.12},{"date":"2024-02-29","close":12.34}]';
 changed jsonb; rejected boolean:=false;
begin
 perform public.market_publish_prices(sec,'none',bars);
 assert (public.market_history('sh999996','2021-01-01','2024-12-31')->'bars')=bars,'Annual read changed dates or prices';
 -- New 2023+ snapshots must retain the archived 2021 date.
 sec:=jsonb_set(sec,'{start}','"2023-01-01"');
 changed:='[{"date":"2023-01-03","close":15.67},{"date":"2024-02-29","close":18.99}]';
 perform public.market_publish_prices(sec,'none',changed);
 assert jsonb_array_length(public.market_history('sh999996','2021-01-01','2024-12-31')->'bars')=3;
 assert (public.market_history('sh999996','2024-01-01','2024-12-31')->'bars'->0->>'close')::numeric=18.99;
 begin perform public.market_publish_prices(sec,'none',changed-1); exception when others then rejected:=true; end;
 assert rejected,'Truncated snapshot was accepted'; rejected:=false;
 begin perform public.market_publish_prices(sec,'none',jsonb_set(changed,'{0,close}','15.671')); exception when others then rejected:=true; end;
 assert rejected,'Sub-cent stock price was silently rounded'; rejected:=false;
 begin perform public.market_publish_prices(sec,'none',changed||changed); exception when others then rejected:=true; end;
 assert rejected,'Duplicate dates were accepted';
 assert not market.valid_price_block(2023::smallint,array[366]::smallint[],array[100]);
 assert market.valid_price_block(2024::smallint,array[366]::smallint[],array[100]);
 assert not market.valid_price_block(2024::smallint,array[2,1]::smallint[],array[100,200]);
 assert not market.valid_price_block(2024::smallint,array[1]::smallint[],array[100,200]);
 assert not market.valid_price_block(2024::smallint,array[1]::smallint[],array[null]::integer[]);
 assert not has_function_privilege('anon','public.market_publish_prices(jsonb,text,jsonb,uuid)','execute');
 assert not has_table_privilege('anon','market.price_yearly','insert');
 -- ETF archive retains three decimals.
 perform public.market_publish_prices('{"symbol":"sh999995","name":"ETF精度测试","kind":"ETF","start":"2023-01-01"}','none','[{"date":"2023-01-03","close":1.234}]');
 assert (public.market_history('sh999995','2023-01-01','2023-12-31')->'bars'->0->>'close')::numeric=1.234;
end $$;
set local role anon;
do $$ begin
 assert jsonb_array_length(public.market_history('sh999996','2023-01-01','2024-12-31')->'bars')=2;
 assert not exists(select 1 from jsonb_array_elements(public.market_ready()->'results')x where x->>'kind'<>'股票' or x->>'name' ~* 'ST' or (x->>'firstDate')::date<'2023-01-01');
 assert (public.market_available('贵州茅台')->>'total')::integer=1;
 assert (public.market_available('guizhoumaotai')->>'total')::integer=1;
 assert (public.market_available('600519')->>'total')::integer=1;
 assert (public.market_available('ETF精度测试')->>'total')::integer=0;
end $$;
rollback;
