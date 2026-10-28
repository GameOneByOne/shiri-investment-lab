create or replace function public.market_bulk_pump() returns void language plpgsql security invoker set search_path='' as $$
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
            cross join unnest(array['none','qfq','hfq']) a;
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
end $$;

create or replace function public.market_bulk_catalog_claim() returns jsonb language plpgsql security invoker set search_path='' as $$
declare c market.bulk_control;
begin
  select * into c from market.bulk_control where id for update;
  if c.id is null or c.catalog_complete or c.state in ('paused_manual','paused_capacity') or c.blocked_until>now()
    or c.catalog_next_at>now() or c.catalog_lease>now() or exists(select 1 from market.collection_tasks where status='running' and lease_until>now()) then return null; end if;
  update market.bulk_control set catalog_lease=now()+interval '2 minutes' where id;
  return jsonb_build_object('page',c.catalog_page,'source',c.source);
end $$;

create or replace function public.market_claim_task() returns jsonb language plpgsql security invoker set search_path='' as $$
declare task market.collection_tasks; c market.bulk_control; isbulk boolean;
begin
  perform pg_advisory_xact_lock(8627340103);
  update market.collection_tasks set status='failed',error='Worker lease expired after 3 attempts'
    where status='running' and lease_until<now() and attempts>=3;
  perform public.market_close_finished_runs();
  select * into c from market.bulk_control where id for update;
  if c.catalog_lease>now() or c.blocked_until>now() or c.next_request_at>now() or exists(select 1 from market.collection_tasks where status='running' and lease_until>now()) then return null; end if;
  select t.* into task from market.collection_tasks t left join market.bulk_members m on m.run_id=t.run_id
    where t.attempts<3 and t.available_at<=now() and (t.status='pending' or (t.status='running' and t.lease_until<now()))
      and (m.symbol is null or c.state in ('running','cataloguing'))
    order by (m.symbol is not null),t.attempts,t.run_id,t.dataset desc,t.adjust,t.year for update of t skip locked limit 1;
  if task.id is null then return null; end if;
  isbulk:=exists(select 1 from market.bulk_members where run_id=task.run_id);
  -- Keep the oldest lease stale-safe; never publish a late worker attempt.
  update market.collection_tasks set status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes' where id=task.id returning * into task;
  update market.bulk_control set next_request_at=now()+interval '6 seconds'+random()*interval '2 seconds' where id;
  return (to_jsonb(task)-'bars'-'error')||jsonb_build_object('bulk',isbulk);
end $$;
