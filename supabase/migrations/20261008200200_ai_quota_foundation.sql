-- migration: 20261008200200_ai_quota_foundation.sql
-- #1177 (T26): プランの判定と、AI の利用回数の記録の仕組みを作る (全員無制限のまま、計測だけ)
--
-- 背景:
--   personal_subscriptions の status / plan_key は、管理画面の閲覧とクーポン適用以外のどこからも参照されておらず、
--   AI を使う処理 (献立生成・写真解析・AI 相談など) にはプランに応じた許可・制限の仕組みが無い (#1177)。
--   2026-10-08 のオーナー判断: 当面は全員無制限のままにし、まず「誰がどれだけ AI を使っているか」を数える。
--   実際の上限値 (T40) と有料プラン (T48) は、この仕組みの上に別の作業で足す。
--
-- 追加するもの (テーブル 2 つ + 関数 3 つ。既存のテーブル・制約・データには一切触れない):
--   1. public.ai_plan_limits(plan_key PK, daily_limit, monthly_limit)
--        プランごとの AI 利用回数の上限。NULL は無制限。
--        既存のプラン (subscription_plans / family_groups.plan_key / organizations.plan に現れる値と 'free') を、
--        すべて NULL (無制限) で入れる。行が無いプランも無制限として扱う。
--        plan_key に外部キーは張らない: organizations.plan の既定値 'standard' のように subscription_plans に無い値が
--        あり得ること、空の DB (CI のシャドウ DB など) に流しても必ず通ることを優先した。
--   2. public.ai_usage_counters(user_id, usage_date, feature, count, PK(user_id, usage_date, feature))
--        ユーザー × 日 × 機能 の利用回数。usage_date は JST (Asia/Tokyo) の暦日。
--        user_id は auth.users への外部キー (ON DELETE CASCADE。アカウントを消せば計測も消える)。
--   3. public.get_effective_plan(p_user_id) -> text
--        そのユーザーに今効いているプランの plan_key。次の順で最初に見つかったもの:
--          a. personal_subscriptions のうち status が trialing / active / grace / past_due の契約 (paused は含めない)
--          b. 所属している家族グループ (family_members.status = 'active' かつ family_groups.status = 'active') の plan_key
--          c. 所属している組織 (user_profiles.organization_id。organizations.status = 'active') の plan
--          d. 'free'
--        家族の plan_key が 'free' でも、そこで確定する (組織のプランは見ない)。
--        organizations.subscription_status (trial / expired など) は見ない。どちらも T40 / T48 で決める。
--   4. public.consume_ai_quota(p_user_id, p_feature) -> jsonb
--        AI を 1 回使うごとに呼ぶ。利用回数を 1 つ増やし、プランの上限と比べて {allowed, remaining, ...} を返す。
--          許可: {"allowed": true,  "remaining": <残り回数 / 無制限なら null>, "plan_key": "..."}
--          拒否: {"allowed": false, "remaining": 0, "plan_key": "...", "limit_kind": "daily" | "monthly",
--                 "limit": <上限>, "reset_at": "<回数が戻る時刻 (UTC, ISO 8601)>"}   ※ 拒否した呼び出しは数えない
--        上限の数え方: daily_limit は「その日 (JST) の、全機能の合計」、monthly_limit は「その月 (JST) の、全機能の合計」。
--        feature は集計と内訳のための名前で、上限は機能ごとには持たない。
--        今は全プランが NULL (無制限) なので、必ず許可され、回数が増えるだけ。拒否の分岐はまだ通らない (テストでだけ通る)。
--   5. public.consume_ai_quota_at(p_user_id, p_feature, p_at) -> jsonb
--        consume_ai_quota の本体。「いつ使ったか」を引数で受け取る。JST の日付の変わり目・月の変わり目を
--        テストで確かめるために切り出した (consume_ai_quota は now() を渡すだけ)。
--        どのロールにも EXECUTE を付けない (所有者と consume_ai_quota からだけ呼べる。PostgREST の API からは呼べない)。
--
-- 同時実行:
--   - 上限が無いプラン (今は全員): 1 文の INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 で数える。
--     行ロックで直列化されるので、同時に何本来ても加算が失われない。
--   - 上限があるプラン: 数える前に、ユーザー単位の pg_advisory_xact_lock を取る。同じユーザーの呼び出しは直列になり、
--     機能をまたいだ合計も、上限を超えて通ることがない (READ COMMITTED 前提。PostgREST の既定)。
--     ロックはトランザクションの終わりで外れる。別のユーザーとは待ち合わない。
--
-- 失敗時の扱い (呼び出し側: src/lib/plan/entitlements.ts, supabase/functions/_shared/quota.ts):
--   この関数が失敗しても (DB エラー・この migration が未適用など)、呼び出し側は記録して「許可」にする。
--   海外の AI へ送る処理を止めない、というオーナーの方針 (2026-10-08)。
--
-- 権限:
--   - 2 つのテーブルは RLS を有効にし、ポリシーは作らない (クライアントからは何も読み書きできない)。
--     Supabase の既定でテーブル権限が anon / authenticated / service_role に付くので、完全形で REVOKE し、
--     service_role にだけ SELECT / INSERT / UPDATE / DELETE を返す (運営の管理画面・サポートの対応・テストが使う)。
--   - get_effective_plan / consume_ai_quota は service_role だけが実行できる (SECURITY DEFINER + search_path = '')。
--     呼び出しは認証済みのサーバー (Next.js の API ルート・Edge Function) だけが行い、
--     ユーザー ID はサーバーが認証で確定した値を渡す。anon / authenticated が呼べると、他人のプランや回数を覗けてしまう。
--
-- 既存データへの影響: なし。ai_plan_limits にプランの行を入れる INSERT (既存のテーブルは読むだけ) 以外に、
--   データの更新・削除・追加はしない。インデックスは主キーだけ (CONCURRENTLY は使えないが、作るのは空のテーブル)。
-- 適用順: ほかの作業の migration とは対象が重ならない (新しい表と関数を足すだけで、既存の表は読むだけ)。ただし、本番の台帳の
--   最大 version より古い version の migration は、deploy-supabase-migrations.yml の drift guard が止めるので、
--   マージは version 順に行う (本番の台帳の最大 version が、この migration の version より新しいときは、version を付け直す)。
--   Web / Edge Function を先にデプロイしても、この migration が未適用の間は「関数が無い」エラーを記録して許可するだけで、
--   AI の利用は止まらない。
-- 冪等: CREATE TABLE / INDEX IF NOT EXISTS、CREATE OR REPLACE FUNCTION、INSERT ... ON CONFLICT DO NOTHING、
--   ENABLE ROW LEVEL SECURITY、REVOKE / GRANT / COMMENT。2 回続けて適用してもエラーにならず、結果も変わらない。
-- 確認: tests/integration/rls/ai-quota-rpc.test.ts
-- ロールバック: supabase/rollbacks/20261008200200_ai_quota_foundation.down.sql
--   (テーブルを消すと、それまでの計測結果も消える。ロールバックの先頭のコメントを参照)

-- ----------------------------------------------------------------
-- (1) ai_plan_limits: プランごとの上限 (NULL = 無制限)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_plan_limits (
  plan_key      TEXT        PRIMARY KEY,
  daily_limit   INTEGER,
  monthly_limit INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_plan_limits_daily_limit_nonneg CHECK (daily_limit IS NULL OR daily_limit >= 0),
  CONSTRAINT ai_plan_limits_monthly_limit_nonneg CHECK (monthly_limit IS NULL OR monthly_limit >= 0)
);

COMMENT ON TABLE public.ai_plan_limits IS
  '#1177: プランごとの AI 利用回数の上限。daily_limit は JST の 1 日、monthly_limit は JST の 1 か月の「全機能の合計」。NULL は無制限。行が無いプランも無制限。service_role だけが読み書きする (クライアント向けのポリシーは無い)。';
COMMENT ON COLUMN public.ai_plan_limits.plan_key IS
  'subscription_plans.plan_key / family_groups.plan_key / organizations.plan と同じ文字列。外部キーは張らない (組織の plan の既定値 ''standard'' など、subscription_plans に無い値があり得るため)。';
COMMENT ON COLUMN public.ai_plan_limits.daily_limit IS '1 日 (JST) の上限。NULL = 無制限。0 以上。';
COMMENT ON COLUMN public.ai_plan_limits.monthly_limit IS '1 か月 (JST) の上限。NULL = 無制限。0 以上。';

-- 既存のプランを、すべて無制限 (NULL / NULL) で入れる。'free' は subscription_plans に無い環境でも必ず入れる。
-- 既存のテーブルは読むだけで、書き換えない。空の DB でも通る ('free' だけが入る)。
INSERT INTO public.ai_plan_limits (plan_key)
SELECT k.plan_key
  FROM (
    SELECT 'free'::text AS plan_key
    UNION SELECT sp.plan_key::text FROM public.subscription_plans AS sp
    UNION SELECT fg.plan_key FROM public.family_groups AS fg
    UNION SELECT o.plan FROM public.organizations AS o WHERE o.plan IS NOT NULL
  ) AS k
ON CONFLICT (plan_key) DO NOTHING;

-- ----------------------------------------------------------------
-- (2) ai_usage_counters: ユーザー × 日 (JST) × 機能 の利用回数
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_usage_counters (
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  usage_date DATE        NOT NULL,
  feature    TEXT        NOT NULL,
  count      INTEGER     NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_date, feature),
  CONSTRAINT ai_usage_counters_count_nonneg CHECK (count >= 0),
  CONSTRAINT ai_usage_counters_feature_format CHECK (feature ~ '^[a-z][a-z0-9_]{0,63}$')
);

