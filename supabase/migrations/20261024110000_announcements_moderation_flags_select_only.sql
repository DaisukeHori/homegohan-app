-- migration: 20261024110000_announcements_moderation_flags_select_only.sql
-- 戻し方: supabase/rollbacks/20261024110000_announcements_moderation_flags_select_only.down.sql
-- #1917 の続き: 運営 (admin / super_admin) が PostgREST の直接の書き込みで announcements (お知らせ) と moderation_flags (食事の通報)
-- の行を INSERT / UPDATE / DELETE でき、recipe_flags (レシピの通報) の行を UPDATE でき、personal_subscriptions (個人の契約) の行を
-- INSERT / UPDATE でき、運営の API と監査ログ (admin_audit_logs) を通らずに済んでしまう既存の欠陥を直す。
--
-- 背景:
--   (A) announcements: 本番のベースライン (20251126124224_create_meal_planner_tables.sql) の
--         :9518  "Admins can manage announcements"  FOR の無い形 (= FOR ALL)・TO public・roles が admin / super_admin
--         :9675  "Public announcements are viewable by everyone"  FOR SELECT・TO public・is_public = true
--       と、:13460-13461 の anon / authenticated への INSERT / SELECT / UPDATE / DELETE の権限により、運営は自分のセッションの
--       JWT で PostgREST からお知らせを直接書けた。20261017130000_operator_mfa_db_gate.sql:379 は TO authenticated と運営の MFA の
--       判定 (operator_mfa_satisfied()) を足しただけで、FOR ALL のまま。お知らせを書く入口は POST /api/announcements
--       (src/app/api/announcements/route.ts) だけで、そこが監査 admin.announcement.create を 1 行残す (#1571)。直接の書き込みは
--       その監査を通らない (公開・非公開の切り替えや、公開済みのお知らせの書き換え・削除が記録に残らない)。
--   (B) moderation_flags: ベースラインの :10605 "moderation_flags_admin_all" (FOR ALL・TO public・roles が admin / super_admin) と
--       :13726-13727 の権限により、同じく運営は通報の行を直接書けた。20261017130000:402 は TO authenticated と MFA の判定を
--       足しただけ。通報の判定・戻す操作は運営の API (PATCH /api/admin/moderation/{type}/{id}・
--       POST /api/admin/moderation/{type}/{id}/restore) が service_role の client で書き、監査を残す。直接の書き込みは
--       通報の状態 (approved / rejected) を、監査も非表示・BAN の手順も通らずに変えられた。
--   (C) recipe_flags: ベースラインの :9536 "Admins can update recipe flags" (FOR UPDATE・TO public・roles が admin / super_admin) と
--       :13814-13815 の anon / authenticated への INSERT / SELECT / UPDATE / DELETE の権限により、運営は通報の行 (status・reviewed_by・
--       reviewed_at) を直接書き換えられた。20261017130000:413 は TO authenticated と MFA の判定を足しただけ。通報の判定・戻す操作は
--       (B) と同じ運営の API が service_role の client で書き、監査を残す (src/lib/admin/moderation-backend.ts の resolveModerationItem・
--       src/lib/admin/hidden-content-restore.ts の approveRejectedFlagsOfContent)。直接の書き込みは (B) と同じく監査も非表示・BAN の手順も通らない。
--       ほかのポリシーは :9594 "Anyone can create recipe flags" (FOR INSERT・TO authenticated・reporter_id = auth.uid()。利用者の通報) と
--       :9713 "Users and admins can view recipe flags" (FOR SELECT。本人と運営) で、DELETE のポリシーはもともと無い。
--   (D) personal_subscriptions: 20261016210000_billing_core.sql:51 "personal_subscriptions_insert_admin" (FOR INSERT) と
--       :55 "personal_subscriptions_update_admin" (FOR UPDATE。どちらも roles が admin / super_admin) と、ベースラインの
--       :13790-13791 の anon / authenticated への INSERT / SELECT / UPDATE / DELETE の権限 (anon の INSERT / UPDATE / DELETE は
--       20261016210000:63 が外した) により、運営は契約の行を直接作り・書き換えられた。20261017130000:409・:411 は TO authenticated と
--       MFA の判定を足しただけ。契約を書く入口は、運営の手動付与 (POST / DELETE /api/super-admin/users/{id}/manual-plan。監査
--       admin.billing.manual_grant / manual_revoke) と Stripe・ストアの写像・クーポンの適用で、どれも service_role の client で
--       SECURITY DEFINER の関数 (billing_grant_manual_subscription など) を呼ぶ。直接の書き込みは監査も、関数の不変条件 (利用者ごとの
--       ロックの順・live な行の衝突の判定 BILL_LIVE_ROW_CONFLICT・plan_key_cached と family_groups の同期) も通らずに、有料のプランを
--       与え・変えられた (docs/design/billing/02-manual-plan-grant.md §16 の 2 の「残すか」。推奨は消す側)。
--       ほかのポリシーはベースラインの :10743 "personal_subscriptions_no_delete" (FOR DELETE USING (false)) と :10747
--       "personal_subscriptions_select" (FOR SELECT。本人と運営 (admin / super_admin / finance / support)) で、どちらも残す。
--   TRUNCATE は 20261022190000_db_privilege_hardening.sql が anon / authenticated から外してある。
--   これより後の migration に、4 つの表のポリシー・権限を変えるものは無い。
--
--   4 つの表を読む・書く経路 (origin/main で git grep した):
--     announcements:
--     - 作成: POST /api/announcements (admin / super_admin。requireRole の後で書く)。この変更で INSERT は service_role の client
--       (getSupabaseAdmin()) で書き、監査は今までどおり本人のセッションの client で書く (src/app/api/admin/organizations/route.ts の
--       POST と同じ形)
--     - 管理用の一覧: GET /api/announcements (mode=public 以外。admin / super_admin) は本人のセッションの client で非公開の行まで
--       読む。運営の SELECT のポリシー (下の 1) が要る
--     - 公開の一覧: GET /api/announcements?mode=public・Web のホーム (src/hooks/useHomeData.ts)・アプリのホーム
--       (apps/mobile/src/hooks/useHomeData.ts) は、公開済みの行を "Public announcements are viewable by everyone" で読む
--     - 更新・削除の API は無い。Web・モバイル・Edge Function (supabase/functions) は、利用者のセッションで announcements を
--       INSERT / UPDATE / DELETE しない
--     moderation_flags:
--     - 運営の画面の読み書き (src/app/api/admin/moderation/**・src/lib/admin/moderation-backend.ts・
--       src/lib/admin/hidden-content-restore.ts) は、どれも requireRole の後で service_role の client で読み書きする
--       (content_moderator は運営のポリシーに当たらないため。#1041)。本人のセッションの client で moderation_flags に触れる経路は無い
--     - 利用者が通報の行を書くポリシーはもともと無い。Edge Function の後片付け (supabase/functions/_shared/hidden-content-purge.ts) は
--       service_role で動き、通報は外部キーの CASCADE で消える
--     recipe_flags:
--     - 運営の画面の読み書きは moderation_flags と同じファイル・同じ関数 (moderation-backend.ts の backingTable() で表を選ぶ・
--       hidden-content-restore.ts の MODERATION_FLAG_TABLE_OF) で、requireRole の後の service_role の client で読み書きする。
--       本人のセッションの client で recipe_flags を UPDATE / DELETE する経路は無い
--     - 利用者の通報 (INSERT) は "Anyone can create recipe flags" のまま残す (authenticated の INSERT の権限も残す)。
--       アプリにいま利用者のセッションで recipe_flags に INSERT する経路は無いが、利用者が自分の名前で通報を作ることは
--       運営の API を迂回する書き込みではないので、本冊では変えない
--     personal_subscriptions:
--     - 書くのは SECURITY DEFINER の関数だけで、どれも EXECUTE は service_role だけ: 写像 billing_apply_stripe_subscription
--       (20261016210000)・billing_apply_store_subscription (20261021100000)・手動付与 billing_grant_manual_subscription・
--       取り消し billing_revoke_manual_subscription・期限切れ billing_expire_manual_subscription_for_user (20261017230000・
--       20261021100000)・クーポンの適用 apply_coupon (20261007160700)。関数は所有者 (postgres) の権限で書くので、この変更の影響を受けない。
--       日次のプロシージャ billing_expire_manual_subscriptions は pg_cron (postgres) が呼び、利用者ごとに上の関数を呼ぶだけ
--     - アプリ (src・apps/mobile・supabase/functions) は、どのセッションでも .from('personal_subscriptions') で INSERT / UPDATE /
--       UPSERT / DELETE しない (src/lib/billing/manual-grant-repository.ts・repository.ts・iap-repository.ts は getSupabaseAdmin() で
--       関数を呼ぶ)。読むのは本人 (利用者の画面・書き出し) と運営 (運営の画面) のセッションで、SELECT のポリシーと権限は変えない
--     4 つとも:
--     - 退会: announcements.created_by (20261010000100_auth_users_fk_on_delete.sql:238)・moderation_flags.resolved_by (:292)・
--       recipe_flags.reporter_id / reviewed_by (:318・:323) は ON DELETE SET NULL、personal_subscriptions.user_id
--       (ベースライン :9223) は ON DELETE CASCADE。外部キーの動作は表の所有者の権限で動き、RLS も当たらない
--     - e2e・結合テストの準備と後片付けは service_role の鍵か postgres で書く
--
-- 変更 (20261022180000_org_tables_rpc_only_writes.sql の organization_invites と同じ形):
--   1. FOR ALL の "Admins can manage announcements" を消し、SELECT だけの "Admins can view announcements" に作り直す
--      (式と TO authenticated は 20261017130000:379 のまま。運営の MFA の判定も同じ)。公開の
--      "Public announcements are viewable by everyone" は残す。
--   2. FOR ALL の moderation_flags_admin_all を消し、SELECT だけの moderation_flags_admin_select に作り直す
--      (USING の式と TO authenticated は 20261017130000:402 のまま。SELECT のポリシーは WITH CHECK を持てないので WITH CHECK は落とす)。
--      これで 2 つの表に INSERT / UPDATE / DELETE を許すポリシーが 1 本も無くなる。
--   3. 書き込みの権限 INSERT / UPDATE / DELETE を、2 つの表とも anon と authenticated から外す。ポリシーを消すだけでも INSERT は
--      42501 になるが、UPDATE / DELETE は 0 行で黙って終わる。権限を外すと INSERT・UPDATE・DELETE は 42501 (permission denied) で
--      止まり、後で誰かが書き込みのポリシーを足しても開かない (二重に閉じる)。
--      SELECT・REFERENCES・TRIGGER・MAINTAIN と service_role の権限は変えない。
--   4. recipe_flags の運営の "Admins can update recipe flags" (FOR UPDATE) を消す (作り直さない。運営の SELECT は
--      "Users and admins can view recipe flags" がもともと持っている)。利用者の INSERT と SELECT のポリシーは残す。
--      これで recipe_flags に UPDATE / DELETE を許すポリシーが 1 本も無くなる。
--   5. recipe_flags の書き込みの権限: UPDATE / DELETE を anon と authenticated から外し、INSERT を anon から外す
--      (anon の INSERT を許すポリシーはもともと無い)。authenticated の INSERT は利用者の通報のために残す。
--      SELECT・REFERENCES・TRIGGER・MAINTAIN と service_role の権限は変えない。
--   6. personal_subscriptions の運営の personal_subscriptions_insert_admin (FOR INSERT) と personal_subscriptions_update_admin
--      (FOR UPDATE) を消す (作り直さない。運営の SELECT は personal_subscriptions_select がもともと持っている)。
--      本人と運営の SELECT と、DELETE の禁止 (personal_subscriptions_no_delete) は残す。
--      これで personal_subscriptions に INSERT / UPDATE を許すポリシーが 1 本も無くなる (DELETE は常に偽のポリシーだけ)。
--   7. personal_subscriptions の書き込みの権限 INSERT / UPDATE / DELETE を anon と authenticated から外す (anon の分は
--      20261016210000:63 が外してあり、ここでは何も変わらない。3. と同じ形にそろえる)。本人の UPDATE / DELETE も、今までの
--      0 行で黙って終わる形から 42501 で止まる形になる。SELECT・REFERENCES・TRIGGER・MAINTAIN と service_role の権限は変えない。
--   運営の MFA の判定を持つポリシーの数 (tests/integration/security/operator-mfa-db-gate.test.ts の番兵) は 3 本減る
--   (1・2 は表ごとに 1 本を消して 1 本を作る。4 は 1 本、6 は 2 本を消すだけ)。番兵の DB_GATED_POLICY_MIN_COUNT を 56 から 53 にした。
--
-- 同じ型の全域の探索:
--   型 = 運営のロール (user_profiles.roles の運営ロールの文字列) で判定する、書き込みを許すポリシー (FOR ALL / INSERT / UPDATE / DELETE)。
--   本冊の直前の public のポリシーのうち、この型に当たるのは 31 本 (migration を version 順に流した状態から機械で数えた。
--   台帳 = tests/helpers/operator-write-policy-sweep.ts の OPERATOR_WRITE_POLICY_SWEEP。
--   tests/announcements-moderation-flags-select-only-migration-contract.test.ts が、migration の文面から作った一覧と台帳の一致と、
--   この節が台帳のすべての表を名指しすることを見る。後の migration がこの型のポリシーを足すとその test が赤になり、台帳での分類を求める)。
--   (1) 本冊が消した (運営の API が service_role の client か SECURITY DEFINER の関数で書き、本人のセッションの client でそのポリシーに
--       頼って書く経路が無い) — 5 本: announcements (ALL)・moderation_flags (ALL)・recipe_flags (UPDATE)・
--       personal_subscriptions (INSERT・UPDATE)。
--   (2) 別の案件 (運営や組織の管理者の API が本人のセッションの client でそのポリシーに頼って書く。ポリシーを絞ると API が書けなく
--       なるので、API を service_role に移す変更と一緒に直す) — 17 本: coupons・experiments・experiment_assignments (DELETE。
--       src/app/api/super-admin/experiments/[id]/route.ts の DELETE)・feature_flags・feature_packages・subscription_plans・
--       system_settings・sales_leads・sales_lead_activities・admin_user_notes・departments・organization_challenges・
--       inquiries (UPDATE。src/app/api/admin/inquiries/[id]/route.ts の PATCH)・support_tickets (INSERT・UPDATE) と
--       support_ticket_messages (INSERT。src/app/api/admin/support/tickets/**)・organization_invites (DELETE。
--       src/app/api/org/invites/route.ts の DELETE。組織の owner / admin の枝と同じポリシー)。
--   (3) 当たらない: 運営が書く API が無い (通るべき API が無い) — 8 本: help_articles・infra_alerts・email_blacklist・
--       plan_store_products・sport_presets・organization_reports・csat_feedbacks・organizations (DELETE。
--       organizations_delete_super_admin は 20261023100000_organizations_no_owner_direct_delete.sql (#1963) が残すと決めた。
--       PostgREST の DELETE は SELECT のポリシーにも当たる必要があり、所属が残る間は 23514 で止まる)。
--   (4) 当たらない: 監査ログそのもの — 1 本: admin_audit_logs の audit_logs_insert_admins (INSERT。src/lib/admin/audit.ts の
--       recordAdminAudit が本人のセッションで書く監査の記録。WITH CHECK が actor_id = 本人・system.* でないことに固定する。
--       20261017130000:375)。
--
-- 既存データへの影響: なし (ポリシーと権限だけの変更。行は消さない・変えない)。
-- 冪等: DROP POLICY IF EXISTS と REVOKE のため、2 回続けて適用してもエラーにならない。
-- ロック: DROP / CREATE POLICY は表に ACCESS EXCLUSIVE を取る。4 つの表は小さく、一瞬で終わる。
-- 確認: tests/integration/rls/announcements-moderation-flags-select-only.test.ts (実 DB)
--       tests/announcements-moderation-flags-select-only-migration-contract.test.ts (静的)
--       tests/integration/rls/coupon-experiment-recipe-flags-rls.test.ts の recipe_flags の段 (実 DB)
--       tests/integration/security/billing-personal-subscriptions-rls.test.ts の personal_subscriptions の段 (実 DB)

-- 表のロックを長く待たない (待ちが続いたら失敗させて流し直す。20261023100000 と同じ)
SET LOCAL lock_timeout = '10s';

-- 1. お知らせの運営のポリシーを SELECT だけにする
DROP POLICY IF EXISTS "Admins can manage announcements" ON public.announcements;
DROP POLICY IF EXISTS "Admins can view announcements" ON public.announcements;
CREATE POLICY "Admins can view announcements" ON public.announcements FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied()))))));

-- 2. 通報の運営のポリシーを SELECT だけにする
DROP POLICY IF EXISTS moderation_flags_admin_all ON public.moderation_flags;
DROP POLICY IF EXISTS moderation_flags_admin_select ON public.moderation_flags;
CREATE POLICY moderation_flags_admin_select ON public.moderation_flags FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));

-- 3. 書き込みの権限
REVOKE INSERT, UPDATE, DELETE ON TABLE public.announcements FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.moderation_flags FROM anon, authenticated;

-- 4. レシピの通報の運営の UPDATE のポリシーを消す (利用者の INSERT と、本人と運営の SELECT は残す)
DROP POLICY IF EXISTS "Admins can update recipe flags" ON public.recipe_flags;

-- 5. レシピの通報の書き込みの権限 (authenticated の INSERT は利用者の通報のために残す)
REVOKE UPDATE, DELETE ON TABLE public.recipe_flags FROM anon, authenticated;
REVOKE INSERT ON TABLE public.recipe_flags FROM anon;

-- 6. 契約の運営の INSERT / UPDATE のポリシーを消す (本人と運営の SELECT と、DELETE の禁止は残す)
DROP POLICY IF EXISTS personal_subscriptions_insert_admin ON public.personal_subscriptions;
DROP POLICY IF EXISTS personal_subscriptions_update_admin ON public.personal_subscriptions;

-- 7. 契約の書き込みの権限 (書くのは、サーバーが呼ぶ SECURITY DEFINER の関数だけ)
REVOKE INSERT, UPDATE, DELETE ON TABLE public.personal_subscriptions FROM anon, authenticated;
