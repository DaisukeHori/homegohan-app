-- rollback: 20261010110000_ai_quota_foundation.sql
-- AI の利用回数の記録の仕組み (#1177 / T26) を消す。戻すのは、この migration が足した関数 3 本とテーブル 2 つだけ。
-- 既存のテーブル・制約・データには、migration で一切触れていない。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - Web (src/lib/plan/entitlements.ts) と Edge Function (supabase/functions/_shared/quota.ts) は、
--     consume_ai_quota が失敗しても「記録して許可する」作りなので、この関数が無くなっても AI の利用は止まらない
--     (呼び出しのたびに「関数が無い」エラーがログに残るだけ)。先に Web / Edge のデプロイを戻しておくと、ログが汚れない。
--   - ai_usage_counters を消すと、それまでの計測結果 (誰がどれだけ AI を使ったか) が失われる。
--     残したいなら、先に中身を書き出す (service_role で SELECT * FROM public.ai_usage_counters)。
--   - ai_plan_limits を消すと、T40 で設定した上限値があれば、それも消える (この migration の時点では全部 NULL)。
--
-- (推奨) 計測だけを止めたい (テーブルは残す) なら、consume_ai_quota を何もしない関数に差し替える:
--   CREATE OR REPLACE FUNCTION public.consume_ai_quota(p_user_id UUID, p_feature TEXT)
--   RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path = ''
--   AS $$ SELECT pg_catalog.jsonb_build_object('allowed', true, 'remaining', NULL); $$;
--
-- 何度流しても同じ結果になる (冪等)。依存の順 (consume_ai_quota -> consume_ai_quota_at -> get_effective_plan -> テーブル) に消す。

DROP FUNCTION IF EXISTS public.consume_ai_quota(UUID, TEXT);
DROP FUNCTION IF EXISTS public.consume_ai_quota_at(UUID, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.get_effective_plan(UUID);

DROP TABLE IF EXISTS public.ai_usage_counters;
DROP TABLE IF EXISTS public.ai_plan_limits;
