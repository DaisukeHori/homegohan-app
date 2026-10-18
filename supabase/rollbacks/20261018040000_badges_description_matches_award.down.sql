-- rollback: 20261018040000_badges_description_matches_award.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 5 つのバッジの description を、元の文 (supabase/migrations/20251126124224_create_meal_planner_tables.sql の INSERT と同じ文) に戻す。
-- name・condition_json・icon・metric_code・priority・id には触れない。
--
-- 何度流しても同じ結果になる (冪等)。

UPDATE public.badges
   SET description = 'はじめて食事を記録しました。新しい習慣の第一歩です！'
 WHERE code = 'first_bite';

UPDATE public.badges
   SET description = '3日連続で記録しました。三日坊主は卒業です。'
 WHERE code = 'streak_3';

UPDATE public.badges
   SET description = '1週間連続で記録しました。素晴らしい継続力です！'
 WHERE code = 'streak_7';

UPDATE public.badges
   SET description = '写真を10枚撮影しました。食卓のアルバムができてきました。'
 WHERE code = 'photo_10';

UPDATE public.badges
   SET description = '1週間の献立を作成しました。計画的な食生活の始まりです。'
 WHERE code = 'planner';
