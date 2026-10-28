-- Keep the default backtest history API compatible while storing all price bases.
create table market.price_daily (
  symbol text not null references market.securities(symbol),
  adjust text not null check(adjust in ('none','qfq','hfq')),
  trade_date date not null,
  open numeric not null check(open>0 and open<1e12),
  close numeric not null check(close>0 and close<1e12),
  high numeric not null check(high>0 and high<1e12),
  low numeric not null check(low>0 and low<1e12),
  volume_raw numeric check(volume_raw>=0 and volume_raw<1e20),
  volume_unit text not null default 'tencent_native' check(volume_unit='tencent_native'),
  amount_cny numeric check(amount_cny>=0 and amount_cny<1e20),
  turnover_rate numeric check(turnover_rate>=0 and turnover_rate<1e6),
  primary key(symbol,adjust,trade_date),
  check(low<=least(open,close) and greatest(open,close)<=high)
);
create table market.price_series (
  symbol text not null references market.securities(symbol),
  adjust text not null check(adjust in ('none','qfq','hfq')),
  source text not null default '腾讯财经',
  first_date date not null, last_date date not null,
  row_count integer not null check(row_count>0),
  fetched_at timestamptz not null, last_run_id uuid,
  primary key(symbol,adjust)
);
insert into market.price_daily(symbol,adjust,trade_date,open,close,high,low)
  select b.symbol,s.adjust,b.trade_date,b.open,b.close,b.high,b.low
  from market.daily_bars b join market.securities s on s.symbol=b.symbol;
insert into market.price_series(symbol,adjust,first_date,last_date,row_count,fetched_at)
  select b.symbol,s.adjust,min(b.trade_date),max(b.trade_date),count(*),s.refreshed_at
  from market.daily_bars b join market.securities s on s.symbol=b.symbol group by b.symbol,s.symbol;

create table market.dividend_events (
  symbol text not null references market.securities(symbol),
  source text not null check(source in ('eastmoney_stock','eastmoney_fund')),
  source_id text not null check(length(source_id) between 1 and 120),
  report_date date, plan_announcement_date date, latest_announcement_date date,
  record_date date, ex_date date, pay_date date,
  plan_status text not null check(plan_status in ('implemented','scheduled','proposed','cancelled','no_distribution','unknown')),
  status_text text not null,
  cash_per_10 numeric check(cash_per_10>=0 and cash_per_10<1e10),
  cash_per_unit numeric generated always as (cash_per_10/10) stored,
  bonus_shares_per_10 numeric check(bonus_shares_per_10>=0 and bonus_shares_per_10<1e10),
  transfer_shares_per_10 numeric check(transfer_shares_per_10>=0 and transfer_shares_per_10<1e10),
  currency text not null check(currency='CNY'),
  tax_basis text not null check(tax_basis in ('pretax','source_unspecified')),
  plan_text text not null, source_url text not null,
  raw jsonb not null, fetched_at timestamptz not null,
  primary key(symbol,source,source_id)
);
create index dividend_events_dates on market.dividend_events(symbol,ex_date);
create table market.dividend_series (
  symbol text primary key references market.securities(symbol),
  source text not null, row_count integer not null check(row_count>=0),
  fetched_at timestamptz not null, last_run_id uuid
);
alter table market.price_daily enable row level security;
alter table market.price_series enable row level security;
alter table market.dividend_events enable row level security;
alter table market.dividend_series enable row level security;
create policy public_prices on market.price_daily for select to anon,authenticated using
  (exists(select 1 from market.securities s where s.symbol=price_daily.symbol and s.enabled));
create policy public_price_series on market.price_series for select to anon,authenticated using
  (exists(select 1 from market.securities s where s.symbol=price_series.symbol and s.enabled));
create policy public_dividends on market.dividend_events for select to anon,authenticated using
  (exists(select 1 from market.securities s where s.symbol=dividend_events.symbol and s.enabled));
create policy public_dividend_series on market.dividend_series for select to anon,authenticated using
  (exists(select 1 from market.securities s where s.symbol=dividend_series.symbol and s.enabled));
grant select on market.price_daily,market.price_series,market.dividend_events,market.dividend_series to anon,authenticated;
grant all on market.price_daily,market.price_series,market.dividend_events,market.dividend_series to service_role;

alter table market.collection_tasks add column dataset text not null default 'prices' check(dataset in ('prices','dividends'));
alter table market.collection_tasks add column adjust text not null default 'qfq' check(adjust in ('none','qfq','hfq'));
update market.collection_tasks set adjust='none' where security->>'kind'='指数';
alter table market.collection_tasks drop constraint collection_tasks_run_id_symbol_year_key;
alter table market.collection_tasks add unique(run_id,symbol,year,dataset,adjust);

