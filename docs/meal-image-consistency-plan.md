# Meal Image Consistency Plan

## Goal

AI献立で表示される料理画像と、料理詳細で表示される画像の不整合をなくす。

このために、画像の正本を「meal単位」ではなく「dish単位」に寄せる。
`planned_meals.image_url` は最終的に meal cover として扱い、詳細画面の正本は `dishes[*].image_url` にする。

## Verified Baseline

2026-03-17 時点で以下を実行し、すべて成功。

- `npm test`
- 結果: 22 files / 141 tests passed

関連して確認できた既存契約。

- `tests/image-route-contracts.test.ts`
  - `/api/ai/image/generate` は `gemini-3.1-flash-image-preview` を既定利用
  - `/api/meal-plans/meals/[id]` PATCH は `imageUrl -> planned_meals.image_url` を保存
- `tests/catalog-meal-route-contracts.test.ts`
  - catalog selection と manual override の整合性は既にテストあり
- `tests/v4-supabase-functions.test.ts`
  - `generate-menu-v4` 周辺の基礎契約あり

## Current State

現状の画像保存先は `planned_meals.image_url` のみ。

- 一覧/カード/ホームで見る画像: meal単位
- 詳細モーダルで出すべき画像: 現時点では meal単位を流用
- dish単位画像: 未保存

そのため、1食に複数料理がある場合に「食事画像」と「料理詳細画像」の正本が分離できていない。

## Inventory: Generation Entry Points

以下は AI で献立や料理を生成または再生成する入口。
画像ジョブを漏れなく拾うため、この経路を全てカバーする必要がある。

| Kind | Path | Role | Notes |
|---|---|---|---|
| Weekly generate | `src/app/api/ai/menu/weekly/request/route.ts` | 7日 x 3食を作る | `generate-menu-v4` を間接起動 |
| Generic V4 generate | `src/app/api/ai/menu/v4/generate/route.ts` | 任意 `targetSlots` を作る | Web UI の汎用入口 |
| Single meal generate | `src/app/api/ai/menu/meal/generate/route.ts` | 1食新規生成 | `generate-menu-v4` を間接起動 |
| Single meal regenerate | `src/app/api/ai/menu/meal/regenerate/route.ts` | 既存1食再生成 | `plannedMealId` 指定 |
| Day regenerate | `src/app/api/ai/menu/day/regenerate/route.ts` | 1日分再生成 | 朝昼夜をまとめて更新 |
| AI consultation | `src/app/api/ai/consultation/actions/[actionId]/execute/route.ts` | `generate_day_menu` / `generate_week_menu` / `generate_single_meal` | 相談アクションから生成 |
| Nutrition analysis regenerate | `src/app/api/ai/nutrition-analysis/route.ts` | 1食再生成 | `plannedMealId` 指定で `generate-menu-v4` を同期起動 |

## Inventory: Shared Final Save Point

AI献立の共通保存ポイントは1箇所に寄せられている。

- `supabase/functions/generate-menu-v4/index.ts`
  - `saveMealToDb(...)`
  - `executeStep6_FinalSave(...)`

`saveMealToDb(...)` が `planned_meals` の insert/update を行うため、AI生成起点の画像ジョブ enqueue はここが第一候補。

このポイントを使えば、次の経路をまとめて拾える。

- 週間生成
- 単発生成
- 単発再生成
- 日単位再生成
- 相談アクション経由の生成
- 栄養分析からの再生成

## Inventory: Non-Generation Mutation Entry Points

以下は `planned_meals` を直接変更する経路。
画像を再利用するのか、無効化するのか、再生成を積むのかを経路ごとに決める必要がある。

| Kind | Path | Mutation | Image handling needed |
|---|---|---|---|
| Web manual edit | `src/app/api/meal-plans/meals/[id]/route.ts` | `dishName`, `dishes`, `mode`, `imageUrl`, catalog linkage | 変更内容に応じて keep / stale / manual override |
| Web manual add | `src/app/api/meal-plans/meals/route.ts` | 新規 `planned_meal` insert | 初期画像状態の定義が必要 |
| Web photo add | `src/app/api/meal-plans/add-from-photo/route.ts` | 写真解析結果を insert | meal photo と dish image の関係を定義 |
| Web photo analyze update | `src/app/api/ai/analyze-meal-photo/route.ts` + `supabase/functions/analyze-meal-photo/index.ts` | 解析後に meal 更新 | user photo をどう dish に反映するか定義 |
| Mobile detail edit | `src/app/api/meals/[id]/route.ts` | meal fields update | keep / stale / regenerate ルールが必要 |
| Mobile manual add | `src/app/api/meals/route.ts` | 新規 insert | 初期画像状態の定義が必要 |
| Mobile photo meal create | `apps/mobile/app/meals/new.tsx` | Supabase直書き insert/delete | API共通化かロジック複製回避が必要 |
| AI consultation direct update | `src/app/api/ai/consultation/actions/[actionId]/execute/route.ts` | `update_meal`, `delete_meal`, `complete_meal` | 画像の stale 判定が必要 |
| Manual image generation | `src/app/api/ai/image/generate/route.ts` | 現状は meal image のみ生成 | dish正本へ移行が必要 |

