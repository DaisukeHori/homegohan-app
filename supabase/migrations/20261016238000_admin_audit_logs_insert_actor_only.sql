-- migration: 20261016238000_admin_audit_logs_insert_actor_only.sql
-- #1736: admin_audit_logs の INSERT のポリシーを 1 本にし、actor と action_type を DB で縛る
--
-- 背景 (本番の現状: supabase/baseline/catalog/catalog_policies.csv の INSERT ポリシー。どちらも roles=public・PERMISSIVE):
--   permissive ポリシーは OR で合成されるため、実際に効くのは 2 本の和集合になる。
--     "Admins can create audit logs"  WITH CHECK (本人のロールが admin / super_admin / support のどれか)
--         ← actor_id も action_type も見ない。actor_id を他人にも NULL にもできる
--           (20261007022126_org_role_tenant_scoped_org_admin.sql で org_admin を外したあとの定義)
--     "audit_logs_insert_admins"      WITH CHECK (actor_id = auth.uid() かつ 運営の 6 ロールのどれか)
--         ← action_type は見ない
--   admin_audit_logs は anon / authenticated に GRANT ALL があり (prod_table_acl.sql)、防いでいるのは RLS だけ。
--   運営のロールの人は、自分の JWT で PostgREST に INSERT を直接送れば、
--     - 他人 (別の運営者) を actor にした行・actor_id が NULL (= system) の行を作れる (前者のポリシー)
--     - system.* の行 (例: GET /api/admin/finance/reconciliation が action_type だけで読む
--       'system.stripe.reconcile_discrepancy') を作れる (どちらのポリシーでも)
--     - actor_email_snapshot / actor_role_snapshot / impersonated_by に他人を書ける
--       (super-admin の監査ログ画面は actor_email_snapshot を actor_id より優先して表示する)
--   監査ログを読んで判断する仕組みは、偽の行を信じてしまう。
--
-- 今の書き手 (2026-10-16 の main で全数を洗った結果。表は PR の説明にある):
--   - 本人の JWT (createClient()) で recordAdminAudit を呼ぶ運営の route: 56 か所の呼び出しのうち 55 か所。
--     actor_id はどれも requireRole / requireSuperAdmin が返した本人の id。
--     action_type は admin.* / super_admin.* のみ (system.* は無い)。snapshot / impersonated_by は書かない。
--   - service_role (getSupabaseAdmin()): recordMfaAudit (admin.mfa.* / super_admin.mfa.reset。recordAdminAudit の 1 か所) と、
--     課金の repository.recordAudit (user.billing.* / system.billing.* / system.payment.* / system.stripe.*。actor_id は本人か NULL)。
--   - SECURITY DEFINER (所有者 postgres): billing_apply_stripe_subscription (system.billing.*・actor_id NULL) と、
--     pg_cron の cleanup_handson_tour_sandbox_rows ('handson_tour_sandbox_cleanup'・actor_id NULL)。
--   - Edge Function・モバイル・scripts からの INSERT は無い。
--   service_role と所有者は RLS の対象外なので、ポリシーを変えても後の 2 種は今までどおり書ける。
--
-- 変更:
--   1. "Admins can create audit logs" を削除する。
--   2. "audit_logs_insert_admins" を TO authenticated で作り直し、WITH CHECK を次の全部にする:
--        a. actor_id = auth.uid()                  (他人・NULL を actor にできない。NULL = auth.uid() は NULL で通らない)
--        b. 運営の 6 ロール (admin / super_admin / support / sales / finance / content_moderator) のどれかを持つ
--        c. action_type が 'system.' で始まらない   (system.* は service_role / SECURITY DEFINER が actor_id NULL で書く予約の名前)
--        d. actor_email_snapshot / actor_role_snapshot / impersonated_by が NULL (actor の表示を他人にできない)
--   action_type を許可の一覧で持たない理由: 本人の JWT の書き手は 55 か所・40 種を超える名前を使い、route が増えるたびに
--   migration が要る形になる (一覧に無い名前は fail-open の記録が黙って落ちる)。判断に使う行 (バックアップの鮮度・DR 訓練・
--   照合の差分など) はサーバーが書く system.* の行なので、その名前空間を本人の JWT から閉じれば足りる。
--   読み取り側は、system の事実を判断に使うとき action_type に加えて actor_id IS NULL でも絞れる
--   (本人の JWT では actor_id を NULL にできないため)。
--
-- 既存の正当な利用経路への影響: なし (上の全数のとおり、本人の JWT の書き手は a〜d をすでに満たしている)。
-- 冪等: DROP POLICY IF EXISTS → CREATE POLICY のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/rls/admin-audit-logs-insert-policy.test.ts と
--       tests/admin-audit-logs-insert-policy-migration-contract.test.ts。
-- ロールバック: supabase/rollbacks/20261016238000_admin_audit_logs_insert_actor_only.down.sql

DROP POLICY IF EXISTS "Admins can create audit logs" ON "public"."admin_audit_logs";

DROP POLICY IF EXISTS "audit_logs_insert_admins" ON "public"."admin_audit_logs";
CREATE POLICY "audit_logs_insert_admins" ON "public"."admin_audit_logs"
  FOR INSERT TO authenticated
  WITH CHECK (
    "actor_id" = "auth"."uid"()
    AND "action_type" NOT LIKE 'system.%'
    AND "actor_email_snapshot" IS NULL
    AND "actor_role_snapshot" IS NULL
    AND "impersonated_by" IS NULL
    AND EXISTS (
      SELECT 1
        FROM "public"."user_profiles"
       WHERE "user_profiles"."id" = "auth"."uid"()
         AND ARRAY['admin'::text, 'super_admin'::text, 'support'::text, 'sales'::text, 'finance'::text, 'content_moderator'::text]
             && "user_profiles"."roles"
    )
  );

COMMENT ON POLICY "audit_logs_insert_admins" ON "public"."admin_audit_logs" IS
  '#1736: 本人の JWT からの INSERT は、actor_id = auth.uid()・運営の 6 ロール・action_type が system.* でない・snapshot / impersonated_by が NULL のときだけ。system.* と actor_id NULL の行は service_role / SECURITY DEFINER だけが書く';
