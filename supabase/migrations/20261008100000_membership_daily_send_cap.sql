-- migration: 20261008100000_membership_daily_send_cap.sql
-- #1163: 招待・子供メンバーの昇格リクエスト (参加リクエスト)・譲渡提案の作成に、DB で数える 24 時間の上限を入れる
--
-- 背景:
--   アプリ層の上限 (src/lib/rate-limit.ts / src/lib/membership/invite-throttle.ts。#1288) は、本番で Upstash が未設定のため
--   in-memory (サーバーインスタンスごと) で動き、日次の上限はインスタンスの入れ替わりで簡単にリセットされる。
--   2026-10-07 のオーナー判断 (#1163): Upstash は当面用意しない。アプリ層の短時間 (分あたり) の上限は残し、
--   インスタンス数に依らず効く 24 時間の上限を DB に足す。数値はアプリ層の日次上限と同じ。
--
-- 何を数えるか: public.membership_audit (コミットされた作成だけ。失敗した RPC は監査行ごと巻き戻る)。
--   - 利用者は書けない・消せない (RLS は SELECT ポリシーのみ)。scope_id に FK が無く、家族・組織を消しても残る。
--   - 招待テーブル自体は数えない。organization_invites は組織管理者が DELETE できる (ポリシー "Org admins can manage invites"、
--     DELETE /api/org/invites)。family_invites は家族の大人が任意の列を UPDATE でき、代表者が family_groups を DELETE すると
--     CASCADE で消える。数える元を消せると上限を回避できる。
--   - create_org_invite だけは監査行を書いていない (SECURITY INVOKER のため membership_audit に書けない)。
--     organization_invites の AFTER INSERT トリガーで 'invite_created' を書く (家族の招待と同じ形)。
--     この migration より前に作られた組織の招待は監査行が無いので、数えるのは適用後に作られた分から。
--
-- 上限 (直近 24 時間のローリングウィンドウ。暦日ではない):
--   family_invite    : 招待者ごと 20 / 同じ家族から同じ宛先へ 3
--   org_invite       : 招待者ごと 200 / 組織ごと 500 / 同じ組織から同じ宛先へ 3
--   child_promotion  : 依頼者ごと 10 / 同じ家族から同じ宛先へ 3
--   transfer_propose : 提案者ごと 10 (家族の代表者譲渡と組織のオーナー譲渡の合計)
--
-- 超過時: RAISE EXCEPTION 'RATE_LIMITED' USING ERRCODE = 'P0001'。mapPgErrorToHttp が 429 / RATE_LIMITED に写す。
--   DETAIL = 超過した上限の名前 (ログ用)、HINT = 'retry_after_sec=<秒>' (Retry-After 用。最古の対象行が窓から出るまで)。
--   Web の route 5 本は src/lib/membership/invite-throttle.ts の inviteThrottleFailureFromRpcError でアプリ層の上限と同じ 429 にする。
--
-- 同時実行: 数える前に pg_advisory_xact_lock を (種類, 招待者) → (種類, 家族 / 組織) の固定順で取る。
--   同じ枠に同時に 2 件来ても、後の 1 件は先の 1 件のコミット後に数え直すので、上限を超えて通らない
--   (READ COMMITTED 前提。PostgREST の既定。REPEATABLE READ 以上や、helper を STABLE にするとロック前のスナップショットで数えてしまう)。
--   ロックはトランザクション終了で外れる。副次効果として、同じ家族 / 組織から同じ宛先へ同時に招待したときの
--   uniq_family_invites_pending / uniq_org_invites_pending の一意制約違反 (23505) も出なくなる。
--
-- 5 つの作成 RPC は CREATE OR REPLACE で、本文は本番の現行 (supabase/baseline/prod_schema.sql。これより新しい migration は
--   どれも変更していない) のまま、上限の判定 (PERFORM 1 行) だけを「認可・既存の上限確認の後、最初の書き込みの前」に足す。
--   signature・戻り値・SECURITY DEFINER / INVOKER・search_path・所有者・EXECUTE 権限は変えない。
-- 新しい helper / トリガー関数は search_path = '' で、参照はすべてスキーマ付き。
--
-- 権限の定型 (#1039/#1020): 新しい関数には Supabase の既定権限で anon / authenticated / service_role に EXECUTE が付くので、
--   REVOKE は FROM PUBLIC, anon, authenticated, service_role の完全形で書き、必要なロールにだけ GRANT し直す。
-- 既存データへの影響: なし (データの更新・削除・追加はしない。インデックスとトリガーと関数だけ)。
--   インデックスは CONCURRENTLY なし (migration はトランザクション内で流れるため)。membership_audit は監査テーブルで小さく、
--   作成中の短時間だけ書き込みが待たされる。
-- 適用順: version 順。20261007160000〜20261007160800 の migration より後に流れる (先にマージしておくこと。台帳より古い version を
--   後から足すと supabase db push が止まる)。それらは本 migration の対象 (membership_audit の索引・organization_invites の
--   トリガー・5 つの作成 RPC・新しい 2 関数) を変更しないので、内容は衝突しない。
-- 冪等: CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE FUNCTION / CREATE OR REPLACE TRIGGER / REVOKE・GRANT のため、
--   2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/security/membership-daily-cap.test.ts
-- ロールバック: supabase/rollbacks/20261008100000_membership_daily_send_cap.down.sql

-- ----------------------------------------------------------------
-- (1) 集計用の複合インデックス (既存は actor_id 単独 / (scope, scope_id) のみ)
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_membership_audit_actor_action_created
  ON public.membership_audit USING btree (actor_id, action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_membership_audit_scope_action_created
  ON public.membership_audit USING btree (scope, scope_id, action, created_at DESC);

-- ----------------------------------------------------------------
-- (2) 組織の招待の監査行 (create_org_invite は SECURITY INVOKER で membership_audit に書けないため)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_organization_invite_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- membership_audit.scope_id は NOT NULL。organization_id の無い招待 (旧データ) は記録しない
  IF NEW.organization_id IS NOT NULL THEN
    INSERT INTO public.membership_audit (scope, scope_id, action, actor_id, metadata)
    VALUES ('organization', NEW.organization_id, 'invite_created',
            COALESCE(auth.uid(), NEW.invited_by),
            pg_catalog.jsonb_build_object('invite_id', NEW.id, 'email', pg_catalog.lower(NEW.email)));
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.audit_organization_invite_created() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.audit_organization_invite_created() IS
  '#1163: organization_invites の INSERT ごとに membership_audit へ invite_created を書く (組織の招待の 24 時間上限はこの行を数える)。create_org_invite に監査 INSERT を足すと二重になるので足さないこと。';

CREATE OR REPLACE TRIGGER trg_audit_organization_invite_created
  AFTER INSERT ON public.organization_invites
  FOR EACH ROW EXECUTE FUNCTION public.audit_organization_invite_created();

-- ----------------------------------------------------------------
-- (3) 24 時間上限の判定 helper (書き込みはしない。超過なら RATE_LIMITED を RAISE)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_membership_daily_cap(
  p_kind TEXT,
  p_scope_id UUID,
  p_email TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor  UUID := auth.uid();
  v_email  TEXT := pg_catalog.lower(p_email);
  v_since  TIMESTAMPTZ := pg_catalog.now() - INTERVAL '24 hours';
  v_count  BIGINT;
  v_oldest TIMESTAMPTZ;
  v_rule   TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  IF p_kind = 'family_invite' THEN
    -- 直接呼ばれても他の家族の件数を覗けないよう、create_family_invite と同じ認可をここでも行う
    IF NOT public.is_active_family_adult(p_scope_id) THEN
      RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:family_invite:actor:' || v_actor::TEXT, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:family_invite:scope:' || p_scope_id::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor AND a.action = 'invite_created' AND a.scope = 'family'
       AND a.created_at > v_since;
    IF v_count >= 20 THEN
      v_rule := 'family_invite:per_actor';
    END IF;

    IF v_rule IS NULL THEN
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'family' AND a.scope_id = p_scope_id AND a.action = 'invite_created'
         AND a.created_at > v_since AND (a.metadata ->> 'email') = v_email;
      IF v_count >= 3 THEN
        v_rule := 'family_invite:per_target';
      END IF;
    END IF;

  ELSIF p_kind = 'org_invite' THEN
    -- create_org_invite と同じ認可 (所属組織の owner / admin)
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles up
       WHERE up.id = v_actor AND up.organization_id = p_scope_id
         AND up.org_role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'NOT_ORG_ADMIN' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:org_invite:actor:' || v_actor::TEXT, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:org_invite:scope:' || p_scope_id::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor AND a.action = 'invite_created' AND a.scope = 'organization'
       AND a.created_at > v_since;
    IF v_count >= 200 THEN
      v_rule := 'org_invite:per_actor';
    END IF;

    IF v_rule IS NULL THEN
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'organization' AND a.scope_id = p_scope_id AND a.action = 'invite_created'
         AND a.created_at > v_since;
      IF v_count >= 500 THEN
        v_rule := 'org_invite:per_org';
      END IF;
    END IF;

    IF v_rule IS NULL THEN
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'organization' AND a.scope_id = p_scope_id AND a.action = 'invite_created'
         AND a.created_at > v_since AND (a.metadata ->> 'email') = v_email;
      IF v_count >= 3 THEN
        v_rule := 'org_invite:per_target';
      END IF;
    END IF;

  ELSIF p_kind = 'child_promotion' THEN
    -- 宛先の上限は「同じ家族から同じ宛先へ」で数える (#1232 v2 §10 の family / email 単位)。
    -- アプリ層は RPC 前に member_id の所属を確かめられないため依頼者単位で数えているが、DB では
    -- request_child_promotion が認可済みの family_id を渡すので家族単位で数えられる。
    IF NOT public.is_active_family_adult(p_scope_id) THEN
      RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:child_promotion:actor:' || v_actor::TEXT, 0));
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:child_promotion:scope:' || p_scope_id::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor AND a.action = 'child_promotion_requested'
       AND a.created_at > v_since;
    IF v_count >= 10 THEN
      v_rule := 'child_promotion:per_actor';
    END IF;

    IF v_rule IS NULL THEN
      SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
        FROM public.membership_audit a
       WHERE a.scope = 'family' AND a.scope_id = p_scope_id AND a.action = 'child_promotion_requested'
         AND a.created_at > v_since AND (a.metadata ->> 'email') = v_email;
      IF v_count >= 3 THEN
        v_rule := 'child_promotion:per_target';
      END IF;
    END IF;

  ELSIF p_kind = 'transfer_propose' THEN
    -- 家族の代表者譲渡と組織のオーナー譲渡は同じ枠 (アプリ層の 'transfer-propose' と同じ)
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('membership_daily_cap:transfer_propose:actor:' || v_actor::TEXT, 0));

    SELECT pg_catalog.count(*), pg_catalog.min(a.created_at) INTO v_count, v_oldest
      FROM public.membership_audit a
     WHERE a.actor_id = v_actor
       AND a.action IN ('owner_transfer_proposed', 'representative_transfer_proposed')
       AND a.created_at > v_since;
    IF v_count >= 10 THEN
      v_rule := 'transfer_propose:per_actor';
    END IF;

  ELSE
    RAISE EXCEPTION 'INVALID_DAILY_CAP_KIND' USING ERRCODE = '22023';
  END IF;

  IF v_rule IS NOT NULL THEN
    RAISE EXCEPTION 'RATE_LIMITED' USING
      ERRCODE = 'P0001',
      DETAIL = v_rule,
      HINT = 'retry_after_sec=' || GREATEST(1, pg_catalog.ceil(pg_catalog.date_part(
               'epoch', v_oldest + INTERVAL '24 hours' - pg_catalog.now())))::BIGINT::TEXT;
  END IF;
END $$;

-- authenticated への EXECUTE は create_org_invite (SECURITY INVOKER = 呼び出し元の権限で動く) から呼ぶために必要。
-- 他の 4 RPC は SECURITY DEFINER (所有者 postgres の権限で動く) なので GRANT は要らない。
-- 直接 /rpc で呼ばれても、書き込みはせず、他人・他テナントの件数も覗けない (家族・組織の枠は上で認可してから数える)。
REVOKE ALL ON FUNCTION public.enforce_membership_daily_cap(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enforce_membership_daily_cap(TEXT, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.enforce_membership_daily_cap(TEXT, UUID, TEXT) IS
  '#1163: 招待・昇格リクエスト・譲渡提案の 24 時間上限 (membership_audit を数える)。超過は RATE_LIMITED (P0001)、DETAIL に上限名、HINT に retry_after_sec。作成 RPC の認可の後・最初の書き込みの前に PERFORM する。';

-- ----------------------------------------------------------------
-- (4) 作成 RPC 5 本: 本文は本番の現行 (supabase/baseline/prod_schema.sql) のまま、上限の判定を 1 か所足す
-- ----------------------------------------------------------------

-- (4-1) create_family_invite (SECURITY DEFINER)。判定は認可・人数上限の後、既存 pending の revoke の前
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

-- (4-2) create_org_invite (SECURITY INVOKER のまま)。判定は認可・席数上限の後、既存 pending の revoke の前。
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

-- (4-3) request_child_promotion (SECURITY DEFINER)。判定は認可・対象の状態確認の後、既存 pending の revoke の前
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

  -- #1163: 24 時間の作成上限 (依頼者ごと 10 / 同じ家族から同じ宛先へ 3)。超過は 'RATE_LIMITED'。ロック順: 上の FOR UPDATE -> 上限の advisory -> 下の request 行
  PERFORM public.enforce_membership_daily_cap('child_promotion', v_member.family_id, p_email);

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

-- (4-4) propose_family_representative_transfer (SECURITY DEFINER)。判定は認可・対象確認の後、既存 pending の expire の前
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

  -- #1163: 24 時間の提案上限 (提案者ごと 10。組織のオーナー譲渡と合算)。超過は 'RATE_LIMITED'
  PERFORM public.enforce_membership_daily_cap('transfer_propose', p_family_id, NULL);

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

-- (4-5) propose_org_owner_transfer (SECURITY DEFINER)。判定は認可・対象確認の後、既存 pending の expire の前
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

  -- #1163: 24 時間の提案上限 (提案者ごと 10。家族の代表者譲渡と合算)。超過は 'RATE_LIMITED'
  PERFORM public.enforce_membership_daily_cap('transfer_propose', p_organization_id, NULL);

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