## Required Design Decision

### 1. Canonical image unit

正本は `dish`。

- 詳細画面は `dishes[*].image_url` を最優先
- `planned_meals.image_url` は meal cover として扱う
- 1 dish の meal では meal cover = dish image
- 複数 dish の meal では meal cover は dish images から作る

### 2. Do not use a separate AI scene as canonical

「食卓の1枚絵」を別生成して正本にすると、料理詳細とズレる。

許容するなら以下の位置づけにする。

- `scene_image_url`: 任意の演出用
- canonical には使わない
- 詳細画面には使わない

### 3. Model

利用モデルは `Nano Banana 2`。

- 実体: `gemini-3.1-flash-image-preview`
- 現行の `/api/ai/image/generate` 既定値も同じ

## Proposed Data Model

### Dish JSON extension

`types/domain.ts` の `DishDetail` と `planned_meals.dishes` JSON に以下を追加する。

- `image_url?: string | null`
- `image_source?: 'generated_ai' | 'meal_photo' | 'manual_override' | 'catalog' | 'none'`
- `image_status?: 'pending' | 'ready' | 'failed' | 'stale'`
- `image_prompt?: string | null`
- `image_model?: string | null`
- `image_subject_hash?: string | null`
- `image_generated_at?: string | null`
- `image_error?: string | null`

### Meal-level fields

既存 `planned_meals.image_url` は残す。

- 意味を `meal cover` に変更
- 可能なら将来 `scene_image_url` を別に追加
- ただし最初の実装では `planned_meals.image_url` を cover のまま流用してよい

### Job table

新規テーブル `meal_image_jobs` を追加する。

推奨カラム:

- `id`
- `user_id`
- `planned_meal_id`
- `dish_index`
- `dish_name`
- `subject_hash`
- `prompt`
- `reference_image_urls jsonb`
- `status` (`pending` / `processing` / `completed` / `failed` / `cancelled`)
- `attempt_count`
- `last_error`
- `requested_by`
- `created_at`
- `updated_at`

目的:

- 生成と保存を非同期化
- generate-menu-v4 から外部画像APIを直接叩かない
- 冪等制御を `subject_hash` で行う

## Consistency Rules

### Rule A: What changes require regen

以下が変わったら dish image を stale にして再生成対象にする。

- `dishes[].name`
- `dishes[].role`
- `dishes[]` の件数
- dish の表示順
- catalog selection による実質的な料理変更
- photo analysis による dish identification の更新
- AI regenerate による dish replacement

### Rule B: What changes do not require regen

以下だけなら画像は維持する。

- `is_completed`
- `display_order`
- `description`
- 栄養値だけの補正
- `mode` 単独変更

### Rule C: Manual override priority

ユーザーが手動で画像を差し替えた場合は `manual_override` とする。

- subject hash が変わらない限り自動再生成で上書きしない
- subject hash が変わったら `stale` に落とし、cover選定から外す
- 必要なら旧URLは消さずに残してもよいが、表示には使わない

### Rule D: Meal cover derivation

meal cover は次の順序で決める。

1. `dishes.length === 1` かつ `dish.image_status === ready` のとき、その `dish.image_url`
2. 複数 dish で ready が2件以上あるとき、dish images からコラージュを作った `planned_meals.image_url`
3. 複数 dish で一部しか ready でないとき、先頭の ready image
4. none のとき、placeholder

別AI生成の「食卓シーン画像」は cover の補助としては使えても、正本にはしない。

## How to Handle Photo-Based Meals

写真由来の meal は AI献立とは別ルールにする。

### Single-dish photo

- meal photo を `planned_meals.image_url` に保存
- 同じ URL を `dishes[0].image_url` にも入れてよい
- `image_source = 'meal_photo'`

