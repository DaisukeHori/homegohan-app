-- rollback: 20261019120000_self_dissolve.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻すもの: 利用者の解散の RPC 2 本と後始末の関数 2 本を DROP し、運営の強制解散の RPC 2 本を 20261017130000_operator_mfa_db_gate.sql の定義 (:166-235, :281-319) に逐語で戻し、
--   CHECK 2 本を外す。NOT NULL は、NULL の行が無いときだけ戻す (解散で NULL にした行があると SET NOT NULL は 23502 で失敗するので、
--   その場合は NOTICE を出して NULL 許容のまま残す。解散した行の元の代表者・オーナーは membership_audit の metadata にだけ残り、列には戻せない)。
--   家族の行の特権列のガード guard_family_groups_privileged を 20251126124224_create_meal_planner_tables.sql の定義 (:1779-1791) に逐語で戻す。
--   ⚠️ 戻すと、active な代表者・大人が REST の UPDATE で family_groups の status / dissolved_at を書けるようになる
--   (代表者を指したままの dissolved の行が作れ、代表者が退会できなくなる。family/11 S-31)。緊急時の切り戻し専用。
-- 戻らないもの: 利用者が解散した家族・組織 (dissolved のまま。メンバーの所属も戻らない)。membership_audit の group_dissolved の行 (記録として残す)。
-- 触れないもの: 外部キー (変えていない)・ほかの関数・RLS・トリガー・組織の特権列のガード (up で変えていない)。
-- 冪等: DROP FUNCTION IF EXISTS / DROP CONSTRAINT IF EXISTS / CREATE OR REPLACE。

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.dissolve_family_by_representative(uuid);
DROP FUNCTION IF EXISTS public.dissolve_org_by_owner(uuid);

-- 運営の RPC 2 本: 20261017130000_operator_mfa_db_gate.sql の operator_force_dissolve_org (:166-235) と operator_force_dissolve_family (:281-319) を逐語で戻す
-- (tests/self-dissolve-migration-contract.test.ts C-9 が同ファイルの該当行との逐語の一致を見る)。後始末の関数を DROP する前に戻すので、
-- 戻したあとの運営の RPC は後始末の関数を呼ばない。署名・戻り値の型は up と同じなので CREATE OR REPLACE で置き換わり、
-- 権限 (EXECUTE の GRANT / REVOKE) は up で変えていないのでそのまま残る。
CREATE OR REPLACE FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_org organizations;
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

  UPDATE user_profiles
    SET organization_id = NULL,
        org_role = NULL,
        is_active_in_org = FALSE,
        joined_org_at = NULL,
        roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
        department_id = NULL  -- #1235: 部署の所属も外す
    WHERE organization_id = p_organization_id;

  -- Round 3 C-4: org_license_pools の used_licenses をリセット
  UPDATE org_license_pools
    SET used_licenses = 0, updated_at = NOW()
    WHERE organization_id = p_organization_id;

  -- organizations.status を dissolved に更新 (000126 で追加したカラム)
  UPDATE organizations
    SET status = 'dissolved',
        dissolved_at = NOW(),
        updated_at = NOW()
    WHERE id = p_organization_id
    RETURNING * INTO v_org;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES (
    'organization',
    p_organization_id,
    'operator_force_dissolve',
    auth.uid(),
    NULL,
    jsonb_build_object(
      'reason', p_reason,
      'dissolved_at', NOW()
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
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  -- #1176 (docs/design/cross/12-operator-mfa.md §11.4): TOTP を登録済みの必須ロールの呼び出し元は、aal2 のセッションでなければ止める
  IF NOT public.operator_mfa_satisfied() THEN
    RAISE EXCEPTION 'OPERATOR_MFA_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (#1310): family_groups -> family_members -> user_profiles。
  -- 最初に家族の行をロックする (従来は最後に更新するだけだった)。承諾・子供の追加など、家族の行を先に取った処理が
  -- 途中であれば、その完了を待ってから以降のメンバーの更新を始めるので、コミット済みのメンバーも全員 left にできる。
  -- 家族の行が無ければ何もせず、従来どおり以降の UPDATE は 0 行のまま v_fam が NULL で返る。
  PERFORM 1 FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;

  UPDATE family_members SET status = 'left' WHERE family_id = p_family_id AND status = 'active';
  UPDATE user_profiles SET family_id = NULL WHERE family_id = p_family_id;

  UPDATE family_groups
    SET status = 'dissolved', dissolved_at = NOW()
    WHERE id = p_family_id
    RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_dissolve', NULL,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;

-- 家族の行の特権列のガード: 20251126124224_create_meal_planner_tables.sql の定義 (:1779-1791) を逐語で戻す (status / dissolved_at を守る列から外す)。
-- 属性 (SECURITY INVOKER・search_path の指定なし)・トリガー・権限は up で変えていないので触らない
CREATE OR REPLACE FUNCTION "public"."guard_family_groups_privileged"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF NEW.representative_id IS DISTINCT FROM OLD.representative_id
       OR NEW.plan_key     IS DISTINCT FROM OLD.plan_key
       OR NEW.member_limit IS DISTINCT FROM OLD.member_limit THEN
      RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP FUNCTION IF EXISTS public.family_dissolve_apply(uuid);
DROP FUNCTION IF EXISTS public.org_dissolve_apply(uuid);

ALTER TABLE public.family_groups DROP CONSTRAINT IF EXISTS family_groups_active_has_representative;
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_active_has_owner;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.family_groups WHERE representative_id IS NULL) THEN
    ALTER TABLE public.family_groups ALTER COLUMN representative_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'family_groups.representative_id に NULL の行があるため NOT NULL に戻しません';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE owner_id IS NULL) THEN
    ALTER TABLE public.organizations ALTER COLUMN owner_id SET NOT NULL;
  ELSE
    RAISE NOTICE 'organizations.owner_id に NULL の行があるため NOT NULL に戻しません';
  END IF;
END
$$;

COMMENT ON COLUMN public.family_groups.representative_id IS NULL;
COMMENT ON COLUMN public.organizations.owner_id IS NULL;
