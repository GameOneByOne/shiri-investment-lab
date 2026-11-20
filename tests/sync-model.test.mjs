import test from 'node:test';
import assert from 'node:assert/strict';
import {mergePortfolio,choosePortfolio,equal} from '../web/sync-model.mjs';
const plan={start:'2026-01-01',years:1,amount:100,initial:0,frequency:'monthly',rate:6,rateUnit:'yearly'};
const record=(date,value)=>({date,mode:'assets',value});
test('Postgres jsonb object key order never creates a false conflict',()=>{
 const a={plan,records:[record('2026-01-02',20)]};
 const b={records:[{value:20,mode:'assets',date:'2026-01-02'}],plan:Object.fromEntries(Object.entries(plan).reverse())};
 assert.ok(equal(a,b));assert.deepEqual(mergePortfolio(null,a,b).conflicts,[]);
});
test('independent records merge and offline deletion stays deleted',()=>{
 const base={plan,records:[record('2026-01-02',20),record('2026-02-02',30)]};
 const local={plan,records:[record('2026-02-02',30)]};
 const remote={plan,records:[...base.records,record('2026-03-02',50)]};
 const merged=mergePortfolio(base,local,remote);
 assert.deepEqual(merged.conflicts,[]);
 assert.deepEqual(merged.data.records,[record('2026-02-02',30),record('2026-03-02',50)]);
});
test('same-record conflicts include delete versus edit and respect explicit choice',()=>{
 const base={plan,records:[record('2026-01-02',20)]};
 const local={plan:{...plan,amount:200},records:[]};
 const remote={plan:{...plan,amount:300},records:[record('2026-01-02',40),record('2026-02-02',50)]};
 assert.deepEqual(mergePortfolio(base,local,remote).conflicts,['plan','2026-01-02']);
 assert.deepEqual(choosePortfolio(base,local,remote,'cloud'),remote);
 assert.deepEqual(choosePortfolio(base,local,remote,'local'),{...local,records:[record('2026-02-02',50)]});
});
test('identical changes and uncertain response retries are idempotent',()=>{
 const local={plan,records:[record('2026-01-02',20)]};
 assert.deepEqual(mergePortfolio(null,local,local),{data:local,conflicts:[]});
 assert.deepEqual(mergePortfolio(local,local,local),{data:local,conflicts:[]});
});
