-- migration: 20261007053924_align_health_recipes_own_policies.sql
-- 本番ドリフト D-1〜D-12 (docs/operations/rls-drift-20261006.md / #1243) の解消:
--   health_goals / health_records / health_streaks / recipes の「own」ポリシー 12 本を、migration の定義に揃える
--
-- 背景:
--   2026-10-06 の本番スナップショットで、次の 12 本の定義が migration と違っていた。
--     D-1〜D-11  health_goals (view / insert / update / delete)、health_records (同 4 本)、
--               health_streaks (view / insert / update)
--               本番は TO public で、UPDATE の 3 本に WITH CHECK が無い。
--               migration (20260508190000_health_records_streaks_goals.sql) は TO authenticated で、
--               UPDATE に WITH CHECK (auth.uid() = user_id) がある。
--     D-12       recipes "Users can manage own recipes" (ALL)
--               本番は WITH CHECK が無い。
--               migration (20260430160000_db_audit_fixes.sql, #224) は WITH CHECK (auth.uid() = user_id) がある。
--   health_streaks の delete は 20260710090000_reconcile_paired_drift.sql で揃え済みのため対象外。
--
-- 変更:
--   12 本を DROP / CREATE し、名前・コマンド・条件を migration の定義どおりにする。
--   挙動は変わらない:
--     - 条件が auth.uid() = user_id のため、未ログイン (anon) は TO public でも一致しない。
--     - UPDATE / ALL で WITH CHECK を省略すると、PostgreSQL は USING の式を WITH CHECK にも使う。
--   tests/integration/rls/health-recipes-own-policies.test.ts (44 件) が、本番の定義のままでも
--   この migration の後でも同じ結果になることを確かめている。
--
-- 本番との関係: 対象テーブルのほかのポリシー (recipes "Users can view public recipes" 等) は本番と migration で一致しており、変更しない。
-- 冪等: DROP POLICY IF EXISTS + CREATE POLICY。
-- ロールバック: supabase/rollbacks/20261007053924_align_health_recipes_own_policies.down.sql

-- ---------------------------------------------------------------
-- health_goals (D-1〜D-4)
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own health goals" ON public.health_goals;
CREATE POLICY "Users can view own health goals"
  ON public.health_goals FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own health goals" ON public.health_goals;
CREATE POLICY "Users can insert own health goals"
  ON public.health_goals FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own health goals" ON public.health_goals;
CREATE POLICY "Users can update own health goals"
  ON public.health_goals FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own health goals" ON public.health_goals;
CREATE POLICY "Users can delete own health goals"
  ON public.health_goals FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- health_records (D-5〜D-8)
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own health records" ON public.health_records;
CREATE POLICY "Users can view own health records"
  ON public.health_records FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own health records" ON public.health_records;
CREATE POLICY "Users can insert own health records"
  ON public.health_records FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own health records" ON public.health_records;
CREATE POLICY "Users can update own health records"
  ON public.health_records FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own health records" ON public.health_records;
CREATE POLICY "Users can delete own health records"
  ON public.health_records FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- health_streaks (D-9〜D-11。delete は揃え済み)
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own health streaks" ON public.health_streaks;
CREATE POLICY "Users can view own health streaks"
  ON public.health_streaks FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own health streaks" ON public.health_streaks;
CREATE POLICY "Users can insert own health streaks"
  ON public.health_streaks FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own health streaks" ON public.health_streaks;
CREATE POLICY "Users can update own health streaks"
  ON public.health_streaks FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- recipes (D-12)
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS "Users can manage own recipes" ON public.recipes;
CREATE POLICY "Users can manage own recipes" ON public.recipes
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
