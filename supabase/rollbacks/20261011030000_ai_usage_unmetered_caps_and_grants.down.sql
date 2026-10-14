-- rollback: 20261011030000_ai_usage_unmetered_caps_and_grants.sql
-- #1149 の是正 (上限に数えない AI の安全弁・写真の判別の数え済みの印) を消し、consume_ai_usage_at を 20261011020000 の定義に戻す。
-- 戻すのは、この migration が足したテーブル 2 つ・関数 1 本と、差し替えた consume_ai_usage_at だけ。
-- ai_usage_counters・ai_daily_limits・consume_ai_usage・refund_ai_usage には触れない。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 上限に数えない機能 (nutrition_advice_auto) の安全弁が無くなり、記録だけして必ず許可する前の動きに戻る。
--   - meal_image_auto は c_unmetered から外れるので、上限に数える機能として扱われる (料理画像が 1 日 10 回に入る)。
--     先に Web のデプロイを戻す (料理画像を image_generation で数える版に戻す) と、機能名が揃う。
--   - claim_ai_usage_grant が無くなると、Web (src/lib/plan/entitlements.ts の redeemAiUsageGrant) は「関数が無い」エラーをログに残して
--     印を使わずに数える (写真の「オート」が 2 回に数えられる前の動きに戻るだけで、AI の利用は止まらない)。
--   - ai_unmetered_daily_caps を消すと、運用で変えた安全弁の値が失われる。残したいなら、先に中身を書き出す
--     (service_role で SELECT * FROM public.ai_unmetered_daily_caps)。
--   - ai_usage_counters に記録済みの meal_image_auto の行は消さない (計測の記録として残す)。
--
-- 何度流しても同じ結果になる (冪等)。

DROP FUNCTION IF EXISTS public.claim_ai_usage_grant(UUID, UUID);
DROP TABLE IF EXISTS public.ai_usage_grant_claims;

-- consume_ai_usage_at を 20261011020000_ai_daily_limits.sql の定義に戻す (上限に数えない機能は記録だけして許可する)
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

DROP TABLE IF EXISTS public.ai_unmetered_daily_caps;
