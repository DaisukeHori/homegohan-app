-- migration: 20261007160000_family_member_limit_row_lock.sql
-- Issue #1213: 家族グループの人数上限 (member_limit) の確認が競合し、同時に参加すると上限を超えて入れてしまう問題を直す
--
-- 背景:
--   accept_family_invite (招待の承諾) と add_family_child (子供の追加) は、
--   「家族の active なメンバー数を数える → 上限未満なら family_members に INSERT する」を、家族の行をロックせずに行っている。
--   - accept_family_invite がロックするのは、承諾する招待の行 (family_invites。token 単位) だけ。
--     同じ家族宛でも招待が別なら別の行なので、承諾どうしは互いを待たない。
--   - add_family_child は、招待の行のロックすらない。
--   そのため、上限 4 人・現在 3 人の家族で、別々の招待を持つ 2 人が同時に承諾する (承諾と子供の追加が同時でも同じ) と、
--   2 人とも「いまは 3 人」と数えて上限を通過し、5 人目が入ってしまう。
--   組織側の同じ問題 (座席数) は #1039 (20260710210039) で org_license_pools の行を FOR UPDATE して直済み。家族側だけ未対応だった。
--   あわせて accept_family_invite は family_groups.status を見ないため、解散済みの家族に宛てた未使用の招待も承諾できた
--   (operator_force_dissolve_family は招待を失効させない)。承諾すると解散済みの家族に active で入り、user_profiles.family_id も入る。
--
-- 変更 (2 関数。どちらも CREATE OR REPLACE。signature・戻り値・属性 (SECURITY DEFINER・search_path = public) は現行のまま):
--   1. 人数を数える前に、その家族の family_groups の行を SELECT ... FOR UPDATE でロックする。
--      同じ家族への承諾・子供の追加は、この 1 行を取り合って 1 件ずつ順に処理される。
--      待たされた側は、先の処理が確定してから人数を数える (READ COMMITTED では文ごとに新しいスナップショットを取るため、
--      先の処理が入れたメンバーが見える) ので、上限を超えられなくなる。ロックする行は家族ごとなので、別の家族どうしは待ち合わない。
--      FOR UPDATE にする理由: family_members への INSERT は family_groups への外部キー確認 (FOR KEY SHARE) を伴う。
--      FOR UPDATE なら、この 2 関数を通らない INSERT も、ロック中は同じ家族の行で待たされる (FOR NO KEY UPDATE だと待たされない)。
--   2. ロックした行の status も確認する。解散済み (status <> 'active') の家族には参加させず FAMILY_NOT_FOUND にする。
--      家族の行が無い場合 (代表者が家族ごと削除した直後など) も同じ。
--   ロック順: accept_family_invite は family_invites (招待) → family_groups (家族)。create_family_invite も
--      「既存の招待を revoke (family_invites) → 新しい招待を INSERT (family_groups への外部キー確認)」の順で同じ向きになり、
--      再招待と承諾が同時に走ってもデッドロックしない。add_family_child は family_groups だけ。
--      (代表者が家族を丸ごと削除する DELETE FROM family_groups は、family_groups → family_invites (CASCADE) の逆向きに取るため、
--       承諾と同時に走るとデッドロックし得る。これは修正前から同じ (承諾の INSERT が family_groups への外部キー確認で同じ行を待つ)
--       で、どちらかが 40P01 で失敗するだけでデータは壊れず、この migration で増えもしない。)
--   add_family_child は、呼び出し者が家族の大人かどうかの確認を先に行い (従来どおり。家族の外の人は、ロックを取る前に
--      NOT_FAMILY_ADULT で弾かれる)、その後でロックする。
--   次は変更しない: create_family_invite の上限確認 (招待を出す時点の早期チェック。メンバーを増やさないので競合しても上限は超えない。
--      上限を守る本体は承諾時の確認)、その他の本文・戻り値・エラーコード。
--   既知の未対応 (修正前から同じで、この migration では直さない): 運営の強制解散 (operator_force_dissolve_family) は
--      family_members → user_profiles → family_groups の順に更新し、家族の行を最初にはロックしない。そのため解散と承諾が
--      ちょうど同時に走ると、解散済みの家族に承諾した人が active のまま残ることがある。解散側のロック順を変えると
--      代表者の移譲承諾 (family_members → family_groups) と逆向きになるため、別途設計して直す。
--
-- 実行権限: CREATE OR REPLACE は権限を変えないが、本番の現行 (supabase/baseline/prod_function_acl.sql) どおり
--   「PUBLIC・anon は実行不可、authenticated と service_role は実行可」を末尾で付け直す (既に同じ状態なら何も変わらない)。
-- 既存データへの影響: なし (関数の本文だけを置き換える。データの更新・削除はしない)。
--
-- 冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/family-member-limit-race.test.ts
-- ロールバック: supabase/rollbacks/20261007160000_family_member_limit_row_lock.down.sql

