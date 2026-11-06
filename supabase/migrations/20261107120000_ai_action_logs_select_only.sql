-- migration: 20261107120000_ai_action_logs_select_only.sql
-- 戻し方: supabase/rollbacks/20261107120000_ai_action_logs_select_only.down.sql
-- #2283 判断待ち 8 の Y2: AI 相談の提案の記録 (ai_action_logs) を、利用者 (authenticated) には読むだけにし、未認証 (anon) には何も許さない。
--
-- 背景:
--   ai_action_logs のポリシー "Users can manage actions in own sessions" (ベースライン 20251126124224_create_meal_planner_tables.sql。
--   本番のスナップショット supabase/baseline/prod_schema.sql の CREATE POLICY と同じ) は FOR の無い形 (= FOR ALL) で、
--   利用者が自分の相談の行を PostgREST から直接 INSERT / UPDATE / DELETE できた。提案の状態 (pending → approved → executed など。
--   src/lib/ai/consultation-action-lifecycle.ts の決まり) と結果 (result) はサーバーが実行の前後に書く値で、利用者が書き換えると、
--   実行していない提案を「実行できた」に見せる・実行済みの提案を pending に戻してもう一度実行させる、などができた。
--   権限 (GRANT) も、ベースライン (supabase/baseline/prod_table_acl.sql) のとおり anon・authenticated に全部付いていた
--   (TRUNCATE だけは 20261022190000_db_privilege_hardening.sql が anon / authenticated から外してある)。
--   前段の Y1 (#2290) で、アプリの書き込みはすべて service_role のクライアント (src/lib/ai/ai-action-log-writer.ts の
--   getAiActionLogWriter) に移した:
--     - 会話の続きの POST の自動実行 (src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts の
--       executeAndFinalizeAction): 行の作成と確定
--     - 実行の API (src/app/api/ai/consultation/actions/[actionId]/execute/route.ts): POST の実行中の印と書き戻し・DELETE の却下
--     - 書き戻し (src/lib/ai/consultation-action-log-writes.ts の writeBackAiActionLog)
--   画面 (Web)・モバイル (apps/mobile)・Edge Function (supabase/functions) は書かず、読むだけ
--   (tests/ai-action-logs-service-role-writes-2283.test.ts がソースから見張る)。読む経路 (会話の GET・実行の API の行の探索・
--   モバイルの読み込み直しの AIAdvisorSheet.tsx の select・アカウントの書き出し) は利用者のセッションのままで、SELECT は残す。
--   migration の関数・トリガーで ai_action_logs に書くものは無い。相談 (ai_consultation_sessions) を消したときの
--   ON DELETE CASCADE は外部キーの動作で、表の所有者の権限で動く (利用者の権限に依らない)。
--
-- 変更:
--   1. FOR ALL の "Users can manage actions in own sessions" を消し、SELECT だけの "Users can view actions in own sessions" に
--      作り直す。TO authenticated と USING の式 (自分の相談の行 = ai_consultation_sessions.user_id = auth.uid() を EXISTS で見る) は
--      ベースラインのまま。SELECT のポリシーは WITH CHECK を持てないので WITH CHECK は落とす。
--      これで ai_action_logs に INSERT / UPDATE / DELETE を許すポリシーが 1 本も無くなる。
--   2. authenticated から INSERT・UPDATE・DELETE・TRUNCATE を外す (TRUNCATE は 20261022190000 が外してあり、ここでは何も変わらない。
--      書き込みの権限をまとめて外す形にそろえる)。ポリシーを消すだけでも INSERT は 42501 になるが、UPDATE / DELETE は 0 行で
--      黙って終わる。権限を外すと INSERT・UPDATE・DELETE は 42501 (permission denied) で止まり、後で誰かが書き込みのポリシーを
--      足しても開かない (二重に閉じる)。SELECT・REFERENCES・TRIGGER・MAINTAIN は変えない。
--   3. anon からは全部の権限を外す (REVOKE ALL。SELECT も外す)。理由: anon に当たるポリシーはもともと 1 本も無く
--      (ポリシーは TO authenticated だけ)、RLS が有効なので anon の SELECT は常に 0 行で、anon が読める行は無い。
--      アプリにも未認証で ai_action_logs を読む経路は無い (どの読み取りも本人の確認のあとのセッション)。
--      使われない権限を残すと、後で誰かが TO public や TO anon のポリシーを足したときに、そのまま開いてしまう。
--      外したあと anon の SELECT は 0 行でなく 42501 になる。
--   4. service_role の権限は変えない (service_role は RLS を通らないので、サーバーの書き込みは今までどおり)。
--   5. 外したあとの状態を確かめ、違えば例外で止める (表の所有者が postgres でないなどで外せなかったときに、黙って穴を残さない。
--      20261022190000 と同じ考え方)。
--
-- 既存データへの影響: なし (ポリシーと権限だけの変更。行は消さない・変えない)。
-- ロック: DROP / CREATE POLICY は ai_action_logs に ACCESS EXCLUSIVE ロックを一瞬取る (行は読み直さない)。GRANT / REVOKE は
--   カタログ (pg_class.relacl) を書き換えるだけ。lock_timeout は他の migration と同じ 10 秒。
-- 冪等: DROP POLICY IF EXISTS (消す側と作る側の両方の名前) のあとに作り、REVOKE は持っていなくてもエラーにならないので、
--   2 回続けて適用してもエラーにならない。
-- 型 (database.types.ts) は RLS・GRANT を持たないので作り直さない。
-- 確認: tests/integration/rls/ai-action-logs-select-only-2283.test.ts (実 DB。権限・ポリシー・サーバーの書き込み・戻し口)
--       tests/integration/security/ai-action-execute-route-select-only-2283.test.ts (実 DB + next dev。実行の API の POST・DELETE)
--       tests/ai-action-logs-select-only-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

