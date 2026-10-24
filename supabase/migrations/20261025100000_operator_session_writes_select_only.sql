-- migration: 20261025100000_operator_session_writes_select_only.sql
-- 戻し方: supabase/rollbacks/20261025100000_operator_session_writes_select_only.down.sql
-- #1917 の続き (20261024140000_announcements_moderation_flags_select_only.sql の残り): 運営 (と組織の管理者のポリシーの運営の枝) が
-- 自分のセッションの JWT で PostgREST から 17 本のポリシーの表へ直接書け、運営の API と監査ログ (admin_audit_logs) を通らずに済んで
-- しまう既存の欠陥を直す。あわせて、利用者の INSERT のポリシーが運営の判定の列を利用者に指定させる欠陥 (recipe_flags と、同じ型の
-- inquiries・support_tickets) を直す。
--
-- 背景 (1): 運営の書き込みのポリシー 17 本 (常設の台帳 tests/helpers/operator-write-policy-ledger.ts の「別の案件」(sessionClientApi) の行)
--   20261024140000 の「同じ型の全域の探索」が (2) に分けた 17 本。どれも 20261017130000_operator_mfa_db_gate.sql が TO authenticated と
--   運営の MFA の判定 (operator_mfa_satisfied()) を足しただけで、書き込みを許したまま残っていた:
--     admin_user_notes        "Admins can manage user notes"               FOR ALL     (20261017130000:377)
--     coupons                 coupons_mutate_sales_or_above                FOR ALL     (:381)
--     departments             "Org admins can manage departments"          FOR ALL     (:386。組織の owner / admin の枝と運営の枝の OR)
--     experiment_assignments  experiment_assignments_delete_super_admin    FOR DELETE  (:390)
--     experiments             experiments_select_super_admin               FOR ALL     (:392。名前は select だが FOR の無い形)
--     feature_flags           feature_flags_super_admin_all                FOR ALL     (:393)
--     feature_packages        feature_packages_mutate_super_admin          FOR ALL     (:394)
--     inquiries               "Admins can update inquiries"                FOR UPDATE  (:398)
--     organization_challenges "Org admins can manage challenges"           FOR ALL     (:405。departments と同じ形)
--     organization_invites    "Org admins can delete invites"              FOR DELETE  (20261022180000_org_tables_rpc_only_writes.sql:191。同じ形)
--     sales_lead_activities   sales_activities_access                      FOR ALL     (:417)
--     sales_leads             sales_leads_access                           FOR ALL     (:418)
--     subscription_plans      subscription_plans_mutate_super_admin        FOR ALL     (:420。価格の列を含む。価格の変更の予約・
--                                                                                       plan_price_history を通らずに価格を変えられた)
--     support_ticket_messages ticket_messages_insert                       FOR INSERT  (:421。利用者の枝と運営の枝の OR)
--     support_tickets         tickets_insert_staff                         FOR INSERT  (:423)
--     support_tickets         tickets_update_support                       FOR UPDATE  (:425)
--     system_settings         "Super admins can update system settings"    FOR ALL     (:428)
--   運営の API は、これらのポリシーに頼って本人のセッションの client で書いていた。この変更と同じ PR で、どの API も requireRole の後で
--   service_role の client (getSupabaseAdmin()) で書く形に移した (監査ログは今までどおり本人のセッションの client で書く。
--   20261024140000 の POST /api/announcements と同じ形):
--     admin_user_notes:        PATCH /api/admin/users/{id}・POST /api/support/users/{id}/notes
--     coupons:                 POST /api/super-admin/coupons・PATCH / DELETE /api/super-admin/coupons/{id}
--     experiments・experiment_assignments: POST /api/super-admin/experiments・PATCH / DELETE /api/super-admin/experiments/{id}
--     feature_flags:           POST /api/super-admin/flags・PATCH / DELETE /api/super-admin/flags/{key}
--     feature_packages:        POST /api/super-admin/feature-packages・PATCH / DELETE /api/super-admin/feature-packages/{id}・
--                              POST /api/super-admin/flags (basic のパッケージにキーを足す)
--     inquiries:               PATCH / PUT /api/admin/inquiries/{id}
--     sales_leads・sales_lead_activities: POST /api/admin/sales/leads・PATCH /api/admin/sales/leads/{id}・
--                              POST /api/admin/sales/leads/{id}/activities
--     subscription_plans:      POST /api/super-admin/plans・PATCH / DELETE /api/super-admin/plans/{id} (価格の変更は以前から
--                              service_role で SECURITY DEFINER の関数 begin_plan_price_change / apply_plan_price_change を呼ぶ。20261024130000)
--     support_tickets・support_ticket_messages: POST /api/admin/support/tickets・PATCH /api/admin/support/tickets/{id}・
--                              POST /api/admin/support/tickets/{id}/assign・POST /api/admin/support/tickets/{id}/messages
--     system_settings:         PUT /api/super-admin/settings
--   どの API も、requireRole の許すロールはポリシーのロールと同じか狭い (広げていない)。運営の MFA は requireRole が
--   AAL2 を求める (src/lib/auth/helpers.ts の requireRole → assertOperatorAssurance。必須ロールは DB の operator_mfa_satisfied() と同じ 4 つ)。
--   組織の 3 本 (departments・organization_challenges・organization_invites) の書き手は /api/org/departments・/api/org/challenges・
--   /api/org/invites で、どれも requireOrgAdmin() (org_role が owner / admin) を通った組織の管理者が本人のセッションで書く。運営が
--   これらの API を運営として通る枝は無い (requireOrgAdmin は user_profiles.roles を見ない。#1235) ので、運営の枝だけを外し、組織の
--   管理者の枝はそのまま残す。support_ticket_messages も同じで、利用者が自分のチケットに書く枝 (is_internal でない) は残す
--   (アプリにいま利用者のセッションでチケットやメッセージを書く経路は無いが、本人が自分の名前で書くことは運営の API を迂回する
--   書き込みではないので変えない)。
--
-- 背景 (2): 利用者の INSERT が運営の判定の列を指定できる (P9 と、同じ型の全域の探索)
--   recipe_flags の "Anyone can create recipe flags" (ベースライン 20251126124224_create_meal_planner_tables.sql:9594。FOR INSERT・
--   TO authenticated) は WITH CHECK が reporter_id = auth.uid() だけで、利用者は判定済みの status や、reviewed_by に他人 (運営) の id、
--   reviewed_at を入れた通報を作れた。20261024140000 は利用者の INSERT を残し、anon の INSERT の権限だけを外した。
--   同じ型 (利用者の INSERT のポリシーが、運営が判定・対応で書く列を利用者に指定させる) を public の全部の表で探した
--   (運営が書く列 = reviewed_* / resolved_* / approved_by / assignee_id / admin_notes / status を持つ表の、利用者に INSERT を許すポリシー):
--     - inquiries の "Anyone can create inquiries" (ベースライン :9590。FOR INSERT・TO authenticated, anon・WITH CHECK (true)):
--       status (対応の状態)・admin_notes (運営のメモ)・resolved_at を指定でき、user_id に他人の id も入れられた (他人の問い合わせの
--       履歴 (GET /api/contact と "Users can view own inquiries") に、本人の書いていない問い合わせを混ぜられた)。
--       書く経路は POST /api/contact (src/app/api/contact/route.ts) だけで、本人のセッション (未ログインなら anon) で
--       user_id = 本人か NULL・status = 'pending' を書く。
--     - support_tickets の tickets_insert_user (ベースライン :10979。FOR INSERT・TO なし = public・WITH CHECK (user_id = auth.uid())):
--       status・assignee_id (担当の運営)・first_response_at・resolved_at・closed_at を指定できた。アプリに利用者のセッションで
--       チケットを作る経路は無い (チケットは運営が POST /api/admin/support/tickets で作る)。
--     - coupon_redemptions (approved_by)・family_promotion_requests / ownership_transfer_proposals (resolved_*)・moderation_flags は、
--       利用者に INSERT を許すポリシーが無い (書くのは SECURITY DEFINER の関数か service_role だけ)。infra_alerts は運営だけの表。
--
-- 変更:
--   1. 運営だけが書く表 (admin_user_notes・coupons・experiments・experiment_assignments・feature_flags・feature_packages・
--      sales_leads・sales_lead_activities・subscription_plans・system_settings) の運営の書き込みのポリシーを消す。運営の SELECT が
--      その書き込みのポリシー (FOR ALL) にしか無い表は、同じ式の SELECT だけのポリシーを作る:
--        admin_user_notes        → "Admins can view user notes"            (USING は 20261017130000:377 のまま)
--        experiments             → experiments_select_super_admin を FOR SELECT で作り直す (:392 のまま。名前どおりの SELECT にする)
--        feature_flags           → feature_flags_select_super_admin        (:393 の USING のまま)
--        feature_packages        → feature_packages_select_super_admin     (:394 のまま。運営の画面は active 以外も読む。
--                                                                            利用者の feature_packages_select_authenticated は残す)
--        sales_lead_activities   → sales_activities_select                 (:417 のまま)
--        sales_leads             → sales_leads_select                      (:418 のまま)
--      coupons (coupons_select_sales_or_above)・subscription_plans (subscription_plans_select_public・subscription_plans_select_operator)・
--      system_settings ("Admins can view system settings")・experiment_assignments (experiment_assignments_select_super_admin) は、
--      運営の SELECT のポリシーをもともと持ち、消すポリシーのロールを含むので、作らない。
--      SELECT のポリシーは WITH CHECK を持てないので WITH CHECK は落とす。
--   2. inquiries の "Admins can update inquiries" と、support_tickets の tickets_insert_staff・tickets_update_support を消す
--      (運営の SELECT は "Admins can view all inquiries"・tickets_select がもともと持つ)。
--   3. 組織の 3 本と support_ticket_messages の ticket_messages_insert は、運営の枝 (user_profiles.roles の運営ロールと
--      operator_mfa_satisfied()) だけを外す (ALTER POLICY。名前・種類・TO はそのまま):
--        departments / organization_challenges / organization_invites: 本人の所属組織の行で、org_role が owner / admin のときだけ
--        support_ticket_messages: sender_id = 本人・is_internal でない・本人のチケットのときだけ
--   4. 利用者の INSERT のポリシー 3 本に、運営の判定の列を指定させない条件を足す (ALTER POLICY。名前・種類はそのまま):
--        recipe_flags "Anyone can create recipe flags": status = 'pending'・reviewed_by と reviewed_at は NULL
--          (status の既定は 'pending'。列を書かない INSERT はそのまま通る)
--        inquiries "Anyone can create inquiries": status = 'pending'・admin_notes と resolved_at は NULL・user_id は NULL か本人
--          (status の既定は 'pending'。POST /api/contact が書く行はそのまま通る)
--        support_tickets tickets_insert_user: TO authenticated にし、status = 'open'・assignee_id・first_response_at・resolved_at・
--          closed_at は NULL (status の既定は 'open')。priority (low〜urgent) と category は利用者が選ぶ項目として残す
--   5. 書き込みの権限:
--      - 1. の 10 表は INSERT / UPDATE / DELETE を anon と authenticated から外す (書き込みを許すポリシーが 1 本も無くなる)。
--      - inquiries は UPDATE / DELETE を anon と authenticated から外す (INSERT は問い合わせの送信のために両方に残す)。
--      - support_tickets・support_ticket_messages は UPDATE / DELETE を anon と authenticated から、INSERT を anon から外す
--        (authenticated の INSERT は本人の枝のために残す。anon には auth.uid() が無く、もともと本人の枝に当たらない)。
--      - departments・organization_challenges は INSERT / UPDATE / DELETE を anon から外す (組織の管理者は authenticated。
--        organization_invites は 20261022180000 が外してある)。
--      ポリシーを消すだけでも INSERT は 42501 になるが、UPDATE / DELETE は 0 行で黙って終わる。権限を外すと 42501 で止まり、
--      後で誰かが書き込みのポリシーを足しても開かない (二重に閉じる。20261024140000 と同じ)。
--      SELECT・REFERENCES・TRIGGER・MAINTAIN と service_role の権限は変えない。TRUNCATE は 20261022190000_db_privilege_hardening.sql が
--      anon / authenticated から外してある。
--   運営の MFA の判定を持つポリシーの数 (tests/integration/security/operator-mfa-db-gate.test.ts の番兵) は 11 本減る (1. の SELECT を
--   作り直す 6 表は 1 本を消して 1 本を作るので変わらない。1. の残り 4 本・2. の 3 本・3. の 4 本が減る)。番兵の
--   DB_GATED_POLICY_MIN_COUNT を 53 から 42 にした。
--
--   これらの表を読む・書くほかの経路 (origin/main で git grep した):
--     - DB の関数: これらの表に INSERT / UPDATE / DELETE する関数は、どれも SECURITY DEFINER (所有者の権限で書くのでこの変更の
--       影響を受けない): apply_coupon (coupons。20261007160700)・apply_plan_price_change (subscription_plans。20261024130000)・
--       update_org_challenge_progress (organization_challenges。20261014100100)・組織の招待の RPC (organization_invites。
--       20261022180000 ほか)・prepare_account_deletion (inquiries・organization_invites。20261016234000)。
--     - 実験の割り当て (src/lib/experiments/assignment.ts) と機能フラグの判定 (src/lib/super-admin/evaluate-flag.ts・
--       supabase/functions/_shared/ai-chat-flag.ts)・プランの写像 (src/lib/billing/**・supabase/functions/stripe-price-sync) は
--       service_role で読み書きする。Web・モバイル (apps/mobile)・Edge Function は、利用者のセッションでこれらの表を書かない
--       (POST /api/contact の inquiries の INSERT と、組織の管理者の /api/org/** を除く)。
--     - 退会の外部キー (20261010000100_auth_users_fk_on_delete.sql) は表の所有者の権限で動き、RLS も当たらない。
--     - e2e・結合テストの準備と後片付けは service_role の鍵か postgres で書く。
--
-- 同じ型の全域の探索 (運営のロールで判定する、書き込みを許すポリシー):
--   本冊の直前にこの型に当たるのは 26 本 (常設の台帳 tests/helpers/operator-write-policy-ledger.ts の全行)。本冊は「別の案件」の
--   17 本をすべてこの型から外し、残りは「運営が書く API が無い」8 本と「監査ログそのもの」1 本の 9 本になる (台帳から 17 行を消した。
--   分類「別の案件」は行が無くなったので台帳から外した)。tests/operator-write-policy-ledger.test.ts (migration の文面) と
--   tests/integration/rls/operator-write-policy-ledger.test.ts (実 DB) が台帳との一致を見る。
--
-- 既存データへの影響: なし (ポリシーと権限だけの変更。行は消さない・変えない)。今ある行が 4. の条件に当たらなくても、
-- WITH CHECK は INSERT の新しい行にだけ当たるので、既存の行は読める・運営の画面で扱える。
-- 冪等: DROP POLICY IF EXISTS → CREATE POLICY・ALTER POLICY (同じ式に何度でも)・REVOKE のため、2 回続けて適用してもエラーにならない。
-- ロック: DROP / CREATE / ALTER POLICY は表に ACCESS EXCLUSIVE を取る。どの表も小さく、一瞬で終わる。
-- 確認: tests/integration/rls/operator-session-writes-select-only.test.ts (実 DB)
--       tests/operator-session-writes-select-only-migration-contract.test.ts (静的)
--       tests/operator-write-policy-ledger.test.ts (静的)・tests/integration/rls/operator-write-policy-ledger.test.ts (実 DB) (同じ型の台帳)

-- 表のロックを長く待たない (待ちが続いたら失敗させて流し直す。20261024140000 と同じ)
SET LOCAL lock_timeout = '10s';

-- 1. 運営だけが書く表の運営の書き込みのポリシーを消し、運営の SELECT がそこにしか無い表は SELECT だけのポリシーを作る
DROP POLICY IF EXISTS "Admins can manage user notes" ON public.admin_user_notes;
DROP POLICY IF EXISTS "Admins can view user notes" ON public.admin_user_notes;
CREATE POLICY "Admins can view user notes" ON public.admin_user_notes FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((user_profiles.roles && ARRAY['admin'::text, 'super_admin'::text, 'support'::text]) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS coupons_mutate_sales_or_above ON public.coupons;

DROP POLICY IF EXISTS experiment_assignments_delete_super_admin ON public.experiment_assignments;

DROP POLICY IF EXISTS experiments_select_super_admin ON public.experiments;
CREATE POLICY experiments_select_super_admin ON public.experiments FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS feature_flags_super_admin_all ON public.feature_flags;
DROP POLICY IF EXISTS feature_flags_select_super_admin ON public.feature_flags;
CREATE POLICY feature_flags_select_super_admin ON public.feature_flags FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS feature_packages_mutate_super_admin ON public.feature_packages;
DROP POLICY IF EXISTS feature_packages_select_super_admin ON public.feature_packages;
CREATE POLICY feature_packages_select_super_admin ON public.feature_packages FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND (('super_admin'::text = ANY (user_profiles.roles)) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS sales_activities_access ON public.sales_lead_activities;
DROP POLICY IF EXISTS sales_activities_select ON public.sales_lead_activities;
CREATE POLICY sales_activities_select ON public.sales_lead_activities FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS sales_leads_access ON public.sales_leads;
DROP POLICY IF EXISTS sales_leads_select ON public.sales_leads;
CREATE POLICY sales_leads_select ON public.sales_leads FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles WHERE ((user_profiles.id = auth.uid()) AND ((ARRAY['sales'::text, 'admin'::text, 'super_admin'::text] && user_profiles.roles) AND (SELECT public.operator_mfa_satisfied()))))));

DROP POLICY IF EXISTS subscription_plans_mutate_super_admin ON public.subscription_plans;

DROP POLICY IF EXISTS "Super admins can update system settings" ON public.system_settings;

-- 2. 問い合わせとチケットの運営の書き込みのポリシーを消す (運営の SELECT は残る)
DROP POLICY IF EXISTS "Admins can update inquiries" ON public.inquiries;
DROP POLICY IF EXISTS tickets_insert_staff ON public.support_tickets;
DROP POLICY IF EXISTS tickets_update_support ON public.support_tickets;

-- 3. 組織の管理者・利用者の枝と OR になっている運営の枝だけを外す
ALTER POLICY "Org admins can manage departments" ON public.departments TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = departments.organization_id) AND (up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum]))))));
ALTER POLICY "Org admins can manage challenges" ON public.organization_challenges TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_challenges.organization_id) AND (up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum]))))));
ALTER POLICY "Org admins can delete invites" ON public.organization_invites TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_invites.organization_id) AND (up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum]))))));
ALTER POLICY ticket_messages_insert ON public.support_ticket_messages TO authenticated WITH CHECK (((sender_id = auth.uid()) AND (NOT is_internal) AND (EXISTS ( SELECT 1 FROM support_tickets t WHERE ((t.id = support_ticket_messages.ticket_id) AND (t.user_id = auth.uid()))))));

-- 4. 利用者の INSERT に、運営の判定の列を指定させない
ALTER POLICY "Anyone can create recipe flags" ON public.recipe_flags WITH CHECK (((reporter_id = auth.uid()) AND (status = 'pending'::text) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL)));
ALTER POLICY "Anyone can create inquiries" ON public.inquiries WITH CHECK (((status = 'pending'::text) AND (admin_notes IS NULL) AND (resolved_at IS NULL) AND ((user_id IS NULL) OR (user_id = auth.uid()))));
ALTER POLICY tickets_insert_user ON public.support_tickets TO authenticated WITH CHECK (((user_id = auth.uid()) AND ((status)::text = 'open'::text) AND (assignee_id IS NULL) AND (first_response_at IS NULL) AND (resolved_at IS NULL) AND (closed_at IS NULL)));

-- 5. 書き込みの権限
REVOKE INSERT, UPDATE, DELETE ON TABLE public.admin_user_notes FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.coupons FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.experiment_assignments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.experiments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.feature_flags FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.feature_packages FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sales_lead_activities FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sales_leads FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.subscription_plans FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.system_settings FROM anon, authenticated;
REVOKE UPDATE, DELETE ON TABLE public.inquiries FROM anon, authenticated;
REVOKE UPDATE, DELETE ON TABLE public.support_tickets FROM anon, authenticated;
REVOKE INSERT ON TABLE public.support_tickets FROM anon;
REVOKE UPDATE, DELETE ON TABLE public.support_ticket_messages FROM anon, authenticated;
REVOKE INSERT ON TABLE public.support_ticket_messages FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.departments FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.organization_challenges FROM anon;
