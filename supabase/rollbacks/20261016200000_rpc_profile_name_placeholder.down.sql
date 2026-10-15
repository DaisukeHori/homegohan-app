-- rollback: 20261016200000_rpc_profile_name_placeholder.sql
-- get_invite_details・get_promotion_details・create_family_group を 20251126124224_create_meal_planner_tables.sql の定義
-- (nickname をそのまま名前として返す・写す形) に戻し、そのあとで public.normalize_profile_name(text) を消す (#1678)。
-- 戻しても、すでに作った family_members の display_name はそのまま残る (データは戻さない)。
-- 3 つの RPC の実行権限は、この migration が変えていないため、ここでも触らない (CREATE OR REPLACE は権限を残す)。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 何度流しても同じ結果になる (CREATE OR REPLACE と DROP FUNCTION IF EXISTS)。

CREATE OR REPLACE FUNCTION "public"."get_invite_details"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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

CREATE OR REPLACE FUNCTION "public"."get_promotion_details"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_request family_promotion_requests;
  v_family_name TEXT;
  v_member_name TEXT;
  v_requested_by_name TEXT;
  v_email_matches BOOLEAN;
BEGIN
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN NULL; -- 見つからない場合 NULL (get_invite_details と同じ)
  END IF;

  SELECT name INTO v_family_name FROM family_groups WHERE id = v_request.family_id;
  SELECT display_name INTO v_member_name FROM family_members WHERE id = v_request.member_id;
  SELECT COALESCE(up.nickname, au.email) INTO v_requested_by_name
    FROM auth.users au
    LEFT JOIN user_profiles up ON up.id = au.id
    WHERE au.id = v_request.requested_by;

  v_email_matches := FALSE;
  IF auth.uid() IS NOT NULL THEN
    SELECT lower(au.email) = lower(v_request.email)
      INTO v_email_matches
      FROM auth.users au WHERE au.id = auth.uid();
  END IF;

  RETURN jsonb_build_object(
    'family_name', v_family_name,
    'member_display_name', v_member_name,
    'requested_by_name', v_requested_by_name,
    'email', v_request.email,
    'status', v_request.status,
    'expires_at', v_request.expires_at,
    'current_user_email_matches', v_email_matches
  );
END $$;

CREATE OR REPLACE FUNCTION "public"."create_family_group"("p_name" "text", "p_plan_key" "text" DEFAULT 'free'::"text") RETURNS "public"."family_groups"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE v_group family_groups;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO family_groups (name, representative_id, plan_key)
  VALUES (p_name, auth.uid(), p_plan_key)
  RETURNING * INTO v_group;

  INSERT INTO family_members (family_id, user_id, role, display_name)
  VALUES (v_group.id, auth.uid(), 'representative',
          (SELECT nickname FROM user_profiles WHERE id = auth.uid()));

  UPDATE user_profiles SET family_id = v_group.id WHERE id = auth.uid();

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id)
  VALUES ('family', v_group.id, 'group_created', auth.uid(), auth.uid());

  RETURN v_group;
END $$;

-- 3 つの RPC が normalize_profile_name を呼ばなくなってから消す
DROP FUNCTION IF EXISTS public.normalize_profile_name(TEXT);
