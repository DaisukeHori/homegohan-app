-- rollback: 20261008110100_health_goals_value_trigger.sql
-- 戻すと、health_goals の target_value / current_value / goal_type に符号や形式の検査が無い元の状態に戻る
-- (負の目標値や、形式に合わない goal_type が DB に保存できるようになる)。緊急時の切り戻し専用。
--
-- 内容: この migration で足した検査トリガーと関数を外す。
--   旧版 (CHECK 制約方式。version 20261007160600 としてマージ前に用意していたもの) の 3 本の制約も、
--   残っていれば外す (本番には無いので、本番では何も起きない)。
--   health_goals_status_check は本番に元からあった制約なので、外さない。
--   トリガーと関数を外すだけで、health_goals の行は一切書き換えない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

DROP TRIGGER IF EXISTS trg_health_goals_validate_values ON public.health_goals;
DROP FUNCTION IF EXISTS public.health_goals_validate_values();

ALTER TABLE public.health_goals DROP CONSTRAINT IF EXISTS health_goals_target_value_positive;
ALTER TABLE public.health_goals DROP CONSTRAINT IF EXISTS health_goals_current_value_nonnegative;
ALTER TABLE public.health_goals DROP CONSTRAINT IF EXISTS health_goals_goal_type_format;
