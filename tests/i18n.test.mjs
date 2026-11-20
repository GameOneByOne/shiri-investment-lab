import test from 'node:test';
import assert from 'node:assert/strict';
import {translateText as t,languageKey} from '../web/i18n.mjs';
test('security names stay unchanged while plan labels and currency explanations translate',()=>{
 assert.equal(t('贵州茅台（600519.SH）','en'),'贵州茅台（600519.SH）');
 assert.equal(t('中国银行','en'),'中国银行');
 assert.equal(t('计划 2 · 三一重工（元投入 · 人民币收益）','en'),'Plan 2 · 三一重工 (CNY contributions · CNY returns)');
 assert.equal(t('计划 2 股票名称','en'),'Plan 2 Security');
 assert.equal(t('计划 2 · 三一重工 参与合计','en'),'Plan 2 · 三一重工 included in total');
});
test('schedules, counts and chart scales localize without changing numeric meaning',()=>{
 assert.equal(t('每个交易日','en'),'Every trading day');assert.equal(t('31 号','en'),'31');
 assert.equal(t('81 次','en'),'81 contributions');assert.equal(t('1 年','en'),'1 year');assert.equal(t('5 年','en'),'5 years');
 assert.equal(t('2.0万','en'),'20K');assert.equal(t('1.2亿','en'),'120M');assert.equal(t('-1.0万','en'),'-10K');
 assert.equal(t('已计算 2 条独立计划；末行可继续填写新计划。','en'),'Calculated 2 independent plans. The last row is ready for a new plan.');
 assert.equal(t('已计算 1 条独立计划；末行可继续填写新计划。','en'),'Calculated 1 independent plan. The last row is ready for a new plan.');
});
test('chart events, range details and validation preserve dates and security names',()=>{
 assert.equal(t('计划 1 · TCL科技 · 分红送转：现金 0.00 元；送转 93.65 股','en'),'Plan 1 · TCL科技 · Corporate action: cash 0.00 CNY; bonus / transfer 93.65 shares');
 assert.equal(t('计划 1 · TCL科技：2023-01-01 至 2026-11-19，首笔执行 2023-02-01。','en'),'Plan 1 · TCL科技: 2023-01-01 to 2026-11-19, first contribution 2023-02-01.');
 assert.equal(t('计划 3：请选择股票或 ETF。','en'),'Plan 3: Please select a stock or ETF.');
 assert.match(t('2023-01-01 缺少有效历史汇率，请稍后重试。','en'),/^No valid historical FX rate for 2023-01-01/);
});
test('Chinese source text is reversible and exports use the selected language',()=>{
 assert.equal(t('累计投入','zh-CN'),'累计投入');assert.equal(t('累计投入','en'),'Total contributed');
 assert.equal(t('日期','en'),'Date');assert.equal(t('人民币','en'),'CNY');assert.equal(t('拾日_多计划回测.csv','en'),'shiri_multi_plan_backtest.csv');
 assert.equal(t('SHIRI · PIXEL EDITION','zh-CN'),'拾日 · 像素版');assert.equal(languageKey,'shiri.ui.language');
});
