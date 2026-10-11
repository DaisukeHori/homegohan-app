-- migration: 20261011030000_ai_usage_unmetered_caps_and_grants.sql
-- #1149 (T40) の是正: 上限に数えない AI に安全弁を付け、写真の「オート」の判別 → 解析を 1 回に数える
--
-- 背景 (デプロイ後の整合ゲートの指摘):
--   1. 上限に数えない機能 (c_unmetered = nutrition_advice_auto) は、consume_ai_usage_at が記録だけして必ず許可していた。
--      どの機能名で数えるかは API ルートが決めるが、その判定の材料 (forceRefresh が偽・includeAdvice など) はクライアントが送る値なので、
--      API を直接呼べば 1 日の上限 (10 回) と無関係に何度でも AI を呼べた。
--   2. 写真の「オート」は、1 回押すと判別 (classify-photo) と続く解析 (analyze-*) の両方で 1 回ずつ数え、1 回の操作が 2 回になっていた。
--   あわせて、手動で料理を保存・更新したときの料理画像の生成 (副作用) を、明示の 10 回に数えない機能 (meal_image_auto) に移す。
--
-- 追加・変更するもの (既存のテーブルの列・データは変えない):
--   1. public.ai_unmetered_daily_caps(feature PK, daily_cap, updated_at)
--        上限に数えない機能の、利用者ごと・1 日 (JST の暦日) の安全弁の回数。機能ごとに 1 行。
--        既定は nutrition_advice_auto = 30 (画面を開くたびの自動のアドバイス)、meal_image_auto = 20 (保存のたびの料理画像)。
--        どちらもふつうの使い方では当たらず、API を直接呼び続けたときだけ止まる値。
--        値は supabase/functions/_shared/ai-usage-core.ts の AI_UNMETERED_DAILY_CAP_DEFAULTS と同じ (tests/ai-usage-contract.test.ts が突き合わせる)。
--        運用で変えるときは、この表の行を service_role で更新する (次の判定から効く)。行が無い機能は c_unmetered_fallback_cap (20)。
--   2. public.consume_ai_usage_at を CREATE OR REPLACE で差し替える (引数・戻り値の形・権限は同じ)。
--        上限に数えない機能も、同じ利用者・同じ日を 1 本ずつ判定し、その機能のその日の回数が安全弁に達していれば記録せずに
--        {allowed: false, metered: false, limit: 安全弁, used} を返す (呼び出し側は今の止め方で止める: AI の部分だけ省く・429・画像だけ見送る)。
--        安全弁は機能ごとに数え、明示の 10 回 (上限に数える機能の合計) とは別に数える (どちらの回数も、もう片方に入らない)。
--        c_unmetered に meal_image_auto を足す。
--   3. public.ai_usage_grant_claims(grant_id PK, user_id, claimed_at)
--        写真の判別 (classify-photo) が数えたあとに返す「数え済みの印」(HMAC の署名つき。_shared/ai-usage-core.ts の signAiUsageGrant) の、
--        使用済みの記録。印は 1 回だけ使える (同じ印を何度送っても、数えずに済むのは最初の 1 回だけ)。
--   4. public.claim_ai_usage_grant(p_user_id, p_grant_id) -> boolean
--        印の ID を使用済みにする。はじめて使用済みにできたら true、使用済みなら false。service_role のみ。
--        印の署名・期限・利用者の確認は呼び出し側 (src/lib/plan/entitlements.ts の redeemAiUsageGrant) が先に行う。
--        古い記録 (c_claim_retention = 1 日より前。印は 10 分で期限が切れるので、それより古い記録は二度と照合されない) は、
--        同じ利用者の呼び出しのついでに消す。
--
-- 権限:
--   - 2 つのテーブルは RLS を有効にし、ポリシーは作らない。anon / authenticated / service_role から完全形で REVOKE し、
--     service_role にだけ必要な権限を返す (20261011020000_ai_daily_limits.sql と同じ理屈)。
--   - consume_ai_usage_at はどのロールにも EXECUTE を付けない (前の定義と同じ。CREATE OR REPLACE は権限を保つが、念のため付け直す)。
--   - claim_ai_usage_grant は service_role だけが実行できる (SECURITY DEFINER + search_path = '')。
--     anon / authenticated が呼べると、他人の印を先に使用済みにできてしまう。
--
-- 既存データへの影響: なし (新しいテーブルに既定の 2 行を入れるだけ。ai_usage_counters は読むだけで、行は足し引きしかしない)。
-- 適用順: 20261011020000_ai_daily_limits.sql (ai_daily_limits・consume_ai_usage_at・consume_ai_usage・refund_ai_usage) のあと。
--   Web を先にデプロイしても、この migration が未適用の間は:
--     - meal_image_auto は c_unmetered に無いので、前の定義では上限に数える機能として扱われる (今と同じく 10 回に入るだけ。止まらない)
--     - claim_ai_usage_grant が無いので印は使えず、解析は数える (今と同じく 2 回に数えるだけ。止まらない)
-- 冪等: CREATE TABLE IF NOT EXISTS、CREATE INDEX IF NOT EXISTS、INSERT ... ON CONFLICT DO NOTHING、CREATE OR REPLACE FUNCTION、
--   REVOKE / GRANT / COMMENT。2 回続けて適用してもエラーにならず、結果も変わらない (運用で変えた安全弁の値は上書きしない)。
-- 確認: tests/integration/rls/ai-daily-limit-rpc.test.ts (J〜L)
-- ロールバック: supabase/rollbacks/20261011030000_ai_usage_unmetered_caps_and_grants.down.sql

