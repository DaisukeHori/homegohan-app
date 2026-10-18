-- migration: 20261018050000_planner_badge_description_weekly_menu.sql
-- 戻し方: supabase/rollbacks/20261018050000_planner_badge_description_weekly_menu.down.sql
-- #1867 「計画上手」(planner) のバッジは、AI で週の献立を初めて作ったときにも付くようにした。説明 (badges.description) をそれに合わせる。
-- オーナーの選択 (2026-10-18 17 時台、選択式): 「取れる条件を足す」— AI で週の献立を初めて作ったときにも付くようにし、説明もそれに合わせる。
--
-- 背景:
--   これまで planner を付けるのは POST /api/menu-plans/add の awardBadge だけで、それを呼ぶのは使い方ガイド (ハンズオンツアー) の
--   お試しの献立の追加だけだった。説明は 20261018040000_badges_description_matches_award.sql でそれに合わせ
--   「使い方ガイドで、お試しの献立を追加しました。…」にしたが、ガイドを終えた人・スキップした人は一覧に出ていても取れなかった。
--   この変更で、AI の週の献立の生成 (POST /api/ai/menu/weekly/request) が成功して献立を保存した (行が completed になった) ときにも付ける:
--     - 状態の確認 (GET /api/ai/menu/weekly/status) が、週の献立の生成の行 (generated_data の印 weeklyRequest: true) の完了を読んだとき
--     - バッジの一覧 (GET /api/badges) を開いたとき、planner が未獲得で、完了した週の献立の生成の行があれば
--   (印は src/lib/ai/weekly-menu-request-origin.ts。お試しの献立の追加での付与は今までどおり)
--
-- 変更:
--   planner の description だけを書き換える (WHERE code = 'planner')。name・condition_json・icon・metric_code・priority・id は変えない。
--   DDL は無い (列を変えないので src/types/database.types.ts も変わらない)。
--   文は 2 つの付く条件をそのまま言う。回数を約束する語・効果の主張は書かない。
--
-- 何度流しても同じ結果になる (冪等)。行が無い DB では何もしない。

UPDATE public.badges
   SET description = 'AIで1週間の献立をはじめて作りました。使い方ガイドのお試しでも付きます。'
 WHERE code = 'planner';
