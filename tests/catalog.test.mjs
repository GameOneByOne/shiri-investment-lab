import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCatalogue,fetchCatalogue} from '../supabase/functions/collect-market/catalog.mjs';
import {createWorker} from '../supabase/functions/collect-market/worker.mjs';
const payload={rc:0,data:{total:4001,diff:[{f12:'920992',f13:0,f14:'中科美菱',f26:20221018}]}};
test('catalogue validates the exact final page and recognises Beijing codes',()=>{
  const result=parseCatalogue(payload,41);
  assert.equal(result.stocks[0].symbol,'bj920992');
  assert.equal(result.stocks[0].start,'2022-10-18');
  assert.throws(()=>parseCatalogue(payload,1),/Incomplete/);
  for(const patch of [{f13:1},{f12:'510300'},{f26:20220230},{f14:''}]){
    assert.throws(()=>parseCatalogue({...payload,data:{...payload.data,diff:[{...payload.data.diff[0],...patch}]}},41));
  }
});
test('catalogue surfaces restrictions without retrying or bypassing the provider',async()=>{
  let requests=0;
  await assert.rejects(fetchCatalogue({page:1,source:'https://source'},async()=>{requests++;return new Response('',{status:429});}),/HTTP 429/);
  assert.equal(requests,1);
});
test('worker records catalogue restrictions and leaves price checkpoints untouched',async()=>{
  const calls=[];
  const worker=createWorker({url:'https://db',key:'private',catalog:true},async(url,options)=>{
    if(url.startsWith('https://source'))return new Response('',{status:429});
    const name=url.split('/').at(-1);calls.push({name,body:JSON.parse(options.body)});
    if(name==='market_authorize_job')return Response.json(true);
    if(name==='market_bulk_catalog_claim')return Response.json({page:2,source:'https://source'});
    return new Response(null,{status:204});
  });
  const response=await worker(new Request('https://worker',{method:'POST',headers:{'x-job-token':'valid'}}));
  assert.equal(response.status,200);
  assert.deepEqual(calls.map(c=>c.name),['market_authorize_job','market_bulk_catalog_claim','market_bulk_catalog_fail']);
  assert.equal(calls.at(-1).body.p_restricted,true);
});
