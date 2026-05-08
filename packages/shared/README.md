# @homegohan/shared

Web / Mobile 共通の **純粋ロジック** パッケージ。
DOM、React Native、Supabase など、実行環境に依存するコードは含まない。

## 境界定義

| カテゴリ | 内容 | 例 |
|--------|------|-----|
| 型 | ドメイン定数型 | `DishRole`, `MealType`, `ModeKey` |
| 定数 | 表示ラベル・フェーズ定義 | `MEAL_LABELS`, `PROGRESS_PHASES`, `NUTRIENT_DEFINITIONS` |
| util | 純粋関数（副作用なし） | `formatLocalDate`, `todayLocal`, `getDishConfig` |
| 栄養プランナー | PFC 計算・目標予測 | `deriveMacroTargets`, `estimateGoalProjection` |

## 含めないもの

- HTTP client・fetch ラッパー → `@homegohan/core`
- Supabase client → `@homegohan/core`
- ストレージ抽象 (localStorage / AsyncStorage) → 各プラットフォームの実装
- UI コンポーネント → 各プラットフォームの `src/components`

## インポート方法

```ts
import { formatLocalDate, getDishConfig, MEAL_LABELS } from '@homegohan/shared';
```

## モジュール一覧

| ファイル | エクスポート |
|---------|------------|
| `date-utils.ts` | `formatLocalDate`, `todayLocal`, `parseLocalDate`, `addDays` |
| `nutrition-planner.ts` | `deriveMacroTargets`, `estimateGoalProjection` |
| `dish-roles.ts` | `DishRole`, `DishConfig`, `getDishConfig` |
| `meal-types.ts` | `MealType`, `MEAL_LABELS`, `MEAL_ORDER` |
| `mode-config.ts` | `ModeKey`, `ModeConfig`, `MODE_CONFIG` |
| `nutrition-constants.ts` | `NUTRIENT_DEFINITIONS`, `getNutrientDefinition`, `calculateDriPercentage` |
| `theme-labels.ts` | `THEME_LABELS_REQUEST`, `AI_CONDITIONS` |
| `progress-phases.ts` | `PROGRESS_PHASES`, `ULTIMATE_PROGRESS_PHASES`, `SHOPPING_LIST_PHASES` |
