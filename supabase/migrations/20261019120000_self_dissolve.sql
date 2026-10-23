-- migration: 20261019120000_self_dissolve.sql
-- 戻し方: supabase/rollbacks/20261019120000_self_dissolve.down.sql
-- #1917 家族グループの代表者・組織のオーナーが自分で解散できるようにする (docs/design/family/11-self-dissolve.md §11)。
--
-- 変更:
--   1. family_groups.representative_id / organizations.owner_id の NOT NULL を外し、CHECK (active な行では NOT NULL) を足す。
--      解散した行は元の代表者・オーナーを指さない (退会の 409 と auth.users への RESTRICT に当たらない。§7.1 N-1)。
--      auth.users への外部キー (ON DELETE RESTRICT) は変えない (active な行は今までどおり退会を止める)。
--   2. 後始末の関数 family_dissolve_apply / org_dissolve_apply を新設 (SECURITY INVOKER。呼ぶのは SECURITY DEFINER の RPC だけ)。
--   3. 利用者の解散の RPC dissolve_family_by_representative / dissolve_org_by_owner を新設 (SECURITY DEFINER。authenticated が呼ぶ)。
--   4. operator_force_dissolve_family / operator_force_dissolve_org の本体を、後始末の関数を呼ぶ形に置き換える
--      (土台は 20261017130000_operator_mfa_db_gate.sql の定義。権限・MFA の判定・エラー・監査の action・戻り値は変えない。
--       監査の metadata に previous_representative_id / previous_owner_id を足す)。
--   5. 既に dissolved の行の representative_id / owner_id を NULL にする (本番は 0 行。2026-10-19 実測)。
--   6. 家族の行の特権列のガード guard_family_groups_privileged が、ログインユーザー (current_user が authenticated / anon) による
--      status / dissolved_at の変更も 42501 で拒否する (土台は 20251126124224_create_meal_planner_tables.sql:1779-1791。後の migration での置き換えは無い)。
--      RLS family_groups_update_adult は active な代表者・大人に列を限らない UPDATE を許すので、これが無いと REST の UPDATE で
--      representative_id が代表者を指したままの dissolved の行が作れ、代表者が退会できなくなる (§10.1・S-31)。
--      #1309 (20261008090000_family_members_status_guard.sql) と同じ形: 値を変えない更新は拒否しない・SECURITY INVOKER のまま・
--      search_path の指定なしのまま・トリガー本体と RLS と GRANT は変えない。
-- 既存データへの影響: 5 の UPDATE だけ (dissolved の行だけ。本番は 0 行)。active の行は変えない。6 は関数の本文だけを置き換える。
-- 冪等: ALTER COLUMN DROP NOT NULL / ADD CONSTRAINT IF NOT EXISTS (DO ブロックで存在を確かめる) / CREATE OR REPLACE / REVOKE・GRANT は何度流しても同じ。
-- 確認: tests/self-dissolve-migration-contract.test.ts (文面)・tests/integration/security/self-dissolve.test.ts (実 DB)
-- ロールバック: supabase/rollbacks/20261019120000_self_dissolve.down.sql

SET LOCAL lock_timeout = '10s';

