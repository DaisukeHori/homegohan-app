-- migration: 20261017160000_org_invite_same_org_member.sql
-- #1799: 組織の招待を承諾すると、同じ組織にすでに在籍している人の org_role が招待の役割 (invited_role) で上書きされる問題を直す
--
-- 背景:
--   accept_org_invite (最新の定義は 20261007150200_invite_accept_creates_missing_profile.sql) は、別の組織の在籍者だけを
--   ALREADY_IN_ORG で断り、同じ組織の在籍者はそのまま通していた。そのあとの INSERT ... ON CONFLICT DO UPDATE が
--   org_role = invited_role に上書きするため、持ち主 (owner) 宛ての member の招待を承諾すると持ち主が member になり、
--   組織から owner がいなくなる (organizations.owner_id はその人のまま)。member 宛ての admin の招待なら admin に上がる。
--   accept_org_invite は SECURITY DEFINER なので、guard_user_profiles_privileged (authenticated / anon だけを止める) も素通りする。
--   create_org_invite (最新の定義は 20261008100000_membership_daily_send_cap.sql) も、宛先が同じ組織の在籍者かを見ていなかった。
--   設計 docs/design/org/10-challenge-diff-privacy.md §20 の 7-7 / 11 にある既知の欠陥。
--
-- 変更:
--   A. accept_org_invite: どこかの組織に在籍している人 (user_profiles.organization_id が NULL でない) の承諾は、
--      宛先の組織が同じでも ALREADY_IN_ORG で断る (従来は別の組織のときだけ)。
--      招待の組織の持ち主 (organizations.owner_id) 本人の承諾も ALREADY_IN_ORG で断る
--      (所属の列が空でも、持ち主の org_role を招待の役割で書かない)。別の組織の持ち主は従来どおり IS_ORG_OWNER。
--      書き込み (INSERT ... ON CONFLICT DO UPDATE) にも「所属が空の行だけを書き換える」条件を付け、書けなければ ALREADY_IN_ORG にする
--      (確認と書き込みの間に、同じ人が別の招待を承諾して所属が入った場合も上書きしない)。
--      断るときは例外でトランザクションごと巻き戻るので、招待は pending のまま (設計 membership/02-flow-spec.md §1.3 の
--      ALREADY_IN_ORG と同じ。本人は拒否 (/reject) できる)・席数も監査ログも変わらない。それ以外の本文・戻り値・エラーは現行のまま。
--   B. create_org_invite: 宛先のメールアドレスの人が、この組織に在籍している (所属の列がこの組織) か、この組織の持ち主なら、
--      招待を作らずに ALREADY_IN_ORG で断る。判定は認可 (NOT_ORG_ADMIN) の直後、席数の上限・24 時間の上限・既存 pending の
--      取り消しより前。既存の pending の招待は取り消さない。
--      create_org_invite は SECURITY INVOKER のままで auth.users を読めないため、判定は新しい helper
--      public.assert_org_invite_recipient_not_in_org (SECURITY DEFINER・search_path = ''・参照はスキーマ付き) に置く。
--      helper は create_org_invite と同じ認可 (所属組織の owner / admin) を自分でも確かめ、それ以外の呼び出しには
--      NOT_ORG_ADMIN を返す (直接呼ばれても、他の組織の在籍の有無を答えない)。
--   家族の招待 (accept_family_invite) は、すでに家族に入っている人 (family_members.status = 'active') を同じ家族でも
--   ALREADY_IN_FAMILY で断り、メンバーの行は INSERT するだけで既存の行の役割を書き換えないので、同じ欠陥は無い (変えない)。
--
-- signature・戻り値・SECURITY DEFINER / INVOKER・search_path・所有者・EXECUTE 権限 (2 つの既存 RPC) は変えない。
-- 権限の定型 (#1039/#1020): 新しい helper には Supabase の既定権限で anon / authenticated / service_role に EXECUTE が付き、PUBLIC にも
--   付くので、引数の型まで含めた完全形で REVOKE し、create_org_invite を呼ぶ authenticated にだけ GRANT し直す。
-- 既存データへの影響: なし (関数の作り直しと追加だけ)。すでに上書きされてしまった人の修復はこの migration に含めない。
-- 冪等: CREATE OR REPLACE FUNCTION / REVOKE・GRANT のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/org-invite-same-org-member.test.ts (実 DB)
--       tests/org-invite-same-org-member-migration-contract.test.ts (静的)
-- ロールバック: supabase/rollbacks/20261017160000_org_invite_same_org_member.down.sql

-- ----------------------------------------------------------------
-- B. 宛先がこの組織の在籍者・持ち主かの判定 (create_org_invite から呼ぶ)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_org_invite_recipient_not_in_org(
  p_organization_id UUID,
  p_email TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = '' AS $$
BEGIN
  -- create_org_invite と同じ認可 (所属組織の owner / admin)。それ以外には在籍の有無を答えない
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles up
     WHERE up.id = auth.uid() AND up.organization_id = p_organization_id
       AND up.org_role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
  END IF;

  -- 宛先のアドレスの人が、この組織に在籍している (所属の列がこの組織)
  IF EXISTS (
    SELECT 1
      FROM public.user_profiles up
      JOIN auth.users u ON u.id = up.id
     WHERE up.organization_id = p_organization_id
       AND pg_catalog.lower(u.email) = pg_catalog.lower(p_email)
  ) THEN
    RAISE EXCEPTION 'ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- 宛先のアドレスの人が、この組織の持ち主 (所属の列が空でも、持ち主の役割を招待で書かせない)
  IF EXISTS (
    SELECT 1
      FROM public.organizations o
      JOIN auth.users u ON u.id = o.owner_id
     WHERE o.id = p_organization_id
       AND pg_catalog.lower(u.email) = pg_catalog.lower(p_email)
  ) THEN
    RAISE EXCEPTION 'ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.assert_org_invite_recipient_not_in_org(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_org_invite_recipient_not_in_org(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.assert_org_invite_recipient_not_in_org(UUID, TEXT) IS
  '#1799: 組織の招待の宛先が、その組織の在籍者 (user_profiles.organization_id が同じ) か持ち主 (organizations.owner_id) なら ALREADY_IN_ORG (P0001)。呼び出し元が所属組織の owner / admin でなければ NOT_ORG_ADMIN。create_org_invite (SECURITY INVOKER) が認可の直後に PERFORM する。';

-- ----------------------------------------------------------------
-- B. create_org_invite (SECURITY INVOKER のまま)。本文は 20261008100000 の定義に、宛先の判定 (PERFORM 1 行) を足しただけ
-- ----------------------------------------------------------------
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

  -- #1799: 宛先がこの組織の在籍者・持ち主なら招待を作らない ('ALREADY_IN_ORG')。承諾で org_role を書き換えさせないため。
  -- 席数・24 時間の上限より前に判定する (作らない招待で上限の判定をしない)。既存の pending は取り消さない
  PERFORM public.assert_org_invite_recipient_not_in_org(p_organization_id, p_email);

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

-- ----------------------------------------------------------------
-- A. accept_org_invite (SECURITY DEFINER のまま)。本文は 20261007150200 の定義に、在籍の判定 2 か所と書き込みの条件を足しただけ
-- ----------------------------------------------------------------
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

  -- 既に組織に所属しているかのチェック。#1799: 宛先の組織が同じでも断る
  -- (従来は別の組織のときだけ断り、同じ組織の在籍者は下の書き込みで org_role を招待の役割に上書きされていた)
  SELECT * INTO v_user_profile FROM user_profiles WHERE id = auth.uid();
  IF v_user_profile.organization_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- 自身が別 org の owner か (owner は脱退不可)
  IF EXISTS (SELECT 1 FROM organizations WHERE owner_id = auth.uid()
             AND id <> v_invite.organization_id) THEN
    RAISE EXCEPTION 'IS_ORG_OWNER' USING ERRCODE = 'P0001';
  END IF;

  -- #1799: 招待の組織の持ち主本人は、所属の列が空でも承諾させない (持ち主の org_role を招待の役割で書かない)
  IF EXISTS (SELECT 1 FROM organizations WHERE owner_id = auth.uid()
             AND id = v_invite.organization_id) THEN
    RAISE EXCEPTION 'ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

  -- メンバ化 (#1273)。初期設定より前に承諾した人はまだプロフィール行が無く、UPDATE だけだと 0 行で終わって
  -- 所属が入らないまま、招待の消化・席数 +1・監査ログだけが進んでいた (戻り値も全列 NULL)。
  -- 行が無ければ既定値 ('Guest' / 'unspecified') で作る。行があるときに更新する列は以前の UPDATE と同じ 4 列だけ。
  -- #1799: 行があるときは所属が空の行だけを書き換える。上の確認のあとに同じ人が別の招待を承諾して所属が入っていたら
  -- 0 行になり、ALREADY_IN_ORG で断る (ON CONFLICT DO UPDATE の条件は、ロックした最新の行で判定される)
  INSERT INTO user_profiles (id, nickname, age_group, gender,
                             organization_id, org_role, joined_org_at, is_active_in_org)
  VALUES (auth.uid(), 'Guest', 'unspecified', 'unspecified',
          v_invite.organization_id, v_invite.invited_role, CURRENT_DATE, TRUE)
  ON CONFLICT (id) DO UPDATE
    SET organization_id  = EXCLUDED.organization_id,
        org_role         = EXCLUDED.org_role,
        joined_org_at    = EXCLUDED.joined_org_at,
        is_active_in_org = EXCLUDED.is_active_in_org
    WHERE user_profiles.organization_id IS NULL
  RETURNING * INTO v_user_profile;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ALREADY_IN_ORG' USING ERRCODE = 'P0001';
  END IF;

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
