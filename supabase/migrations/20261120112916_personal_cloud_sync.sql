-- User-owned metadata only. No market prices or computed chart points.
create table public.user_portfolios (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  constraint portfolio_size check (octet_length(data::text) <= 1048576),
  constraint portfolio_shape check (
    jsonb_typeof(data)='object' and data ? 'plan' and data ? 'records'
    and jsonb_typeof(data->'plan')='object'
    and jsonb_typeof(data->'records')='array'
  )
);
alter table public.user_portfolios enable row level security;
revoke all on public.user_portfolios from public,anon,authenticated;
grant select,insert,update on public.user_portfolios to authenticated;
create policy portfolio_read on public.user_portfolios for select to authenticated
  using ((select auth.uid())=user_id);
create policy portfolio_insert on public.user_portfolios for insert to authenticated
  with check ((select auth.uid())=user_id);
create policy portfolio_update on public.user_portfolios for update to authenticated
  using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

-- Empty result means stale revision: fetch, merge and retry. Retrying after a
-- lost response is safe; it cannot overwrite a newer device's version.
create function public.save_user_portfolio(expected_revision bigint,payload jsonb)
returns table(revision bigint,updated_at timestamptz)
language plpgsql security invoker set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if expected_revision=0 then
    return query insert into public.user_portfolios as p(user_id,data)
      values(auth.uid(),payload) on conflict(user_id) do nothing
      returning p.revision,p.updated_at;
  else
    return query update public.user_portfolios as p
      set data=payload,revision=p.revision+1,updated_at=clock_timestamp()
      where p.user_id=auth.uid() and p.revision=expected_revision
      returning p.revision,p.updated_at;
  end if;
end;
$$;
revoke all on function public.save_user_portfolio(bigint,jsonb) from public,anon;
grant execute on function public.save_user_portfolio(bigint,jsonb) to authenticated;
