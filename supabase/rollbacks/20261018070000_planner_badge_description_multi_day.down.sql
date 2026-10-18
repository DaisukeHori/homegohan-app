-- rollback: 20261018070000_planner_badge_description_multi_day.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- planner の description を、この migration の前の文 (20261018050000_planner_badge_description_weekly_menu.sql の文) に戻す。
-- name・condition_json・icon・metric_code・priority・id には触れない。
-- 付与の条件 (AI で 2 日分以上をまとめて作ったときに印を書く) は戻らないので、説明だけを戻すと、説明 (1 週間) が付く条件より狭くなる点に注意する。
--
-- 何度流しても同じ結果になる (冪等)。

UPDATE public.badges
   SET description = 'AIで1週間の献立をはじめて作りました。使い方ガイドのお試しでも付きます。'
 WHERE code = 'planner';
