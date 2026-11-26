import test from 'node:test';
import assert from 'node:assert/strict';
import {createFxApi,convertPlanCurrency,convertPlanToCny,rateOn,validateRates} from '../web/fx.mjs';
import {combineCnyPlans,combinePlans} from '../web/portfolio.mjs';
const rates=[{date:'2023-01-02',base:'USD',quote:'CNY',rate:7},{date:'2023-01-03',base:'USD',quote:'CNY',rate:8}];
const plan=(market='us')=>({id:1,name:'test',options:{market,start:'2023-01-02',end:'2023-01-04'},result:{count:2,series:[{date:'2023-01-02',contributed:100,assets:100,profit:0,purchases:1},{date:'2023-01-03',contributed:200,assets:200,profit:0,purchases:1}]}});
test('historical deposits retain their FX cost and returns include FX movement',()=>{
 const p=convertPlanToCny(plan(),rates);assert.equal(p.result.last.contributed,1500);assert.equal(p.result.last.assets,1600);assert.equal(p.result.last.profit,100);assert.equal(p.result.last.rate,100/1500);assert.equal(p.result.last.fxDate,'2023-01-03');
 assert.equal(p.nativeResult.series[1].contributed,200);
});
test('FX moves foreign assets on a stock holiday without repeating deposits or dividends',()=>{
 const p=plan();p.result.series=[{date:'2023-01-02',contributed:100,assets:100,profit:0,purchases:1,events:[{cashAmount:10}]}];
 const c=convertPlanToCny(p,rates);assert.equal(c.result.last.assets,800);assert.equal(c.result.last.contributed,700);
 assert.equal(c.result.series.reduce((s,d)=>s+(d.purchases||0),0),1);
 assert.equal(c.result.series.flatMap(d=>d.events).length,1);assert.equal(c.result.series[0].events[0].cashAmount,70);
});
test('mixed markets share one CNY total and ended plans freeze their CNY value',()=>{
 const usd=convertPlanToCny(plan(),rates),cny=convertPlanToCny({...plan('cn'),id:2,options:{market:'cn',start:'2023-01-02',end:'2023-01-06'}},[]);
 const [total]=combineCnyPlans([usd,cny]);assert.equal(total.last.contributed,1700);assert.equal(total.last.assets,1800);assert.equal(total.last.profit,100);assert.equal(total.count,4);
 assert.equal(total.members[0].options.market,'us');assert.equal(combineCnyPlans([cny])[0].last.assets,200);
});
test('cross-currency totals convert cash flows at their execution rate and keep ended-plan valuations',()=>{
 const hkdRates=[{date:'2023-01-02',base:'HKD',quote:'CNY',rate:0.8},{date:'2023-01-03',base:'HKD',quote:'CNY',rate:1}];
 const usd=convertPlanCurrency(plan(),'hk',rates,hkdRates);
 const hkd=convertPlanCurrency({...plan('hk'),id:2,options:{market:'hk',start:'2023-01-02',end:'2023-01-06'}},'hk');
 const [total]=combinePlans([usd,hkd],'hk');
 assert.equal(total.last.contributed,1875);
 assert.equal(total.last.assets,1800);
 assert.equal(total.last.profit,-75);
 assert.equal(total.last.rate,-75/1875);
 assert.equal(total.count,4);
 assert.equal(total.members[0].options.market,'us');
 assert.equal(usd.result.last.fxRate,8);
 assert.equal(hkd.result,hkd.nativeResult);
});
test('CNY to USD converts the benchmark and dividend cash with their dated rates',()=>{
 const cny=plan('cn');
 cny.result.series[0].benchmarkAssets=105;
 cny.result.series[0].events=[{cashAmount:14}];
 cny.result.series[1].benchmarkAssets=216;
 const p=convertPlanCurrency(cny,'us',[],rates);
 const first=p.result.series[0],last=p.result.last;
 assert.equal(first.benchmarkAssets,15);
 assert.equal(first.events[0].cashAmount,2);
 assert.equal(first.events[0].nativeCashAmount,14);
 assert.equal(last.benchmarkAssets,27);
 assert.equal(last.benchmarkProfit,27-(100/7+100/8));
 assert.equal(last.assets,25);
 assert.equal(last.contributed,100/7+100/8);
});
test('FX never looks ahead or silently uses stale or invalid rates',()=>{
 assert.throws(()=>rateOn(rates,'2023-01-01'),/缺少/);assert.throws(()=>rateOn(rates,'2023-01-11'),/缺少/);
 assert.throws(()=>validateRates([{...rates[0],rate:0}],'USD'),/异常/);
 assert.throws(()=>validateRates(rates,'HKD'),/异常/);assert.throws(()=>validateRates([rates[0],rates[0]],'USD'),/异常/);
});
test('FX transport only sends currency and dates, caches successes and retries errors',async()=>{
 let calls=0;
 const load=createFxApi(async(url)=>{calls++;const u=new URL(url);assert.equal(u.searchParams.get('base'),'USD');assert.equal(u.searchParams.get('quotes'),'CNY');assert.equal(u.searchParams.get('providers'),'ECB');assert.equal(u.searchParams.get('from'),'2022-12-19');assert.equal([...u.searchParams].length,5);return {ok:true,json:async()=>rates};});
 await load('us','2023-01-02','2023-01-04');await load('us','2023-01-02','2023-01-04');assert.equal(calls,1);await load('cn','2023-01-02','2023-01-04');assert.equal(calls,1);
 let failed=0;const retry=createFxApi(async()=>{failed++;return {ok:false};});
 await assert.rejects(()=>retry('us','2023-01-02','2023-01-04'),/失败/);await assert.rejects(()=>retry('us','2023-01-02','2023-01-04'),/失败/);assert.equal(failed,2);
});
