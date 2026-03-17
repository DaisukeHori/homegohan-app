# Meal Image Specification

## Purpose

献立一覧と料理詳細で表示される画像の意味を揃え、生成・再生成・手動更新のどの経路を通っても画像整合性が崩れないようにする。

## Problem Statement

現状は `planned_meals.image_url` のみが存在し、meal 単位の画像しか持てない。
そのため、複数料理を含む 1 食で以下の問題が起きる。

- 献立カードの画像と料理詳細の画像が同じ意味を持たない
- 料理ごとの詳細を開いても、料理単位の正本画像が存在しない
- AI生成、写真解析、手動編集の各経路で画像更新ルールが統一されていない

## Definitions

- `dish image`
  - 個別料理の正本画像
- `meal cover`
  - 1 食全体を一覧で見せるためのカバー画像
- `stale`
  - 料理内容の変更により、既存画像を表示継続してはいけない状態
- `manual override`
  - ユーザーが手動指定した画像。自動再生成より優先する

## Source Of Truth

画像の正本は `planned_meals.dishes[*]` に保存される `dish image` とする。

- 詳細画面は `dishes[*].image_url` を正本として扱う
- `planned_meals.image_url` は `meal cover` として扱う
- 1 料理の meal では `meal cover = dish image`
- 複数料理の meal では `meal cover` は dish images から導出する

別AI生成の食卓シーン画像は canonical にしない。

## Scope

### Phase 1 scope

- `DishDetail` に画像メタデータを追加
- AI献立保存時に `dish image` の subject hash を計算する
- 画像生成ジョブを enqueue する
- 詳細画面を `dish.image_url` 優先、`meal.imageUrl` fallback にする
- `planned_meals` の直接更新経路で stale 判定を導入する

### Out of scope for Phase 1

- 食卓シーン画像の新設
- 複数料理 meal の高品質コラージュ生成
- 画像生成ジョブの高度な優先度制御
- 過去画像の自動削除

## Functional Requirements

### FR-1 Canonical storage

各 dish は以下の画像メタデータを持つ。

- `image_url`
- `image_source`
- `image_status`
- `image_prompt`
- `image_model`
- `image_subject_hash`
- `image_generated_at`
- `image_error`

### FR-2 AI generation path

`generate-menu-v4` が meal を保存したとき、各 dish について以下を行う。

- `image_subject_hash` を計算
- `image_status = 'pending'`
- `image_prompt` を保存
- `meal_image_jobs` に 1 dish 1 job で enqueue

### FR-3 Direct mutation path

AI生成以外の更新経路で `dish` の内容が変わった場合、対象 dish は stale になる。

- stale の定義は `name`, `role`, `dish count`, `dish order`, catalog による実質的な料理変更
- stale になった dish は `image_status = 'stale'`
- 自動再生成対象なら enqueue
- `manual_override` は subject hash が変わるまで維持

### FR-4 Photo-based meals

写真由来の meal は別ルールで扱う。

- 単品写真:
  - `planned_meals.image_url = uploaded meal photo`
  - `dishes[0].image_url = same url`
  - `image_source = 'meal_photo'`
- 複数料理写真:
  - `planned_meals.image_url = uploaded meal photo`
  - `dishes[*].image_url` は空でもよい
  - 詳細は `meal.image_url` fallback を表示してよい

### FR-5 UI fallback

料理詳細の表示順は以下。

1. `dish.image_url`
2. `meal.image_url`
3. placeholder

meal 一覧の表示順は以下。

1. `planned_meals.image_url`
2. 先頭 ready dish image
3. placeholder

### FR-6 Job idempotency

同一 dish 内容に対して重複 job を積まない。

- 冪等キーは `planned_meal_id + dish_index + image_subject_hash`
- `pending` または `processing` の同一キー job がある場合は新規 enqueue しない

### FR-7 Failure handling

