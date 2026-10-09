-- migration: 20261008200900_ops_alert_state.sql
-- #1157: 本番エラーの急増を運用メールに知らせるための DB 側の部品 (表 1 つ + 関数 3 本)
--
-- 背景:
--   オーナー判断 (2026-10-08, #1157): app_logs の error が急に増えたら、運用のメールアドレスに 1 通知らせる。
--   Vercel Cron が 15 分おきに GET /api/cron/app-log-alerts を呼び、直近 15 分の error 件数を数えて、しきい値を超えていたら
--   メールを送る (src/app/api/cron/app-log-alerts/route.ts)。この migration は、その route が使う DB 側の部品を足す。
--   infra_alerts は使わない (インフラ画面は「未接続」のままにする: #1180)。
--
-- 追加するもの:
--   1. public.ops_alert_state (alert_key PK, last_sent_at) — 「このアラートを最後に送った時刻」を覚える小さな表。
--      同じアラートを 60 分以内に送り直さないために使う。service_role だけが読み書きできる。
--   2. public.claim_ops_alert(p_alert_key, p_cooldown_minutes) — 「今、このアラートを送ってよいか」を決める関数。
--      送ってよければ、その場で last_sent_at を今にして、その時刻を返す (= 送る権利を 1 つだけ取る)。
--      前回から p_cooldown_minutes 分たっていなければ何も変えず NULL を返す。
--      Vercel Cron は、まれに同じ回を 2 回呼ぶことがある。「読む → 送る → 書く」と分けると 2 通届いてしまうため、
--      判断と書き込みを 1 つの INSERT ... ON CONFLICT DO UPDATE ... WHERE にまとめ、同時に何本来ても 1 本だけが権利を取れるようにした。
--   3. public.release_ops_alert(p_alert_key, p_claimed_at) — メールを送れなかったときに、取った権利を返す関数。
--      返すのは「p_claimed_at と同じ時刻の行」だけ (別の実行が取り直した新しい行は消さない)。
--      送れていないのに「送った」と記録したままにすると、メールの設定が直ったあとも 60 分は通知が来ないため。
--   4. public.app_log_error_counts(p_window_minutes, p_limit) — 直近 p_window_minutes 分の level='error' を function_name ごとに数える。
--      件数の多い順に p_limit 行まで返し、どの行にも全体の件数 (total_count) を付ける。返すのは関数名と件数だけで、
--      ログの本文 (message / error_message / error_stack / metadata) とユーザー ID は読み出さない。
--
-- 権限の考え方 (すべて service_role だけ):
--   - 表: RLS を有効にし、anon / authenticated には権限を付けず、念のため全拒否のポリシーも置く
--     (20261007150300_native_bridge_codes.sql と同じ形)。service_role に SELECT / INSERT / UPDATE / DELETE だけ付ける。
--   - 関数 3 本: SECURITY INVOKER (呼んだ人の権限で動く)。service_role 以外には EXECUTE を付けない。
--     万一 EXECUTE が広がっても、表の権限が無いので他のロールは読み書きできない (app_logs も RLS で本人の行しか見えない)。
--     SECURITY DEFINER にしないのは、権限の取り違えが起きたときの被害を小さくするため。
--   - Supabase は関数を作ると anon / authenticated / service_role に EXECUTE を自動で付け、PostgreSQL は PUBLIC にも付ける。
--     そのため REVOKE は FROM PUBLIC, anon, authenticated, service_role の完全形で書き、service_role にだけ GRANT し直す
--     (20261008160000_revoke_anon_execute_on_definer_functions.sql と同じ書き方。anon の EXECUTE 検査:
--      tests/integration/security/anon-definer-execute.test.ts は SECURITY DEFINER 関数だけを見るので、この 3 本は対象外)。
--   - 関数はどれも search_path = '' で、参照はすべてスキーマ付き。
--
-- 既存データへの影響: なし。既存の表・列・行・関数には触れない (新しい表と新しい関数を足すだけ)。データの更新・削除もしない。
--   app_logs は SELECT するだけ。使う索引は既存の idx_app_logs_created_at (created_at DESC) で、新しい索引は足さない
--   (15 分の窓は、直近の少数の行だけを読む)。
-- 適用順: version 順に流す。他の migration とは別の表・別の関数名なので、内容は衝突しない。
-- 冪等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS → CREATE POLICY / REVOKE・GRANT のため、
--   2 回続けて適用してもエラーにならない。
-- 確認: tests/integration/rls/ops-alert-state.test.ts
-- ロールバック: supabase/rollbacks/20261008200900_ops_alert_state.down.sql

-- ----------------------------------------------------------------
-- (1) 表: アラートごとの「最後に送った時刻」
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ops_alert_state (
  alert_key    TEXT        PRIMARY KEY,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ops_alert_state ENABLE ROW LEVEL SECURITY;

-- Supabase の default privileges は CREATE TABLE の時点で anon / authenticated / service_role にテーブル権限を自動で付ける。
-- REVOKE FROM PUBLIC だけでは外れないので、ロール個別に完全形で REVOKE してから service_role にだけ付け直す。
REVOKE ALL ON public.ops_alert_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ops_alert_state TO service_role;

-- 上の REVOKE で anon / authenticated は 42501 (権限エラー) になる。多層防御として、ポリシーでも全拒否を明示する
-- (service_role は BYPASSRLS のため影響を受けない)。
DROP POLICY IF EXISTS ops_alert_state_deny_client_access ON public.ops_alert_state;
CREATE POLICY ops_alert_state_deny_client_access ON public.ops_alert_state
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE public.ops_alert_state IS
  '#1157: 運用アラート (app_logs のエラー急増メールなど) を最後に送った時刻。同じアラートを短時間に送り直さないための記録。service_role のみ。';
COMMENT ON COLUMN public.ops_alert_state.alert_key IS
  'アラートの種類を表す固定の名前 (例: app_logs_error_spike)。ユーザー ID・メールアドレス・ログの文面は入れない';
COMMENT ON COLUMN public.ops_alert_state.last_sent_at IS
  '最後に送った時刻 (送る権利を取った時刻)。DB の時計。メールを送れなかったときは release_ops_alert で行ごと消す';

-- ----------------------------------------------------------------
-- (2) 送る権利を 1 つだけ取る (クールダウン中なら NULL)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_ops_alert(
  p_alert_key        TEXT,
  p_cooldown_minutes INTEGER DEFAULT 60
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_claimed_at TIMESTAMPTZ;
BEGIN
  IF p_alert_key IS NULL OR pg_catalog.btrim(p_alert_key) = '' THEN
    RAISE EXCEPTION 'claim_ops_alert: invalid alert_key' USING ERRCODE = '22023';
  END IF;
  -- クールダウンは 1 分〜7 日。範囲外は呼び出し側の誤りなので拒否する
  IF p_cooldown_minutes IS NULL OR p_cooldown_minutes < 1 OR p_cooldown_minutes > 10080 THEN
    RAISE EXCEPTION 'claim_ops_alert: invalid cooldown' USING ERRCODE = '22023';
  END IF;

  -- 行が無ければ INSERT して権利を取る。行があれば、前回からクールダウン分たっているときだけ UPDATE して権利を取る。
  -- たっていないときは WHERE が偽になり、何も更新せず RETURNING も空になる (v_claimed_at は NULL のまま)。
  -- 同時に来た複数の呼び出しは、衝突した行のロックで順番に処理される。先に取った 1 本が last_sent_at を今にするので、
  -- あとの呼び出しは更新後の行で WHERE を評価し直して偽になる (READ COMMITTED。PostgREST の既定)。
  INSERT INTO public.ops_alert_state AS s (alert_key, last_sent_at)
  VALUES (p_alert_key, pg_catalog.now())
  ON CONFLICT (alert_key) DO UPDATE
     SET last_sent_at = EXCLUDED.last_sent_at
   WHERE s.last_sent_at <= EXCLUDED.last_sent_at - pg_catalog.make_interval(mins => p_cooldown_minutes)
  RETURNING s.last_sent_at INTO v_claimed_at;

  RETURN v_claimed_at;
END $$;

-- ----------------------------------------------------------------
-- (3) 送れなかったときに、取った権利を返す
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_ops_alert(
  p_alert_key  TEXT,
  p_claimed_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  -- claim_ops_alert が返した時刻と同じ行だけを消す。その後に別の実行が権利を取り直していたら (時刻が違うので) 消さない。
  -- 行を消しても、次の claim_ops_alert が新しく INSERT するだけで、クールダウンの判断は変わらない
  -- (権利を取れたということは、前の送信はクールダウンより前だったので、前の時刻はもう要らない)。
  DELETE FROM public.ops_alert_state s
   WHERE s.alert_key = p_alert_key
     AND s.last_sent_at = p_claimed_at;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END $$;

-- ----------------------------------------------------------------
-- (4) 直近の error を function_name ごとに数える (関数名と件数だけ。本文・ユーザー ID は読まない)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_log_error_counts(
  p_window_minutes INTEGER DEFAULT 15,
  p_limit          INTEGER DEFAULT 10
) RETURNS TABLE (
  function_name TEXT,
  error_count   BIGINT,
  total_count   BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  -- 窓は 1 分〜1 日、返す行数は 1〜100。範囲外は呼び出し側の誤りなので拒否する
  IF p_window_minutes IS NULL OR p_window_minutes < 1 OR p_window_minutes > 1440 THEN
    RAISE EXCEPTION 'app_log_error_counts: invalid window' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'app_log_error_counts: invalid limit' USING ERRCODE = '22023';
  END IF;

  -- total_count は LIMIT の前に全グループを合計した値 (ウィンドウ関数は LIMIT より先に評価される)。
  -- 返す行が上位 p_limit 件でも、全体の件数が分かる。function_name が NULL のログ (クライアントのログなど) は NULL の 1 グループ。
  RETURN QUERY
  SELECT g.function_name,
         g.error_count,
         (pg_catalog.sum(g.error_count) OVER ())::BIGINT AS total_count
    FROM (
      SELECT l.function_name,
             pg_catalog.count(*)::BIGINT AS error_count
        FROM public.app_logs l
       WHERE l.level = 'error'
         AND l.created_at >= pg_catalog.now() - pg_catalog.make_interval(mins => p_window_minutes)
       GROUP BY l.function_name
    ) g
   ORDER BY g.error_count DESC, g.function_name ASC
   LIMIT p_limit;
END $$;

-- ----------------------------------------------------------------
-- 関数の権限: service_role だけ (完全形で REVOKE してから GRANT し直す)
-- ----------------------------------------------------------------
REVOKE ALL ON FUNCTION public.claim_ops_alert(TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_ops_alert(TEXT, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.release_ops_alert(TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_ops_alert(TEXT, TIMESTAMPTZ)
  TO service_role;

REVOKE ALL ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.claim_ops_alert(TEXT, INTEGER) IS
  '#1157: アラートを送る権利を 1 つだけ取る。前回から p_cooldown_minutes 分たっていれば last_sent_at を今にしてその時刻を返し、たっていなければ NULL を返す (同時に来ても 1 本だけが取れる)。service_role のみ。';
COMMENT ON FUNCTION public.release_ops_alert(TEXT, TIMESTAMPTZ) IS
  '#1157: メールを送れなかったときに、claim_ops_alert で取った権利を返す (p_claimed_at と同じ時刻の行だけを消す)。消したら true。service_role のみ。';
COMMENT ON FUNCTION public.app_log_error_counts(INTEGER, INTEGER) IS
  '#1157: 直近 p_window_minutes 分の app_logs.level=error を function_name ごとに数え、多い順に p_limit 行まで返す (全体の件数 total_count 付き)。関数名と件数だけを返し、ログの本文・ユーザー ID は読まない。service_role のみ。';
