# 拾日 · 历史定投实验室

前后端分离的历史定投回测工具。Vercel 托管静态前端；Supabase 采集、存储并返回行情；浏览器计算收益和绘图。不需要登录，不创建账号，不保存用户的金额、周期或收益。

## 架构

```text
Supabase Cron（北京时间每天 21:00 创建任务）
  → collect-market Edge Function（按证券、年份分批采集腾讯行情）
  → market schema（暂存、校验、整只证券原子发布）
  → Supabase 只读 RPC（证券搜索、历史日线、行情日期）
  → Vercel 前端（engine.mjs 计算，app.mjs 绘图）
```

行情请求只包含证券代码和起止日期，不上传定投金额或周期。服务器没有收益计算接口。market schema 与未来可能的用户业务数据分离，无需加入 Supabase 暴露的 schema 列表。

## 当前云端配置

- Supabase 项目：shiri-investment-lab，新加坡区域。
- Project ref：vxwthnmoroyxqnloonqi。
- API URL：https://vxwthnmoroyxqnloonqi.supabase.co。
- 初始股票池：贵州茅台、平安银行、招商银行、宁德时代、沪深300ETF、中证500ETF、上证50ETF、上证指数。
- 数据范围：2021-01-01 或之后的上市日起，仅保留正数的不复权收盘价。

## 前端开发与 Vercel

需要 Node.js 22+。无第三方运行时或构建依赖。

1. 将 .env.example 复制为 .env，填写 Supabase URL 和 **publishable 公钥**。
2. 执行 `npm run dev`，打开 http://127.0.0.1:8765。
3. Vercel 导入本仓库，Root Directory 使用仓库根目录，Framework Preset 选择 Other。
4. 在 Vercel 的 Production / Preview 环境分别配置：

```text
PUBLIC_SUPABASE_URL=https://vxwthnmoroyxqnloonqi.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=<Supabase 项目中的 sb_publishable_ 公钥>
```

vercel.json 已配置 `npm run build` 和 dist 输出目录。构建脚本只公开以上两个值；发现 secret/service-role 密钥会拒绝构建。SUPABASE_SECRET_KEY 绝不能填入前端环境变量。无需 Python 服务、Vercel Functions 或 Vercel Cron。

## 数据接口

使用 Supabase Data API：`POST /rest/v1/rpc/<name>`，请求头 `apikey: <publishable key>`。

| RPC | 输入 | 返回 |
| --- | --- | --- |
| market_config | {} | 股票池、基准最后一个已采集交易日 |
| market_search | {"p_query":"茅台"} | 股票池内中文、代码、拼音匹配 |
| market_history | {"p_symbol":"sh600519","p_start":"2021-01-01","p_end":"2026-10-27"} | 完整区间日线、复权口径、来源和采集时间 |

历史日线包在单个 JSON 对象内返回，避免默认行数上限截断长期历史。前端分别读取标的与基准日线，再调用纯客户端 simulate()。月/年切换只改变显示采样。

## 采集与一致性

- shiri-nightly-21-shanghai：UTC 13:00，即北京时间每天 21:00 创建任务。
- shiri-collection-worker：每分钟检查队列，有任务时才触发采集；每次最多处理三个年份。
- shiri-queue-cleanup：清理两天前暂存数据，保留 30 天运行摘要。
- 每项任务有两分钟租约、最多三次尝试；超时可重新领取，回调校验尝试编号。
- 整只证券全部年份完成后，在一个事务中更新目录和完整历史，避免不完整年度覆盖已发布数据。
- 任一年份失败，保留上一份已发布行情；拒绝删除已有交易日的不完整快照。
- 21:00 是任务开始时间，完成时间取决于股票池和行情源。节假日也检查，行情日期保持最后交易日。
- 页面展示行情截止日和采集时间；采集超过 48 小时会提示。

