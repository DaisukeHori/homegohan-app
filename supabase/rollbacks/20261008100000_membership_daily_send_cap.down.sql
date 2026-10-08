-- rollback: 20261008100000_membership_daily_send_cap.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- (推奨) 上限だけを一時的に止めるなら、RPC は戻さず helper を何もしない関数に差し替える (RPC の本文は触らない):
--   CREATE OR REPLACE FUNCTION public.enforce_membership_daily_cap(p_kind TEXT, p_scope_id UUID, p_email TEXT DEFAULT NULL)
--   RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ BEGIN RETURN; END $$;
--
-- (完全に戻す) 5 つの RPC を 20261008100000 より前の本文 (supabase/baseline/prod_schema.sql と同一。これより前の migration で
-- この 5 つを変えたものは無い) に戻してから、helper / トリガー / インデックスを消す。RPC を先に戻すこと
-- (plpgsql は依存を記録しないため、helper を先に消すと RPC が実行時に失敗する)。
-- トリガーが書いた組織の招待の監査行 (membership_audit) は監査履歴として残す (消さない)。
-- signature・戻り値・SECURITY DEFINER / INVOKER・search_path・所有者・EXECUTE 権限は、戻す前後で変わらない。
-- 注意: 戻すと、DB の 24 時間上限が無くなり、アプリ層の上限 (本番は in-memory = インスタンスごとの概算) だけに戻る。
--   Web の route にある RATE_LIMITED の変換 (inviteThrottleFailureFromRpcError) は、DB が返さなくなるだけなので残してよい。

CREATE OR REPLACE FUNCTION public.create_family_invite(
  p_family_id UUID,
  p_email TEXT,
  p_custom_message TEXT DEFAULT NULL
) RETURNS public.family_invites
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

--       監査行は (2) のトリガーが書く
CREATE OR REPLACE FUNCTION public.create_org_invite(
  p_organization_id UUID,
  p_email TEXT,
  p_role public.org_role_enum DEFAULT 'member',
  p_custom_message TEXT DEFAULT NULL
) RETURNS public.organization_invites
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

CREATE OR REPLACE FUNCTION public.request_child_promotion(p_member_id UUID, p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role family_role_enum;
  v_member family_members;
  v_request family_promotion_requests;
  v_token TEXT;
  v_family_name TEXT;
  v_requester_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  -- 認可を先に (email 解決より前 = 列挙オラクルを作らない)。member 不在時も
  -- v_member.family_id = NULL → ロール NULL → NOT_FAMILY_ADULT (存在有無を漏らさない)。
  -- この FOR UPDATE が canonical 順の先頭ロック。同一 member への並行
  -- request/revoke/accept/reject はこの行で完全直列化される。
  SELECT * INTO v_member FROM family_members WHERE id = p_member_id FOR UPDATE;
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_member.family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  -- 対象は active な子供プレースホルダーであること
  -- (user_id IS NULL ⟺ role='child' は family_members_child_profile_consistency CHECK が保証)
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.status <> 'active' THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  -- 既存 pending の失効 (request 行ロックは member 行ロック取得済みの今なら安全)
  UPDATE family_promotion_requests
    SET status = 'revoked', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE member_id = p_member_id AND status = 'pending';

  -- G4: gen_random_bytes は使用禁止 (pgcrypto/search_path 地雷 = 20260511000134 の教訓)
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO family_promotion_requests
    (family_id, member_id, email, token, status, requested_by, expires_at)
  VALUES
    (v_member.family_id, p_member_id, lower(p_email), v_token, 'pending', auth.uid(),
     NOW() + INTERVAL '14 days')
  RETURNING * INTO v_request;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promotion_requested', auth.uid(), NULL,
          jsonb_build_object('member_id', p_member_id, 'request_id', v_request.id,
                             'email', lower(p_email)));

  -- メール文面用の表示名 (auth.users 参照は SECURITY DEFINER 関数本体内のみ = 確立パターン)
  SELECT name INTO v_family_name FROM family_groups WHERE id = v_member.family_id;
  SELECT COALESCE(up.nickname, au.email) INTO v_requester_name
    FROM auth.users au
    LEFT JOIN user_profiles up ON up.id = au.id
    WHERE au.id = auth.uid();

  RETURN jsonb_build_object(
    'id',                  v_request.id,
    'family_id',           v_request.family_id,
    'member_id',           v_request.member_id,
    'member_display_name', v_member.display_name,
    'family_name',         v_family_name,
    'email',               v_request.email,
    'token',               v_request.token,
    'status',              v_request.status,
    'expires_at',          v_request.expires_at,
    'requester_name',      v_requester_name
  );