-- 1. ポリシーを SELECT だけにする
DROP POLICY IF EXISTS "Users can manage actions in own sessions" ON public.ai_action_logs;
DROP POLICY IF EXISTS "Users can view actions in own sessions" ON public.ai_action_logs;
CREATE POLICY "Users can view actions in own sessions" ON public.ai_action_logs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1 FROM public.ai_consultation_sessions WHERE ((ai_consultation_sessions.id = ai_action_logs.session_id) AND (ai_consultation_sessions.user_id = auth.uid())))));

-- 2. authenticated の書き込みの権限を外す (SELECT は残す)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.ai_action_logs FROM authenticated;

-- 3. anon からは全部の権限を外す
REVOKE ALL ON TABLE public.ai_action_logs FROM anon;

-- 5. 外したあとの状態を確かめる
DO $verify$
DECLARE
  v_left text[] := ARRAY[]::text[];
  v_priv text;
BEGIN
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
    IF pg_catalog.has_table_privilege('anon', 'public.ai_action_logs', v_priv) THEN
      v_left := v_left || ('anon ' || v_priv);
    END IF;
  END LOOP;
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF pg_catalog.has_table_privilege('authenticated', 'public.ai_action_logs', v_priv) THEN
      v_left := v_left || ('authenticated ' || v_priv);
    END IF;
  END LOOP;
  IF cardinality(v_left) > 0 THEN
    RAISE EXCEPTION 'ai_action_logs の権限を外せなかった: %', array_to_string(v_left, ', ');
  END IF;
  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.ai_action_logs', 'SELECT') THEN
    RAISE EXCEPTION 'ai_action_logs の authenticated の SELECT が無い (利用者が自分の提案の記録を読めなくなる)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'public.ai_action_logs'::regclass AND polcmd <> 'r') THEN
    RAISE EXCEPTION 'ai_action_logs に SELECT 以外のポリシーが残っている';
  END IF;
END
$verify$;
