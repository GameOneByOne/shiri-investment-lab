import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCatalogue,parseBseCatalogue,fetchCatalogue} from '../supabase/functions/collect-market/catalog.mjs';
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

const bsePage={totalElements:354,totalPages:18,size:20,number:1,numberOfElements:20,
  content:Array.from({length:20},(_,i)=>({xxzqdm:String(920100+i),xxzqjc:'fixture '+i,fxssrq:'20200102'}))};
test('official BSE adapter validates page completeness, new codes, dates and duplicates',()=>{
  const parse=d=>parseBseCatalogue('null('+JSON.stringify([d])+')',1);
  const result=parse(bsePage);assert.equal(result.total,354);assert.equal(result.stocks[0].symbol,'bj920100');
  assert.equal(result.stocks[0].start,'2021-01-01');
  for(const patch of [{number:0},{totalPages:17},{content:bsePage.content.slice(1)},
    {content:[bsePage.content[0],...bsePage.content.slice(0,19)]},
    {content:bsePage.content.map((r,i)=>i? r:{...r,fxssrq:'20200230'})}])assert.throws(()=>parse({...bsePage,...patch}));
  assert.throws(()=>parseBseCatalogue('<html>redirect</html>',1),/Unexpected/);
});
test('BSE self redirects stop immediately instead of looping or bypassing',async()=>{
  let calls=0;
  await assert.rejects(fetchCatalogue({source:'https://www.bse.cn/nqxxController/nqxxCnzq.do',page:1},async(url,options)=>{
    calls++;assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');
    return new Response('',{status:307});
  }),/HTTP 307/);
  assert.equal(calls,1);
});
