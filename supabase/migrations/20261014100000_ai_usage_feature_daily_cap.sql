-- migration: 20261014100000_ai_usage_feature_daily_cap.sql
-- #1142: 究極モードを 1 人 1 日 1 回 (JST の暦日) までにする。機能ごとの 1 日の上限を、1 日の AI の上限 (#1149) の判定と同じ呼び出しで原子的に判定する
--
-- 背景:
--   究極モード (献立の生成で、AI が作った献立をもう一度見直す。AI を通常の倍の 6 段階呼ぶ) を全員に開放する。
--   そのかわり、1 日の AI の上限 (ai_daily_limits。既定は free = 10 回) とは別に、究極モードだけ 1 人 1 日 1 回までにする。
--   究極モードの 1 回は、1 日の AI の上限にも今どおり 1 回と数える (両方に数える)。
--
-- なぜ既存の関数だけでは表せないか (この migration が要る理由):
--   - consume_ai_usage は「上限に数える機能の合計」だけを上限と比べる。機能ごとの上限を持てるのは、上限に数えない機能
--     (c_unmetered。ai_unmetered_daily_caps の安全弁) だけで、上限に数える機能に機能ごとの上限は無い。
--   - API ルートの側で「先に ai_usage_counters を読んで 1 回以上なら止める → consume_ai_usage で数える」とすると、
--     読んでから数えるまでの間に同じ利用者の 2 本目が入れる (同時に 2 回押すと、究極モードが 2 回通る)。
--     consume_ai_usage と同じ鍵のロック (同じ利用者・同じ日) の中で、機能ごとの回数の判定と、合計の判定・記録を続けて行う必要がある。
--   新しい表は作らない。機能ごとの上限の値は呼び出し側 (Next.js / Edge Function) が引数で渡す
--   (値の正は supabase/functions/_shared/ai-usage-core.ts の AI_ULTIMATE_MODE_DAILY_LIMIT_DEFAULT = 1。
--    環境変数 AI_ULTIMATE_MODE_DAILY_LIMIT で上書きできる)。
--
-- 追加するもの (関数 2 つだけ。既存のテーブル・関数・データは変えない):
--   1. public.consume_ai_usage_capped_at(p_user_id, p_feature, p_feature_daily_cap, p_at) -> jsonb
--        consume_ai_usage_at と同じ鍵のロックを取り、その日 (JST の暦日) のその機能の回数が p_feature_daily_cap に達していれば、
--        記録せずに {allowed: false, metered: true, limit: p_feature_daily_cap, used: その機能の回数, usage_date, capped_feature: p_feature} を返す。
--        達していなければ consume_ai_usage_at に渡す (1 日の上限の判定と記録。結果はそのまま返す)。
--        機能ごとの上限に達していなくても、1 日の上限に達していれば consume_ai_usage_at が止める (そのときは capped_feature を付けない)。
--        API からは呼べない (時刻を引数で受けるのはテストのため。consume_ai_usage_capped を使う)。
--   2. public.consume_ai_usage_capped(p_user_id, p_feature, p_feature_daily_cap) -> jsonb
--        consume_ai_usage_capped_at に now() を渡すだけ。service_role のみ
--
-- 数え方:
--   究極モードは機能名 'menu_generation_ultimate' (上限に数える機能。c_unmetered に無い) で数える。
--   1 回の究極モードは ai_usage_counters の 'menu_generation_ultimate' の行に 1 回だけ入り、
--   - 1 日の上限の合計 (上限に数える機能の合計) に 1 回入る
--   - 機能ごとの上限 (その機能の行の回数) に 1 回入る
--   数え戻し (refund_ai_usage) は、同じ機能名で 1 回戻せば両方から戻る (同じ 1 行なので)。
--
-- 同時実行:
--   consume_ai_usage_at と同じ鍵 (ai_usage:<利用者>:<JST の日>) の pg_advisory_xact_lock を先に取る。
--   consume_ai_usage_at の中でもう一度同じ鍵を取るが、同じセッションが持つ advisory lock は重ねて取れる (待たない)。
--   ロックはトランザクションの終わりまで外れないので、機能ごとの回数の読み取りから記録までの間に、同じ利用者・同じ日の
--   ほかの呼び出し (consume_ai_usage を含む) は入れない。同時に何本来ても、機能ごとの上限も合計の上限も超えて許可しない。
--
-- 失敗したときの扱い (呼び出し側: src/lib/plan/entitlements.ts / supabase/functions/_shared/ai-usage.ts):
--   この関数が失敗したとき (DB エラー・未適用・応答が遅い) は、呼び出し側はログに残して許可する (#1149 と同じく止めない)。
--   Web / Edge Function を先にデプロイすると、この migration が未適用の間は、究極モードを数えずに許可する (ログに「関数が無い」が残る)。
--   main へのマージで migration と Web のデプロイが続けて走るので、その間だけ。
--
-- 権限:
--   - consume_ai_usage_capped は service_role だけが実行できる (SECURITY DEFINER + search_path = '')。
--     anon / authenticated が呼べると、他人の回数を増やせてしまう。
--   - consume_ai_usage_capped_at はどのロールにも EXECUTE を付けない (所有者と consume_ai_usage_capped からだけ呼べる)。
--
-- 既存データへの影響: なし (関数を足すだけ。データの更新・削除・追加はしない)。
-- 適用順: 20261011030000_ai_usage_unmetered_caps_and_grants.sql (consume_ai_usage_at の最後の定義) のあと。
-- 冪等: CREATE OR REPLACE FUNCTION、REVOKE / GRANT / COMMENT。2 回続けて適用してもエラーにならず、結果も変わらない。
-- 確認: tests/integration/rls/ai-usage-feature-cap-rpc.test.ts
-- ロールバック: supabase/rollbacks/20261014100000_ai_usage_feature_daily_cap.down.sql

-- ----------------------------------------------------------------
-- (1) consume_ai_usage_capped_at: 機能ごとの上限の判定 → 1 日の上限の判定と記録 (本体。時刻を引数で受け取る。API からは呼べない)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_ai_usage_capped_at(
  p_user_id           UUID,
  p_feature           TEXT,
  p_feature_daily_cap INTEGER,
  p_at                TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_date DATE;
  v_used INTEGER;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'consume_ai_usage_capped: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_feature IS NULL OR p_feature !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'consume_ai_usage_capped: p_feature must be snake_case (up to 64 chars)' USING ERRCODE = '22023';
  END IF;
  IF p_feature_daily_cap IS NULL OR p_feature_daily_cap < 0 THEN
    RAISE EXCEPTION 'consume_ai_usage_capped: p_feature_daily_cap must be 0 or more' USING ERRCODE = '22023';
  END IF;
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'consume_ai_usage_capped: p_at is required' USING ERRCODE = '22023';
  END IF;

  -- 日付は JST の暦日 (consume_ai_usage_at と同じ)
  v_date := (p_at AT TIME ZONE 'Asia/Tokyo')::DATE;

  -- consume_ai_usage_at と同じ鍵で、同じ利用者・同じ日の判定を 1 本ずつにする (トランザクションの終わりで外れる)。
  -- consume_ai_usage_at の中でもう一度取るが、同じセッションは重ねて取れる
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ai_usage:' || p_user_id::TEXT || ':' || v_date::TEXT, 0)
  );

  -- その日の、その機能だけの回数 (ロックを取ったあとなので、前の呼び出しの確定した結果まで読む)
  SELECT COALESCE(SUM(c.count), 0)::INTEGER
    INTO v_used
    FROM public.ai_usage_counters AS c
   WHERE c.user_id = p_user_id
     AND c.usage_date = v_date
     AND c.feature = p_feature;

  IF v_used >= p_feature_daily_cap THEN
    -- 機能ごとの上限に達している: 記録せずに止める (1 日の上限の回数は減らさない)
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'metered', true, 'plan', NULL, 'limit', p_feature_daily_cap, 'used', v_used,
      'usage_date', v_date, 'capped_feature', p_feature
    );
  END IF;

  -- 1 日の上限の判定と記録 (上限に数える機能の合計。達していれば記録せずに止める)
  RETURN public.consume_ai_usage_at(p_user_id, p_feature, p_at);
