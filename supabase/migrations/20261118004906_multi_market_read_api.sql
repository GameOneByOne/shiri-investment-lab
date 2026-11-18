-- Public read-only APIs for existing foreign-market schemas; no collector changes.
create function public.market_browse(p_market text,p_query text default '',p_after text default null) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare ns text; result jsonb;
begin
 if p_market='cn' then return public.market_available(p_query,p_after); end if;
 ns:=case p_market when 'hk' then 'market_hk' when 'us' then 'market_us' else null end;
 if ns is null then raise exception 'Invalid market' using errcode='22023';end if;
 execute format($q$
 with available as(select s.symbol,s.name,s.kind,s.currency,p.first_date as "firstDate",p.last_date as "lastDate"
 from %1$I.securities s join %1$I.price_series p using(symbol)
 where s.enabled and s.in_catalogue and s.ready and p.adjust='none' and p.row_count>0
 and position(lower(left(trim(coalesce($1,'')),40)) in lower(s.name||s.symbol))>0),
 page as(select * from available where $2 is null or symbol>$2 order by symbol limit 51),
 visible as(select * from page order by symbol limit 50)
 select jsonb_build_object('total',(select count(*) from available),'results',coalesce((select jsonb_agg(to_jsonb(v) order by symbol) from visible v),'[]'),
 'nextCursor',case when (select count(*) from page)>50 then (select max(symbol) from visible) else null end)
 $q$,ns) into result using p_query,p_after;
 return result;
end $$;

create function public.market_foreign_snapshot(p_market text,p_symbol text,p_start date,p_end date) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare ns text; sec jsonb; stock jsonb; events jsonb; unresolved integer; meta jsonb;
begin
 ns:=case p_market when 'hk' then 'market_hk' when 'us' then 'market_us' else null end;
 if ns is null or p_symbol is null or p_start is null or p_end is null or p_start<date '2023-01-01' or p_end<p_start
 or p_end>(now() at time zone 'Asia/Shanghai')::date then raise exception 'Invalid market or range' using errcode='22023';end if;
 execute format('select to_jsonb(s) from %I.securities s where symbol=$1 and enabled and in_catalogue and ready',ns) into sec using p_symbol;
 if sec is null then raise exception '该标的数据尚未采集完整，请选择其他股票。' using errcode='22023';end if;
 execute format($q$select count(*) from %I.dividend_events where symbol=$1 and ex_date between $2 and $3
 and (action_kind not in ('cash','split') or action_kind='cash' and (cash_per_unit is null or currency is distinct from $4)
 or action_kind='split' and (share_ratio is null or share_ratio<=0))$q$,ns) into unresolved using p_symbol,p_start,p_end,sec->>'currency';
 if unresolved>0 then raise exception '所选区间有尚未核实的分红或拆股，暂不能准确模拟收益。' using errcode='22023';end if;
 execute format('select to_jsonb(d) from %I.dividend_series d where symbol=$1',ns) into meta using p_symbol;
 if meta is null then raise exception '该标的分红数据尚未核实。' using errcode='22023';end if;
 execute format($q$select jsonb_build_object('symbol',$1,'source',p.source,'adjust','none','fetchedAt',p.fetched_at,
 'currency',$4,'firstDate',min(b.date),'lastDate',max(b.date),'bars',coalesce(jsonb_agg(jsonb_build_object('date',b.date,'close',b.close) order by b.date) filter(where b.date is not null),'[]'))
 from %1$I.price_series p left join lateral(select make_date(a.trade_year,1,1)+u.d-1 as date,u.c::numeric/a.price_scale as close
 from %1$I.price_yearly a cross join lateral unnest(a.days,a.close_units) u(d,c)
 where a.security_id=$5 and a.trade_year between extract(year from $2::date) and extract(year from $3::date)
 and make_date(a.trade_year,1,1)+u.d-1 between $2 and $3) b on true
 where p.symbol=$1 and p.adjust='none' group by p.source,p.fetched_at$q$,ns)
 into stock using p_symbol,p_start,p_end,sec->>'currency',(sec->>'id')::integer;
 if stock is null then raise exception '所选标的暂无已采集行情。' using errcode='22023';end if;
 execute format($q$select coalesce(jsonb_agg(jsonb_build_object('id',source_id,'source',source,'exDate',ex_date,'payDate',pay_date,
 'status','implemented','cashPer10',case when action_kind='cash' then cash_per_unit*10 else 0 end,
 'shareFactor',case when action_kind='split' then share_ratio else 1 end,'currency',currency,'taxBasis',tax_basis,'planText',plan_text) order by ex_date,source_id),'[]')
 from %I.dividend_events where symbol=$1 and ex_date between $2 and $3$q$,ns) into events using p_symbol,p_start,p_end;
 return jsonb_build_object('stock',stock,'dividends',jsonb_build_object('events',events),'coverage',
 jsonb_build_object('prices',jsonb_build_array(jsonb_build_object('adjust','none')),'dividends',jsonb_build_object('status','collected','count',meta->'row_count'),
 'note','分红及拆股来自行情日线标注，并非完整公告档案；不计税费和汇率变动。'));
end $$;
revoke all on function public.market_browse(text,text,text),public.market_foreign_snapshot(text,text,date,date) from public;
grant execute on function public.market_browse(text,text,text),public.market_foreign_snapshot(text,text,date,date) to anon,authenticated,service_role;
notify pgrst,'reload schema';
