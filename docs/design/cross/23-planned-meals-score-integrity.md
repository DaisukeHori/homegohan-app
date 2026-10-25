# 比較ランキングと組織のチャレンジの値 (planned_meals の veg_score・is_completed・completed_at) をサーバの計算値だけにする (#2025) 設計

| 版 | 日付 | 内容 |
|---|---|---|
| v1.0 | 2026-10-25 | 新設 (Issue #2025 の設計ゲート・A 型 4 相。`planned_meals` の `veg_score`・`is_completed`・`completed_at` を利用者 (authenticated) の INSERT / UPDATE の権限から外し、完了の操作は SECURITY DEFINER の RPC `planned_meals_set_completed` 1 本に、野菜スコアは写真の解析の Edge Function が service_role で書く 1 か所に寄せる) |

要件の正本は Issue #2025 の本文とコメント (2026-10-25 時点でコメントは無い)。本書はその上で決めた範囲と設計で、Issue と食い違ったら本書が正。
ファイル名は cross/23 (cross/ の既存は 01〜09・12・13a・13b・14〜22。10・11・13 は欠番)。

前提 (本書が従う条件):

- オーナーの選択 (2026-10-25・選択式): 「サーバの計算値だけ使う」。集計に使う値はサーバが計算した値だけにする。利用者の書き込みからこの列を外す (権限を外す migration)。migration の中身は、マージの前にオーナーへ確認する。
- 本番の DB には書き込まない (本書の事実は 2026-10-25 の SELECT だけ。§3.5)。
- ローンチ前で利用者はゼロ。正しい形にしてよい。本番の `planned_meals` は 748 行・`veg_score` は全行 NULL・`is_completed = true` は 6 行 (§3.5)。既存の行の値は変えない (移行の UPDATE は無い)。
- 前例に合わせる: #1999 (`20261024110000_health_streaks_user_writes_daily_record_only.sql`。利用者が書ける `health_streaks` の種類を `daily_record` だけに絞った。ファイル冒頭の見出しは #1917 と書いてあるが、作った commit `99584308d` は #1999) と、運営の直接の書き込みを閉じた `20261024140000_announcements_moderation_flags_select_only.sql` (ポリシーを SELECT だけにし、表の書き込みの権限を REVOKE して二重に閉じる) と、cross/02 §3.3 (service_role は Edge Function に限る)・§3.4 (TRUNCATE を付け直さない)・§4.1 (self-ownership)。
- `health_streaks` の 2 種類 (`meal_record` / `breakfast`) は #1999 で閉じてある。本書は `planned_meals` の 3 列だけを扱う。
- 範囲外 (新しい要求は発明しない。候補は §21): `planned_meals` の RLS ポリシー `Users can manage own planned meals` の式・DELETE の権限・ほかの列の値の検査 (トリガー `trg_planned_meals_validate_values` の対象の列)・`veg_score` を DB の CHECK やトリガーで範囲検査すること・写真から記録した食事 (`POST /api/meal-plans/add-from-photo`) に野菜スコアを付けること・比較ランキングの指標の意味の変更 (`nutrition_score` は尺度の定数に追随させるだけ)・組織のチャレンジの SQL (`update_org_challenge_progress`) の変更・モバイルの古いビルドを動かし続けること。

---

## 0. 外形固定と分冊判定 (相 1)

### 0.1 発注と決めること

発注 (Issue #2025): 比較ランキング (segment の集計 `calculate-segment-stats`) と組織のチャレンジ (`update_org_challenge_progress`) が指標に使う献立の値 `planned_meals.veg_score`・`is_completed` を、利用者が PostgREST から自分で好きな値に書き換えられる (RLS `Users can manage own planned meals` は FOR ALL で列を絞らず、表の INSERT / UPDATE の権限が authenticated にある)。`POST /api/ai/nutrition` は栄養素 4 つだけを検証し、`veg_score` は範囲を見ずに書く。#1999 の `health_streaks` と同じ型の問題。

本書が答えを出すこと:

| # | 決めること | 答え (§6) |
|---|---|---|
| 1 | 3 列 (`veg_score`・`is_completed`・`completed_at`) を書く経路の全列挙と、書き手ごとの client (利用者のセッションか、サーバ = route の service_role / Edge Function の service_role か) | §3.1 の 13 経路の表。利用者のセッションで書いている経路は 9 本 (モバイルのホーム・Web のホーム・食事の詳細 → `PATCH /api/meals/[id]`・献立表 → `PATCH /api/meal-plans/meals/[id]`・AI 相談の `complete_meal`・`POST /api/ai/nutrition` の 2 分岐・写真の解析の Edge Function (利用者の JWT で書いている)・新規作成 3 route の `is_completed: false`・週間生成の失敗時の復元) |
| 2 | `is_completed` は利用者が「食べた」を記録する操作そのもの。何をサーバの計算値と見るか | 完了の操作は本人の操作として残す。サーバの計算値 = **完了の時刻 `completed_at` (DB の `now()`) と、`is_completed` ⇄ `completed_at` の対の整合** (完了なら時刻あり・未完了なら NULL。利用者は時刻を偽れず、対を崩せない)。書く口は SECURITY DEFINER の RPC `planned_meals_set_completed(p_meal_id, p_completed)` の 1 本だけで、本人の行かどうかは関数の中で確かめる (§6.2)。集計側の別の検証 (将来の日付の完了を数えない等) は本書では足さない (§21 Q-2) |
| 3 | `veg_score` の計算の正本・範囲・型 | 正本 = 写真の解析の `nutrition-pipeline.ts` の `estimateVegetableScore` (料理の材料のうち野菜の g の合計 ÷ 120 g × 100 を四捨五入し 0〜100 に収める)。範囲 0〜100 の整数 (列は `integer`)。NULL = まだ計算していない。書くのは `analyze-meal-photo` の背景の処理 1 か所 (service_role・本人の行であることを確かめてから)。`POST /api/ai/nutrition` は `veg_score` を書かない (利用者の入力の分岐は利用者の値そのもの、AI の分岐は別のモデルの 1〜5 点で正本と尺度が違う) (§6.3) |
| 4 | 権限の外し方 (列の GRANT か、RLS の WITH CHECK か、トリガーか) | **列の権限**: 表の INSERT / UPDATE を anon / authenticated から REVOKE し、authenticated に 3 列を除く 56 列の INSERT (列) / UPDATE (列) を GRANT し直す。RLS のポリシー・SELECT・DELETE・service_role は変えない (§6.4・§5) |
| 5 | モバイルの古いビルドが直接書いていた場合に壊れないか (版の互換) | 古いビルドの完了の切り替えは 42501 で失敗し、既存の失敗時の処理 (楽観的更新を戻して読み直す) で画面は元に戻る。壊れるのはその操作だけで、ほかの画面は変わらない。ローンチ前で利用者はゼロなので、互換のための猶予は作らない (§6.5) |
| 6 | モジュラーモノリスの切り方・Zod の正典・エラー表・テスト | 共通の定数と RPC の名前は `packages/shared/src/planned-meals-integrity.ts` (Web・モバイル・テストが読む)。Web は `src/modules/planned-meals-integrity/` (`core.ts` = Zod・文言、`server.ts` = RPC の呼び出し)。Edge は `supabase/functions/_shared/veg-score.ts` (尺度と計算)。エラー表は §10。テストは §12 (§6.6) |
| 7 | 段分けと本番への当て方 (権限を外す migration は、書き手を付け替えた後にしか当てられない) | migration を 2 本に分ける。段 A = RPC を足す migration (追加だけ) + 共通の定数、段 B = 書き手の付け替え (Web・モバイル・Edge)、段 C = 権限を外す migration。段 C のマージの前にオーナーへ migration の中身を確認する (§15) |

### 0.2 要件行列

| # | 要件 | 根拠 | 本書の置き場 |
|---|---|---|---|
| R-1 | 利用者 (authenticated) のセッションは、PostgREST の INSERT / UPDATE / upsert のどれでも `planned_meals.veg_score`・`is_completed`・`completed_at` に値を入れられない (42501)。他の 56 列は今までどおり書ける | #2025・オーナーの選択 | §7.3・§7.20 |
| R-2 | 利用者は自分の献立を「食べた」「食べていない」に切り替えられる (Web のホーム・食事の詳細・献立表・モバイルのホーム・AI 相談)。切り替えの口は RPC `planned_meals_set_completed` 1 本で、`completed_at` は DB の `now()` (完了) か NULL (未完了)。すでに完了している行をもう一度完了にしても `completed_at` は変わらない | §0.1 の 2 | §7.1・§7.8〜§7.10・§7.14 |
| R-3 | 他人の献立・存在しない id・UUID の形でない id は `PLANNED_MEAL_NOT_FOUND` (route は 404 の固定の文)。未ログインは RPC を実行できない (42501) | cross/02 §4.1 | §7.1・§7.8・§10 |
| R-4 | `veg_score` は `estimateVegetableScore` の値 (0〜100 の整数) だけが入る。書くのは `analyze-meal-photo` の背景の処理で、service_role の client で、本人の行であることを確かめてから書く。他人の `mealId` を渡しても書かない | §0.1 の 3 | §7.6・§7.15・§7.16 |
| R-5 | `POST /api/ai/nutrition` は `veg_score` を書かない (利用者の `nutritionData.veg_score` は捨てる。AI の応答の `veg_score` も書かず、プロンプトからも外す)。栄養素 4 列・`quality_tags`・`dishes` などは今までどおり | §0.1 の 3 | §7.13 |
| R-6 | 新規作成の 3 route (`POST /api/meals`・`POST /api/meal-plans/meals`・`POST /api/meal-plans/add-from-photo`) は `is_completed` を送らない (DB の既定 false)。応答の `is_completed` は false のまま | R-1 の帰結 | §7.11 |
| R-7 | 週間生成の失敗時の復元 (`restorePlannedMealsSnapshot`) は、消した行の `is_completed`・`completed_at`・`veg_score` を落とさずに戻す (service_role の client で戻す。行は本人の RLS で読んだものだけ) | R-1 の帰結・#1042 | §7.12 |
| R-8 | 比較ランキングの `veg_score_avg` は 0〜100 の平均 (小数第 1 位)、`nutrition_score` は `veg_score_avg` を 0〜100 に正規化した整数 (尺度の定数から導く。0〜100 なら係数 1)。組織のチャレンジの `veg_score` (`targetMax` 100) と同じ尺度 | §0.1 の 3 | §7.6・§7.17・§13 |
| R-9 | service_role (Edge Function の献立の生成・保存・集計・運営) は今までどおり 3 列を読み書きできる | #1999 と同じ | §7.3・§7.20 |
| R-10 | RLS のポリシー・SELECT・DELETE・REFERENCES・TRIGGER の権限・既存のトリガー・既存の行は変えない。TRUNCATE を付け直さない (cross/02 §3.4) | 範囲・前例 | §7.3・§7.4 |
| R-11 | migration は 2 本とも戻し口を対で置き、冪等で、`lock_timeout` を持つ。段 A の migration は追加だけ (RPC の作成)。段 C の migration は権限だけ (行に触れない)。番号はマージの直前に確定する | 設計書の規約 | §7.1〜§7.4 |
| R-12 | `src/types/database.types.ts` と `packages/shared/src/database.types.ts` に RPC の型が入る (`tests/database-types-migrations-contract.test.ts`) | 既存の番兵 | §7.18・§16 |
| R-13 | 3 列を利用者のセッションで書く経路が src・apps/mobile に戻らないことを、ソース走査のテストが見張る。Edge の `analyze-meal-photo` の書き込みが service_role であることも見張る | 再発防止 | §7.21 |
| R-14 | 本文を読む route の 400 (壊れた JSON・NULL 文字) と 401・404・500 の既存の形を保つ。`is_completed` / `isCompleted` が boolean でない本文は 400 の固定の文 | #1657・#1917 | §7.9・§10 |
| R-15 | 文言・`data-testid`・応答の形 (`PATCH /api/meals/[id]` は行そのもの、`PATCH /api/meal-plans/meals/[id]` は `{ success, meal }`) は変えない。応答の `is_completed`・`completed_at` は RPC が返した値 | 既存の画面と e2e | §7.9 |
| R-16 | 本番への当て方: 段 A の migration → 段 B のデプロイ (Vercel・Edge) → 段 C の migration の順。段 C を先に当てると、古いコードの完了の切り替え・写真の上書きが 42501 で失敗する | §0.1 の 7 | §15・§19 |

### 0.3 ユーザーシナリオ (25 本。トレースは §4.3)

| # | シナリオ | 期待 |
|---|---|---|
| S-1 | Web のホームで今日の昼食の「食べた」を押す | `supabase.rpc('planned_meals_set_completed', { p_meal_id, p_completed: true })`。行は `is_completed = true`・`completed_at = now()` (DB の時刻)。画面は楽観的更新のまま |
| S-2 | S-1 の直後にもう一度押す (未完了に戻す) | RPC `p_completed: false`。`is_completed = false`・`completed_at = NULL` |
| S-3 | モバイル (本書の後のビルド) のホームで「食べた」を押す | S-1 と同じ RPC。`apps/mobile/src/hooks/useHomeData.ts` が `supabase.rpc` を呼ぶ |
| S-4 | モバイルの古いビルド (`.from('planned_meals').update({ is_completed, completed_at })`) で「食べた」を押す | PostgREST が 42501 (permission denied for table planned_meals)。既存の失敗時の処理で楽観的更新を戻し `fetchAll()` で読み直す。行は変わらない |
| S-5 | Web の食事の詳細 (`/meals/[id]`) で「食べた」を押す。画面は今までどおり `is_completed` と端末の時刻の `completed_at` を `PATCH /api/meals/[id]` に送る | route は `completed_at` を無視し、RPC で完了にする。応答の `completed_at` は DB の時刻。`allowedFields` から `is_completed`・`completed_at` は消えている |
| S-6 | 献立表 (`/menus/weekly`) で完了を切り替える (`PATCH /api/meal-plans/meals/[id]` に `isCompleted`) | route が RPC で切り替え、`meal` に RPC の値を載せて返す |
| S-7 | AI 相談で「昼食を食べたことにして」→ `complete_meal` | `runConsultationAction` が `setPlannedMealCompleted` (RPC) で切り替える。他人の id は `{ error: '権限がありません' }` のまま |
| S-8 | 利用者が PostgREST で自分の行の `veg_score` を 100 に UPDATE する | 42501。行は変わらない |
| S-9 | 利用者が PostgREST で `is_completed: true, veg_score: 100` を含む行を INSERT する (upsert も) | 42501。行はできない |
| S-10 | 利用者が PostgREST で自分の行の `dish_name`・`memo`・`calories_kcal` を UPDATE する。新しい行を 3 列なしで INSERT する | 今までどおり通る (他の 56 列の権限は残る)。`is_completed` は既定 false |
| S-11 | 写真の解析 (`analyze-meal-photo` を `mealId` つきで呼ぶ。本人の献立) | 背景の処理が service_role の client で本人の行であることを確かめ、`veg_score = estimateVegetableScore(...)` (0〜100) と栄養の列を書く |
| S-12 | 写真の解析を他人の `mealId` で呼ぶ | 本人の行として見つからないので書かない (例外を記録して終わる。今までは RLS で 0 行だった) |
| S-13 | `POST /api/ai/nutrition` に `nutritionData: { calories_kcal: 500, veg_score: 100 }` | 200。栄養素だけ書き `veg_score` は書かない (update の本文に `veg_score` の鍵が無い) |
| S-14 | `POST /api/ai/nutrition` に `imageUrl` (AI の推定) | AI の応答の栄養素・`quality_tags`・`dishes` を書き、`veg_score` は書かない。プロンプトに `veg_score` は無い |
| S-15 | `POST /api/meals` で献立を作る | insert の本文に `is_completed` が無い。応答の `is_completed` は false |
| S-16 | 週間の献立の生成を頼み、今日の朝食 (完了済み・写真のスコアつき) を含む 7 日分を消したあと生成が失敗する | 復元は service_role の client で行い、`is_completed = true`・`completed_at`・`veg_score` がそのまま戻る |
| S-17 | 比較ランキングの集計 (`calculate-segment-stats`) が `veg_score` 80・60 の 2 食を読む | `veg_score_avg = 70`・`nutrition_score = 70` (0〜100 の尺度。係数 1) |
| S-18 | 組織のチャレンジの日次の集計 (`update_org_challenge_progress`) | 変えない。`veg_score` の平均は 0〜100 の値をそのまま平均する (今までと同じ SQL) |
| S-19 | 未ログイン (anon) が RPC を呼ぶ | 42501 (EXECUTE が無い)。行は変わらない |
| S-20 | 他人の献立の id で RPC を呼ぶ | 例外 `PLANNED_MEAL_NOT_FOUND` (SQLSTATE P0002)。route は 404 の固定の文 (`MEAL_NOT_FOUND_MESSAGE`)。行は変わらない |
| S-21 | `PATCH /api/meals/[id]` に `is_completed: 'yes'` (boolean でない) | 400 `{ error: PLANNED_MEAL_COMPLETION_INVALID_MESSAGE }`。DB に触れない |
| S-22 | 段 C の migration の戻し口を流す | authenticated の列の権限を消し、anon / authenticated に表の INSERT / UPDATE を付け直す (本番のベースラインの形)。TRUNCATE は付けない |
| S-23 | 段 A の migration の戻し口を流す | 関数 `planned_meals_set_completed(uuid, boolean)` を消す。表・権限・行は変わらない |
| S-24 | すでに完了している行 (`completed_at` あり) に RPC `p_completed: true` | `is_completed = true` のまま、`completed_at` は元の値 (今の時刻で上書きしない) |
| S-25 | service_role (`save-meal.ts`) が `is_completed: false` で INSERT し、`generate-menu-v5` が `is_completed` を読む | 今までどおり通る (service_role の権限は変えない) |

### 0.4 分冊判定

目安 (設計書 800 行超 / 消費先レーン 3 以上 / 共有面 2 つ以上) のうち、行数と消費先 (Web の route と hook・モバイルの hook・Edge Function の 3 本) と共有面 (`planned_meals` の権限・`packages/shared`・`supabase/functions/_shared`) に当たる。ただし核 (migration 2 本・RPC・共通の定数) は 1 本の契約で閉じ、配線は「既存の書き手を RPC か service_role に付け替えるだけ」で判断の余地が無いので、**1 冊**にし、実装は段で分ける (§15: 段 A = RPC の migration と共通の定数、段 B = 書き手の付け替え、段 C = 権限の migration)。段ごとに 2 枚レビューを閉じ、段の間に本番への適用 (段 A の migration・段 B のデプロイ) を挟む。

### 0.5 用語

| 語 | 意味 |
|---|---|
| 3 列 | `planned_meals.veg_score` (野菜スコア・integer)・`is_completed` (食べた印・boolean DEFAULT false)・`completed_at` (食べた時刻・timestamptz) |
| 利用者のセッション | anon key + 利用者の JWT (Cookie か Authorization) の client。RLS と列の権限が効く。Web の `createClient()` (`lib/supabase/server.ts`・`lib/supabase/client.ts`)・モバイルの `supabase`・Edge Function が `Authorization` ヘッダを付けて作る client |
| service_role | RLS と列の権限を通らない client。Web の `getSupabaseAdmin()`・Edge Function の `SERVICE_ROLE_JWT` / `SUPABASE_SERVICE_ROLE_KEY` の client |
| 完了の RPC | `public.planned_meals_set_completed(p_meal_id uuid, p_completed boolean)`。SECURITY DEFINER。本人の行だけを完了 / 未完了にし、`completed_at` を DB の時刻で書く |
| 野菜スコアの正本 | `supabase/functions/_shared/nutrition-pipeline.ts` の `estimateVegetableScore` (本書で `_shared/veg-score.ts` の `vegScoreOfVegetableGrams` を使う形にする) |
| 尺度 | `VEG_SCORE_MIN = 0`・`VEG_SCORE_MAX = 100`・満点の野菜の量 `VEG_SCORE_FULL_MARK_GRAMS = 120` |

### 0.6 読み方

- 実装は §7 の正典コードを写す。§8 の facade 契約と §13 の定数の名前を変えない。
- 表 3 点 (§9) とエラー表 (§10) は、レビューが最初に自分で作り直して突き合わせる対象。
- migration のファイル名の番号は置き場 (`<番号はマージ時に確定>`・`<同じ番号>`) で書く。マージの直前に `origin/main` の `supabase/migrations` の最大より大きい番号で確定し、設計書の置き場を全部その番号に書き換える (`tests/helpers/design-doc-migration-number.ts` の規則。混ざると赤)。

---

## 1. 目的・スコープ

- 目的: 比較ランキングと組織のチャレンジが指標に使う `planned_meals` の 3 列を、利用者が PostgREST から直接書けない形にし、書く口をサーバの処理 (完了の RPC・写真の解析の service_role) に限る。
- 対象: `planned_meals` の INSERT / UPDATE の権限 (列単位)・完了の RPC・3 列を書く既存の経路の付け替え (Web の route 5 本と hook 1 本・モバイルの hook 1 本・AI 相談の 1 アクション・Edge Function 3 本)・野菜スコアの尺度の定数・比較ランキングの `nutrition_score` の係数・テスト。
- 対象外: 冒頭の前提の「範囲外」のとおり。

## 2. 関連要件・既存設計

| 文書 | 関係 |
|---|---|
| Issue #2025 | 要件の正本 (症状・根拠・オーナーの選択・進め方) |
| cross/02 §3.3・§3.4・§4.1・§10 | service_role の使い方 (Edge Function に限る。Next.js の route では `getSupabaseAdmin()` を所有権の確認の後にだけ使う)・TRUNCATE を付け直さない・self-ownership・RLS のテストの形 |
| `20261024110000_health_streaks_user_writes_daily_record_only.sql` (#1999) とそのテスト 2 本 | 同じ型の前例 (ポリシーで種類を絞る)。本書は列の権限で絞る (理由は §5) |
| `20261024140000_announcements_moderation_flags_select_only.sql` | 表の書き込みの権限を REVOKE する形・戻し口の書き方・同じ型の全域の探索の記録の書き方 |
| `20261022150000_family_invites_rpc_only_writes.sql`・`20261022180000_org_tables_rpc_only_writes.sql` | 書き込みを SECURITY DEFINER の RPC に限る形 |
| `20261008110000_planned_meals_value_checks.sql` (#1205) | `planned_meals` の既存のトリガー (`trg_planned_meals_validate_values`。`veg_score` は対象外のまま) |
| `20261014100100_org_challenge_progress.sql` (#1132) | 組織のチャレンジの集計 (`veg_score` の平均。変えない) |
| cross/22 | 設計書の形 (本書はこれに倣う) |

## 3. 現状の事実 (origin/main `03734bcd1`・本番の読み取り 2026-10-25)

### 3.1 3 列を書く経路 (13 経路。1 = 利用者のセッション・S = service_role)

| # | 経路 | 書く列 | client | file:line (origin/main) | 本書の後 |
|---|---|---|---|---|---|
| W-1 | モバイルのホームの完了の切り替え `toggleMealCompletion` | `is_completed`・`completed_at` | 利 | `apps/mobile/src/hooks/useHomeData.ts:661-662` (`.update({ is_completed, completed_at }).eq('id')`) | RPC (§7.14) |
| W-2 | Web のホームの完了の切り替え `toggleMealCompletion` | `is_completed`・`completed_at` | 利 (ブラウザの client) | `src/hooks/useHomeData.ts:930-936` | RPC (§7.14) |
| W-3 | Web の食事の詳細の `toggleCompletion` → `PATCH /api/meals/[id]` | `is_completed`・`completed_at` (本文から `allowedFields` で通す) | 利 (route の `createClient()`) | `src/app/(main)/meals/[id]/page.tsx:189-197` → `src/app/api/meals/[id]/route.ts:113-116` | route が RPC (§7.9) |
| W-4 | 献立表の `handleUpdateMeal(..., { isCompleted })` → `PATCH /api/meal-plans/meals/[id]` | `is_completed`・`completed_at` (`isCompleted` から) | 利 | `src/app/(main)/menus/weekly/page.tsx:2866` → `src/app/api/meal-plans/meals/[id]/route.ts:93-96` | route が RPC (§7.9) |
| W-5 | AI 相談の `complete_meal` | `is_completed` | 利 (`execute` / `messages` の route が `createClient()` を渡す) | `src/lib/ai/consultation-action-executor.ts:1032-1053` | RPC (§7.10) |
| W-6 | `POST /api/ai/nutrition` の `nutritionData` の分岐 | `veg_score` (`nutritionData.veg_score` を検証せずそのまま)・`quality_tags` | 利 | `src/app/api/ai/nutrition/route.ts:98-106` | `veg_score` を書かない (§7.13) |
| W-7 | `POST /api/ai/nutrition` の `imageUrl` の分岐 (fast LLM。プロンプトは `veg_score` 1〜5) | `veg_score` (`result.veg_score`) | 利 | `src/app/api/ai/nutrition/route.ts:149・213` | `veg_score` を書かない (§7.13) |
| W-8 | 写真の解析の背景の処理 `analyzeMealPhotoBackgroundTask` | `veg_score` (`result.vegScore` = 0〜100)・栄養の列・`dishes` など | **利** (anon key + 利用者の `Authorization` で作った client。`:172-176`。ジョブの取り消しだけ service_role `:233-236`) | `supabase/functions/analyze-meal-photo/index.ts:247-262` | service_role + 本人の行の確認 (§7.15) |
| W-9 | `POST /api/meals` (献立の作成) | `is_completed: false` | 利 | `src/app/api/meals/route.ts:240` | 送らない (§7.11) |
| W-10 | `POST /api/meal-plans/meals` | `is_completed: false` | 利 | `src/app/api/meal-plans/meals/route.ts:185` | 送らない (§7.11) |
| W-11 | `POST /api/meal-plans/add-from-photo` | `is_completed: false` | 利 | `src/app/api/meal-plans/add-from-photo/route.ts:178` | 送らない (§7.11) |
| W-12 | 週間生成の失敗時の復元 `restorePlannedMealsSnapshot` (`select('*')` の行をそのまま INSERT) | 3 列を含む全列 | 利 (`weekly/request/route.ts:110` の `createClient()` を `:312` で渡す) | `src/lib/planned-meals-snapshot.ts:147・160` | service_role で戻す (§7.12) |
| W-13 | 献立の生成と保存 (`generate-menu-v4` / `v5` → `_shared/save-meal.ts`) | `is_completed: false` の INSERT・`status` の判定で `is_completed` を読む | S | `supabase/functions/_shared/save-meal.ts:662・706・725`・`generate-menu-v5/index.ts:1862・1906・3481` | 変えない |

補足:
- `veg_score` を書く経路は W-6・W-7・W-8 の 3 本だけ。`save-meal.ts`・`meal-image.ts` (`writePlannedMealDishesWithOptimisticLock` は `dishes`・`image_url`・`updated_at` だけ)・`planned-meals-snapshot.ts` (写し) は `veg_score` を指定しない。モバイルの `apps/mobile/app/meals/new.tsx` の直接の INSERT (`20261008110000` のコメントが述べる) は origin/main に無い (#1598 で消えた)。
- `POST /api/ai/nutrition` を呼ぶ画面は src・apps/mobile に無い (route 自身の `internalError` の文だけ)。`tests/planned-meal-nutrient-validation-routes.test.ts`・`tests/ai-consent-enforcement-routes.test.ts` が route を直接呼ぶ。
- Web の写真の記録 (`src/app/(main)/meals/new/page.tsx`) は `POST /api/ai/analyze-meal-photo` (`mealId` 無し = 同期) の応答の `vegScore` を画面に出すだけで、保存 (`POST /api/meal-plans/add-from-photo`) には `veg_score` を渡さない。`mealId` つきで呼ぶ経路は src・apps/mobile に見つからなかった。本番の `veg_score` が全行 NULL なのと整合する。
- 読み手 (変えない): `supabase/functions/calculate-segment-stats/index.ts:349・386-394・416-425` (service_role。`veg_score_avg`・`nutrition_score = round(vegAvg × 20)`・`breakfast_rate`・`menu_execution_rate`)、`update_org_challenge_progress` (`20261014100100_org_challenge_progress.sql:155・174`。`avg(pm.veg_score)`)、`src/app/api/badges/route.ts:54-77`、`src/hooks/useHomeData.ts:573-585` (`veg_score` で並べる)、`apps/mobile/src/hooks/useHomeData.ts:386-410`、`src/lib/org-challenges.ts:53-62` (`targetMax: 100`。注釈に「写真の解析は 0〜100 点、AI の推定は 1〜5 点」)、`generate-menu-v4` / `v5` の `status: meal.is_completed ? "completed" : ...`、`src/lib/membership/family-menu.ts:147` (SECURITY DEFINER の `family_menu_planned_meals`)。

### 3.2 DB (`20251126124224_create_meal_planner_tables.sql`。本番と同じ)

- 表 `public.planned_meals` (`:5850-5910`)。59 列 (本番の `information_schema.columns` も 59)。3 列: `is_completed boolean DEFAULT false`・`completed_at timestamptz`・`veg_score integer`。所有者 (`user_id`) は無く、`daily_meal_id → user_daily_meals(user_id, day_date, is_sandbox)`。
- RLS: 有効 (FORCE は無し)。ポリシーは `Users can manage own planned meals` の 1 本 (`:9900`。FOR の無い形 = ALL・TO public・USING は `EXISTS (SELECT 1 FROM user_daily_meals WHERE id = planned_meals.daily_meal_id AND user_id = auth.uid())`・WITH CHECK 無し = USING と同じ)。本番の `pg_policies` も同じ (`roles = {public}`・`with_check = null`)。
- 権限 (`:13797-13800`): `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role` のあと、anon・authenticated・service_role に `INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN`。`20261022190000_db_privilege_hardening.sql` が anon / authenticated の TRUNCATE を外した。本番の `role_table_grants`: anon / authenticated = `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE`、service_role = それ + TRUNCATE。列単位の GRANT / REVOKE は無い (本番の `column_privileges` は表の権限の写し)。
- トリガー 3 本 (本番と同じ): `trg_fill_planned_meals_magnesium_mg` (BEFORE INSERT OR UPDATE)・`trg_planned_meals_updated_at` (BEFORE UPDATE)・`trg_planned_meals_validate_values` (BEFORE INSERT OR UPDATE OF meal_type, calories_kcal, protein_g, fat_g, carbs_g。SQLSTATE 23514。`veg_score` は対象外)。
- ベースラインより後に `planned_meals` の列・権限・ポリシーを変えた migration は無い (`ALTER TABLE ... planned_meals`・`GRANT|REVOKE ... planned_meals` は grep で 0 件。`20261016241000_family_menu_view_functions.sql` は関数の EXECUTE だけ)。
- 既存の SECURITY DEFINER の RPC の形 (本書が倣う): `20261022150000_family_invites_rpc_only_writes.sql` (SECURITY DEFINER・`SET search_path`・`REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated, service_role` → `GRANT EXECUTE ... TO` 必要な役割だけ。`tests/integration/security/anon-definer-execute.test.ts` の A1 が、anon が実行できる DEFINER 関数を許可一覧の 2 本に限る)。

### 3.3 Web・モバイル・Edge の client

- Web の route: `createClient()` (`lib/supabase/server.ts`。Cookie / Authorization を使う。RLS が効く) と `getSupabaseAdmin()` (service_role。`tests/supabase-service-role-client-scan.test.ts` が、これ以外の service_role の `createClient` を src・lib で禁じる)。Web のホーム: `lib/supabase/client.ts` の `createClient()` (ブラウザ)。
- モバイル: `apps/mobile/src/lib/supabase.ts` の `supabase` (anon key + 端末のセッション)。`.rpc()` を呼ぶ箇所は今は無い (supabase-js の `SupabaseClient` なので呼べる)。
- Edge: `analyze-meal-photo` は利用者の `Authorization` で client を作り、`analyzeWithEvidence` (dataset の検索) と Storage のアップロードと `planned_meals` の UPDATE に使う。service_role の client は `meal_image_jobs` の取り消しにだけ作る。`calculate-segment-stats`・`save-meal.ts`・`generate-menu-*` は service_role。
- `packages/shared` は zod を持たない (定数と純関数だけ)。Edge Function は `packages/shared` を import しない (`_shared/ai-chat-flag.ts` の注のとおり、同じ値を両方に置き、テストで一致を見る)。

### 3.4 既存のテストと番兵 (本書の変更に反応するもの。直し方は §16)

- 実 DB: `tests/integration/rls/planned-meals-value-checks.test.ts:576-609・683` (利用者が `is_completed` を直接 UPDATE)・`tests/integration/rls/stats-edge-functions-user-daily-meals.test.ts:148-150・382-383・594` (service_role で 3 列を seed。`nutrition_score` の期待値 80/60/40/20 は `veg_score` 4/3/2/1 × 20)・`org-challenge-progress.test.ts:211-212`・`org-challenge-diff-privacy.test.ts:306`・`security/badges-api.test.ts:126・150`・`security/support-routes.test.ts:119` (service_role で seed。影響なし)。
- 単体: `tests/calculate-segment-stats-planned-meals.test.ts:131-134・437-438・648-649・812` (`nutrition_score = veg × 20`)・`tests/planned-meal-nutrient-validation-routes.test.ts:527-531・548・564` (`veg_score` が update の本文に入ることを期待)・`tests/meal-image-skip-routes.test.ts:130-180・513・525` (route の偽物の DB に `rpc` が無い)・`tests/analyze-meal-photo-sugar.test.ts:430-454` (planned_meals の update が 1 か所で `veg_score` を手書きすること。本書の後も同じ)。
- 静的: `tests/migration-file-version-integrity.test.ts` (見出し・戻し口の対)・`tests/database-types-migrations-contract.test.ts` (新しい関数が型ファイル 2 本にあること)・`tests/db-privilege-hardening-migration-contract.test.ts` (後の migration と戻し口が利用者へ表の TRUNCATE / ALL を付けないこと)・`tests/operator-write-policy-ledger.test.ts` (運営ロールのポリシー。本書は触らない)・`tests/supabase-service-role-client-scan.test.ts`・`tests/env-source-scan.test.ts`・`tests/postgrest-embed-relationship-scan.test.ts` (src・lib の埋め込み。Edge は見ない)・`tests/edge-function-verify-jwt.test.ts` (config は変えない)。
- モバイル: `apps/mobile/__tests__/home/home.test.tsx` は `toggleMealCompletion` を jest.fn で差し替える (hook の中身は見ない)。

### 3.5 本番の読み取り (2026-10-25。Supabase MCP の SELECT だけ。書き込みなし)

| 項目 | 値 |
|---|---|
| `planned_meals` の行数 | 748 |
| `veg_score` が NULL でない行 | 0 (min / max / avg は null) |
| `is_completed = true` / `false` / NULL | 6 / 742 / 0 |
| ポリシー | `Users can manage own planned meals` (ALL・`{public}`・USING のみ) の 1 本 |
| 表の権限 | §3.2 のとおり (anon / authenticated に INSERT・UPDATE あり。TRUNCATE 無し) |
| 列の権限 (3 列) | anon / authenticated / postgres / service_role とも `INSERT, REFERENCES, SELECT, UPDATE` (表の権限の写し。列単位の設定は無い) |
| トリガー | §3.2 の 3 本 |
| 列数 | 59 (ベースラインの CREATE TABLE と同じ並び) |

---

## 4. 構想 (相 2)

### 4.1 構造 (構造 A: 列の権限で閉じ、書く口を 2 つに限る)

```
利用者のセッション (Web / モバイル / route の createClient)
  ├─ INSERT / UPDATE: 3 列を除く 56 列 ……… 列の権限 (段 C の migration)。3 列を含むと 42501
  ├─ SELECT / DELETE: 今までどおり (RLS の USING で本人の行だけ)
  └─ 完了の切り替え ──→ RPC planned_meals_set_completed(p_meal_id, p_completed)  ……… SECURITY DEFINER (段 A)
                           本人の行 (user_daily_meals.user_id = auth.uid()) だけ UPDATE
                           is_completed = p_completed, completed_at = now() | 既存 | NULL
                           無ければ PLANNED_MEAL_NOT_FOUND (P0002)
サーバ (service_role)
  ├─ analyze-meal-photo の背景の処理: 本人の行を確かめ → veg_score = vegScoreOfVegetableGrams(野菜 g) ほかを UPDATE
  ├─ save-meal.ts / generate-menu: is_completed: false の INSERT (今までどおり)
  ├─ weekly/request の復元: snapshot の行 (本人の RLS で読んだもの) をそのまま INSERT
  └─ calculate-segment-stats / update_org_challenge_progress: 3 列を読む (今までどおり)
尺度 (0〜100・満点 120 g):
  ├─ supabase/functions/_shared/veg-score.ts  (Edge: 計算と係数)
  └─ packages/shared/src/planned-meals-integrity.ts (Web / モバイル: 定数・RPC の名前と引数・エラーの判定)
      ↑ 値の一致は tests/veg-score-scale-contract.test.ts が見る
```

- 閉じ方は「列の権限」の 1 枚。RLS のポリシーは変えない (行の所有は今までどおり USING が守る)。列の権限は PostgREST の INSERT / UPDATE / upsert すべてに効き、後で誰かが書き込みのポリシーを足しても 3 列は開かない。
- 完了の口は RPC 1 本。Web の hook・モバイルの hook は `supabase.rpc` を直接呼び、route 2 本と AI 相談は `src/modules/planned-meals-integrity/server.ts` の `setPlannedMealCompleted` を通して同じ RPC を呼ぶ。
- 野菜スコアの口は Edge の 1 か所。`POST /api/ai/nutrition` からは `veg_score` を外す (呼ぶ画面も無い)。
- 尺度は定数にし、`nutrition_score` の係数は定数から導く (`100 / VEG_SCORE_MAX`)。

### 4.2 動き

1. 段 A の migration で RPC を作る (既存の経路はまだ直接書いている。RPC は誰も呼ばない)。
2. 段 B で書き手を付け替える。デプロイ後、完了の切り替えは RPC、写真の上書きは service_role、作成は `is_completed` を送らない。この時点でも利用者は PostgREST で 3 列を書ける (穴は段 C で閉じる)。
3. 段 C の migration で列の権限を外す。以後、利用者のセッションから 3 列を含む INSERT / UPDATE は 42501。

### 4.3 シナリオのトレース (§4.1 の構造で手で走らせた記録)

| # | トレース | 結果 |
|---|---|---|
| S-1 | hook → `supabase.rpc('planned_meals_set_completed', { p_meal_id, p_completed: true })` → 関数: `auth.uid()` あり → UPDATE (EXISTS で本人) → `completed_at = now()` → RETURNING 1 行 → FOUND | 期待どおり |
| S-2 | 同じ RPC `p_completed: false` → `completed_at = NULL` | 期待どおり |
| S-3 | モバイルの hook → `supabase.rpc(...)` (S-1 と同じ) | 期待どおり |
| S-4 | 古いビルド → PostgREST `PATCH /rest/v1/planned_meals?id=eq.…` 本文 `{ is_completed, completed_at }` → 列の権限で 42501 → hook の `if (error)` → 楽観的更新を戻し `fetchAll()` | 期待どおり (操作だけ失敗) |
| S-5 | page → `PATCH /api/meals/[id]` `{ is_completed, completed_at }` → route: `allowedFields` に無いので `updateData` に入らない → `completion = PlannedMealCompletionInputSchema.safeParse(body.is_completed)` → 既存の UPDATE (`updated_at` 等) → `setPlannedMealCompleted(supabase, { mealId, completed })` → RPC → 応答 `{ ...data, ...row }` | 期待どおり (`completed_at` は DB の時刻) |
| S-6 | page → `PATCH /api/meal-plans/meals/[id]` `{ isCompleted }` → route: `isCompleted` を Zod で読む → 既存の UPDATE → RPC → `meal: { ...data, ...row }` | 期待どおり |
| S-7 | executor `complete_meal` → `setPlannedMealCompleted(supabase, { mealId, completed: isCompleted !== false })` → not_found → `result = { error: '権限がありません' }` / ok → `result = { mealId, completed }` | 期待どおり |
| S-8 | PostgREST UPDATE `veg_score` → 列の権限 → 42501 | 期待どおり |
| S-9 | PostgREST INSERT に `is_completed`・`veg_score` → 42501 (upsert は INSERT の権限で止まる) | 期待どおり |
| S-10 | PostgREST UPDATE `dish_name` → 56 列の権限で通る。INSERT (3 列なし) → 通り `is_completed` は既定 false | 期待どおり |
| S-11 | Edge: 利用者の client で解析 → `writer` (service_role) で `select id, user_daily_meals!inner(user_id)` + `eq('user_daily_meals.user_id', userId)` → 1 行 → `writer.update({ ..., veg_score: result.vegScore })` | 期待どおり |
| S-12 | 同上 → 0 行 → `throw new Error(PLANNED_MEAL_NOT_FOUND_CODE)` → 既存の catch がログに残す | 期待どおり (書かない) |
| S-13 | route: `validatePlannedMealInput` → update の本文は `{ ...validation.nutrients, quality_tags, updated_at }` | 期待どおり |
| S-14 | route: プロンプトに `veg_score` 無し → `updatePayload` に `veg_score` 無し | 期待どおり |
| S-15 | route: `insertData` に `is_completed` 無し → DB の DEFAULT false → `.select().single()` の応答は false | 期待どおり |
| S-16 | route: `select('*')` (利用者の RLS) で snapshot → 削除 → 生成が失敗 → `restorePlannedMealsSnapshot(getSupabaseAdmin(), snapshot)` → service_role の INSERT (3 列を含む) | 期待どおり |
| S-17 | `fetchBulkData` → `vegScoreSum / vegScoreCount = 70` → `veg_score_avg = 70.0`・`nutrition_score = round(70 × NUTRITION_SCORE_PER_VEG_SCORE) = 70` | 期待どおり |
| S-18 | SQL は変えない。`avg(pm.veg_score)` は 0〜100 の値の平均 | 期待どおり |
| S-19 | anon → `/rest/v1/rpc/planned_meals_set_completed` → EXECUTE 無し → 42501 | 期待どおり |
| S-20 | 本人の JWT・他人の id → 関数の UPDATE が 0 行 → `RAISE EXCEPTION 'PLANNED_MEAL_NOT_FOUND' USING ERRCODE = 'P0002'` → `server.ts` が `isPlannedMealNotFoundRpcError` → route 404 | 期待どおり |
| S-21 | route: `safeParse('yes')` 失敗 → 400 (DB に触れる前) | 期待どおり |
| S-22 | 戻し口: `REVOKE INSERT (56 列), UPDATE (56 列) ... FROM authenticated` → `GRANT INSERT, UPDATE ON TABLE ... TO anon, authenticated` | 期待どおり |
| S-23 | 戻し口: `DROP FUNCTION IF EXISTS public.planned_meals_set_completed(uuid, boolean)` | 期待どおり |
| S-24 | 関数の CASE: `pm.is_completed IS TRUE AND pm.completed_at IS NOT NULL` → 既存の `completed_at` を保つ | 期待どおり |
| S-25 | service_role は表の権限を変えていない → 通る | 期待どおり |

---

## 5. 構造裁定 (相 3・1 回だけ)

### 5.1 代替案の比較

| 案 | 内容 | 長所 | 短所 | 判定 |
|---|---|---|---|---|
| A (採用) | 列の権限 (表の INSERT / UPDATE を REVOKE → 56 列を GRANT) + 完了の RPC + 写真の解析は service_role | 3 列は PostgREST のどの書き方でも 42501。ポリシーを足されても開かない (二重に閉じる前例と同じ考え)。RLS は触らない。RPC で `completed_at` と対の整合がサーバの計算値になる | 56 列の列挙が要る (後で列を足す migration は同じファイルで GRANT が要る。§7.19 の契約テストが見張る)。書き手 9 本の付け替え | 採る |
| B | RLS の WITH CHECK で 3 列の変更を禁じる (`is_completed IS NOT DISTINCT FROM (SELECT is_completed FROM planned_meals WHERE id = …)` のように旧値と比べる) | ポリシーだけで済む | WITH CHECK から旧の行を引く副問い合わせは同じ行を読むので RLS の再帰になり、書き方が複雑で読み手が迷う。INSERT では旧値が無く、`is_completed = false AND veg_score IS NULL` のような固定の式が要る。後で FOR ALL のポリシーを足すと開く | 採らない |
| C | トリガーで `current_user IN ('authenticated', 'anon')` のときだけ 3 列の変更を 42501 にする (`guard_organizations_privileged` の型) | 列挙が要らない。既存の型 | 守りが「関数の本文」に隠れ、権限の表 (`information_schema`) に現れない。トリガーは `session_replication_role = replica` で動かない。完了の RPC は別に要る (SECURITY DEFINER の中は `current_user = postgres` なので通る) | 採らない |
| D | 完了の切り替えも route の service_role (`getSupabaseAdmin()`) で書く (RPC 無し) | DB の関数が増えない | Web の hook・モバイルの hook が route 経由になり、モバイルは Next.js を経由する client が要る (今は PostgREST を直接呼ぶ)。cross/02 §3.3 は route の service_role を禁じ、所有権の確認を route ごとに書くことになる | 採らない |
| E | `veg_score` も RPC (`planned_meals_set_veg_score`) にする | 口が揃う | 利用者が EXECUTE できる RPC なら値を入れられるので意味が無く、service_role だけが呼べる RPC は service_role の UPDATE と同じ | 採らない |

### 5.2 F の問い (縁の発生源を消すより単純な構造は無いか)

- 発生源は「利用者のセッションが表の列を区別せずに書ける」こと。列の権限はその発生源そのものを消す (A)。ポリシー (B) やトリガー (C) は書き込みの経路の途中で止める形で、発生源は残る。
- 完了の操作を「本人の操作」として残す以上、`is_completed` の値そのものは本人が決める。サーバの計算値になるのは時刻と対の整合だけで、それ以上 (将来の日付を数えない等) は集計の意味の変更なので本書では足さない (§21 Q-2)。
- `POST /api/ai/nutrition` から `veg_score` を外すのは、口を 1 つにする最も単純な形 (呼ぶ画面も無い)。

### 5.3 確定

構造 A で確定する。以後 §7〜§15 は A を機械的に展開したもので、構造の疑義が出たら blocking ではなく本節への差し戻しの事由として扱う。

---

## 6. 決めたこと (0.1 の 1〜7 への答え)

### 6.1 書き手の全列挙 (決めること 1)

§3.1 の表。利用者のセッションで 3 列を書く 9 本 (W-1〜W-7・W-8・W-12) と `is_completed: false` を送る 3 本 (W-9〜W-11) を §7 で付け替える。service_role の W-13 は変えない。

### 6.2 完了 (決めること 2)

- 完了 / 未完了は本人の操作。口は `planned_meals_set_completed(p_meal_id uuid, p_completed boolean)` (§7.1)。
- サーバの計算値 = `completed_at`。完了にするとき、すでに完了していて時刻があればその時刻を保ち、無ければ `now()`。未完了にするときは NULL。利用者は時刻を指定できない (route は本文の `completed_at` を無視する)。
- 本人の行の判定は関数の中の `EXISTS (SELECT 1 FROM public.user_daily_meals d WHERE d.id = pm.daily_meal_id AND d.user_id = auth.uid())` (RLS の USING と同じ式)。0 行なら `PLANNED_MEAL_NOT_FOUND` (P0002)。
- EXECUTE は authenticated と service_role だけ (PUBLIC・anon から外す。`anon-definer-execute.test.ts` A1 の規則)。
- `is_sandbox` の日 (ハンズオンのお試し) の献立も切り替えられる (今までと同じ。集計は `is_sandbox = false` で絞る)。

### 6.3 野菜スコア (決めること 3)

- 正本 = `estimateVegetableScore` (`nutrition-pipeline.ts`)。本書で `_shared/veg-score.ts` の `vegScoreOfVegetableGrams(grams)` = `clamp(round(grams / VEG_SCORE_FULL_MARK_GRAMS × VEG_SCORE_MAX), VEG_SCORE_MIN, VEG_SCORE_MAX)` を使う形にする (値は今と同じ。`grams` が有限でない・負のときは今の NaN でなく 0)。
- 型 integer・範囲 0〜100・NULL = 未計算。範囲は書き手 (この 1 関数) が守る。DB の CHECK / トリガーは足さない (§21 Q-1 に候補)。
- 書くのは `analyze-meal-photo` の背景の処理だけ。service_role の client で、本人の行であることを `user_daily_meals!inner(user_id)` で確かめてから書く (RLS を通らない client なので、確認は必須)。
- `POST /api/ai/nutrition` は 2 分岐とも `veg_score` を書かず、プロンプトからも外す。`quality_tags` は今までどおり (指標でない)。
- 集計: `veg_score_avg` は値の平均 (小数第 1 位)。`nutrition_score = round(vegAvg × NUTRITION_SCORE_PER_VEG_SCORE)` (`= 100 / VEG_SCORE_MAX = 1`)。`src/lib/org-challenges.ts` の `targetMax` は `VEG_SCORE_MAX` を読む (値 100 は同じ)。

### 6.4 権限の外し方 (決めること 4)

- 段 C の migration (§7.3): `REVOKE INSERT, UPDATE ON TABLE public.planned_meals FROM anon, authenticated;` → `GRANT INSERT (56 列), UPDATE (56 列) ON TABLE public.planned_meals TO authenticated;`。anon には付け直さない (anon が書ける経路は無い。ポリシーは `auth.uid()` が NULL で 0 行)。
- 表レベルの権限が残ると列の REVOKE は効かない (PostgreSQL は表の権限か列の権限のどちらかがあれば許す) ので、表の権限を外してから列を付ける。
- SELECT・DELETE・REFERENCES・TRIGGER・MAINTAIN と service_role・postgres の権限、RLS のポリシー、トリガーは変えない。TRUNCATE は付け直さない。
- 戻し口 (§7.4): 列の権限を外し、表の INSERT / UPDATE を anon / authenticated に付け直す (本番のベースラインの形)。

### 6.5 版の互換 (決めること 5)

- 古いモバイルのビルド (W-1 の直接の UPDATE) は、段 C の後は完了の切り替えが 42501 で失敗し、既存の失敗時の処理 (`console.error` → 楽観的更新を戻す → `fetchAll()`) で画面が元に戻る。ほかの画面 (読むだけ) は影響なし。
- 古い Web (Vercel のデプロイで入れ替わる) は段 B で同時に変わる。
- 猶予 (古い書き方も通す期間) は作らない。ローンチ前で利用者はゼロ。段の順 (A → B → C) で、新しいコードが古い DB で動かない窓 (RPC が無い) と、古いコードが新しい DB で動かない窓 (権限が無い) を作らない (§15)。

### 6.6 モジュールと契約 (決めること 6)

| 置き場 | 中身 | 読む側 |
|---|---|---|
| `packages/shared/src/planned-meals-integrity.ts` (新) | 3 列の名前・RPC の名前と引数の組み立て・`PLANNED_MEAL_NOT_FOUND` の判定・尺度の定数 (Web / モバイル用の写し) | Web の hook・route・モジュール、モバイルの hook、テスト |
| `src/modules/planned-meals-integrity/core.ts` (新) | Zod (route の本文の `is_completed` / `isCompleted`・RPC の返す行)・文言 | route・`server.ts`・テスト |
| `src/modules/planned-meals-integrity/server.ts` (新) | `setPlannedMealCompleted(db, { mealId, completed })` (RPC の呼び出しと結果の形) | route 2 本・AI 相談の executor |
| `supabase/functions/_shared/veg-score.ts` (新) | 尺度の定数・`vegScoreOfVegetableGrams`・`NUTRITION_SCORE_PER_VEG_SCORE` | `nutrition-pipeline.ts`・`calculate-segment-stats` |

UI (page・hook) は `@homegohan/shared` だけを読み、`server.ts` を import しない。

### 6.7 段分けと本番への当て方 (決めること 7)

§15。段 A (RPC の migration + 共通の定数 + 型の生成物) → 本番に段 A の migration が当たってから段 B (書き手の付け替え) をデプロイ → 段 B が本番で動いてから段 C (権限の migration) をマージ。段 C の migration の中身はマージの前にオーナーへ確認する。

---

## 7. 正典コード

### 7.1 `supabase/migrations/<番号はマージ時に確定>_planned_meals_set_completed_rpc.sql` (段 A。追加だけ)

```sql
-- migration: <番号はマージ時に確定>_planned_meals_set_completed_rpc.sql
-- 戻し方: supabase/rollbacks/<同じ番号>_planned_meals_set_completed_rpc.down.sql
-- #2025 (1/2): 献立 (planned_meals) の「食べた」の切り替えを、本人の行だけを書く SECURITY DEFINER の関数 1 本にする。
--
-- 背景:
--   比較ランキング (calculate-segment-stats の breakfast_rate / menu_execution_rate / veg_score_avg / nutrition_score) と
--   組織のチャレンジ (update_org_challenge_progress) は planned_meals.is_completed / veg_score を指標に使う。
--   本番のベースライン (20251126124224_create_meal_planner_tables.sql) の
--     :9900  "Users can manage own planned meals"  FOR ALL・TO public・USING (本人の user_daily_meals の行)・WITH CHECK 無し
--     :13798-13799  anon / authenticated への INSERT, SELECT, UPDATE, DELETE, ... の表の権限
--   により、利用者は PostgREST から自分の行のどの列でも書けた (#1999 の health_streaks と同じ型)。
--   完了の切り替えはアプリの 5 か所が利用者のセッションで直接 UPDATE していた (apps/mobile/src/hooks/useHomeData.ts・
--   src/hooks/useHomeData.ts・PATCH /api/meals/[id]・PATCH /api/meal-plans/meals/[id]・AI 相談の complete_meal)。
--
-- 変更 (この migration は関数を 1 本足すだけ。表・ポリシー・権限・行は変えない):
--   public.planned_meals_set_completed(p_meal_id uuid, p_completed boolean)
--     - SECURITY DEFINER (所有者 postgres の権限で書く)。search_path は空にし、表・関数は schema つきで書く
--     - 本人の行 (user_daily_meals.user_id = auth.uid()) だけを UPDATE。他人の行・無い行は PLANNED_MEAL_NOT_FOUND (P0002)
--     - is_completed = p_completed。completed_at は、完了にするときは「すでに完了で時刻があればその時刻、無ければ now()」、
--       未完了にするときは NULL (時刻は利用者が指定できない = サーバの計算値)
--     - 返すのは書いた行の id / is_completed / completed_at / updated_at (updated_at はトリガー trg_planned_meals_updated_at が進める)
--     - EXECUTE は authenticated と service_role だけ (PUBLIC・anon から外す。tests/integration/security/anon-definer-execute.test.ts の A1)
--   利用者のセッションから is_completed / completed_at / veg_score を直接書く権限は、次の migration
--   (<番号はマージ時に確定>_planned_meals_score_columns_server_only.sql) が外す。アプリの書き手の付け替え (この関数を呼ぶ形) は
--   その前にデプロイする (docs/design/cross/23-planned-meals-score-integrity.md §15)。
--
-- 既存データへの影響: なし。
-- 冪等: CREATE OR REPLACE FUNCTION と REVOKE / GRANT のため、2 回続けて適用してもエラーにならない。
-- ロック: 表には触れない (関数の作成とカタログの権限だけ)。
-- 確認: tests/integration/rls/planned-meals-score-integrity.test.ts (実 DB)
--       tests/planned-meals-score-integrity-migration-contract.test.ts (静的)

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.planned_meals_set_completed(p_meal_id uuid, p_completed boolean)
RETURNS TABLE (id uuid, is_completed boolean, completed_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'PLANNED_MEAL_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF p_meal_id IS NULL OR p_completed IS NULL THEN
    RAISE EXCEPTION 'PLANNED_MEAL_INVALID_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  UPDATE public.planned_meals AS pm
     SET is_completed = p_completed,
         completed_at = CASE
           WHEN NOT p_completed THEN NULL
           WHEN pm.is_completed IS TRUE AND pm.completed_at IS NOT NULL THEN pm.completed_at
           ELSE now()
         END
   WHERE pm.id = p_meal_id
     AND EXISTS (
       SELECT 1 FROM public.user_daily_meals AS d
        WHERE d.id = pm.daily_meal_id AND d.user_id = v_user_id
     )
  RETURNING pm.id, pm.is_completed, pm.completed_at, pm.updated_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PLANNED_MEAL_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.planned_meals_set_completed(uuid, boolean) IS
  '#2025: 献立 (planned_meals) の「食べた」を本人の行だけ切り替える。completed_at は完了なら既存の時刻か now()、未完了なら NULL。他人の行・無い行は PLANNED_MEAL_NOT_FOUND (P0002)。docs/design/cross/23-planned-meals-score-integrity.md §7.1';

REVOKE ALL ON FUNCTION public.planned_meals_set_completed(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.planned_meals_set_completed(uuid, boolean) TO authenticated, service_role;
```

書き方の注:
- `RETURN QUERY UPDATE ... RETURNING` は 1 行も返さないと `FOUND` が false になる (PL/pgSQL の `RETURN QUERY` は返した行があれば `FOUND` を true にする)。
- `RETURNS TABLE` の列名 (`id` など) は関数の中では変数になるので、表の列は必ず `pm.` を付けて書く。
- `search_path = ''` でも `now()`・`auth.uid()` は解決する (`pg_catalog` は常に引かれ、`auth.uid()` は schema つき)。
- `SET LOCAL lock_timeout` は前例 (`20261024110000`) と同じ。表のロックは取らないが、形をそろえる。

### 7.2 `supabase/rollbacks/<同じ番号>_planned_meals_set_completed_rpc.down.sql`

```sql
-- rollback: <同じ番号>_planned_meals_set_completed_rpc.sql
-- #2025 (1/2) で足した、献立の「食べた」を切り替える SECURITY DEFINER の関数 planned_meals_set_completed(uuid, boolean) を消す。
-- 表・ポリシー・権限・行には触れていないので、戻すのは関数だけ。
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、アプリの完了の切り替え (hook・route・AI 相談) は RPC が無いので失敗する (PostgREST の PGRST202)。
--     先に 2/2 (<同じ番号>_planned_meals_score_columns_server_only.sql) を戻し、アプリを直接 UPDATE する版に戻してから流す。
--
-- 何度流しても同じ結果になる (冪等: DROP FUNCTION IF EXISTS)。

SET LOCAL lock_timeout = '10s';

DROP FUNCTION IF EXISTS public.planned_meals_set_completed(uuid, boolean);
```

### 7.3 `supabase/migrations/<番号はマージ時に確定>_planned_meals_score_columns_server_only.sql` (段 C。権限だけ)

```sql
-- migration: <番号はマージ時に確定>_planned_meals_score_columns_server_only.sql
-- 戻し方: supabase/rollbacks/<同じ番号>_planned_meals_score_columns_server_only.down.sql
-- #2025 (2/2): 比較ランキングと組織のチャレンジが指標に使う planned_meals の 3 列 (veg_score / is_completed / completed_at) を、
--   利用者 (anon / authenticated) の INSERT / UPDATE の権限から外す。書けるのはサーバだけにする。
--
-- 背景:
--   本番のベースライン (20251126124224_create_meal_planner_tables.sql) の :13798-13799 で anon / authenticated は planned_meals の
--   INSERT / UPDATE を表ごと持ち、:9900 のポリシー "Users can manage own planned meals" (FOR ALL・列を絞らない) で自分の行の
--   どの列でも書けた。利用者は veg_score に好きな値を入れ、is_completed / completed_at も好きに書けた (#1999 の health_streaks と同じ型)。
--   20261022190000_db_privilege_hardening.sql は TRUNCATE だけを外した。ベースラインより後に planned_meals の列・権限・ポリシーを
--   変えた migration は無い (origin/main で grep した)。
--
--   3 列を書く経路 (origin/main で git grep した。docs/design/cross/23-planned-meals-score-integrity.md §3.1):
--     - 完了の切り替え (モバイルのホーム・Web のホーム・PATCH /api/meals/[id]・PATCH /api/meal-plans/meals/[id]・AI 相談の
--       complete_meal) は、1/2 (<番号はマージ時に確定>_planned_meals_set_completed_rpc.sql) の SECURITY DEFINER の関数
--       planned_meals_set_completed を呼ぶ形に付け替え済み (所有者の権限で書くので、この変更の影響を受けない)
--     - 野菜スコア (veg_score) を書くのは写真の解析 (supabase/functions/analyze-meal-photo) の背景の処理だけで、service_role の
--       client で本人の行を確かめてから書く形に付け替え済み。POST /api/ai/nutrition は veg_score を書かない
--     - 新規作成の route (POST /api/meals・POST /api/meal-plans/meals・POST /api/meal-plans/add-from-photo) は is_completed を送らない
--       (列の既定 false)。週間生成の失敗時の復元 (src/lib/planned-meals-snapshot.ts) は service_role で戻す
--     - 献立の生成と保存 (supabase/functions/_shared/save-meal.ts・generate-menu-v4 / v5) と集計 (calculate-segment-stats・
--       update_org_challenge_progress) は service_role (変えない)
--
-- 変更:
--   1. planned_meals の INSERT / UPDATE を anon と authenticated から外す (表の権限が残っていると列の権限は効かない:
--      PostgreSQL は表の権限か列の権限のどちらかがあれば許す)。
--   2. authenticated に、3 列を除く 56 列の INSERT (列) / UPDATE (列) を付け直す (ベースラインの CREATE TABLE の 59 列から
--      is_completed / completed_at / veg_score を除いた並び)。anon には付け直さない (anon が planned_meals を書く経路は無く、
--      ポリシーは auth.uid() が NULL で 0 行)。
--   後で planned_meals に列を足す migration は、同じファイルで authenticated にその列の INSERT (列) / UPDATE (列) を GRANT する
--   (tests/planned-meals-score-integrity-migration-contract.test.ts が見張る)。
--   SELECT・DELETE・REFERENCES・TRIGGER・MAINTAIN と service_role・postgres の権限、RLS のポリシー、トリガーは変えない。
--   TRUNCATE は付け直さない (20261022190000 の規則)。
--
-- 効き方: 利用者のセッションから 3 列を含む INSERT / UPDATE / upsert は 42501 (permission denied for table planned_meals) で止まる
--   (PostgREST では 403・supabase-js では error.code = '42501')。3 列を含まない INSERT / UPDATE は今までどおり通る。
--   古いモバイルのビルドの完了の切り替え (直接の UPDATE) は失敗し、既存の失敗時の処理で画面が元に戻る (ローンチ前で利用者はゼロ)。
--
-- 既存データへの影響: なし (権限だけの変更。行は消さない・変えない)。
-- 冪等: REVOKE / GRANT は何度流しても同じ結果になる。
-- ロック: GRANT / REVOKE は planned_meals の ACCESS EXCLUSIVE を一瞬取る (カタログの書き換えだけで、行には触れない)。
-- 確認: tests/integration/rls/planned-meals-score-integrity.test.ts (実 DB)
--       tests/planned-meals-score-integrity-migration-contract.test.ts (静的)

-- 表のロックを長く待たない (待ちが続いたら失敗させて流し直す。20261024110000 と同じ)
SET LOCAL lock_timeout = '10s';

-- 1. 表ごとの INSERT / UPDATE を外す
REVOKE INSERT, UPDATE ON TABLE public.planned_meals FROM anon, authenticated;

-- 2. 3 列 (is_completed / completed_at / veg_score) を除く 56 列を authenticated に付け直す
GRANT INSERT (
  id, meal_type, dish_name, recipe_url, image_url, description, ingredients,
  calories_kcal, protein_g, fat_g, carbs_g, actual_meal_id, created_at, updated_at,
  mode, dishes, is_simple, cooking_time_minutes, memo, quality_tags, display_order,
  sodium_g, sugar_g, fiber_g, fiber_soluble_g, fiber_insoluble_g, potassium_mg, calcium_mg,
  phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg,
  vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug,
  vitamin_k_ug, vitamin_e_mg, saturated_fat_g, monounsaturated_fat_g, polyunsaturated_fat_g,
  amino_acid_g, recipe_steps, is_generating, source_type, source_dataset_version,
  source_menu_set_external_id, generation_metadata, magnesium_mg, daily_meal_id, catalog_product_id
), UPDATE (
  id, meal_type, dish_name, recipe_url, image_url, description, ingredients,
  calories_kcal, protein_g, fat_g, carbs_g, actual_meal_id, created_at, updated_at,
  mode, dishes, is_simple, cooking_time_minutes, memo, quality_tags, display_order,
  sodium_g, sugar_g, fiber_g, fiber_soluble_g, fiber_insoluble_g, potassium_mg, calcium_mg,
  phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg,
  vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug,
  vitamin_k_ug, vitamin_e_mg, saturated_fat_g, monounsaturated_fat_g, polyunsaturated_fat_g,
  amino_acid_g, recipe_steps, is_generating, source_type, source_dataset_version,
  source_menu_set_external_id, generation_metadata, magnesium_mg, daily_meal_id, catalog_product_id
) ON TABLE public.planned_meals TO authenticated;
```

### 7.4 `supabase/rollbacks/<同じ番号>_planned_meals_score_columns_server_only.down.sql`

```sql
-- rollback: <同じ番号>_planned_meals_score_columns_server_only.sql
-- #2025 (2/2) で外した planned_meals の利用者の INSERT / UPDATE の権限を元に戻す。
-- 列ごとの権限 (authenticated の 56 列) を外し、表ごとの INSERT / UPDATE を anon と authenticated に付け直す
-- (本番のベースライン 20251126124224_create_meal_planner_tables.sql:13798-13799 の形。SELECT・DELETE・REFERENCES・TRIGGER・
-- MAINTAIN は本冊が触れていないので付け直さない)。
-- TRUNCATE は付け直さない: 本冊の適用の直前の時点で、20261022190000_db_privilege_hardening.sql が anon / authenticated から
-- 外してある (本冊は TRUNCATE に触れていない)。
-- (tests/planned-meals-score-integrity-migration-contract.test.ts が、流した後の状態が本冊の直前の状態と同じことを見る)
--
-- 本番に戻す必要があるときは、この内容を新しい migration として PR 経由で適用する (本番への直接 SQL は禁止。CLAUDE.md)。
--
-- 影響:
--   - 戻すと、利用者が PostgREST から自分の行の veg_score / is_completed / completed_at を直接書けるようになり、
--     比較ランキングと組織のチャレンジの指標に任意の値を入れられる穴が再び開く。
--   - アプリ (完了は RPC、野菜スコアは service_role で書く) は、戻しても戻さなくても動く。先にアプリを戻す必要は無い。
--
-- 何度流しても同じ結果になる (冪等: REVOKE / GRANT は何度流しても同じ)。

SET LOCAL lock_timeout = '10s';

REVOKE INSERT (
  id, meal_type, dish_name, recipe_url, image_url, description, ingredients,
  calories_kcal, protein_g, fat_g, carbs_g, actual_meal_id, created_at, updated_at,
  mode, dishes, is_simple, cooking_time_minutes, memo, quality_tags, display_order,
  sodium_g, sugar_g, fiber_g, fiber_soluble_g, fiber_insoluble_g, potassium_mg, calcium_mg,
  phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg,
  vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug,
  vitamin_k_ug, vitamin_e_mg, saturated_fat_g, monounsaturated_fat_g, polyunsaturated_fat_g,
  amino_acid_g, recipe_steps, is_generating, source_type, source_dataset_version,
  source_menu_set_external_id, generation_metadata, magnesium_mg, daily_meal_id, catalog_product_id
), UPDATE (
  id, meal_type, dish_name, recipe_url, image_url, description, ingredients,
  calories_kcal, protein_g, fat_g, carbs_g, actual_meal_id, created_at, updated_at,
  mode, dishes, is_simple, cooking_time_minutes, memo, quality_tags, display_order,
  sodium_g, sugar_g, fiber_g, fiber_soluble_g, fiber_insoluble_g, potassium_mg, calcium_mg,
  phosphorus_mg, iron_mg, zinc_mg, iodine_ug, cholesterol_mg, vitamin_b1_mg, vitamin_b2_mg,
  vitamin_b6_mg, vitamin_b12_ug, folic_acid_ug, vitamin_c_mg, vitamin_a_ug, vitamin_d_ug,
  vitamin_k_ug, vitamin_e_mg, saturated_fat_g, monounsaturated_fat_g, polyunsaturated_fat_g,
  amino_acid_g, recipe_steps, is_generating, source_type, source_dataset_version,
  source_menu_set_external_id, generation_metadata, magnesium_mg, daily_meal_id, catalog_product_id
) ON TABLE public.planned_meals FROM authenticated;

GRANT INSERT, UPDATE ON TABLE public.planned_meals TO anon, authenticated;
```

列の並びは 4 か所とも同じ (ベースラインの CREATE TABLE の順から 3 列を抜いたもの)。`tests/planned-meals-score-integrity-migration-contract.test.ts` (§7.19) が、ベースラインの列から機械で作った一覧と 4 か所の一致を見る。

### 7.5 `packages/shared/src/planned-meals-integrity.ts` (新。全文。何も import しない。Web・モバイル・テストが読む)

`packages/shared/src/index.ts` に `export * from './planned-meals-integrity';` を 1 行足す (`./billing-plans` の行の次)。

```ts
// packages/shared/src/planned-meals-integrity.ts
// 献立 (planned_meals) の、サーバだけが書く 3 列と完了の RPC (docs/design/cross/23-planned-meals-score-integrity.md)。
// Web (src) とモバイル (apps/mobile) の両方から読むので、zod も supabase-js も import しない。
// Edge Function は packages/shared を import できないので、尺度の値は supabase/functions/_shared/veg-score.ts にも置く
// (値の一致は tests/veg-score-scale-contract.test.ts が見る)。

/**
 * 利用者 (authenticated) のセッションからは INSERT / UPDATE できない列。
 * 比較ランキング (calculate-segment-stats) と組織のチャレンジ (update_org_challenge_progress) が指標に使う 2 列と、
 * 完了の時刻 (完了の RPC だけが書く)。migration <番号はマージ時に確定>_planned_meals_score_columns_server_only.sql が
 * 列の権限から外す。
 */
export const PLANNED_MEALS_SERVER_ONLY_COLUMNS = ['is_completed', 'completed_at', 'veg_score'] as const;

export type PlannedMealsServerOnlyColumn = (typeof PLANNED_MEALS_SERVER_ONLY_COLUMNS)[number];

/** 完了の切り替えの RPC (SECURITY DEFINER。本人の行だけ。migration <番号はマージ時に確定>_planned_meals_set_completed_rpc.sql) */
export const PLANNED_MEALS_SET_COMPLETED_RPC = 'planned_meals_set_completed';

/** RPC の引数 (DB の関数の引数名と同じ) */
export interface PlannedMealsSetCompletedArgs {
  p_meal_id: string;
  p_completed: boolean;
}

/** RPC の引数を組み立てる (hook・route・テストで引数名を手書きしない) */
export function plannedMealsSetCompletedArgs(mealId: string, completed: boolean): PlannedMealsSetCompletedArgs {
  return { p_meal_id: mealId, p_completed: completed };
}

/** RPC が返す 1 行 (RETURNS TABLE)。completed_at / updated_at は ISO 8601 の文字列か null */
export interface PlannedMealsSetCompletedRow {
  id: string;
  is_completed: boolean;
  completed_at: string | null;
  updated_at: string | null;
}

/**
 * RPC が「本人の行として見つからない」ときに RAISE する文 (他人の行・無い行)。SQLSTATE は P0002 (no_data_found)。
 * supabase-js の error は { code: 'P0002', message: 'PLANNED_MEAL_NOT_FOUND' } の形で届く
 */
export const PLANNED_MEAL_NOT_FOUND_CODE = 'PLANNED_MEAL_NOT_FOUND';
export const PLANNED_MEAL_NOT_FOUND_SQLSTATE = 'P0002';

/** supabase-js / PostgREST のエラーが、RPC の PLANNED_MEAL_NOT_FOUND か */
export function isPlannedMealNotFoundRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === PLANNED_MEAL_NOT_FOUND_SQLSTATE) return true;
  return typeof message === 'string' && message.includes(PLANNED_MEAL_NOT_FOUND_CODE);
}

/**
 * 野菜スコアの尺度 (写真の解析 supabase/functions/_shared/nutrition-pipeline.ts の estimateVegetableScore が書く値の範囲)。
 * 計算の正本は supabase/functions/_shared/veg-score.ts (ここは Web / モバイル用の写し)。
 * 組織のチャレンジ (src/lib/org-challenges.ts) の目標値の範囲と、比較ランキングの nutrition_score の正規化がこの値を使う
 */
export const VEG_SCORE_MIN = 0;
export const VEG_SCORE_MAX = 100;

/** 野菜スコアとして DB に入ってよい値 (0〜100 の整数) か。null は「未計算」で、ここでは false */
export function isVegScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= VEG_SCORE_MIN && value <= VEG_SCORE_MAX;
}
```

### 7.6 `supabase/functions/_shared/veg-score.ts` (新。全文。Deno。何も import しない)

```ts
// supabase/functions/_shared/veg-score.ts
// 野菜スコア (planned_meals.veg_score) の尺度と計算の正本 (docs/design/cross/23-planned-meals-score-integrity.md §6.3)。
// 書くのは analyze-meal-photo の背景の処理 (service_role) だけ。読むのは calculate-segment-stats (nutrition_score の正規化)。
// Web / モバイルは packages/shared/src/planned-meals-integrity.ts の写し (VEG_SCORE_MIN / VEG_SCORE_MAX) を読む。
// 値の一致は tests/veg-score-scale-contract.test.ts が見る。

/** 野菜スコアの下限・上限 (整数の点)。DB の列は integer */
export const VEG_SCORE_MIN = 0;
export const VEG_SCORE_MAX = 100;

/**
 * 満点 (VEG_SCORE_MAX) に当たる 1 食の野菜の量 (g)。
 * 以前の estimateVegetableScore の式 `round(vegetableGrams / 120 * 100)` の 120 を名前にしたもの。尺度の定義そのもので、
 * 変えると過去の値と比べられなくなるので、環境変数では変えない (変えるときは設計書を改定する)
 */
export const VEG_SCORE_FULL_MARK_GRAMS = 120;

/**
 * 比較ランキングの nutrition_score (0〜100 の整数) を veg_score_avg から求める係数。
 * 尺度が 0〜100 なので 1 (以前は 1〜5 点を前提に 20 を掛けていた)
 */
export const NUTRITION_SCORE_PER_VEG_SCORE = 100 / VEG_SCORE_MAX;

function clampVegScore(value: number): number {
  return Math.min(VEG_SCORE_MAX, Math.max(VEG_SCORE_MIN, value));
}

/**
 * 1 食の野菜の量 (g の合計) から野菜スコア (0〜100 の整数) を求める。
 * 有限でない・負の量は 0 (以前は NaN が通り抜けた)。
 */
export function vegScoreOfVegetableGrams(vegetableGrams: number): number {
  if (!Number.isFinite(vegetableGrams) || vegetableGrams <= 0) return VEG_SCORE_MIN;
  return clampVegScore(Math.round((vegetableGrams / VEG_SCORE_FULL_MARK_GRAMS) * VEG_SCORE_MAX));
}

/** 比較ランキングの nutrition_score: veg_score_avg (0〜100) を 0〜100 の整数に正規化する。平均が無い (0 件) ときは 0 */
export function nutritionScoreOfVegScoreAverage(vegScoreAverage: number): number {
  if (!Number.isFinite(vegScoreAverage)) return VEG_SCORE_MIN;
  return clampVegScore(Math.round(vegScoreAverage * NUTRITION_SCORE_PER_VEG_SCORE));
}
```

### 7.7 `src/modules/planned-meals-integrity/core.ts` (新。全文。zod と `@homegohan/shared` だけを import する)

```ts
// tsc:skip (本書が新設する @homegohan/shared の planned-meals-integrity を import する。型は §7.5 のとおり)
// src/modules/planned-meals-integrity/core.ts
// 献立の完了の RPC の入出力の Zod の正典と文言 (docs/design/cross/23-planned-meals-score-integrity.md §7.7)。
// route と server.ts から使う。DB の操作は ./server.ts。
import { z } from 'zod';
import type { PlannedMealsSetCompletedRow } from '@homegohan/shared';

/**
 * route の本文の完了の指定 (PATCH /api/meals/[id] の is_completed・PATCH /api/meal-plans/meals/[id] の isCompleted)。
 * boolean だけ。undefined は「指定なし」(route が safeParse の前に見分ける)。文字列の 'true' や 1 は通さない
 */
export const PlannedMealCompletionInputSchema = z.boolean();

/** RPC planned_meals_set_completed が返す 1 行 (RETURNS TABLE)。PostgREST は配列で返す */
export const PlannedMealsSetCompletedRowSchema = z.object({
  id: z.string().uuid(),
  is_completed: z.boolean(),
  completed_at: z.string().nullable(),
  updated_at: z.string().nullable(),
}) satisfies z.ZodType<PlannedMealsSetCompletedRow>;

export type PlannedMealCompletionRow = z.infer<typeof PlannedMealsSetCompletedRowSchema>;

/** 本文の is_completed / isCompleted が boolean でないときの 400 の文 (固定。値は載せない) */
export const PLANNED_MEAL_COMPLETION_INVALID_MESSAGE = '完了の指定は true か false で送ってください';

/** RPC の返す行の形が正典と違うときの失敗の文 (ログ用。本文には出ない) */
export const PLANNED_MEAL_COMPLETION_ROW_SHAPE_FAILURE_MESSAGE =
  'planned_meals_set_completed の返す行の形が正典 (PlannedMealsSetCompletedRowSchema) と違います';
```

### 7.8 `src/modules/planned-meals-integrity/server.ts` (新。全文。route と AI 相談の executor だけが import する)

```ts
// tsc:skip (本書が新設する ./core と @homegohan/shared の planned-meals-integrity を import する)
// src/modules/planned-meals-integrity/server.ts
// 献立の完了の切り替え (RPC planned_meals_set_completed の呼び出し)。RLS の効く利用者の client を受け取る (service_role は使わない)。
// 失敗は固定の形で返し、DB の生のエラーは呼び出し側 (route) が internalError で構造化ログにだけ残す。
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  PLANNED_MEALS_SET_COMPLETED_RPC,
  isPlannedMealNotFoundRpcError,
  plannedMealsSetCompletedArgs,
} from '@homegohan/shared';
import { isUuid } from '@/lib/http-params';
import {
  PLANNED_MEAL_COMPLETION_ROW_SHAPE_FAILURE_MESSAGE,
  PlannedMealsSetCompletedRowSchema,
  type PlannedMealCompletionRow,
} from './core';

/** route・executor が渡す、利用者のセッションの Supabase クライアント (rpc だけを使う) */
export type PlannedMealsIntegrityDb = Pick<SupabaseClient, 'rpc'>;

export type SetPlannedMealCompletedResult =
  | { ok: true; row: PlannedMealCompletionRow }
  /** 本人の行として無い (他人の行・消えた行・UUID の形でない id)。route は 404、AI 相談は '権限がありません' */
  | { ok: false; reason: 'not_found' }
  /** DB の失敗 (RPC が無い・接続の失敗・行の形が違う)。route は 500 */
  | { ok: false; reason: 'db'; error: unknown };

/**
 * 献立を完了 / 未完了にする。completed_at は DB が決める (完了なら既存の時刻か now()、未完了なら NULL)。
 * UUID の形でない id は DB に渡さず not_found (uuid 型の引数に渡すと 22P02 になるため)。
 */
export async function setPlannedMealCompleted(
  db: PlannedMealsIntegrityDb,
  params: { mealId: string; completed: boolean },
): Promise<SetPlannedMealCompletedResult> {
  if (!isUuid(params.mealId)) return { ok: false, reason: 'not_found' };
  const { data, error } = await db.rpc(
    PLANNED_MEALS_SET_COMPLETED_RPC,
    plannedMealsSetCompletedArgs(params.mealId, params.completed),
  );
  if (error) {
    if (isPlannedMealNotFoundRpcError(error)) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'db', error };
  }
  // RETURNS TABLE は配列で届く (supabase-js の型の都合で単体のこともあるので両方を受ける)
  const rows: unknown[] = Array.isArray(data) ? data : data === null || data === undefined ? [] : [data];
  const parsed = PlannedMealsSetCompletedRowSchema.safeParse(rows[0]);
  if (!parsed.success) {
    return { ok: false, reason: 'db', error: new Error(PLANNED_MEAL_COMPLETION_ROW_SHAPE_FAILURE_MESSAGE) };
  }
  return { ok: true, row: parsed.data };
}
```

### 7.9 route 2 本の差分 (完了は RPC。本文の `completed_at` は無視)

#### 7.9.1 `src/app/api/meals/[id]/route.ts` の PATCH (差分。3 か所)

```ts
// tsc:skip (既存ファイルの差分の断片)
// (1) import に足す
import { setPlannedMealCompleted } from '@/modules/planned-meals-integrity/server';
import { PLANNED_MEAL_COMPLETION_INVALID_MESSAGE, PlannedMealCompletionInputSchema } from '@/modules/planned-meals-integrity/core';

// (2) 本文の検証 (validatePlannedMealInput の直後)。is_completed が無ければ null。boolean でなければ 400 (DB に触れる前)
//     completed_at は本文にあっても読まない (時刻は DB が決める)
const completionInput = body.is_completed === undefined ? null : PlannedMealCompletionInputSchema.safeParse(body.is_completed);
if (completionInput && !completionInput.success) {
  return NextResponse.json({ error: PLANNED_MEAL_COMPLETION_INVALID_MESSAGE }, { status: 400 });
}

// (3) allowedFields から 'is_completed', 'completed_at' を外す (列の権限が無く、送ると 42501 になる)
const allowedFields = [
  'dish_name', 'mode', 'description', 'image_url', 'ingredients',
  'calories_kcal', 'protein_g', 'fat_g', 'carbs_g',
  'dishes', 'is_simple', 'cooking_time_minutes', 'source_type'
];

// (4) 既存の update (updateData) と画像のジョブの処理はそのまま。その後、完了の指定があれば RPC で切り替え、応答の行に載せる
//     (既存の update の `data` の後ろ・`enqueueMealImageJobs` の前に置く)
let completionRow: Record<string, unknown> = {};
if (completionInput) {
  const completion = await setPlannedMealCompleted(supabase, { mealId: params.id, completed: completionInput.data });
  if (!completion.ok) {
    if (completion.reason === 'not_found') {
      return NextResponse.json({ error: MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }
    return internalError('PATCH /api/meals/[id]', completion.error, { userId: user.id, requestId: requestId ?? undefined });
  }
  completionRow = completion.row;
}

// (5) 応答: 行に RPC の値 (is_completed / completed_at / updated_at) を重ねる
return NextResponse.json({
  ...data,
  ...completionRow,
  ...(imageGenerationThrottled ? { imageGenerationThrottled: true } : {}),
  ...aiDailyLimitSkippedField(imageUsage),
});
```

順序: 既存の UPDATE (ほかの列) → 完了の RPC → 画像のジョブ。既存の UPDATE が失敗したら今までどおり 500 で終わり、RPC は呼ばない。RPC が失敗したら (他の列は保存済みのまま) 404 / 500 を返す。画面は失敗時に楽観的更新を戻して読み直す (今までと同じ)。

#### 7.9.2 `src/app/api/meal-plans/meals/[id]/route.ts` の PATCH (差分。3 か所)

```ts
// tsc:skip (既存ファイルの差分の断片)
// (1) import に足す (7.9.1 と同じ 2 行)
import { setPlannedMealCompleted } from '@/modules/planned-meals-integrity/server';
import { PLANNED_MEAL_COMPLETION_INVALID_MESSAGE, PlannedMealCompletionInputSchema } from '@/modules/planned-meals-integrity/core';

// (2) validatePlannedMealInput の直後
const completionInput = isCompleted === undefined ? null : PlannedMealCompletionInputSchema.safeParse(isCompleted);
if (completionInput && !completionInput.success) {
  return NextResponse.json({ error: PLANNED_MEAL_COMPLETION_INVALID_MESSAGE }, { status: 400 });
}

// (3) updateData から is_completed / completed_at の 2 行を消す (次の 4 行を削除)
//   if (isCompleted !== undefined) {
//     updateData.is_completed = isCompleted;
//     updateData.completed_at = isCompleted ? new Date().toISOString() : null;
//   }

// (4) 既存の update の `data` の後ろ・画像のジョブの前
let completionRow: Record<string, unknown> = {};
if (completionInput) {
  const completion = await setPlannedMealCompleted(supabase, { mealId: existingMeal.id, completed: completionInput.data });
  if (!completion.ok) {
    if (completion.reason === 'not_found') {
      return NextResponse.json({ error: MEAL_NOT_FOUND_MESSAGE }, { status: 404 });
    }
    throw completion.error;
  }
  completionRow = completion.row;
}

// (5) 応答
return NextResponse.json({
  success: true,
  meal: { ...data, ...completionRow },
  ...(imageGenerationThrottled ? { imageGenerationThrottled: true } : {}),
  ...aiDailyLimitSkippedField(imageUsage),
});
```

`throw completion.error` は、この route の既存の `catch` が `internalError('PATCH /api/meal-plans/meals/[id]', error, { userId })` で 500 にする形に合わせたもの (既存の `if (error) throw error;` と同じ)。

### 7.10 `src/lib/ai/consultation-action-executor.ts` の `complete_meal` (差し替え)

```ts
// tsc:skip (既存ファイルの差分の断片。import は先頭に足す)
import { setPlannedMealCompleted } from '@/modules/planned-meals-integrity/server';

    case 'complete_meal': {
      const { mealId, isCompleted } = action.action_params;
      // 本人の行かどうかは RPC (planned_meals_set_completed) が確かめる。他人の行・無い行・UUID の形でない id は not_found
      const completion = await setPlannedMealCompleted(supabase, {
        mealId: typeof mealId === 'string' ? mealId : '',
        completed: isCompleted !== false,
      });
      if (!completion.ok) {
        if (completion.reason === 'not_found') {
          result = { error: '権限がありません' };
          break;
        }
        success = false;
        result = { mealId, error: '食事の完了を更新できませんでした' };
        break;
      }
      success = true;
      result = { mealId, completed: completion.row.is_completed };
      break;
    }
```

- 既存の所有権の確認 (`select id, user_daily_meals!inner(user_id)`) は消す (RPC が同じ式で確かめる)。
- `result.error` の文 '権限がありません' は既存のまま (`tests/consultation-action-raw-error-text.test.ts`・`src/lib/ai/ai-api-messages.ts` の決まり: route の外の文は固定の日本語)。DB の失敗の文 '食事の完了を更新できませんでした' は新設 (§13)。`src/lib/ai/ai-api-messages.ts` の「相談の提案の実行の値の検証」の節に定数 `AI_ACTION_COMPLETE_MEAL_FAILED_MESSAGE` として置き、executor はそれを読む (直書きしない)。

### 7.11 新規作成の 3 route (差分。`is_completed: false` の 1 行を消す)

```ts
// tsc:skip (既存ファイルの差分の断片)
// src/app/api/meals/route.ts (insertData)・src/app/api/meal-plans/meals/route.ts (insertData)・
// src/app/api/meal-plans/add-from-photo/route.ts (insertData) の 3 か所から、次の 1 行を消す
//   is_completed: false,
// 列の既定 (DEFAULT false) が入る。応答の is_completed (.select().single() / newMeal.is_completed) は false のまま
```

### 7.12 週間生成の失敗時の復元 (`src/app/api/ai/menu/weekly/request/route.ts` の差分)

```ts
// tsc:skip (既存ファイルの差分の断片)
// import に getSupabaseAdmin を足す (createClient と同じ行から)
import { createClient, getSupabaseAdmin } from '@/lib/supabase/server';

// 失敗時の復元 (既存の restorePlannedMealsSnapshot(supabase, deletedMealsSnapshot) の 1 行を差し替える)
//   snapshot の行は本人のセッション (RLS) の select('*') で読んだもので、daily_meal_id は本人の user_daily_meals を指す。
//   利用者の権限では is_completed / completed_at / veg_score を INSERT できない (42501) ので、消した行をそのまま
//   (完了の印・時刻・野菜スコアを落とさずに) 戻すために service_role で INSERT する (#2025。cross/02 §3.3 の例外。
//   所有権は行の出どころで保証され、ここで別の行を作らない)
const restoreResult = await restorePlannedMealsSnapshot(getSupabaseAdmin(), deletedMealsSnapshot);
```

`src/lib/planned-meals-snapshot.ts` は変えない (受け取った client で INSERT する。`fetchOccupiedSlots` も同じ client で、snapshot の `daily_meal_id` に絞る)。

### 7.13 `src/app/api/ai/nutrition/route.ts` の差分 (`veg_score` を書かない。3 か所)

```ts
// tsc:skip (既存ファイルの差分の断片)
// (1) nutritionData の分岐の update: veg_score の 1 行を消す (quality_tags は残す)
      const { error: updateError } = await supabase
        .from('planned_meals')
        .update({
          // 検証済みの値（送られていない項目は含まれず、既存の値を残す）
          ...validation.nutrients,
          // veg_score は利用者から受け取らない (#2025。サーバの計算値 = 写真の解析だけが書く)
          quality_tags: nutritionData.quality_tags,
          updated_at: new Date().toISOString(),
        })
        .eq('id', plannedMealId);

// (2) プロンプトから `"veg_score": number (1-5),` の行を消す (応答の形は calories_kcal / protein_g / fat_g / carbs_g / quality_tags / dishes)

// (3) imageUrl の分岐の updatePayload から `veg_score: result.veg_score,` の 1 行を消す
        const updatePayload: Record<string, unknown> = {
          ...aiNutrients,
          // veg_score は書かない (#2025。fast LLM の 1〜5 点は写真の解析の 0〜100 点と尺度が違い、正本ではない)
          quality_tags: result.quality_tags,
          dishes: photoDishes.length > 0 ? photoDishes : existing.dishes ?? null,
          image_url: imageUrl,
          updated_at: new Date().toISOString(),
        };
```

応答 (`{ success: true, nutritionData }` / `{ success: true, nutritionData: result }`) の形は変えない (AI の応答に `veg_score` が入っていてもそのまま返すが、保存はしない)。

### 7.14 hook 2 本の差分 (完了は RPC)

#### 7.14.1 `src/hooks/useHomeData.ts` (Web のホーム)

```ts
// tsc:skip (既存ファイルの差分の断片)
// import に足す (formatLocalDate と同じ行から)
import { formatLocalDate, pantryExpiringSoonUntil, PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs } from "@homegohan/shared";

    // DB更新 (完了は RPC。completed_at は DB が決める。#2025)
    const { error } = await supabase.rpc(PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs(mealId, newStatus));
```

楽観的更新 (`completedAt: newStatus ? new Date().toISOString() : null`) と失敗時の戻し・`fetchHomeData()` は今のまま (画面の時刻は読み直しで DB の値に置き換わる)。

#### 7.14.2 `apps/mobile/src/hooks/useHomeData.ts` (モバイルのホーム)

```ts
// tsc:skip (既存ファイルの差分の断片)
// import に足す (formatCalendarDate と同じ行から)
import { formatCalendarDate, pantryExpiringSoonUntil, todayCalendarDate, todayLocal, PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs } from "@homegohan/shared";

    const { error } = await supabase.rpc(PLANNED_MEALS_SET_COMPLETED_RPC, plannedMealsSetCompletedArgs(mealId, newStatus));
```

楽観的更新・失敗時の戻し・`fetchAll()` は今のまま。

### 7.15 `supabase/functions/analyze-meal-photo/index.ts` の差分 (背景の処理の書き込みを service_role に)

```ts
// tsc:skip (Deno の既存ファイルの差分の断片)
// analyzeMealPhotoBackgroundTask の中。利用者の client (supabase) は解析 (analyzeWithEvidence) と Storage のアップロードに使い続ける。
// planned_meals の書き込みは service_role の client (writer) で行う。利用者の権限では veg_score を書けない (#2025)。
// service_role は RLS を通らないので、書く前に本人の行であることを必ず確かめる (save-meal.ts の「最終防衛線」と同じ考え)。
const writer = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SERVICE_ROLE_JWT') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
)

// (meal_image_jobs の取り消しは、今まで try の中で作っていた queueDb を writer に置き換える)
await cancelPendingMealImageJobs({ supabase: writer, userId, plannedMealId: mealId, reason: 'photo overwrite' })

// 本人の行か (user_daily_meals.user_id = userId)。無ければ書かずに終える (他人の mealId・消えた献立)
const { data: owned, error: ownedError } = await writer
  .from('planned_meals')
  .select('id, user_daily_meals!inner(user_id)')
  .eq('id', mealId)
  .eq('user_daily_meals.user_id', userId)
  .maybeSingle()
if (ownedError) throw ownedError
if (!owned) throw new Error(PLANNED_MEAL_NOT_FOUND_CODE)

const { error: updateError } = await writer
  .from('planned_meals')
  .update({
    dish_name: dishName || '写真から入力',
    dishes: photoDishes,
    image_url: imageUrl,
    description: result.praiseComment,
    // 栄養素 (基本・拡張・糖質)。書く列は meal-photo-update.ts に集約している (#1146)
    ...buildPhotoOverwriteNutrition(result),
    // 野菜スコア (0〜100。_shared/veg-score.ts の尺度。#2025 の正本)
    veg_score: result.vegScore,
    // メタデータ
    is_simple: result.dishes.length <= 1,
    mode: 'cook',
    updated_at: new Date().toISOString(),
  })
  .eq('id', mealId)
```

- `PLANNED_MEAL_NOT_FOUND_CODE` は Edge では `_shared/veg-score.ts` に置かず、`index.ts` の先頭で `const PLANNED_MEAL_NOT_FOUND_CODE = 'PLANNED_MEAL_NOT_FOUND'` と定義する (Edge は `packages/shared` を import しない。値は §7.5 と同じ。`tests/veg-score-scale-contract.test.ts` が一致を見る)。
- 既存の `catch` (`createLogger('analyze-meal-photo').withUser(userId).error(...)`) はそのまま。他人の `mealId` は今まで RLS で黙って 0 行だったが、本書の後はこの例外がログに残る (書き込みは起きない)。
- `update` の本文の列は今までと同じ (`tests/analyze-meal-photo-sugar.test.ts` の「update は 1 か所・栄養の列は `buildPhotoOverwriteNutrition(result)`・`veg_score` は手書き」はそのまま通る。`select` は update に数えない)。
- `writer` の変数名と `createClient(... SERVICE_ROLE_JWT ... SUPABASE_SERVICE_ROLE_KEY ...)` の形は、`tests/planned-meals-score-integrity-writers-scan.test.ts` (§7.21) が逐語で見る。

### 7.16 `supabase/functions/_shared/nutrition-pipeline.ts` の差分 (`estimateVegetableScore` を尺度の正本に寄せる)

```ts
// tsc:skip (Deno の既存ファイルの差分の断片)
import { vegScoreOfVegetableGrams } from './veg-score.ts'

// estimateVegetableScore を export し、式を veg-score.ts に寄せる (値は今までと同じ。有限でない量は 0)
export function estimateVegetableScore(dishes: AnalyzedDish[]): number {
  const vegetableGrams = dishes.reduce((sum, dish) => (
    sum + dish.ingredients.reduce((dishSum, ingredient) => (
      dishSum + (isVegetableIngredient(ingredient.name, ingredient.matched?.name) ? ingredient.amount_g : 0)
    ), 0)
  ), 0)

  return vegScoreOfVegetableGrams(vegetableGrams)
}
```

`export` にするのは `tests/veg-score-scale-contract.test.ts` から直接呼ぶため (`nutrition-pipeline.ts` は supabase-js と Gemini の module を import するので、テストは `vegScoreOfVegetableGrams` の方を主に確かめ、`estimateVegetableScore` は「その関数を呼ぶ」ことを AST で見る)。

### 7.17 `supabase/functions/calculate-segment-stats/index.ts` の差分 (`nutrition_score` の係数)

```ts
// tsc:skip (Deno の既存ファイルの差分の断片)
import { nutritionScoreOfVegScoreAverage } from '../_shared/veg-score.ts';

    case 'nutrition_score': {
      const sum = bulk.vegScoreSum.get(userId) ?? 0;
      const cnt = bulk.vegScoreCount.get(userId) ?? 0;
      // veg_score は 0〜100 (写真の解析の尺度。#2025)。以前は 1〜5 点を前提に × 20 していた
      return cnt > 0 ? nutritionScoreOfVegScoreAverage(sum / cnt) : 0;
    }
```

`veg_score_avg` の分岐 (`Math.round((sum / cnt) * 10) / 10`) は変えない。

### 7.18 `src/types/database.types.ts`・`packages/shared/src/database.types.ts` (段 A で生成し直す。追記の形)

`Functions` の節に次が入る (`supabase gen types` の出力。手書きしない。`tests/database-types-migrations-contract.test.ts` の「型の作り直し方」の手順で生成し、2 本を同じ中身にする)。

```ts
// tsc:skip (生成物の断片。アルファベット順で planner_* の後・plan_* の前後の位置は生成に従う)
      planned_meals_set_completed: {
        Args: { p_completed: boolean; p_meal_id: string }
        Returns: {
          id: string
          is_completed: boolean
          completed_at: string
          updated_at: string
        }[]
      }
```

`completed_at` / `updated_at` の null の有無は生成物のとおりにする (RETURNS TABLE の列は NOT NULL の情報を持たないので、生成は `string` と出す。アプリは §7.7 の Zod (`nullable()`) で読む)。