-- ─────────────────────────────────────────────────────────
-- 1. 列の制約
-- ─────────────────────────────────────────────────────────
ALTER TABLE public.family_groups ALTER COLUMN representative_id DROP NOT NULL;
ALTER TABLE public.organizations ALTER COLUMN owner_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_groups_active_has_representative') THEN
    ALTER TABLE public.family_groups
      ADD CONSTRAINT family_groups_active_has_representative
      CHECK (status <> 'active' OR representative_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_active_has_owner') THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_active_has_owner
      CHECK (status <> 'active' OR owner_id IS NOT NULL);
  END IF;
END
$$;

COMMENT ON COLUMN public.family_groups.representative_id IS
  '代表者 (auth.users)。active な行では NOT NULL (CHECK family_groups_active_has_representative)。解散 (status = dissolved) で NULL にする (#1917)。auth.users への外部キーは ON DELETE RESTRICT のまま (代表者は譲渡か解散をしないと退会できない)';
COMMENT ON COLUMN public.organizations.owner_id IS
  'オーナー (auth.users)。active な行では NOT NULL (CHECK organizations_active_has_owner)。解散 (status = dissolved) で NULL にする (#1917)。auth.users への外部キーは ON DELETE RESTRICT のまま';

-- ─────────────────────────────────────────────────────────
-- 2. 後始末の関数 (運営の強制解散と利用者の解散の両方が呼ぶ。本体は 20261017130000 の operator_force_dissolve_* の UPDATE の並びそのもの)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.family_dissolve_apply(p_family_id uuid)
RETURNS public.family_groups
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_fam public.family_groups;
BEGIN
  -- LOCK-ORDER (#1310): family_groups -> family_members -> user_profiles。呼び出し元が先に取っていても、同じトランザクションなので再取得は待たない
  PERFORM 1 FROM public.family_groups WHERE id = p_family_id FOR NO KEY UPDATE;

  UPDATE public.family_members SET status = 'left' WHERE family_id = p_family_id AND status = 'active';
  UPDATE public.user_profiles SET family_id = NULL WHERE family_id = p_family_id;

  -- representative_id を同じ文で NULL にする。BEFORE UPDATE OF representative_id のトリガー (billing_family_plan_follow_representative) は
  -- NEW.status が active でないので何もしない (20261016210000_billing_core.sql)
  UPDATE public.family_groups
    SET status = 'dissolved', dissolved_at = pg_catalog.now(), representative_id = NULL
    WHERE id = p_family_id
    RETURNING * INTO v_fam;

  RETURN v_fam;
END $$;
REVOKE ALL ON FUNCTION public.family_dissolve_apply(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.family_dissolve_apply(uuid) TO service_role;
COMMENT ON FUNCTION public.family_dissolve_apply(uuid) IS
  '#1917 家族の解散の後始末 (メンバーを left・プロフィールの family_id を NULL・行を dissolved・representative_id を NULL)。operator_force_dissolve_family と dissolve_family_by_representative が呼ぶ。クライアントからは呼ばせない';

CREATE OR REPLACE FUNCTION public.org_dissolve_apply(p_organization_id uuid)
RETURNS public.organizations
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_org public.organizations;
BEGIN
  -- 20261017130000 の operator_force_dissolve_org と同じ順 (user_profiles -> org_license_pools -> organizations)。
  -- 組織の行を先に取らない: accept_org_owner_transfer (user_profiles -> organizations) と逆向きになり、デッドロックするため (§11.3)
  UPDATE public.user_profiles
    SET organization_id = NULL,
        org_role = NULL,
        is_active_in_org = FALSE,
        joined_org_at = NULL,
        roles = pg_catalog.array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE organization_id = p_organization_id;

  UPDATE public.org_license_pools
    SET used_licenses = 0, updated_at = pg_catalog.now()
    WHERE organization_id = p_organization_id;

  UPDATE public.organizations
    SET status = 'dissolved',
        dissolved_at = pg_catalog.now(),
        updated_at = pg_catalog.now(),
        owner_id = NULL
    WHERE id = p_organization_id
    RETURNING * INTO v_org;

  RETURN v_org;
END $$;
REVOKE ALL ON FUNCTION public.org_dissolve_apply(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_dissolve_apply(uuid) TO service_role;
COMMENT ON FUNCTION public.org_dissolve_apply(uuid) IS
  '#1917 組織の解散の後始末 (所属の列 6 つを外す・席数を 0・行を dissolved・owner_id を NULL)。operator_force_dissolve_org と dissolve_org_by_owner が呼ぶ。クライアントからは呼ばせない';

-- ─────────────────────────────────────────────────────────
-- 3. 利用者の解散の RPC
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.dissolve_family_by_representative(p_family_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_fam          public.family_groups;
  v_member_ids   uuid[];
  v_member_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): 最初に家族の行をロックし、そのロック下で代表者かを判定する (譲渡の承諾・招待の承諾と直列になる)
  SELECT * INTO v_fam FROM public.family_groups WHERE id = p_family_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_fam.status = 'dissolved' THEN
    RAISE EXCEPTION 'FAMILY_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;
  IF v_fam.representative_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'NOT_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  -- 通知先 (アカウントを持つ active なメンバー。解散する本人を含む) は後始末の前に集める (あとでは left になり分からない)
  SELECT coalesce(pg_catalog.array_agg(user_id), '{}'::uuid[]), pg_catalog.count(*)::integer
    INTO v_member_ids, v_member_count
    FROM public.family_members
   WHERE family_id = p_family_id AND status = 'active';
  v_member_ids := pg_catalog.array_remove(v_member_ids, NULL);

  v_fam := public.family_dissolve_apply(p_family_id);

  INSERT INTO public.membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'group_dissolved', auth.uid(), NULL,
          pg_catalog.jsonb_build_object(
            'dissolved_by', 'representative',
            'previous_representative_id', auth.uid(),
            'member_count', v_member_count
          ));

  RETURN pg_catalog.jsonb_build_object(
    'scope_id', v_fam.id,
    'scope_name', v_fam.name,
    'dissolved_at', v_fam.dissolved_at,
    'member_user_ids', pg_catalog.to_jsonb(v_member_ids)
  );
END $$;
REVOKE ALL ON FUNCTION public.dissolve_family_by_representative(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dissolve_family_by_representative(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.dissolve_family_by_representative(uuid) IS
  '#1917 代表者が自分の家族グループを解散する。家族の行をロックして代表者かを判定し、family_dissolve_apply で後始末、membership_audit に group_dissolved。戻り値は { scope_id, scope_name, dissolved_at, member_user_ids } (通知の宛先は route が引く)';

CREATE OR REPLACE FUNCTION public.dissolve_org_by_owner(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org          public.organizations;
  v_member_ids   uuid[];
  v_member_count integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 本人の user_profiles の行を最初にロックする: オーナーの譲渡の承諾 (accept_org_owner_transfer) は 旧オーナーの user_profiles -> organizations の順に
  -- 書くので、同じ向きで取れば直列になり、デッドロックしない (§11.3)。本人の行が無ければ (プロフィール未作成) オーナーではありえない
  PERFORM 1 FROM public.user_profiles WHERE id = auth.uid() FOR NO KEY UPDATE;

  SELECT * INTO v_org FROM public.organizations WHERE id = p_organization_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_org.status = 'dissolved' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;
  IF v_org.owner_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(pg_catalog.array_agg(id), '{}'::uuid[]), pg_catalog.count(*)::integer
    INTO v_member_ids, v_member_count
    FROM public.user_profiles
   WHERE organization_id = p_organization_id;

  v_org := public.org_dissolve_apply(p_organization_id);

  INSERT INTO public.membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'group_dissolved', auth.uid(), NULL,
          pg_catalog.jsonb_build_object(
            'dissolved_by', 'owner',
            'previous_owner_id', auth.uid(),
            'member_count', v_member_count
          ));

  RETURN pg_catalog.jsonb_build_object(
    'scope_id', v_org.id,
    'scope_name', v_org.name,
    'dissolved_at', v_org.dissolved_at,
    'member_user_ids', pg_catalog.to_jsonb(v_member_ids)
  );
END $$;
REVOKE ALL ON FUNCTION public.dissolve_org_by_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dissolve_org_by_owner(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.dissolve_org_by_owner(uuid) IS
  '#1917 オーナーが自分の組織を解散する。本人の user_profiles の行 → 組織の行の順にロックしてオーナーかを判定し、org_dissolve_apply で後始末、membership_audit に group_dissolved。戻り値は { scope_id, scope_name, dissolved_at, member_user_ids }';

-- ─────────────────────────────────────────────────────────
-- 4. 運営の強制解散の RPC 2 本: 本体を後始末の関数を呼ぶ形に置き換える (土台 = 20261017130000_operator_mfa_db_gate.sql:166-235, 281-319)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_org organizations;
  v_prev_owner UUID;
BEGIN
  SELECT roles INTO v_caller_roles
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_roles IS NULL
     OR NOT (
       'super_admin' = ANY(v_caller_roles)
       OR 'operator' = ANY(v_caller_roles)
     ) THEN
    RAISE EXCEPTION 'OPERATOR_PERMISSION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  -- #1176 (docs/design/cross/12-operator-mfa.md §11.4): TOTP を登録済みの必須ロールの呼び出し元は、aal2 のセッションでなければ止める
  IF NOT public.operator_mfa_satisfied() THEN
    RAISE EXCEPTION 'OPERATOR_MFA_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_org FROM organizations WHERE id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_org.status = 'dissolved' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;
  v_prev_owner := v_org.owner_id;

  -- #1917: 後始末 (所属の列を外す・席数を 0・行を dissolved・owner_id を NULL) は public.org_dissolve_apply に閉じる
  v_org := public.org_dissolve_apply(p_organization_id);

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES (
    'organization',
    p_organization_id,
    'operator_force_dissolve',
    auth.uid(),
    NULL,
    jsonb_build_object(
      'reason', p_reason,
      'dissolved_at', NOW(),
      'previous_owner_id', v_prev_owner
    )
  );

  RETURN v_org;
END;
$$;

CREATE OR REPLACE FUNCTION public.operator_force_dissolve_family(p_family_id UUID, p_reason TEXT)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam family_groups;
  v_caller_roles TEXT[];
  v_prev_rep UUID;
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  -- #1176 (docs/design/cross/12-operator-mfa.md §11.4): TOTP を登録済みの必須ロールの呼び出し元は、aal2 のセッションでなければ止める
  IF NOT public.operator_mfa_satisfied() THEN
    RAISE EXCEPTION 'OPERATOR_MFA_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_members -> user_profiles。最初に家族の行をロックし、元の代表者をそのロック下で読む。
  -- 家族の行が無ければ v_prev_rep は NULL のままで、後始末は従来どおり 0 行の UPDATE で v_fam が NULL で返る
  SELECT representative_id INTO v_prev_rep FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;

  -- #1917: 後始末 (メンバーを left・プロフィールの family_id を NULL・行を dissolved・representative_id を NULL) は public.family_dissolve_apply に閉じる
  v_fam := public.family_dissolve_apply(p_family_id);

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_dissolve', NULL,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'reason', p_reason,
            'previous_representative_id', v_prev_rep
          ));

  RETURN v_fam;
END $$;

-- ─────────────────────────────────────────────────────────
-- 5. 既に解散している行 (本番は 0 行) の元の代表者・オーナーを外す
-- ─────────────────────────────────────────────────────────
UPDATE public.family_groups SET representative_id = NULL WHERE status = 'dissolved' AND representative_id IS NOT NULL;
UPDATE public.organizations SET owner_id = NULL WHERE status = 'dissolved' AND owner_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────
-- 6. 家族の行の特権列のガードに status / dissolved_at を足す (土台 = 20251126124224_create_meal_planner_tables.sql:1779-1791)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_family_groups_privileged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    -- #1917: status / dissolved_at もログインユーザーは直接変更できない。解散は後始末の関数 family_dissolve_apply
    -- (呼ぶのは SECURITY DEFINER の dissolve_family_by_representative / operator_force_dissolve_family) か service_role だけが行う。
    -- RLS family_groups_update_adult は active な代表者・大人に列を限らない UPDATE を許すので、ここで止めないと
    -- representative_id が代表者を指したままの dissolved の行が作れ、代表者が退会できなくなる (docs/design/family/11-self-dissolve.md S-31)。
    IF NEW.representative_id IS DISTINCT FROM OLD.representative_id
       OR NEW.plan_key     IS DISTINCT FROM OLD.plan_key
       OR NEW.member_limit IS DISTINCT FROM OLD.member_limit
       OR NEW.status       IS DISTINCT FROM OLD.status
       OR NEW.dissolved_at IS DISTINCT FROM OLD.dissolved_at THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
