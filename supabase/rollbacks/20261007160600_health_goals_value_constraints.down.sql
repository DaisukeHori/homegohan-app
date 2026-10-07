-- rollback: 20261007160600_health_goals_value_constraints.sql
-- 戻すと、health_goals の target_value / current_value / goal_type に符号や形式の制約が無い元の状態に戻る
-- (負の目標値や、形式に合わない goal_type が DB に保存できるようになる)。緊急時の切り戻し専用。
--
-- 内容: この migration で足した 3 本の CHECK 制約を外す。
--   health_goals_status_check は本番に元からあった制約なので、外さない。
--   (この migration の 1 本目は「無い環境にだけ足す」ものだったため、戻しても本番の状態は変わらない)
--   制約を外すだけで、health_goals の行は一切書き換えない。
-- 本番への適用: 本番への直接 SQL は禁止 (CLAUDE.md)。この内容を新しい migration として
--       supabase/migrations に追加し、PR → main マージ → CI で適用する。

ALTER TABLE public.health_goals DROP CONSTRAINT IF EXISTS health_goals_target_value_positive;
ALTER TABLE public.health_goals DROP CONSTRAINT IF EXISTS health_goals_current_value_nonnegative;
ALTER TABLE public.health_goals DROP CONSTRAINT IF EXISTS health_goals_goal_type_format;
