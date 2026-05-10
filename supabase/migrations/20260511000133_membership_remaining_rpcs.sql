-- migration: 20260511000133_membership_remaining_rpcs.sql
-- 残 RPC: revoke_org_invite, revoke_family_invite, get_invite_details,
--         update_my_share_settings, is_inactive_user,
--         list_orgs_with_inactive_owner, list_families_with_inactive_representative

-- ----------------------------------------------------------------
-- 1. revoke_org_invite
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_org_invite(p_invite_id UUID)
RETURNS organization_invites
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_caller_org_id UUID;
  v_caller_role org_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 招待を取得
  SELECT * INTO v_invite FROM organization_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 呼び出し元が対象 org の owner/admin か検証
  SELECT organization_id, org_role INTO v_caller_org_id, v_caller_role
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_org_id IS DISTINCT FROM v_invite.organization_id
     OR v_caller_role IS NULL
     OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  -- pending のみ revoke 可能
  UPDATE organization_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE id = p_invite_id AND status = 'pending'
    RETURNING * INTO v_invite;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_revoked', auth.uid(),
          jsonb_build_object('invite_id', p_invite_id));

  RETURN v_invite;
END $$;

REVOKE EXECUTE ON FUNCTION public.revoke_org_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_org_invite TO authenticated;

-- ----------------------------------------------------------------
-- 2. revoke_family_invite
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_family_invite(p_invite_id UUID)
RETURNS family_invites
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_invite family_invites;
  v_caller_role family_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- 招待を取得
  SELECT * INTO v_invite FROM family_invites WHERE id = p_invite_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- 呼び出し元が対象 family の representative/adult か検証
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_invite.family_id AND user_id = auth.uid() AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative', 'adult') THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  -- pending のみ revoke 可能
  UPDATE family_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE id = p_invite_id AND status = 'pending'
    RETURNING * INTO v_invite;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_revoked', auth.uid(),
          jsonb_build_object('invite_id', p_invite_id));

  RETURN v_invite;
END $$;

REVOKE EXECUTE ON FUNCTION public.revoke_family_invite FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_family_invite TO authenticated;

