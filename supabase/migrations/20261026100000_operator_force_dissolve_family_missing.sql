-- migration: 20261026100000_operator_force_dissolve_family_missing.sql
-- 戻し方: supabase/rollbacks/20261026100000_operator_force_dissolve_family_missing.down.sql
-- 運営の家族の強制解散 (operator_force_dissolve_family) が、無い家族・解散済みの家族でも成功して監査を残す既存の欠陥を直す。
--
-- 背景:
--   operator_force_dissolve_family (最新の定義は 20261019120000_self_dissolve.sql:287-320) は、権限と MFA の判定のあと家族の行を
--   FOR NO KEY UPDATE で読むが、行の有無も status も見ずに後始末 (family_dissolve_apply) と membership_audit の INSERT を行う。
--     (a) 無い家族の id: 後始末の UPDATE が 0 行で、戻り値は NULL。それでも membership_audit に operator_force_dissolve が 1 行残り、
--         route (POST /api/operator/membership/family/{id}/dissolve) は RPC が失敗しないので admin_audit_logs
--         (super_admin.family.dissolve) にも 1 行書いて 200 { data: null } を返す。運営の画面は成功に見える。
--     (b) 解散済みの家族: 後始末がもう一度走って dissolved_at を上書きし (解散から 90 日の purge の数え直しになる)、
--         membership_audit と admin_audit_logs に 2 回目の解散の記録が残る。運営 2 人がほぼ同時に解散したときも、後の方は
--         家族の行のロックを待ったあと解散済みの行を読み、同じことになる。
--   組織の強制解散 (operator_force_dissolve_org) と、代表者の解散 (dissolve_family_by_representative) は、行をロックして
--   読んだあと、無ければ ORG_NOT_FOUND / FAMILY_NOT_FOUND、dissolved なら ORG_ALREADY_DISSOLVED / FAMILY_ALREADY_DISSOLVED で止める。
--
-- 変更 (1 つの関数。名前・引数・戻り値の型・属性 (SECURITY DEFINER・search_path)・権限は変えないので CREATE OR REPLACE):
--   operator_force_dissolve_family: 家族の行の読み出し (FOR NO KEY UPDATE。ロックの順は変えない) を行全体にし、その下で
--     行が無ければ FAMILY_NOT_FOUND、status が 'dissolved' なら FAMILY_ALREADY_DISSOLVED (どちらも P0001) で止める
--     (family_groups.status は 'active' / 'dissolved' の 2 値。CHECK family_groups_status_check)。
--     止めたときは後始末も membership_audit の INSERT もしない (例外でトランザクションごと巻き戻る)。
--   エラーの順番: NOT_OPERATOR → OPERATOR_MFA_REQUIRED → FAMILY_NOT_FOUND → FAMILY_ALREADY_DISSOLVED。
--   本文はこの 2 つの判定と、読み出しを行全体にしたことのほかは 20261019120000 の定義の逐語 (権限・MFA の判定・ロック・後始末・
--   監査の action と metadata (previous_representative_id はロックの下で読んだ代表者)・戻り値は同じ)。
--   route は membership-errors の表 (FAMILY_NOT_FOUND → 404・FAMILY_ALREADY_DISSOLVED → 409) で返し、監査とメールを出さない
--   (src/lib/membership/operator-rpc-errors.ts の operator_force_dissolve_family の行)。
--
-- 既存データへの影響: なし (関数の本文だけを置き換える。データを書き換える文は無い)。
-- 冪等: CREATE OR REPLACE は何度流しても同じ。
-- 確かめるテスト: tests/operator-force-dissolve-family-missing-migration-contract.test.ts (文面)・
--   tests/integration/security/self-dissolve.test.ts の D-17 (実 DB)・tests/integration/security/family-lock-order-race.test.ts の C5 (同時の 2 回)・
--   tests/operator-membership-rpc-errors-1917.test.ts (route の 404 / 409)
-- ロールバック: supabase/rollbacks/20261026100000_operator_force_dissolve_family_missing.down.sql

SET LOCAL lock_timeout = '10s';

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

  -- LOCK-ORDER (#1310): family_groups -> family_members -> user_profiles。最初に家族の行をロックし、元の代表者と status をそのロック下で読む。
  -- 無い家族・解散済みの家族は、後始末と監査の前に止める (組織の強制解散 operator_force_dissolve_org・代表者の解散 dissolve_family_by_representative と同じ形)。
  -- 同時に 2 回呼ばれたときは、後の方がロックを待ったあと dissolved の行を読んで FAMILY_ALREADY_DISSOLVED になる
  SELECT * INTO v_fam FROM family_groups WHERE id = p_family_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_fam.status = 'dissolved' THEN
    RAISE EXCEPTION 'FAMILY_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;
  v_prev_rep := v_fam.representative_id;

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
