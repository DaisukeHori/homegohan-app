-- rollback: 20261007150200_invite_accept_creates_missing_profile.sql
-- 2 関数を 2026-10-06 時点の本番の定義 (supabase/baseline/prod_schema.sql) へ戻す。
-- ⚠️ 戻すと、初期設定前に招待を承諾した人の所属 (family_id / organization_id など) が再び入らなくなる (#1273 の再発)。
-- データは戻さない: 適用後に作られた 'Guest' のプロフィール行は、初期設定を後回しにした人の行と区別がつかず、
--   消すと所属も一緒に失われる。消さない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

CREATE OR REPLACE FUNCTION "public"."accept_family_invite"("p_token" "text", "p_share_meals" boolean DEFAULT true, "p_share_health" boolean DEFAULT false, "p_share_menu" boolean DEFAULT true) RETURNS "public"."family_members"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite family_invites;
  v_member family_members;
  v_caller_email TEXT;
  v_count INT;
  v_limit INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

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

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = v_invite.family_id;
  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = v_invite.family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_members (
    family_id, user_id, role, share_meals, share_health, share_menu
  ) VALUES (
    v_invite.family_id, auth.uid(), 'adult', p_share_meals, p_share_health, p_share_menu
  ) RETURNING * INTO v_member;

  UPDATE user_profiles SET family_id = v_invite.family_id WHERE id = auth.uid();

  UPDATE family_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_member;
END $$;

CREATE OR REPLACE FUNCTION "public"."accept_org_invite"("p_token" "text") RETURNS "public"."user_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_invite organization_invites;
  v_user_profile user_profiles;
  v_caller_email TEXT;
  v_total_licenses INT;
  v_used_licenses INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 招待 fetch (★ Warning 2: SELECT FOR UPDATE で二重受諾防止)
  SELECT * INTO v_invite FROM organization_invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 状態チェック
  IF v_invite.status = 'expired' OR v_invite.expires_at < NOW() THEN
    UPDATE organization_invites SET status = 'expired' WHERE id = v_invite.id;
    RAISE EXCEPTION 'INVITE_EXPIRED' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status IN ('accepted','rejected','revoked') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- email 一致チェック (auth.users から caller の email 取得)
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- 既に他組織所属チェック
  SELECT * INTO v_user_profile FROM user_profiles WHERE id = auth.uid();
  IF v_user_profile.organization_id IS NOT NULL
     AND v_user_profile.organization_id <> v_invite.organization_id THEN
    RAISE EXCEPTION 'ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- 自身が別 org の owner か (owner は脱退不可)
  IF EXISTS (SELECT 1 FROM organizations WHERE owner_id = auth.uid()
             AND id <> v_invite.organization_id) THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  -- メンバ化
  UPDATE user_profiles
    SET organization_id = v_invite.organization_id,
        org_role = v_invite.invited_role,
        joined_org_at = CURRENT_DATE,
        is_active_in_org = TRUE
    WHERE id = auth.uid()
    RETURNING * INTO v_user_profile;

  -- 招待消化
  UPDATE organization_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  -- ★ F3-08: ライセンス使用数 increment 直前に上限を再チェック (座席超過防止)
  -- create_org_invite は発行時にしか上限を見ないため、複数招待の先行発行 →
  -- 全員 accept で座席超過するのを防ぐ。FOR UPDATE で同時実行時の競合も防止。
  SELECT total_licenses, used_licenses INTO v_total_licenses, v_used_licenses
    FROM org_license_pools WHERE organization_id = v_invite.organization_id FOR UPDATE;

  IF v_total_licenses IS NOT NULL AND v_used_licenses >= v_total_licenses THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- ライセンス使用数 increment
  UPDATE org_license_pools
    SET used_licenses = used_licenses + 1, updated_at = NOW()
    WHERE organization_id = v_invite.organization_id;

  -- 監査ログ
  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id, 'role', v_invite.invited_role));

  RETURN v_user_profile;
END $$;
