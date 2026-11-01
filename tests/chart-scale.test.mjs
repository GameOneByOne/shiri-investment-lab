import test from 'node:test';
import assert from 'node:assert/strict';
import {chartScale} from '../web/chart-scale.mjs';

for(const values of [[-9263,2274],[120,950],[-950,-120],[0,0],[],[-.004,.007],[1e8,9e8]]){
  test(`axis includes zero and covers ${JSON.stringify(values)}`,()=>{
    const {lo,hi,ticks}=chartScale(values);
    assert(ticks.includes(0));
    assert(lo<hi);
    assert(values.every(v=>v>=lo&&v<=hi));
    assert(ticks.length>=3&&ticks.length<=7);
    const step=ticks[1]-ticks[0];
    for(let i=1;i<ticks.length;i++)assert(Math.abs(ticks[i]-ticks[i-1]-step)<step*1e-9);
  });
}
