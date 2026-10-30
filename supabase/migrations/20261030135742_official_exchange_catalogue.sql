-- Retain old checkpoints/data while reconciling the campaign against exchanges.
alter table market.bulk_members add column in_universe boolean not null default true;
alter table market.bulk_members add column catalogue_verified boolean not null default false;
alter table market.bulk_control add column catalog_manifest jsonb not null default '{}'::jsonb;

create function public.market_bulk_add_official(p_stocks jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare c market.bulk_control; base integer; n integer;
begin
 select * into c from market.bulk_control where id for update;
 if jsonb_typeof(p_stocks) is distinct from 'array' or jsonb_array_length(p_stocks)>12000 then raise exception 'Invalid catalogue'; end if;
 if exists(select 1 from jsonb_to_recordset(p_stocks) s(symbol text,name text,listed date,start date,exchange text)
  where s.symbol is null or s.symbol !~ '^(sh6|sz[03]|bj[489])[0-9]{5}$' or nullif(trim(s.name),'') is null
  or s.listed is null or s.listed<date '1990-01-01' or s.listed>c.cutoff
  or s.start is distinct from greatest(date '2021-01-01',s.listed) or s.exchange is distinct from left(s.symbol,2))
 then raise exception 'Invalid official listing identity'; end if;
 if (select count(distinct s->>'symbol') from jsonb_array_elements(p_stocks) s)<>jsonb_array_length(p_stocks) then raise exception 'Duplicate listing'; end if;
 select coalesce(max(ordinal),0) into base from market.bulk_members;
 insert into market.securities(symbol,name,kind,start_date,adjust,enabled,nightly)
  select symbol,name,'股票',start,'none',false,false from jsonb_to_recordset(p_stocks) s(symbol text,name text,start date)
  on conflict(symbol) do update set name=excluded.name,start_date=excluded.start_date;
 insert into market.bulk_members(symbol,ordinal,listed_date,exchange,requests_total,status,price_rows,dividend_rows,in_universe,catalogue_verified)
  select s.symbol,base+row_number() over(order by s.symbol),s.listed,s.exchange,
   case when p.last_date>=c.cutoff and d.symbol is not null then 0 else extract(year from c.cutoff)::integer-extract(year from s.start)::integer+2 end,
   case when p.last_date>=c.cutoff and d.symbol is not null then 'completed' else 'queued' end,
   coalesce(p.row_count,0),coalesce(d.row_count,0),true,true
  from jsonb_to_recordset(p_stocks) s(symbol text,listed date,start date,exchange text)
  left join market.price_series p on p.symbol=s.symbol and p.adjust='none'
  left join market.dividend_series d on d.symbol=s.symbol
  on conflict(symbol) do update set listed_date=excluded.listed_date,exchange=excluded.exchange,in_universe=true,catalogue_verified=true;
 get diagnostics n=row_count;return n;
end $$;

create function public.market_bulk_import_official(p_stocks jsonb,p_manifest jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare c market.bulk_control; sh integer; sz integer; bj integer; expected integer;
begin
 select * into c from market.bulk_control where id for update;
 if c.id is null or c.catalog_manifest->>'source'='official_exchanges' then raise exception 'Missing campaign or snapshot already installed'; end if;
 if p_manifest->>'source' is distinct from 'official_exchanges' or (p_manifest->>'cutoff')::date is distinct from c.cutoff
  or (p_manifest->'bse'->>'nextPage')::integer<>1 or (p_manifest->'bse'->>'complete')::boolean then raise exception 'Invalid official snapshot manifest'; end if;
 select count(*) filter(where s->>'exchange'='sh'),count(*) filter(where s->>'exchange'='sz'),count(*) filter(where s->>'exchange'='bj')
  into sh,sz,bj from jsonb_array_elements(p_stocks) s;
 expected:=sh+sz+(p_manifest->'bse'->>'reportedTotal')::integer;
 if sh not between 1800 and 4000 or sz not between 2000 and 4000 or bj<>20 or expected not between 4500 and 12000
  or (p_manifest->>'total')::integer<>jsonb_array_length(p_stocks)
  or (p_manifest->'counts'->>'sh')::integer<>sh or (p_manifest->'counts'->>'sz')::integer<>sz
  or (p_manifest->>'expectedTotal')::integer<>expected then raise exception 'Incomplete exchange snapshot'; end if;
 perform public.market_bulk_add_official(p_stocks);
 update market.bulk_members set in_universe=false where exchange in ('sh','sz') and not catalogue_verified;
 update market.bulk_control set source='https://www.bse.cn/nqxxController/nqxxCnzq.do',catalog_page=1,catalog_total=expected,
  catalog_complete=false,catalog_manifest=p_manifest,catalog_lease=null,catalog_next_at=now()+interval '1 minute',catalog_failures=0,last_error=null,
  state=case when state in ('paused_manual','paused_capacity') then state when blocked_until>now() then 'paused_provider' else 'cataloguing' end where id;
 perform public.market_bulk_refresh_progress();
end $$;

-- The original importer remains for older campaigns. This campaign now continues BSE pages only.
alter function public.market_bulk_catalog_complete(integer,integer,jsonb) rename to market_bulk_catalog_complete_legacy;
create function public.market_bulk_catalog_complete(p_page integer,p_total integer,p_stocks jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare c market.bulk_control; expected integer; eligible jsonb; excluded integer; complete boolean; actual integer;
begin
 select * into c from market.bulk_control where id for update;
 if c.source<>'https://www.bse.cn/nqxxController/nqxxCnzq.do' then
  perform public.market_bulk_catalog_complete_legacy(p_page,p_total,p_stocks);return;end if;
 if c.catalog_page<>p_page or c.catalog_lease is null or c.catalog_complete then raise exception 'Stale BSE page'; end if;
 expected:=least(20,p_total-p_page*20);
 if p_total is distinct from (c.catalog_manifest->'bse'->>'reportedTotal')::integer or expected<1
  or jsonb_typeof(p_stocks) is distinct from 'array' or jsonb_array_length(p_stocks)<>expected
  or exists(select 1 from jsonb_array_elements(p_stocks) s where s->>'exchange' is distinct from 'bj' or s->>'listed' is null)
  or exists(select 1 from jsonb_array_elements(p_stocks) s join market.bulk_members m on m.symbol=s->>'symbol' where m.catalogue_verified)
 then raise exception 'Incomplete or duplicate BSE page';end if;
 select coalesce(jsonb_agg(s) filter(where (s->>'listed')::date<=c.cutoff),'[]'),count(*) filter(where (s->>'listed')::date>c.cutoff)
  into eligible,excluded from jsonb_array_elements(p_stocks) s;
 perform public.market_bulk_add_official(eligible);
 complete:=(p_page+1)*20>=p_total;
 if complete then
  update market.bulk_members set in_universe=false where exchange='bj' and not catalogue_verified;
  select count(*) into actual from market.bulk_members where exchange='bj' and in_universe;
  if actual<>p_total-coalesce((c.catalog_manifest->'bse'->>'excludedAfterCutoff')::integer,0)-excluded then raise exception 'BSE universe incomplete';end if;
 end if;
 update market.bulk_control set catalog_page=p_page+1,catalog_complete=complete,catalog_total=catalog_total-excluded,
  catalog_manifest=jsonb_set(jsonb_set(jsonb_set(catalog_manifest,'{bse,nextPage}',to_jsonb(p_page+1)),
   '{bse,complete}',to_jsonb(complete)),'{bse,excludedAfterCutoff}',to_jsonb(coalesce((catalog_manifest->'bse'->>'excludedAfterCutoff')::integer,0)+excluded)),
  catalog_lease=null,catalog_next_at=now()+interval '60 seconds',catalog_failures=0,last_error=null where id;
 perform public.market_bulk_refresh_progress();
end $$;
revoke all on function public.market_bulk_add_official(jsonb),public.market_bulk_import_official(jsonb,jsonb),public.market_bulk_catalog_complete(integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.market_bulk_add_official(jsonb),public.market_bulk_import_official(jsonb,jsonb),public.market_bulk_catalog_complete(integer,integer,jsonb) to service_role;
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
    'catalogue',jsonb_build_object('source',c.source,'sourceLabel',case when c.catalog_manifest->>'source'='official_exchanges' then '沪深交易所名单已核实；北交所名单逐页补齐' else '东方财富名单' end,'nextPage',c.catalog_page,'expectedStocks',c.catalog_total,
      'discoveredStocks',count(*) filter(where catalogue_verified),'complete',c.catalog_complete,'nextAttemptAt',c.catalog_next_at),
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
      where in_universe and status in ('partial','failed') order by finished_at desc limit 10) x),'[]'::jsonb),
    'ratePolicy',jsonb_build_object('concurrency',1,'minimumIntervalSeconds',6,'maximumAttempts',3,'restrictionCooldownHours',24)
  ) into data from market.bulk_members where in_universe;
  insert into market.bulk_progress(id,snapshot) values(true,data)
    on conflict(id) do update set snapshot=excluded.snapshot,updated_at=now();
end $function$

;
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
        select * into m from market.bulk_members where in_universe and status='queued' order by ordinal for update skip locked limit 1;
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
      if c.catalog_complete and not exists(select 1 from market.bulk_members where in_universe and status in ('queued','collecting')) then
        update market.bulk_control set state=case when exists(select 1 from market.bulk_members where in_universe and status in ('partial','failed')) then 'completed_with_errors' else 'completed' end where id;
      end if;
    end if;
  end if;
  perform public.market_bulk_refresh_progress();
end $function$

;