create function public.market_publish_prices(p_security jsonb,p_adjust text,p_bars jsonb,p_run_id uuid default null)
returns integer language plpgsql security invoker set search_path='' as $$
declare sym text:=p_security->>'symbol'; n integer; default_mode boolean;
begin
  if sym is null or sym !~ '^(sh|sz|bj)[0-9]{6}$' or p_adjust is null or p_adjust not in ('none','qfq','hfq')
    or (p_security->>'kind'='指数' and p_adjust<>'none') or jsonb_typeof(p_bars) is distinct from 'array'
    or jsonb_array_length(p_bars)=0 or jsonb_array_length(p_bars)>20000 then raise exception 'Invalid price snapshot'; end if;
  perform pg_advisory_xact_lock(hashtextextended(sym,0));
  if exists(select 1 from market.price_daily old where old.symbol=sym and old.adjust=p_adjust and not exists
    (select 1 from jsonb_to_recordset(p_bars) b(date date) where b.date=old.trade_date)) then
    raise exception 'Snapshot would discard previously published dates'; end if;
  if exists(select 1 from jsonb_to_recordset(p_bars) b(date date) where b.date is null
    or b.date<(p_security->>'start')::date or b.date>(now() at time zone 'Asia/Shanghai')::date) then
    raise exception 'Snapshot contains out-of-range dates'; end if;
  default_mode:=p_adjust=case when p_security->>'kind'='指数' then 'none' else 'qfq' end;
  insert into market.securities(symbol,name,kind,pinyin,start_date,adjust,refreshed_at)
    values(sym,p_security->>'name',p_security->>'kind',coalesce(p_security->>'pinyin',''),(p_security->>'start')::date,
      case when p_security->>'kind'='指数' then 'none' else 'qfq' end,case when default_mode then now() else null end)
    on conflict(symbol) do update set name=excluded.name,kind=excluded.kind,pinyin=excluded.pinyin,
      start_date=excluded.start_date,refreshed_at=case when default_mode then now() else market.securities.refreshed_at end;
  delete from market.price_daily where symbol=sym and adjust=p_adjust;
  insert into market.price_daily(symbol,adjust,trade_date,open,close,high,low,volume_raw,volume_unit,amount_cny,turnover_rate)
    select sym,p_adjust,b.date,b.open,b.close,b.high,b.low,b."volumeRaw",coalesce(b."volumeUnit",'tencent_native'),b."amountCny",b."turnoverRate"
    from jsonb_to_recordset(p_bars) b(date date,open numeric,close numeric,high numeric,low numeric,
      "volumeRaw" numeric,"volumeUnit" text,"amountCny" numeric,"turnoverRate" numeric);
  get diagnostics n=row_count;
  insert into market.price_series(symbol,adjust,first_date,last_date,row_count,fetched_at,last_run_id)
    select sym,p_adjust,min(trade_date),max(trade_date),count(*),now(),p_run_id from market.price_daily where symbol=sym and adjust=p_adjust
    on conflict(symbol,adjust) do update set first_date=excluded.first_date,last_date=excluded.last_date,
      row_count=excluded.row_count,fetched_at=excluded.fetched_at,last_run_id=excluded.last_run_id;
  if default_mode then
    delete from market.daily_bars where symbol=sym;
    insert into market.daily_bars select symbol,trade_date,open,close,high,low from market.price_daily where symbol=sym and adjust=p_adjust;
  end if;
  return n;
end $$;
create or replace function public.market_publish(p_security jsonb,p_bars jsonb) returns integer
language sql security invoker set search_path='' as $$
  select public.market_publish_prices(p_security,case when p_security->>'symbol'='sh000001' then 'none' else 'qfq' end,p_bars)
