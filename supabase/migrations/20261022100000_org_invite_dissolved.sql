-- migration: 20261022100000_org_invite_dissolved.sql
-- 戻し方: supabase/rollbacks/20261022100000_org_invite_dissolved.down.sql
-- 解散した組織の招待を承諾できてしまう既存の欠陥 (docs/design/family/11-self-dissolve.md の Q-4・S-22・S-30) を直す。
--
-- 背景:
--   accept_org_invite (最新の定義は 20261017160000_org_invite_same_org_member.sql) は、招待の status と期限は見るが、
--   organizations.status を読まず、組織の行もロックしなかった。そのため
--     (a) 解散した組織の pending の招待を承諾すると、解散した組織に所属したまま残る (席数も +1 される)。
--     (b) オーナーの解散 (dissolve_org_by_owner) と招待の承諾が同時に走ると、解散の後始末の UPDATE (所属を外す) は
--         承諾の commit 前の版 (所属が空) を見て承諾した人を外さず、承諾が後から commit して、解散した組織に所属が残る。
--     運営の強制解散 (operator_force_dissolve_org) も同じ (こちらは組織の行を後始末の最後まで取らないので、(b) の窓がもっと広い)。
--
-- 変更:
--   1. accept_org_invite: 宛先のメールの判定のあと、在籍の判定と最初の書き込みより前に、招待の組織の行を FOR NO KEY UPDATE でロックし、
--      status が 'active' でなければ ORG_ALREADY_DISSOLVED (P0001) で止める (organizations.status は 'active' / 'dissolved' の 2 値。
--      CHECK organizations_status_check)。組織の行が無ければ ORG_NOT_FOUND。断るときは例外でトランザクションごと巻き戻るので、
--      招待は pending のまま・席数も監査ログも変わらない (本人は拒否 (/reject) できる)。
--      ロックの向き: 招待の行 → 組織の行 → 承諾者の user_profiles → org_license_pools。
--      解散 (dissolve_org_by_owner) は 本人の user_profiles → 組織の行 → 全員の user_profiles → org_license_pools → 組織の行 なので、
--      組織の行で直列になる。解散が先に組織の行を取れば、承諾は解散の commit を待ってから dissolved を読んで止まる。
--      承諾が先に取れば、解散は承諾の commit を待ってから後始末の UPDATE を始めるので、承諾した人の所属も外す。
--      解散は招待の行を触らず、承諾はオーナーの user_profiles を書かないので、逆向きの待ちは無い (デッドロックしない)。
--      FOR NO KEY UPDATE にするのは、FOR UPDATE だと組織を外部キーで参照する行の追加・更新 (FOR KEY SHARE) と待ち合うため
--      (CLAUDE.md の「家族 (family_*) を変える関数のロック順」の「新しく足す家族の行のロックは FOR NO KEY UPDATE」と同じ理由)。
--      解散の FOR NO KEY UPDATE / UPDATE とは衝突するので、直列にはなる。
--   2. operator_force_dissolve_org: 後始末 (org_dissolve_apply) の前に、dissolve_org_by_owner と同じ向きで
--      オーナーの user_profiles → 組織の行 をロックする (どちらも FOR NO KEY UPDATE)。
--      従来は組織の行を後始末の最後の UPDATE まで取らず、全員の user_profiles → org_license_pools → 組織の行 の順だったため、
--      1 の承諾 (組織の行 → org_license_pools) と逆向きになり、同時に走るとデッドロック (40P01) しうる。
--      また、後始末の UPDATE が承諾の commit 前に始まると、(b) と同じく承諾した人の所属が残る。
--      オーナーの行を先に取るのは、譲渡の承諾 (accept_org_owner_transfer / operator_force_owner_transfer: 旧オーナーの user_profiles →
--      新オーナーの user_profiles → 組織の行) と同じ向きにするため (組織の行を先に取ると逆向きになる。family/11 §11.3)。
--      オーナーを読んでから行をロックするまでに譲渡が commit したら、新しいオーナーの行を取り直す (オーナーの行を持っている間は、
--      そのオーナーからの譲渡は旧オーナーの行の UPDATE で待つので、ループを抜けたあとはオーナーが変わらない)。
--      権限・MFA の判定・エラーとその順番・監査の action と metadata・戻り値は 20261019120000_self_dissolve.sql の定義のまま。
--   3. 解散の後始末 (org_dissolve_apply) は変えない: 解散のときに pending の招待を revoked にはしない。
--      理由: 1 で承諾の側が解散した組織を必ず断るので、招待が pending のまま残っても所属は作られない。
--      招待の一覧 (src/app/(org)/org/invites/page.tsx) を見るのは組織の owner / admin で、解散で所属が外れるので解散後は誰も開けない。
--      招待を受けた人の画面 (src/app/invite/[token]/page.tsx) は、revoked にすると「この招待は取り消し済みです・招待者に再発行を
--      依頼してください」になり、解散した組織では再発行できないので事実と違う案内になる。pending のままなら、承諾の時点で
--      「この組織は解散しているため、招待を承諾できません」(承諾の API の文) が出て、拒否もできる。
--      後始末の関数に招待の UPDATE を足すと、解散 (組織の行 → 招待の行) と承諾 (招待の行 → 組織の行) が逆向きになり、
--      承諾の側のロックの順番も変える必要が出る。
--
-- signature・戻り値・SECURITY DEFINER・search_path・所有者・EXECUTE 権限 (2 つの RPC とも) は変えない
-- (CREATE OR REPLACE のため、権限はそのまま残る)。
-- 既存データへの影響: なし (関数の本文の置き換えだけ)。すでに解散した組織に所属が残っている人の修復はこの migration に含めない。
-- 冪等: CREATE OR REPLACE FUNCTION のため、2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/org-invite-dissolved.test.ts (実 DB)
--       tests/org-invite-dissolved-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

