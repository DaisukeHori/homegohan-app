-- migration: 20261022160000_release_membership_owner_race.sql
-- 戻し方: supabase/rollbacks/20261022160000_release_membership_owner_race.down.sql
-- 退会 (src/lib/account-deletion.ts の deleteAccount) の findBlocker (オーナー / 代表者なら 409) のあとに、譲渡の承諾・運営の強制譲渡で
-- オーナーになった人の所属を release_user_membership が外し、organizations.owner_id が所属の無い人を指す組織が残りうる既存の欠陥を直す
-- (CLAUDE.md の「組織 (organizations) を変える関数のロック順 (DB)」・docs/design/family/11-self-dissolve.md §11.3)。
--
-- 背景:
--   退会は findBlocker (organizations.owner_id = 本人なら 409) → 段階 billing → prepare_account_deletion → release_user_membership の順に進む。
--   findBlocker のあと release_user_membership までの間に、本人が譲渡の提案を承諾する (accept_org_owner_transfer) か、運営が本人へ
--   強制譲渡する (operator_force_owner_transfer) と、本人はオーナーになる。release_user_membership (最新の定義は
--   20251126124224_create_meal_planner_tables.sql :2803-2832) は組織の行を取らず、本人がオーナーかを判定しないので、そのまま所属を外す。
--   退会はそのあと deleteUser で organizations.owner_id の外部キー (ON DELETE RESTRICT) に当たって失敗し、アカウントは残るが、
--   組織の owner_id は所属の無い人を指したまま残る。この状態の組織に運営の強制譲渡 (最新の定義は 20261022140000_org_transfer_toctou.sql
--   :191-236) をすると、旧オーナー (owner_id の人) の行へ在籍を見ずに org_role = 'admin' を書き、CHECK user_profiles_org_consistency (23514)
--   で止まって、組織を立て直せない。
--
-- 変更 (2 つの関数):
--   1. release_user_membership: 本人の所属の組織をロックを取らずに読み、組織の行 (FOR NO KEY UPDATE) → 本人の user_profiles
--      (FOR NO KEY UPDATE) の順に取ってから判定する (CLAUDE.md の組織のロック順。組織の行を、ほかのどの user_profiles の行よりも先に取る)。
--        - ロックの下で読んだ本人の所属が、最初に読んだ組織でなければ: 所属が無い (ほかの処理がもう外した) なら何もしない (従来の冪等のまま)。
--          別の組織に入っていれば CONFLICT_RETRY (既存のコード。その組織の行を取らずに所属を外さない。退会はやり直しで片付く)。
--        - 本人がロックした組織の行の owner_id なら IS_ORG_OWNER (既存のコード。leave_org と同じ。所属は外さない)。
--          退会の本体は、これを findBlocker と同じ 409 (ACCOUNT_DELETE_BLOCKED_ORG_OWNER) にする。
--        - それ以外は従来どおり (所属を外す UPDATE・席数を 1 減らす・監査の member_left は逐語で同じ)。
--      譲渡の承諾・運営の強制譲渡も組織の行を最初に取るので、組織の行で直列になる:
--        譲渡が先なら、release_user_membership は譲渡の commit を待ってから新しい owner_id を読み、IS_ORG_OWNER で止まる。
--        release_user_membership が先なら、譲渡は commit を待ってから本人の所属が外れているのを読み、
--        TRANSFER_ACCEPTOR_NOT_IN_ORG / TARGET_NOT_IN_ORG で止まる (所属の外れた行に org_role を書かない。23514 にならない)。
--   2. operator_force_owner_transfer: 旧オーナーの行への UPDATE に AND organization_id = p_organization_id を足し、所属の外れた行
--      (上の既存の状態の組織) に org_role を書かない (23514 にならない。新しいオーナーへの譲渡は通るので、組織を立て直せる)。
--      本文は 20261022140000 の定義の、その 1 文だけを変えたもの (権限・MFA・ロック・判定・エラーとその順番・監査・戻り値は同じ)。
--
-- 家族の側 (代表者) に同じ型は無い: 退会は家族の所属を関数で外さない (family_members は deleteUser の CASCADE で消える)。
-- findBlocker のあとに代表者になった人は、deleteUser が family_groups.representative_id の外部キー (ON DELETE RESTRICT) に当たって
-- 失敗するので、所属が残ったままの代表者になる (所属の無い人を representative_id が指す状態にはならない)。
--
-- ロックの向き (この migration のあと):
--   release_user_membership: organizations → 本人の user_profiles → org_license_pools
--   (ほかの組織の関数は 20261022140000 の見出しのまま。operator_force_owner_transfer の向きも変えない)
-- 規則 (20261022140000 の見出し): (1) 提案の行・招待の行 → (2) organizations → (3) user_profiles → (4) org_license_pools の順にしか取らない。
--   release_user_membership は (2) の組織の行を持ってから (3) の本人の行を 1 つだけ取るので、この規則に合う。
--   組織の行を取らない関数 (脱退・除名) は (3) の行を 1 つだけ取って (4) へ進み、(2) を待たないので、待ちの輪はできない。
--   最初の所属の読み出しはロックを取らない (どの組織の行を取るかを決めるだけ。判定はロックの下で読み直した値で行う)。
--
-- signature・戻り値・SECURITY DEFINER・search_path・所有者・EXECUTE 権限 (2 つの関数とも) は変えない
-- (CREATE OR REPLACE のため、権限はそのまま残る。release_user_membership の EXECUTE は service_role だけ)。
-- 既存データへの影響: なし (関数の本文の置き換えだけ。すでに残っている「所属の無い人を owner_id が指す組織」は、運営の強制譲渡で立て直せる)。
-- 冪等: CREATE OR REPLACE FUNCTION のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/org-transfer-toctou-release-membership.test.ts (実 DB)
--       tests/release-membership-owner-race-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. release_user_membership (SECURITY DEFINER のまま)。本文は 20251126124224 の定義に、組織の行のロックとロックの下の判定を足したもの
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."release_user_membership"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_org_id UUID;
  v_org_owner_id UUID;
  v_locked_org_id UUID;
