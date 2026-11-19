# 云端每日行情更新

云端项目：`vxwthnmoroyxqnloonqi`。所有时间均为北京时间。

| 启动时间 | Cron 名称 | 用途 |
| --- | --- | --- |
| 每天 00:05 | `shiri-daily-refresh-0005-shanghai` | 为 A 股、港股、美股安排最新已收盘日线更新 |
| 每天 08:05 | `shiri-us-refresh-0805-shanghai` | 美股收盘后补充当晚最新日线 |

项目 Cron 时区为 GMT，表达式分别为 `5 16 * * *` 和 `5 0 * * *`。旧的 21:00 入队任务已停用；两个现有采集 Worker 和历史补采协调器继续运行。

## 更新规则

- A 股覆盖有已发布行情且启用的非 ST 股票、ETF、指数，不再只依赖 `nightly` 标记。历史补采的非 ST 范围保持不变。
- A 股日常只重取当前年度，跨年首周同时核对上一年度；历史年份复用已存数据。指定池的分红任务继续更新。
- 港股、美股沿用已有目录和年度任务，复用任务主键，更新尚未追平的截止日期；当前年度已有行情的标的优先执行。年度行情快照同时包含现有口径的公司行动数据。
- `00:05` 的美股尚未收盘，因此 `08:05` 再入队一次。沿用各市场本地收盘后的安全截止时间，并将周末截止日期回退到周五。节假日由真实行情决定，绝不合成缺失交易日。
- 已排队任务合并截止日期，不重复插入；运行中任务、重试次数及冷却时间保持不变。失败不会被伪装成成功。
- 是否追到目标日依据实际行情日期或已完成任务的截止日期核实，不能仅凭 `fetched_at`。例如今天下载了昨天截止的历史快照，仍需补采今天的收盘数据。
- 更新期间不将已发布标的的 `ready` 改为 false，前台仍可使用上次成功的数据。原有快照截断检查继续防止覆盖丢失历史日期。
- 共用现有单路限速和租约，任务间隔至少 6 秒；403/429 按原规则冷却。免费库达到 380 MiB 或存在手动/容量暂停时不再入队，不自动解除暂停、不升级套餐。
- 有 A 股日线待更新时，每四分钟中的两个连续调度窗口优先留给 A 股，让之前的海外市场租约先结束，避免两个按分钟启动的 Worker 持续竞争同一个限速门闩而使 A 股无法执行。不新增下载循环或增加 Worker 调用频率。
- 凌晨是启动时间，不是全量完成时间。是否已追到目标交易日，需要看实际 `price_series.last_date`；节假日、停牌和来源延迟都可能使最后日期早于目标日期。

## 查看每轮记录

在 Supabase SQL Editor 中执行：

```sql
select market, target_date, checked_at, tasks_added, status, run_id
from market.daily_refresh_log
order by checked_at desc
limit 30;
```

`tasks_added` 是该市场、该目标日期累计新增或更新的任务数，不是已下载成功的股票数。`run_id` 指最近一次产生新任务的 A 股批次，补充入队可能另有批次。`no_new_tasks` 表示本次没有新增任务，可能仍有已排队任务在执行；`skipped_pause`、`skipped_capacity`、`skipped_cooldown` 表示遵守暂停或退避。本表和入队函数仅管理员/服务端可用，匿名用户没有访问或执行权限。

查看 A 股最新目标日期的价格任务进度（包括该日期已存在的合并任务）：

```sql
select t.status, count(*)
from market.collection_tasks t
where t.dataset='prices'
  and t.year=extract(year from market.refresh_cutoff('CN'))
  and t.end_date>=market.refresh_cutoff('CN')
group by t.status;
```

历史补采总览仍在 https://shiri-investment-lab.vercel.app/progress.html ，不要将它的历史补采完成数视作今日更新完成数。

## 验证

`supabase/tests/daily_refresh.sql` 使用回滚事务检查时区截止日期、重复入队、已发布行情可用性、容量暂停、Worker 暂停及匿名权限，不实际调用行情源。云端首次启用时另外执行了一次正式入队，以便现有 Worker 继续处理。
