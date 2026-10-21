-- rollback: 20261022100000_org_invite_dissolved.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 戻すもの: 2 つの RPC を、この migration より前の最新の定義に逐語で戻す。
--   - accept_org_invite: 20261017160000_org_invite_same_org_member.sql の定義 (:158-260。組織の行をロックせず、status を見ない)
--   - operator_force_dissolve_org: 20261019120000_self_dissolve.sql の定義 (:232-285。後始末の前にオーナーの行・組織の行を取らない)
--   (tests/org-invite-dissolved-migration-contract.test.ts が、両ファイルの該当行との逐語の一致を見る)
-- signature・戻り値・SECURITY DEFINER・search_path・所有者・EXECUTE 権限は、戻す前後で変わらない (CREATE OR REPLACE)。
-- ⚠️ 戻すと Q-4 (docs/design/family/11-self-dissolve.md) が再発する: 解散した組織の招待を承諾でき、解散と承諾が同時に走ると
--   解散した組織に所属が残る。
-- データは戻さない (この migration はデータを変えていない)。
-- 冪等: CREATE OR REPLACE FUNCTION のため、2 回続けて流してもエラーにならない。

SET LOCAL lock_timeout = '10s';

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

CREATE OR REPLACE FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_org organizations;
  v_prev_owner UUID;
BEGIN
  SELECT roles INTO v_caller_roles
    FROM user_profiles WHERE id = auth.uid();

  IF v_caller_roles IS NULL
     OR NOT (
       'super_admin' = ANY(v_caller_roles)
       OR 'operator' = ANY(v_caller_roles)
     ) THEN
    RAISE EXCEPTION 'OPERATOR_PERMISSION_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  -- #1176 (docs/design/cross/12-operator-mfa.md §11.4): TOTP を登録済みの必須ロールの呼び出し元は、aal2 のセッションでなければ止める
  IF NOT public.operator_mfa_satisfied() THEN
    RAISE EXCEPTION 'OPERATOR_MFA_REQUIRED' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_org FROM organizations WHERE id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_org.status = 'dissolved' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
  END IF;
  v_prev_owner := v_org.owner_id;

  -- #1917: 後始末 (所属の列を外す・席数を 0・行を dissolved・owner_id を NULL) は public.org_dissolve_apply に閉じる
  v_org := public.org_dissolve_apply(p_organization_id);

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES (
    'organization',
    p_organization_id,
    'operator_force_dissolve',
    auth.uid(),
    NULL,
    jsonb_build_object(
      'reason', p_reason,
      'dissolved_at', NOW(),
      'previous_owner_id', v_prev_owner
    )
  );

  RETURN v_org;
END;
$$;
