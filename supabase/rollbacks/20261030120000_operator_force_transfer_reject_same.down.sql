-- rollback: 20261030120000_operator_force_transfer_reject_same.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻すもの: 2 つの関数を 20261023140000_operator_transfer_return_old_owner.sql の定義に逐語で戻す
--   - operator_force_owner_transfer: :43-92
--   - operator_force_representative_transfer: :105-154
--   (tests/operator-force-transfer-reject-same-migration-contract.test.ts が同ファイルの該当行との逐語の一致を見る)。
--   名前・引数・戻り値の型 (jsonb) は up と同じなので CREATE OR REPLACE で置き換わり、権限 (EXECUTE の GRANT / REVOKE) は up で
--   変えていないのでそのまま残る。関数のコメントも 20261023140000 の文 (:97-98・:159-160) に戻す。
--   ⚠️ 戻すと、譲渡先がすでに今のオーナー / 代表者でも RPC は断らずに書き、membership_audit に旧 = 新の行が残る (#2093 W5 の前の動き)。
--   route は ALREADY_OWNER / ALREADY_REPRESENTATIVE を受け取らなくなるだけで、戻り値の旧オーナー / 旧代表者で 409 にする判定が残るので、
--   admin_audit_logs と通知メールは出さない (壊れはしない)。
-- 戻らないもの: なし (up はデータを書き換えない)。
-- 冪等: CREATE OR REPLACE と COMMENT は何度流しても同じ。

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION "public"."operator_force_owner_transfer"("p_organization_id" "uuid", "p_new_owner_id" "uuid", "p_reason" "text") RETURNS "jsonb"
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

  -- #1917: 更新した後の行と、組織の行のロックの下で読んだ旧オーナー (membership_audit の old_owner_id と同じ値) を返す。
  -- route はこの old_owner_id を監査の from_user_id と旧オーナーへの知らせの宛先に使う (RPC の前にロックの外で読んだ値は使わない)
  RETURN jsonb_build_object('organization', to_jsonb(v_org), 'old_owner_id', v_old_owner_id);
END $$;

COMMENT ON FUNCTION public.operator_force_owner_transfer(uuid, uuid, text) IS
  '運営 (super_admin・MFA 済み) が組織のオーナーを強制的に譲渡する。戻り値は {"organization": 更新した後の organizations の行, "old_owner_id": 組織の行を FOR NO KEY UPDATE でロックして読んだ旧オーナー (membership_audit の old_owner_id と同じ値。同時の譲渡があってもこの譲渡の直前のオーナー)}。#1917';

CREATE OR REPLACE FUNCTION public.operator_force_representative_transfer(p_family_id UUID, p_new_rep_id UUID, p_reason TEXT)
RETURNS jsonb
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

  -- #1917: 更新した後の行と、家族の行のロックの下で読んだ旧代表者 (membership_audit の old_rep_id と同じ値) を返す。
  -- route はこの old_rep_id を監査の from_user_id と旧代表者への知らせの宛先に使う (RPC の前にロックの外で読んだ値は使わない)
  RETURN jsonb_build_object('family_group', to_jsonb(v_fam), 'old_rep_id', v_old_rep_id);
END $$;

COMMENT ON FUNCTION public.operator_force_representative_transfer(uuid, uuid, text) IS
  '運営 (super_admin・MFA 済み) が家族の代表者を強制的に譲渡する。戻り値は {"family_group": 更新した後の family_groups の行, "old_rep_id": 家族の行を FOR NO KEY UPDATE でロックして読んだ旧代表者 (membership_audit の old_rep_id と同じ値。同時の譲渡があってもこの譲渡の直前の代表者)}。#1917';