EXCEPTION
  WHEN deadlock_detected THEN
    -- #1232 v3 (G10): 他機能とのロック交差等で 40P01 になっても 500/UNKNOWN を漏らさず
    -- 再試行可能な競合 (409) として返す。副作用はサブトランザクションごと巻き戻り済み。
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;

CREATE OR REPLACE FUNCTION public.propose_family_representative_transfer(p_family_id UUID, p_to_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role family_role_enum; v_target_role family_role_enum; v_proposal_id UUID;
BEGIN
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = p_family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role <> 'representative' THEN
    RAISE EXCEPTION 'NOT_FAMILY_REPRESENTATIVE' USING ERRCODE = 'P0001';
  END IF;

  SELECT role INTO v_target_role FROM family_members
    WHERE family_id = p_family_id AND user_id = p_to_user_id AND status = 'active';
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_target_role = 'child' THEN
    RAISE EXCEPTION 'CANNOT_TRANSFER_TO_CHILD' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ownership_transfer_proposals
    SET status = 'expired', resolved_at = NOW()
    WHERE scope = 'family' AND scope_id = p_family_id AND status = 'pending';

  INSERT INTO ownership_transfer_proposals (scope, scope_id, from_user_id, to_user_id)
  VALUES ('family', p_family_id, auth.uid(), p_to_user_id)
  RETURNING id INTO v_proposal_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', p_family_id, 'representative_transfer_proposed',
          auth.uid(), p_to_user_id,
          jsonb_build_object('proposal_id', v_proposal_id));

  RETURN v_proposal_id;
END $$;

CREATE OR REPLACE FUNCTION public.propose_org_owner_transfer(p_organization_id UUID, p_to_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_caller_role org_role_enum; v_target_role org_role_enum; v_proposal_id UUID;
BEGIN
  SELECT org_role INTO v_caller_role FROM user_profiles
    WHERE id = auth.uid() AND organization_id = p_organization_id;
  IF v_caller_role IS NULL OR v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'NOT_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  SELECT org_role INTO v_target_role FROM user_profiles
    WHERE id = p_to_user_id AND organization_id = p_organization_id;
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'TARGET_NOT_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  UPDATE ownership_transfer_proposals
    SET status = 'expired', resolved_at = NOW()
    WHERE scope = 'organization' AND scope_id = p_organization_id AND status = 'pending';

  INSERT INTO ownership_transfer_proposals (scope, scope_id, from_user_id, to_user_id)
  VALUES ('organization', p_organization_id, auth.uid(), p_to_user_id)
  RETURNING id INTO v_proposal_id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('organization', p_organization_id, 'owner_transfer_proposed',
          auth.uid(), p_to_user_id,
          jsonb_build_object('proposal_id', v_proposal_id));

  RETURN v_proposal_id;
END $$;

DROP TRIGGER IF EXISTS trg_audit_organization_invite_created ON public.organization_invites;
DROP FUNCTION IF EXISTS public.audit_organization_invite_created();
DROP FUNCTION IF EXISTS public.enforce_membership_daily_cap(TEXT, UUID, TEXT);
DROP INDEX IF EXISTS public.idx_membership_audit_actor_action_created;
DROP INDEX IF EXISTS public.idx_membership_audit_scope_action_created;
