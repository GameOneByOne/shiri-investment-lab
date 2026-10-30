import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBars,createWorker} from '../supabase/functions/collect-market/worker.mjs';
const task={id:'task',attempts:1,symbol:'sh600519',year:2024,end_date:'2024-12-31',security:{kind:'股票',start:'2024-01-01'}};
const payload={code:0,data:{sh600519:{day:[['2024-01-02','10','11','12','9']]}}};

test('edge adapter rejects nonpositive, duplicate and unadjusted prices',()=>{
  assert.equal(parseBars(payload,task)[0].close,11);
  for(const values of [[['2024-01-02','10','-1','12','9']], [['2024-01-02','10','NaN','12','9']],
    [payload.data.sh600519.day[0],payload.data.sh600519.day[0]]]){
    assert.throws(()=>parseBars({data:{sh600519:{day:values}}},task));
  }
  assert.throws(()=>parseBars({data:{sh600519:{qfqday:[]}}},task),/day/);
});
test('worker authenticates before it can claim or download',async()=>{
  const calls=[];
  const worker=createWorker({url:'https://db',key:'private'},async(url)=>{
    calls.push(url);return Response.json(false);
  });
  assert.equal((await worker(new Request('https://worker',{method:'POST'}))).status,401);
  assert.equal(calls.length,0);
  assert.equal((await worker(new Request('https://worker',{method:'POST',headers:{'x-job-token':'bad'}}))).status,401);
  assert.deepEqual(calls,['https://db/rest/v1/rpc/market_authorize_job']);
});
test('worker stages a validated year',async()=>{
  let claimed=0;const calls=[];
  const worker=createWorker({url:'https://db',key:'private'},async(url,options)=>{
    const name=url.split('/').at(-1);
    if(url.startsWith('https://proxy.finance'))return Response.json(payload);
    calls.push({name,body:JSON.parse(options.body)});
    if(name==='market_authorize_job')return Response.json(true);
    if(name==='market_claim_task')return Response.json(claimed++===0?task:null);
    return new Response(null,{status:204});
  });
  const result=await worker(new Request('https://worker',{method:'POST',headers:{'x-job-token':'valid'}}));
  assert.deepEqual(await result.json(),{completed:1,failed:0});
  assert.deepEqual(calls.find(c=>c.name==='market_complete_task').body,{p_id:'task',p_attempt:1,p_bars:[{date:'2024-01-02',close:11}]});
});
test('failed upstream is retried through the task queue without publishing',async()=>{
  let claimed=0;const names=[];
  const worker=createWorker({url:'https://db',key:'private'},async(url)=>{
    if(url.startsWith('https://proxy.finance'))return new Response('offline',{status:503});
    const name=url.split('/').at(-1);names.push(name);
    if(name==='market_authorize_job')return Response.json(true);
    if(name==='market_claim_task')return Response.json(claimed++===0?task:null);
    return new Response(null,{status:204});
  });
  const result=await worker(new Request('https://worker',{method:'POST',headers:{'x-job-token':'valid'}}));
  assert.deepEqual(await result.json(),{completed:0,failed:1});
  assert.ok(names.includes('market_fail_task'));
  assert.ok(!names.includes('market_complete_task'));
});

