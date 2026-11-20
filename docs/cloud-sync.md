# Optional account and cloud sync

## 中文配置速查

代码和数据库权限已接好；正式邮箱收码仍需配置 SMTP。以 Resend 为例：

1. 注册 Resend，添加并验证 `shiriinvestment.top` 或专用发信子域名。
   将 Resend 给出的 DNS 记录填写到域名当前使用的 DNS 服务商，等待验证通过。
   创建用于发信的 API Key，密钥只填入 Supabase。
2. 打开 Supabase 项目 → Authentication → Notifications 下的 Email → SMTP Settings，
   启用自定义 SMTP：Host `smtp.resend.com`，Port `465`，Username `resend`，
   Password 填 Resend API Key。Sender email 使用已验证域名的地址，例如
   `noreply@shiriinvestment.top`；Sender name 填「拾日」。保存。
3. 在邮件模板中，把 Magic Link 和 Confirm signup 的邮件正文设置为下文的验证码模板，
   保留 `{{ .Token }}`，不要填成固定数字。邮箱登录需开启，新用户注册也需允许。
4. Site URL 填 `https://www.shiriinvestment.top`，Redirect URLs 加入下文列出的正式和本地地址。
5. 在本地页面用自己的邮箱注册并收取验证码，确认导入，再用另一浏览器登录验证同步。
   SMTP 密码／API Key 不要发到聊天，也不要写入前端代码。

配置值来源：[Resend 官方 Supabase SMTP 指引](https://resend.com/docs/send-with-supabase-smtp)。
此操作不需要升级 Supabase 数据库套餐；邮件服务的额度及费用需按所选服务的套餐确认。

The home and My headers share a circular avatar. Hover or keyboard focus reveals
the menu; clicking also works on touch screens. Logged-out users see sign-up and
login. Authenticated users see their email, sync state and last successful sync.
The My menu also offers backup export/import. This release does not persist the
homepage's simulation form; cloud sync covers the existing personal investment
goal and its actual asset / legacy rate records only.

## Hosted Auth setup before real email testing

The database migration is independent of frontend deployment. No SMTP password
or service-role key belongs in the frontend, repository, or chat.

1. Open the Supabase project `vxwthnmoroyxqnloonqi` → Authentication. Enable Email
   and allow new email signups. Anonymous Auth accounts are not needed: guest
   usage remains entirely local.
2. Configure a custom SMTP sender in Authentication → Email / SMTP settings.
   Supabase's default mail service is restricted to organization team addresses
   and is not suitable for public registration. Configure the sender's domain
   verification in the chosen email provider; do not upgrade the database plan.
3. Add `{{ .Token }}` to the Magic Link and Confirm signup email templates. For
   example:

   ```html
   <h2>拾日 · 邮箱验证码 / Shiri verification code</h2>
   <p>{{ .Token }}</p>
   <p>请在拾日页面输入此验证码。若非本人操作，请忽略此邮件。</p>
   ```

4. Set Site URL to `https://www.shiriinvestment.top` and allow redirect URLs
   `https://www.shiriinvestment.top/my.html`,
   `https://shiri-investment-lab.vercel.app/my.html`, and
   `http://127.0.0.1:54629/my.html` for the local review. Add other preview origins
   explicitly when needed. Do not allow arbitrary wildcard destinations.
5. Test with a real user-controlled mailbox: register → request code → verify →
   confirm first import in My → save → sign in on a second browser → compare
   values. Also check a returning email via Login. The agent does not send test
   emails or use a user's OTP without authorization.

Official references:
[email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless),
[SMTP](https://supabase.com/docs/guides/auth/auth-smtp),
[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Data and synchronization

- `public.user_portfolios`: one row per `auth.users.id`; `data` stores `{plan,
  records}`, with a 1 MiB ceiling. `revision` is a server-side compare-and-swap
  version; `updated_at` is server time. No prices or computed chart points are
  duplicated. User metadata shares the existing database capacity.
- RLS restricts SELECT / INSERT / UPDATE to the row owner. Anonymous clients
  have no table or save-RPC privileges. There is no frontend service key.
- `save_user_portfolio(expected_revision,payload)` uses `SECURITY INVOKER`.
  Initial insert does nothing on conflict; updates match the expected version.
  An empty response means another client wrote first and must be re-read.
- Guest data remains under `shiri.personal-plan.v1`. Account caches and their
  last acknowledged server base use `shiri.cloud.portfolio.v1.<user UUID>`.
  A first import is explicit, with summaries of both versions. Blank defaults
  are never uploaded automatically. Imported guest data stays local.
- Changes save locally first. Sync is debounced by 700 ms and also triggered
  on reconnect, page visibility, and the Sync now button. Failed writes remain
  pending; a timeout never counts as a successful sync. Sync runs one request
  sequence at a time per page; a busy request schedules a follow-up.
- Three-way merge treats the plan as one atomic value and records by their
  existing date identity (the UI permits one record per date). Disjoint edits
  merge; concurrent changes to the same value require an explicit choice.
  Missing records relative to the acknowledged base represent deletions, so
  offline devices cannot silently resurrect records. JSON object key order is
  ignored because Postgres jsonb reorders keys.
- A local edit during a write is rebased onto the acknowledged result and
  remains pending. Storage events from other tabs merge instead of replacing
  in-memory drafts. Up to four CAS attempts are made before a visible retry
  state; conflicts are not silently resolved using client timestamps.
- If a merged plan is incompatible with record dates, the user must choose a
  complete version. The previous local and cloud versions are retained in an
  account-specific local backup and included in exported JSON. This keeps the
  most recent decision's originals, not an unlimited revision history.
- Exported backups contain personal financial records. Import validates plan
  values and dates and requires confirmation before replacing the current
  workspace. The user can export before logging out with pending changes.
- Logout signs out this device and removes its account cache and conflict
  backup. The guest workspace stays separate. In-flight responses from a
  previous account cannot write into the next account's workspace.

## Verification

`npm test` includes merge and sync-controller tests for two devices, deletion,
same-field conflicts, key reordering, uncertain writes, pending offline data,
edits during a write, another-tab updates, and account switching. The SDK is
pinned and bundled locally by esbuild; it is not fetched from a third-party CDN.

`supabase/tests/personal_cloud_sync.sql` is a rollback-only hosted integration
test. It creates two transient fixture identities without sending mail and
checks RLS ownership, cross-account read / write rejection, CAS, malformed
payload rejection and anonymous ACLs. Auth email delivery and OTP verification
still require the SMTP setup and a real mailbox walkthrough above.
