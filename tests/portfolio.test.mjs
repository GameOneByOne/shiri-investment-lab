import test from 'node:test';
import assert from 'node:assert/strict';
import {combinePlans} from '../web/portfolio.mjs';
const plan=(id,market,start,end,rows)=>({id,name:id,options:{market,start,end},result:{series:rows}});
const row=(date,contributed,profit,purchases=0)=>({date,contributed,profit,assets:contributed+profit,purchases});
test('independent calendars start at zero and final valuations carry forward',()=>{
 const a=plan('a','cn','2023-01-01','2023-01-03',[row('2023-01-02',100,10,1)]);
 const b=plan('b','cn','2023-01-03','2023-01-05',[row('2023-01-03',200,20,1),row('2023-01-05',200,30)]);
 const [r]=combinePlans([a,b]);
 assert.equal(r.series[0].assets,0);assert.equal(r.series[1].assets,110);
 assert.equal(r.last.profit,40);assert.equal(r.last.contributed,300);assert.equal(r.last.rate,40/300);assert.equal(r.count,2);
 assert.equal(r.last.values.a.profit,10);
 assert.equal(combinePlans([b])[0].last.profit,30);
 assert.deepEqual(combinePlans([]),[]);
});
test('different currencies never enter one total',()=>{
 const plans=['cn','hk','us'].map((m,i)=>plan(String(i),m,'2023-01-01','2023-01-02',[row('2023-01-02',100,10,1)]));
 const groups=combinePlans(plans);assert.equal(groups.length,3);
 for(const r of groups){assert.equal(r.last.profit,10);assert.equal(r.count,1);}
});
test('events and purchases are not repeated on other plans trading dates',()=>{
 const first=row('2023-01-02',100,10,1);first.events=[{id:'dividend'}];
 const a=plan('a','cn','2023-01-01','2023-01-05',[first]);
 const b=plan('b','cn','2023-01-03','2023-01-05',[row('2023-01-03',100,20,1)]);
 const [r]=combinePlans([a,b]);assert.equal(r.count,2);assert.equal(r.series.flatMap(d=>d.events).length,1);
});