| 表 | 用途 | 浏览器权限 |
| --- | --- | --- |
| market.securities | 股票池、采集元信息 | 只读启用标的 |
| market.daily_bars | 正式日线，证券与日期联合索引 | 只读启用标的 |
| market.collection_tasks | 年份任务、暂存、租约、重试 | 无 |
| market.collection_runs | 运行状态、成功数、错误 | 无 |
| market.job_secret | 任务令牌摘要 | 无 |

所有表启用 RLS；读接口为 SECURITY INVOKER；写入和队列 RPC 仅允许 service_role。Edge Function 使用平台内置服务端密钥，入口验证独立任务令牌。原始令牌保存在 Vault，数据库只存摘要；浏览器公钥不能触发采集。

## 扩展股票池

1. 修改 backend/stock-pool.json，保留 sh000001。start 不得早于 2021-01-01。
2. 执行 `node scripts/pool-sql.mjs` 生成可审阅 SQL，在 Supabase SQL Editor 执行。移出的标的停止采集和提供查询，已有数据保留。
3. 执行 `select public.market_enqueue();` 立即补数，或等待下一次 21:00。

当前支持股票、ETF 和上证指数；其他指数需先添加并验证行情适配。

## 新环境初始化

1. 使用 Supabase CLI 应用 supabase/migrations 下迁移。当前云端项目已应用这些迁移。
2. 执行 `supabase functions deploy collect-market`，函数配置见 supabase/config.toml。
3. 修改 supabase/setup-scheduler.sql 的项目 URL，在 SQL Editor 执行，生成 Vault 令牌、摘要并配置工作队列调度。
4. 执行 `select public.market_enqueue();`，等首次采集成功后发布前端。

setup-scheduler.sql 是环境初始化脚本，不作为数据库迁移重复推送。复制到新项目时必须修改 URL，不需要手工复制任务令牌。

可选 Python 采集器 backend/collector.py 用于诊断和人工采集，依赖 Python 3.10+ 与 curl，日常定时任务不依赖它。配置私有环境变量 SUPABASE_URL、SUPABASE_SECRET_KEY 后可执行 `python -m backend.collector`。不要在定时采集运行时人工发布其他快照。

## 校验与运维

```sh
npm test
python -m unittest discover -s tests -p 'test_*.py'
npm run build
```

tests/database.sql 在 SQL Editor 以管理员身份执行，校验权限、价格和快照回滚，所有测试数据会回滚。GitHub CI 执行 JS/Python 测试与前端构建。

```sql
select id, started_at, finished_at, status, succeeded, errors
from market.collection_runs order by started_at desc limit 10;
select symbol, year, status, attempts, error
from market.collection_tasks where status <> 'completed';
select jobname, schedule, active from cron.job;
```

## 行情维度与分红明细

只采集 2021-01-01（或之后的上市日）起的不复权收盘价。`market.price_daily` 只有 `symbol`、`trade_date`、`close` 三列；前复权/后复权、2021 年前行情、开盘/最高/最低价、成交量、成交额、换手率及重复的 `daily_bars` 表已移除。

分红独立保留登记日、除息日、发放日（未知时为 null）、税前每十股派现金额、送股和转增比例、实施状态及必要的来源标识；去掉原始响应 JSON。不根据报告年度删除事件：2020 年报在 2021 年实施的分红仍需保留。只保留经济日期在 2021 年起的记录。

浏览器按不复权收盘价定投，登记日收盘持股确定权益；除息日计入税前应收分红，不再投资；送转按除权日增加理论持股，尚未模拟实际到账后的可卖限制。缺登记日时按除权前持股估算。累计收益率不是年化收益率。不模拟配股缴款、交易税费和整手限制。分红尚未采齐时不显示含分红收益。

`market_prices` 只接受 `none`，`market_history` 默认返回该口径。已移除的价格口径会报错，不会悄悄返回其他口径。旧本地 Python 下载入口已停用，采集统一通过共享限速队列。

## 全 A 股慢速补采

入口：`/progress.html`，或匿名只读 RPC `market_bulk_progress()`。统计快照每分钟刷新；股票总数来自名单源报告，只有所有分页计数和代码去重校验通过才标记名单完整。名单核实与已发现标的补采可以交替进行，不把已知的小样本作为全市场分母。

