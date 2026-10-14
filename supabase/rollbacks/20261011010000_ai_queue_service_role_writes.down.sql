-- rollback: 20261011010000_ai_queue_service_role_writes.sql
-- #1465 で外した、AI のキュー (weekly_menu_requests / meal_image_jobs) への利用者からの書き込みのポリシーと権限を、元に戻す。
-- ポリシーの名前・対象のロール・式は、本番のベースライン (20251126124224_create_meal_planner_tables.sql) と同じ。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、利用者がキューに直接行を積めるようになり、AI の利用回数の記録 (#1177) と上限 (T40 #1149) をすり抜けられる穴が開く。
--   - アプリ (route は service role で書く) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: 作り直す前に DROP POLICY IF EXISTS する。GRANT は何度流しても同じ)。

GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.weekly_menu_requests TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.meal_image_jobs TO anon, authenticated;

DROP POLICY IF EXISTS "Users can create their own requests" ON public.weekly_menu_requests;
CREATE POLICY "Users can create their own requests" ON public.weekly_menu_requests
  FOR INSERT WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "Users can manage own weekly menu requests" ON public.weekly_menu_requests;
CREATE POLICY "Users can manage own weekly menu requests" ON public.weekly_menu_requests
  USING ((auth.uid() = user_id));

DROP POLICY IF EXISTS "meal_image_jobs_insert_own" ON public.meal_image_jobs;
CREATE POLICY "meal_image_jobs_insert_own" ON public.meal_image_jobs
  FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "meal_image_jobs_update_own" ON public.meal_image_jobs;
CREATE POLICY "meal_image_jobs_update_own" ON public.meal_image_jobs
  FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

DROP POLICY IF EXISTS "user can delete own meal_image_jobs" ON public.meal_image_jobs;
CREATE POLICY "user can delete own meal_image_jobs" ON public.meal_image_jobs
  FOR DELETE USING ((auth.uid() = user_id));
