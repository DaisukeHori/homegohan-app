-- migration: 20261011020000_ai_daily_limits.sql
-- #1149 (T40): AI の 1 日の利用回数に上限を入れる (上限の値を DB に置き、判定と記録を 1 回の呼び出しで原子的に行う)
--
-- 背景:
--   #1177 (20261010140000_ai_usage_foundation.sql) で、AI の利用回数を ai_usage_counters に記録する仕組み (record_ai_usage) が入った。
--   記録だけで、上限と比べて止める処理は無かった。運営画面の LLM の quotas は、コードに書いた目安を表示するだけで保存できなかった (#1149)。
--   上限は「1 日 10 回 (究極モードも 1 回)」、課金は「無料のまま計測」(いまは全員が free プラン) で入れる。
--
-- 追加するもの (テーブル 1 つ + 関数 3 つ + 既定の値 1 行。既存のテーブル・関数・データは変えない):
--   1. public.ai_daily_limits(plan_key PK, daily_limit, updated_at, updated_by)
--        プランごとの 1 日の上限 (全機能の合計の回数)。daily_limit が NULL のプランは無制限。
--        そのプランの行が無いときは、'free' の行の値を使う ('free' の行も無ければ無制限)。
--        既定は 'free' = 10 の 1 行だけ (ほかのプランも 'free' の値 = 10 回になる)。値は運営画面
--        (/super-admin/llm/quotas → PATCH /api/super-admin/llm/quotas) から service_role で保存する。
--   2. public.consume_ai_usage_at(p_user_id, p_feature, p_at) -> jsonb
--        上限の判定と記録を 1 回で行う。その日 (JST の暦日) の回数 (上限に数える機能の合計) が上限に達していれば、
--        記録せずに {allowed: false, limit, used, ...} を返す。達していなければ 1 を足して {allowed: true, ...} を返す。
--        API からは呼べない (時刻を引数で受けるのはテストのため。consume_ai_usage を使う)。
--   3. public.consume_ai_usage(p_user_id, p_feature) -> jsonb    consume_ai_usage_at に now() を渡すだけ。service_role のみ
--   4. public.refund_ai_usage(p_user_id, p_feature, p_usage_date) -> boolean
--        数えた 1 回を戻す (数え戻し)。記録したあと、AI へ送る前に DB の処理が失敗して何も送らなかったときだけ、呼び出し側が使う
--        (例: 生成のリクエストの行の insert の失敗)。0 より下にはしない。service_role のみ
--
-- 上限に数えない機能 (c_unmetered):
--   'nutrition_advice_auto' — 画面を開くと自動で呼ばれる AI (ホームの栄養のアドバイス・栄養の詳細を開いたときの栄養士のコメント)。
--   利用者が押した操作ではないので、上限に数えず (回数を減らさず)、上限に達していても止めない。記録は残す (計測のため)。
--   一覧は supabase/functions/_shared/ai-usage-core.ts の AI_UNMETERED_FEATURES と同じ (tests/ai-usage-contract.test.ts が突き合わせる)。
--
-- 同時実行:
--   同じ利用者・同じ日の判定を pg_advisory_xact_lock で 1 本ずつにする (トランザクションの終わりで外れる)。
--   ロックを取ったあとの SELECT は、前にロックを持っていた呼び出しの確定した結果を読む (READ COMMITTED で文ごとに新しいスナップショット)。
--   そのため、同時に何本来ても、上限を超えて許可しない。ロックの鍵は (利用者, 日) の文字列のハッシュで、ほかの利用者と鍵が重なっても
--   順番に待つだけで、結果は変わらない。
--
-- 失敗したときの扱い (呼び出し側: src/lib/plan/entitlements.ts / supabase/functions/_shared/ai-usage.ts):
--   この関数が失敗したとき (DB エラー・未適用・応答が遅い) は、呼び出し側はログに残して許可する (#1177 と同じく止めない)。
--
-- 権限:
--   - テーブルは RLS を有効にし、ポリシーは作らない。anon / authenticated / service_role から完全形で REVOKE し、
--     service_role にだけ SELECT / INSERT / UPDATE / DELETE を返す (運営画面の API が service_role で読み書きする)。
--   - consume_ai_usage / refund_ai_usage は service_role だけが実行できる (SECURITY DEFINER + search_path = '')。
--     anon / authenticated が呼べると、他人の回数を増やしたり戻したりできてしまう。
--   - consume_ai_usage_at はどのロールにも EXECUTE を付けない (所有者と consume_ai_usage からだけ呼べる)。
--
-- 既存データへの影響: なし (新しいテーブルに既定の 1 行を入れるだけ。ai_usage_counters は読むだけで、行は足し引きしかしない)。
-- 適用順: 20261010140000_ai_usage_foundation.sql (ai_usage_counters・get_effective_plan・record_ai_usage_at) のあと。
--   Web / Edge Function を先にデプロイしても、この migration が未適用の間は「関数が無い」エラーをログに残して許可するだけで、
--   AI の利用は止まらない (上限が効かないだけ)。
-- 冪等: CREATE TABLE IF NOT EXISTS、INSERT ... ON CONFLICT DO NOTHING、CREATE OR REPLACE FUNCTION、REVOKE / GRANT / COMMENT。
--   2 回続けて適用してもエラーにならず、結果も変わらない (運営画面で変えた値は上書きしない)。
-- 確認: tests/integration/rls/ai-daily-limit-rpc.test.ts
-- ロールバック: supabase/rollbacks/20261011020000_ai_daily_limits.down.sql

-- ----------------------------------------------------------------
-- (1) ai_daily_limits: プランごとの 1 日の上限
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_daily_limits (
  plan_key    TEXT        PRIMARY KEY,
  daily_limit INTEGER     NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID        NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT ai_daily_limits_plan_key_not_blank CHECK (btrim(plan_key) <> ''),
  CONSTRAINT ai_daily_limits_daily_limit_nonneg CHECK (daily_limit IS NULL OR daily_limit >= 0)
);

COMMENT ON TABLE public.ai_daily_limits IS
  '#1149: プランごとの AI の 1 日の上限 (全機能の合計の回数。JST の暦日)。行の無いプランは ''free'' の行の値を使う。service_role だけが読み書きする (運営画面の API)。';
COMMENT ON COLUMN public.ai_daily_limits.daily_limit IS '1 日の上限の回数。NULL は無制限。0 はその日は 1 回も使えない。';
COMMENT ON COLUMN public.ai_daily_limits.updated_by IS '最後に値を保存した運営者 (auth.users)。migration の既定の行は NULL。';

ALTER TABLE public.ai_daily_limits ENABLE ROW LEVEL SECURITY;

-- Supabase の default privileges は CREATE TABLE 時点で anon / authenticated / service_role に権限を自動付与するので、
-- ロールを個別に完全形で REVOKE してから service_role にだけ返す (20261010140000_ai_usage_foundation.sql と同じ理屈)
REVOKE ALL ON public.ai_daily_limits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_daily_limits TO service_role;

-- 既定の値: free = 1 日 10 回 (オーナーの選択。究極モードも 1 回と数える)。
-- 既に行がある (運営画面で値を変えた) ときは上書きしない
INSERT INTO public.ai_daily_limits (plan_key, daily_limit)
VALUES ('free', 10)
ON CONFLICT (plan_key) DO NOTHING;

-- ----------------------------------------------------------------
-- (2) consume_ai_usage_at: 上限の判定と記録 (本体。時刻を引数で受け取る。API からは呼べない)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_ai_usage_at(
  p_user_id UUID,
  p_feature TEXT,
  p_at      TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 上限に数えない機能 (画面を開くと自動で呼ばれる AI)。supabase/functions/_shared/ai-usage-core.ts の AI_UNMETERED_FEATURES と同じ
  c_unmetered    CONSTANT TEXT[] := ARRAY['nutrition_advice_auto'];
  -- 行の無いプランが使う既定のプラン
  c_default_plan CONSTANT TEXT   := 'free';
  v_date  DATE;
  v_plan  TEXT;
  v_limit INTEGER;
  v_used  INTEGER;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'consume_ai_usage: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_feature IS NULL OR p_feature !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'consume_ai_usage: p_feature must be snake_case (up to 64 chars)' USING ERRCODE = '22023';
  END IF;
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'consume_ai_usage: p_at is required' USING ERRCODE = '22023';
  END IF;

  -- 日付は JST の暦日 (record_ai_usage_at と同じ)
  v_date := (p_at AT TIME ZONE 'Asia/Tokyo')::DATE;

  -- 上限に数えない機能は、記録だけして許可する (止めない)
  IF p_feature = ANY (c_unmetered) THEN
    PERFORM public.record_ai_usage_at(p_user_id, p_feature, p_at);
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true, 'metered', false, 'plan', NULL, 'limit', NULL, 'used', NULL, 'usage_date', v_date
    );
  END IF;

  -- 同じ利用者・同じ日の判定を 1 本ずつにする (トランザクションの終わりで外れる)
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ai_usage:' || p_user_id::TEXT || ':' || v_date::TEXT, 0)
  );

  v_plan := public.get_effective_plan(p_user_id);

  -- そのプランの行。無ければ 'free' の行 (それも無ければ NULL = 無制限)
  SELECT l.daily_limit INTO v_limit FROM public.ai_daily_limits AS l WHERE l.plan_key = v_plan;
  IF NOT FOUND THEN
    SELECT l.daily_limit INTO v_limit FROM public.ai_daily_limits AS l WHERE l.plan_key = c_default_plan;
  END IF;

  -- その日の回数 (上限に数える機能の合計)。ロックを取ったあとなので、前の呼び出しの確定した結果まで読む
  SELECT COALESCE(SUM(c.count), 0)::INTEGER
    INTO v_used
    FROM public.ai_usage_counters AS c
   WHERE c.user_id = p_user_id
     AND c.usage_date = v_date
     AND NOT (c.feature = ANY (c_unmetered));

  IF v_limit IS NOT NULL AND v_used >= v_limit THEN
    -- 上限に達している: 記録せずに止める
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'metered', true, 'plan', v_plan, 'limit', v_limit, 'used', v_used, 'usage_date', v_date
    );
  END IF;

  INSERT INTO public.ai_usage_counters AS c (user_id, usage_date, feature, count)
  VALUES (p_user_id, v_date, p_feature, 1)
  ON CONFLICT (user_id, usage_date, feature)
  DO UPDATE SET count = c.count + 1, updated_at = pg_catalog.now();

  RETURN pg_catalog.jsonb_build_object(
    'allowed', true, 'metered', true, 'plan', v_plan, 'limit', v_limit, 'used', v_used + 1, 'usage_date', v_date
  );
