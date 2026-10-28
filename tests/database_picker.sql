begin;
set local role anon;
do $$
declare firstpage jsonb; nextpage jsonb; stock jsonb;
begin
  firstpage:=public.market_available();
  assert (firstpage->>'total')::integer>8,'Newly published stocks are missing from the picker';
  assert jsonb_array_length(firstpage->'results')=50;
  nextpage:=public.market_available('',firstpage->>'nextCursor');
  assert not exists(select 1 from jsonb_array_elements(firstpage->'results') a join jsonb_array_elements(nextpage->'results') b on a->>'symbol'=b->>'symbol'),'Duplicate cursor page';
  stock:=public.market_available('920992');
  assert stock->'results'->0->>'symbol'='bj920992';
  assert stock->'results'->0->>'firstDate' is not null;
  assert not exists(select 1 from jsonb_array_elements(firstpage->'results') e join market.securities s on s.symbol=e->>'symbol' where not s.enabled);
end $$;
rollback;