COMMENT ON TABLE public.ai_usage_counters IS
  '#1177: AI の利用回数 (ユーザー × 日 × 機能)。書き込みは consume_ai_quota だけが行う。usage_date は JST の暦日。service_role だけが読み書きする (クライアント向けのポリシーは無い)。';
COMMENT ON COLUMN public.ai_usage_counters.usage_date IS '利用した日。JST (Asia/Tokyo) の暦日。';
COMMENT ON COLUMN public.ai_usage_counters.feature IS
  '機能名 (小文字・数字・アンダースコア。src/lib/plan/entitlements.ts の AI_FEATURES と supabase/functions/_shared/quota.ts が同じ一覧を持つ)。';
COMMENT ON COLUMN public.ai_usage_counters.count IS 'その日・その機能の利用回数。ユーザーの 1 回の操作を 1 と数える。';

-- ----------------------------------------------------------------
-- (3) 権限: クライアントには何も開けない (RLS 有効・ポリシー無し + テーブル権限も剥がす)
-- ----------------------------------------------------------------
ALTER TABLE public.ai_plan_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_counters ENABLE ROW LEVEL SECURITY;

-- Supabase の default privileges は CREATE TABLE 時点で anon / authenticated / service_role に権限を自動付与する。
-- REVOKE FROM PUBLIC だけでは剥がれないので、ロールを個別に完全形で REVOKE してから、service_role にだけ返す
-- (20261007150300_native_bridge_codes.sql と同じ理屈)。service_role は BYPASSRLS なので、RLS の影響は受けない。
REVOKE ALL ON public.ai_plan_limits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_plan_limits TO service_role;

