-- rollback: 20261011020000_ai_daily_limits.sql
-- AI の 1 日の上限 (#1149 / T40) を消す。戻すのは、この migration が足した関数 3 本とテーブル 1 つだけ。
-- ai_usage_counters (#1177 の記録) と record_ai_usage・get_effective_plan には触れない。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - Web (src/lib/plan/entitlements.ts の consumeAiUsage) と Edge Function (supabase/functions/_shared/ai-usage.ts の
--     consumeEdgeAiUsage) は、consume_ai_usage が失敗しても「ログに残して許可する」作りなので、関数が無くなっても AI の利用は止まらない
--     (上限が効かなくなり、呼び出しのたびに「関数が無い」エラーがログに残る。回数の記録も止まる)。
--     先に Web / Edge のデプロイを戻す (record_ai_usage を呼ぶ版に戻す) と、記録が途切れない。
--   - ai_daily_limits を消すと、運営画面で保存した上限の値が失われる。残したいなら、先に中身を書き出す
--     (service_role で SELECT * FROM public.ai_daily_limits)。
--
-- (推奨) 上限だけを外したい (記録は続ける) なら、関数は残して、上限を無制限にする:
--   UPDATE public.ai_daily_limits SET daily_limit = NULL;   -- 全プランを無制限 (運営画面からも同じことができる)
--
-- 何度流しても同じ結果になる (冪等)。依存の順 (consume_ai_usage -> consume_ai_usage_at -> refund_ai_usage -> テーブル) に消す。

DROP FUNCTION IF EXISTS public.consume_ai_usage(UUID, TEXT);
DROP FUNCTION IF EXISTS public.consume_ai_usage_at(UUID, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.refund_ai_usage(UUID, TEXT, DATE);

DROP TABLE IF EXISTS public.ai_daily_limits;
