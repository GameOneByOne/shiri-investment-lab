-- Market data is physically separated from any future user/business tables.
create schema market;
revoke all on schema market from public;
grant usage on schema market to anon, authenticated, service_role;

create table market.securities (
  symbol text primary key check (symbol ~ '^(sh|sz|bj)[0-9]{6}$'),
  name text not null,
  kind text not null check (kind in ('股票','ETF','指数')),
  pinyin text not null default '',
  start_date date not null check (start_date >= date '1990-01-01'),
  enabled boolean not null default true,
  adjust text not null check (adjust in ('qfq','none')),
  refreshed_at timestamptz
);
create table market.daily_bars (
  symbol text not null references market.securities(symbol),
  trade_date date not null,
  open numeric not null check (open > 0 and open < 1e9),
  close numeric not null check (close > 0 and close < 1e9),
  high numeric not null check (high > 0 and high < 1e9),
  low numeric not null check (low > 0 and low < 1e9),
  primary key (symbol, trade_date),
  check (low <= least(open,close) and greatest(open,close) <= high)
);
create table market.collection_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','success','partial','failed')),
  succeeded integer not null default 0,
  errors jsonb not null default '[]'::jsonb
);
alter table market.securities enable row level security;
alter table market.daily_bars enable row level security;
alter table market.collection_runs enable row level security;
create policy market_catalog_read on market.securities for select to anon, authenticated using (enabled);
create policy market_prices_read on market.daily_bars for select to anon, authenticated
  using (exists (select 1 from market.securities s where s.symbol=daily_bars.symbol and s.enabled));
grant select on market.securities, market.daily_bars to anon, authenticated;
grant all on all tables in schema market to service_role;

-- All public read APIs run as the caller and obey table grants and RLS.
create function public.market_config() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'lastCompleteDate',(select max(trade_date) from market.daily_bars where symbol='sh000001'),
    'popular',coalesce((select jsonb_agg(jsonb_build_object('symbol',symbol,'name',name,'kind',kind) order by symbol)
      from market.securities where enabled),'[]'::jsonb))
$$;
create function public.market_search(p_query text default '') returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('results',coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb)) from (
    select symbol,name,kind from market.securities
    where enabled and (position(lower(left(trim(coalesce(p_query,'')),40)) in lower(name||symbol||pinyin))>0)
    order by symbol limit 20
  ) s
$$;
create function public.market_history(p_symbol text,p_start date,p_end date) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare result jsonb;
begin
  if p_symbol is null or p_symbol !~ '^(sh|sz|bj)[0-9]{6}$'
    or p_start is null or p_end is null or p_start < date '1990-01-01' or p_end < p_start
    or p_end > (now() at time zone 'Asia/Shanghai')::date then
    raise exception '请输入有效的证券代码和历史日期范围。' using errcode='22023';
  end if;
  select jsonb_build_object('symbol',s.symbol,'source','腾讯财经','adjust',s.adjust,
    'cached',true,'fetchedAt',s.refreshed_at,
    'firstDate',min(b.trade_date),'lastDate',max(b.trade_date),
    'bars',jsonb_agg(jsonb_build_object('date',b.trade_date,'open',b.open,'close',b.close,'high',b.high,'low',b.low) order by b.trade_date))
    into result from market.securities s join market.daily_bars b on b.symbol=s.symbol
    where s.symbol=p_symbol and s.enabled and b.trade_date between p_start and p_end
    group by s.symbol;
  if result is null then
    raise exception '股票池或所选区间暂无已采集行情，请调整日期或等待采集完成。' using errcode='22023';
  end if;
  return result;
end
$$;

-- Ingestion only. Replaces a complete symbol in a single transaction, including
-- historical qfq values; readers never see a half-published adjusted series.
create function public.market_publish(p_security jsonb,p_bars jsonb) returns integer
language plpgsql security invoker set search_path = '' as $$
declare sym text:=p_security->>'symbol'; n integer;
begin
  if sym is null or sym !~ '^(sh|sz|bj)[0-9]{6}$' or jsonb_typeof(p_bars) is distinct from 'array'
    or jsonb_array_length(p_bars)=0 or jsonb_array_length(p_bars)>20000 then
    raise exception 'Invalid market snapshot';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(sym,0));
  if exists (
    select 1 from market.daily_bars old where old.symbol=sym and not exists (
      select 1 from jsonb_to_recordset(p_bars) as b(date date) where b.date=old.trade_date
    )
  ) then raise exception 'Snapshot would discard previously published dates'; end if;
  if exists (select 1 from jsonb_to_recordset(p_bars) as b(date date)
    where b.date is null or b.date < (p_security->>'start')::date
    or b.date > (now() at time zone 'Asia/Shanghai')::date) then
    raise exception 'Snapshot contains out-of-range dates';
  end if;
  insert into market.securities(symbol,name,kind,pinyin,start_date,enabled,adjust,refreshed_at)
    values(sym,p_security->>'name',p_security->>'kind',coalesce(p_security->>'pinyin',''),
      (p_security->>'start')::date,true,case when sym='sh000001' then 'none' else 'qfq' end,now())
    on conflict(symbol) do update set name=excluded.name,kind=excluded.kind,pinyin=excluded.pinyin,
      start_date=excluded.start_date,enabled=true,adjust=excluded.adjust,refreshed_at=excluded.refreshed_at;
  delete from market.daily_bars where symbol=sym;
  insert into market.daily_bars(symbol,trade_date,open,close,high,low)
    select sym,b.date,b.open,b.close,b.high,b.low from jsonb_to_recordset(p_bars)
      as b(date date,open numeric,close numeric,high numeric,low numeric);
  get diagnostics n = row_count;
  return n;
end
$$;
create function public.market_run_start() returns uuid
language sql security invoker set search_path = '' as $$
  insert into market.collection_runs default values returning id
$$;
create function public.market_run_finish(p_id uuid,p_succeeded integer,p_errors jsonb) returns void
language sql security invoker set search_path = '' as $$
  update market.collection_runs set finished_at=now(),succeeded=p_succeeded,errors=p_errors,
    status=case when jsonb_array_length(p_errors)=0 then 'success' when p_succeeded>0 then 'partial' else 'failed' end
    where id=p_id and status='running'
$$;
revoke all on function public.market_config(), public.market_search(text), public.market_history(text,date,date),
  public.market_publish(jsonb,jsonb), public.market_run_start(), public.market_run_finish(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.market_config(),public.market_search(text),public.market_history(text,date,date) to anon,authenticated,service_role;
grant execute on function public.market_publish(jsonb,jsonb),public.market_run_start(),public.market_run_finish(uuid,integer,jsonb) to service_role;
