create policy daily_refresh_service_only on market.daily_refresh_log for all to service_role using (true) with check (true);
