-- rollback: 20261011110000_llm_usage_summary.sql
-- #1498 で足した public.llm_usage_summary(...) を消す。表のデータには触れない。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - GET /api/super-admin/llm/usage (src/app/api/super-admin/llm/usage/route.ts) は、この関数で集計する。
--     先に、この関数を呼ばない版の Web をデプロイしてから戻すこと。
--     先に関数だけを消すと、LLM 使用量の画面 (/super-admin/llm・/super-admin/llm/[provider]) が
--     「関数が無い」(PGRST202) で毎回 500 になる (失敗は黙らず、記録される)。
--
-- 何度流しても同じ結果になる (DROP FUNCTION IF EXISTS)。

DROP FUNCTION IF EXISTS public.llm_usage_summary(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, INTEGER, INTEGER);
