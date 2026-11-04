create table public.feedback (
 id uuid primary key,
 created_at timestamptz not null default now(),
 category text not null check(category in ('使用问题','功能建议','其他反馈')),
 content text not null check(char_length(btrim(content)) between 1 and 2000),
 contact text check(contact is null or char_length(contact)<=120),
 page_path text not null check(page_path in ('/','/my.html','/progress.html')),
 version text not null check(version ~ '^V[0-9]+\.[0-9]+\.[0-9]+$' and char_length(version)<=30),
 status text not null default '待处理' check(status in ('待处理','处理中','已解决'))
);
comment on table public.feedback is '拾日内测反馈；仅后台管理员可查看和处理。';
comment on column public.feedback.contact is '用户选填的联系方式；不公开展示。';
create index feedback_created_at_idx on public.feedback(created_at desc);
alter table public.feedback enable row level security;
revoke all on public.feedback from public,anon,authenticated;
grant insert(id,category,content,contact,page_path,version) on public.feedback to anon,authenticated;
grant all on public.feedback to service_role;
create policy feedback_submit_only on public.feedback for insert to anon,authenticated
 with check(status='待处理' and created_at=now());
-- A private trigger can count submissions without granting readers access to feedback.
-- Anonymous submissions are intentional: there is no identity-based authorization.
create schema if not exists app_private;
revoke all on schema app_private from public,anon,authenticated;
create function app_private.guard_feedback_insert() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(8627340110);
 if (select count(*) from public.feedback where created_at>=now()-interval '1 hour')>=100
 or (select count(*) from public.feedback where created_at>=now()-interval '24 hours')>=1000 then
  raise exception '反馈提交较多，请稍后再试。' using errcode='P0001';
 end if;
 new.content:=btrim(new.content);
 new.contact:=nullif(btrim(new.contact),'');
 return new;
end $$;
revoke all on function app_private.guard_feedback_insert() from public,anon,authenticated;
create trigger feedback_insert_guard before insert on public.feedback
 for each row execute function app_private.guard_feedback_insert();
notify pgrst,'reload schema';
