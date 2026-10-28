export function parseCatalogue(payload,page){
  const {total,diff}=payload.data??{};
  if(payload.rc!==0||!Number.isSafeInteger(total)||total<4000||total>12000||!Array.isArray(diff)
    ||diff.length!==Math.min(100,total-(page-1)*100))throw new Error('Incomplete stock catalogue page');
  const symbols=new Set();
  const stocks=diff.map(row=>{
    const code=row.f12;
    if(typeof code!=='string'||!/^\d{6}$/.test(code))throw new Error('Invalid stock code');
    const exchange=/^6/.test(code)?'sh':/^[03]/.test(code)?'sz':/^(4|8|92)/.test(code)?'bj':null;
    if(!exchange||(exchange==='sh')!==(row.f13===1)||typeof row.f14!=='string'||!row.f14.trim())throw new Error('Invalid stock identity');
    const digits=String(row.f26),listed=digits.slice(0,4)+'-'+digits.slice(4,6)+'-'+digits.slice(6,8);
    if(!/^\d{8}$/.test(digits)||!Number.isFinite(Date.parse(listed))||new Date(listed).toISOString().slice(0,10)!==listed||listed<'1990-01-01')throw new Error('Missing or invalid listing date');
    const symbol=exchange+code;
    if(symbols.has(symbol))throw new Error('Duplicate catalogue symbol');
    symbols.add(symbol);
    return {symbol,name:row.f14,listed,start:listed<'2020-01-01'?'2020-01-01':listed,exchange};
  });
  return {total,stocks};
}

export async function fetchCatalogue(task,fetcher=globalThis.fetch){
  const query=new URLSearchParams({pn:String(task.page),pz:'100',po:'1',np:'1',fltt:'2',invt:'2',fid:'f12',
    fs:'m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',fields:'f12,f13,f14,f26'});
  const response=await fetcher(task.source+'?'+query,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(18000)});
  if(!response.ok)throw new Error(`Catalogue source HTTP ${response.status}`);
  return parseCatalogue(await response.json(),task.page);
}
