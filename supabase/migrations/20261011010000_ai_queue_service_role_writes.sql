-- migration: 20261011010000_ai_queue_service_role_writes.sql
-- #1465: AI のキュー (weekly_menu_requests / meal_image_jobs) への書き込みを service role だけにする
--
-- 背景:
--   2 つの表に積んだ行は、service role の処理が AI へ送る。
--     weekly_menu_requests: Vercel Cron (src/app/api/cron/process-menu-queue) が queued の行を取り出し、generate-menu-v5 を呼ぶ
--     meal_image_jobs:      Edge Function process-meal-image-jobs が pending のジョブを処理する
--   AI の利用回数は、行を積む route で記録する (#1177)。ところが利用者 (authenticated) は RLS で自分の行を直接
--   INSERT / UPDATE / DELETE できたので、route を通らずに積んだ行・status などを書き換えて積み直した行は、どこでも記録されず、
--   これから入れる上限 (T40 #1149) もすり抜けられた。
--   Web の画面・モバイルからの直接の書き込みは無くし (モバイルの写真の上書きだけが meal_image_jobs を直接 UPDATE していた)、
--   route は本人の確認のあとで service role (src/lib/ai/ai-queue-writer.ts の getAiQueueWriter) で書くようにした。
--
-- 変更:
--   1. 書き込みを許すポリシーを消す (SELECT の本人ポリシーは残す。進み具合の表示と Realtime が読む)
--        weekly_menu_requests:
--          "Users can create their own requests"         FOR INSERT (TO public)
--          "Users can manage own weekly menu requests"   FOR ALL    (TO public)  ※ SELECT は "Users can view their own requests" が残る
--        meal_image_jobs:
--          "meal_image_jobs_insert_own"                  FOR INSERT TO authenticated
--          "meal_image_jobs_update_own"                  FOR UPDATE TO authenticated
--          "user can delete own meal_image_jobs"         FOR DELETE (TO public)
--        残すもの: "Users can view their own requests" / "meal_image_jobs_select_own" (本人の行の SELECT)、
--                  "service_role can manage meal_image_jobs" (auth.role() = 'service_role' のときだけ。利用者には効かない)
--   2. 書き込みの権限 (INSERT / UPDATE / DELETE / TRUNCATE) を anon と authenticated から外す
--        ポリシーを消すだけでも書けなくなるが、権限も外して二重に閉じる (後で誰かが書き込みのポリシーを足しても開かない)。
--        TRUNCATE は RLS が効かない書き込みなので一緒に外す。anon も auth.uid() が NULL で書けなかったが、同じく外す。
--        SELECT・REFERENCES・TRIGGER・MAINTAIN と service_role の権限は変えない。
--
-- 本番のデータは消さない (ポリシーと権限だけの変更)。何度流しても同じ結果になる (冪等: DROP POLICY IF EXISTS と REVOKE)。
-- 戻し方: supabase/rollbacks/20261011010000_ai_queue_service_role_writes.down.sql
-- 確かめるテスト: tests/integration/rls/ai-queue-writes.test.ts (実 DB) と tests/ai-usage-contract.test.ts (migration の読み取り)

-- 1. 書き込みのポリシー
DROP POLICY IF EXISTS "Users can create their own requests" ON public.weekly_menu_requests;
DROP POLICY IF EXISTS "Users can manage own weekly menu requests" ON public.weekly_menu_requests;

DROP POLICY IF EXISTS "meal_image_jobs_insert_own" ON public.meal_image_jobs;
DROP POLICY IF EXISTS "meal_image_jobs_update_own" ON public.meal_image_jobs;
DROP POLICY IF EXISTS "user can delete own meal_image_jobs" ON public.meal_image_jobs;

-- 2. 書き込みの権限
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.weekly_menu_requests FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.meal_image_jobs FROM anon, authenticated;
