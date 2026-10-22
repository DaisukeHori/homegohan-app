-- migration: 20261022150000_family_invites_rpc_only_writes.sql
-- 戻し方: supabase/rollbacks/20261022150000_family_invites_rpc_only_writes.down.sql
-- #1912 (C36): 家族の大人が PostgREST の直接の INSERT / UPDATE で family_invites の行を作り・書き換えられ、
-- 招待の作成の RPC create_family_invite の門 (家族プランの門 FAMILY_PLAN_REQUIRED・人数上限 MEMBER_LIMIT_EXCEEDED・
-- 24 時間の作成上限 RATE_LIMITED・作成の監査ログ) を通らない既存の欠陥を直す。
--
-- 背景:
--   本番のベースライン (20251126124224_create_meal_planner_tables.sql) の family_invites の書き込みのポリシー
--     :10367 family_invites_insert_adult  FOR INSERT TO authenticated WITH CHECK (is_active_family_adult(family_id))
--     :10375 family_invites_update_adult  FOR UPDATE TO authenticated USING      (is_active_family_adult(family_id))
--   と、:13592-13593 の anon / authenticated への INSERT・UPDATE・DELETE・TRUNCATE の権限により、その家族の active な
--   代表者・大人は、RPC を通らずに招待の行を作れ (status・token・expires_at・invited_role 以外の列も好きな値で)、
--   家族の招待のどの列も書き換えられた (20261008100000_membership_daily_send_cap.sql の冒頭の「family_invites は家族の大人が
--   任意の列を UPDATE でき」)。これより後の migration に、このポリシーを外すものは無い。
--   家族プランの門は 20261022130000_family_invite_plan_gate.sql:59-66 の RPC の中にだけあるので、直接の INSERT はそれを通らない。
--   メールは送られず (送るのは POST /api/family/invites の route)、承諾はトリガー family_members_billing_plan_gate が
--   FAMILY_PLAN_REQUIRED で断るので、利用者に見える影響は小さい。
--
--   招待の行を書く経路 (origin/main で git grep した。直接の書き込みはどれも RPC か service role):
--     - 作成: create_family_invite (SECURITY DEFINER。POST /api/family/invites が呼ぶ)
--     - 取り消し: revoke_family_invite (SECURITY DEFINER。POST /api/family/invites/[id]/revoke)
--     - 承諾・拒否: accept_family_invite / reject_family_invite (SECURITY DEFINER。招待された本人)
--     - 退会の前処理: prepare_account_deletion (SECURITY DEFINER。service_role だけが実行できる)
--     - 解散した家族の物理削除: purge_dissolved_family_groups (呼ぶのは pg_cron (所有者 postgres) と service_role だけ) と、代表者の家族の行の DELETE
--       (ポリシー family_groups_delete_representative) の外部キーの CASCADE。CASCADE は参照する表の所有者の権限で動き、
--       RLS も当たらないので、この migration の後も招待の行は一緒に消える (結合テストで確かめる)
--     - Web (src) が利用者のセッションで family_invites を触るのは GET /api/family/invites の SELECT だけ。
--       モバイル (apps/mobile)・Edge Function (supabase/functions) は family_invites を触らない。
--       e2e の補助 (tests/e2e/helpers/membership-family.ts・tests/e2e/membership/06-family-edge-cases.spec.ts) は service_role の鍵で書く
--
-- 変更 (20261011010000_ai_queue_service_role_writes.sql と同じ形):
--   1. 書き込みを許すポリシーを消す: family_invites_insert_adult / family_invites_update_adult。
--      SELECT のポリシー family_invites_select_adult は残す (招待の一覧の画面が読む)。DELETE のポリシーはもともと無い。
--   2. 書き込みの権限 (INSERT / UPDATE / DELETE / TRUNCATE) を anon と authenticated から外す。
--      ポリシーを消すだけでも INSERT は 42501 になるが、UPDATE は 0 行で黙って終わる。権限を外すと INSERT・UPDATE・DELETE は
--      どれも 42501 (permission denied) で止まり、後で誰かが書き込みのポリシーを足しても開かない (二重に閉じる)。
--      TRUNCATE は RLS が効かない書き込みなので一緒に外す。SELECT・REFERENCES・TRIGGER・MAINTAIN と service_role の権限は変えない。
--      SECURITY DEFINER の RPC は所有者 (postgres) の権限で書くので、この変更の影響を受けない。
--
-- 既存データへの影響: なし (ポリシーと権限だけの変更。直接の INSERT で作られた既存の招待の行は消さない。承諾はトリガーが断る)。
-- 冪等: DROP POLICY IF EXISTS と REVOKE のため、2 回続けて適用してもエラーにならない。
-- ロック: DROP POLICY は family_invites に ACCESS EXCLUSIVE を取る。招待の表は小さく、長い処理が走っていなければ一瞬で終わる。
-- 確認: tests/integration/rls/family-invites-rpc-only-writes.test.ts (実 DB)
--       tests/family-invites-rpc-only-writes-migration-contract.test.ts (静的)

-- 表のロックを長く待たない (待ちが続いたら失敗させて流し直す。20261022130000 と同じ)
SET LOCAL lock_timeout = '10s';

-- 1. 書き込みのポリシー
DROP POLICY IF EXISTS family_invites_insert_adult ON public.family_invites;
DROP POLICY IF EXISTS family_invites_update_adult ON public.family_invites;

-- 2. 書き込みの権限
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.family_invites FROM anon, authenticated;
