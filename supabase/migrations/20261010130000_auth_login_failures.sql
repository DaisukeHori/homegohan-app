-- migration: 20261010130000_auth_login_failures.sql
-- #1165: ログイン失敗のロック (設計書 docs/design/cross/01-auth-session.md §8) の記録を置く
--
-- 背景:
--   Web のログインは、ブラウザから Supabase Auth を直接呼んでいた。サーバーが失敗の回数を数える場所が無く、
--   ロックは何も無かった (画面の 30 秒のクールダウンだけで、保存データを消せば外れる)。
--   この PR で、Web のログインをサーバーの POST /api/auth/login 経由にし、メールアドレスごとの連続失敗の回数と
--   ロックの期限を、このテーブルに記録する (Upstash Redis は未設定だとメモリ内の数え方になり、インスタンスをまたげない。
--   ロックの記録は確実に残す必要があるので DB に置く)。
--
-- 変更:
--   1. auth_login_failures (メールアドレスのハッシュごとに 1 行)
--      - email_hash: lower(btrim(メールアドレス)) の SHA-256 (16 進 64 文字)。メールアドレスそのものは残さない。
--        アカウントが存在しないメールアドレスでも同じように数える (ロックの有無からアカウントの有無が分からないように)。
--      - failure_count: 連続して失敗した回数。ログインに成功したとき、またはパスワードの再設定を済ませたときに行ごと消す。
--      - locked_until: この時刻まではログインを断る (正しいパスワードでも)。NULL はロックなし。
--      - 回数とロックの長さの対応 (3 回 → CAPTCHA、5 回 → 15 分、10 回 → 1 時間 + 本人へメール、20 回 → 24 時間 + 運営へ通知) は
--        アプリ (src/lib/auth/login-lock.ts) が持つ。DB は数えることと、渡された期限を記録することだけをする。
--   2. 関数 (すべて service_role だけが実行できる。anon / authenticated は 42501)
--      - auth_login_email_hash(p_email): ハッシュの計算。ほかの関数が使う。ハッシュの式はここ 1 か所だけ
--      - auth_login_lock_status(p_email): 回数とロックの期限を返す (行が無ければ 0 行)
--      - auth_login_record_failure(p_email): 回数を 1 増やし (行が無ければ 1 で作る)、増やした後の回数と期限を返す。
--        INSERT ... ON CONFLICT で 1 文なので、同時に失敗しても数え漏れない
--      - auth_login_apply_lock(p_email, p_locked_until): 期限を延ばす (今の期限より短くはしない)
--      - auth_login_clear_failures(p_email): 行を消す (成功・再設定)
--      - auth_login_account_user_id(p_email): そのメールアドレスのアカウントの user_id (無ければ NULL)。
--        10 回 / 20 回に達したときの通知の宛先を決めるのに使う。auth.users を読むので SECURITY DEFINER
--   3. RLS を有効にし、ポリシーは作らない。anon / authenticated からはテーブルの権限も外す。読み書きは service_role だけ。
--
-- 設計上の判断:
--   - SECURITY DEFINER は auth.users を読む auth_login_account_user_id だけ。ほかは SECURITY INVOKER
--     (呼ぶのは service_role で、テーブルの権限と RLS の BYPASS で足りる)。どれも SET search_path = '' で、参照は完全修飾。
--   - 新しい関数には Supabase の既定権限で anon / authenticated / service_role に EXECUTE が付き、PUBLIC にも付くので、
--     引数の型まで含めた完全形で REVOKE する (20261007160800_admin_user_email_lookup.sql と同じ理屈)。
--   - SHA-256 は PostgreSQL の組み込み (pg_catalog.sha256、PostgreSQL 11 以降)。拡張 (pgcrypto) に依存しない。
--   - auth.users の email は GoTrue が小文字で保存する。比較は u.email = lower(btrim(p_email)) にして、email の索引を使える形にする。
--
-- 既存の正当な利用経路への影響: なし (テーブルと関数の追加だけ。既存のデータには触れない)。
--   ログインの経路の変更 (Web の画面 → POST /api/auth/login) は同じ PR のアプリ側。
--   アプリが先に出て関数がまだ無いと、POST /api/auth/login は 500 を返す (ロックを判定できないときは通さない)。
--   migration は main へのマージで CI が本番へ適用するので、通常はアプリと同時に入る。
--
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION。REVOKE / GRANT は何度流しても同じ結果になる。
-- ロールバック: supabase/rollbacks/20261010130000_auth_login_failures.down.sql
-- 確認: tests/integration/security/auth-login-lock.test.ts

