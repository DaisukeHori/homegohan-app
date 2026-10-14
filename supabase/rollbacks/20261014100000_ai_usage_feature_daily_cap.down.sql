-- rollback: 20261014100000_ai_usage_feature_daily_cap.sql
-- 究極モードの 1 日の上限 (#1142) の DB 関数を消す。戻すのは、この migration が足した関数 2 本だけ。
-- ai_usage_counters・consume_ai_usage・consume_ai_usage_at・refund_ai_usage には触れない。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - Web (src/lib/plan/entitlements.ts の consumeAiUsage) と Edge Function (supabase/functions/_shared/ai-usage.ts の
--     consumeEdgeAiUsage) は、consume_ai_usage_capped が失敗しても「ログに残して許可する」作りなので、関数が無くなっても
--     AI の利用は止まらない。ただし究極モードは、1 日 1 回の上限も、1 日の AI の上限 (10 回) への記録も効かなくなる
--     (呼び出しのたびに「関数が無い」エラーがログに残る)。
--     先に Web / Edge のデプロイを戻す (究極モードを menu_generation で数える版に戻す) と、記録が途切れない。
--   - 記録 (ai_usage_counters の 'menu_generation_ultimate' の行) は消さない (1 日の上限の合計にはそのまま入る)。
--
-- 何度流しても同じ結果になる (冪等)。依存の順 (consume_ai_usage_capped -> consume_ai_usage_capped_at) に消す。

DROP FUNCTION IF EXISTS public.consume_ai_usage_capped(UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.consume_ai_usage_capped_at(UUID, TEXT, INTEGER, TIMESTAMPTZ);
