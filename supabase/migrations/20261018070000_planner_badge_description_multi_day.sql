-- migration: 20261018070000_planner_badge_description_multi_day.sql
-- 戻し方: supabase/rollbacks/20261018070000_planner_badge_description_multi_day.down.sql
-- #1867 「計画上手」(planner) を、AI で複数の日の献立をまとめて作ったとき (1 週間に満たなくても) にも付くようにした。説明 (badges.description) をそれに合わせる。
-- オーナーの選択 (2026-10-18 21 時台、選択式): 週の途中に「空欄を埋める」で今週の残りを AI で作ったとき (7 日未満) も、「計画上手」を「付ける」。
-- AI の献立の画面 (空欄を埋める・期間を指定) で複数の日の献立を初めて作ったら付け、説明もそれに合わせる。
--
-- 背景:
--   20261018050000_planner_badge_description_weekly_menu.sql の時点では、AI の生成で planner の印 (generated_data の weeklyRequest: true) を
--   書くのは、対象の枠が 1 週間 (異なる日付が 7 日以上) を覆うときだけで、説明は「AIで1週間の献立をはじめて作りました。…」だった。
--   そのため、AI献立アシスタント (V4GenerateModal) の「空欄を埋める」「AI献立だけ変更」(今日から週の終わりまで)・「期間を指定」
--   (既定は週の終わりまで) では、週の途中だと 7 日未満になり付かなかった。
--   この変更で、印を書く条件を「異なる日付が 2 日以上」(src/lib/ai/weekly-menu-request-origin.ts の MULTI_DAY_MENU_GENERATION_MIN_DAYS) にした。
--   1 日分 (1 日の改善)・1 食分の生成では、今までどおり付けない。印を書く経路 (POST /api/ai/menu/v4/generate・/v5/generate・
--   AI 相談の 1 週間分の生成・POST /api/ai/menu/weekly/request) は変えない。
--   付ける側 (DB のトリガー weekly_menu_requests_award_planner (20261018060000)・保険の状態の確認とバッジの一覧) は印だけを見るので変えない
--   (トリガーの関数は行の status と印だけで決め、何日分かを見ない)。お試しの献立の追加での付与も今までどおり。
--
-- 変更:
--   planner の description だけを書き換える (WHERE code = 'planner')。name・condition_json・icon・metric_code・priority・id は変えない。
--   DDL は無い (列を変えないので src/types/database.types.ts も変わらない)。
--   文は 2 つの付く条件 (AI で複数の日の献立をまとめて作る・使い方ガイドのお試し) をそのまま言う。回数を約束する語・効果の主張は書かない。
--
-- 何度流しても同じ結果になる (冪等)。行が無い DB では何もしない。

UPDATE public.badges
   SET description = 'AIで複数の日の献立をはじめてまとめて作りました。使い方ガイドのお試しでも付きます。'
 WHERE code = 'planner';
