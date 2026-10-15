-- migration: 20261016236000_auth_history_sessions.sql
-- ログイン履歴・不審なログインの通知・セッションの一覧と失効・パスワードの再利用の防止 の DB (#1190・#1189・#1198。段 A。
-- 設計の正典 docs/design/cross/16-auth-history-sessions.md §11。下の SQL は §11.1〜§11.6 の写し)
--
-- 1. user_sessions_metadata に列 12 本・索引 2 本・CHECK 3 本を足し、本人の UPDATE のポリシー (sessions_revoke_self) を消す。
--    本人 (authenticated) は SELECT だけ。password_history は anon / authenticated から何もできない (§11.1)
-- 2. 既存の auth.sessions を live の行として写し、既存の利用者の現在のパスワードのハッシュを履歴の 1 件目にする (§11.2。冪等)
-- 3. auth.sessions (作成・更新・削除) と auth.users (パスワードの変更) のトリガー 4 本、user_profiles の BEFORE INSERT のトリガー 1 本 (§11.3)。
--    auth の表の所有者は supabase_auth_admin で、postgres は CREATE TRIGGER はできるが DROP TRIGGER はできないので、
--    同じ名前のトリガーが無いときだけ作る。記録の失敗はどのトリガーでも握り、ログイン・更新・ログアウト・パスワードの変更を止めない
-- 4. RPC: auth_session_revoke (本人の 1 端末の失効)・claim_login_alerts / release_login_alert (通知の取り置き・戻し)・
--    auth_password_check (現在のパスワードの確認と履歴の照合) (§11.4・§11.5)
-- 5. 保守の関数 3 本と pg_cron のジョブ cleanup-auth-sessions-and-login-history (毎日 03:55 JST) (§11.6)
--
-- 戻し方: supabase/rollbacks/20261016236000_auth_history_sessions.down.sql (auth の表のトリガー 4 本は消せないので、関数の本体を空にして残す §11.7)
-- 確かめるテスト: tests/auth-history-sessions-migration-contract.test.ts (文面)・tests/integration/security/auth-history-sessions.test.ts (実 DB)・
--   tests/integration/security/anon-definer-execute.test.ts (EXECUTE の権限)

-- 1. 列 (既存: session_id, user_id, device_name, ip_address, user_agent, created_at, last_active_at, revoked_at)
ALTER TABLE public.user_sessions_metadata
  ADD COLUMN IF NOT EXISTS ip_network     inet,
  ADD COLUMN IF NOT EXISTS country_code   character(2),
  ADD COLUMN IF NOT EXISTS context_source text NOT NULL DEFAULT 'auth',
  ADD COLUMN IF NOT EXISTS device_family  text,
  ADD COLUMN IF NOT EXISTS is_new_device  boolean,
  ADD COLUMN IF NOT EXISTS is_new_ip      boolean,
  ADD COLUMN IF NOT EXISTS is_new_country boolean,
  ADD COLUMN IF NOT EXISTS alert_status   text NOT NULL DEFAULT 'done',
  ADD COLUMN IF NOT EXISTS alert_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS alert_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS alert_sent_at  timestamptz,
  ADD COLUMN IF NOT EXISTS ended_reason   text;

ALTER TABLE public.user_sessions_metadata
  ADD CONSTRAINT user_sessions_metadata_context_source_check CHECK (context_source IN ('auth', 'web', 'mobile')),
  ADD CONSTRAINT user_sessions_metadata_alert_status_check   CHECK (alert_status IN ('pending', 'processing', 'done')),
  ADD CONSTRAINT user_sessions_metadata_ended_reason_check   CHECK (ended_reason IS NULL OR ended_reason IN ('signed_out', 'revoked_by_user', 'idle_expired'));

COMMENT ON COLUMN public.user_sessions_metadata.context_source IS 'ip_address / user_agent の出どころ。auth = GoTrue の記録 (Web は Next.js のサーバーの値)、web = Web の route が request の値で上書き、mobile = アプリが端末名を登録';
COMMENT ON COLUMN public.user_sessions_metadata.ip_network IS 'IPv4 は /24、IPv6 は /48 (ホスト単位では比べない)';
COMMENT ON COLUMN public.user_sessions_metadata.alert_status IS '不審なログインの通知の進み (pending → processing → done)。pending で作るのはトリガー auth_session_created だけ。既定の done は、列を足した時点の行 (ロールバックの後にもう一度流したときに残っていた行) とトリガー以外が作る行を、通知の対象にしないため。cross/16 §10・§11.4';

