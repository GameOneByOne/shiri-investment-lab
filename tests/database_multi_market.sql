begin;
set local role anon;
do $$ declare snapshot jsonb; rejected boolean:=false; begin
 assert (public.market_browse('cn')->>'total')::integer>0;
 assert (public.market_browse('hk')->>'total')::integer>0;
 assert (public.market_browse('us')->>'total')::integer>0;
 snapshot:=public.market_foreign_snapshot('us','AAPL','2023-01-01','2026-10-28');
 assert snapshot->'stock'->>'currency'='USD';
 assert jsonb_array_length(snapshot->'stock'->'bars')>0;
 assert jsonb_array_length(snapshot->'dividends'->'events')>0;
 begin perform public.market_browse('invalid');exception when invalid_parameter_value then rejected:=true;end;
 assert rejected,'Invalid schema selector was accepted';
 assert not has_table_privilege('anon','market_us.securities','insert');
 assert not has_table_privilege('anon','market_hk.securities','insert');
end $$;
rollback;
