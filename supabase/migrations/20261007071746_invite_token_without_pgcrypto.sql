-- migration: 20261007071746_invite_token_without_pgcrypto.sql
-- 組織・家族の招待 RPC (create_org_invite / create_family_invite) が本番で必ず失敗する不具合を直す
--
-- 背景:
--   本番 (2026-10-06 のスナップショット) の 2 つの RPC は、招待トークンを encode(gen_random_bytes(32), 'hex') で作っていた。
--   gen_random_bytes は pgcrypto の関数で、Supabase では extensions スキーマにある。2 つの RPC は search_path を public に
--   固定しているため解決できず、`42883 function gen_random_bytes(integer) does not exist` で必ず失敗する
--   (Web の「メンバーを招待」(POST /api/org/invites) と家族の招待が 500 になる)。
--   修正版の 20260511000134_fix_gen_random_bytes.sql (gen_random_uuid() でトークンを作る) は台帳上は適用済みだが、
--   本番の関数本文は 20260511000105 / 000115 の古い版のままだった。関数本文の比較で見つけた
--   (属性 (DEFINER / INVOKER、search_path、権限) は一致していたため、2026-10-06 のドリフト調査では見つからなかった)。
--
-- 変更:
--   20260511000134 の 2 つの関数定義を、そのまま適用し直す (トークンは gen_random_uuid() 2 つ分の 64 文字の 16 進数)。
--   本番の現行本文との違いはトークン生成の 1 行とコメントだけで、トークンの形式 (64 文字の 16 進数) は変わらない。
--   CREATE OR REPLACE のため、所有者と EXECUTE 権限は本番の現行のまま (000134 の REVOKE / GRANT は流さない)。
--   create_org_invite は SECURITY INVOKER、create_family_invite は SECURITY DEFINER で、本番の現行と同じ。
--
-- 冪等: CREATE OR REPLACE FUNCTION。
-- ロールバック: supabase/rollbacks/20261007071746_invite_token_without_pgcrypto.down.sql

CREATE OR REPLACE FUNCTION public.create_org_invite(
  p_organization_id UUID,
  p_email TEXT,
  p_role org_role_enum DEFAULT 'member',
  p_custom_message TEXT DEFAULT NULL
) RETURNS organization_invites
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public AS $$
DECLARE
  v_invite organization_invites;
  v_token TEXT;
  v_caller_org_id UUID;
  v_caller_role org_role_enum;
  v_seat_limit INT;
  v_used_seats INT;
BEGIN
  -- 呼び出し元が同 org の admin/owner か検証
  SELECT organization_id, org_role INTO v_caller_org_id, v_caller_role
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_org_id IS DISTINCT FROM p_organization_id OR v_caller_role IS NULL OR v_caller_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  -- seat 上限チェック (org_license_pools)
  SELECT total_licenses, used_licenses INTO v_seat_limit, v_used_seats
    FROM org_license_pools WHERE organization_id = p_organization_id;

  IF v_seat_limit IS NOT NULL AND v_used_seats >= v_seat_limit THEN
    RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- token 生成: gen_random_uuid() x2 → 64 文字 hex (pgcrypto 不要)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  -- 既存 pending を invalidate (revoke)
  UPDATE organization_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE organization_id = p_organization_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO organization_invites (
    organization_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_organization_id, lower(p_email), v_token, p_role, p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  RETURN v_invite;
END $$;

CREATE OR REPLACE FUNCTION public.create_family_invite(
  p_family_id UUID,
  p_email TEXT,
  p_custom_message TEXT DEFAULT NULL
) RETURNS family_invites
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invite family_invites;
  v_token TEXT;
  v_caller_role family_role_enum;
  v_count INT;
  v_limit INT;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT member_limit INTO v_limit FROM family_groups WHERE id = p_family_id;
  SELECT COUNT(*) INTO v_count FROM family_members WHERE family_id = p_family_id AND status = 'active';
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'MEMBER_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  -- token 生成: gen_random_uuid() x2 → 64 文字 hex (pgcrypto 不要)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  -- 既存 pending を revoke
  UPDATE family_invites
    SET status = 'revoked', revoked_at = NOW(), revoked_by = auth.uid()
    WHERE family_id = p_family_id
      AND lower(email) = lower(p_email)
      AND status = 'pending';

  INSERT INTO family_invites (
    family_id, email, token, invited_role, custom_message,
    status, expires_at, created_at, invited_by
  ) VALUES (
    p_family_id, lower(p_email), v_token, 'adult', p_custom_message,
    'pending', NOW() + INTERVAL '14 days', NOW(), auth.uid()
  )
  RETURNING * INTO v_invite;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, metadata)
  VALUES ('family', p_family_id, 'invite_created', auth.uid(),
          jsonb_build_object('invite_id', v_invite.id, 'email', lower(p_email)));

  RETURN v_invite;
END $$;
