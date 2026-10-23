-- rollback: 20261023140000_operator_transfer_return_old_owner.sql
-- #1917 で戻り値を jsonb (更新した後の行 + ロックの下で読んだ旧オーナー / 旧代表者) にした 2 つの関数を、本冊の直前の定義に戻す。
--   - operator_force_owner_transfer: 20261022160000_release_membership_owner_race.sql の定義 (:118-165。戻り値は organizations の行)
--   - operator_force_representative_transfer: 20261017130000_operator_mfa_db_gate.sql の定義 (:322-369。戻り値は family_groups の行)
-- 本文は各ファイルの該当行の逐語。権限は本番と同じ (supabase/baseline/prod_function_acl.sql:143-148: PUBLIC / anon から外し、
-- authenticated と service_role に EXECUTE)。戻り値の型が変わるので DROP してから作り、権限を付け直す。
-- (tests/operator-transfer-old-owner-migration-contract.test.ts が、各ファイルの該当行との逐語の一致と権限を見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと戻り値に旧オーナー / 旧代表者が無くなる。route (src/app/api/operator/membership/org/[id]/transfer/route.ts・
--     family/[id]/transfer/route.ts) は戻り値が古い形だと、RPC の前に先に読んだ旧オーナー / 旧代表者で監査と知らせを出し、
--     食い違いうることをログに残す (#1917 の前の動き。同時の譲渡で直前の値と食い違いうる)。譲渡そのものは動く。
-- データは戻さない (この migration はデータを変えていない)。
-- 何度流しても同じ結果になる (冪等: DROP FUNCTION IF EXISTS → CREATE OR REPLACE → REVOKE / GRANT)。

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.operator_force_owner_transfer(uuid, uuid, text);

CREATE OR REPLACE FUNCTION "public"."operator_force_owner_transfer"("p_organization_id" "uuid", "p_new_owner_id" "uuid", "p_reason" "text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_org organizations;
  v_old_owner_id UUID;
  v_caller_roles TEXT[];
  v_target_org_id UUID;
BEGIN
  SELECT roles INTO v_caller_roles FROM user_profiles WHERE id = auth.uid();
  IF NOT ('super_admin' = ANY(v_caller_roles)) THEN
    RAISE EXCEPTION 'NOT_OPERATOR' USING ERRCODE = 'P0001';
  END IF;
  -- #1176 (docs/design/cross/12-operator-mfa.md §11.4): TOTP を登録済みの必須ロールの呼び出し元は、aal2 のセッションでなければ止める
  IF NOT public.operator_mfa_satisfied() THEN
    RAISE EXCEPTION 'OPERATOR_MFA_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER (docs/design/family/11-self-dissolve.md §11.3・CLAUDE.md の組織のロック順):
  -- 組織の行 → 新オーナーの user_profiles (どちらも FOR NO KEY UPDATE) → 旧オーナーの user_profiles (UPDATE)。
  -- 解散・譲渡の承諾も組織の行を最初に取るので、組織の行で直列になる。新オーナーの在籍はロックの下で判定する
  -- (ロックの外で判定すると、解散の commit のあとに所属の外れた行へ org_role を書いて 23514 になる)。
  -- 旧オーナーは組織の行のロックの下で読んだ owner_id。解散した組織は所属が 0 人なので、従来どおり TARGET_NOT_IN_ORG になる
  SELECT owner_id INTO v_old_owner_id FROM organizations WHERE id = p_organization_id FOR NO KEY UPDATE;

  SELECT organization_id INTO v_target_org_id FROM user_profiles WHERE id = p_new_owner_id FOR NO KEY UPDATE;
  IF v_target_org_id IS NULL OR v_target_org_id <> p_organization_id THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- 旧オーナーの行は、この組織に在籍しているときだけ admin にする (所属の外れた行に org_role を書くと CHECK user_profiles_org_consistency
  -- (23514) になる。所属の無い人を owner_id が指す組織 (20261022160000 の見出し) も、この強制譲渡で新しいオーナーに立て直せる)
  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id AND organization_id = p_organization_id;
  UPDATE user_profiles SET org_role = 'owner' WHERE id = p_new_owner_id;
  UPDATE organizations SET owner_id = p_new_owner_id WHERE id = p_organization_id RETURNING * INTO v_org;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'operator_force_owner_transfer',
          NULL, p_new_owner_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_owner_id', v_old_owner_id,
            'reason', p_reason
          ));

  RETURN v_org;
END $$;

REVOKE ALL ON FUNCTION public.operator_force_owner_transfer(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.operator_force_owner_transfer(uuid, uuid, text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.operator_force_representative_transfer(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.operator_force_representative_transfer(p_family_id UUID, p_new_rep_id UUID, p_reason TEXT)
RETURNS family_groups
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fam family_groups;
  v_old_rep_id UUID;
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

  -- LOCK-ORDER (#1310): family_groups -> family_members。
  -- 最初に家族の行をロックし、旧代表者もこのロック下で読む (従来は新代表者の確認と旧代表者の取得がロックより前で、
  -- 家族の行は最後に更新するだけだった)。家族の行が無ければ v_old_rep_id は NULL のままで、次の確認が TARGET_NOT_IN_FAMILY になる。
  SELECT representative_id INTO v_old_rep_id FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM family_members
    WHERE family_id = p_family_id AND user_id = p_new_rep_id
      AND status = 'active' AND role IN ('representative', 'adult')
  ) THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members SET role = 'adult'
    WHERE family_id = p_family_id AND user_id = v_old_rep_id AND status = 'active';
  UPDATE family_members SET role = 'representative'
    WHERE family_id = p_family_id AND user_id = p_new_rep_id AND status = 'active';
  UPDATE family_groups SET representative_id = p_new_rep_id
    WHERE id = p_family_id RETURNING * INTO v_fam;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'operator_force_representative_transfer',
          NULL, p_new_rep_id,
          jsonb_build_object(
            'operator_id', auth.uid(),
            'old_rep_id', v_old_rep_id,
            'reason', p_reason
          ));

  RETURN v_fam;
END $$;

REVOKE ALL ON FUNCTION public.operator_force_representative_transfer(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.operator_force_representative_transfer(uuid, uuid, text) TO authenticated, service_role;
