# @homegohan/core

Web / Mobile 共通の **API クライアント・計算エンジン** パッケージ。
純粋ロジック・定数は `@homegohan/shared` に置く。

## 境界定義

| カテゴリ | 内容 | 例 |
|--------|------|-----|
| HTTP client | fetch ラッパー・認証トークン付与 | `createHttpClient`, `HttpClient` |
| 栄養計算エンジン | DRI2020 準拠の栄養目標計算 | `calculateNutritionTargets` |
| 型定義 | API・プロフィール型 | `UserProfileLite`, `NutritionCalculatorInput` |
| Zod スキーマ | API レスポンス検証 | `DishSchema`, `MenuResponseSchema` |
| 週計算 | 週範囲・日付操作 | `getWeekRange`, `shiftWeek` |
| アダプティブループ | チェックイン分析・推奨調整 | `analyzeCheckinLoop`, `applyRecommendations` |

## 含めないもの

- 純粋定数・ラベル → `@homegohan/shared`
- UI コンポーネント → 各プラットフォームの `src/components`
- Supabase client インスタンス → 各プラットフォームで初期化 (環境変数が異なるため)
- プラットフォーム固有のストレージ → 各プラットフォームの `src/lib`

## インポート方法

```ts
import { createHttpClient, calculateNutritionTargets } from '@homegohan/core';
```

## モジュール一覧

| ファイル | エクスポート |
|---------|------------|
| `api/httpClient.ts` | `createHttpClient`, `HttpClient`, `GetAccessToken` |
| `nutrition/calculate.ts` | `calculateNutritionTargets` |
| `nutrition/types.ts` | `NutritionCalculatorInput`, `NutritionCalculationResult`, etc. |
| `nutrition/dri-tables.ts` | DRI2020 参照テーブル |
| `nutrition/adaptive-loop.ts` | `analyzeCheckinLoop`, `applyRecommendations` |
| `schemas/dish.ts` | `DishSchema`, `DishRole`, `Dish` |
| `schemas/menu-response.ts` | `MenuResponseSchema` |
| `schemas/generation-config.ts` | `GenerationConfigSchema` |
| `types/userProfile.ts` | `UserProfileLite`, `DbUserProfileLite` |
| `converters/userProfile.ts` | `toUserProfileLite` |
| `utils/week-utils.ts` | `getWeekRange`, `shiftWeek`, `formatLocalDate`, `getDaysBetween` |
