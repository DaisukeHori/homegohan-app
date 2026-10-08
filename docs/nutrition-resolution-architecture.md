# Nutrition Resolution Architecture

## Purpose
This document separates the current nutrition-resolution responsibilities so V4, meal-photo analysis, and future maintenance do not drift again.

## Current Runtime Roles

| File | Role | Used By | Status |
|---|---|---|---|
| [supabase/functions/_shared/ingredient-matcher.ts](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/ingredient-matcher.ts) | Resolve free-form ingredient names to `dataset_ingredients` rows | meal-photo pipeline, V4 adapter | Active |
| [supabase/functions/_shared/ingredient-search-utils.ts](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/ingredient-search-utils.ts) | Merge vector/text candidates and decide when LLM can be skipped | ingredient matcher | Active |
| [supabase/functions/_shared/nutrition-calculator-v2.ts](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/nutrition-calculator-v2.ts) | Aggregate nutrition totals from matched ingredients | meal-photo pipeline, V4 adapter | Active |
| [supabase/functions/_shared/v4-nutrition-adapter.ts](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/v4-nutrition-adapter.ts) | Thin compatibility layer so V4 can use split matcher/calculator flow | `generate-menu-v4` | Active |
| [supabase/functions/_shared/nutrition-pipeline.ts](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/nutrition-pipeline.ts) | Orchestrate image analysis, ingredient matching, nutrition calculation, evidence checks | `analyze-meal-photo` | Active |
| [supabase/functions/_shared/evidence-verifier.ts](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/evidence-verifier.ts) | Recipe-reference lookup and validation support | meal-photo pipeline, V4 adapter | Active |
| [supabase/functions/_shared/nutrition-calculator.ts](/Users/horidaisuke/homegohan/homegohan-app/supabase/functions/_shared/nutrition-calculator.ts) | Legacy monolithic resolver/calculator kept for compatibility and shared constants | legacy paths, constant reuse | Shrinking |

## How V4 Works Now
1. `generate-menu-v4` estimates dish ingredients.
2. `v4-nutrition-adapter.ts` calls `ingredient-matcher.ts`.
3. `ingredient-search-utils.ts` merges exact, alias, text, and vector candidates.
4. `nutrition-calculator-v2.ts` aggregates totals.
5. `evidence-verifier.ts` / recipe similarity remains separate from raw matching.

This is intentionally different from the old monolithic `nutrition-calculator.ts` path.

## Why The Split Path Exists
- Ingredient resolution changes more often than nutrition aggregation.
- Text fallback and alias rules must be tunable without rewriting aggregation logic.
- V4 and meal-photo analysis should share matching behavior, not maintain separate heuristics.

## What Still Lives In The Legacy Layer
- `EXACT_NAME_NORM_MAP`
- `INGREDIENT_ALIASES`
- some cache and validation helpers
- compatibility types like `NutritionTotals`

The current direction is to keep those constants reusable while moving runtime matching and calculation to the split path.

## Practical Rule
- New matching logic belongs in `ingredient-matcher.ts` or `ingredient-search-utils.ts`
- New nutrition aggregation logic belongs in `nutrition-calculator-v2.ts`
- V4 should call the adapter, not rebuild resolver logic inline
- Legacy `nutrition-calculator.ts` should not regain new business logic unless it is strictly compatibility-only

## 糖質 (sugar_g) の定義 (#1146)
- 食材 DB (`dataset_ingredients`) に糖質の列は無い。糖質は **炭水化物 (`carbs_g`) − 食物繊維 (`fiber_g`)** を、食材ごとに 0 で下限をとって求めてから合算する
- 式は `supabase/functions/_shared/nutrition-sugar.ts` の `calcSugarG` だけに書く。v1 / v2 / 派生レシピ / 写真解析で書き写さない
- 食物繊維が未登録の食材は 0 として扱う (糖質 = 炭水化物)。炭水化物が未登録の食材は糖質に足さない
- 炭水化物の根拠が無い料理の糖質は、`planned_meals.sugar_g` / `dishes[].sugar_g` に 0 ではなく null (不明) で保存する (`save-meal.ts` の `sugarForSave`)。栄養が 1 つも計算できていない料理のほか、計算できなかった料理を炭水化物の無い参照レシピで補正して kcal だけが入った料理も、null にする
- 参照レシピで補正するとき (`validateAndAdjustNutritionV4`)、炭水化物を参照レシピの値に置き換えた場合は 置き換えた炭水化物 − 倍率で換算した食物繊維、置き換えない場合は補正前の糖質を倍率で換算する (材料ごとの下限を崩さない)
- 写真で献立を上書きする (`analyze-meal-photo`) ときは、`planned_meals` に書く栄養の列を `_shared/meal-photo-update.ts` の `buildPhotoOverwriteNutrition` で組み立て、糖質を炭水化物・食物繊維と一緒に上書きする。糖質を書かないと、上書き前の AI 献立の古い糖質が残り、炭水化物より大きい糖質が表示される
- 栄養目標側 (`packages/core` の `SUGAR_APP_DEFAULT`) も同じ定義 (炭水化物の目標 − 食物繊維の目標) にそろえてある。比率・式は管理栄養士の確認前の暫定値
