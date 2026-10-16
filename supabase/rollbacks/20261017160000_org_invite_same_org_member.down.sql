-- rollback: 20261017160000_org_invite_same_org_member.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 2 つの RPC を 20261017160000 より前の定義に戻してから、helper を消す。RPC を先に戻すこと
-- (plpgsql は依存を記録しないため、helper を先に消すと create_org_invite が実行時に失敗する)。
--   - create_org_invite: 20261008100000_membership_daily_send_cap.sql の定義 (宛先の判定なし)
--   - accept_org_invite: 20261007150200_invite_accept_creates_missing_profile.sql の定義 (同じ組織の在籍者を通す)
-- signature・戻り値・SECURITY DEFINER / INVOKER・search_path・所有者・EXECUTE 権限は、戻す前後で変わらない。
-- ⚠️ 戻すと #1799 が再発する: 同じ組織の在籍者が招待を承諾すると org_role が招待の役割で上書きされる (持ち主が member になりうる)。
-- データは戻さない (この migration はデータを変えていない)。

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

  -- #1163: 24 時間の作成上限 (招待者ごと 200 / 組織ごと 500 / 同じ組織から同じ宛先へ 3)。超過は 'RATE_LIMITED'
  PERFORM public.enforce_membership_daily_cap('org_invite', p_organization_id, p_email);

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

CREATE OR REPLACE FUNCTION public.accept_org_invite(p_token TEXT)
RETURNS user_profiles
LANGUAGE plpgsql
SECURITY DEFINER  -- ★ 受諾は user_profiles を SET するため DEFINER 必須
SET search_path = public AS $$
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

  -- メンバ化 (#1273)。初期設定より前に承諾した人はまだプロフィール行が無く、UPDATE だけだと 0 行で終わって
  -- 所属が入らないまま、招待の消化・席数 +1・監査ログだけが進んでいた (戻り値も全列 NULL)。
  -- 行が無ければ既定値 ('Guest' / 'unspecified') で作る。行があるときに更新する列は以前の UPDATE と同じ 4 列だけ。
  INSERT INTO user_profiles (id, nickname, age_group, gender,
                             organization_id, org_role, joined_org_at, is_active_in_org)
  VALUES (auth.uid(), 'Guest', 'unspecified', 'unspecified',
          v_invite.organization_id, v_invite.invited_role, CURRENT_DATE, TRUE)
  ON CONFLICT (id) DO UPDATE
    SET organization_id  = EXCLUDED.organization_id,
        org_role         = EXCLUDED.org_role,
        joined_org_at    = EXCLUDED.joined_org_at,
        is_active_in_org = EXCLUDED.is_active_in_org
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

DROP FUNCTION IF EXISTS public.assert_org_invite_recipient_not_in_org(UUID, TEXT);
