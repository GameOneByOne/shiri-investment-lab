begin;
do $$ declare c market.bulk_control; rows jsonb; rejected boolean:=false; prior_count integer;
begin
select * into c from market.bulk_control where id for update;
select count(*) into prior_count from market.bulk_members where catalogue_verified;
update market.bulk_control set catalog_page=1,catalog_complete=false,catalog_lease=now()+interval '2 minutes' where id;
select jsonb_agg(jsonb_build_object('symbol','bj4999'||lpad(n::text,2,'0'),'name','fixture','listed','2024-01-01','start','2024-01-01','exchange','bj')) into rows from generate_series(0,19)n;
perform public.market_bulk_catalog_complete(1,354,rows);
assert (select catalog_page from market.bulk_control)=2;
assert (select count(*) from market.bulk_members where catalogue_verified)=prior_count+20;
update market.bulk_control set catalog_lease=now()+interval '2 minutes' where id;
begin perform public.market_bulk_catalog_complete(2,354,rows); exception when others then rejected:=true;end;
assert rejected,'Duplicate source page was accepted';
update market.bulk_control set catalog_next_at=now()-interval '1 second',catalog_lease=null,blocked_until=null,next_request_at=now()-interval '1 second' where id;
assert public.market_claim_task() is null,'Overdue catalogue is starved by price queue';
assert not has_function_privilege('anon','public.market_bulk_import_official(jsonb,jsonb)','execute');
end $$;
rollback;