$$;
create function public.market_publish_dividends(p_security jsonb,p_events jsonb,p_run_id uuid default null) returns integer
language plpgsql security invoker set search_path='' as $$
declare sym text:=p_security->>'symbol'; src text; n integer;
begin
  src:=case p_security->>'kind' when '股票' then 'eastmoney_stock' when 'ETF' then 'eastmoney_fund' else null end;
  if sym is null or src is null or jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>2000 then
    raise exception 'Invalid corporate-action snapshot'; end if;
  if exists(select 1 from jsonb_array_elements(p_events) e where e->>'source' is distinct from src) then
    raise exception 'Corporate-action source mismatch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(sym||':dividends',0));
  delete from market.dividend_events where symbol=sym;
  insert into market.dividend_events(symbol,source,source_id,report_date,plan_announcement_date,latest_announcement_date,
    record_date,ex_date,pay_date,plan_status,status_text,cash_per_10,bonus_shares_per_10,transfer_shares_per_10,
    currency,tax_basis,plan_text,source_url,raw,fetched_at)
    select sym,src,e."sourceId",e."reportDate",e."planDate",e."noticeDate",e."recordDate",e."exDate",e."payDate",
      e.status,e."statusText",e."cashPer10",e."bonusSharesPer10",e."transferSharesPer10",e.currency,e."taxBasis",e."planText",e."sourceUrl",e.raw,now()
    from jsonb_to_recordset(p_events) e("sourceId" text,"reportDate" date,"planDate" date,"noticeDate" date,"recordDate" date,
      "exDate" date,"payDate" date,status text,"statusText" text,"cashPer10" numeric,"bonusSharesPer10" numeric,
      "transferSharesPer10" numeric,currency text,"taxBasis" text,"planText" text,"sourceUrl" text,raw jsonb);
  get diagnostics n=row_count;
  insert into market.dividend_series(symbol,source,row_count,fetched_at,last_run_id) values(sym,src,n,now(),p_run_id)
    on conflict(symbol) do update set source=excluded.source,row_count=n,fetched_at=now(),last_run_id=p_run_id;
  return n;
end $$;

create or replace function public.market_enqueue() returns uuid
language plpgsql security invoker set search_path='' as $$
declare rid uuid; cutoff date;
begin
  perform pg_advisory_xact_lock(8627340101);
  if exists(select 1 from market.collection_runs where status='running') then return null; end if;
  cutoff:=(now() at time zone 'Asia/Shanghai')::date;
  if extract(hour from now() at time zone 'Asia/Shanghai')<16 then cutoff:=cutoff-1; end if;
  insert into market.collection_runs default values returning id into rid;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
    select rid,s.symbol,y,jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,'start',s.start_date),cutoff,'prices',m
    from market.securities s
    cross join lateral generate_series(extract(year from s.start_date)::integer,extract(year from cutoff)::integer) y
    cross join lateral unnest(case when s.kind='指数' then array['none'] else array['none','qfq','hfq'] end) m where s.enabled;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
    select rid,s.symbol,extract(year from cutoff)::integer,
      jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,'start',s.start_date),cutoff,'dividends','none'
    from market.securities s where s.enabled and s.kind<>'指数';
  return rid;
