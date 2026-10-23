-- migration: 20261023140000_operator_transfer_return_old_owner.sql
-- 戻し方: supabase/rollbacks/20261023140000_operator_transfer_return_old_owner.down.sql
-- #1917 の続き: 運営の強制譲渡 (POST /api/operator/membership/org/{id}/transfer・family/{id}/transfer) の監査
-- (admin_audit_logs の super_admin.organization.transfer_admin / super_admin.family.transfer_representative) の details.from_user_id と、
-- 旧オーナー / 旧代表者への知らせの宛先が、同時の譲渡で実際の直前の値と食い違いうる既存の欠陥を直す。
--
-- 背景:
--   route は RPC の前に、ロックを取らずに organizations.owner_id / family_groups.representative_id を読み (#1209)、その値を監査の
--   from_user_id と知らせの宛先 (旧オーナー / 旧代表者の役の宛先) に使っていた。RPC (operator_force_owner_transfer の最新の定義は
--   20261022160000_release_membership_owner_race.sql、operator_force_representative_transfer の最新の定義は
--   20261017130000_operator_mfa_db_gate.sql) は、組織 / 家族の行を FOR NO KEY UPDATE でロックしてから旧オーナー / 旧代表者を読み、
--   membership_audit の metadata (old_owner_id / old_rep_id) に書くが、戻り値は更新した後の行 (owner_id / representative_id は新しい人) で、
--   ロックの下で読んだ旧オーナー / 旧代表者を返さない。運営 2 人がほぼ同時に同じ組織 / 家族を譲渡すると、後の譲渡の直前のオーナーは
--   先の譲渡の相手なのに、後の route は先に読んだ (先の譲渡の前の) 人を from_user_id に残し、その人へ旧オーナー向けの知らせを送る
--   (本当の直前のオーナーには一般メンバー向けの知らせが届く)。membership_audit とも食い違う。
--
-- 変更 (2 つの関数):
--   戻り値を jsonb にし、更新した後の行と、ロックの下で読んだ旧オーナー / 旧代表者 (membership_audit に書く値と同じ変数) を返す。
--     operator_force_owner_transfer:          {"organization": <更新した後の organizations の行>, "old_owner_id": <uuid>}
--     operator_force_representative_transfer: {"family_group": <更新した後の family_groups の行>, "old_rep_id": <uuid>}
--   route はこの値で監査の from_user_id と知らせの宛先を決める (src/lib/membership/operator-force-transfer-result.ts の Zod スキーマで読む)。
--   本文は最新の定義の逐語で、変えたのは RETURNS と最後の RETURN の 1 文だけ (権限・MFA の判定・ロックとその順・判定・エラーとその順番・
--   書き込み・membership_audit は同じ。CLAUDE.md の組織 / 家族の行のロック順も変えない)。
--   - 戻り値の型が変わるので、CREATE OR REPLACE ではなく DROP してから作る。DROP で権限が消えるので、本番の権限
--     (supabase/baseline/prod_function_acl.sql:143-148: PUBLIC / anon から外し、authenticated と service_role に EXECUTE) を付け直す。
--     関数の所有者は migration を流すロール (postgres) になる (ベースラインの ALTER FUNCTION ... OWNER TO "postgres" と同じ)。
--   - 呼ぶのは route の 2 か所だけ (src の .rpc('operator_force_owner_transfer' / .rpc('operator_force_representative_transfer' は 1 件ずつ)。
--     今の route (この migration より前のアプリ) は戻り値をそのまま応答の data に載せるだけで中身を読まない (画面も data を読まない) ので、
--     この migration を先に当てても今のアプリは動く。逆に新しい route が古い DB (戻り値が行のまま) に当たったときは、先に読んだ値で記録し、
--     食い違いうることをログに残す (route の受け持ち)。
-- 冪等: DROP FUNCTION IF EXISTS → CREATE OR REPLACE → REVOKE / GRANT → COMMENT は何度流しても同じ。既存のデータを書き換える文は無い。
-- 確かめるテスト: tests/operator-transfer-old-owner-migration-contract.test.ts (文面)・
--   tests/integration/security/operator-transfer-old-owner.test.ts (実 DB。戻り値・同時の譲渡・権限)・
--   src/__tests__/api/operator/membership/org-transfer.test.ts・family-transfer.test.ts (route が戻り値の旧オーナー / 旧代表者で監査と知らせを出す)

SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. operator_force_owner_transfer: 本文は 20261022160000_release_membership_owner_race.sql の定義の逐語。RETURNS と最後の RETURN だけを変える
-- ----------------------------------------------------------------
DROP FUNCTION IF EXISTS public.operator_force_owner_transfer(uuid, uuid, text);

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

REVOKE ALL ON FUNCTION public.operator_force_owner_transfer(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.operator_force_owner_transfer(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.operator_force_owner_transfer(uuid, uuid, text) IS
  '運営 (super_admin・MFA 済み) が組織のオーナーを強制的に譲渡する。戻り値は {"organization": 更新した後の organizations の行, "old_owner_id": 組織の行を FOR NO KEY UPDATE でロックして読んだ旧オーナー (membership_audit の old_owner_id と同じ値。同時の譲渡があってもこの譲渡の直前のオーナー)}。#1917';

-- ----------------------------------------------------------------
-- 2. operator_force_representative_transfer: 本文は 20261017130000_operator_mfa_db_gate.sql の定義の逐語。RETURNS と最後の RETURN だけを変える
-- ----------------------------------------------------------------
DROP FUNCTION IF EXISTS public.operator_force_representative_transfer(uuid, uuid, text);

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

REVOKE ALL ON FUNCTION public.operator_force_representative_transfer(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.operator_force_representative_transfer(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.operator_force_representative_transfer(uuid, uuid, text) IS
  '運営 (super_admin・MFA 済み) が家族の代表者を強制的に譲渡する。戻り値は {"family_group": 更新した後の family_groups の行, "old_rep_id": 家族の行を FOR NO KEY UPDATE でロックして読んだ旧代表者 (membership_audit の old_rep_id と同じ値。同時の譲渡があってもこの譲渡の直前の代表者)}。#1917';