END
$$;

-- どのロールにも EXECUTE を付けない (所有者と、同じ所有者の consume_ai_usage_capped からだけ呼べる)
REVOKE ALL ON FUNCTION public.consume_ai_usage_capped_at(UUID, TEXT, INTEGER, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.consume_ai_usage_capped_at(UUID, TEXT, INTEGER, TIMESTAMPTZ) IS
  '#1142: consume_ai_usage_capped の本体。利用した時刻 (p_at) を引数で受け取る (JST の日付の変わり目をテストで確かめるため)。API (PostgREST) からは呼べない。consume_ai_usage_capped を使うこと。';

-- ----------------------------------------------------------------
-- (2) consume_ai_usage_capped: 機能ごとの上限がある機能 (究極モード) を、AI へ送る直前に数える (service_role のみ)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_ai_usage_capped(
  p_user_id           UUID,
  p_feature           TEXT,
  p_feature_daily_cap INTEGER
) RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.consume_ai_usage_capped_at(p_user_id, p_feature, p_feature_daily_cap, pg_catalog.now());
$$;

REVOKE ALL ON FUNCTION public.consume_ai_usage_capped(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_usage_capped(UUID, TEXT, INTEGER) TO service_role;

COMMENT ON FUNCTION public.consume_ai_usage_capped(UUID, TEXT, INTEGER) IS
  '#1142: 機能ごとの 1 日の上限がある機能 (究極モード = menu_generation_ultimate) を、AI へ送る直前に数える。その日 (JST) のその機能の回数が p_feature_daily_cap に達していれば記録せずに {allowed:false, capped_feature}、達していなければ consume_ai_usage と同じ判定と記録 (1 日の上限)。service_role のみ。';