-- ----------------------------------------------------------------
-- 3. get_invite_details  (認証不要: anon + authenticated)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_invite_details(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_org_invite  organization_invites;
  v_fam_invite  family_invites;
  v_org_name    TEXT;
  v_fam_name    TEXT;
  v_invited_by_name TEXT;
  v_is_existing BOOLEAN;
  v_email_matches BOOLEAN;
BEGIN
  -- org 招待を検索
  SELECT * INTO v_org_invite
    FROM organization_invites
    WHERE token = p_token;

  IF FOUND THEN
    -- 組織名
    SELECT name INTO v_org_name FROM organizations WHERE id = v_org_invite.organization_id;

    -- 招待者名
    SELECT COALESCE(up.nickname, au.email) INTO v_invited_by_name
      FROM user_profiles up
      JOIN auth.users au ON au.id = up.id
      WHERE up.id = v_org_invite.invited_by;

    -- 既存ユーザー判定
    SELECT EXISTS(SELECT 1 FROM auth.users WHERE lower(email) = lower(v_org_invite.email))
      INTO v_is_existing;

    -- caller の email 一致判定
    v_email_matches := FALSE;
    IF auth.uid() IS NOT NULL THEN
      SELECT lower(au.email) = lower(v_org_invite.email)
        INTO v_email_matches
        FROM auth.users au WHERE au.id = auth.uid();
    END IF;

    RETURN jsonb_build_object(
      'scope',                   'organization',
      'scope_id',                v_org_invite.organization_id,
      'scope_name',              v_org_name,
      'role',                    v_org_invite.invited_role,
      'invited_by_name',         v_invited_by_name,
      'expires_at',              v_org_invite.expires_at,
      'email',                   v_org_invite.email,
      'status',                  v_org_invite.status,
      'is_existing_user',        v_is_existing,
      'current_user_email_matches', v_email_matches
    );
  END IF;

  -- family 招待を検索
  SELECT * INTO v_fam_invite
    FROM family_invites
    WHERE token = p_token;

  IF FOUND THEN
    -- 家族名
    SELECT name INTO v_fam_name FROM family_groups WHERE id = v_fam_invite.family_id;

    -- 招待者名
    SELECT COALESCE(up.nickname, au.email) INTO v_invited_by_name
      FROM user_profiles up
      JOIN auth.users au ON au.id = up.id
      WHERE up.id = v_fam_invite.invited_by;

    -- 既存ユーザー判定
    SELECT EXISTS(SELECT 1 FROM auth.users WHERE lower(email) = lower(v_fam_invite.email))
      INTO v_is_existing;

    -- caller の email 一致判定
    v_email_matches := FALSE;
    IF auth.uid() IS NOT NULL THEN
      SELECT lower(au.email) = lower(v_fam_invite.email)
        INTO v_email_matches
        FROM auth.users au WHERE au.id = auth.uid();
    END IF;

    RETURN jsonb_build_object(
      'scope',                   'family',
      'scope_id',                v_fam_invite.family_id,
      'scope_name',              v_fam_name,
      'role',                    v_fam_invite.invited_role,
      'invited_by_name',         v_invited_by_name,
      'expires_at',              v_fam_invite.expires_at,
      'email',                   v_fam_invite.email,
      'status',                  v_fam_invite.status,
      'is_existing_user',        v_is_existing,
      'current_user_email_matches', v_email_matches
    );
  END IF;

  -- 見つからない場合 NULL
  RETURN NULL;
END $$;

REVOKE EXECUTE ON FUNCTION public.get_invite_details FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_invite_details TO anon, authenticated;

-- ----------------------------------------------------------------
-- 4. update_my_share_settings
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_my_share_settings(
  p_share_meals  BOOLEAN,
  p_share_health BOOLEAN,
  p_share_menu   BOOLEAN
) RETURNS family_members
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_member family_members;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_members
    SET share_meals  = p_share_meals,
        share_health = p_share_health,
        share_menu   = p_share_menu
    WHERE user_id = auth.uid() AND status = 'active'
    RETURNING * INTO v_member;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_member;
END $$;

REVOKE EXECUTE ON FUNCTION public.update_my_share_settings FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_my_share_settings TO authenticated;

-- ----------------------------------------------------------------
-- 5. is_inactive_user
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_inactive_user(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_last_sign_in TIMESTAMPTZ;
BEGIN
  SELECT last_sign_in_at
  INTO v_last_sign_in
  FROM auth.users
  WHERE id = p_user_id;

  -- ユーザーが存在しない
  IF NOT FOUND THEN
    RETURN TRUE;
  END IF;

  -- 30 日以上 sign-in なし または一度もサインインしていない
  RETURN (v_last_sign_in IS NULL OR v_last_sign_in < NOW() - INTERVAL '30 days');
END $$;

REVOKE EXECUTE ON FUNCTION public.is_inactive_user FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_inactive_user TO authenticated;

-- ----------------------------------------------------------------
-- 6. list_orgs_with_inactive_owner
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_orgs_with_inactive_owner()
RETURNS TABLE (
  organization_id       UUID,
  organization_name     TEXT,
  owner_user_id         UUID,
  owner_email           TEXT,
  owner_last_sign_in    TIMESTAMPTZ,
  member_count          BIGINT,
  dissolved             BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  -- super_admin チェック
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    o.id                          AS organization_id,
    o.name                        AS organization_name,
    up.id                         AS owner_user_id,
    au.email                      AS owner_email,
    au.last_sign_in_at            AS owner_last_sign_in,
    (SELECT COUNT(*)
       FROM user_profiles mp
       WHERE mp.organization_id = o.id
    )                             AS member_count,
    (o.status = 'dissolved')      AS dissolved
  FROM organizations o
  JOIN user_profiles up ON up.organization_id = o.id AND up.org_role = 'owner'
  JOIN auth.users au ON au.id = up.id
  WHERE au.last_sign_in_at IS NULL
     OR au.last_sign_in_at < NOW() - INTERVAL '30 days';
END $$;

REVOKE EXECUTE ON FUNCTION public.list_orgs_with_inactive_owner FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_orgs_with_inactive_owner TO authenticated;

-- ----------------------------------------------------------------
-- 7. list_families_with_inactive_representative
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_families_with_inactive_representative()
RETURNS TABLE (
  family_id                UUID,
  family_name              TEXT,
  representative_user_id   UUID,
  representative_email     TEXT,
  member_count             BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  -- super_admin チェック
  IF NOT EXISTS (
    SELECT 1 FROM user_profiles
    WHERE id = auth.uid() AND 'super_admin' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_PERMISSION' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    fg.id                         AS family_id,
    fg.name                       AS family_name,
    fm.user_id                    AS representative_user_id,
    au.email                      AS representative_email,
    (SELECT COUNT(*)
       FROM family_members mc
       WHERE mc.family_id = fg.id AND mc.status = 'active'
    )                             AS member_count
  FROM family_groups fg
  JOIN family_members fm ON fm.family_id = fg.id
                         AND fm.role = 'representative'
                         AND fm.status = 'active'
  JOIN auth.users au ON au.id = fm.user_id
  WHERE fg.status = 'active'
    AND (au.last_sign_in_at IS NULL
         OR au.last_sign_in_at < NOW() - INTERVAL '30 days');
END $$;

REVOKE EXECUTE ON FUNCTION public.list_families_with_inactive_representative FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_families_with_inactive_representative TO authenticated;
