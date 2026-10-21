-- rollback: 20261022130000_family_invite_plan_gate.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻すもの: create_family_invite を、この migration より前の最新の定義に逐語で戻す。
--   - create_family_invite: 20261008100000_membership_daily_send_cap.sql の定義 (:256-308。家族プランの門が無い)
--   (tests/family-invite-plan-gate-migration-contract.test.ts が、該当行との逐語の一致を見る)
-- 引数・戻り値・SECURITY DEFINER・search_path・所有者・EXECUTE 権限は、戻す前後で変わらない (CREATE OR REPLACE)。
-- ⚠️ 戻すと #1912 の取りこぼしが再発する: 家族プランの無い (plan_key = free の) グループでも招待を作れ、招待のメールが送られ、
--   承諾の時に FAMILY_PLAN_REQUIRED で断られる。
-- データは戻さない (この migration はデータを変えていない)。
-- 冪等: CREATE OR REPLACE FUNCTION のため、2 回続けて流してもエラーにならない。

SET LOCAL lock_timeout = '10s';

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

  -- #1163: 24 時間の作成上限 (招待者ごと 20 / 同じ家族から同じ宛先へ 3)。超過は 'RATE_LIMITED'
  PERFORM public.enforce_membership_daily_cap('family_invite', p_family_id, p_email);

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
