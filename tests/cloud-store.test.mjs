import test from 'node:test';
import assert from 'node:assert/strict';
import {PortfolioStore,GUEST_KEY} from '../web/cloud-store.mjs';
const plan={start:'2026-01-01',years:1,initial:0,amount:100,frequency:'monthly',rate:6,rateUnit:'yearly'};
const data=(records=[])=>({plan:{...plan},records});
const record=(date,value)=>({date,mode:'assets',value});
Object.defineProperty(globalThis,'navigator',{value:{onLine:true},configurable:true});
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
function setup(initial=null){
 storage.clear();navigator.onLine=true;
 const server={data:initial,revision:initial?1:0,writes:0,fail:false};
 const client={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:server.data?{data:structuredClone(server.data),revision:server.revision}:null,error:server.fail?Error('network'):null})})})}),rpc:async(_name,{expected_revision,payload})=>{
   if(server.fail)return {error:Error('network')};
   if(expected_revision!==server.revision)return {data:[]};
   server.data=structuredClone(payload);server.revision++;server.writes++;return {data:[{revision:server.revision}]};
 }};
 const make=()=>{const store=new PortfolioStore();store.client=client;store.user={id:'user-a'};return store;};
 return {server,make};
}
test('an empty device downloads cloud data without uploading defaults',async()=>{
 const {server,make}=setup(data([record('2026-01-02',20)])),store=make();
 let busyAtLastChange;
 store.addEventListener('change',()=>{busyAtLastChange=store.busy;});
 await store.sync();assert.deepEqual(store.read(),server.data);assert.equal(server.writes,0);assert.equal(store.state,'synced');
 assert.equal(busyAtLastChange,false,'manual sync must be available after a completed request');
});
test('another tab storage event merges pending edits rather than replacing this tab',async()=>{
 const {server,make}=setup(data()),store=make();await store.sync();
 store.envelope.data.records=[record('2026-01-02',20)];store.envelope.dirty=true;
 const other={data:data([record('2026-02-02',30)]),base:data(),revision:1,dirty:true};
 await store.receive(other);
 assert.deepEqual(server.data.records,[record('2026-01-02',20),record('2026-02-02',30)]);
});
test('another tab acknowledgement does not start an endless read-and-ack loop',async()=>{
 const {make}=setup(data()),store=make();await store.sync();
 store.client.from=()=>{throw Error('unchanged acknowledgement must not query again');};
 await store.receive({...structuredClone(store.envelope),syncedAt:new Date().toISOString()});
 assert.equal(store.state,'synced');assert.equal(store.busy,false);
});
test('first guest import requires explicit choice and retains guest data',async()=>{
 const {server,make}=setup(),store=make(),guest=data();localStorage.setItem(GUEST_KEY,JSON.stringify(guest));
 store.choose=async()=> 'cancel';await store.sync();assert.equal(server.writes,0);assert.equal(store.state,'import');
 store.choose=async()=> 'local';await store.sync();assert.deepEqual(server.data,guest);assert.ok(localStorage.getItem(GUEST_KEY));
});
test('two devices merge different edits, and offline deletion cannot resurrect',async()=>{
 const baseline=data([record('2026-01-02',20)]),{server,make}=setup(baseline),a=make(),b=make();
 await a.sync();await b.sync();
 a.envelope.data=data([record('2026-01-02',20),record('2026-02-02',30)]);a.envelope.dirty=true;
 b.envelope.data=data([]);b.envelope.dirty=true;
 await a.sync();await b.sync();assert.deepEqual(server.data.records,[record('2026-02-02',30)]);
 await a.sync();assert.deepEqual(a.read(),server.data);
});
test('conflict cancellation preserves dirty local data and never overwrites server',async()=>{
 const {server,make}=setup(data()),a=make(),b=make();await a.sync();await b.sync();
 a.envelope.data.plan.amount=200;b.envelope.data.plan.amount=300;b.envelope.dirty=true;
 await a.sync();b.choose=async()=> 'cancel';await b.sync();
 assert.equal(server.data.plan.amount,200);assert.equal(b.read().plan.amount,300);assert.equal(b.state,'conflict');assert.ok(b.envelope.dirty);
 b.choose=async()=> 'cloud';await b.sync();assert.equal(b.read().plan.amount,200);assert.equal(b.state,'synced');
});
test('a lost write response is retried idempotently and network failures keep pending data',async()=>{
 const {server,make}=setup(data()),store=make();await store.sync();store.envelope.data.plan.amount=250;store.envelope.dirty=true;
 server.fail=true;await store.sync();assert.equal(store.state,'error');assert.ok(store.envelope.dirty);assert.equal(server.data.plan.amount,100);
 server.fail=false;const original=store.client.rpc;store.client.rpc=async(...args)=>{await original(...args);return {error:Error('response lost')};};
 await store.sync();assert.equal(store.state,'error');assert.equal(server.data.plan.amount,250);
 const writes=server.writes;store.client.rpc=original;await store.sync();assert.equal(store.state,'synced');assert.equal(server.writes,writes);
});
test('editing during a write retains new changes and incorporates remote additions',async()=>{
 const {server,make}=setup(data()),store=make();await store.sync();
 server.data.records.push(record('2026-01-02',20));server.revision++;
 store.envelope.data.plan.amount=200;store.envelope.dirty=true;
 const rpc=store.client.rpc;store.client.rpc=async(...args)=>{store.envelope.data.plan.rate=7;return rpc(...args);};
 await store.sync();clearTimeout(store.timer);assert.equal(store.read().plan.rate,7);assert.equal(store.read().records.length,1);assert.ok(store.envelope.dirty);
 store.client.rpc=rpc;await store.sync();assert.equal(server.data.plan.rate,7);
});
test('offline saves stay queued; guest and account workspaces stay isolated',async()=>{
 const {server,make}=setup(data()),store=make();await store.sync();navigator.onLine=false;
 store.save({...data(),plan:{...plan,amount:500}});clearTimeout(store.timer);await store.sync();assert.equal(store.state,'offline');assert.equal(server.data.plan.amount,100);
 localStorage.setItem(GUEST_KEY,JSON.stringify(data([record('2026-01-02',80)])));
 store.switchUser(null);assert.equal(store.read().records[0].value,80);assert.equal(store.state,'local');
 navigator.onLine=true;
});
test('account switch discards an in-flight old-account response',async()=>{
 const {make}=setup(data()),store=make();let respond;
 store.client.from=()=>({select:()=>({eq:()=>({maybeSingle:()=>new Promise(resolve=>{respond=resolve;})})})});
 const pending=store.sync();store.switchUser(null);respond({data:{data:data(),revision:1}});await pending;clearTimeout(store.timer);
 assert.equal(store.user,null);assert.equal(store.envelope,null);assert.equal(store.state,'local');
});
