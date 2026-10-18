-- rollback: 20261018050000_planner_badge_description_weekly_menu.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- planner の description を、この migration の前の文 (20261018040000_badges_description_matches_award.sql の文) に戻す。
-- name・condition_json・icon・metric_code・priority・id には触れない。
-- 付与の経路 (AI の週の献立の生成でも付く) は戻らないので、説明だけを戻すと、説明が付く条件の一部しか言わなくなる点に注意する。
--
-- 何度流しても同じ結果になる (冪等)。

UPDATE public.badges
   SET description = '使い方ガイドで、お試しの献立を追加しました。献立づくりの練習はばっちりです。'
 WHERE code = 'planner';
