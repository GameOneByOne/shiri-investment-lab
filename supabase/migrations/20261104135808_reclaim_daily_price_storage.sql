set lock_timeout='10s';
lock table market.price_daily,market.price_yearly in share mode;
-- Compare every original date and price, grouped into exact arrays. No sampling.
do $$ begin
 if exists(
 select 1 from (
 select s.id,extract(year from p.trade_date)::smallint y,
 array_agg(extract(doy from p.trade_date)::smallint order by p.trade_date) ds,
 array_agg((p.close*(case when s.kind='ETF' then 1000 else 100 end))::integer order by p.trade_date) ps
 from market.price_daily p join market.securities s using(symbol) group by s.id,extract(year from p.trade_date),s.kind
 ) old full join market.price_yearly n on n.security_id=old.id and n.trade_year=old.y
 where old.id is null or n.security_id is null or old.ds is distinct from n.days or old.ps is distinct from n.close_units
 ) then raise exception 'Annual migration verification failed'; end if;
end $$;

-- All data has been verified in the annual store; retain a read-only compatibility view.
drop table market.price_daily;
create view market.price_daily with (security_invoker=true) as
 select s.symbol,make_date(a.trade_year,1,1)+u.d-1 as trade_date,u.c::numeric/a.price_scale as close
 from market.price_yearly a join market.securities s on s.id=a.security_id
 cross join lateral unnest(a.days,a.close_units) u(d,c);
grant select on market.price_daily to anon,authenticated,service_role;
update market.bulk_control set database_bytes=pg_database_size(current_database()),updated_at=now() where id;
select public.market_bulk_refresh_progress();
notify pgrst,'reload schema';