-- 2. 索引 (既存: idx_sessions_user (user_id, last_active_at DESC))
CREATE INDEX IF NOT EXISTS idx_sessions_alert_queue ON public.user_sessions_metadata (created_at) WHERE alert_status <> 'done';
CREATE INDEX IF NOT EXISTS idx_sessions_ended       ON public.user_sessions_metadata (revoked_at) WHERE revoked_at IS NOT NULL;

-- 3. 権限とポリシー。本人は SELECT だけ (sessions_self は残す)。書くのは service_role・SECURITY DEFINER の関数・トリガーだけ
DROP POLICY IF EXISTS sessions_revoke_self ON public.user_sessions_metadata;
REVOKE ALL ON TABLE public.user_sessions_metadata FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_sessions_metadata TO authenticated;
REVOKE ALL ON TABLE public.password_history FROM PUBLIC, anon, authenticated;

-- [cross16-backfill:begin]
-- 既存のセッション (1,331 行) を live として写す。通知はしない (alert_status = 'done')
INSERT INTO public.user_sessions_metadata
  (session_id, user_id, ip_address, ip_network, user_agent, created_at, last_active_at, context_source, alert_status)
SELECT s.id::text, s.user_id, s.ip,
       CASE WHEN s.ip IS NULL THEN NULL WHEN family(s.ip) = 4 THEN network(set_masklen(s.ip, 24)) ELSE network(set_masklen(s.ip, 48)) END,
       s.user_agent, s.created_at, COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.created_at), 'auth', 'done'
FROM auth.sessions s
ON CONFLICT (session_id) DO NOTHING;

-- 既存の利用者 (195 人) の現在のパスワードのハッシュを履歴の 1 件目にする (移行前の現在のパスワードも世代に数える)
INSERT INTO public.password_history (user_id, password_hash, changed_at)
SELECT u.id, u.encrypted_password, COALESCE(u.updated_at, u.created_at, pg_catalog.now())
FROM auth.users u
WHERE u.encrypted_password IS NOT NULL AND u.encrypted_password <> ''
  AND NOT EXISTS (SELECT 1 FROM public.password_history h WHERE h.user_id = u.id)
ON CONFLICT (user_id, changed_at) DO NOTHING;
-- [cross16-backfill:end]

CREATE OR REPLACE FUNCTION public.auth_session_created()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  -- 「同じ場所」とみなす範囲。src/lib/auth/sessions/constants.ts の IP_NETWORK_PREFIX_V4 / V6 と同じ値 (契約テスト §20.3)
  c_prefix_v4 CONSTANT integer := 24;
  c_prefix_v6 CONSTANT integer := 48;
BEGIN
  INSERT INTO public.user_sessions_metadata
    (session_id, user_id, ip_address, ip_network, user_agent, created_at, last_active_at, context_source, alert_status)
  VALUES
    (NEW.id::text, NEW.user_id, NEW.ip,
     CASE WHEN NEW.ip IS NULL THEN NULL
          WHEN family(NEW.ip) = 4 THEN network(set_masklen(NEW.ip, c_prefix_v4))
          ELSE network(set_masklen(NEW.ip, c_prefix_v6)) END,
     NEW.user_agent, NEW.created_at, COALESCE(NEW.refreshed_at AT TIME ZONE 'UTC', NEW.created_at), 'auth', 'pending')
  ON CONFLICT (session_id) DO NOTHING;

  UPDATE public.user_profiles
     SET last_login_at = NEW.created_at, login_count = COALESCE(login_count, 0) + 1
   WHERE id = NEW.user_id;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- 記録の失敗でログインを止めない (R-13)。値 (IP / UA) はログに出さない
  RAISE WARNING 'auth_session_created failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_session_refreshed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- refresh した側の user_agent / ip は写さない (Web の refresh は Next.js のサーバーが行う §3)
  UPDATE public.user_sessions_metadata
     SET last_active_at = COALESCE(NEW.refreshed_at AT TIME ZONE 'UTC', pg_catalog.now())
   WHERE session_id = NEW.id::text;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auth_session_refreshed failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_session_deleted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.user_sessions_metadata
     SET revoked_at = COALESCE(revoked_at, pg_catalog.now()),
         ended_reason = COALESCE(ended_reason, 'signed_out')
   WHERE session_id = OLD.id::text;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auth_session_deleted failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.password_history_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  -- 残す世代の最大 = 運営の世代数 (cross/01 §7.1)。src/lib/auth/password/policy.ts の PASSWORD_HISTORY_MAX_GENERATIONS と同じ値 (契約テスト)
  c_max_generations CONSTANT integer := 10;
