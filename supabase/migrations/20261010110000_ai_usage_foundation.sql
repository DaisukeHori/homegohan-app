-- migration: 20261010110000_ai_usage_foundation.sql
-- #1177 (T26): プランの判定と、AI の利用回数の記録の仕組みを作る (全員無制限のまま、記録だけ)
--
-- 背景:
--   personal_subscriptions の status / plan_key は、管理画面の閲覧とクーポン適用以外のどこからも参照されておらず、
--   AI を使う処理 (献立生成・写真解析・AI 相談など) にはプランに応じた許可・制限の仕組みが無い (#1177)。
--   当面は無料のまま計測する。全員無制限のままにし、まず「誰がどれだけ AI を使っているか」を記録する。
--   上限と比べて止める処理 (上限の値の表・上限との比較・拒否の応答) は、この migration では足さない。
--   上限を実際に入れる作業 (#1149 / T40) が、上限の値と、上限を超えたときの扱いと一緒に足す。
--
-- 追加するもの (テーブル 1 つ + 関数 3 つ。既存のテーブル・制約・データには一切触れない):
--   1. public.ai_usage_counters(user_id, usage_date, feature, count, PK(user_id, usage_date, feature))
--        ユーザー × 日 × 機能 の利用回数。usage_date は JST (Asia/Tokyo) の暦日。
--        user_id は auth.users への外部キー (ON DELETE CASCADE。アカウントを消せば記録も消える)。
--   2. public.get_effective_plan(p_user_id) -> text
--        そのユーザーに今効いているプランの plan_key。次の順で最初に見つかったもの:
--          a. personal_subscriptions のうち status が trialing / active / grace / past_due の契約 (paused は含めない)
--          b. 所属している家族グループ (family_members.status = 'active' かつ family_groups.status = 'active') の plan_key
--          c. 所属している組織 (user_profiles.organization_id。organizations.status = 'active') の plan
--          d. 'free'
--        家族の plan_key が 'free' でも、そこで確定する (組織のプランは見ない)。
--        organizations.subscription_status (trial / expired など) は見ない。どちらも T40 / T48 で決める。
--        この migration の中では使わない (記録はプランによらない)。上限を入れる作業が、プランごとの上限を引くのに使う。
--   3. public.record_ai_usage(p_user_id, p_feature) -> void
--        AI を 1 回使うごとに呼ぶ。その日 (JST) のその機能の回数を 1 つ増やすだけ。止める判定はしない。
--   4. public.record_ai_usage_at(p_user_id, p_feature, p_at) -> void
--        record_ai_usage の本体。「いつ使ったか」を引数で受け取る。JST の日付の変わり目を
--        テストで確かめるために切り出した (record_ai_usage は now() を渡すだけ)。
--        どのロールにも EXECUTE を付けない (所有者と record_ai_usage からだけ呼べる。PostgREST の API からは呼べない)。
--
-- 同時実行: 1 文の INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 で数える。
--   行ロックで直列化されるので、同時に何本来ても加算が失われない。
--
-- 失敗時の扱い (呼び出し側: src/lib/plan/entitlements.ts, supabase/functions/_shared/ai-usage.ts):
--   この関数が失敗しても (DB エラー・この migration が未適用など)、呼び出し側はログに残して先へ進む。
--   記録は best-effort で、記録の失敗で AI の機能そのものを止めない。
--
-- 権限:
--   - テーブルは RLS を有効にし、ポリシーは作らない (クライアントからは何も読み書きできない)。
--     Supabase の既定でテーブル権限が anon / authenticated / service_role に付くので、完全形で REVOKE し、
--     service_role にだけ SELECT / INSERT / UPDATE / DELETE を返す (運営の集計・サポートの対応・テストが使う)。
--   - get_effective_plan / record_ai_usage は service_role だけが実行できる (SECURITY DEFINER + search_path = '')。
--     呼び出しは認証済みのサーバー (Next.js の API ルート・Edge Function) だけが行い、
--     ユーザー ID はサーバーが認証で確定した値を渡す。anon / authenticated が呼べると、他人のプランを覗いたり、
--     他人の回数を増やしたりできてしまう。
--
-- 既存データへの影響: なし。データの更新・削除・追加はしない。インデックスは主キーだけ (作るのは空のテーブル)。
-- 適用順: ほかの作業の migration とは対象が重ならない (新しい表と関数を足すだけで、既存の表は読むだけ)。ただし、本番の台帳の
--   最大 version より古い version の migration は、deploy-supabase-migrations.yml の drift guard が止めるので、
--   マージは version 順に行う (本番の台帳の最大 version が、この migration の version より新しいときは、version を付け直す)。
--   Web / Edge Function を先にデプロイしても、この migration が未適用の間は「関数が無い」エラーをログに残すだけで、
--   AI の利用は止まらない。
-- 冪等: CREATE TABLE IF NOT EXISTS、CREATE OR REPLACE FUNCTION、ENABLE ROW LEVEL SECURITY、REVOKE / GRANT / COMMENT。
--   2 回続けて適用してもエラーにならず、結果も変わらない。
-- 確認: tests/integration/rls/ai-usage-rpc.test.ts
-- ロールバック: supabase/rollbacks/20261010110000_ai_usage_foundation.down.sql
--   (テーブルを消すと、それまでの記録も消える。ロールバックの先頭のコメントを参照)

-- ----------------------------------------------------------------
-- (1) ai_usage_counters: ユーザー × 日 (JST) × 機能 の利用回数
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
  '#1177: AI の利用回数 (ユーザー × 日 × 機能)。書き込みは record_ai_usage だけが行う。usage_date は JST の暦日。service_role だけが読み書きする (クライアント向けのポリシーは無い)。';
COMMENT ON COLUMN public.ai_usage_counters.usage_date IS '利用した日。JST (Asia/Tokyo) の暦日。';
COMMENT ON COLUMN public.ai_usage_counters.feature IS
  '機能名 (小文字・数字・アンダースコア。一覧は supabase/functions/_shared/ai-usage-core.ts の AI_FEATURES。Next.js と Edge Functions が共用する)。';
COMMENT ON COLUMN public.ai_usage_counters.count IS 'その日・その機能の利用回数。ユーザーの 1 回の操作を 1 と数える。';

-- ----------------------------------------------------------------
-- (2) 権限: クライアントには何も開けない (RLS 有効・ポリシー無し + テーブル権限も剥がす)
-- ----------------------------------------------------------------
ALTER TABLE public.ai_usage_counters ENABLE ROW LEVEL SECURITY;

-- Supabase の default privileges は CREATE TABLE 時点で anon / authenticated / service_role に権限を自動付与する。
-- REVOKE FROM PUBLIC だけでは剥がれないので、ロールを個別に完全形で REVOKE してから、service_role にだけ返す
-- (20261007150300_native_bridge_codes.sql と同じ理屈)。service_role は BYPASSRLS なので、RLS の影響は受けない。
REVOKE ALL ON public.ai_usage_counters FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage_counters TO service_role;

-- ----------------------------------------------------------------
-- (3) get_effective_plan: いま効いているプランの plan_key
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
-- (4) record_ai_usage_at: 本体 (時刻を引数で受け取る。API からは呼べない)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_ai_usage_at(
  p_user_id UUID,
  p_feature TEXT,
  p_at      TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'record_ai_usage: p_user_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_feature IS NULL OR p_feature !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'record_ai_usage: p_feature must be snake_case (up to 64 chars)' USING ERRCODE = '22023';
  END IF;
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'record_ai_usage: p_at is required' USING ERRCODE = '22023';
  END IF;

  -- 日付は JST の暦日 (UTC の暦日だと、JST の 0〜9 時が前日になってしまう)。
  -- 1 文で原子的に +1 するので、同時に来ても加算は失われない。
  INSERT INTO public.ai_usage_counters AS c (user_id, usage_date, feature, count)
  VALUES (p_user_id, (p_at AT TIME ZONE 'Asia/Tokyo')::DATE, p_feature, 1)
  ON CONFLICT (user_id, usage_date, feature)
  DO UPDATE SET count = c.count + 1, updated_at = pg_catalog.now();
END
$$;

-- どのロールにも EXECUTE を付けない (所有者と、同じ所有者の record_ai_usage からだけ呼べる)。
REVOKE ALL ON FUNCTION public.record_ai_usage_at(UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.record_ai_usage_at(UUID, TEXT, TIMESTAMPTZ) IS
  '#1177: record_ai_usage の本体。利用した時刻 (p_at) を引数で受け取る。JST の日付の変わり目をテストで確かめるために切り出したもので、API (PostgREST) からは呼べない。record_ai_usage を使うこと。';

-- ----------------------------------------------------------------
-- (5) record_ai_usage: AI を 1 回使うごとに呼ぶ (service_role のみ)
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_ai_usage(
  p_user_id UUID,
  p_feature TEXT
) RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.record_ai_usage_at(p_user_id, p_feature, pg_catalog.now());
$$;

REVOKE ALL ON FUNCTION public.record_ai_usage(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_ai_usage(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.record_ai_usage(UUID, TEXT) IS
  '#1177: AI を 1 回使うごとに呼ぶ。ai_usage_counters の (ユーザー, JST の今日, 機能) を +1 する。上限との比較はしない (上限は #1149 / T40)。service_role のみ。呼び出し側は失敗しても止めない。';