-- ─────────────────────────────────────────────────────────
-- 1. テーブル
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_login_failures (
  email_hash text PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  locked_until timestamptz,
  last_failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.auth_login_failures IS
  'ログインの連続失敗の回数とロックの期限 (#1165・設計 cross/01-auth-session.md §8)。メールアドレスは SHA-256 のハッシュだけを持つ。service_role だけが読み書きする';
COMMENT ON COLUMN public.auth_login_failures.email_hash IS
  'lower(btrim(メールアドレス)) の SHA-256 (16 進)。public.auth_login_email_hash で作る';
COMMENT ON COLUMN public.auth_login_failures.failure_count IS
  '連続して失敗した回数。ログインの成功・パスワードの再設定で行ごと消す';
COMMENT ON COLUMN public.auth_login_failures.locked_until IS
  'この時刻まではログインを断る (正しいパスワードでも)。NULL はロックなし';

ALTER TABLE public.auth_login_failures ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.auth_login_failures FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.auth_login_failures TO service_role;

-- ─────────────────────────────────────────────────────────
-- 2. 関数
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_login_email_hash(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT encode(pg_catalog.sha256(convert_to(lower(btrim(coalesce(p_email, ''))), 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION public.auth_login_lock_status(p_email text)
RETURNS TABLE (failure_count integer, locked_until timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT f.failure_count, f.locked_until
    FROM public.auth_login_failures AS f
   WHERE f.email_hash = public.auth_login_email_hash(p_email)
$$;

CREATE OR REPLACE FUNCTION public.auth_login_record_failure(p_email text)
RETURNS TABLE (failure_count integer, locked_until timestamptz)
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  INSERT INTO public.auth_login_failures AS f (email_hash, failure_count, last_failed_at, updated_at)
  VALUES (public.auth_login_email_hash(p_email), 1, now(), now())
  ON CONFLICT (email_hash) DO UPDATE
    SET failure_count = f.failure_count + 1,
        last_failed_at = now(),
        updated_at = now()
  RETURNING f.failure_count, f.locked_until
$$;

CREATE OR REPLACE FUNCTION public.auth_login_apply_lock(p_email text, p_locked_until timestamptz)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  UPDATE public.auth_login_failures AS f
     SET locked_until = GREATEST(coalesce(f.locked_until, p_locked_until), p_locked_until),
         updated_at = now()
   WHERE f.email_hash = public.auth_login_email_hash(p_email)
$$;

CREATE OR REPLACE FUNCTION public.auth_login_clear_failures(p_email text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $$
  DELETE FROM public.auth_login_failures AS f
   WHERE f.email_hash = public.auth_login_email_hash(p_email)
$$;

CREATE OR REPLACE FUNCTION public.auth_login_account_user_id(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT u.id
    FROM auth.users AS u
   WHERE u.email = lower(btrim(coalesce(p_email, '')))
   ORDER BY u.created_at, u.id
   LIMIT 1
$$;

-- 関数の権限: service_role のみ。
REVOKE ALL ON FUNCTION public.auth_login_email_hash(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_email_hash(text) TO service_role;

REVOKE ALL ON FUNCTION public.auth_login_lock_status(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_lock_status(text) TO service_role;

REVOKE ALL ON FUNCTION public.auth_login_record_failure(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_record_failure(text) TO service_role;

REVOKE ALL ON FUNCTION public.auth_login_apply_lock(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_apply_lock(text, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.auth_login_clear_failures(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_clear_failures(text) TO service_role;

REVOKE ALL ON FUNCTION public.auth_login_account_user_id(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_login_account_user_id(text) TO service_role;
