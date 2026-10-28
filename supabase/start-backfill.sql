-- Run once after applying migrations, deploying collect-market and setting up
-- the scheduler. Re-running does not clear checkpoints or resume a paused run.
insert into market.bulk_control(id) values(true) on conflict(id) do nothing;
select public.market_bulk_pump();
select public.market_bulk_progress();
