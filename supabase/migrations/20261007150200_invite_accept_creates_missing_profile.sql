-- migration: 20261007150200_invite_accept_creates_missing_profile.sql
-- Issue #1273: 初期設定 (オンボーディング) より前に招待を承諾すると、所属が user_profiles に入らない問題を直す
--
-- 背景:
--   本番には auth.users から user_profiles を作るトリガーが無く、プロフィール行は初期設定の保存で初めて作られる。
--   招待メールのリンクから新規登録した人は、初期設定より前でも招待ページ (/invite/[token]。#1057) で承諾できるため、
--   承諾の時点でプロフィール行がまだ無い。
--   - accept_family_invite: UPDATE user_profiles SET family_id が 0 行で終わる。family_members には active で入るのに
--     user_profiles.family_id は NULL のまま。家族の画面は「家族なし」になり、家族を新規作成しても ALREADY_IN_FAMILY で失敗する。
--   - accept_org_invite: 同じ UPDATE が 0 行で終わるが、その後は進む (招待は accepted、used_licenses +1、監査ログ)。
--     所属は入らず戻り値は全列 NULL の行になり、席を解放する経路も無い。
--   - 初期設定の保存 (upsert) は family_id / organization_id などの特権列を送らないため、後から作られる行でも NULL のまま。
--
-- 変更 (2026-10-07 オーナー判断。accept_child_promotion = 20261007112100 と同じ形):
--   プロフィール行が無ければ、アプリの既定値 (nickname 'Guest'、age_group / gender 'unspecified'。/api/profile・
--   /api/onboarding/progress と同じ) で作ってから所属を入れる。行があるときは所属の列だけを更新する
--   (INSERT ... ON CONFLICT (id) DO UPDATE)。初期設定の日時は入れないため初期設定の導線は変わらない。
--   - SECURITY DEFINER (所有者 postgres) のため #1274 の BEFORE INSERT ガードは掛からない。書き込む行は auth.uid() 本人だけ。
--   - 変えるのは本人のプロフィールへの書き込み 1 か所ずつだけ。それ以外の本文・戻り値・エラーは現行のまま。
--   - CREATE OR REPLACE のため所有者と EXECUTE 権限は本番の現行のまま (REVOKE / GRANT は流さない)。
-- 既に被害を受けた人の修復はこの migration に含めない (本番の件数を確認してから別 migration で判断する)。
--
-- 冪等: CREATE OR REPLACE FUNCTION。
-- ロールバック: supabase/rollbacks/20261007150200_invite_accept_creates_missing_profile.down.sql

CREATE OR REPLACE FUNCTION public.accept_family_invite(
  p_token TEXT,
  p_share_meals BOOLEAN DEFAULT TRUE,
  p_share_health BOOLEAN DEFAULT FALSE,
  p_share_menu BOOLEAN DEFAULT TRUE
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  -- ★ Warning 2: SELECT FOR UPDATE で二重受諾防止
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

  -- 所属家族を本人のプロフィールに入れる (#1273)。初期設定より前に承諾した人はまだプロフィール行が無く、
  -- UPDATE だけだと 0 行で終わって family_id が NULL のままになる。行が無ければ既定値 ('Guest' / 'unspecified') で作る。
  -- 初期設定の日時は入れない。accept_child_promotion (20261007112100) と同じ形。
  INSERT INTO user_profiles (id, nickname, age_group, gender, family_id)
  VALUES (auth.uid(), 'Guest', 'unspecified', 'unspecified', v_invite.family_id)
  ON CONFLICT (id) DO UPDATE SET family_id = EXCLUDED.family_id;

  UPDATE family_invites
    SET status = 'accepted', accepted_at = NOW(), accepted_by = auth.uid()
    WHERE id = v_invite.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_invite.family_id, 'invite_accepted', auth.uid(), auth.uid(),
          jsonb_build_object('invite_id', v_invite.id));

  RETURN v_member;
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