-- ----------------------------------------------------------------
-- (1) ai_unmetered_daily_caps: 上限に数えない機能の安全弁
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_unmetered_daily_caps (
  feature    TEXT        PRIMARY KEY,
  daily_cap  INTEGER     NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_unmetered_daily_caps_feature_format CHECK (feature ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT ai_unmetered_daily_caps_daily_cap_nonneg CHECK (daily_cap >= 0)
);

COMMENT ON TABLE public.ai_unmetered_daily_caps IS
  '#1149: 上限に数えない AI の機能 (画面を開く・保存するだけで呼ばれる AI) の、利用者ごと・1 日 (JST) の安全弁の回数。機能ごとに数え、明示の 1 日の上限 (ai_daily_limits) とは別。行の無い機能は consume_ai_usage_at の c_unmetered_fallback_cap。service_role だけが読み書きする。';
COMMENT ON COLUMN public.ai_unmetered_daily_caps.daily_cap IS '1 日の安全弁の回数。0 はその日は 1 回も使えない (無制限は無い)。';

ALTER TABLE public.ai_unmetered_daily_caps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_unmetered_daily_caps FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_unmetered_daily_caps TO service_role;

-- 既定の値 (_shared/ai-usage-core.ts の AI_UNMETERED_DAILY_CAP_DEFAULTS と同じ)。既に行がある (運用で値を変えた) ときは上書きしない
--   nutrition_advice_auto = 30: ホーム・栄養の詳細を開くたびに 1 回。1 日に数回〜十数回開いても当たらない
--   meal_image_auto       = 20: 料理を保存・更新するたびに 1 回。1 日 3 食 + 間食を何度か直しても当たらない
INSERT INTO public.ai_unmetered_daily_caps (feature, daily_cap)
VALUES ('nutrition_advice_auto', 30), ('meal_image_auto', 20)
ON CONFLICT (feature) DO NOTHING;

-- ----------------------------------------------------------------
-- (2) consume_ai_usage_at: 上限に数えない機能にも安全弁を付ける (差し替え)
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
  -- 上限に数えない機能 (画面を開く・保存するだけで呼ばれる AI)。supabase/functions/_shared/ai-usage-core.ts の AI_UNMETERED_FEATURES と同じ
  c_unmetered    CONSTANT TEXT[] := ARRAY['nutrition_advice_auto', 'meal_image_auto'];
  -- 行の無いプランが使う既定のプラン
  c_default_plan CONSTANT TEXT   := 'free';
  -- ai_unmetered_daily_caps に行が無い機能の安全弁 (_shared/ai-usage-core.ts の AI_UNMETERED_DAILY_CAP_FALLBACK と同じ。
  -- 既定の値のうち小さいほう。行が消されても無制限にしない)
  c_unmetered_fallback_cap CONSTANT INTEGER := 20;
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

  -- 同じ利用者・同じ日の判定を 1 本ずつにする (トランザクションの終わりで外れる)。上限に数えない機能も同じ鍵で待つ
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ai_usage:' || p_user_id::TEXT || ':' || v_date::TEXT, 0)
  );

  -- 上限に数えない機能: 明示の上限 (ai_daily_limits) には数えず、その機能だけの安全弁 (ai_unmetered_daily_caps) で止める
  IF p_feature = ANY (c_unmetered) THEN
    SELECT cap.daily_cap INTO v_limit FROM public.ai_unmetered_daily_caps AS cap WHERE cap.feature = p_feature;
    IF NOT FOUND THEN
      v_limit := c_unmetered_fallback_cap;
    END IF;

    -- その日の、その機能だけの回数 (ロックを取ったあとなので、前の呼び出しの確定した結果まで読む)
    SELECT COALESCE(SUM(c.count), 0)::INTEGER
      INTO v_used
      FROM public.ai_usage_counters AS c
     WHERE c.user_id = p_user_id
       AND c.usage_date = v_date
       AND c.feature = p_feature;

    IF v_used >= v_limit THEN
      -- 安全弁に達している: 記録せずに止める
      RETURN pg_catalog.jsonb_build_object(
        'allowed', false, 'metered', false, 'plan', NULL, 'limit', v_limit, 'used', v_used, 'usage_date', v_date
      );
    END IF;

    PERFORM public.record_ai_usage_at(p_user_id, p_feature, p_at);
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true, 'metered', false, 'plan', NULL, 'limit', NULL, 'used', NULL, 'usage_date', v_date
    );
  END IF;

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
  '#1149: consume_ai_usage の本体。利用した時刻 (p_at) を引数で受け取る (JST の日付の変わり目をテストで確かめるため)。上限に数えない機能は ai_unmetered_daily_caps の安全弁で止める。API (PostgREST) からは呼べない。consume_ai_usage を使うこと。';

