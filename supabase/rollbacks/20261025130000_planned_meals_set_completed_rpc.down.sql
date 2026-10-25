-- rollback: 20261025130000_planned_meals_set_completed_rpc.sql
-- #2025 (1/2) で足した、献立の「食べた」を切り替える SECURITY DEFINER の関数 planned_meals_set_completed(uuid, boolean) を消す。
-- 表・ポリシー・権限・行には触れていないので、戻すのは関数だけ。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、アプリの完了の切り替え (hook・route・AI 相談) は RPC が無いので失敗する (PostgREST の PGRST202)。
--     先に 2/2 (20261026010000_planned_meals_score_columns_server_only.sql) を戻し、アプリを直接 UPDATE する版に戻してから流す。
--
-- 何度流しても同じ結果になる (冪等: DROP FUNCTION IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.planned_meals_set_completed(uuid, boolean);