BEGIN
  -- どの組織の行を取るかを決めるためだけに、所属をロックを取らずに読む (判定は下でロックしてから読み直した値で行う)
  SELECT organization_id INTO v_org_id FROM user_profiles WHERE id = p_user_id;

  IF v_org_id IS NOT NULL THEN
    -- LOCK-ORDER (docs/design/family/11-self-dissolve.md §11.3・CLAUDE.md の組織のロック順):
    -- 組織の行 (FOR NO KEY UPDATE) → 本人の user_profiles (FOR NO KEY UPDATE) → org_license_pools。
    -- 譲渡の承諾・運営の強制譲渡も組織の行を最初に取るので、組織の行で直列になる。譲渡が先なら新しい owner_id を読んで IS_ORG_OWNER で止まり、
    -- こちらが先なら譲渡は所属の外れた本人を読んで止まる (所属の無い人を owner_id が指す組織を残さない)。
    -- owner_id を書くのは組織の行を持った関数だけなので、ここで読んだ owner_id は commit まで変わらない
    SELECT owner_id INTO v_org_owner_id FROM organizations WHERE id = v_org_id FOR NO KEY UPDATE;
    SELECT organization_id INTO v_locked_org_id FROM user_profiles WHERE id = p_user_id FOR NO KEY UPDATE;

    IF v_locked_org_id IS DISTINCT FROM v_org_id THEN
      -- 最初に読んだあとに所属が変わった。別の組織に入っていれば、その組織の行を取っていないので外さない (退会はやり直しで片付く)
      IF v_locked_org_id IS NOT NULL THEN
        RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
      END IF;
      -- 所属が無い (ほかの処理がもう外した) なら、従来どおり何もしない
      RETURN;
    END IF;

    -- オーナーの所属は外さない (譲渡か解散が先。leave_org と同じコード)
    IF v_org_owner_id = p_user_id THEN
      RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
    END IF;

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

-- ----------------------------------------------------------------
-- 2. operator_force_owner_transfer (SECURITY DEFINER のまま)。本文は 20261022140000 の定義の、旧オーナーの行への UPDATE に
--    AND organization_id = p_organization_id を足しただけ
-- ----------------------------------------------------------------
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
