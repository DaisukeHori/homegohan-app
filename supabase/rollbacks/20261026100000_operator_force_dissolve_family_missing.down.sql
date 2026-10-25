-- rollback: 20261026100000_operator_force_dissolve_family_missing.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻すもの: operator_force_dissolve_family を 20261019120000_self_dissolve.sql の定義 (:287-320) に逐語で戻す
--   (tests/operator-force-dissolve-family-missing-migration-contract.test.ts が同ファイルの該当行との逐語の一致を見る)。
--   名前・引数・戻り値の型は up と同じなので CREATE OR REPLACE で置き換わり、権限 (EXECUTE の GRANT / REVOKE) は up で変えていないのでそのまま残る。
--   ⚠️ 戻すと、無い家族・解散済みの家族への強制解散がまた成功し、membership_audit (と route の admin_audit_logs) に解散の記録が残る
--   (解散済みの家族は dissolved_at が上書きされる)。route は FAMILY_NOT_FOUND / FAMILY_ALREADY_DISSOLVED を受け取らなくなるだけで、壊れはしない。
-- 戻らないもの: なし (up はデータを書き換えない)。
-- 冪等: CREATE OR REPLACE。

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
