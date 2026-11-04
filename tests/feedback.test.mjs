import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeedbackApi,feedbackPayload} from '../web/feedback-api.mjs';
const input={id:'12345678-1234-4567-8123-123456789abc',category:'功能建议',content:' 希望增加导出功能 ',contact:'',page_path:'/my.html',version:'V0.8.0'};
test('feedback transmits an explicit allowlist without investment data or page query strings',async()=>{
 let request;
 await createFeedbackApi({url:'https://test.supabase.co',key:'sb_publishable_test'},async(url,options)=>{request={url,...options};return {ok:true};})({...input,initial:200000,records:[{value:1000}],status:'已解决'});
 assert.deepEqual(JSON.parse(request.body),{...input,content:'希望增加导出功能',contact:null});
 assert.equal(request.headers.Prefer,'return=minimal');
 assert.equal(request.url,'https://test.supabase.co/rest/v1/feedback');
 assert.throws(()=>feedbackPayload({...input,page_path:'/my.html?initial=200000'}));
});
test('empty and oversized feedback is rejected before any network request',async()=>{
 let called=false;const submit=createFeedbackApi({url:'https://test.supabase.co',key:'sb_publishable_test'},async()=>{called=true;});
 for(const patch of [{content:'   '},{content:'字'.repeat(2001)},{contact:'x'.repeat(121)},{category:'unknown'}])await assert.rejects(submit({...input,...patch}));
 assert.equal(called,false);
});
test('uncertain responses can be retried using the same id without duplicate feedback',async()=>{
 let attempts=0;const submit=createFeedbackApi({url:'https://test.supabase.co',key:'sb_publishable_test'},async()=>{
  if(!attempts++)throw new Error('connection lost');
  return {ok:false,status:409,json:async()=>({code:'23505'})};
 });
 await assert.rejects(submit(input),/内容已保留/);
 await assert.doesNotReject(submit(input));
});
test('rate limits and permission errors remain failures, never false success',async()=>{
 const limited=createFeedbackApi({url:'https://test.supabase.co',key:'sb_publishable_test'},async()=>({ok:false,status:400,json:async()=>({code:'P0001'})}));
 await assert.rejects(limited(input),/稍后再试/);
 const denied=createFeedbackApi({url:'https://test.supabase.co',key:'sb_publishable_test'},async()=>({ok:false,status:403,json:async()=>({code:'42501'})}));
 await assert.rejects(denied(input),/提交未完成/);
});
