import test from 'node:test';
import assert from 'node:assert/strict';
import {simulate,sampleSeries,scheduledDates,chartSeries} from '../web/engine.mjs';
const bars=[{date:'2024-01-05',close:10},{date:'2024-01-08',close:20},{date:'2024-01-09',close:15}];
const options={start:'2024-01-05',end:'2024-01-09',frequency:'daily',amount:100};
test('daily contributions are valued after purchase at close',()=>{
  const r=simulate(options,bars);assert.equal(r.count,3);assert.equal(r.last.contributed,300);assert.equal(r.last.assets,325);assert.equal(r.last.profit,25);
});
test('a weekend weekly order moves to the following trading day',()=>{
  const r=simulate({...options,frequency:'weekly',weekday:6},bars);assert.equal(r.count,1);assert.equal(r.firstPurchase,'2024-01-08');assert.equal(r.last.assets,75);
});
test('orders outside the available end are not charged',()=>{
  const r=simulate({...options,end:'2024-01-05',frequency:'weekly',weekday:6},bars);
  assert.equal(r.count,0);assert.equal(r.last.contributed,0);assert.equal(r.last.profit,0);
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
  const r=simulate({...options,start:'2023-01-01',stock:{firstDate:'2024-01-05'},frequency:'monthly',monthday:1},bars);
  assert.equal(r.count,0);assert.equal(r.firstPurchase,null);
  assert(r.series.every(d=>d.contributed===0&&d.assets===0&&d.profit===0&&d.rate===0));
});

test('pre-listing monthly orders are skipped and later schedules execute normally',()=>{
  const b=[{date:'2023-04-19',close:10},{date:'2023-05-04',close:10},{date:'2023-06-01',close:20}];
  const o={start:'2023-01-01',end:'2023-06-01',amount:100,frequency:'monthly',monthday:1,stock:{firstDate:'2023-04-19'}};
  const r=simulate(o,b);
  assert.equal(r.series[0].date,'2023-01-01');assert.equal(r.count,2);
  assert.equal(r.firstPurchase,'2023-05-04');assert.equal(r.last.contributed,200);
  assert(r.series.filter(d=>d.date<'2023-05-04').every(d=>d.contributed===0&&d.profit===0&&d.rate===0));
  assert.equal(r.last.assets,300);
});
test('an entirely pre-listing range returns a zero curve, including benchmark zeros',()=>{
  const r=simulate({start:'2023-01-01',end:'2023-01-31',amount:100,frequency:'weekly',weekday:1,stock:{firstDate:'2023-04-19'}},[],[{date:'2023-01-03',close:3000}]);
  assert.equal(r.series.length,31);assert.equal(r.count,0);assert.equal(r.firstPurchase,null);
  assert(r.series.every(d=>d.assets===0&&d.contributed===0&&d.profit===0&&d.rate===0&&d.benchmarkAssets===0));
});
test('already-listed securities still roll holiday orders to the next trading day',()=>{
  const r=simulate({start:'2023-01-01',end:'2023-01-04',amount:100,frequency:'monthly',monthday:1,stock:{firstDate:'2021-01-04'}},[{date:'2023-01-03',close:10},{date:'2023-01-04',close:11}]);
  assert.equal(r.count,1);assert.equal(r.firstPurchase,'2023-01-03');assert.equal(r.last.assets,110);
  assert.equal(r.series[0].contributed,0);
});
test('no-variance single-day scenario is valid and has zero profit',()=>{
  const r=simulate({...options,end:'2024-01-05'},bars);assert.equal(r.last.profit,0);assert.equal(r.last.rate,0);
});

const action={id:'cash-1',source:'fixture',status:'implemented',recordDate:'2024-01-05',exDate:'2024-01-08',cashPer10:10,bonusSharesPer10:0,transferSharesPer10:0};
test('chart retains all entitled actions and their exact benefits across sampling modes',()=>{
  const actions=[action,{...action,id:'shares',cashPer10:0,bonusSharesPer10:3,transferSharesPer10:7,planText:'10送3转7'}];
  const r=simulate(options,bars,[],actions);
  for(const mode of ['day','month','year']){
    const points=chartSeries(r.series,mode),event=points.find(d=>d.date==='2024-01-08');
    assert.equal(event.events.length,2);
    assert.equal(event.events[0].cashAmount,10);
    assert.equal(event.events[1].bonusUnits,3);
    assert.equal(event.events[1].transferUnits,7);
    assert.equal(event.events[1].planText,'10送3转7');
    assert.equal(points.filter(d=>d.date==='2024-01-08').length,1);
    assert.equal(points.at(-1),r.last);
  }
});
test('proposals and actions with no entitled holdings produce no chart markers',()=>{
  const proposed=simulate(options,bars,[],[{...action,status:'proposed'}]);
  assert(proposed.series.every(d=>!d.events?.length));
  const onExDate=simulate({...options,start:'2024-01-08'},bars,[],[action]);
  assert(onExDate.series.every(d=>!d.events?.length));
});
test('an action during missing prices is attached to the next valuation with its original ex-date',()=>{
  const r=simulate(options,[bars[0],bars[2]],[],[action]);
  assert.equal(r.last.events[0].exDate,'2024-01-08');
  assert.equal(r.last.date,'2024-01-09');
});
test('cash dividend offsets ex-date price reduction and excludes ex-date purchases',()=>{
  const b=[{date:'2024-01-05',close:10},{date:'2024-01-08',close:9}];
  const r=simulate({...options,end:'2024-01-08'},b,[],[action]);
  assert.equal(r.last.cash,10);assert.equal(r.last.contributed,200);
  assert.equal(r.last.assets,200);assert.equal(r.last.profit,0);
});
test('bonus and transfer shares preserve assets through ex-rights adjustment',()=>{
  const b=[{date:'2024-01-05',close:10},{date:'2024-01-08',close:5}];
  const r=simulate({...options,end:'2024-01-08',frequency:'weekly',weekday:5},b,[],[{...action,cashPer10:0,bonusSharesPer10:3,transferSharesPer10:7}]);
  assert.equal(r.last.units,20);assert.equal(r.last.assets,100);assert.equal(r.last.profit,0);
});
test('record-date entitlement is fixed even when purchases occur before ex-date',()=>{
  const b=[{date:'2024-01-05',close:10},{date:'2024-01-08',close:10},{date:'2024-01-09',close:9}];
  const r=simulate(options,b,[],[{...action,exDate:'2024-01-09'}]);
  assert.equal(r.last.cash,10);
  const startingOnEx=simulate({...options,start:'2024-01-09'},b,[],[{...action,exDate:'2024-01-09'}]);
  assert.equal(startingOnEx.last.cash,0);
});
test('proposals are excluded; retained dividends are not reinvested',()=>{
  const b=[{date:'2024-01-05',close:10},{date:'2024-01-08',close:9},{date:'2024-01-09',close:18}];
  const o={...options,frequency:'weekly',weekday:5};
  assert.equal(simulate(o,b,[],[{...action,status:'proposed'}]).last.assets,180);
  const r=simulate(o,b,[],[action]);assert.equal(r.last.units,10);assert.equal(r.last.cash,10);assert.equal(r.last.assets,190);
});
