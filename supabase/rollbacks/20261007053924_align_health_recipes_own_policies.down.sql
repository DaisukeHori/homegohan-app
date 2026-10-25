-- rollback: 20261007053924_align_health_recipes_own_policies.sql
-- 20261024110000 より前の状態で流すなら挙動は変わらない (本番ドリフト D-1〜D-12 が再び生じるだけ)。20261024110000 の後に流すと、health_streaks の INSERT / UPDATE のポリシーを streak_type を絞らない旧式で作り直すので、利用者が自分の meal_record / breakfast の行を書ける穴が再び開く (20261024110000 の down を流したのと同じ認可になる)。
--   この migration は定義の書き方を migration に揃えただけで、認可の結果は前後で同じ
--   (tests/integration/rls/health-recipes-own-policies.test.ts)。通常は戻す必要は無い。
--
-- 内容: 2026-10-06 時点の本番の定義 (supabase/baseline/prod_schema.sql) へ戻す。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP POLICY IF EXISTS "Users can view own health goals" ON "public"."health_goals";
CREATE POLICY "Users can view own health goals" ON "public"."health_goals" FOR SELECT USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can insert own health goals" ON "public"."health_goals";
CREATE POLICY "Users can insert own health goals" ON "public"."health_goals" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can update own health goals" ON "public"."health_goals";
CREATE POLICY "Users can update own health goals" ON "public"."health_goals" FOR UPDATE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can delete own health goals" ON "public"."health_goals";
CREATE POLICY "Users can delete own health goals" ON "public"."health_goals" FOR DELETE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can view own health records" ON "public"."health_records";
CREATE POLICY "Users can view own health records" ON "public"."health_records" FOR SELECT USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can insert own health records" ON "public"."health_records";
CREATE POLICY "Users can insert own health records" ON "public"."health_records" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can update own health records" ON "public"."health_records";
CREATE POLICY "Users can update own health records" ON "public"."health_records" FOR UPDATE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can delete own health records" ON "public"."health_records";
CREATE POLICY "Users can delete own health records" ON "public"."health_records" FOR DELETE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can view own health streaks" ON "public"."health_streaks";
CREATE POLICY "Users can view own health streaks" ON "public"."health_streaks" FOR SELECT USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can insert own health streaks" ON "public"."health_streaks";
CREATE POLICY "Users can insert own health streaks" ON "public"."health_streaks" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can update own health streaks" ON "public"."health_streaks";
CREATE POLICY "Users can update own health streaks" ON "public"."health_streaks" FOR UPDATE USING (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can manage own recipes" ON "public"."recipes";
CREATE POLICY "Users can manage own recipes" ON "public"."recipes" USING (("auth"."uid"() = "user_id"));