end $$;
create or replace function public.market_complete_task(p_id uuid,p_attempt integer,p_bars jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare task market.collection_tasks; all_bars jsonb;
begin
  select * into task from market.collection_tasks where id=p_id for update;
  if task.status is distinct from 'running' or task.attempts<>p_attempt then raise exception 'Stale task attempt'; end if;
  if jsonb_typeof(p_bars) is distinct from 'array' then raise exception 'Invalid task payload'; end if;
  if task.dataset='prices' and exists(select 1 from jsonb_to_recordset(p_bars) b(date date)
    where b.date is null or extract(year from b.date)<>task.year or b.date>task.end_date or b.date<(task.security->>'start')::date) then
    raise exception 'Invalid year snapshot'; end if;
  update market.collection_tasks set status='completed',bars=p_bars,lease_until=null,error=null where id=p_id;
  perform pg_advisory_xact_lock(hashtextextended(task.run_id::text||task.symbol||task.dataset||task.adjust,0));
  if task.dataset='dividends' then
    perform public.market_publish_dividends(task.security,p_bars,task.run_id);
  elsif not exists(select 1 from market.collection_tasks where run_id=task.run_id and symbol=task.symbol
    and dataset=task.dataset and adjust=task.adjust and status<>'completed') then
    select jsonb_agg(b.value order by b.value->>'date') into all_bars
      from market.collection_tasks t cross join lateral jsonb_array_elements(t.bars) b
      where t.run_id=task.run_id and t.symbol=task.symbol and t.dataset=task.dataset and t.adjust=task.adjust;
    perform public.market_publish_prices(task.security,task.adjust,all_bars,task.run_id);
  end if;
  perform public.market_close_finished_runs();
end $$;

create function public.market_prices(p_symbol text,p_start date,p_end date,p_adjust text default 'qfq') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_symbol is null or p_symbol !~ '^(sh|sz|bj)[0-9]{6}$' or p_adjust is null or p_adjust not in ('none','qfq','hfq')
    or p_start is null or p_end is null or p_start<date '1990-01-01' or p_end<p_start
    or p_end>(now() at time zone 'Asia/Shanghai')::date then raise exception '请输入有效的代码、日期和复权口径。' using errcode='22023'; end if;
  select jsonb_build_object('symbol',s.symbol,'source',m.source,'adjust',p_adjust,'cached',true,'fetchedAt',m.fetched_at,
    'firstDate',min(b.trade_date),'lastDate',max(b.trade_date),
    'bars',jsonb_agg(jsonb_build_object('date',b.trade_date,'open',b.open,'close',b.close,'high',b.high,'low',b.low,
      'volumeRaw',b.volume_raw,'volumeUnit',b.volume_unit,'amountCny',b.amount_cny,'turnoverRate',b.turnover_rate) order by b.trade_date))
    into result from market.securities s join market.price_series m on m.symbol=s.symbol and m.adjust=p_adjust
    join market.price_daily b on b.symbol=m.symbol and b.adjust=m.adjust
    where s.symbol=p_symbol and s.enabled and b.trade_date between p_start and p_end group by s.symbol,m.source,m.fetched_at;
  if result is null then raise exception '所选口径或区间暂无已采集行情。' using errcode='22023'; end if;
  return result;
end $$;
create or replace function public.market_history(p_symbol text,p_start date,p_end date) returns jsonb
language sql stable security invoker set search_path='' as $$
  select public.market_prices(p_symbol,p_start,p_end,case when p_symbol='sh000001' then 'none' else 'qfq' end)
$$;
create function public.market_dividends(p_symbol text,p_start date default date '1990-01-01',p_end date default current_date) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare sec market.securities; meta market.dividend_series; events jsonb;
begin
  if p_symbol is null or p_start is null or p_end is null or p_start<date '1990-01-01' or p_end<p_start
    or p_end>(now() at time zone 'Asia/Shanghai')::date then raise exception 'Invalid dividend date range' using errcode='22023'; end if;
  select * into sec from market.securities where symbol=p_symbol and enabled;
  if sec.symbol is null then raise exception '股票池标的不存在。' using errcode='22023'; end if;
  select * into meta from market.dividend_series where symbol=p_symbol;
  select coalesce(jsonb_agg(jsonb_build_object('id',source_id,'source',source,'reportDate',report_date,
    'planDate',plan_announcement_date,'noticeDate',latest_announcement_date,'recordDate',record_date,'exDate',ex_date,'payDate',pay_date,
    'status',plan_status,'statusText',status_text,'cashPer10',cash_per_10,'cashPerUnit',cash_per_unit,
    'bonusSharesPer10',bonus_shares_per_10,'transferSharesPer10',transfer_shares_per_10,'currency',currency,
    'taxBasis',tax_basis,'planText',plan_text,'sourceUrl',source_url) order by coalesce(ex_date,record_date,plan_announcement_date,report_date)),'[]')
    into events from market.dividend_events where symbol=p_symbol
    and coalesce(ex_date,record_date,plan_announcement_date,report_date) between p_start and p_end;
  return jsonb_build_object('symbol',p_symbol,'status',case when sec.kind='指数' then 'not_applicable'
    when meta.symbol is null then 'not_collected' else 'collected' end,'source',meta.source,'fetchedAt',meta.fetched_at,
    'totalRecords',meta.row_count,'events',events,'cashUnit','CNY per share or fund unit',
    'note','分红方案与现金到账不是同一事件；缺失的派息日和金额为 null，当前回测不计入独立分红现金流。');
end $$;
create function public.market_data_status(p_symbol text) returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('symbol',s.symbol,'prices',coalesce((select jsonb_agg(jsonb_build_object('adjust',p.adjust,
    'firstDate',p.first_date,'lastDate',p.last_date,'count',p.row_count,'fetchedAt',p.fetched_at,'source',p.source) order by p.adjust)
    from market.price_series p where p.symbol=s.symbol),'[]'),
    'dividends',jsonb_build_object('status',case when s.kind='指数' then 'not_applicable' when d.symbol is null then 'not_collected' else 'collected' end,
      'count',d.row_count,'source',d.source,'fetchedAt',d.fetched_at))
    from market.securities s left join market.dividend_series d on d.symbol=s.symbol where s.symbol=p_symbol and s.enabled
$$;
revoke all on function public.market_publish_prices(jsonb,text,jsonb,uuid),public.market_publish_dividends(jsonb,jsonb,uuid),
  public.market_prices(text,date,date,text),public.market_dividends(text,date,date),public.market_data_status(text) from public,anon,authenticated;
grant execute on function public.market_publish_prices(jsonb,text,jsonb,uuid),public.market_publish_dividends(jsonb,jsonb,uuid) to service_role;
grant execute on function public.market_prices(text,date,date,text),public.market_dividends(text,date,date),public.market_data_status(text) to anon,authenticated,service_role;

