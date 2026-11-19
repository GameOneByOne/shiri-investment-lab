begin;
set local statement_timeout='30s';
do $test$
declare first_result jsonb; second_result jsonb; cn_before integer; cn_after integer;
 hk_before integer; us_before integer; hk_after integer; us_after integer; queued_before integer;
begin
 if market.refresh_cutoff('US','2026-11-20 00:05:00+08')<>date '2026-11-18'
 or market.refresh_cutoff('US','2026-11-20 08:05:00+08')<>date '2026-11-19'
 or market.refresh_cutoff('CN','2026-11-20 00:05:00+08')<>date '2026-11-19'
 or market.refresh_cutoff('HK','2026-11-22 00:05:00+08')<>date '2026-11-20' then raise exception 'Cutoff/calendar test failed';end if;
 select count(*) into hk_before from market_hk.securities where ready;
 select count(*) into us_before from market_us.securities where ready;
 first_result:=public.market_daily_refresh();
 select count(*) into cn_before from market.collection_tasks;
 second_result:=public.market_daily_refresh();
 select count(*) into cn_after from market.collection_tasks;
 if cn_before<>cn_after then raise exception 'Repeated enqueue created duplicate CN tasks';end if;
 if exists(select 1 from jsonb_array_elements(second_result) x where (x->>'tasksAdded')::integer<>0) then raise exception 'Repeated enqueue created duplicate tasks';end if;
 select count(*) into hk_after from market_hk.securities where ready;
 select count(*) into us_after from market_us.securities where ready;
 if hk_before<>hk_after or us_before<>us_after then raise exception 'Refresh changed published availability';end if;
 select count(*) into queued_before from market.collection_tasks;
 update market.bulk_control set state='paused_capacity' where id;
 if exists(select 1 from jsonb_array_elements(public.market_daily_refresh()) x where x->>'status'<>'skipped_pause') then raise exception 'Capacity pause ignored';end if;
 if public.market_enqueue() is not null or public.market_global_enqueue('HK')<>0 or public.market_global_enqueue('US')<>0 then raise exception 'Paused enqueue guard failed';end if;
 if (select count(*) from market.collection_tasks)<>queued_before then raise exception 'Queue changed during capacity pause';end if;
 if public.market_global_claim('HK') is not null or public.market_global_claim('US') is not null then raise exception 'Paused worker guard failed';end if;
 if has_function_privilege('anon','public.market_daily_refresh(text)','execute')
 or has_table_privilege('anon','market.daily_refresh_log','select') then raise exception 'Public access to coordinator';end if;
 raise notice 'PASS: market cutoffs, duplicate suppression, availability, sticky capacity pause, worker pause and ACL';
end $test$;
rollback;
select 'PASS: cutoff / idempotency / ready availability / capacity pause / ACL; all test changes rolled back' as verification;
