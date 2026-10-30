-- Raw close-only data from 2021. Rebuild the large table to actually reclaim storage.
set lock_timeout='10s';
lock table market.price_daily,market.daily_bars,market.collection_tasks in access exclusive mode;
create table market.price_daily_lean (
 symbol text not null references market.securities(symbol),
 trade_date date not null check(trade_date>=date '2021-01-01'),
 close numeric not null check(close>0 and close<1e12),
 primary key(symbol,trade_date)
);
insert into market.price_daily_lean select symbol,trade_date,close from market.price_daily where adjust='none' and trade_date>=date '2021-01-01';
alter table market.price_daily_lean enable row level security;
create policy public_prices on market.price_daily_lean for select to anon,authenticated using
 (exists(select 1 from market.securities s where s.symbol=price_daily_lean.symbol and s.enabled));
grant select on market.price_daily_lean to anon,authenticated;
grant all on market.price_daily_lean to service_role;
drop table market.daily_bars;
drop table market.price_daily;
alter table market.price_daily_lean rename to price_daily;
delete from market.price_series where adjust<>'none';
update market.price_series p set first_date=x.first_date,last_date=x.last_date,row_count=x.n from
 (select symbol,min(trade_date) first_date,max(trade_date) last_date,count(*) n from market.price_daily group by symbol) x where p.symbol=x.symbol;
update market.securities set adjust='none',start_date=greatest(start_date,date '2021-01-01');
alter table market.securities alter column adjust set default 'none';
alter table market.collection_tasks alter column adjust set default 'none';
delete from market.collection_tasks where adjust<>'none' or (dataset='prices' and year<2021);
update market.collection_tasks set security=jsonb_set(security,'{start}',to_jsonb(greatest((security->>'start')::date,date '2021-01-01')));
update market.collection_tasks t set bars=(select coalesce(jsonb_agg(jsonb_build_object('date',b->>'date','close',b->'close')),'[]'::jsonb) from jsonb_array_elements(t.bars) b where b->>'date'>='2021-01-01') where dataset='prices' and bars is not null;
alter table market.price_series add constraint raw_series_only check(adjust='none');
alter table market.collection_tasks add constraint raw_tasks_only check(adjust='none');
alter table market.securities add constraint raw_security_only check(adjust='none');
delete from market.dividend_events where coalesce(ex_date,record_date,plan_announcement_date,report_date)<date '2021-01-01';
alter table market.dividend_events drop column raw;
update market.dividend_series d set row_count=(select count(*) from market.dividend_events e where e.symbol=d.symbol);

CREATE OR REPLACE FUNCTION public.market_bulk_pump()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c market.bulk_control; m market.bulk_members; rid uuid; cutoff date; sec jsonb; endyear integer;
begin
  perform pg_advisory_xact_lock(8627340102);
  select * into c from market.bulk_control where id for update;
  if c.id is null then return; end if;
  update market.bulk_control set database_bytes=pg_database_size(current_database()),updated_at=now() where id returning * into c;
  -- A completed run is summarized durably before its staging rows are removed.
  for m in select b.* from market.bulk_members b join market.collection_runs r on r.id=b.run_id where b.status='collecting' and r.status<>'running' loop
    update market.bulk_members set status=case when r.status='success' then 'completed' when exists(select 1 from market.price_series where symbol=m.symbol and last_run_id=m.run_id) then 'partial' else 'failed' end,
      requests_done=(select count(*) from market.collection_tasks where run_id=m.run_id and status='completed'),
      requests_failed=(select count(*) from market.collection_tasks where run_id=m.run_id and status='failed'),
      price_rows=(select coalesce(sum(row_count),0) from market.price_series where symbol=m.symbol),
      dividend_rows=(select coalesce(sum(row_count),0) from market.dividend_series where symbol=m.symbol),
      error=nullif(r.errors::text,'[]'),finished_at=now()
      from market.collection_runs r where r.id=m.run_id and market.bulk_members.symbol=m.symbol;
    delete from market.collection_tasks where run_id=m.run_id;
  end loop;
  if c.database_bytes>=c.capacity_bytes then
    update market.bulk_control set state='paused_capacity',last_error='Free-plan safety threshold reached; no further bulk downloads will be started' where id;
  elsif c.state not in ('paused_manual','paused_capacity') then
    if c.blocked_until>now() then
      update market.bulk_control set state='paused_provider' where id;
    else
      update market.bulk_control set state=case when c.catalog_complete then 'running' else 'cataloguing' end where id;
      if (select count(*) from market.bulk_members where status='collecting')<2 then
        select * into m from market.bulk_members where status='queued' order by ordinal for update skip locked limit 1;
        if m.symbol is not null then
          cutoff:=c.cutoff; endyear:=extract(year from cutoff)::integer;
          select jsonb_build_object('symbol',symbol,'name',name,'kind',kind,'pinyin',pinyin,'start',start_date) into sec from market.securities where symbol=m.symbol;
          insert into market.collection_runs default values returning id into rid;
          insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
            select rid,m.symbol,y,sec,cutoff,'prices',a from generate_series(extract(year from (sec->>'start')::date)::integer,endyear) y
            cross join unnest(array['none']) a;
          insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
            values(rid,m.symbol,endyear,sec,cutoff,'dividends','none');
          update market.bulk_members set status='collecting',run_id=rid,started_at=now() where symbol=m.symbol;
        end if;
      end if;
      if c.catalog_complete and not exists(select 1 from market.bulk_members where status in ('queued','collecting')) then
        update market.bulk_control set state=case when exists(select 1 from market.bulk_members where status in ('partial','failed')) then 'completed_with_errors' else 'completed' end where id;
      end if;
    end if;
  end if;
  perform public.market_bulk_refresh_progress();
