-- rollback: 20261107140000_ai_action_logs_claim_token.sql
-- #2299 の B の前段 W2a の戻し口 (このファイルは supabase/rollbacks/20261107140000_ai_action_logs_claim_token.down.sql。1 行目は対の migration の名前)。
-- AI 相談の提案の記録 (ai_action_logs) から、本冊が足した claim_token の列を消す (列のコメントも一緒に消える)。
-- 権限・ポリシーには触れない (本冊も触れていない)。
-- (tests/integration/rls/ai-action-logs-claim-token-2299.test.ts が、戻し口を 1 つのトランザクションで流して巻き戻し、
--  流した直後に列が無いことを見る)
--
-- 影響:
--   - 列の値 (claim のたびに付けた token) は消える。ほかの列・行は変わらない。
--   - 後段の W2b (claim_token を書く・書き戻しを claim_token で絞るコード) が入ったあとに戻すときは、先にアプリを W2b より前に戻す
--     (逆の順だと、その間の claim と書き戻しが「列が無い」で失敗する)。W2b より前のアプリはこの列を読まない・書かないので、
--     戻しても戻さなくても動く。
--
-- 冪等: DROP COLUMN IF EXISTS は何度流してもエラーにならない。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。

SET LOCAL lock_timeout = '10s';

ALTER TABLE public.ai_action_logs DROP COLUMN IF EXISTS claim_token;
