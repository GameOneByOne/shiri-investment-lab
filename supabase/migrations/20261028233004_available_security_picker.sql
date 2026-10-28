-- Public picker covers all published, enabled securities, independent of the
-- separately maintained eight-symbol nightly/popular pool.
create function public.market_available(p_query text default '',p_after text default null) returns jsonb
language sql stable security invoker set search_path='' as $$
  with available as (
    select s.symbol,s.name,s.kind,p.first_date as "firstDate",p.last_date as "lastDate"
    from market.securities s join market.price_series p on p.symbol=s.symbol and p.adjust=s.adjust
    where s.enabled and p.row_count>0 and position(lower(left(trim(coalesce(p_query,'')),40)) in lower(s.name||s.symbol||s.pinyin))>0
  ), page as (
    select * from available where p_after is null or symbol>p_after order by symbol limit 51
  ), visible as (select * from page order by symbol limit 50)
  select jsonb_build_object('results',coalesce((select jsonb_agg(to_jsonb(v) order by symbol) from visible v),'[]'::jsonb),
    'total',(select count(*) from available),
    'nextCursor',case when (select count(*) from page)>50 then (select max(symbol) from visible) else null end)
$$;
revoke all on function public.market_available(text,text) from public;
grant execute on function public.market_available(text,text) to anon,authenticated,service_role;
