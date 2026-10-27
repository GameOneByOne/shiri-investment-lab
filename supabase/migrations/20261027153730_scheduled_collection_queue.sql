-- All queue tables and secrets are private to the ingestion service.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create table market.job_secret (id boolean primary key default true check(id), token_hash text not null);
create table market.collection_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references market.collection_runs(id),
  symbol text not null references market.securities(symbol),
  year integer not null check(year between 1990 and 2200),
  security jsonb not null,
  end_date date not null,
  status text not null default 'pending' check(status in ('pending','running','completed','failed')),
  attempts integer not null default 0,
  lease_until timestamptz,
  bars jsonb,
  error text,
  unique(run_id,symbol,year)
);
create index collection_tasks_pending on market.collection_tasks(status,lease_until);
alter table market.job_secret enable row level security;
alter table market.collection_tasks enable row level security;
create policy service_runs on market.collection_runs to service_role using(true) with check(true);
create policy service_tasks on market.collection_tasks to service_role using(true) with check(true);
create policy service_secret on market.job_secret to service_role using(true) with check(true);
grant all on market.job_secret,market.collection_tasks to service_role;

create function public.market_authorize_job(p_token text) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from market.job_secret where token_hash=encode(extensions.digest(p_token,'sha256'),'hex'))
$$;
create function public.market_enqueue() returns uuid
language plpgsql security invoker set search_path='' as $$
declare rid uuid; cutoff date;
begin
  perform pg_advisory_xact_lock(8627340101);
  if exists(select 1 from market.collection_runs where status='running') then return null; end if;
  cutoff:=(now() at time zone 'Asia/Shanghai' - interval '16 hours')::date;
  if extract(hour from now() at time zone 'Asia/Shanghai')>=16 then cutoff:=(now() at time zone 'Asia/Shanghai')::date; end if;
  insert into market.collection_runs default values returning id into rid;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date)
    select rid,s.symbol,y,jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,'start',s.start_date),cutoff
    from market.securities s cross join lateral generate_series(extract(year from s.start_date)::integer,extract(year from cutoff)::integer) y
    where s.enabled;
  return rid;
end
$$;
create function public.market_close_finished_runs() returns void
language sql security invoker set search_path='' as $$
  with counts as (
    select run_id,count(*) filter(where bad=0) as succeeded,count(*) filter(where bad>0) as failed,
      coalesce(jsonb_agg(jsonb_build_object('symbol',symbol,'error',error)) filter(where bad>0),'[]') as errors
    from (select run_id,symbol,count(*) filter(where status='failed') bad,max(error) error
      from market.collection_tasks group by run_id,symbol) s
    where not exists(select 1 from market.collection_tasks t where t.run_id=s.run_id and t.status in ('pending','running'))
    group by run_id
  ) update market.collection_runs r set finished_at=now(),succeeded=c.succeeded,errors=c.errors,
    status=case when c.failed=0 then 'success' when c.succeeded>0 then 'partial' else 'failed' end
    from counts c where r.id=c.run_id and r.status='running'
$$;
create function public.market_claim_task() returns jsonb
language plpgsql security invoker set search_path='' as $$
declare task market.collection_tasks;
begin
  update market.collection_tasks set status='failed',error='Worker lease expired after 3 attempts'
    where status='running' and lease_until<now() and attempts>=3;
  perform public.market_close_finished_runs();
  select * into task from market.collection_tasks
    where attempts<3 and (status='pending' or (status='running' and lease_until<now()))
    order by attempts,run_id,symbol,year for update skip locked limit 1;
  if task.id is null then return null; end if;
  update market.collection_tasks set status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes'
    where id=task.id returning * into task;
  return to_jsonb(task)-'bars'-'error';
end
$$;
create function public.market_complete_task(p_id uuid,p_attempt integer,p_bars jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare task market.collection_tasks; all_bars jsonb;
begin
  select * into task from market.collection_tasks where id=p_id for update;
  if task.status is distinct from 'running' or task.attempts<>p_attempt then raise exception 'Stale task attempt'; end if;
  if jsonb_typeof(p_bars) is distinct from 'array' or exists(select 1 from jsonb_to_recordset(p_bars) b(date date)
    where extract(year from b.date)<>task.year or b.date>task.end_date or b.date<(task.security->>'start')::date) then
    raise exception 'Invalid year snapshot';
  end if;
  update market.collection_tasks set status='completed',bars=p_bars,lease_until=null,error=null where id=p_id;
  perform pg_advisory_xact_lock(hashtextextended(task.run_id::text||task.symbol,0));
  if not exists(select 1 from market.collection_tasks where run_id=task.run_id and symbol=task.symbol and status<>'completed') then
    select jsonb_agg(b.value order by b.value->>'date') into all_bars
      from market.collection_tasks t cross join lateral jsonb_array_elements(t.bars) b
      where t.run_id=task.run_id and t.symbol=task.symbol;
    perform public.market_publish(task.security,all_bars);
  end if;
  perform public.market_close_finished_runs();
end
$$;
create function public.market_fail_task(p_id uuid,p_attempt integer,p_error text) returns void
language sql security invoker set search_path='' as $$
  update market.collection_tasks set status=case when attempts>=3 then 'failed' else 'pending' end,
    error=left(p_error,300),lease_until=null
    where id=p_id and status='running' and attempts=p_attempt;
  select public.market_close_finished_runs()
$$;
revoke all on function public.market_authorize_job(text),public.market_enqueue(),public.market_close_finished_runs(),
  public.market_claim_task(),public.market_complete_task(uuid,integer,jsonb),public.market_fail_task(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.market_authorize_job(text),public.market_enqueue(),public.market_close_finished_runs(),
  public.market_claim_task(),public.market_complete_task(uuid,integer,jsonb),public.market_fail_task(uuid,integer,text) to service_role;

-- Queue payloads are staging only; retain recent run summaries for operations.
select cron.schedule('shiri-queue-cleanup','30 12 * * *',$$
  delete from market.collection_tasks where run_id in
    (select id from market.collection_runs where finished_at < now()-interval '2 days');
  delete from market.collection_runs where finished_at < now()-interval '30 days';
$$);
select cron.schedule('shiri-nightly-21-shanghai','0 13 * * *',$$select public.market_enqueue();$$);

insert into market.securities(symbol,name,kind,pinyin,start_date,adjust) values
('sh600519','贵州茅台','股票','guizhoumaotai gzmt','2020-01-01','qfq'),
('sz000001','平安银行','股票','pinganyinhang payh','2020-01-01','qfq'),
('sh600036','招商银行','股票','zhaoshangyinhang zsyh','2020-01-01','qfq'),
('sz300750','宁德时代','股票','ningdeshidai ndsd','2020-01-01','qfq'),
('sh510300','沪深300ETF','ETF','hushen300 hs300','2020-01-01','qfq'),
('sh510500','中证500ETF','ETF','zhongzheng500 zz500','2020-01-01','qfq'),
('sh510050','上证50ETF','ETF','shangzheng50 sz50','2020-01-01','qfq'),
('sh000001','上证指数','指数','shangzhengzhishu szzs','2020-01-01','none');
