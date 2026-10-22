-- rollback: 20261022160000_release_membership_owner_race.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻すもの: 2 つの関数を、この migration より前の最新の定義に逐語で戻す。
--   - release_user_membership: 20251126124224_create_meal_planner_tables.sql の定義 (:2803-2832。組織の行を取らず、本人がオーナーかを判定しない)
--   - operator_force_owner_transfer: 20261022140000_org_transfer_toctou.sql の定義 (:191-236。旧オーナーの行へ在籍を見ずに org_role を書く)
--   (tests/release-membership-owner-race-migration-contract.test.ts が、各ファイルの該当行との逐語の一致を見る)
-- signature・戻り値・SECURITY DEFINER・search_path・所有者・EXECUTE 権限は、戻す前後で変わらない (CREATE OR REPLACE)。
-- ⚠️ 戻すと、退会の findBlocker のあとに譲渡の承諾・運営の強制譲渡でオーナーになった人の所属が外れ、organizations.owner_id が
--   所属の無い人を指す組織が残りうる欠陥と、その組織への運営の強制譲渡が CHECK user_profiles_org_consistency (23514) で止まる欠陥が再発する。
--   退会の本体 (src/lib/account-deletion.ts) は IS_ORG_OWNER / CONFLICT_RETRY を受け取らなくなるだけで、そのまま動く。
-- データは戻さない (この migration はデータを変えていない)。
-- 冪等: CREATE OR REPLACE FUNCTION のため、2 回続けて流してもエラーにならない。

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION "public"."release_user_membership"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_org_id UUID;
BEGIN
  SELECT organization_id INTO v_org_id FROM user_profiles WHERE id = p_user_id FOR UPDATE;

  IF v_org_id IS NOT NULL THEN
    -- 対象を無効化してからカウントを減らす (leave_org と同じ冪等パターン)。
    -- WHERE organization_id = v_org_id が不成立 (=既に無効化済み) なら
    -- 0行 UPDATE となり、以降の decrement/監査ログもスキップされる。
    UPDATE user_profiles
      SET organization_id = NULL, org_role = NULL,
          is_active_in_org = FALSE, joined_org_at = NULL,
          roles = array_remove(roles, 'org_admin'),  -- #1235: 所属と一緒に外す
          department_id = NULL  -- #1235: 部署の所属も外す
      WHERE id = p_user_id AND organization_id = v_org_id;

    IF FOUND THEN
      UPDATE org_license_pools
        SET used_licenses = GREATEST(used_licenses - 1, 0), updated_at = NOW()
        WHERE organization_id = v_org_id;

      INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
      VALUES ('organization', v_org_id, 'member_left', p_user_id, p_user_id,
              jsonb_build_object('reason', 'account_delete'));
    END IF;
  END IF;
END $$;

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

  UPDATE user_profiles SET org_role = 'admin' WHERE id = v_old_owner_id;
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
