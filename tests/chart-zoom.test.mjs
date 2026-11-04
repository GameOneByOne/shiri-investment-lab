import test from 'node:test';
import assert from 'node:assert/strict';
import {DAY,zoomTimeRange} from '../web/chart-zoom.mjs';
const bounds={start:Date.UTC(2026,0,1),end:Date.UTC(2027,0,1)};
test('zoom preserves the time under the pointer',()=>{
  const fraction=.3,next=zoomTimeRange(bounds,bounds,fraction,-1);
  assert.ok(Math.abs(next.start+(next.end-next.start)*fraction-(bounds.start+(bounds.end-bounds.start)*fraction))<1);
});
test('zoom stops at seven days and the complete plan',()=>{
  const close=zoomTimeRange(bounds,bounds,.5,-100);
  assert.equal(close.end-close.start,7*DAY);
  assert.deepEqual(zoomTimeRange(close,bounds,.5,100),bounds);
});
test('both edge anchors stay within plan boundaries',()=>{
  for(const fraction of [0,1]){
    const next=zoomTimeRange(bounds,bounds,fraction,-1);
    assert.ok(next.start>=bounds.start&&next.end<=bounds.end);
    assert.equal(fraction?next.end:next.start,fraction?bounds.end:bounds.start);
    assert.deepEqual(zoomTimeRange(next,bounds,1-fraction,100),bounds);
  }
});
test('recorded ranges shorter than seven days stay fully visible',()=>{
  for(const length of [0,3*DAY]){
    const short={start:bounds.start,end:bounds.start+length};
    assert.deepEqual(zoomTimeRange(short,short,.4,-100),short);
  }
});
