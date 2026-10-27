import test from 'node:test';
import assert from 'node:assert/strict';
import {createDataApi} from '../web/data.mjs';

test('history only transmits security and dates, never amount or schedule',async()=>{
  let request;
  const api=createDataApi({url:'https://test.supabase.co',key:'sb_publishable_test'},async(url,options)=>{
    request={url,...options};return {ok:true,json:async()=>({bars:[]})};
  });
  await api.history('sh600519',{start:'2020-01-01',end:'2024-01-01',amount:1000,frequency:'monthly'});
  assert.equal(request.url,'https://test.supabase.co/rest/v1/rpc/market_history');
  assert.deepEqual(JSON.parse(request.body),{p_symbol:'sh600519',p_start:'2020-01-01',p_end:'2024-01-01'});
  assert.equal(request.headers.apikey,'sb_publishable_test');
});
test('database errors are surfaced and missing config never calls fetch',async()=>{
  const api=createDataApi({url:'https://test.supabase.co',key:'sb_publishable_test'},async()=>({ok:false,json:async()=>({message:'暂无行情'})}));
  await assert.rejects(api.config(),/暂无行情/);
  let called=false;
  await assert.rejects(createDataApi({},async()=>{called=true;}).config(),/尚未配置/);
  assert.equal(called,false);
});
