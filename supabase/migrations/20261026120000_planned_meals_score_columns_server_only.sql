-- migration: 20261026120000_planned_meals_score_columns_server_only.sql
-- 戻し方: supabase/rollbacks/20261026120000_planned_meals_score_columns_server_only.down.sql
-- #2025 (2/2): 比較ランキングと組織のチャレンジが指標に使う planned_meals の 3 列 (veg_score / is_completed / completed_at) を、
--   利用者 (anon / authenticated) の INSERT / UPDATE の権限から外す。書けるのはサーバだけにする。
--
-- 背景:
--   本番のベースライン (20251126124224_create_meal_planner_tables.sql) の :13798-13799 で anon / authenticated は planned_meals の
--   INSERT / UPDATE を表ごと持ち、:9900 のポリシー "Users can manage own planned meals" (FOR ALL・列を絞らない) で自分の行の
--   どの列でも書けた。利用者は veg_score に好きな値を入れ、is_completed / completed_at も好きに書けた (#1999 の health_streaks と同じ型)。
--   20261022190000_db_privilege_hardening.sql は TRUNCATE だけを外した。ベースラインより後に planned_meals の列・権限・ポリシーを
--   変えた migration は無い (origin/main で grep した)。
--
--   3 列を書く経路 (origin/main で git grep した。docs/design/cross/23-planned-meals-score-integrity.md §3.1):
--     - 完了の切り替え (モバイルのホーム・Web のホーム・PATCH /api/meals/[id]・PATCH /api/meal-plans/meals/[id]・AI 相談の
--       complete_meal) は、1/2 (20261025130000_planned_meals_set_completed_rpc.sql) の SECURITY DEFINER の関数
--       planned_meals_set_completed を呼ぶ形に付け替え済み (所有者の権限で書くので、この変更の影響を受けない)
--     - 野菜スコア (veg_score) を書くのは写真の解析 (supabase/functions/analyze-meal-photo) の背景の処理だけで、service_role の
--       client で本人の行を確かめてから書く形に付け替え済み。POST /api/ai/nutrition は veg_score を書かない
--     - 新規作成の route (POST /api/meals・POST /api/meal-plans/meals・POST /api/meal-plans/add-from-photo) は is_completed を送らない
--       (列の既定 false)。週間生成の失敗時の復元 (src/lib/planned-meals-snapshot.ts) は service_role で戻す
--     - 献立の生成と保存 (supabase/functions/_shared/save-meal.ts・generate-menu-v4 / v5) と集計 (calculate-segment-stats・
--       update_org_challenge_progress) は service_role (変えない)
--     - SQL 関数 upsert_daily_meal_slot (SECURITY DEFINER・EXECUTE は service_role だけ・呼ぶ箇所は無い) は INSERT で is_completed = FALSE を
--       書くが、所有者の権限で書くのでこの変更の影響を受けない (変えない)
--
-- 変更:
--   1. planned_meals の INSERT / UPDATE を anon と authenticated から外す (表の権限が残っていると列の権限は効かない:
--      PostgreSQL は表の権限か列の権限のどちらかがあれば許す)。
--   2. authenticated に、3 列を除く 56 列の INSERT (列) / UPDATE (列) を付け直す (ベースラインの CREATE TABLE の 59 列から
--      is_completed / completed_at / veg_score を除いた並び)。anon には付け直さない (anon が planned_meals を書く経路は無く、
--      ポリシーは auth.uid() が NULL で 0 行)。
--   後で planned_meals に列を足す migration は、同じファイルで authenticated にその列の INSERT (列) / UPDATE (列) を GRANT する
--   (tests/planned-meals-score-integrity-migration-contract.test.ts が見張る)。
--   SELECT・DELETE・REFERENCES・TRIGGER・MAINTAIN と service_role・postgres の権限、RLS のポリシー、トリガーは変えない。
--   TRUNCATE は付け直さない (20261022190000 の規則)。
--
-- 効き方: 利用者のセッションから 3 列を含む INSERT / UPDATE / upsert は 42501 (permission denied for table planned_meals) で止まる
--   (PostgREST では 403・supabase-js では error.code = '42501')。3 列を含まない INSERT / UPDATE は今までどおり通る。
--   古いモバイルのビルドの完了の切り替え (直接の UPDATE) は失敗し、既存の失敗時の処理で画面が元に戻る (ローンチ前で利用者はゼロ)。
--
-- 既存データへの影響: なし (権限だけの変更。行は消さない・変えない)。
-- 冪等: REVOKE / GRANT は何度流しても同じ結果になる。
-- ロック: GRANT / REVOKE は planned_meals の ACCESS EXCLUSIVE を一瞬取る (カタログの書き換えだけで、行には触れない)。
-- 確認: tests/integration/rls/planned-meals-score-integrity.test.ts (実 DB)
--       tests/planned-meals-score-integrity-migration-contract.test.ts (静的)

-- 表のロックを長く待たない (待ちが続いたら失敗させて流し直す。20261024110000 と同じ)
SET LOCAL lock_timeout = '10s';

-- 1. 表ごとの INSERT / UPDATE を外す
REVOKE INSERT, UPDATE ON TABLE public.planned_meals FROM anon, authenticated;

-- 2. 3 列 (is_completed / completed_at / veg_score) を除く 56 列を authenticated に付け直す
GRANT INSERT (
  id, meal_type, dish_name, recipe_url, image_url, description, ingredients,
  calories_kcal, protein_g, fat_g, carbs_g, actual_meal_id, created_at, updated_at,
  mode, dishes, is_simple, cooking_time_minutes, memo, quality_tags, display_order,
  sodium_g, sugar_g, fiber_g, fiber_soluble_g, fiber_insoluble_g, potassium_mg, calcium_mg,
  phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg,
  vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug,
  vitamin_k_ug, vitamin_e_mg, saturated_fat_g, monounsaturated_fat_g, polyunsaturated_fat_g,
  amino_acid_g, recipe_steps, is_generating, source_type, source_dataset_version,
  source_menu_set_external_id, generation_metadata, magnesium_mg, daily_meal_id, catalog_product_id
), UPDATE (
  id, meal_type, dish_name, recipe_url, image_url, description, ingredients,
  calories_kcal, protein_g, fat_g, carbs_g, actual_meal_id, created_at, updated_at,
  mode, dishes, is_simple, cooking_time_minutes, memo, quality_tags, display_order,
  sodium_g, sugar_g, fiber_g, fiber_soluble_g, fiber_insoluble_g, potassium_mg, calcium_mg,
  phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg,
  vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug,
  vitamin_k_ug, vitamin_e_mg, saturated_fat_g, monounsaturated_fat_g, polyunsaturated_fat_g,
  amino_acid_g, recipe_steps, is_generating, source_type, source_dataset_version,
  source_menu_set_external_id, generation_metadata, magnesium_mg, daily_meal_id, catalog_product_id
) ON TABLE public.planned_meals TO authenticated;
