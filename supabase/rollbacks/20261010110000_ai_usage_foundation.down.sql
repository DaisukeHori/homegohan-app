-- rollback: 20261010110000_ai_usage_foundation.sql
-- AI の利用回数の記録の仕組み (#1177 / T26) を消す。戻すのは、この migration が足した関数 3 本とテーブル 1 つだけ。
-- 既存のテーブル・制約・データには、migration で一切触れていない。
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - Web (src/lib/plan/entitlements.ts) と Edge Function (supabase/functions/_shared/ai-usage.ts) は、
--     record_ai_usage が失敗しても「ログに残して先へ進む」作りなので、この関数が無くなっても AI の利用は止まらない
--     (呼び出しのたびに「関数が無い」エラーがログに残るだけ)。先に Web / Edge のデプロイを戻しておくと、ログが汚れない。
--   - ai_usage_counters を消すと、それまでの記録 (誰がどれだけ AI を使ったか) が失われる。
--     残したいなら、先に中身を書き出す (service_role で SELECT * FROM public.ai_usage_counters)。
--
-- (推奨) 記録だけを止めたい (テーブルは残す) なら、record_ai_usage を何もしない関数に差し替える:
--   CREATE OR REPLACE FUNCTION public.record_ai_usage(p_user_id UUID, p_feature TEXT)
--   RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
--   AS $$ BEGIN END $$;
--
-- 何度流しても同じ結果になる (冪等)。依存の順 (record_ai_usage -> record_ai_usage_at -> get_effective_plan -> テーブル) に消す。

DROP FUNCTION IF EXISTS public.record_ai_usage(UUID, TEXT);
DROP FUNCTION IF EXISTS public.record_ai_usage_at(UUID, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.get_effective_plan(UUID);

DROP TABLE IF EXISTS public.ai_usage_counters;
