import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate,sampleSeries,scheduledDates} from '../web/engine.mjs';
const bars=[{date:'2024-01-05',close:10},{date:'2024-01-08',close:20},{date:'2024-01-09',close:15}];
const options={start:'2024-01-05',end:'2024-01-09',frequency:'daily',amount:100};
test('daily contributions are valued after purchase at close',()=>{
  const r=simulate(options,bars);assert.equal(r.count,3);assert.equal(r.last.contributed,300);assert.equal(r.last.assets,325);assert.equal(r.last.profit,25);
});
test('a weekend weekly order moves to the following trading day',()=>{
  const r=simulate({...options,frequency:'weekly',weekday:6},bars);assert.equal(r.count,1);assert.equal(r.firstPurchase,'2024-01-08');assert.equal(r.last.assets,75);
});
test('orders outside the available end are not charged',()=>{
  assert.throws(()=>simulate({...options,end:'2024-01-05',frequency:'weekly',weekday:6},bars),/没有可执行/);
});
test('monthly 31 clamps to February end and then rolls forward',()=>{
  const b=[{date:'2024-02-28',close:10},{date:'2024-03-01',close:20}];
  const o={start:'2024-02-01',end:'2024-03-01',amount:100,frequency:'monthly',monthday:31};
  assert.deepEqual(scheduledDates(o,b),['2024-02-29']);
  assert.equal(simulate({...o,start:'2024-02-20'},b).firstPurchase,'2024-03-01');
});
test('benchmark uses exactly the same contribution dates and cash flows',()=>{
  const r=simulate(options,bars,bars.map(b=>({...b,close:b.close*100})));
  assert.equal(r.last.benchmarkAssets,r.last.assets);assert.equal(r.last.benchmarkProfit,r.last.profit);
});
test('missing benchmark on purchase date is an error rather than previous-day execution',()=>{
  assert.throws(()=>simulate(options,bars,bars.slice(1)),/缺少/);
});
test('period grouping takes the last value and never sums returns',()=>{
  const series=[{date:'2023-12-29',profit:10},{date:'2024-01-02',profit:20},{date:'2024-01-31',profit:30},{date:'2024-02-01',profit:40}];
  assert.deepEqual(sampleSeries(series,'month').map(x=>x.profit),[10,30,40]);
  assert.deepEqual(sampleSeries(series,'year').map(x=>x.profit),[10,40]);
});
test('pre-listing years cannot accumulate and execute on IPO day',()=>{
  assert.throws(()=>simulate({...options,start:'2020-01-01'},bars),/最早可用/);
});
test('no-variance single-day scenario is valid and has zero profit',()=>{
  const r=simulate({...options,end:'2024-01-05'},bars);assert.equal(r.last.profit,0);assert.equal(r.last.rate,0);
});
