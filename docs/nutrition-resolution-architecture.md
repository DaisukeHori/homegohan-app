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
