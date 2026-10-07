-- migration: 20261007112100_child_promotion_consent_rpcs.sql
-- #1232 v3: 子供メンバー昇格の本人同意フロー (2/3) — 同意フロー RPC 5本
--
-- 設計: Issue #1232 実装設計 v3 §3 (v2 §3-2 の全文差替) + v2 §3-2(5) get_promotion_details。
-- 設計からの変更点:
--   - 設計時の version 20260714090100 は本番台帳 (最新 20261007094400) より古いため、新しい version で置く。
--   - accept_child_promotion の期限切れ分岐にあった「status を 'expired' に UPDATE してから RAISE」は、
--     直後の RAISE でトランザクションごと巻き戻り、永続化されない (accept_family_invite の同じ書き方も同様)。
--     挙動は変わらないため UPDATE は置かず、期限切れは常に expires_at で判定する (status は 'pending' のまま)。
--
-- ══ ロック順規約 (#1232 v3 / G10) ══════════════════════════════════
-- LOCK-ORDER CANONICAL: family_members -> family_promotion_requests
-- 本ファイルの全 write RPC は、family_promotion_requests の行ロック
-- (FOR UPDATE / UPDATE) を取得する前に、必ず対応する family_members 行の
-- FOR UPDATE を取得済みであること (例外なし)。token しか知らない RPC
-- (accept/reject) は「(1) 非ロック読みで member_id 解決 → (2) member 行ロック
-- → (3) request 行ロック + (1) の判定を全て再検証」の 3 段で実現する。
-- 安全性: 全トランザクションが member 行を先に取る単一順序のため、promotion
-- RPC 同士の待ちサイクル (deadlock) は構造的に不成立。member 行ロック保持中は
-- canonical 順に従う他 RPC が同 member の request 行に触れないことも保証される。
-- さらに他機能 (invite/transfer 等) とのロック交差に備え、各関数の最外殻で
-- deadlock_detected (SQLSTATE 40P01) を捕捉し 'CONFLICT_RETRY' (P0001,
-- HTTP 409) へ正規化する。生の 'deadlock detected' メッセージは
-- mapPgErrorToHttp の語彙に無く 500/UNKNOWN に化けるため、DB 内で潰すのが第一防衛線。
-- (route 側の mapPgErrorToHttp(message, error.code) による 40P01→409 が第二防衛線)
--
-- 権限の定型 (#1039/#1020): REVOKE は FROM PUBLIC, anon, authenticated,
-- service_role の完全形。必要ロールにのみ GRANT し直す。
--
-- 冪等: CREATE OR REPLACE FUNCTION + REVOKE/GRANT。
-- ロールバック: supabase/rollbacks/20261007112100_child_promotion_consent_rpcs.down.sql

-- ----------------------------------------------------------------
-- (1) request_child_promotion — email→user 解決をしない (列挙オラクル排除)。
--     member/user_profiles は不変。v2 から: ロック順マーカー + 40P01 正規化を追加
--     (ロック順自体は v2 の時点で member → request の canonical 順)。
--     戻り値はメール文面用の表示名と token を含む JSONB。token は route がメールに載せるためだけに使い、
--     HTTP レスポンスには含めない。
-- ----------------------------------------------------------------
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

REVOKE EXECUTE ON FUNCTION public.request_child_promotion(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_child_promotion(uuid, text) TO authenticated;

-- ----------------------------------------------------------------
-- (2) accept_child_promotion — 対象者本人が自分の auth.uid() で受諾。ここで初めて紐付ける。
--     ★v3 (G10): v2 は request行→member行 の逆順ロックだった。3 段構成へ改修。
--     email 一致検証は accept_family_invite を踏襲。auth.uid()→email は id 一意なので
--     #1062 の SSO 非決定性は原理的に発生しない。
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_child_promotion(
  p_token TEXT,
  p_share_meals BOOLEAN DEFAULT TRUE,
  p_share_health BOOLEAN DEFAULT FALSE,
  p_share_menu BOOLEAN DEFAULT TRUE
) RETURNS family_members
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request family_promotion_requests;
  v_member family_members;
  v_caller_email TEXT;
  v_constraint TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  -- (1) 非ロック読み: member_id 解決 + 終端 status の早期確定。
  --     終端 status (accepted/rejected/revoked/expired) は不変条件のため
  --     非ロック読みでも確定判定してよい。'pending' だけが遷移しうるので (3) で再検証する。
  --     member_id / token は全 RPC を通じて UPDATE されない不変列 → (2) でそのまま使える。
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status = 'expired' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
  ELSIF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- (2) member 行を先にロック (canonical 順の先頭。request_child_promotion と同順)
  SELECT * INTO v_member FROM family_members WHERE id = v_request.member_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;

  -- (3) request 行をロックし、(1) の 'pending' 判定を再検証
  --     ((1)→(3) の間に revoke/再送で遷移した可能性がある。member ロック保持中は
  --      canonical 順に従う他 RPC はもうこの行に触れないため、(3) 以降は安定)
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    IF v_request.status = 'expired' THEN
      RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
    ELSE
      RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  -- 期限切れ。status を 'expired' に UPDATE しても直後の RAISE で巻き戻るため書かない
  -- (status は 'pending' のまま。期限切れは常に expires_at で判定する)。
  IF v_request.expires_at < NOW() THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_EXPIRED' USING ERRCODE = 'P0001';
  END IF;

  -- 対象者本人であることを「自分のメール」で検証 (呼び出し者自身 = 列挙オラクルにならない)
  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(v_request.email) THEN
    RAISE EXCEPTION 'PROMOTION_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- member の状態検証 ((2) でロック済みの行が権威)
  IF v_member.status <> 'active' THEN
    RAISE EXCEPTION 'PROMOTION_MEMBER_UNAVAILABLE' USING ERRCODE = 'P0001';
  END IF;
  IF v_member.user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_PROMOTED' USING ERRCODE = 'P0001';
  END IF;

  -- 呼び出し者が既にどこかの family に所属していないこと (クリーンパスの事前チェック)
  IF EXISTS (SELECT 1 FROM family_members WHERE user_id = auth.uid() AND status = 'active') THEN
    RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
  END IF;

  -- G3 (v2): 同一本人の 2 token 並行 accept は uniq_family_members_user の 23505 を
  -- ALREADY_IN_FAMILY(409) へ正規化。他の unique violation は再 RAISE。
  BEGIN
    UPDATE family_members
      SET user_id = auth.uid(), child_profile = NULL, role = 'adult',
          share_meals = p_share_meals, share_health = p_share_health, share_menu = p_share_menu
      WHERE id = v_member.id
      RETURNING * INTO v_member;
  EXCEPTION
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'uniq_family_members_user' THEN
        RAISE EXCEPTION 'ALREADY_IN_FAMILY' USING ERRCODE = 'P0001';
      END IF;
      RAISE;
  END;

  UPDATE user_profiles SET family_id = v_member.family_id WHERE id = auth.uid();

  UPDATE family_promotion_requests
    SET status = 'accepted', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE id = v_request.id;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_member.family_id, 'child_promoted', auth.uid(), auth.uid(),
          jsonb_build_object('member_id', v_member.id, 'request_id', v_request.id,
                             'requested_by', v_request.requested_by));

  RETURN v_member;
EXCEPTION
  WHEN deadlock_detected THEN
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;

REVOKE EXECUTE ON FUNCTION public.accept_child_promotion(text, boolean, boolean, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_child_promotion(text, boolean, boolean, boolean)
  TO authenticated;

-- ----------------------------------------------------------------
-- (3) reject_child_promotion — 対象者本人が拒否。
--     ★v3 (G10): 単独では request 行ロックのみで自らはサイクルを構成しないが、
--     「request 行ロックの前に必ず member 行ロック」という例外なしの単一規約に揃える
--     (将来 member 更新が追加された場合の逆順地雷の予防)。3 段構成は accept と同型。
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_child_promotion(p_token TEXT)
RETURNS family_promotion_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request family_promotion_requests;
  v_caller_email TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  -- (1) 非ロック読み
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;

  -- (2) member 行ロック (行が消えていれば request も CASCADE 済み = NOT_FOUND 扱い)
  PERFORM 1 FROM family_members WHERE id = v_request.member_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  -- (3) request 行ロック + 再検証
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_ALREADY_USED' USING ERRCODE = 'P0001';
  END IF;
  -- 期限切れ (pending のまま日付超過) でも拒否は許可 (v2 踏襲: 本人の意思表示を優先)

  SELECT email INTO v_caller_email FROM auth.users WHERE id = auth.uid();
  IF v_caller_email IS NULL OR lower(v_caller_email) <> lower(v_request.email) THEN
    RAISE EXCEPTION 'PROMOTION_EMAIL_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_promotion_requests
    SET status = 'rejected', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE id = v_request.id
    RETURNING * INTO v_request;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_request.family_id, 'child_promotion_rejected', auth.uid(), auth.uid(),
          jsonb_build_object('member_id', v_request.member_id, 'request_id', v_request.id));

  RETURN v_request;
EXCEPTION
  WHEN deadlock_detected THEN
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;

REVOKE EXECUTE ON FUNCTION public.reject_child_promotion(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_child_promotion(text) TO authenticated;

-- ----------------------------------------------------------------
-- (4) revoke_child_promotion — 発行側 rep/adult が取消 (member_id キー = DELETE ルート用)。
--     ★v3 (G10): v2 は member 行を無ロックで読んでいた。canonical 順の先頭ロックとして
--     FOR UPDATE に変更 (member 不在時の NULL ロール → NOT_FAMILY_ADULT 挙動は不変)。
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_child_promotion(p_member_id UUID)
RETURNS family_promotion_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_role family_role_enum;
  v_member family_members;
  v_request family_promotion_requests;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK-ORDER: family_members -> family_promotion_requests
  SELECT * INTO v_member FROM family_members WHERE id = p_member_id FOR UPDATE;
  SELECT role INTO v_caller_role FROM family_members
    WHERE family_id = v_member.family_id AND user_id = auth.uid() AND status = 'active';
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('representative','adult') THEN
    RAISE EXCEPTION 'NOT_FAMILY_ADULT' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_request FROM family_promotion_requests
    WHERE member_id = p_member_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMOTION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  UPDATE family_promotion_requests
    SET status = 'revoked', resolved_at = NOW(), resolved_by = auth.uid()
    WHERE id = v_request.id
    RETURNING * INTO v_request;

  INSERT INTO membership_audit (scope, scope_id, action, actor_id, target_user_id, metadata)
  VALUES ('family', v_request.family_id, 'child_promotion_revoked', auth.uid(), NULL,
          jsonb_build_object('member_id', p_member_id, 'request_id', v_request.id));

  RETURN v_request;
EXCEPTION
  WHEN deadlock_detected THEN
    RAISE EXCEPTION 'CONFLICT_RETRY' USING ERRCODE = 'P0001';
END $$;

REVOKE EXECUTE ON FUNCTION public.revoke_child_promotion(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_child_promotion(uuid) TO authenticated;

-- ----------------------------------------------------------------
-- (5) get_promotion_details — 承認ページ用の read-only 詳細取得 (v2 §3-2(5) と同一。
--     行ロック無し・ロック順規約の対象外)。
-- ★#1232 v2 (G2): family_promotion_requests への「対象者本人 SELECT ポリシー」の代替。
-- get_invite_details (20260511000133) と同型の SECURITY DEFINER。auth.users 参照は
-- この関数本体内のみで行い、RLS USING 句では一切行わない。
--
-- ⚠️ anon への GRANT は意図的 (20260711130000 の除外リストと同じクラス):
-- メールリンクを踏んだ未ログイン/未登録ユーザーが、ログイン・サインアップ前に
-- 「何に同意を求められているか」を確認できる必要がある (/invite/[token] と同じ UX)。
-- token (64桁hex) の保有が実質の資格であり、返す情報は招待プレビューと同水準。
-- 将来 anon EXECUTE 棚卸し (#1020 系) を行う際もこの関数は除外対象とすること。
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_promotion_details(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request family_promotion_requests;
  v_family_name TEXT;
  v_member_name TEXT;
  v_requested_by_name TEXT;
  v_email_matches BOOLEAN;
BEGIN
  SELECT * INTO v_request FROM family_promotion_requests WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN NULL; -- 見つからない場合 NULL (get_invite_details と同じ)
  END IF;

  SELECT name INTO v_family_name FROM family_groups WHERE id = v_request.family_id;
  SELECT display_name INTO v_member_name FROM family_members WHERE id = v_request.member_id;
  SELECT COALESCE(up.nickname, au.email) INTO v_requested_by_name
    FROM auth.users au
    LEFT JOIN user_profiles up ON up.id = au.id
    WHERE au.id = v_request.requested_by;

  v_email_matches := FALSE;
  IF auth.uid() IS NOT NULL THEN
    SELECT lower(au.email) = lower(v_request.email)
      INTO v_email_matches
      FROM auth.users au WHERE au.id = auth.uid();
  END IF;

  RETURN jsonb_build_object(
    'family_name', v_family_name,
    'member_display_name', v_member_name,
    'requested_by_name', v_requested_by_name,
    'email', v_request.email,
    'status', v_request.status,
    'expires_at', v_request.expires_at,
    'current_user_email_matches', v_email_matches
  );
END $$;

REVOKE EXECUTE ON FUNCTION public.get_promotion_details(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_promotion_details(text) TO anon, authenticated;