画像生成に失敗しても meal 保存は成功扱いにする。

- `dish.image_status = 'failed'`
- `dish.image_error` を保存
- `meal cover` は fallback を使う

## Data Model

### DishDetail extension

`types/domain.ts` と `planned_meals.dishes` JSON の両方に以下を追加する。

```ts
image_url?: string | null;
image_source?: 'generated_ai' | 'meal_photo' | 'manual_override' | 'catalog' | 'none';
image_status?: 'pending' | 'ready' | 'failed' | 'stale';
image_prompt?: string | null;
image_model?: string | null;
image_subject_hash?: string | null;
image_generated_at?: string | null;
image_error?: string | null;
```

### New table: meal_image_jobs

最低限必要なカラム:

- `id uuid primary key`
- `user_id uuid not null`
- `planned_meal_id uuid not null`
- `dish_index integer not null`
- `dish_name text not null`
- `subject_hash text not null`
- `prompt text not null`
- `reference_image_urls jsonb not null default '[]'::jsonb`
- `status text not null`
- `attempt_count integer not null default 0`
- `last_error text null`
- `requested_by text not null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

推奨インデックス:

- unique index on `(planned_meal_id, dish_index, subject_hash, status)` filtered to `status in ('pending','processing')`
- index on `(status, created_at)`
- index on `(user_id, created_at desc)`

## Prompt Specification

`image_prompt` は dish ごとに deterministic に組み立てる。

最低限含める要素:

- dish name
- role
- main ingredients
- Japanese home-cooked meal context
- plating / close-up food photography

同一入力なら同一 prompt になることを優先する。

## Subject Hash

`image_subject_hash` は以下の正規化入力から算出する。

- normalized dish name
- normalized role
- normalized ingredient names
- display order

栄養値や説明文は hash に含めない。

## Lifecycle By Entry Point

### Through `generate-menu-v4`

- meal 保存
- dish image metadata 初期化
- job enqueue
- worker が生成
- dish 更新
- meal cover 再計算

### Through PATCH routes

- 更新前後の dish subject hash を比較
- 変化なし: 既存画像維持
- 変化あり:
  - manual override でなければ stale + enqueue
  - manual override なら stale にして自動上書きしない

### Through photo analysis

- 写真のアップロード URL を meal photo として保存
- 単品なら dish にも同じ URL を反映
- 複数なら fallback のみ

## API / Worker Boundaries

### Producers

以下は job producer として振る舞う。

- `supabase/functions/generate-menu-v4/index.ts`
- `src/app/api/meal-plans/meals/[id]/route.ts`
- `src/app/api/meals/[id]/route.ts`
- `src/app/api/meal-plans/meals/route.ts`
- `src/app/api/meals/route.ts`
- `src/app/api/meal-plans/add-from-photo/route.ts`
- `supabase/functions/analyze-meal-photo/index.ts`
- `src/app/api/ai/consultation/actions/[actionId]/execute/route.ts`
- `apps/mobile/app/meals/new.tsx` は API 共通化対象

### Worker

専用 worker が以下を実施する。

- pending jobs の取得
- Nano Banana 2 呼び出し
- Storage 保存
- `dishes[*].image_*` 更新
- `planned_meals.image_url` 再計算

## Acceptance Criteria

- AI生成された dish は保存時に `image_subject_hash` を持つ
- AI生成された dish は `pending` job を持つ
- detail modal は `dish.image_url` を優先表示する
- meal 内容が変わらない更新では既存画像を維持する
- meal 内容が変わる更新では stale になる
- 画像生成失敗時も meal 本体は残る
- 同一 hash の重複 job が積まれない

## Implementation Order

1. 型追加
2. migration 追加
3. image hash / prompt / enqueue helper 実装
4. `generate-menu-v4` 連携
5. PATCH 系 stale 判定
6. worker 実装
7. UI fallback 仕上げ
8. mobile 直書き経路の API 共通化