BEGIN
  IF NEW.encrypted_password IS NULL OR NEW.encrypted_password = '' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.encrypted_password IS NOT DISTINCT FROM NEW.encrypted_password THEN RETURN NULL; END IF;

  INSERT INTO public.password_history (user_id, password_hash, changed_at)
  VALUES (NEW.id, NEW.encrypted_password, pg_catalog.clock_timestamp())
  ON CONFLICT (user_id, changed_at) DO NOTHING;

  DELETE FROM public.password_history h
   WHERE h.user_id = NEW.id
     AND h.changed_at < (SELECT min(newest.changed_at)
                           FROM (SELECT changed_at FROM public.password_history
                                  WHERE user_id = NEW.id ORDER BY changed_at DESC LIMIT c_max_generations) AS newest);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'password_history_record failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NULL;
END;
$$;

-- トリガー (auth の表に足すのはトリガーだけ。表・列は変えない)。auth.sessions / auth.users の所有者は supabase_auth_admin で、
-- postgres は TRIGGER の権限で CREATE TRIGGER はできるが、DROP TRIGGER はできない (表の所有者だけ。IF EXISTS でも、トリガーが
-- あると所有者の確認で失敗する §3)。よって DROP TRIGGER を書かず、同じ名前のトリガーが無いときだけ作る (2 回目の適用・ロールバック
-- の後の適用では作らない。本体は上の CREATE OR REPLACE FUNCTION が入れ替える。トリガーの定義 (時機・列・WHEN) を変えたくなったら、
-- 同じ名前は使えないので新しい名前で作る)。2 行の目印の間は結合テスト (§20.3) が切り出してもう一度流す
-- [cross16-auth-triggers:begin]
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.sessions'::regclass AND t.tgname = 'on_auth_session_created') THEN
    CREATE TRIGGER on_auth_session_created AFTER INSERT ON auth.sessions
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_created();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.sessions'::regclass AND t.tgname = 'on_auth_session_refreshed') THEN
    CREATE TRIGGER on_auth_session_refreshed AFTER UPDATE OF refreshed_at ON auth.sessions
      FOR EACH ROW WHEN (OLD.refreshed_at IS DISTINCT FROM NEW.refreshed_at) EXECUTE FUNCTION public.auth_session_refreshed();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.sessions'::regclass AND t.tgname = 'on_auth_session_deleted') THEN
    CREATE TRIGGER on_auth_session_deleted AFTER DELETE ON auth.sessions
      FOR EACH ROW EXECUTE FUNCTION public.auth_session_deleted();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'on_auth_user_password_changed') THEN
    CREATE TRIGGER on_auth_user_password_changed AFTER INSERT OR UPDATE OF encrypted_password ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.password_history_record();
  END IF;
END $$;
-- [cross16-auth-triggers:end]

