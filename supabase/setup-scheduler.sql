-- Run once AFTER deploying collect-market. Replace the URL for another project.
-- Job tokens stay in Vault; no token or service key is sent to the browser.
do $$
begin
  if not exists(select 1 from vault.secrets where name='shiri_project_url') then
    perform vault.create_secret('https://vxwthnmoroyxqnloonqi.supabase.co','shiri_project_url');
  end if;
  if not exists(select 1 from vault.secrets where name='shiri_job_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'shiri_job_token');
  end if;
end $$;
insert into market.job_secret(id,token_hash)
  select true,encode(extensions.digest(decrypted_secret,'sha256'),'hex')
    from vault.decrypted_secrets where name='shiri_job_token'
  on conflict(id) do update set token_hash=excluded.token_hash;
select cron.schedule('shiri-collection-worker','* * * * *',$$
  select net.http_post(
    url:=(select decrypted_secret from vault.decrypted_secrets where name='shiri_project_url')||'/functions/v1/collect-market',
    headers:=jsonb_build_object('Content-Type','application/json','x-job-token',
      (select decrypted_secret from vault.decrypted_secrets where name='shiri_job_token')),
    body:='{}'::jsonb,timeout_milliseconds:=90000
  ) where exists(select 1 from market.collection_tasks where status in ('pending','running'));
$$);
