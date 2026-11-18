import test from 'node:test';
import assert from 'node:assert/strict';
import {panTimeRange,panValueRange} from '../web/chart-pan.mjs';
test('drag follows the pointer without changing the zoom level',()=>{
  assert.deepEqual(panTimeRange({start:40,end:60},{start:0,end:100},.5),{start:30,end:50});
  assert.deepEqual(panTimeRange({start:40,end:60},{start:0,end:100},-.5),{start:50,end:70});
  assert.deepEqual(panValueRange({lo:100,hi:200},.25),{lo:125,hi:225});
  assert.deepEqual(panValueRange({lo:100,hi:200},-.25),{lo:75,hi:175});
});
test('horizontal dragging cannot expose dates outside the plan',()=>{
  assert.deepEqual(panTimeRange({start:40,end:60},{start:0,end:100},100),{start:0,end:20});
  assert.deepEqual(panTimeRange({start:40,end:60},{start:0,end:100},-100),{start:80,end:100});
  assert.deepEqual(panTimeRange({start:0,end:100},{start:0,end:100},1),{start:0,end:100});
});