end $function$
;

CREATE OR REPLACE FUNCTION public.market_bulk_catalog_complete(p_page integer, p_total integer, p_stocks jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c market.bulk_control; n integer; expected integer;
begin
  select * into c from market.bulk_control where id for update;
  if c.catalog_page<>p_page or c.catalog_lease is null or c.catalog_complete then raise exception 'Stale catalogue page'; end if;
  if p_total not between 4000 and 12000 or (c.catalog_total is not null and c.catalog_total<>p_total) then raise exception 'Catalogue total changed'; end if;
  expected:=least(100,p_total-(p_page-1)*100);
  if jsonb_typeof(p_stocks) is distinct from 'array' or jsonb_array_length(p_stocks)<>expected or expected<1 then raise exception 'Incomplete catalogue page'; end if;
  if exists(select 1 from jsonb_to_recordset(p_stocks) s(symbol text,name text,listed date,start date,exchange text)
    where s.symbol !~ '^(sh6|sz[03]|bj[489])[0-9]{5}$' or s.symbol is null or s.name is null or s.listed is null or s.listed>c.cutoff
    or s.start is distinct from greatest(date '2021-01-01',s.listed) or s.exchange is distinct from left(s.symbol,2))
    then raise exception 'Invalid catalogue identity'; end if;
  if exists(select 1 from jsonb_to_recordset(p_stocks) s(symbol text) join market.bulk_members b using(symbol)) then raise exception 'Duplicate catalogue member'; end if;
  insert into market.securities(symbol,name,kind,start_date,adjust,enabled,nightly)
    select symbol,name,'股票',start,'none',false,false from jsonb_to_recordset(p_stocks) s(symbol text,name text,start date)
    on conflict(symbol) do update set name=excluded.name;
  insert into market.bulk_members(symbol,ordinal,listed_date,exchange,requests_total)
    select s->>'symbol',(p_page-1)*100+ord::integer,(s->>'listed')::date,s->>'exchange',
      (extract(year from c.cutoff)::integer-extract(year from (s->>'start')::date)::integer+1)+1
    from jsonb_array_elements(p_stocks) with ordinality x(s,ord);
  select count(*) into n from market.bulk_members;
  if p_page*100>=p_total and n<>p_total then raise exception 'Catalogue universe incomplete'; end if;
  update market.bulk_control set catalog_page=p_page+1,catalog_total=p_total,catalog_complete=n=p_total,
    catalog_lease=null,catalog_next_at=now()+interval '60 seconds',catalog_failures=0,last_error=null where id;
  perform public.market_bulk_refresh_progress();
end $function$
;

CREATE OR REPLACE FUNCTION public.market_bulk_refresh_progress()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare c market.bulk_control; data jsonb;
begin
  select * into c from market.bulk_control where id;
  if c.id is null then return; end if;
  select jsonb_build_object(
    'state',c.state,'startedAt',c.started_at,'cutoff',c.cutoff,'historyStart','2021-01-01',
    'catalogue',jsonb_build_object('source',c.source,'nextPage',c.catalog_page,'expectedStocks',c.catalog_total,
      'discoveredStocks',count(*),'complete',c.catalog_complete,'nextAttemptAt',c.catalog_next_at),
    'stocks',jsonb_build_object('total',c.catalog_total,'queued',count(*) filter(where status='queued'),
      'collecting',count(*) filter(where status='collecting'),'completed',count(*) filter(where status='completed'),
      'partial',count(*) filter(where status='partial'),'failed',count(*) filter(where status='failed')),
    'requests',jsonb_build_object('totalKnown',coalesce(sum(requests_total),0),
      'completed',coalesce(sum(requests_done),0)+(select count(*) from market.collection_tasks t join market.bulk_members m on m.run_id=t.run_id where m.status='collecting' and t.status='completed'),
      'failed',coalesce(sum(requests_failed),0)+(select count(*) from market.collection_tasks t join market.bulk_members m on m.run_id=t.run_id where m.status='collecting' and t.status='failed')),
    'published',jsonb_build_object('priceRows',(select coalesce(sum(p.row_count),0) from market.price_series p join market.bulk_members m on m.symbol=p.symbol and m.run_id=p.last_run_id),'dividendRows',(select coalesce(sum(p.row_count),0) from market.dividend_series p join market.bulk_members m on m.symbol=p.symbol and m.run_id=p.last_run_id)),
    'capacity',jsonb_build_object('databaseBytes',c.database_bytes,'pauseAtBytes',c.capacity_bytes,'plan','free'),
    'blockedUntil',c.blocked_until,'lastError',c.last_error,
    'recentFailures',coalesce((select jsonb_agg(x) from (select symbol,status,error,finished_at from market.bulk_members
      where status in ('partial','failed') order by finished_at desc limit 10) x),'[]'::jsonb),
    'ratePolicy',jsonb_build_object('concurrency',1,'minimumIntervalSeconds',6,'maximumAttempts',3,'restrictionCooldownHours',24)
  ) into data from market.bulk_members;
  insert into market.bulk_progress(id,snapshot) values(true,data)
    on conflict(id) do update set snapshot=excluded.snapshot,updated_at=now();
end $function$
;

CREATE OR REPLACE FUNCTION public.market_enqueue()
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare rid uuid; cutoff date;
begin
  perform pg_advisory_xact_lock(8627340101);
  if exists(select 1 from market.collection_runs r where r.status='running' and not exists(select 1 from market.bulk_members b where b.run_id=r.id)) then return null; end if;
  cutoff:=(now() at time zone 'Asia/Shanghai')::date;
  if extract(hour from now() at time zone 'Asia/Shanghai')<16 then cutoff:=cutoff-1; end if;
  insert into market.collection_runs default values returning id into rid;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
    select rid,s.symbol,y,jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,'start',s.start_date),cutoff,'prices',m
    from market.securities s cross join lateral generate_series(extract(year from s.start_date)::integer,extract(year from cutoff)::integer) y
    cross join lateral unnest(array['none']) m where s.enabled and s.nightly;
  insert into market.collection_tasks(run_id,symbol,year,security,end_date,dataset,adjust)
    select rid,s.symbol,extract(year from cutoff)::integer,jsonb_build_object('symbol',s.symbol,'name',s.name,'kind',s.kind,'pinyin',s.pinyin,'start',s.start_date),cutoff,'dividends','none'
    from market.securities s where s.enabled and s.nightly and s.kind<>'指数';
  return rid;
