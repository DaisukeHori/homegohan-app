-- migration: 20261018040000_badges_description_matches_award.sql
-- 戻し方: supabase/rollbacks/20261018040000_badges_description_matches_award.down.sql
-- #1867 アプリの中のバッジの説明 (badges.description) を、実際に付く条件に合わせる (設計 docs/design/marketing/01-landing-site.md §24 Q-13)。
-- オーナーの指示 (2026-10-18 13 時台) 逐語:「バッジの説明も直していいよ」
--
-- 背景 (説明が付く条件と食い違っていた):
--   バッジの一覧 (src/app/(main)/badges/page.tsx) は、未獲得のバッジの説明を「取り方」として見せる。説明が条件と違うと、書いてあるとおりにしても付かない。
--   - photo_10 (カメラマン): 説明は「写真を10枚撮影しました…」だが、GET /api/badges は写真を数えず、完了した食事が 10 食で付ける
--     (src/app/api/badges/route.ts の `badge.code === 'photo_10' && mealCount >= 10`)。
--   - planner (計画上手): 説明は「1週間の献立を作成しました…」だが、付けるのは POST /api/menu-plans/add の awardBadge だけで、
--     それを呼ぶのは使い方ガイド (ハンズオンツアー) のお試しの献立の追加だけ (src/app/handson-tour/menu/page.tsx・
--     src/components/ai-assistant/V4GenerateModal.tsx と apps/mobile/src/components/menu/V4GenerateModal.tsx の sandbox の経路)。
--     AI の週の献立の生成 (/api/ai/menu/weekly/request) では付かない。
--   - first_bite / streak_3 / streak_7: 説明は「記録しました」だが、数えるのは「完了」にした食事 (planned_meals.is_completed = true。
--     お試しの記録 is_sandbox は除く) と、完了した食事のある日の連続日数だけ。食事の記録の画面で写真から保存した食事は未完了で作られる
--     (src/app/api/meal-plans/add-from-photo/route.ts の is_completed: false) ので、「記録」しただけでは付かない。
--
-- 変更:
--   上の 5 行の description だけを書き換える (WHERE code = ...)。name・condition_json・icon・metric_code・priority・id は変えない。
--   DDL は無い (列を変えないので src/types/database.types.ts も変わらない)。
--   文は元の説明と同じ語調・長さで、付く条件をそのまま言う。回数を約束する語・効果の主張は書かない。
--   アプリの中の「完了」の操作 (ホームと献立表の完了の印・食事の詳細の「食べた！」) に合わせて「完了」と書く (紹介ページ src/components/marketing/landing-copy.ts の書き方と同じ)。
--
-- 変えないもの (付く条件と食い違っていない、または付く経路が無いもの):
--   - tutorial_complete: complete_handson_tour() が、使い方ガイド (アプリの中でもこの名前で呼ぶ) の卒業の画面でだけ付ける。説明の「使い方ガイド完走」と合う。
--   - segment_* / improved_* / *_champion: calculate-segment-stats の判定 (順位・上位の割合・平均との差・前の期間からの改善率) と説明が合う。
--   - health_streak_* / early_bird / night_guard / veggie_5 / protein_5 / balance_king / chef_soul / rainbow / hello_ai / legend_100 / streak_30 /
--     weight_goal_achieved / first_blood_test / challenge_completed: 付ける処理が無く (src/lib/badges/awardable.ts の一覧の外)、未獲得のうちは一覧に出ない。
--
-- 何度流しても同じ結果になる (冪等)。行が無い DB では何もしない。

UPDATE public.badges
   SET description = 'はじめて食事を「完了」にしました。新しい習慣の第一歩です！'
 WHERE code = 'first_bite';

UPDATE public.badges
   SET description = '3日連続で食事を「完了」にしました。三日坊主は卒業です。'
 WHERE code = 'streak_3';

UPDATE public.badges
   SET description = '1週間連続で食事を「完了」にしました。素晴らしい継続力です！'
 WHERE code = 'streak_7';

UPDATE public.badges
   SET description = '食事を10食「完了」にしました。毎日の食卓が積み重なってきました。'
 WHERE code = 'photo_10';

UPDATE public.badges
   SET description = '使い方ガイドで、お試しの献立を追加しました。献立づくりの練習はばっちりです。'
 WHERE code = 'planner';
