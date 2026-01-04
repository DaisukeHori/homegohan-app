# Plan: V4汎用献立生成（generate-menu-v4）ステップ実行方式（V3踏襲）

## 目的
- V4（`supabase/functions/generate-menu-v4`）を **V3のステップ実行方式（自己トリガ＋継続）** に揃え、最大31日/93スロットでもタイムアウト・再開性・品質（レビュー/修正）を担保する。
- V4は「渡された`targetSlots`だけを生成/更新する」原則を維持しつつ、**V3のLLM運用（検索→日単位生成→レビュー→必要枠だけ修正）** を“超参考”で移植する。

## 参照（詳細設計の根拠）
- `SPECIFICATION.md`
  - **8.7 汎用献立生成エンジン（V4）**（パラメータ/targetSlots/ジョブ管理）
- `DESIGN.md`
  - **V4パイプライン図**（コンテキスト→プロンプト→日単位生成→栄養→保存）
  - **Edge Function: generate-menu-v4**（日単位並列生成/対象スロットのみ保存）
- V3実装（コードが真実）
  - `supabase/functions/generate-weekly-menu-v3/index.ts`
    - `triggerNextStep()` / `_continue` / `SERVICE_ROLE_JWT` の扱い
    - Step1→Step2→Step3 の分割と `current_step` / `generated_data` の利用
    - `reviewWeeklyMenus` / `regenerateMealForIssue` / swap適用
    - 栄養の低カロリー疑義に対する `validateAndAdjustNutrition`

## 対象範囲（このPlanで扱う詳細設計項目）
- **BE-Edge/V4-01**: `generate-menu-v4` をステップ実行方式に変更（V3互換の自己トリガ）
- **BE-Edge/V4-02**: Step1（日単位生成）を日付バッチで分割（再開可能に）
- **BE-Edge/V4-03**: Step2（レビュー/修正）を「2件/週」スケール＋必要なら分割実行
- **BE-Edge/V4-04**: Step3（栄養/保存）をスロットバッチで分割（再開可能に）
- **BE-API/V4-05**: plannedMealId の所有権/整合性検証（サービスロール更新のため必須）
- **QA/V4-06**: V4 Supabase Functions の自動テスト（約20ケース）

## 非対象（今回やらない）
- UI改善（モーダル/選択モードなどの追加改善）
- 既存ページの進捗表示の大幅改修（progressの表示改善は後続）
- 埋め込み再生成などの別機能

---

## 詳細設計：契約（API Route → Edge Function）

### 初回呼び出し（API Routeから）
- 呼び出し元: `src/app/api/ai/menu/v4/generate/route.ts`
- 認可: サーバー側でサービスロールキーを用いて Edge Function を呼ぶ（`Authorization: Bearer <service role>`）
- body（概略）:
  - `requestId`（= `weekly_menu_requests.id`）
  - `userId`
  - `mealPlanId`
  - `targetSlots`（camelCase）
  - `existingMenus`, `fridgeItems`, `userProfile`, `seasonalContext`, `constraints`, `note`, `familySize`

### 継続呼び出し（Edge Function → Edge Function 自己トリガ）
- V3と同じ方式で自己呼び出しする
  - headers:
    - `Authorization: Bearer ${SERVICE_ROLE_JWT || SUPABASE_SERVICE_ROLE_KEY}`
    - `apikey: ${同じキー}`
  - body:
    - `request_id`（snake）
    - `userId`
    - `_continue: true`

#### 注意（V3で詰まったポイントを必ず踏襲）
- `_continue: true` の場合、Authorizationはサービスロールになるため `supabase.auth.getUser()` が使えない
  - **body.userId を必須**にして継続する（V3同様）

---

## 詳細設計：ジョブ状態（weekly_menu_requests）

### 使用する列
- `weekly_menu_requests.current_step`: 1/2/3（ステップ番号）
- `weekly_menu_requests.generated_data`: ステップ内のカーソルや中間成果（JSONB）
- `weekly_menu_requests.progress`: UI表示用の進捗（JSONB）
- `weekly_menu_requests.target_slots`: V4生成対象（JSONB）
- `weekly_menu_requests.status`: `processing` / `completed` / `failed`

### generated_data（V4）スキーマ（概略）
- `mealPlanId`
- `dates`（対象日付一覧）
- `targetSlots`（正規化済み）
- `userProfile`, `fridgeItems`, `existingMenus`, `seasonalContext`, `constraints`, `note`, `familySize`
- `nutritionTargets`, `userContext`, `userSummary`, `references`
- `generatedMeals`: `{ \"YYYY-MM-DD:mealType\": GeneratedMeal }`
- `step1`: `{ cursor, batchSize }`（日付カーソル）
- `step2`: `{ reviewResult, issuesToFix, fixCursor, maxFixes, fixesPerRun, swapsApplied }`
- `step3`: `{ cursor, batchSize, savedCount, errors }`（スロットカーソル）

