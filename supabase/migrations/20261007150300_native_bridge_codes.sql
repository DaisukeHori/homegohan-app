-- migration: 20261007150300_native_bridge_codes.sql
-- #1036: モバイル WebView 認証ブリッジのワンタイムコード (1/1) — テーブル + 発行 / 消費 RPC
--
-- 背景: モバイルアプリは WebView を認証済みにするため、Supabase のアクセストークンと
-- リフレッシュトークンを URL クエリ (GET /auth/native-bridge?access_token=...&refresh_token=...)
-- に載せて Web へ渡していた。URL はサーバ・CDN・プロキシのアクセスログやブラウザ履歴に残るため、
-- 有効なリフレッシュトークンがそのままログに漏れる (#1036, critical)。
-- 本 migration は「URL にはワンタイムコードだけを載せ、サーバ側でコードをトークンに交換する」方式の
-- 土台を作る。
--   ネイティブ -> POST /api/auth/native-bridge/code (Bearer JWT) -> コード発行 (本テーブルに保存)
--   WebView   -> GET  /auth/native-bridge?code=...               -> 消費 (DELETE ... RETURNING) -> Cookie セッション
--
-- 変更:
--   1. public.native_bridge_codes を新設する。
--      - code_hash は sha256(コード) の 16 進。コード本体は保存しない (DB が漏れてもコードは復元できない)。
--      - 有効期間は既定 60 秒 (CHECK で最大 5 分)。1 回使うと消える。
--      - access_token / refresh_token は平文列 (有効期間 60 秒以内・service_role のみ・消費時に削除。
--        auth.refresh_tokens も平文で持っており、新しい種類の露出は増えない。暗号化して持つかどうかは
--        オーナーの確認待ちで、この版は平文を既定とする。必要になれば別の migration で列を足す)。
--   2. issue_native_bridge_code(...) を新設する。期限切れ行の掃除と、1 ユーザーあたり 20 件の上限を持つ。
--      pg_cron は使わず、発行のたびに全ユーザー分の期限切れ行を掃除する (使われずに残った行は次の発行で消える)。
--   3. consume_native_bridge_code(p_code_hash) を新設する。DELETE ... RETURNING による原子的な 1 回限りの消費。
--      期限切れでも一致した行は削除する (トークンを DB に残さない)。返すのは期限内の行だけ。
--   4. 権限は service_role のみ。anon / authenticated はテーブルも RPC も 42501 になる。
--
-- 設計上の判断:
--   - consume は期限切れ行も削除する (期限内の行だけを返す)。期限切れ行を残すと、有効なリフレッシュトークンが
--     DB に残り続けるため。
--   - pg_cron による定期掃除は入れない。発行のたびに掃除するだけで足り、cron 拡張の有無に migration が依存しない。
--
-- 冪等: CREATE TABLE / INDEX IF NOT EXISTS、DROP POLICY IF EXISTS -> CREATE POLICY、CREATE OR REPLACE FUNCTION。
--       REVOKE / GRANT は何度流しても同じ結果になる。
-- ロールバック: supabase/rollbacks/20261007150300_native_bridge_codes.down.sql
--   (行は最長 60 秒しか生きないので、戻しても失うデータは実質ない。先に Web のデプロイを戻すこと)

CREATE TABLE IF NOT EXISTS public.native_bridge_codes (
  code_hash     TEXT        PRIMARY KEY,   -- hex(sha256(code))。コード本体は保存しない
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '60 seconds'),
  CONSTRAINT native_bridge_codes_code_hash_format CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT native_bridge_codes_ttl CHECK (
    expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'
  )
);

-- 期限切れの掃除用
CREATE INDEX IF NOT EXISTS idx_native_bridge_codes_expires_at
  ON public.native_bridge_codes (expires_at);
-- 1 ユーザーあたりの上限 (古い順に捨てる) 用
CREATE INDEX IF NOT EXISTS idx_native_bridge_codes_user_created
  ON public.native_bridge_codes (user_id, created_at DESC);

ALTER TABLE public.native_bridge_codes ENABLE ROW LEVEL SECURITY;

-- 権限設計:
-- - 読み書きは service_role (サーバの API ルート) のみ。クライアント (anon / authenticated) には何も開けない。
-- - Supabase の default privileges は CREATE TABLE 時点で anon / authenticated / service_role に
--   テーブル権限を自動付与する。REVOKE FROM PUBLIC だけでは剥がれないため、ロール個別に完全形で REVOKE する
--   (20261007112000_family_promotion_requests.sql と同じ理屈)。
-- - service_role に残すのは SELECT / INSERT / DELETE だけ (UPDATE は使わない)。
--   RPC は SECURITY INVOKER なので、呼び出し元 (service_role) の権限で DELETE ... RETURNING / INSERT を実行する。
REVOKE ALL ON public.native_bridge_codes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.native_bridge_codes TO service_role;

