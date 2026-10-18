-- rollback: 20261018060000_planner_badge_award_on_weekly_menu_completed.sql
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 週の献立の生成の完了で planner を付けるトリガーと、その関数を消す。
-- 付けた user_badges の行は消さない (獲得したバッジは取り上げない)。weekly_menu_requests の行も変えていないので、そのまま。
-- トリガーを消すと、状態の確認 (GET /api/ai/menu/weekly/status) とバッジの一覧 (GET /api/badges) の付与だけが残り、
-- 完了を読まない画面 (モバイルなど) の利用者にはバッジの一覧を開くまで付かなくなる点に注意する。
--
-- 何度流しても同じ結果になる (冪等)。
DROP TRIGGER IF EXISTS weekly_menu_requests_award_planner ON public.weekly_menu_requests;
DROP FUNCTION IF EXISTS public.award_planner_badge_on_weekly_menu_completed();
