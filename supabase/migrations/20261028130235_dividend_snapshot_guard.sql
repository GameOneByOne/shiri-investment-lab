create or replace function public.market_publish_dividends(p_security jsonb,p_events jsonb,p_run_id uuid default null) returns integer
language plpgsql security invoker set search_path='' as $$
declare sym text:=p_security->>'symbol'; src text; n integer;
begin
  src:=case p_security->>'kind' when '股票' then 'eastmoney_stock' when 'ETF' then 'eastmoney_fund' else null end;
  if sym is null or src is null or jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>2000 then
    raise exception 'Invalid corporate-action snapshot'; end if;
  if exists(select 1 from jsonb_array_elements(p_events) e where e->>'source' is distinct from src) then
    raise exception 'Corporate-action source mismatch'; end if;
  perform pg_advisory_xact_lock(hashtextextended(sym||':dividends',0));
  if exists(select 1 from market.dividend_events old where old.symbol=sym and old.plan_status='implemented'
    and not exists(select 1 from jsonb_array_elements(p_events) e
      where e->>'source'=old.source and e->>'sourceId'=old.source_id)) then
    raise exception 'Snapshot would discard implemented dividend records';
  end if;
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