### Multi-dish photo

- meal photo は `planned_meals.image_url` に保存
- 各 dish に同じ全体写真を正本として複製しない
- 詳細は暫定的に meal photo fallback を表示してよい
- 必要なら later phase で `meal photo + dish name` を reference にした dish image generation を行う

## Where to Hook the Queue

### Primary hook

`supabase/functions/generate-menu-v4/index.ts` の `saveMealToDb(...)` の直後。

ここで行うこと:

- `dish.image_subject_hash` を計算
- `dish.image_status = 'pending'`
- `dish.image_url = null` または stale 判定に応じて維持
- `meal_image_jobs` に enqueue

この位置なら AI生成系の全入口を共通化できる。

### Secondary hooks

AI生成以外の更新でも stale 判定が必要。

- `src/app/api/meal-plans/meals/[id]/route.ts`
- `src/app/api/meals/[id]/route.ts`
- `src/app/api/meal-plans/meals/route.ts`
- `src/app/api/meals/route.ts`
- `src/app/api/meal-plans/add-from-photo/route.ts`
- `supabase/functions/analyze-meal-photo/index.ts`
- `src/app/api/ai/consultation/actions/[actionId]/execute/route.ts`
- `apps/mobile/app/meals/new.tsx`

## Worker Placement

推奨は「enqueue はどこからでも行える」「画像生成は専用 worker が行う」構成。

### Recommended split

- `generate-menu-v4` / PATCH routes / photo routes
  - DBに job を積むだけ
- Next.js server worker
  - job を取得
  - Nano Banana 2 を呼ぶ
  - Storage に保存
  - `dishes[*].image_*` と `planned_meals.image_url` を更新

### Why not generate inline everywhere

- 画像生成は遅い
- quota と retry 制御が必要
- 同一 meal が複数経路から更新される
- 失敗時に meal 本体保存だけ成功、画像だけ再試行にしたい

## Prompt Strategy

prompt は dish ごとに固定化する。

最低限含める情報:

- dish name
- role
- key ingredients
- cuisine style
- serving style

生成の再現性を上げるために以下も保存する。

- `image_prompt`
- `image_model`
- `image_subject_hash`

## UI Rules

### Recipe detail modal

- まず `selectedRecipeData.imageUrl`
- 将来的には `dish.image_url` を優先
- fallback で `meal.imageUrl`

### Weekly cards and home cards

- `planned_meals.image_url` を表示
- これは canonical dish image から導出された cover

### Loading state

- `dishes[*].image_status = pending` のとき skeleton
- `failed` のとき retry affordance

## Implementation Order

### Phase 1

- `DishDetail` に image metadata を追加
- 詳細モーダルは `dish.image_url` 優先、`meal.imageUrl` fallback に変更
- `saveMealToDb(...)` で dish subject hash を保存

### Phase 2

- `meal_image_jobs` テーブル追加
- enqueue helper 実装
- `generate-menu-v4` の `saveMealToDb(...)` から enqueue

### Phase 3

- worker 実装
- Nano Banana 2 呼び出しを shared helper 化
- cover image derivation 実装

### Phase 4

- manual edit / mobile edit / consultation update の stale 判定実装
- photo-based meals の single/multi dish ルール実装

## Test Plan To Add

### Contract tests

- `saveMealToDb(...)` が new/update 双方で image job を enqueue する
- `meal.regenerate` / `meal.generate` / `day.regenerate` / `weekly.request` が最終的に同じ enqueue 経路へ流れる
- `consultation generate_*` も同じ enqueue 経路へ流れる

### Mutation tests

- `meal-plans PATCH` で `dishName` 変更時は stale + enqueue
- `meal-plans PATCH` で `description` 変更のみなら keep
- `meals PATCH` でも同じ判定
- `consultation update_meal` でも同じ判定

### Photo tests

- single-dish photo は `meal_photo` として meal/dish に反映
- multi-dish photo は meal photo のみ canonical、dish は fallback 扱い

### UI tests

- detail modal が `dish.image_url` を優先表示
- fallback が `meal.imageUrl`

## Immediate Next Step

次に着手すべき最小単位は以下。

1. `DishDetail` の image metadata を型へ追加
2. `generate-menu-v4` の `saveMealToDb(...)` で `image_subject_hash` を保存
3. `meal_image_jobs` migration を作成
4. enqueue helper と worker の骨組みを作る
