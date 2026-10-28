create or replace function public.market_bulk_refresh_progress() returns void language plpgsql security invoker set search_path='' as $$
declare c market.bulk_control; data jsonb;
begin
  select * into c from market.bulk_control where id;
  if c.id is null then return; end if;
  select jsonb_build_object(
    'state',c.state,'startedAt',c.started_at,'cutoff',c.cutoff,'historyStart','2020-01-01',
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
end $$;
