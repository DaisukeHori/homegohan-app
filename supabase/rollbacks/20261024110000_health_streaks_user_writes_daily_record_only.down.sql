-- rollback: 20261024110000_health_streaks_user_writes_daily_record_only.sql
-- #1917 で streak_type = 'daily_record' に絞った、health_streaks の利用者 (authenticated) の INSERT / UPDATE のポリシーを、元に戻す。
-- ポリシーの名前・種類・対象のロール・式は、本番のベースライン (20251126124224_create_meal_planner_tables.sql:9783・:9980) と同じ。
-- 本冊は表の権限に触れていないので、権限は戻さない (GRANT を書かない)。
-- (tests/health-streaks-user-writes-migration-contract.test.ts が、ポリシーとベースラインの行との一致を見る。
--  tests/integration/rls/health-streaks-user-writes.test.ts が、ローカルの DB で流して確かめる)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、利用者が自分の meal_record / breakfast の行を直接 INSERT / UPDATE でき、比較ランキングの指標
--     record_streak / breakfast_streak に任意の値を入れられる穴が再び開く。
--   - アプリ (書くのは daily_record だけ) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: 作り直す前に DROP POLICY IF EXISTS する)。

SET LOCAL lock_timeout = '10s';

DROP POLICY IF EXISTS "Users can insert own health streaks" ON public.health_streaks;
CREATE POLICY "Users can insert own health streaks" ON "public"."health_streaks" FOR INSERT TO "authenticated" WITH CHECK (("auth"."uid"() = "user_id"));

DROP POLICY IF EXISTS "Users can update own health streaks" ON public.health_streaks;
CREATE POLICY "Users can update own health streaks" ON "public"."health_streaks" FOR UPDATE TO "authenticated" USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));