-- ----------------------------------------------------------------
-- 1. accept_org_invite (SECURITY DEFINER のまま)。本文は 20261017160000 の定義に、組織の行のロックと status の判定を足しただけ
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
  v_org_status TEXT;
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

  -- Q-4 (docs/design/family/11-self-dissolve.md): 招待の組織の行をロックし、解散した組織なら承諾させない。
  -- LOCK-ORDER: 招待の行 → 組織の行 → 承諾者の user_profiles → org_license_pools。解散 (dissolve_org_by_owner /
  -- operator_force_dissolve_org) も後始末の前に組織の行を取るので、ここで直列になる (解散が先なら dissolved を読んで止まり、
  -- 承諾が先なら解散の後始末の UPDATE が承諾した人の所属も外す)。FOR NO KEY UPDATE は外部キーの確認 (FOR KEY SHARE) と待ち合わない
  SELECT status INTO v_org_status FROM organizations WHERE id = v_invite.organization_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_org_status <> 'active' THEN
    RAISE EXCEPTION 'ORG_ALREADY_DISSOLVED' USING ERRCODE = 'P0001';
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

-- ----------------------------------------------------------------
-- 2. operator_force_dissolve_org (SECURITY DEFINER のまま)。本文は 20261019120000_self_dissolve.sql の定義に、
--    後始末の前のロック (オーナーの user_profiles → 組織の行) を足しただけ
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."operator_force_dissolve_org"("p_organization_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."organizations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_caller_roles TEXT[];
  v_org organizations;
  v_prev_owner UUID;
  v_lock_owner UUID;
  v_current_owner UUID;
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

  SELECT owner_id INTO v_lock_owner FROM organizations WHERE id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORG_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- Q-4 (docs/design/family/11-self-dissolve.md): LOCK-ORDER は dissolve_org_by_owner と同じ
  -- オーナーの user_profiles → 組織の行 (どちらも FOR NO KEY UPDATE) → 後始末 (全員の user_profiles → org_license_pools → 組織の行)。
  -- 組織の行を後始末より前に取るので、招待の承諾 (accept_org_invite: 組織の行 → 承諾者の user_profiles → org_license_pools) と
  -- 直列になり、承諾が先に commit した人の所属も後始末の UPDATE で外れる。オーナーの行を先に取るのは、譲渡の承諾
  -- (旧オーナーの user_profiles → 新オーナーの user_profiles → 組織の行) と同じ向きにするため。
  -- オーナーを読んでから行を取るまでに譲渡が commit していたら、新しいオーナーの行を取り直す
  -- (解散した組織は owner_id が NULL なので、何もロックせずに抜けて下で ORG_ALREADY_DISSOLVED になる)
  LOOP
    PERFORM 1 FROM user_profiles WHERE id = v_lock_owner FOR NO KEY UPDATE;
    SELECT owner_id INTO v_current_owner FROM organizations WHERE id = p_organization_id;
    EXIT WHEN v_current_owner IS NOT DISTINCT FROM v_lock_owner;
    v_lock_owner := v_current_owner;
  END LOOP;

  SELECT * INTO v_org FROM organizations WHERE id = p_organization_id FOR NO KEY UPDATE;
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
