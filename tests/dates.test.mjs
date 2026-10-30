import test from 'node:test';
import assert from 'node:assert/strict';
import {currentMarketDate,validateDateRange} from '../web/dates.mjs';
test('today follows the Shanghai trading calendar date and rolls over at midnight',()=>{
  assert.equal(currentMarketDate(new Date('2026-10-28T15:59:59Z')),'2026-10-28');
  assert.equal(currentMarketDate(new Date('2026-10-28T16:00:00Z')),'2026-10-29');
});
test('date range accepts the first supported day and today, rejects earlier and future days',()=>{
  const now=new Date('2026-10-28T12:00:00Z');
  assert.doesNotThrow(()=>validateDateRange('2021-01-01','2026-10-28',now));
  assert.throws(()=>validateDateRange('2020-12-31','2026-10-28',now),/最早/);
  assert.throws(()=>validateDateRange('2021-01-01','2026-10-29',now),/今天/);
  assert.throws(()=>validateDateRange('2026-10-28','2026-10-27',now),/开始日期/);
});
