-- rollback: 20261016241000_family_menu_view_functions.sql
-- 関数 2 本を消す (#1584 の 1)。表・列・ポリシー・データは migration が変えていないので、何も戻さない。
-- 消すと GET /api/family/menu は 500 (RPC_FAILED) になり、週間献立の画面は家族の行の場所にエラーの注記を出す
-- (自分の献立は影響を受けない)。戻す前に段 B の画面の配線を外すか、段 A ごと戻す。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
-- 何度流しても同じ結果になる (DROP ... IF EXISTS)。

DROP FUNCTION IF EXISTS public.family_menu_planned_meals(date, date);
DROP FUNCTION IF EXISTS public.family_menu_visible_members();
