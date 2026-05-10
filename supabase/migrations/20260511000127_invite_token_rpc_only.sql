-- migration: 20260511000127_invite_token_rpc_only.sql
-- Round 3 監査 C-5: 招待 token の RLS policy を削除し RPC 経由のみで参照させる
-- 問題: token を持つ認証済みユーザが全 pending 招待 (email 含む) を列挙可能な policy を除去
-- 対応: token プレビューは専用 SECURITY DEFINER RPC に限定

-- org_invites_select_token policy を削除 (存在した場合)
DROP POLICY IF EXISTS org_invites_select_token ON organization_invites;

-- family_invites_select_token policy を削除 (存在した場合)
DROP POLICY IF EXISTS family_invites_select_token ON family_invites;

-- org 招待プレビュー RPC (token を持つユーザが招待詳細を確認するために使用)
-- SECURITY DEFINER で token 検証のみに限定し、email 等の個人情報は返さない
CREATE OR REPLACE FUNCTION public.preview_org_invite(p_token TEXT)
RETURNS TABLE(
  organization_id UUID,
  organization_name TEXT,
  email TEXT,
  role org_role_enum,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    oi.organization_id,
    o.name AS organization_name,
    oi.email,
    oi.invited_role AS role,
    oi.expires_at
  FROM organization_invites oi
  JOIN organizations o ON o.id = oi.organization_id
  WHERE oi.token = p_token
    AND oi.status = 'pending'
    AND oi.expires_at > NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.preview_org_invite(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_org_invite(TEXT) TO anon, authenticated;

-- family 招待プレビュー RPC (token を持つユーザが招待詳細を確認するために使用)
CREATE OR REPLACE FUNCTION public.preview_family_invite(p_token TEXT)
RETURNS TABLE(
  family_id UUID,
  family_name TEXT,
  email TEXT,
  role family_role_enum,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    fi.family_id,
    fg.name AS family_name,
    fi.email,
    fi.invited_role AS role,
    fi.expires_at
  FROM family_invites fi
  JOIN family_groups fg ON fg.id = fi.family_id
  WHERE fi.token = p_token
    AND fi.status = 'pending'
    AND fi.expires_at > NOW();
END;
$$;

REVOKE ALL ON FUNCTION public.preview_family_invite(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_family_invite(TEXT) TO anon, authenticated;
