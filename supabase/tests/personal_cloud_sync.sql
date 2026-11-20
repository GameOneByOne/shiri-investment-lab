-- Rollback-only integration test. No mail, persistent accounts, or user data.
begin;
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','sync-a@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','sync-b@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$
declare n integer;
begin
 select count(*) into n from public.save_user_portfolio(0,'{"plan":{},"records":[]}');
 if n<>1 then raise exception 'First save failed'; end if;
 select count(*) into n from public.save_user_portfolio(0,'{"plan":{},"records":[]}');
 if n<>0 then raise exception 'Duplicate insert replaced data'; end if;
 select count(*) into n from public.save_user_portfolio(1,'{"plan":{"test":1},"records":[]}');
 if n<>1 then raise exception 'CAS update failed'; end if;
 select count(*) into n from public.save_user_portfolio(1,'{"plan":{"test":2},"records":[]}');
 if n<>0 then raise exception 'Stale update accepted'; end if;
 begin
  insert into public.user_portfolios(user_id,data) values('22222222-2222-4222-8222-222222222222','{"plan":{},"records":[]}');
  raise exception 'Cross-user insert accepted';
 exception when insufficient_privilege then null; end;
 begin
  update public.user_portfolios set user_id='22222222-2222-4222-8222-222222222222';
  raise exception 'Ownership change accepted';
 exception when insufficient_privilege then null; end;
 begin
  perform public.save_user_portfolio(2,'{"plan":{},"records":null}');
  raise exception 'Malformed data accepted';
 exception when check_violation then null; end;
end $$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$
declare n integer;
begin
 select count(*) into n from public.user_portfolios;
 if n<>0 then raise exception 'Cross-user read leaked data'; end if;
 select count(*) into n from public.save_user_portfolio(2,'{"plan":{},"records":[]}');
 if n<>0 then raise exception 'Cross-user update accepted'; end if;
end $$;
reset role;
do $$ begin
 if has_table_privilege('anon','public.user_portfolios','SELECT') then raise exception 'Anonymous table access'; end if;
 if has_function_privilege('anon','public.save_user_portfolio(bigint,jsonb)','EXECUTE') then raise exception 'Anonymous RPC access'; end if;
end $$;
select 'personal_cloud_sync passed: CAS, RLS isolation, ownership, shape, anonymous ACL' as result;
rollback;
