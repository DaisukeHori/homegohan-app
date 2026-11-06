-- migration: 20261106120000_ai_consultation_sessions_status_closed.sql
-- 戻し方: supabase/rollbacks/20261106120000_ai_consultation_sessions_status_closed.down.sql
-- #2283 V2: AI 相談 (ai_consultation_sessions) の状態の制約 ai_consultation_sessions_status_check に closed を足す。
--
-- 背景:
--   「相談を終了」(POST /api/ai/consultation/sessions/[sessionId]/close。src/app/api/ai/consultation/sessions/[sessionId]/close/route.ts) は
--   相談の行を status = 'closed' に書き換える。状態の制約 (本番のスナップショット supabase/baseline/prod_schema.sql と同じ) は
--   'active'・'completed'・'archived' しか許さず、closed が無かった。そのため書き換えが 23514 で失敗し、閉じる route は 500 を返していた
--   (本番で「相談を終了」が成功した行は無い)。閉じた相談の要約を次の相談へ引き継ぐ読み取り
--   (src/app/api/ai/consultation/sessions/route.ts と src/app/api/ai/consultation/sessions/[sessionId]/messages/route.ts の
--   .eq('status', 'closed')) も、closed の行が無いので常に空だった。
--
-- 変更 (表の行・列・既定値・権限 (GRANT)・ポリシーには触れない):
--   制約 ai_consultation_sessions_status_check を、今までの 3 つ (active・completed・archived) に closed を足した 4 つで作り直す。
--   今までの値は消さない (残っている行が制約に合わなくならないよう残す)。
--   コードが書く状態 (閉じる route の 'closed'・列の既定値の 'active') がこの一覧に入っていることは
--   tests/ai-consultation-sessions-status-closed-migration-contract.test.ts が見張る。
--
-- 既存データへの影響: 行は書き換えない。新しい一覧は今までの一覧を全部含むので、既存の行はどれも合う。
-- ロック: DROP / ADD CONSTRAINT は ai_consultation_sessions に ACCESS EXCLUSIVE ロックを一瞬取る。NOT VALID で足してから VALIDATE で
--   既存の行を確かめる (VALIDATE は SHARE UPDATE EXCLUSIVE で、書き込みを止めない)。lock_timeout は他の migration と同じ 10 秒。
-- 冪等: DROP CONSTRAINT IF EXISTS のあとに作るので、2 回続けて適用してもエラーにならない。
-- 型 (database.types.ts) は CHECK 制約を持たないので作り直さない。
-- 確認: tests/integration/rls/ai-consultation-sessions-status-closed.test.ts (実 DB)
--       tests/ai-consultation-sessions-status-closed-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.ai_consultation_sessions DROP CONSTRAINT IF EXISTS ai_consultation_sessions_status_check;

ALTER TABLE public.ai_consultation_sessions
  ADD CONSTRAINT ai_consultation_sessions_status_check CHECK (status = ANY (ARRAY[
    'active'::text,
    'completed'::text,
    'archived'::text,
    'closed'::text
  ])) NOT VALID;

ALTER TABLE public.ai_consultation_sessions VALIDATE CONSTRAINT ai_consultation_sessions_status_check;