-- ----------------------------------------------------------------
-- (3) ai_usage_grant_claims: 数え済みの印の使用済みの記録
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_usage_grant_claims (
  grant_id   UUID        PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_grant_claims_user_claimed_at_idx
  ON public.ai_usage_grant_claims (user_id, claimed_at);

COMMENT ON TABLE public.ai_usage_grant_claims IS
  '#1149: 写真の判別が数えたあとに返す「数え済みの印」の使用済みの記録 (印は 1 回だけ使える)。claim_ai_usage_grant だけが書く。service_role だけが読み書きする。';

ALTER TABLE public.ai_usage_grant_claims ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ai_usage_grant_claims FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.ai_usage_grant_claims TO service_role;

-- ----------------------------------------------------------------
-- (4) claim_ai_usage_grant: 印の ID を使用済みにする (service_role のみ)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_ai_usage_grant(
  p_user_id  UUID,
  p_grant_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 使用済みの記録を残す長さ。印の有効期限 (_shared/ai-usage-core.ts の AI_USAGE_GRANT_MAX_AGE_SEC = 10 分) より十分長くする
  -- (期限の切れた印は署名の確認で落ちるので、それより古い記録は二度と照合されない)
  c_claim_retention CONSTANT INTERVAL := INTERVAL '1 day';
  v_claimed INTEGER;
BEGIN
  IF p_user_id IS NULL OR p_grant_id IS NULL THEN
    RAISE EXCEPTION 'claim_ai_usage_grant: p_user_id and p_grant_id are required' USING ERRCODE = '22023';
  END IF;

  -- 同じ利用者の古い記録を消す (表が増え続けないように)
  DELETE FROM public.ai_usage_grant_claims AS g
   WHERE g.user_id = p_user_id
     AND g.claimed_at < pg_catalog.now() - c_claim_retention;

  INSERT INTO public.ai_usage_grant_claims (grant_id, user_id)
  VALUES (p_grant_id, p_user_id)
  ON CONFLICT (grant_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed > 0;
END
$$;

REVOKE ALL ON FUNCTION public.claim_ai_usage_grant(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_usage_grant(UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.claim_ai_usage_grant(UUID, UUID) IS
  '#1149: 写真の判別が返した数え済みの印の ID を使用済みにする。はじめてなら true (呼び出し側は数えない)、使用済みなら false (数える)。署名・期限・利用者の確認は呼び出し側が先に行う。service_role のみ。';