-- 上の REVOKE で anon / authenticated は権限エラー (42501) になるが、多層防御としてポリシーでも拒否を明示する
-- (service_role は BYPASSRLS のため影響を受けない)。
DROP POLICY IF EXISTS native_bridge_codes_deny_client_access ON public.native_bridge_codes;
CREATE POLICY native_bridge_codes_deny_client_access ON public.native_bridge_codes
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.native_bridge_codes IS
  '#1036: モバイル WebView 認証ブリッジのワンタイムコード (sha256 のみ保存)。有効 60 秒・消費時に削除。service_role のみ。';
COMMENT ON COLUMN public.native_bridge_codes.code_hash IS
  'hex(sha256(code))。コード本体は保存しない';
COMMENT ON COLUMN public.native_bridge_codes.access_token IS
  '発行時点のアクセストークン (平文。有効期間 60 秒以内・消費時に削除)';
COMMENT ON COLUMN public.native_bridge_codes.refresh_token IS
  '発行時点のリフレッシュトークン (平文。有効期間 60 秒以内・消費時に削除)';

-- ─────────────────────────────────────────────────────────
-- 発行: コードのハッシュとトークンを保存する (コード本体の生成とハッシュ化は呼び出し側)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.issue_native_bridge_code(
  p_code_hash     TEXT,
  p_user_id       UUID,
  p_access_token  TEXT,
  p_refresh_token TEXT,
  p_ttl_seconds   INTEGER DEFAULT 60
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expires_at TIMESTAMPTZ;
BEGIN
  -- 有効期間は 1〜120 秒 (テーブルの CHECK は最大 5 分。それより厳しく関数側で絞る)
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 120 THEN
    RAISE EXCEPTION 'issue_native_bridge_code: invalid ttl' USING ERRCODE = '22023';
  END IF;

  -- 期限切れ行の掃除 (idx_native_bridge_codes_expires_at を使う)。
  -- FOR UPDATE SKIP LOCKED は使わない: 行ロックの句は UPDATE 権限も要求するが、service_role に
  -- 付けるのは SELECT / INSERT / DELETE だけにしている。
  DELETE FROM public.native_bridge_codes WHERE expires_at < now();

  -- 1 ユーザーあたりの未消費コードは最大 20 件。新しい 19 件を残し、これから 1 件入れる
  -- (タブを開くたびに発行されるため、連打や異常なクライアントでテーブルを肥大させない)
  DELETE FROM public.native_bridge_codes
   WHERE code_hash IN (
     SELECT code_hash
       FROM public.native_bridge_codes
      WHERE user_id = p_user_id
      ORDER BY created_at DESC, code_hash
     OFFSET 19
   );

  INSERT INTO public.native_bridge_codes (code_hash, user_id, access_token, refresh_token, expires_at)
  VALUES (
    p_code_hash,
    p_user_id,
    p_access_token,
    p_refresh_token,
    now() + make_interval(secs => p_ttl_seconds)
  )
  RETURNING expires_at INTO v_expires_at;

  RETURN v_expires_at;
END $$;

-- ─────────────────────────────────────────────────────────
-- 消費: 原子的な 1 回限りの引き換え
--   - 同じコードを同時に 2 回消費しても、行を返すのは片方だけ (DELETE が行ロックを取るため)
--   - 一致した行は期限切れでも削除する。返すのは期限内 (DB の時計) の行だけ
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.consume_native_bridge_code(p_code_hash TEXT)
RETURNS TABLE (user_id UUID, access_token TEXT, refresh_token TEXT)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH consumed AS (
    DELETE FROM public.native_bridge_codes AS c
     WHERE c.code_hash = p_code_hash
    RETURNING c.user_id, c.access_token, c.refresh_token, c.expires_at
  )
  SELECT consumed.user_id, consumed.access_token, consumed.refresh_token
    FROM consumed
   WHERE consumed.expires_at > now();
$$;

-- 関数の権限: service_role のみ。
-- Supabase は関数作成時に anon / authenticated / service_role へ EXECUTE を自動付与し、PUBLIC にも EXECUTE が付く。
-- 引数の型まで含めた完全形で REVOKE する (#1039 / #1020 と同じ理屈)。
REVOKE ALL ON FUNCTION public.issue_native_bridge_code(TEXT, UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_native_bridge_code(TEXT, UUID, TEXT, TEXT, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.consume_native_bridge_code(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_native_bridge_code(TEXT)
  TO service_role;

COMMENT ON FUNCTION public.issue_native_bridge_code(TEXT, UUID, TEXT, TEXT, INTEGER) IS
  '#1036: ワンタイムコード (sha256) とトークンを保存して期限を返す。期限切れ行の掃除と 1 ユーザー 20 件の上限つき。service_role のみ。';
COMMENT ON FUNCTION public.consume_native_bridge_code(TEXT) IS
  '#1036: コードのハッシュに一致する行を削除して (user_id, access_token, refresh_token) を返す。期限切れは返さない。service_role のみ。';
