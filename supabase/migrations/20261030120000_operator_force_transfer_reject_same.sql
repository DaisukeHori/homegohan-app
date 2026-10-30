-- migration: 20261030120000_operator_force_transfer_reject_same.sql
-- 戻し方: supabase/rollbacks/20261030120000_operator_force_transfer_reject_same.down.sql
-- #2093 W5: 運営の強制譲渡 (operator_force_owner_transfer / operator_force_representative_transfer) が、譲渡先がすでに今のオーナー /
-- 代表者 (新 = 旧) でも membership_audit に旧 = 新の行を 1 行書いてしまう既存の欠陥を直す。
--
-- 背景:
--   route (POST /api/operator/membership/org/{id}/transfer・family/{id}/transfer) は #2086 V1 で、新 = 旧の譲渡を 2 か所で 409 にした:
--   (1) RPC の前の控え (ロックの外で読んだ今のオーナー / 代表者) が譲渡先と同じなら、RPC を呼ばずに止める
--   (2) RPC の戻り値の旧オーナー / 旧代表者 (ロックの下で読んだ値) が譲渡先と同じなら、admin_audit_logs と通知メールを出さずに止める
--   (2) に来るのは、RPC の前の控えを読めなかったときと、控えを読んだあと RPC の直前に別の運営が同じ人へ譲渡したとき。このとき RPC
--   (最新の定義は 20261023140000_operator_transfer_return_old_owner.sql) はすでに役割を書き直し、membership_audit に旧 = 新の行を
--   書いて commit している。その行は運営の監査ログの画面に「運営によるオーナー / 代表者の強制譲渡」としてもう 1 行出て、
--   admin_audit_logs には行が無いので 2 つの監査が食い違い、運営が二重に譲渡したと読む余地がある。
--
-- 変更 (2 つの関数。名前・引数・戻り値の型 (jsonb)・属性 (SECURITY DEFINER・search_path)・権限は変えないので CREATE OR REPLACE):
--   組織 / 家族の行を FOR NO KEY UPDATE でロックして旧オーナー / 旧代表者を読んだ直後に、譲渡先が同じなら
--   ALREADY_OWNER / ALREADY_REPRESENTATIVE (P0001) で止める。止めたときは役割の更新も owner_id / representative_id の更新も
--   membership_audit の INSERT もしない (どれも判定より後)。
--   エラーの順番: NOT_OPERATOR → OPERATOR_MFA_REQUIRED → ALREADY_OWNER / ALREADY_REPRESENTATIVE → TARGET_NOT_IN_ORG / TARGET_NOT_IN_FAMILY。
--   本文はこの判定のほかは 20261023140000 の定義 (:43-92・:105-154) の逐語 (権限・MFA の判定・ロックとその順・在籍の判定・
--   役割の更新の順・membership_audit の action と metadata・戻り値は同じ。CLAUDE.md の組織 / 家族の行のロック順も変えない)。
--   route は RPC のこのコードを、今の 409 (src/lib/membership/operator-force-transfer-result.ts の code と文) に写し、監査と通知を出さない。
--   route の (2) の判定は、この migration を当てる前の DB でも安全なように残す。
--
-- 既存データへの影響: なし (関数の本文だけを置き換える。データを書き換える文は無い。すでに残っている旧 = 新の行は消さない)。
-- 冪等: CREATE OR REPLACE は何度流しても同じ。
-- 確かめるテスト: tests/operator-force-transfer-reject-same-migration-contract.test.ts (文面)・
--   tests/integration/security/operator-transfer-old-owner.test.ts の OTO-8〜OTO-11 (実 DB・route)・
--   src/__tests__/api/operator/membership/org-transfer.test.ts・family-transfer.test.ts と tests/operator-membership-rpc-errors-1917.test.ts (route の 409)
-- ロールバック: supabase/rollbacks/20261030120000_operator_force_transfer_reject_same.down.sql

SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. operator_force_owner_transfer: 本文は 20261023140000 の定義 (:43-92) の逐語に、新 = 旧の判定を 1 つ足したもの
-- ----------------------------------------------------------------
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

  -- #2093 W5: 譲渡先がすでに今のオーナー (ロックの下で読んだ旧オーナーと同じ) なら、役割も owner_id も membership_audit も書かずに断る。
  -- 断らないと、旧オーナー = 新オーナーの membership_audit の行が残り、運営の監査ログの画面に二重の譲渡として出る
  -- (route は admin_audit_logs と通知メールを出さないので、2 つの監査が食い違う)。route はこのコードを 409 ALREADY_OWNER に写す。
  -- 解散した組織・無い組織は v_old_owner_id が NULL なので、この判定は通らず、従来どおり次の在籍の判定 (TARGET_NOT_IN_ORG) で止まる
  IF p_new_owner_id = v_old_owner_id THEN
    RAISE EXCEPTION 'ALREADY_OWNER' USING ERRCODE = 'P0001';
  END IF;

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
  '運営 (super_admin・MFA 済み) が組織のオーナーを強制的に譲渡する。戻り値は {"organization": 更新した後の organizations の行, "old_owner_id": 組織の行を FOR NO KEY UPDATE でロックして読んだ旧オーナー (membership_audit の old_owner_id と同じ値。同時の譲渡があってもこの譲渡の直前のオーナー)}。#1917。譲渡先がすでにオーナー (旧オーナーと同じ) なら、何も書かずに ALREADY_OWNER で止める。#2093';

-- ----------------------------------------------------------------
-- 2. operator_force_representative_transfer: 本文は 20261023140000 の定義 (:105-154) の逐語に、新 = 旧の判定を 1 つ足したもの
-- ----------------------------------------------------------------
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

  -- #2093 W5: 譲渡先がすでに今の代表者 (ロックの下で読んだ旧代表者と同じ) なら、役割も representative_id も membership_audit も書かずに断る。
  -- 断らないと、旧代表者 = 新代表者の membership_audit の行が残り、運営の監査ログの画面に二重の譲渡として出る
  -- (route は admin_audit_logs と通知メールを出さないので、2 つの監査が食い違う)。route はこのコードを 409 ALREADY_REPRESENTATIVE に写す。
  -- 解散した家族・無い家族は v_old_rep_id が NULL なので、この判定は通らず、従来どおり次の確認 (TARGET_NOT_IN_FAMILY) で止まる
  IF p_new_rep_id = v_old_rep_id THEN
    RAISE EXCEPTION 'ALREADY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

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
  '運営 (super_admin・MFA 済み) が家族の代表者を強制的に譲渡する。戻り値は {"family_group": 更新した後の family_groups の行, "old_rep_id": 家族の行を FOR NO KEY UPDATE でロックして読んだ旧代表者 (membership_audit の old_rep_id と同じ値。同時の譲渡があってもこの譲渡の直前の代表者)}。#1917。譲渡先がすでに代表者 (旧代表者と同じ) なら、何も書かずに ALREADY_REPRESENTATIVE で止める。#2093';