end $function$
;

CREATE OR REPLACE FUNCTION public.market_complete_task(p_id uuid, p_attempt integer, p_bars jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare task market.collection_tasks; all_bars jsonb;
begin
  select * into task from market.collection_tasks where id=p_id for update;
  if task.status is distinct from 'running' or task.attempts<>p_attempt then raise exception 'Stale task attempt'; end if;
  if jsonb_typeof(p_bars) is distinct from 'array' then raise exception 'Invalid task payload'; end if;
  if task.dataset='prices' and exists(select 1 from jsonb_to_recordset(p_bars) b(date date)
    where b.date is null or extract(year from b.date)<>task.year or b.date>task.end_date or b.date<(task.security->>'start')::date) then raise exception 'Invalid year snapshot'; end if;
  update market.collection_tasks set status='completed',bars=p_bars,lease_until=null,error=null where id=p_id;
  perform pg_advisory_xact_lock(hashtextextended(task.run_id::text||task.symbol||task.dataset||task.adjust,0));
  if task.dataset='dividends' then
    perform public.market_publish_dividends(task.security,p_bars,task.run_id);
    update market.collection_tasks set bars=null where id=p_id;
  elsif not exists(select 1 from market.collection_tasks where run_id=task.run_id and symbol=task.symbol and dataset=task.dataset and adjust=task.adjust and status<>'completed') then
    select jsonb_agg(b.value order by b.value->>'date') into all_bars from market.collection_tasks t cross join lateral jsonb_array_elements(t.bars) b
      where t.run_id=task.run_id and t.symbol=task.symbol and t.dataset=task.dataset and t.adjust=task.adjust;
    perform public.market_publish_prices(task.security,task.adjust,all_bars,task.run_id);
    update market.collection_tasks set bars=null where run_id=task.run_id and symbol=task.symbol and dataset=task.dataset and adjust=task.adjust;
    if task.adjust='none' then update market.securities set enabled=true where symbol=task.symbol; end if;
  end if;
  update market.bulk_control set consecutive_failures=0 where id;
  perform public.market_close_finished_runs();
end $function$
;

CREATE OR REPLACE FUNCTION public.market_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('lastCompleteDate',(select max(trade_date) from market.price_daily where symbol='sh000001'),
    'popular',coalesce((select jsonb_agg(jsonb_build_object('symbol',symbol,'name',name,'kind',kind) order by symbol)
      from market.securities where enabled and nightly),'[]'::jsonb))
$function$
;

CREATE OR REPLACE FUNCTION public.market_history(p_symbol text, p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select public.market_prices(p_symbol,p_start,p_end,'none')
$function$
;

CREATE OR REPLACE FUNCTION public.market_prices(p_symbol text, p_start date, p_end date, p_adjust text DEFAULT 'none'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
  if p_symbol is null or p_symbol !~ '^(sh|sz|bj)[0-9]{6}$' or p_adjust is null or p_adjust<>'none'
    or p_start is null or p_end is null or p_start<date '2021-01-01' or p_end<p_start
    or p_end>(now() at time zone 'Asia/Shanghai')::date then raise exception '请输入有效的代码、日期和复权口径。' using errcode='22023'; end if;
  select jsonb_build_object('symbol',s.symbol,'source',m.source,'adjust',p_adjust,'cached',true,'fetchedAt',m.fetched_at,
    'firstDate',min(b.trade_date),'lastDate',max(b.trade_date),
    'bars',jsonb_agg(jsonb_build_object('date',b.trade_date,'close',b.close) order by b.trade_date))
    into result from market.securities s join market.price_series m on m.symbol=s.symbol and m.adjust=p_adjust
    join market.price_daily b on b.symbol=m.symbol
    where s.symbol=p_symbol and s.enabled and b.trade_date between p_start and p_end group by s.symbol,m.source,m.fetched_at;
  if result is null then raise exception '所选口径或区间暂无已采集行情。' using errcode='22023'; end if;
  return result;
end $function$
;

CREATE OR REPLACE FUNCTION public.market_publish(p_security jsonb, p_bars jsonb)
 RETURNS integer
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select public.market_publish_prices(p_security,'none',p_bars)
$function$
;

CREATE OR REPLACE FUNCTION public.market_publish_prices(p_security jsonb, p_adjust text, p_bars jsonb, p_run_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare sym text:=p_security->>'symbol'; n integer; default_mode boolean;
begin
  if sym is null or sym !~ '^(sh|sz|bj)[0-9]{6}$' or p_adjust is null or p_adjust<>'none'
    or (p_security->>'kind'='指数' and p_adjust<>'none') or jsonb_typeof(p_bars) is distinct from 'array'
    or jsonb_array_length(p_bars)=0 or jsonb_array_length(p_bars)>20000 then raise exception 'Invalid price snapshot'; end if;
  perform pg_advisory_xact_lock(hashtextextended(sym,0));
  if exists(select 1 from market.price_daily old where old.symbol=sym and not exists
    (select 1 from jsonb_to_recordset(p_bars) b(date date) where b.date=old.trade_date)) then
    raise exception 'Snapshot would discard previously published dates'; end if;
  if exists(select 1 from jsonb_to_recordset(p_bars) b(date date) where b.date is null
    or b.date<greatest((p_security->>'start')::date,date '2021-01-01') or b.date>(now() at time zone 'Asia/Shanghai')::date) then
    raise exception 'Snapshot contains out-of-range dates'; end if;
  default_mode:=p_adjust='none';
  insert into market.securities(symbol,name,kind,pinyin,start_date,adjust,refreshed_at)
    values(sym,p_security->>'name',p_security->>'kind',coalesce(p_security->>'pinyin',''),(p_security->>'start')::date,
      'none',case when default_mode then now() else null end)
    on conflict(symbol) do update set name=excluded.name,kind=excluded.kind,pinyin=excluded.pinyin,
      start_date=excluded.start_date,refreshed_at=case when default_mode then now() else market.securities.refreshed_at end;
  delete from market.price_daily where symbol=sym;
  insert into market.price_daily(symbol,trade_date,close)
    select sym,b.date,b.close from jsonb_to_recordset(p_bars) b(date date,close numeric);
  get diagnostics n=row_count;
  insert into market.price_series(symbol,adjust,first_date,last_date,row_count,fetched_at,last_run_id)
    select sym,p_adjust,min(trade_date),max(trade_date),count(*),now(),p_run_id from market.price_daily where symbol=sym
    on conflict(symbol,adjust) do update set first_date=excluded.first_date,last_date=excluded.last_date,
      row_count=excluded.row_count,fetched_at=excluded.fetched_at,last_run_id=excluded.last_run_id;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.market_publish_dividends(p_security jsonb, p_events jsonb, p_run_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare sym text:=p_security->>'symbol'; src text; n integer;
begin
  src:=case p_security->>'kind' when '股票' then 'eastmoney_stock' when 'ETF' then 'eastmoney_fund' else null end;
  if sym is null or src is null or jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>2000 then
    raise exception 'Invalid corporate-action snapshot'; end if;
  if exists(select 1 from jsonb_array_elements(p_events) e where e->>'source' is distinct from src) then
    raise exception 'Corporate-action source mismatch'; end if;
  select coalesce(jsonb_agg(e),'[]'::jsonb) into p_events from jsonb_array_elements(p_events) e
    where coalesce(e->>'exDate',e->>'recordDate',e->>'planDate',e->>'reportDate')>='2021-01-01';
  perform pg_advisory_xact_lock(hashtextextended(sym||':dividends',0));
  if exists(select 1 from market.dividend_events old where old.symbol=sym and old.plan_status='implemented'
    and not exists(select 1 from jsonb_array_elements(p_events) e
      where e->>'source'=old.source and e->>'sourceId'=old.source_id)) then
    raise exception 'Snapshot would discard implemented dividend records';
  end if;
  delete from market.dividend_events where symbol=sym;
  insert into market.dividend_events(symbol,source,source_id,report_date,plan_announcement_date,latest_announcement_date,
    record_date,ex_date,pay_date,plan_status,status_text,cash_per_10,bonus_shares_per_10,transfer_shares_per_10,
    currency,tax_basis,plan_text,source_url,fetched_at)
    select sym,src,e."sourceId",e."reportDate",e."planDate",e."noticeDate",e."recordDate",e."exDate",e."payDate",
      e.status,e."statusText",e."cashPer10",e."bonusSharesPer10",e."transferSharesPer10",e.currency,e."taxBasis",e."planText",e."sourceUrl",now()
    from jsonb_to_recordset(p_events) e("sourceId" text,"reportDate" date,"planDate" date,"noticeDate" date,"recordDate" date,
      "exDate" date,"payDate" date,status text,"statusText" text,"cashPer10" numeric,"bonusSharesPer10" numeric,
      "transferSharesPer10" numeric,currency text,"taxBasis" text,"planText" text,"sourceUrl" text);
  get diagnostics n=row_count;
  insert into market.dividend_series(symbol,source,row_count,fetched_at,last_run_id) values(sym,src,n,now(),p_run_id)
    on conflict(symbol) do update set source=excluded.source,row_count=n,fetched_at=now(),last_run_id=p_run_id;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION public.market_dividends(p_symbol text, p_start date DEFAULT '2021-01-01'::date, p_end date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare sec market.securities; meta market.dividend_series; events jsonb;
begin
  if p_symbol is null or p_start is null or p_end is null or p_start<date '2021-01-01' or p_end<p_start
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
end $function$
;

-- Recompute retained rows and resolve old failures attributable only to removed modes.
update market.bulk_members m set price_rows=coalesce((select row_count from market.price_series p where p.symbol=m.symbol and p.adjust='none'),0),
 dividend_rows=coalesce((select row_count from market.dividend_series d where d.symbol=m.symbol),0);
update market.bulk_members m set status='completed',error=null where status='partial' and error like '%Missing qfqday%'
 and exists(select 1 from market.price_series p where p.symbol=m.symbol and p.adjust='none')
 and exists(select 1 from market.dividend_series d where d.symbol=m.symbol);
update market.securities s set enabled=true where exists(select 1 from market.price_series p where p.symbol=s.symbol and p.adjust='none');
-- Historical request counters remain historical; queued totals follow the new plan.
update market.bulk_members m set requests_total=extract(year from c.cutoff)::integer-extract(year from s.start_date)::integer+2
 from market.bulk_control c,market.securities s where m.symbol=s.symbol and m.status='queued';
select public.market_close_finished_runs();
select public.market_bulk_refresh_progress();
notify pgrst,'reload schema';
