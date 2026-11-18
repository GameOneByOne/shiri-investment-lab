create function public.market_stock_options(p_market text) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare ns text; result jsonb;
begin
 if p_market='cn' then return public.market_ready();end if;
 ns:=case p_market when 'hk' then 'market_hk' when 'us' then 'market_us' else null end;
 if ns is null then raise exception 'Invalid market' using errcode='22023';end if;
 execute format('select jsonb_build_object(''total'',count(*),''results'',coalesce(jsonb_agg(jsonb_build_object(''symbol'',s.symbol,''name'',s.name,''kind'',s.kind,''currency'',s.currency,''firstDate'',p.first_date,''lastDate'',p.last_date) order by s.name,s.symbol),''[]'')) from %1$I.securities s join %1$I.price_series p using(symbol) where s.enabled and s.in_catalogue and s.ready and p.adjust=''none'' and p.row_count>0',ns) into result;
 return result;
end $$;
revoke all on function public.market_stock_options(text) from public;
grant execute on function public.market_stock_options(text) to anon,authenticated,service_role;
notify pgrst,'reload schema';
