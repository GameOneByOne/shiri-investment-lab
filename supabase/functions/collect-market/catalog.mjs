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
    return {symbol,name:row.f14,listed,start:listed<'2021-01-01'?'2021-01-01':listed,exchange};
  });
  return {total,stocks};
}

export function parseBseCatalogue(text,page){
  const match=text.match(/^\s*(?:null|[A-Za-z_$][\w$]*)\((\[.*\])\);?\s*$/s);
  if(!match)throw new Error('Unexpected BSE catalogue response');
  const data=JSON.parse(match[1])[0];
  const {totalElements:total,size,totalPages,content:rows}=data??{};
  if(![total,size,totalPages].every(Number.isSafeInteger)||total<100||total>2000||size!==20
    ||totalPages!==Math.ceil(total/size)||data.number!==page||!Array.isArray(rows)
    ||rows.length!==Math.min(size,total-page*size)||rows.length!==data.numberOfElements)throw new Error('Incomplete BSE catalogue page');
  const seen=new Set();
  const stocks=rows.map(row=>{
    const code=row.xxzqdm,digits=String(row.fxssrq),listed=digits.slice(0,4)+'-'+digits.slice(4,6)+'-'+digits.slice(6,8);
    if(typeof code!=='string'||!/^(?:[48]\d{5}|92\d{4})$/.test(code)||typeof row.xxzqjc!=='string'||!row.xxzqjc.trim()
      ||!/^\d{8}$/.test(digits)||!Number.isFinite(Date.parse(listed))||new Date(listed).toISOString().slice(0,10)!==listed||listed<'1990-01-01'
      ||seen.has(code))throw new Error('Invalid BSE listing identity');
    seen.add(code);return {symbol:'bj'+code,name:row.xxzqjc.trim(),listed,start:listed<'2021-01-01'?'2021-01-01':listed,exchange:'bj'};
  });
  return {total,stocks};
}

export async function fetchCatalogue(task,fetcher=globalThis.fetch){
  if(task.source==='https://www.bse.cn/nqxxController/nqxxCnzq.do'){
    const body=new URLSearchParams({page:String(task.page),typejb:'T','xxfcbj[]':'2',xxzqdm:'',sortfield:'xxzqdm',sorttype:'asc'});
    const response=await fetcher(task.source,{method:'POST',body,headers:{'User-Agent':'Mozilla/5.0'},redirect:'manual',signal:AbortSignal.timeout(18000)});
    if(!response.ok)throw new Error(`BSE catalogue source HTTP ${response.status}`);
    return parseBseCatalogue(await response.text(),task.page);
  }
  const query=new URLSearchParams({pn:String(task.page),pz:'100',po:'1',np:'1',fltt:'2',invt:'2',fid:'f12',
    fs:'m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',fields:'f12,f13,f14,f26'});
  const response=await fetcher(task.source+'?'+query,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(18000)});
  if(!response.ok)throw new Error(`Catalogue source HTTP ${response.status}`);
  return parseCatalogue(await response.json(),task.page);
}
