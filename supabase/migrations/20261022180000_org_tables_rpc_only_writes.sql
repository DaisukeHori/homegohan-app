-- migration: 20261022180000_org_tables_rpc_only_writes.sql
-- 戻し方: supabase/rollbacks/20261022180000_org_tables_rpc_only_writes.down.sql
-- #1917: 組織の owner / admin が PostgREST の直接の書き込みで、席数 (org_license_pools) と招待 (organization_invites) の
-- RPC の門を通らずに済んでしまう既存の欠陥を直す。family_invites の直し (#1912 C36・ブランチ fix/family-invites-rls) の
-- 同じ型の全域の探索で見つかったもの。
--
-- 背景:
--   (A) org_license_pools: 本番のベースライン (20251126124224_create_meal_planner_tables.sql:10665) のポリシー
--       org_license_pools_update_admin (FOR UPDATE・TO public・同じ組織の org_role が owner / admin) と、:12785-12786 の
--       anon / authenticated への GRANT ALL により、組織の owner / admin は自分の組織の total_licenses / used_licenses を直接
--       UPDATE できた。total_licenses を NULL (上限なし) や大きな値にし、used_licenses を 0 に戻せば、create_org_invite と
--       accept_org_invite の席数の上限 (SEAT_LIMIT_EXCEEDED) を外せる。設計 docs/design/org/09-rls-policies.md §18 では UPDATE は
--       service_role だけ。アプリ (src) は利用者のセッションでこの表に書かない (書くのは src/app/api/admin/organizations/route.ts の
--       service role の INSERT だけ)。表に書く関数はどれも SECURITY DEFINER か、service_role だけが実行できる:
--         accept_org_invite・leave_org・remove_org_member・release_user_membership (SECURITY DEFINER)、
--         org_dissolve_apply (SECURITY INVOKER だが EXECUTE は service_role だけ。dissolve_org_by_owner /
--         operator_force_dissolve_org (SECURITY DEFINER) の中から所有者の権限で呼ばれる。20261019120000_self_dissolve.sql:114-115)。
--       INSERT / DELETE のポリシーはもともと無い (RLS が拒む) が、権限は付いていた。
--   (B) organization_invites: ベースラインのポリシー
--         :9632  "Org admins can manage invites" (FOR ALL。20261017130000_operator_mfa_db_gate.sql:406 で TO authenticated と運営の MFA の判定を足した)
--         :10638 org_invites_insert_admin        (FOR INSERT・TO public)
--         :10650 org_invites_update_admin        (FOR UPDATE・TO public)
--       と :11798-11799 の GRANT ALL により、組織の owner / admin は招待の行を直接 INSERT / UPDATE できた。create_org_invite の門
--       (宛先がこの組織の在籍者・持ち主なら ALREADY_IN_ORG・席数の上限 SEAT_LIMIT_EXCEEDED・24 時間の作成上限 RATE_LIMITED) を通らず、
--       invited_role = 'owner' の招待や、期限・状態を好きに書いた招待を作れた。
--       create_org_invite は SECURITY INVOKER で、それ自体がこの INSERT / UPDATE のポリシーと権限に頼っていた。
--   (C) create_org_invite の p_role は org_role_enum ('owner' を含む) をそのまま受け、'owner' を断るのは route の Zod
--       (src/schemas/membership/organization-invite.ts の CreateOrgInviteRequestBodySchema) だけだった。
--       owner / admin が RPC を直接呼べば invited_role = 'owner' の招待を作れ、承諾した人の org_role が 'owner' になる
--       (organizations.owner_id は変わらない)。
--
--   招待の行を書く経路 (origin/main で git grep した):
--     - 作成: create_org_invite (この migration で SECURITY DEFINER にする。POST /api/org/invites・POST /api/org/members が
--       src/lib/membership/org-invite.ts から呼ぶ)
--     - 承諾・拒否・取り消し: accept_org_invite / reject_org_invite / revoke_org_invite (SECURITY DEFINER)
--     - 退会の前処理: prepare_account_deletion (SECURITY DEFINER。service_role だけが実行できる)
--     - 削除: DELETE /api/org/invites (src/app/api/org/invites/route.ts) が組織の owner / admin のセッションで直接 DELETE する。
--       この経路は残す (下の 3)。招待の削除は席数・24 時間の上限を増やさない (24 時間の上限は membership_audit の
--       'invite_created' を数えるので、招待の行を消しても戻らない。20261008100000_membership_daily_send_cap.sql の冒頭)
--     - 組織の削除の外部キーの CASCADE (表の所有者の権限で動き、RLS も当たらない)
--     - e2e・結合テストの補助は service_role の鍵で書く
--
-- 変更 (20261011010000_ai_queue_service_role_writes.sql と同じ形。family_invites の直しも同じ形):
--   1. org_license_pools: 書き込みのポリシー org_license_pools_update_admin を消し、書き込みの権限
--      (INSERT / UPDATE / DELETE / TRUNCATE) を anon と authenticated から外す。SELECT のポリシー org_license_pools_select_member は残す
--      (組織の画面が席数を読む)。
--   2. create_org_invite を SECURITY DEFINER にする (search_path = public に固定。accept_org_invite と同じ)。
--      本文は 20261017160000_org_invite_same_org_member.sql の定義のまま、認可 (NOT_ORG_ADMIN) の直後に
--      「p_role が 'owner' なら INSUFFICIENT_PERMISSION (P0001)」を足しただけ。
--        - 呼び出し元の認可 (所属組織の owner / admin でなければ NOT_ORG_ADMIN) は従来から本文の最初で明示している。
--          DEFINER になっても判定は auth.uid() の行で行い、RLS には頼らない (その行の org_role と organization_id を見る)。
--        - 'owner' の判定は認可の後に置く (組織の管理者でない人には、従来どおり最初に NOT_ORG_ADMIN を返す)。
--          そのほかのエラーとその順番 (NOT_ORG_ADMIN → ALREADY_IN_ORG → SEAT_LIMIT_EXCEEDED → RATE_LIMITED)、引数・戻り値は変えない。
--          コードは既存の INSUFFICIENT_PERMISSION (src/lib/errors/membership-errors.ts。403) を使う
--          (route は Zod で 'owner' を 400 にするので、アプリからはこのコードに届かない。RPC を直接呼んだときだけ返る)。
--        - 作成の監査行は従来どおり organization_invites の AFTER INSERT のトリガー (audit_organization_invite_created) が書く
--          (auth.uid() は DEFINER の中でも呼び出し元の JWT のまま)。
--        - ロックは足さない (組織の行・user_profiles の行を取らない。所属や役割を書き換えないので、CLAUDE.md の
--          「組織 (organizations) を変える関数のロック順」の対象外。順番も変わらない)。
--        - EXECUTE の権限は今のまま (authenticated・service_role。anon と PUBLIC は 20261017210000 で外してある)。
--          CREATE OR REPLACE は権限と所有者 (postgres) を引き継ぐ。
--   3. organization_invites: 書き込みのポリシー org_invites_insert_admin / org_invites_update_admin を消す。
--      FOR ALL の "Org admins can manage invites" は、SELECT と DELETE だけの 2 本 ("Org admins can view invites" /
--      "Org admins can delete invites") に分けて作り直す (式と TO authenticated は 20261017130000:406 のまま。運営の項の
--      MFA の判定も同じ)。これで INSERT / UPDATE を許すポリシーが 1 本も無くなる。SELECT の org_invites_select_admin は残す。
--      権限は INSERT / UPDATE / TRUNCATE を anon と authenticated から外し、DELETE は anon からだけ外す
--      (authenticated の DELETE は DELETE /api/org/invites が使う。行を選ぶのは DELETE のポリシー)。
--      ポリシーを消すだけでも INSERT は 42501 になるが、UPDATE は 0 行で黙って終わる。権限を外すと INSERT・UPDATE は
--      42501 (permission denied) で止まり、後で誰かが書き込みのポリシーを足しても開かない (二重に閉じる)。
--      TRUNCATE は RLS が効かない書き込みなので一緒に外す。SELECT・REFERENCES・TRIGGER と service_role の権限は変えない。
--   SECURITY DEFINER の関数は所有者 (postgres) の権限で書くので、1 と 3 の影響を受けない。
--
-- 同じ型の全域の探索 (org_* / organization_* の残りの表。直さないものと理由):
--   - organizations: UPDATE は organizations_update_admin (owner / admin) で許すが、owner_id と status は
--     guard_organizations_privileged、plan は guard_organizations_plan_value (20261021110000) が authenticated / anon の
--     書き換えを止める。残りの列 (name・industry・employee_count・settings・連絡先・logo_url・subscription_status・
--     subscription_expires_at・dissolved_at) を見て判定する RPC の門は無い (subscription_* は画面の表示だけ)。
--     INSERT のポリシーは無い。DELETE の organizations_delete_owner は残す: 組織に所属の列が残る人 (オーナー本人を含む) が
--     いる間は、外部キー (user_profiles.organization_id ON DELETE SET NULL) が org_role を残したまま所属を空にして
--     CHECK user_profiles_org_consistency (23514) で止まる。消せるのは、所属の列を持つ人が 1 人もいない組織だけで、
--     席数・招待の門とは関わらない。
--   - departments / organization_challenges / organization_reports: owner / admin の FOR ALL のポリシーで直接書く。
--     部署とチャレンジは API (src/app/api/org/departments・src/app/api/org/challenges) が利用者のセッションで直接書く設計で、
--     迂回される RPC の門は無い (チャレンジの状態の遷移は org_challenge_guard_update などのトリガーが守る。20261016240000)。
--     organization_reports はアプリが使っていない (書く RPC も無い)。
--   - organization_challenge_participants: INSERT は "Users can join challenges" (API の参加の条件と同じ式。20261016170000)、
--     DELETE は本人の行だけ。UPDATE のポリシーは無い。
--   - organization_challenge_aggregates / organization_challenge_ranking_exclusions: anon / authenticated の権限が無い (service_role だけ)。
--   - org_daily_stats: SELECT のポリシーだけ (書き込みのポリシーが無い)。
--
-- 既存データへの影響: なし (ポリシー・権限・関数の属性と本文の置き換えだけ。直接の書き込みで作られた既存の行は消さない)。
-- 冪等: DROP POLICY IF EXISTS → CREATE POLICY・REVOKE・CREATE OR REPLACE FUNCTION のため、2 回続けて適用してもエラーにならない。
-- ロック: DROP / CREATE POLICY は 2 つの表に ACCESS EXCLUSIVE を取る。どちらも小さく、長い処理が走っていなければ一瞬で終わる。
-- 確認: tests/integration/rls/org-tables-rpc-only-writes.test.ts (実 DB)
--       tests/org-tables-rpc-only-writes-migration-contract.test.ts (静的)

-- 表のロックを長く待たない (待ちが続いたら失敗させて流し直す。20261022130000 と同じ)
SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. org_license_pools
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS org_license_pools_update_admin ON public.org_license_pools;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.org_license_pools FROM anon, authenticated;

-- ----------------------------------------------------------------
-- 2. create_org_invite (SECURITY INVOKER → SECURITY DEFINER)。本文は 20261017160000 の定義に、'owner' の判定を足しただけ
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_org_invite(
  p_organization_id UUID,
  p_email TEXT,
  p_role public.org_role_enum DEFAULT 'member',
  p_custom_message TEXT DEFAULT NULL
) RETURNS public.organization_invites
LANGUAGE plpgsql
SECURITY DEFINER  -- #1917: organization_invites の利用者の INSERT / UPDATE の権限を外したため、所有者の権限で書く
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_token TEXT;
  v_caller_org_id UUID;
  v_caller_role org_role_enum;
  v_seat_limit INT;
  v_used_seats INT;
BEGIN
  -- 呼び出し元が同 org の admin/owner か検証 (DEFINER なので RLS に頼らず、auth.uid() の行で明示的に判定する)
  SELECT organization_id, org_role INTO v_caller_org_id, v_caller_role
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_org_id IS DISTINCT FROM p_organization_id OR v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  -- #1917: 'owner' の役割の招待は作らない (承諾した人の org_role が owner になり、organizations.owner_id と食い違う)。
  -- route は Zod で断っているが、RPC を直接呼ぶ経路でも断る。認可の後に置く (管理者でない人には NOT_ORG_ADMIN を先に返す)
  IF p_role = 'owner' THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  -- #1799: 宛先がこの組織の在籍者・持ち主なら招待を作らない ('ALREADY_IN_ORG')。承諾で org_role を書き換えさせないため。
  -- 席数・24 時間の上限より前に判定する (作らない招待で上限の判定をしない)。既存の pending は取り消さない
  PERFORM public.assert_org_invite_recipient_not_in_org(p_organization_id, p_email);

  -- seat 上限チェック (org_license_pools)
  SELECT total_licenses, used_licenses INTO v_seat_limit, v_used_seats
    FROM org_license_pools WHERE organization_id = p_organization_id;

  IF v_seat_limit IS NOT NULL AND v_used_seats >= v_seat_limit THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- #1163: 24 時間の作成上限 (招待者ごと 200 / 組織ごと 500 / 同じ組織から同じ宛先へ 3)。超過は 'RATE_LIMITED'
  PERFORM public.enforce_membership_daily_cap('org_invite', p_organization_id, p_email);

  -- token 生成: gen_random_uuid() x2 → 64 文字 hex (pgcrypto 不要)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  -- 既存 pending を invalidate (revoke)
  UPDATE organization_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE organization_id = p_organization_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO organization_invites (
    organization_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_organization_id, lower(p_email), v_token, p_role, p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  RETURN v_invite;
END $$;

-- ----------------------------------------------------------------
-- 3. organization_invites
-- ----------------------------------------------------------------
DROP POLICY IF EXISTS org_invites_insert_admin ON public.organization_invites;
DROP POLICY IF EXISTS org_invites_update_admin ON public.organization_invites;

-- FOR ALL を SELECT と DELETE の 2 本に分ける (式と TO は 20261017130000_operator_mfa_db_gate.sql:406 のまま)
DROP POLICY IF EXISTS "Org admins can manage invites" ON public.organization_invites;

DROP POLICY IF EXISTS "Org admins can view invites" ON public.organization_invites;
CREATE POLICY "Org admins can view invites" ON public.organization_invites FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_invites.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));

DROP POLICY IF EXISTS "Org admins can delete invites" ON public.organization_invites;
CREATE POLICY "Org admins can delete invites" ON public.organization_invites FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1 FROM user_profiles up WHERE ((up.id = auth.uid()) AND (up.organization_id = organization_invites.organization_id) AND ((up.org_role = ANY (ARRAY['owner'::org_role_enum, 'admin'::org_role_enum])) OR ((up.roles && ARRAY['admin'::text, 'super_admin'::text]) AND (SELECT public.operator_mfa_satisfied())))))));

REVOKE INSERT, UPDATE, TRUNCATE ON TABLE public.organization_invites FROM anon, authenticated;
REVOKE DELETE ON TABLE public.organization_invites FROM anon;
