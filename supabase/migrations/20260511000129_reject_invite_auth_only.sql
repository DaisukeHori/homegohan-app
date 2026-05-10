-- migration: 20260511000129_reject_invite_auth_only.sql
-- Round 4 監査 C-2 + C-3
-- reject_org_invite / reject_family_invite を authenticated のみに制限し
-- auth.uid() IS NULL の場合に早期 RAISE を追加する

-- C-2: anon 権限剥奪 → authenticated のみ
REVOKE EXECUTE ON FUNCTION public.reject_org_invite(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.reject_org_invite(TEXT) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.reject_family_invite(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.reject_family_invite(TEXT) TO authenticated;

-- C-3: auth.uid() IS NULL 早期リターンを追加するため CREATE OR REPLACE で再定義

CREATE OR REPLACE FUNCTION public.reject_org_invite(p_token TEXT)
RETURNS organization_invites
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_caller_email TEXT;
BEGIN
  -- C-3: 未認証は即エラー
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invite FROM organization_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status NOT IN ('pending') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  UPDATE organization_invites
    SET status = 'rejected', rejected_at = NOW()
    WHERE id = v_invite.id
    RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', v_invite.organization_id, 'invite_rejected', auth.uid(), NULL,
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_invite;
END $$;

-- GRANT は REVOKE 後に再付与 (上記 REVOKE/GRANT で対応済みだが関数再定義後に念のため再付与)
REVOKE EXECUTE ON FUNCTION public.reject_org_invite(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_org_invite(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_family_invite(p_token TEXT)
RETURNS family_invites
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_invite family_invites;
  v_caller_email TEXT;
BEGIN
  -- C-3: 未認証は即エラー
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invite FROM family_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.status NOT IN ('pending') THEN
    RAISE EXCEPTION 'INVITE_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF lower(v_caller_email) <> lower(v_invite.email) THEN
    RAISE EXCEPTION 'INVITE_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_invites
    SET status = 'rejected', rejected_at = NOW()
    WHERE id = v_invite.id
    RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_rejected', auth.uid(), NULL,
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_invite;
END $$;

REVOKE EXECUTE ON FUNCTION public.reject_family_invite(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_family_invite(TEXT) TO authenticated;
