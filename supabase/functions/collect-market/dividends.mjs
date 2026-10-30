// Public provider data, kept separate from adjusted prices and user inputs.
const stockEndpoint='https://datacenter-web.eastmoney.com/api/data/v1/get';
const missing=value=>value===null||value===undefined||value===''||value==='--';
function number(value){
  if(missing(value))return null;
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>1e10)throw new Error('Invalid corporate-action amount');
  return n;
}
function date(value){
  if(missing(value))return null;
  const s=String(value).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s||s<'1990-01-01')throw new Error('Invalid corporate-action date');
  return s;
}
export function parseStockDividends(rows,task){
  if(!Array.isArray(rows))throw new Error('Missing dividend records');
  const seen=new Set();
  return rows.map(row=>{
    if(row.SECURITY_CODE!==task.symbol.slice(2))throw new Error('Dividend symbol mismatch');
    const reportDate=date(row.REPORT_DATE),planDate=date(row.PLAN_NOTICE_DATE),noticeDate=date(row.NOTICE_DATE);
    if(!reportDate||!planDate)throw new Error('Missing dividend identity');
    const id=reportDate+':'+planDate;
    if(seen.has(id))throw new Error('Duplicate dividend identity');
    seen.add(id);
    const exDate=date(row.EX_DIVIDEND_DATE),recordDate=date(row.EQUITY_RECORD_DATE);
    const statusText=String(row.ASSIGN_PROGRESS??'');
    const planText=String(row.IMPL_PLAN_PROFILE??'');
    let status='unknown';
    if(/取消|终止/.test(statusText))status='cancelled';
    else if(/不分配|不派/.test(planText))status='no_distribution';
    else if(statusText==='实施分配')status=exDate?(exDate<=task.end_date?'implemented':'scheduled'):'proposed';
    else if(/预|通过|董事|股东/.test(statusText))status='proposed';
    return {sourceId:id,reportDate,planDate,noticeDate,recordDate,exDate,payDate:null,status,statusText,
      cashPer10:number(row.PRETAX_BONUS_RMB),bonusSharesPer10:number(row.BONUS_RATIO),
      transferSharesPer10:number(row.IT_RATIO),currency:'CNY',taxBasis:'pretax',planText,
      source:'eastmoney_stock',sourceUrl:`https://data.eastmoney.com/yjfp/detail/${task.symbol.slice(2)}.html`,raw:undefined};
  }).filter(row=>row.planDate<=task.end_date&&(row.exDate||row.recordDate||row.planDate)>='2021-01-01');
}
const plain=text=>text.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').trim();
export function parseFundDividends(html,task){
  const table=[...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map(m=>m[0])
    .find(t=>t.includes('每10份分红')&&t.includes('分红发放日'));
  if(!table)throw new Error('Fund dividend table not found; refusing an empty replacement');
  const rows=[...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const result=[],seen=new Set();
  for(const row of rows){
    const cells=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>plain(m[1]));
    if(!cells.length)continue;
    if(cells.length===1&&/暂无|没有分红/.test(cells[0]))continue;
    if(cells.length!==5)throw new Error('Fund dividend columns changed');
    const recordDate=date(cells[1]),exDate=date(cells[2]),payDate=date(cells[4]);
    const amount=cells[3].match(/^每10份派现金\s*([\d.]+)\s*元$/);
    if(!exDate||!recordDate||!amount)throw new Error('Unrecognized fund dividend unit or date');
    const id=exDate+':'+recordDate;
    if(seen.has(id))throw new Error('Duplicate fund dividend identity');
    seen.add(id);
    result.push({sourceId:id,reportDate:null,planDate:null,noticeDate:null,recordDate,exDate,payDate,
      status:exDate<=task.end_date?'implemented':'scheduled',statusText:'基金分红记录',
      cashPer10:number(amount[1]),bonusSharesPer10:null,transferSharesPer10:null,currency:'CNY',
      taxBasis:'source_unspecified',planText:cells[3],source:'eastmoney_fund',
      sourceUrl:`https://fundf10.eastmoney.com/fhsp_${task.symbol.slice(2)}.html`,raw:undefined});
  }
  if(!result.length&&!/暂无|没有分红/.test(table))throw new Error('Empty fund table without an explicit no-data marker');
  return result.filter(row=>row.exDate>='2021-01-01'&&row.exDate<=task.end_date);
}
export async function fetchDividends(task,fetcher=globalThis.fetch){
  const code=task.symbol.slice(2);
  const get=async url=>{
    const response=await fetcher(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36','Cache-Control':'no-cache'},signal:AbortSignal.timeout(18000)});
    if(!response.ok)throw new Error(`Dividend source HTTP ${response.status}`);
    return response;
  };
  if(task.security.kind==='ETF'){
    for(let attempt=0;attempt<2;attempt++){
      const html=await (await get(`https://fundf10.eastmoney.com/fhsp_${code}.html`)).text();
      const title=html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]||'';
      if(!title.includes(code))throw new Error('Fund dividend page identity mismatch');
      const events=parseFundDividends(html,task);
      if(events.length)return events;
    }
    // The source sometimes returns a valid-looking empty page for a fund that
    // has a dividend history. Do not turn that response into a confirmed zero.
    throw new Error('Fund source reports no records; verification required before publishing an empty snapshot');
  }
  if(task.security.kind!=='股票')throw new Error('Dividend adapter not applicable');
  const rows=[];let pages=1,expected=null;
  for(let page=1;page<=pages;page++){
    const query=new URLSearchParams({reportName:'RPT_SHAREBONUS_DET',columns:'ALL',filter:`(SECURITY_CODE="${code}")`,
      pageSize:'500',pageNumber:String(page),sortColumns:'REPORT_DATE',sortTypes:'-1',source:'WEB',client:'WEB'});
    const data=await (await get(stockEndpoint+'?'+query)).json();
    if(data.success!==true||!data.result||!Array.isArray(data.result.data))throw new Error('Dividend source returned no verified dataset');
    const count=Number(data.result.count),totalPages=Number(data.result.pages);
    if(!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(totalPages)||totalPages<1||totalPages>5)throw new Error('Invalid dividend pagination');
    if(expected!==null&&expected!==count)throw new Error('Dividend dataset changed during pagination');
    expected=count;pages=totalPages;rows.push(...data.result.data);
  }
  if(rows.length!==expected)throw new Error('Incomplete dividend pagination');
  return parseStockDividends(rows,task);
}