---

## 詳細設計：ステップ構成（V3踏襲＋V4汎用化）

### Step1: 生成（分割実行）
- 目的: `targetSlots` を満たす `generatedMeals` を `generated_data` に蓄積
- V3踏襲ポイント:
  - `buildSearchQueryBase` → `search_menu_examples`
  - 朝/昼/夕は **日単位**で `generateDayMealsWithLLM`（整合性/被り回避）
  - 間食/夜食は単体 `generateMealWithLLM`
- 分割単位: **日付バッチ**（例: 6日/回）
- 進捗: `progress.completedSlots` は「生成済みslot数」
- 完了条件: `step1.cursor >= dates.length` → `current_step=2`

### Step2: レビュー→修正（必要なら分割）
- 目的: 生成結果の重複/偏りをレビューし、問題枠のみ差し替え
- V3踏襲ポイント:
  - `reviewWeeklyMenus`（俯瞰レビュー）
  - `regenerateMealForIssue`（問題枠だけ再生成）
  - swaps（同日昼夜の入れ替え）適用
- 修正件数:
  - **2件/週（=7日）を基本**
  - `maxFixes = min(issuesToFix.length, ceil(days/7)*2, 12)`
- 分割単位: 修正バッチ（例: 3件/回）で `fixCursor` を進める
- 完了条件:
  - `fixCursor >= maxFixes` ＆ swaps適用済み → `current_step=3`

### Step3: 栄養計算＋保存（分割実行）
- 目的: `generatedMeals` を DB（`meal_plan_days` / `planned_meals`）へ反映
- V3踏襲ポイント:
  - `calculateNutritionFromIngredients`
  - 低カロリー等の疑義に `validateAndAdjustNutrition`（参照レシピ補正）
  - `dishes` JSONに栄養・材料Markdown等を格納（画面/買い物導線整合）
- 分割単位: スロットバッチ（例: 15枠/回）
- 完了条件:
  - `step3.cursor >= targetSlots.length` → `status=completed|failed`

---

## 所要時間見積もり（目安）
- Step1（生成）:
  - 1日（朝昼夕）: 8〜25秒
  - 7日: 40〜120秒
  - 31日: 3〜8分（※分割必須）
- Step2（レビュー/修正）:
  - レビュー: 5〜20秒
  - 修正: 1件あたり+5〜20秒（バッチ分割で吸収）
- Step3（栄養/保存）:
  - 1枠: 1〜4秒
  - 21枠: 30〜120秒
  - 93枠: 2〜6分（※分割必須）

---

## テスト計画（V4 Supabase Functions：概ね20ケース）
目的: ステップ実行/再開性/修正予算/保存の安全性（既存保護）を担保する

### 自動テスト（約20）
- **T01**: Step1 日付バッチのカーソル進行（cursor/batchSize）
- **T02**: Step1 完了→ `current_step=2` 遷移
- **T03**: Step1 途中→ `current_step=1` のまま継続トリガ
- **T04**: Step2 `maxFixes` が `2/週` で増える（7/14/31日）
- **T05**: Step2 `fixesPerRun` 分割で `fixCursor` が進む
- **T06**: Step2 swapsは「同日・両方target・両方generated」時のみ適用
- **T07**: Step2 完了→ `current_step=3` 遷移
- **T08**: Step3 slotバッチのカーソル進行（cursor/batchSize）
- **T09**: Step3 完了→ status=completed（errorsなし）
- **T10**: Step3 errorsあり→ status=completed かつ error_message 記録（成功>0）
- **T11**: `_continue=true` で `userId` 不在→ 失敗
- **T12**: `_continue=true` で `current_step` をDBから読む
- **T13**: `target_slots` の正規化（snake→camel相当）
- **T14**: `targetSlots` のソート順（date→mealType）
- **T15**: `generatedMeals` のキー（YYYY-MM-DD:mealType）
- **T16**: plannedMealId所有権チェック（不正ID→API 404）
- **T17**: plannedMealIdの日付/mealType不一致→API 400
- **T18**: 「空欄保護」：plannedMealIdなしで既存枠がある場合 insertしない
- **T19**: 「上書き」：plannedMealIdありで update される
- **T20**: progress更新で `updated_at` が更新され続ける（stale回避）

---

## 実装完了の定義
- Plan記載の対象範囲（BE-Edge/API/QA）が実装されている
- 自動テストが概ね20件存在し、ローカルで実行できる
- V3の自己トリガ/JWT運用と同等の動作（_continue/body.userId/Authorization/apikey）が担保されている

