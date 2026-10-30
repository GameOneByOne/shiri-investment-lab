import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBars,createWorker} from '../supabase/functions/collect-market/worker.mjs';
import {parseStockDividends,parseFundDividends,fetchDividends} from '../supabase/functions/collect-market/dividends.mjs';
const task={id:'task',attempts:1,symbol:'sh600519',year:2024,end_date:'2026-10-27',security:{kind:'股票',start:'2020-01-01'}};
const stock={SECURITY_CODE:'600519',REPORT_DATE:'2024-12-31 00:00:00',PLAN_NOTICE_DATE:'2025-04-03 00:00:00',
  NOTICE_DATE:'2025-06-20 00:00:00',EQUITY_RECORD_DATE:'2025-06-25 00:00:00',EX_DIVIDEND_DATE:'2025-06-26 00:00:00',
  PRETAX_BONUS_RMB:276.73,BONUS_RATIO:null,IT_RATIO:null,ASSIGN_PROGRESS:'实施分配',IMPL_PLAN_PROFILE:'10派276.73元(含税)'};
test('only raw close is retained; adjusted-only payloads are rejected',()=>{
  const row=['2024-01-02','invalid-open','11',null,null,'invalid-volume'];
  assert.deepEqual(parseBars({data:{sh600519:{day:[row]}}},{...task,adjust:'none'}),[{date:'2024-01-02',close:11}]);
  for(const adjust of ['qfq','hfq','bogus'])assert.throws(()=>parseBars({},{...task,adjust}),/Invalid adjustment/);
  assert.throws(()=>parseBars({data:{sh600519:{qfqday:[row]}}},task),/Missing day/);
  assert.deepEqual(parseBars({data:{sh600519:{day:[['2020-01-02',10,11]]}}},{...task,year:2020}),[]);
});

test('stock dividends keep per-ten tax basis, dates and missing payments intact',()=>{
  const event=parseStockDividends([stock],task)[0];
  assert.equal(event.cashPer10,276.73);assert.equal(event.taxBasis,'pretax');
  assert.equal(event.recordDate,'2025-06-25');assert.equal(event.exDate,'2025-06-26');assert.equal(event.payDate,null);
  assert.equal(event.bonusSharesPer10,null);assert.equal(event.status,'implemented');
  assert.equal(parseStockDividends([{...stock,ASSIGN_PROGRESS:'董事会预案',EX_DIVIDEND_DATE:null}],task)[0].status,'proposed');
  assert.equal(parseStockDividends([{...stock,EX_DIVIDEND_DATE:'2026-12-01'}],task)[0].status,'scheduled');
  assert.throws(()=>parseStockDividends([{...stock,SECURITY_CODE:'000001'}],task),/symbol mismatch/);
  assert.throws(()=>parseStockDividends([stock,stock],task),/Duplicate/);
  assert.throws(()=>parseStockDividends([{...stock,PRETAX_BONUS_RMB:'NaN'}],task),/amount/);
});
const fundHtml=`<table><tr><th>年份</th><th>权益登记日</th><th>除息日</th><th>每10份分红</th><th>分红发放日</th></tr>
  <tr><td>2026年</td><td>2026-01-16</td><td>2026-01-19</td><td>每10份派现金1.2300元</td><td>2026-01-27</td></tr></table>`;
test('ETF dividends parse explicit per-ten fund units and retain payment date',()=>{
  const fundTask={...task,symbol:'sh510300',security:{...task.security,kind:'ETF'}};
  const event=parseFundDividends(fundHtml,fundTask)[0];
  assert.equal(event.cashPer10,1.23);assert.equal(event.payDate,'2026-01-27');
  assert.equal(event.reportDate,null);assert.equal(event.taxBasis,'source_unspecified');
  assert.throws(()=>parseFundDividends('provider blocked',fundTask),/not found/);
  assert.throws(()=>parseFundDividends(fundHtml.replace('每10份派现金','每份派现金'),fundTask),/unit/);
});
test('dividend pagination rejects partial or unsuccessful datasets',async()=>{
  await assert.rejects(fetchDividends(task,async()=>Response.json({success:true,result:{pages:1,count:2,data:[stock]}})),/Incomplete/);
  await assert.rejects(fetchDividends(task,async()=>Response.json({success:false,result:null})),/verified/);
});
test('ETF source empty placeholders are retried and never published as confirmed zero',async()=>{
  const fundTask={...task,symbol:'sh510300',security:{...task.security,kind:'ETF'}};
  const empty=`<title>沪深300ETF(510300)</title><table><tr><th>每10份分红</th><th>分红发放日</th></tr><tr><td>暂无分红信息!</td></tr></table>`;
  let calls=0;
  const events=await fetchDividends(fundTask,async()=>new Response(calls++===0?empty:'<title>沪深300ETF(510300)</title>'+fundHtml));
  assert.equal(events.length,1);assert.equal(calls,2);
  await assert.rejects(fetchDividends(fundTask,async()=>new Response(empty)),/verification required/);
  await assert.rejects(fetchDividends(fundTask,async()=>new Response('<title>Unknown fund</title>'+fundHtml)),/identity mismatch/);
});
test('worker dispatches dividend tasks through their adapter rather than price parser',async()=>{
  let claimed=0;const calls=[];
  const worker=createWorker({url:'https://db',key:'private'},async(url,options)=>{
    if(url.startsWith('https://datacenter-web'))return Response.json({success:true,result:{pages:1,count:1,data:[stock]}});
    const name=url.split('/').at(-1);calls.push({name,body:JSON.parse(options.body)});
    if(name==='market_authorize_job')return Response.json(true);
    if(name==='market_claim_task')return Response.json(claimed++===0?{...task,dataset:'dividends',adjust:'none'}:null);
    return new Response(null,{status:204});
  });
  const response=await worker(new Request('https://worker',{method:'POST',headers:{'x-job-token':'test'}}));
  assert.deepEqual(await response.json(),{completed:1,failed:0});
  assert.equal(calls.find(c=>c.name==='market_complete_task').body.p_bars[0].cashPer10,276.73);
});
