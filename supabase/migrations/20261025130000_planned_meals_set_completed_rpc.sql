-- migration: 20261025130000_planned_meals_set_completed_rpc.sql
-- 戻し方: supabase/rollbacks/20261025130000_planned_meals_set_completed_rpc.down.sql
-- #2025 (1/2): 献立 (planned_meals) の「食べた」の切り替えを、本人の行だけを書く SECURITY DEFINER の関数 1 本にする。
--
-- 背景:
--   比較ランキング (calculate-segment-stats の breakfast_rate / menu_execution_rate / veg_score_avg / nutrition_score) と
--   組織のチャレンジ (update_org_challenge_progress) は planned_meals.is_completed / veg_score を指標に使う。
--   本番のベースライン (20251126124224_create_meal_planner_tables.sql) の
--     :9900  "Users can manage own planned meals"  FOR ALL・TO public・USING (本人の user_daily_meals の行)・WITH CHECK 無し
--     :13798-13799  anon / authenticated への INSERT, SELECT, UPDATE, DELETE, ... の表の権限
--   により、利用者は PostgREST から自分の行のどの列でも書けた (#1999 の health_streaks と同じ型)。
--   完了の切り替えはアプリの 5 か所が利用者のセッションで直接 UPDATE していた (apps/mobile/src/hooks/useHomeData.ts・
--   src/hooks/useHomeData.ts・PATCH /api/meals/[id]・PATCH /api/meal-plans/meals/[id]・AI 相談の complete_meal)。
--
-- 変更 (この migration は関数を 1 本足すだけ。表・ポリシー・権限・行は変えない):
--   public.planned_meals_set_completed(p_meal_id uuid, p_completed boolean)
--     - SECURITY DEFINER (所有者 postgres の権限で書く)。search_path は空にし、表・関数は schema つきで書く
--     - 本人の行 (user_daily_meals.user_id = auth.uid()) だけを UPDATE。他人の行・無い行は PLANNED_MEAL_NOT_FOUND (P0002)
--     - is_completed = p_completed。completed_at は、完了にするときは「すでに完了で時刻があればその時刻、無ければ now()」、
--       未完了にするときは NULL (時刻は利用者が指定できない = サーバの計算値)
--     - 返すのは書いた行の id / is_completed / completed_at / updated_at (updated_at はトリガー trg_planned_meals_updated_at が進める)
--     - EXECUTE は authenticated と service_role だけ (PUBLIC・anon から外す。tests/integration/security/anon-definer-execute.test.ts の A1)
--   利用者のセッションから is_completed / completed_at / veg_score を直接書く権限は、次の migration
--   (<番号はマージ時に確定>_planned_meals_score_columns_server_only.sql) が外す。アプリの書き手の付け替え (この関数を呼ぶ形) は
--   その前にデプロイする (docs/design/cross/23-planned-meals-score-integrity.md §15)。
--
-- 既存データへの影響: なし。
-- 冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT のため、2 回続けて適用してもエラーにならない。
-- ロック: 表には触れない (関数の作成とカタログの権限だけ)。
-- 確認: tests/integration/rls/planned-meals-score-integrity.test.ts (実 DB)
--       tests/planned-meals-score-integrity-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.planned_meals_set_completed(p_meal_id uuid, p_completed boolean)
RETURNS TABLE (id uuid, is_completed boolean, completed_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'PLANNED_MEAL_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF p_meal_id IS NULL OR p_completed IS NULL THEN
    RAISE EXCEPTION 'PLANNED_MEAL_INVALID_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE public.planned_meals AS pm
     SET is_completed = p_completed,
         completed_at = CASE
           WHEN NOT p_completed THEN NULL
           WHEN pm.is_completed IS TRUE AND pm.completed_at IS NOT NULL THEN pm.completed_at
           ELSE now()
         END
   WHERE pm.id = p_meal_id
     AND EXISTS (
       SELECT 1 FROM public.user_daily_meals AS d
        WHERE d.id = pm.daily_meal_id AND d.user_id = v_user_id
     )
  RETURNING pm.id, pm.is_completed, pm.completed_at, pm.updated_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLANNED_MEAL_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.planned_meals_set_completed(uuid, boolean) IS
  '#2025: 献立 (planned_meals) の「食べた」を本人の行だけ切り替える。completed_at は完了なら既存の時刻か now()、未完了なら NULL。他人の行・無い行は PLANNED_MEAL_NOT_FOUND (P0002)。docs/design/cross/23-planned-meals-score-integrity.md §7.1';

REVOKE ALL ON FUNCTION public.planned_meals_set_completed(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.planned_meals_set_completed(uuid, boolean) TO authenticated, service_role;