-- 権限: 誰にも直接は実行させない (anon の番兵 §22 N-19)。トリガーとして動くときは EXECUTE を確かめられない (確かめるのは CREATE TRIGGER の時だけ。
-- migration 20261010000100 の注記と同じ)。auth の表の 4 本は、GoTrue の役割 (supabase_auth_admin) にだけ GRANT を明示しておく
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['auth_session_created', 'auth_session_refreshed', 'auth_session_deleted', 'password_history_record'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I() TO supabase_auth_admin', fn);
  END LOOP;
END $$;

-- プロフィールの行を作るときに、それまでのログインを入れる (R-10・§8 の行 23)。新規登録の直後の最初のログインでは
-- user_profiles の行がまだ無く (行は同意 accept_legal_documents・モバイルの初期設定・招待の承諾が作る)、auth_session_created の
-- UPDATE が 0 行になるため。SECURITY INVOKER: 行を作るのは authenticated (本人の upsert。user_sessions_metadata の本人の行は
-- sessions_self で読める)・service_role・postgres (SECURITY DEFINER の RPC) で、どれも同じ利用者の行を読める。
-- 特権列ガード (trg_guard_user_profiles_privileged_on_insert) は last_login_at / login_count を見ないので、発火の順 (名前の順) に依らない
CREATE OR REPLACE FUNCTION public.user_profiles_fill_login_stats()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_last_login  timestamptz;
  v_login_count integer;
BEGIN
  -- 値を明示して作る行 (移行・テスト) は変えない
  IF NEW.last_login_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT max(m.created_at), count(*)::integer INTO v_last_login, v_login_count
    FROM public.user_sessions_metadata m
   WHERE m.user_id = NEW.id;
  IF v_login_count > 0 THEN
    NEW.last_login_at := v_last_login;
    NEW.login_count := GREATEST(COALESCE(NEW.login_count, 0), v_login_count);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 記録の失敗で同意・初期設定を止めない (R-13)
  RAISE WARNING 'user_profiles_fill_login_stats failed: % (%)', SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.user_profiles_fill_login_stats() FROM PUBLIC, anon, authenticated, service_role;
-- user_profiles の所有者は postgres (§3) なので、こちらは DROP TRIGGER IF EXISTS → CREATE で作り直せる
DROP TRIGGER IF EXISTS trg_user_profiles_fill_login_stats ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_fill_login_stats BEFORE INSERT ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.user_profiles_fill_login_stats();
COMMENT ON COLUMN public.user_profiles.last_login_at IS '最終ログイン日時。auth.sessions の INSERT のトリガー auth_session_created が書き、行がまだ無かった最初のログインは行を作るときのトリガー user_profiles_fill_login_stats が入れる (cross/16 §11.3)';

CREATE OR REPLACE FUNCTION public.auth_session_revoke(p_session_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_current text := auth.jwt() ->> 'session_id';
  v_deleted integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000'; END IF;
  IF v_current IS NOT NULL AND v_current = p_session_id::text THEN RETURN 'current'; END IF;

  UPDATE public.user_sessions_metadata SET ended_reason = 'revoked_by_user'
   WHERE session_id = p_session_id::text AND user_id = v_uid AND revoked_at IS NULL;
  DELETE FROM auth.sessions s WHERE s.id = p_session_id AND s.user_id = v_uid;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN
    UPDATE public.user_sessions_metadata SET ended_reason = NULL
     WHERE session_id = p_session_id::text AND user_id = v_uid AND revoked_at IS NULL;
    RETURN 'not_found';
  END IF;
  RETURN 'revoked';
END;
$$;
REVOKE ALL ON FUNCTION public.auth_session_revoke(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_session_revoke(uuid) TO authenticated;
COMMENT ON FUNCTION public.auth_session_revoke(uuid) IS '本人 (auth.uid()) のセッション 1 つを auth.sessions から消す。自分のセッション (auth.jwt() の session_id) は ''current''、無ければ ''not_found''、消せたら ''revoked''。終了は on_auth_session_deleted が刻む (ended_reason は先に revoked_by_user にしておく)。cross/16 §11.4';

CREATE OR REPLACE FUNCTION public.claim_login_alerts(
  p_batch_size integer, p_min_age_seconds integer, p_reclaim_minutes integer, p_max_age_hours integer)
RETURNS SETOF public.user_sessions_metadata
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_min_age_seconds IS NULL OR p_min_age_seconds < 0
     OR p_reclaim_minutes IS NULL OR p_reclaim_minutes < 1 OR p_max_age_hours IS NULL OR p_max_age_hours < 1 THEN
    RAISE EXCEPTION 'claim_login_alerts: argument out of range' USING ERRCODE = '22023';
  END IF;
  -- 1. 期限切れ: 作成から p_max_age_hours を過ぎた待ちの行 (と、取り直しの時機を過ぎた processing の行) は、送らずに done にする。
  --    段 A のデプロイから段 B の worker まで・worker が止まっていた間に溜まった行を、後からまとめて送らない (§10 の期限切れの行・S-34)。
  --    印 (device_family・is_new_*) と alert_sent_at は NULL のまま (判定していない)。ほかの worker がロック中の行は飛ばす
  WITH stale AS (
    SELECT m.session_id
      FROM public.user_sessions_metadata m
     WHERE m.created_at < pg_catalog.now() - pg_catalog.make_interval(hours => p_max_age_hours)
       AND (m.alert_status = 'pending'
            OR (m.alert_status = 'processing'
                AND m.alert_claimed_at < pg_catalog.now() - pg_catalog.make_interval(mins => p_reclaim_minutes)))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.user_sessions_metadata m
     SET alert_status = 'done', alert_claimed_at = NULL
    FROM stale
   WHERE m.session_id = stale.session_id;

  -- 2. 取り置き: 候補を古い順に p_batch_size 行まで選んでロックする。ほかの worker がロック中の行は飛ばす (同じ行を 2 つの worker が取らない S-19)
  -- revoked_at は見ない: 判定の前に終わったログイン (すぐのログアウト・GoTrue が消した他の端末) も判定して知らせる (§10 の ended の行・S-29)
  -- now() はトランザクションの開始の時刻で 1 の文と同じ値なので、1 で done にしなかった行 (作成から p_max_age_hours 以内) だけが候補になる
  RETURN QUERY
  WITH picked AS (
    SELECT m.session_id
      FROM public.user_sessions_metadata m
     WHERE m.created_at <= pg_catalog.now() - pg_catalog.make_interval(secs => p_min_age_seconds)
       AND m.created_at >= pg_catalog.now() - pg_catalog.make_interval(hours => p_max_age_hours)
       AND (m.alert_status = 'pending'
            OR (m.alert_status = 'processing'
                AND m.alert_claimed_at < pg_catalog.now() - pg_catalog.make_interval(mins => p_reclaim_minutes)))
     ORDER BY m.created_at
     LIMIT p_batch_size
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.user_sessions_metadata m
     SET alert_status = 'processing', alert_claimed_at = pg_catalog.now()
    FROM picked
   WHERE m.session_id = picked.session_id
  RETURNING m.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_login_alert(p_session_id text, p_max_attempts integer)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_session_id IS NULL OR p_max_attempts IS NULL OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'release_login_alert: argument out of range' USING ERRCODE = '22023';
  END IF;
  -- processing の行だけを戻す。数えた回数が p_max_attempts に届いたら諦めて done (§10 の例外の行)
  UPDATE public.user_sessions_metadata m
     SET alert_attempts = m.alert_attempts + 1,
         alert_status = CASE WHEN m.alert_attempts + 1 >= p_max_attempts THEN 'done' ELSE 'pending' END,
         alert_claimed_at = NULL
   WHERE m.session_id = p_session_id
     AND m.alert_status = 'processing';
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['claim_login_alerts(integer, integer, integer, integer)', 'release_login_alert(text, integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.auth_password_check(
  p_user_id uuid, p_current_password text, p_new_password text, p_generations integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c_max_generations CONSTANT integer := 10;   -- password_history_record と同じ
  c_bcrypt_prefix   CONSTANT text := '$2%';   -- pgcrypto の crypt() が比べられる bcrypt。ほかの形式は比べない (crypt に渡さない)
  v_hash       text;
  v_has_hash   boolean;
  v_comparable boolean;
  v_reused     boolean;
BEGIN
  IF p_generations IS NULL OR p_generations < 1 OR p_generations > c_max_generations THEN
    RAISE EXCEPTION 'p_generations out of range' USING ERRCODE = '22023';
  END IF;
  SELECT u.encrypted_password INTO v_hash FROM auth.users u WHERE u.id = p_user_id;
  v_has_hash   := v_hash IS NOT NULL AND v_hash <> '';
  v_comparable := v_has_hash AND v_hash LIKE c_bcrypt_prefix;

  -- 変更 (p_current_password がある): 現在のパスワードを確かめる。パスワードが無い・比べられない形なら確かめられないので断る
  IF p_current_password IS NOT NULL THEN
    IF NOT v_has_hash THEN RETURN 'no_password'; END IF;
    IF NOT v_comparable THEN RETURN 'unsupported_hash'; END IF;
    IF v_hash <> extensions.crypt(p_current_password, v_hash) THEN RETURN 'current_mismatch'; END IF;
  END IF;
  -- 再設定 (p_current_password が NULL。メールのリンク / コードで本人を確かめた §14.7) は、パスワードが無い (Google / Apple だけ)・
  -- 比べられない形でも止めない。いまの再設定の画面 (updateUser) と同じく、最初のパスワードを作れる (S-28)

  -- 直近 p_generations 世代 (履歴に写した現在のパスワードを含む) と比べる。bcrypt でない行は CASE で crypt に渡さない
  SELECT EXISTS (
    SELECT 1 FROM (SELECT h.password_hash FROM public.password_history h
                    WHERE h.user_id = p_user_id ORDER BY h.changed_at DESC LIMIT p_generations) AS recent
     WHERE CASE WHEN recent.password_hash LIKE c_bcrypt_prefix
                THEN recent.password_hash = extensions.crypt(p_new_password, recent.password_hash)
                ELSE false END
  ) INTO v_reused;
  IF v_reused THEN RETURN 'reused'; END IF;
  -- 現在のパスワードと同じ (履歴に無い場合の念のため)。比べられるときだけ
  IF v_comparable THEN
    IF v_hash = extensions.crypt(p_new_password, v_hash) THEN RETURN 'reused'; END IF;
  END IF;
  RETURN 'ok';
END;
$$;
REVOKE ALL ON FUNCTION public.auth_password_check(uuid, text, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_password_check(uuid, text, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.expire_idle_auth_sessions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  -- 更新 (refresh) の無いまま終える日数。cross/01 §4.1 の個人の絶対タイムアウト。constants.ts の SESSION_IDLE_EXPIRE_DAYS と同じ値
  c_idle   CONSTANT interval := INTERVAL '30 days';
  v_ids    uuid[];
  v_count  integer;
BEGIN
  SELECT array_agg(s.id) INTO v_ids FROM auth.sessions s
   WHERE COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.created_at) < pg_catalog.now() - c_idle;
  IF v_ids IS NULL THEN RETURN 0; END IF;
  UPDATE public.user_sessions_metadata SET ended_reason = 'idle_expired'
   WHERE revoked_at IS NULL AND session_id = ANY (v_ids::text[]);
  DELETE FROM auth.sessions s WHERE s.id = ANY (v_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_user_sessions_metadata()
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  WITH fixed AS (
    UPDATE public.user_sessions_metadata m
       SET revoked_at = pg_catalog.now(), ended_reason = COALESCE(m.ended_reason, 'signed_out')
     WHERE m.revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id::text = m.session_id)
    RETURNING 1)
  SELECT count(*)::integer FROM fixed
$$;

CREATE OR REPLACE FUNCTION public.cleanup_ended_user_sessions_metadata()
RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
  WITH params AS (SELECT INTERVAL '90 days' AS retention),  -- constants.ts の LOGIN_HISTORY_RETENTION_DAYS と同じ値
  deleted AS (
    DELETE FROM public.user_sessions_metadata m USING params p
     WHERE m.revoked_at IS NOT NULL AND m.revoked_at < pg_catalog.now() - p.retention
    RETURNING 1)
  SELECT count(*)::integer FROM deleted
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['expire_idle_auth_sessions', 'reconcile_user_sessions_metadata', 'cleanup_ended_user_sessions_metadata'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I() TO service_role', fn);
  END LOOP;
END $$;

-- 毎日 03:55 JST (18:55 UTC)。ほかの毎日のジョブ (03:10 / 03:15 / 03:25 / 03:45 JST。docs/design/operator/08-cron-batches.md §3.0) と重ねない。同じ名前・同じ処理のジョブは先に外す (20261011070000 と同じ形)
DO $$
DECLARE v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid, jobname, schedule FROM cron.job
     WHERE jobname = 'cleanup-auth-sessions-and-login-history'
        OR command ~* '[[:<:]]expire_idle_auth_sessions[[:>:]]'
     ORDER BY jobid
  LOOP
    PERFORM cron.unschedule(v_job.jobid);
    RAISE NOTICE '登録済みの pg_cron のジョブを登録解除しました: jobid=%, jobname=%, schedule=%', v_job.jobid, v_job.jobname, v_job.schedule;
  END LOOP;
  PERFORM cron.schedule(
    'cleanup-auth-sessions-and-login-history',
    '55 18 * * *',
    'SELECT public.expire_idle_auth_sessions(), public.reconcile_user_sessions_metadata(), public.cleanup_ended_user_sessions_metadata();'
  );
END $$;
