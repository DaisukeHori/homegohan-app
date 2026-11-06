-- rollback: 20261107120000_ai_action_logs_select_only.sql
-- #2283 判断待ち 8 の Y2 の戻し口 (このファイルは supabase/rollbacks/20261107120000_ai_action_logs_select_only.down.sql。1 行目は対の migration の名前)。
-- AI 相談の提案の記録 (ai_action_logs) のポリシーと権限を、本冊の直前の形に戻す:
--   ポリシー: SELECT だけの "Users can view actions in own sessions" を消し、FOR ALL の "Users can manage actions in own sessions" を
--     ベースライン (20251126124224_create_meal_planner_tables.sql。supabase/baseline/prod_schema.sql の CREATE POLICY と同じ) の形に
--     作り直す (名前・TO authenticated・USING と WITH CHECK の式はそのまま)。
--   権限: 本冊の直前に持っていた権限だけを付け直す:
--     authenticated: INSERT・UPDATE・DELETE (SELECT・REFERENCES・TRIGGER・MAINTAIN は本冊が外していない)
--     anon: SELECT・INSERT・UPDATE・DELETE・REFERENCES・TRIGGER・MAINTAIN (本冊が REVOKE ALL で外したもの)
--   TRUNCATE は付け直さない: 本冊の適用の直前の時点で、20261022190000_db_privilege_hardening.sql が anon / authenticated から
--   外してある (20261022190000 より後の戻し口の規律: TRUNCATE / ALL を付け直さない)。service_role の権限には触れない。
-- (tests/integration/rls/ai-action-logs-select-only-2283.test.ts が、戻し口を 1 つのトランザクションで流して巻き戻し、
--  流した直後の状態が本冊の直前の状態と同じことを見る)
--
-- 影響:
--   - 戻すと、利用者が自分の相談の提案の記録を PostgREST から直接書き換えられる穴が再び開く (状態・結果を書き換えて、実行していない
--     提案を「実行できた」に見せる・実行済みの提案をもう一度実行させる)。
--   - アプリ (Y1 #2290 で書き込みはすべて service_role のクライアント) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--     ただし Y1 より前のアプリ (利用者のセッションで書く) に戻すときは、先にこの戻し口を当てる (逆の順だと、その間の書き込みが 42501 になる)。
--   - 行は消さない・変えない。
--
-- 冪等: 作り直す前に DROP POLICY IF EXISTS (両方の名前) する。GRANT は何度流しても同じ。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。

SET LOCAL lock_timeout = '10s';

GRANT INSERT, UPDATE, DELETE ON TABLE public.ai_action_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.ai_action_logs TO anon;

DROP POLICY IF EXISTS "Users can view actions in own sessions" ON public.ai_action_logs;
DROP POLICY IF EXISTS "Users can manage actions in own sessions" ON public.ai_action_logs;
CREATE POLICY "Users can manage actions in own sessions" ON public.ai_action_logs TO authenticated USING ((EXISTS ( SELECT 1 FROM public.ai_consultation_sessions WHERE ((ai_consultation_sessions.id = ai_action_logs.session_id) AND (ai_consultation_sessions.user_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1 FROM public.ai_consultation_sessions WHERE ((ai_consultation_sessions.id = ai_action_logs.session_id) AND (ai_consultation_sessions.user_id = auth.uid())))));
