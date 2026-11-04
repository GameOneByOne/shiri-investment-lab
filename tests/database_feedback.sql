begin;
set local role anon;
do $$
declare rejected boolean:=false;
begin
 insert into public.feedback(id,category,content,contact,page_path,version)
 values(gen_random_uuid(),'功能建议','  自动化反馈测试，将回滚  ','  ','/my.html','V0.8.0');
 begin perform content from public.feedback; exception when insufficient_privilege then rejected:=true; end;
 assert rejected,'Anonymous reader can see private feedback';rejected:=false;
 begin insert into public.feedback(id,category,content,page_path,version,status) values(gen_random_uuid(),'使用问题','测试','/','V0.8.0','已解决'); exception when insufficient_privilege then rejected:=true; end;
 assert rejected,'Anonymous writer can forge status';rejected:=false;
 begin insert into public.feedback(id,category,content,page_path,version) values(gen_random_uuid(),'使用问题','  ','/','V0.8.0'); exception when check_violation then rejected:=true; end;
 assert rejected,'Blank feedback accepted';rejected:=false;
 begin update public.feedback set status='已解决'; exception when insufficient_privilege then rejected:=true; end;
 assert rejected,'Anonymous writer can alter feedback';rejected:=false;
 begin delete from public.feedback; exception when insufficient_privilege then rejected:=true; end;
 assert rejected,'Anonymous writer can delete feedback';
end $$;
set local role authenticated;
do $$ declare rejected boolean:=false; begin
 begin perform content from public.feedback; exception when insufficient_privilege then rejected:=true; end;
 assert rejected,'Signed-in visitor can read feedback';
end $$;
reset role;
do $$ declare n integer;rejected boolean:=false;begin
 assert exists(select 1 from public.feedback where content='自动化反馈测试，将回滚' and contact is null and status='待处理');
 select 100-count(*) into n from public.feedback where created_at>=now()-interval '1 hour';
 insert into public.feedback(id,category,content,page_path,version)
 select gen_random_uuid(),'其他反馈','容量限制回滚测试','/','V0.8.0' from generate_series(1,n);
 begin insert into public.feedback(id,category,content,page_path,version) values(gen_random_uuid(),'其他反馈','超额回滚测试','/','V0.8.0'); exception when raise_exception then rejected:=true; end;
 assert rejected,'Hourly insert limit ignored';
 assert not has_schema_privilege('anon','app_private','usage');
 assert not has_function_privilege('anon','app_private.guard_feedback_insert()','execute');
end $$;
rollback;
