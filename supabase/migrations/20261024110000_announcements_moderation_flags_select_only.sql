-- migration: 20261024110000_announcements_moderation_flags_select_only.sql
-- 戻し方: supabase/rollbacks/20261024110000_announcements_moderation_flags_select_only.down.sql
-- #1917 の続き: 運営 (admin / super_admin) が PostgREST の直接の書き込みで announcements (お知らせ) と moderation_flags (食事の通報)
-- の行を INSERT / UPDATE / DELETE でき、recipe_flags (レシピの通報) の行を UPDATE でき、運営の API と監査ログ (admin_audit_logs) を
-- 通らずに済んでしまう既存の欠陥を直す。
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
--   TRUNCATE は 20261022190000_db_privilege_hardening.sql が anon / authenticated から外してある。
--   これより後の migration に、3 つの表のポリシー・権限を変えるものは無い。
--
--   3 つの表を読む・書く経路 (origin/main で git grep した):
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
--     3 つとも:
--     - 退会: announcements.created_by (20261010000100_auth_users_fk_on_delete.sql:238)・moderation_flags.resolved_by (:292)・
--       recipe_flags.reporter_id / reviewed_by (:318・:323) は ON DELETE SET NULL。外部キーの動作は表の所有者の権限で動き、RLS も当たらない
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
--   運営の MFA の判定を持つポリシーの数 (tests/integration/security/operator-mfa-db-gate.test.ts の番兵) は 1 本減る
--   (1・2 は表ごとに 1 本を消して 1 本を作る。4 は 1 本を消すだけ)。番兵の DB_GATED_POLICY_MIN_COUNT を 56 から 55 にした。
--
-- 同じ型の全域の探索 (運営のロールで判定する FOR ALL のポリシーの残り。直さないものと理由):
--   - 運営のロールで判定する書き込みのポリシーのうち、運営の API が service_role で書いていて本人のセッションの client で書く
--     経路が無い表は、announcements・moderation_flags・recipe_flags の 3 つで、本冊でまとめて直す (recipe_flags は FOR UPDATE)。
--   - 運営の API が本人のセッションの client でそのポリシーに頼って書いている表 (coupons・experiments・feature_flags・
--     feature_packages・subscription_plans・system_settings・sales_leads・sales_lead_activities・admin_user_notes・departments・
--     organization_challenges) は、ポリシーを絞ると API が書けなくなるので、API を service_role に移す変更と一緒に別の案件で直す。
--   - 運営が書く API が無い表 (help_articles・infra_alerts・email_blacklist・plan_store_products・sport_presets・
--     organization_reports・csat_feedbacks) は「API を通らない書き込み」の型に当たらない (通るべき API が無い)。
--
-- 既存データへの影響: なし (ポリシーと権限だけの変更。行は消さない・変えない)。
-- 冪等: DROP POLICY IF EXISTS と REVOKE のため、2 回続けて適用してもエラーにならない。
-- ロック: DROP / CREATE POLICY は表に ACCESS EXCLUSIVE を取る。3 つの表は小さく、一瞬で終わる。
-- 確認: tests/integration/rls/announcements-moderation-flags-select-only.test.ts (実 DB)
--       tests/announcements-moderation-flags-select-only-migration-contract.test.ts (静的)
--       tests/integration/rls/coupon-experiment-recipe-flags-rls.test.ts の recipe_flags の段 (実 DB)

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