- 范围：启动时沪深北上市 A 股，主板、创业板、科创板、北交所；不包含 B 股、港股及已退市股票。名单源为东方财富公开行情列表，保存代码、名称、交易所和上市日。历史起点为 `max(2021-01-01, 上市日)`，截止日在启动时固定；分红保留 2021 年起实施或公告的方案。
- 每只股票的任务为每年一份不复权收盘价，加一份分红任务。按单路执行，任务请求间隔至少 6 秒，正常工作器实际约 8–10 秒以上；每次 Edge 调用最多 10 个任务并限制执行窗口。仅两只股票进入暂存窗口，发布完整价格口径后立即释放该口径的暂存 JSON。
- 失败按 15 分钟、30 分钟递增延迟，最多 3 次；连续 3 次失败触发 1 小时全局冷却，HTTP 403/429 至少冷却 24 小时。名单失败则 30 分钟起指数退避、最高 6 小时；不会换 IP、绕过验证码或限制。
- `market.bulk_control` 保存名单页码、退避、容量阈值和截止日；`market.bulk_members` 保存每股断点、最终任务计数、发布行数及异常；完成后清除任务暂存，保留成员和运行摘要。`market.bulk_progress` 是可公开的只读统计，内部调度表不向匿名用户开放。
- 用户选择继续使用 Supabase Free：数据库总尺寸达到 **380 MiB（398,458,880 字节）** 时暂停 bulk 新请求，保留断点，不自动恢复、不升级。该安全阈值留出原股票池、暂存和系统维护空间；不能保证长期后台增长永远不触及平台配额。
- 原有 8 个标的仍按 21:00 的原计划维护。新增股票的 `nightly=false`，不混入旧的全历史每日重拉任务；完整不复权收盘价发布后才 `enabled=true`，可在回测中搜索使用。本轮全市场历史补采不代表已实现全市场每日更新。
- 免费容量预计装不下全部历史，**一周是慢速采集的目标窗口，不是免费套餐下全部入库的承诺**。进度中的 `completed` 必须所有必需任务成功；`partial`/`failed` 均不会算成功。任务成功意味着来源响应与格式通过校验，仍未独立对照交易所完整交易日历。

部署：应用迁移，部署包含 `catalog.mjs` 的 collect-market，执行 `supabase/setup-scheduler.sql`，再执行 `supabase/start-backfill.sql`。后者可重复执行，不清空进度。`scripts/catalog.py` 是可选的本地断点名单采集工具；定时采集不依赖本机在线。

运维查询：

```sql
select public.market_bulk_progress();
select symbol,status,requests_done,requests_total,error from market.bulk_members order by ordinal;
-- 手动暂停（在途请求可能完成）：
update market.bulk_control set state='paused_manual' where id;
select public.market_bulk_refresh_progress();
-- 确认容量已释放且低于阈值后恢复；不会自动恢复容量暂停：
update market.bulk_control set state=case when catalog_complete then 'running' else 'cataloguing' end
where id and state in ('paused_capacity','paused_manual') and pg_database_size(current_database())<capacity_bytes;
```

集成检查 `tests/database_bulk.sql` 需要在首次激活前运行，事务回滚；验证名单不完整、单路闸门、退避、403/429 冷却、容量暂停不自恢复和匿名写入限制。其他数据库维度测试可以继续运行。

## 计算口径

以不复权收盘价计算模拟持股：投入 / 当日价格；每日资产 = 持股 × 收盘价 + 累计税前应收分红，送转独立增加持股。上证指数使用原始点位，复用标的实际投入日期和金额。累计收益率 =（资产 − 累计投入）/ 累计投入，不是年化收益率。

周/月计划遇休市或缺行情顺延，当月无指定日号则取月末，超出结束日期不执行。首条行情距开始日期超过 20 天时要求调整区间。暂不模拟税费、整手限制和真实分红现金流，也未独立校验全历史交易日历；这是价格历史模拟，历史表现不预示未来收益。