CREATE OR REPLACE FUNCTION public.accept_family_invite(
  p_token TEXT,
  p_share_meals BOOLEAN DEFAULT TRUE,
  p_share_health BOOLEAN DEFAULT FALSE,
  p_share_menu BOOLEAN DEFAULT TRUE
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite family_invites;
  v_member family_members;
  v_caller_email TEXT;
  v_count INT;
  v_limit INT;
  v_family_status TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- ★ Warning 2: SELECT FOR UPDATE で二重受諾防止
  SELECT * INTO v_invite FROM family_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_invite.status = 'expired' OR v_invite.expires_at < NOW() THEN
    UPDATE family_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status IN ('accepted','rejected','revoked') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- 人数を数える前に、家族の行をロックする (#1213)。別の招待を持つ人の承諾や子供の追加が同時に走っても、
  -- この行を取り合って 1 件ずつ処理されるので、下の人数確認と INSERT の間に他のメンバーが入り込めない。
  -- ロック順は family_invites (上で取得済み) → family_groups。status もこの行で確認し、解散済みの家族には参加させない。
  SELECT member_limit, status INTO v_limit, v_family_status
    FROM family_groups WHERE id = v_invite.family_id FOR UPDATE;
  IF NOT FOUND OR v_family_status <> 'active' THEN
    RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = v_invite.family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (
    family_id, user_id, role, share_meals, share_health, share_menu
  ) VALUES (
    v_invite.family_id, auth.uid(), 'adult', p_share_meals, p_share_health, p_share_menu
  ) RETURNING * INTO v_member;

  -- 所属家族を本人のプロフィールに入れる (#1273)。初期設定より前に承諾した人はまだプロフィール行が無く、
  -- UPDATE だけだと 0 行で終わって family_id が NULL のままになる。行が無ければ既定値 ('Guest' / 'unspecified') で作る。
  -- 初期設定の日時は入れない。accept_child_promotion (20261007112100) と同じ形。
  INSERT INTO user_profiles (id, nickname, age_group, gender, family_id)
  VALUES (auth.uid(), 'Guest', 'unspecified', 'unspecified', v_invite.family_id)
  ON CONFLICT (id) DO UPDATE SET family_id = EXCLUDED.family_id;

  UPDATE family_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_member;
END $$;

CREATE OR REPLACE FUNCTION public.add_family_child(
  p_family_id UUID,
  p_display_name TEXT,
  p_child_profile JSONB
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_member family_members; v_count INT; v_limit INT; v_family_status TEXT;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  -- 人数を数える前に、家族の行をロックする (#1213)。承諾 (accept_family_invite) や別の子供の追加が同時に走っても、
  -- この行を取り合って 1 件ずつ処理されるので、下の人数確認と INSERT の間に他のメンバーが入り込めない。
  -- 大人かどうかの確認は上で先に済ませてあるため、家族の外の人はこのロックを取れない。
  -- ロックを待つ間に解散された家族 (status <> 'active') や削除された家族には追加させない。
  SELECT member_limit, status INTO v_limit, v_family_status
    FROM family_groups WHERE id = p_family_id FOR UPDATE;
  IF NOT FOUND OR v_family_status <> 'active' THEN
    RAISE EXCEPTION 'FAMILY_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*) INTO v_count FROM family_members
    WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (family_id, user_id, role, display_name, child_profile)
  VALUES (p_family_id, NULL, 'child', p_display_name, p_child_profile)
  RETURNING * INTO v_member;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'child_added', auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'display_name', p_display_name));

  RETURN v_member;
END $$;

-- 実行権限を本番の現行どおりに付け直す (PUBLIC・anon は不可、authenticated と service_role は可)。
REVOKE ALL ON FUNCTION public.accept_family_invite(text, boolean, boolean, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_family_invite(text, boolean, boolean, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.add_family_child(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_family_child(uuid, text, jsonb) TO authenticated, service_role;