REVOKE ALL ON public.ai_usage_counters FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage_counters TO service_role;

-- ----------------------------------------------------------------
-- (4) get_effective_plan: いま効いているプランの plan_key
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_effective_plan(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 'free';
  END IF;

  -- a. 個人の契約。有効な状態 (試用中・有効・猶予中・支払い遅延) の契約だけ。paused / cancelled / expired は含めない。
  --    有効な契約は 1 ユーザーにつき 1 件まで (部分 UNIQUE idx_personal_subscriptions_active_per_user)。
  --    ORDER BY は、その前提が崩れても結果が揺れないようにするためのもの。
  SELECT s.plan_key::TEXT
    INTO v_plan
    FROM public.personal_subscriptions AS s
   WHERE s.user_id = p_user_id
     AND s.status IN ('trialing', 'active', 'grace', 'past_due')
   ORDER BY s.created_at DESC, s.id
   LIMIT 1;
  IF v_plan IS NOT NULL THEN
    RETURN v_plan;
  END IF;

  -- b. 家族。active なメンバーとして、active な家族グループに所属している場合の、その家族の plan_key。
  --    active なメンバーは 1 ユーザーにつき 1 行まで (部分 UNIQUE uniq_family_members_user)。
  SELECT g.plan_key
    INTO v_plan
    FROM public.family_members AS m
    JOIN public.family_groups AS g ON g.id = m.family_id
   WHERE m.user_id = p_user_id
     AND m.status = 'active'
     AND g.status = 'active'
   LIMIT 1;
  IF v_plan IS NOT NULL THEN
    RETURN v_plan;
  END IF;

  -- c. 組織。所属している (user_profiles.organization_id) active な組織の plan。plan が NULL の組織は 'free' になる。
  SELECT o.plan
    INTO v_plan
    FROM public.user_profiles AS p
    JOIN public.organizations AS o ON o.id = p.organization_id
   WHERE p.id = p_user_id
     AND o.status = 'active'
   LIMIT 1;

  -- d. どれにも当てはまらなければ 'free'
  RETURN COALESCE(v_plan, 'free');
END
$$;

REVOKE ALL ON FUNCTION public.get_effective_plan(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_effective_plan(UUID) TO service_role;

COMMENT ON FUNCTION public.get_effective_plan(UUID) IS
  '#1177: ユーザーに今効いているプランの plan_key。個人の契約 (trialing / active / grace / past_due) -> 家族 (active なメンバー・active な家族) -> 組織 (active) -> ''free'' の順で最初に見つかったもの。service_role のみ。';

-- ----------------------------------------------------------------
-- (5) consume_ai_quota_at: 本体 (時刻を引数で受け取る。API からは呼べない)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_ai_quota_at(
  p_user_id UUID,
  p_feature TEXT,
  p_at      TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_today         DATE;
  v_month_start   DATE;
  v_plan          TEXT;
  v_daily_limit   INTEGER;
  v_monthly_limit INTEGER;
  v_day_total     BIGINT;
  v_month_total   BIGINT;
  v_remaining     BIGINT;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'consume_ai_quota: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_feature IS NULL OR p_feature !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'consume_ai_quota: p_feature must be snake_case (up to 64 chars)' USING ERRCODE = '22023';
  END IF;
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'consume_ai_quota: p_at is required' USING ERRCODE = '22023';
  END IF;

  -- 日付は JST の暦日 (UTC の暦日だと、JST の 0〜9 時が前日になってしまう)。月も JST の暦月。
  v_today := (p_at AT TIME ZONE 'Asia/Tokyo')::DATE;
  v_month_start := pg_catalog.date_trunc('month', v_today::TIMESTAMP)::DATE;

  -- プランの上限。行が無いプランは無制限 (NULL / NULL のまま)。
  v_plan := public.get_effective_plan(p_user_id);
  SELECT l.daily_limit, l.monthly_limit
    INTO v_daily_limit, v_monthly_limit
    FROM public.ai_plan_limits AS l
   WHERE l.plan_key = v_plan;

  -- 上限があるときだけ、ユーザー単位で直列化して、これまでの合計と比べる。
  -- 拒否した呼び出しは数えない (回数は増やさずに返す)。
  IF v_daily_limit IS NOT NULL OR v_monthly_limit IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('ai_quota:' || p_user_id::TEXT, 0));

    SELECT COALESCE(SUM(c.count) FILTER (WHERE c.usage_date = v_today), 0),
           COALESCE(SUM(c.count), 0)
      INTO v_day_total, v_month_total
      FROM public.ai_usage_counters AS c
     WHERE c.user_id = p_user_id
       AND c.usage_date >= v_month_start
       AND c.usage_date <= v_today;

    IF v_daily_limit IS NOT NULL AND v_day_total >= v_daily_limit THEN
      RETURN pg_catalog.jsonb_build_object(
        'allowed', false,
        'remaining', 0,
        'plan_key', v_plan,
        'limit_kind', 'daily',
        'limit', v_daily_limit,
        -- 回数が戻るのは、次の JST の 0 時
        'reset_at', pg_catalog.to_char(
          ((v_today + 1)::TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      );
    END IF;

    IF v_monthly_limit IS NOT NULL AND v_month_total >= v_monthly_limit THEN
      RETURN pg_catalog.jsonb_build_object(
        'allowed', false,
        'remaining', 0,
        'plan_key', v_plan,
        'limit_kind', 'monthly',
        'limit', v_monthly_limit,
        -- 回数が戻るのは、翌月 1 日の JST の 0 時
        'reset_at', pg_catalog.to_char(
          ((v_month_start + INTERVAL '1 month')::TIMESTAMP AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      );
    END IF;
  END IF;

  -- 数える。1 文で原子的に +1 するので、同時に来ても加算は失われない。
  INSERT INTO public.ai_usage_counters AS c (user_id, usage_date, feature, count)
  VALUES (p_user_id, v_today, p_feature, 1)
  ON CONFLICT (user_id, usage_date, feature)
  DO UPDATE SET count = c.count + 1, updated_at = pg_catalog.now();

  -- 残り回数。上限が無ければ NULL (無制限)。両方あれば少ない方 (今回の分を引いたあと)。
  v_remaining := LEAST(
    CASE WHEN v_daily_limit IS NOT NULL THEN v_daily_limit - (v_day_total + 1) END,
    CASE WHEN v_monthly_limit IS NOT NULL THEN v_monthly_limit - (v_month_total + 1) END
  );

  RETURN pg_catalog.jsonb_build_object(
    'allowed', true,
    'remaining', v_remaining,
    'plan_key', v_plan
  );
END
$$;

-- どのロールにも EXECUTE を付けない (所有者と、同じ所有者の consume_ai_quota からだけ呼べる)。
REVOKE ALL ON FUNCTION public.consume_ai_quota_at(UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.consume_ai_quota_at(UUID, TEXT, TIMESTAMPTZ) IS
  '#1177: consume_ai_quota の本体。利用した時刻 (p_at) を引数で受け取る。JST の日付・月の変わり目をテストで確かめるために切り出したもので、API (PostgREST) からは呼べない。consume_ai_quota を使うこと。';

-- ----------------------------------------------------------------
-- (6) consume_ai_quota: AI を 1 回使うごとに呼ぶ (service_role のみ)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_ai_quota(
  p_user_id UUID,
  p_feature TEXT
) RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.consume_ai_quota_at(p_user_id, p_feature, pg_catalog.now());
$$;

REVOKE ALL ON FUNCTION public.consume_ai_quota(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.consume_ai_quota(UUID, TEXT) IS
  '#1177: AI を 1 回使うごとに呼ぶ。ユーザーのプランの上限 (ai_plan_limits。NULL = 無制限) と比べて {allowed, remaining, plan_key} を返し、許可したら ai_usage_counters を +1 する。拒否時は limit_kind / limit / reset_at も返し、数えない。JST の日・月で数える。service_role のみ。呼び出し側は失敗しても許可する (止めない)。';