END
$$;

-- どのロールにも EXECUTE を付けない (所有者と、同じ所有者の consume_ai_usage からだけ呼べる)
REVOKE ALL ON FUNCTION public.consume_ai_usage_at(UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.consume_ai_usage_at(UUID, TEXT, TIMESTAMPTZ) IS
  '#1149: consume_ai_usage の本体。利用した時刻 (p_at) を引数で受け取る (JST の日付の変わり目をテストで確かめるため)。API (PostgREST) からは呼べない。consume_ai_usage を使うこと。';

-- ----------------------------------------------------------------
-- (3) consume_ai_usage: AI へ送る直前に呼ぶ (service_role のみ)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_ai_usage(
  p_user_id UUID,
  p_feature TEXT
) RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.consume_ai_usage_at(p_user_id, p_feature, pg_catalog.now());
$$;

REVOKE ALL ON FUNCTION public.consume_ai_usage(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_usage(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.consume_ai_usage(UUID, TEXT) IS
  '#1149: AI へ送る直前に呼ぶ。その日 (JST) の回数が上限 (ai_daily_limits) に達していれば記録せずに {allowed:false}、達していなければ +1 して {allowed:true}。同じ利用者・同じ日は 1 本ずつ判定する。service_role のみ。';

-- ----------------------------------------------------------------
-- (4) refund_ai_usage: 数えた 1 回を戻す (service_role のみ)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_ai_usage(
  p_user_id    UUID,
  p_feature    TEXT,
  p_usage_date DATE
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL OR p_feature IS NULL OR p_usage_date IS NULL THEN
    RAISE EXCEPTION 'refund_ai_usage: p_user_id, p_feature and p_usage_date are required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.ai_usage_counters AS c
     SET count = c.count - 1, updated_at = pg_catalog.now()
   WHERE c.user_id = p_user_id
     AND c.usage_date = p_usage_date
     AND c.feature = p_feature
     AND c.count > 0;
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION public.refund_ai_usage(UUID, TEXT, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_ai_usage(UUID, TEXT, DATE) TO service_role;

COMMENT ON FUNCTION public.refund_ai_usage(UUID, TEXT, DATE) IS
  '#1149: consume_ai_usage で数えた 1 回を戻す。数えたあと、AI へ送る前に DB の処理が失敗して何も送らなかったときだけ呼ぶ。0 より下にはしない。行を減らせたら true。service_role のみ。';
