/**
 * エビデンス検証（evidence-verifier.ts）
 * 
 * 計算された栄養素をdataset_recipesの類似レシピと比較し、
 * 妥当性を検証する
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { NutritionTotals, roundNutrition } from './nutrition-calculator-v2.ts'
import { isRetryableError, withRetry, withTimeout } from './network-retry.ts'

// ============================================
// 型定義
// ============================================

export interface ReferenceRecipe {
  id: string
  name: string
  name_norm: string
  source_url: string | null
  ingredients_text: string | null
  calories_kcal: number | null
  protein_g: number | null
  fat_g: number | null
  carbs_g: number | null
  sodium_g: number | null
  similarity: number
}

export interface VerificationResult {
  isVerified: boolean
  calculatedCalories: number
  referenceCalories: number | null
  deviationPercent: number | null
  reason: 'ok' | 'high_deviation' | 'excessive_deviation' | 'no_reference'
  warning: string | null
  referenceRecipe: ReferenceRecipe | null
  allReferences: ReferenceRecipe[]
  /**
   * #1047 F5: 保存に使用すべきカロリー値。
   * reason==='excessive_deviation'（参照値との乖離50%超）の場合のみ、
   * calculatedCalories を参照値の ±MAX_DEVIATION_RATIO の範囲にクランプした値。
   * それ以外は calculatedCalories と同じ。
   * 以前は乖離50%超でも calculatedCalories（未補正の生値）がそのまま保存され、
   * confidenceScore を下げるだけで実際の保存値は補正されていなかった。
   */
  recommendedCalories: number
}

export interface EvidenceInfo {
  calculationMethod: 'ingredient_based' | 'llm_fallback'
  matchedIngredients: MatchedIngredientInfo[]
  referenceRecipes: ReferenceRecipe[]
  verification: VerificationResult
  confidenceScore: number
}

export interface MatchedIngredientInfo {
  input: string
  matchedName: string | null
  matchedId: string | null
  similarity: number
  amount_g: number
}

type LlmFallbackConfidence = 'high' | 'medium' | 'low'

function createSupabaseQueryError(label: string, error: any): Error & { status?: number } {
  const err = new Error(`${label}: ${error?.message ?? 'unknown error'}`) as Error & { status?: number }
  err.status =
    isRetryableError(error) || /timeout|temporar|unavailable|connection|fetch failed/i.test(String(error?.message ?? ''))
      ? 503
      : 400
  return err
}

// ============================================
// 類似レシピ検索
// ============================================

export async function searchSimilarRecipes(
  supabase: SupabaseClient,
  dishName: string,
  threshold: number = 0.3,
  limit: number = 5
): Promise<ReferenceRecipe[]> {
  try {
    const data = await withRetry(async () => {
      const result = await withTimeout(supabase.rpc('search_recipes_with_nutrition', {
        query_name: dishName,
        similarity_threshold: threshold,
        result_limit: limit,
      }), {
        label: `search_recipes_with_nutrition:${dishName}`,
        timeoutMs: 15000,
      })
      if (result.error) {
        throw createSupabaseQueryError(`search_recipes_with_nutrition:${dishName}`, result.error)
      }
      return result.data ?? []
    }, {
      label: `search_recipes_with_nutrition:${dishName}`,
      retries: 2,
    })

    return data.map((r: any) => ({
      id: r.id,
      name: r.name,
      name_norm: r.name_norm,
      source_url: r.source_url,
      ingredients_text: r.ingredients_text,
      calories_kcal: r.calories_kcal,
      protein_g: r.protein_g,
      fat_g: r.fat_g,
      carbs_g: r.carbs_g,
      sodium_g: r.sodium_g,
      similarity: r.similarity,
    }))
  } catch (error) {
    console.error('Recipe search error:', error)
    return []
  }
}

// ============================================
// カロリー偏差計算
// ============================================

function calculateDeviation(calculated: number, reference: number): number {
  if (reference === 0) return 0
  return Math.abs((calculated - reference) / reference) * 100
}

// #1047 F5: 参照値との乖離が50%を超える場合にクランプする許容比率。
// 20-50%（high_deviation）は警告付きでそのまま採用するが、50%超（excessive_deviation）は
// 参照値の ±50% の範囲に丸め込む（完全に参照値へ置き換えると計算結果を無視することになるため、
// 「明らかに信頼できる範囲」まで寄せるに留める）。
const EXCESSIVE_DEVIATION_CLAMP_RATIO = 0.5

function clampToReferenceRange(calculated: number, reference: number): number {
  const min = reference * (1 - EXCESSIVE_DEVIATION_CLAMP_RATIO)
  const max = reference * (1 + EXCESSIVE_DEVIATION_CLAMP_RATIO)
  return Math.min(Math.max(calculated, min), max)
}

// ============================================
// 検証実行
// ============================================

export async function verifyNutrition(
  supabase: SupabaseClient,
  dishName: string,
  calculatedNutrition: NutritionTotals
): Promise<VerificationResult> {
  const references = await searchSimilarRecipes(supabase, dishName, 0.3, 5)

  if (references.length === 0) {
    return {
      isVerified: false,
      calculatedCalories: calculatedNutrition.calories_kcal,
      recommendedCalories: calculatedNutrition.calories_kcal,
      referenceCalories: null,
      deviationPercent: null,
      reason: 'no_reference',
      warning: '類似レシピが見つかりませんでした',
      referenceRecipe: null,
      allReferences: [],
    }
  }

  const best = references[0]
  const refCalories = best.calories_kcal

  if (!refCalories || refCalories === 0) {
    return {
      isVerified: false,
      calculatedCalories: calculatedNutrition.calories_kcal,
      recommendedCalories: calculatedNutrition.calories_kcal,
      referenceCalories: null,
      deviationPercent: null,
      reason: 'no_reference',
      warning: '参照レシピにカロリー情報がありません',
      referenceRecipe: best,
      allReferences: references,
    }
  }

  const deviation = calculateDeviation(calculatedNutrition.calories_kcal, refCalories)

  if (deviation <= 20) {
    // 20%以内: OK
    return {
      isVerified: true,
      calculatedCalories: calculatedNutrition.calories_kcal,
      recommendedCalories: calculatedNutrition.calories_kcal,
      referenceCalories: refCalories,
      deviationPercent: Math.round(deviation * 10) / 10,
      reason: 'ok',
      warning: null,
      referenceRecipe: best,
      allReferences: references,
    }
  } else if (deviation <= 50) {
    // 20-50%: 警告付きで採用（値は補正しない）
    return {
      isVerified: true,
      calculatedCalories: calculatedNutrition.calories_kcal,
      recommendedCalories: calculatedNutrition.calories_kcal,
      referenceCalories: refCalories,
      deviationPercent: Math.round(deviation * 10) / 10,
      reason: 'high_deviation',
      warning: `計算値と参照値の差が${Math.round(deviation)}%あります`,
      referenceRecipe: best,
      allReferences: references,
    }
  } else {
    // #1047 F5: 50%超の大幅な乖離は confidenceScore を下げるだけでなく、
    // 参照値の ±50% の範囲にクランプした値を recommendedCalories として提示する。
    // 呼び出し側（nutrition-pipeline.ts）はこの値を使って保存する栄養素合計を補正する。
    return {
      isVerified: false,
      calculatedCalories: calculatedNutrition.calories_kcal,
      recommendedCalories: clampToReferenceRange(calculatedNutrition.calories_kcal, refCalories),
      referenceCalories: refCalories,
      deviationPercent: Math.round(deviation * 10) / 10,
      reason: 'excessive_deviation',
      warning: `計算値と参照値の差が${Math.round(deviation)}%あり、大幅に乖離しています`,
      referenceRecipe: best,
      allReferences: references,
    }
  }
}

// ============================================
// 信頼度スコア計算
// ============================================

export function calculateConfidenceScore(
  matchRate: number,
  verification: VerificationResult,
  fallbackConfidence?: LlmFallbackConfidence,
): number {
  let score = matchRate

  if (score <= 0 && fallbackConfidence) {
    score = fallbackConfidence === 'high'
      ? 0.75
      : fallbackConfidence === 'medium'
        ? 0.6
        : 0.45
  }

  // 検証結果による調整
  if (verification.isVerified) {
    if (verification.reason === 'ok') {
      // 偏差20%以内: スコア維持
      score = Math.min(score * 1.1, 1.0)
    } else if (verification.reason === 'high_deviation') {
      // 偏差20-50%: 少し減点
      score = score * 0.85
    }
  } else {
    if (verification.reason === 'no_reference') {
      // 参照なし: 中程度減点
      score = score * 0.7
    } else if (verification.reason === 'excessive_deviation') {
      // 大幅乖離: 大きく減点
      score = score * 0.5
    }
  }

  // 最低0.1、最高1.0
  return Math.max(0.1, Math.min(1.0, Math.round(score * 100) / 100))
}

// ============================================
// エビデンス情報生成
// ============================================

export function createEvidenceInfo(
  matchedIngredients: MatchedIngredientInfo[],
  referenceRecipes: ReferenceRecipe[],
  verification: VerificationResult,
  matchRate: number,
  usedFallback: boolean = false,
  fallbackConfidence?: LlmFallbackConfidence,
): EvidenceInfo {
  const confidenceScore = calculateConfidenceScore(
    matchRate,
    verification,
    usedFallback ? fallbackConfidence : undefined,
  )

  return {
    calculationMethod: usedFallback ? 'llm_fallback' : 'ingredient_based',
    matchedIngredients,
    referenceRecipes,
    verification,
    confidenceScore,
  }
}

// ============================================
// 乖離補正の適用（#1047 F5）
// ============================================

/**
 * verifyNutrition() の結果が excessive_deviation の場合、mealTotals 全体を
 * recommendedCalories / calculatedCalories の比率で一律スケーリングして返す。
 * カロリーだけを補正すると、他の栄養素（P/F/C等）との整合が崩れる
 * （例: カロリー300kcalなのにタンパク質は600kcal相当のまま）ため、
 * 相対的な栄養バランスを保ったまま全体を補正する。
 * excessive_deviation でない場合は mealTotals をそのまま返す（no-op）。
 */
export function applyCalorieCorrection(
  mealTotals: NutritionTotals,
  verification: VerificationResult,
): NutritionTotals {
  if (verification.reason !== 'excessive_deviation') return mealTotals
  if (verification.calculatedCalories <= 0) return mealTotals
  if (verification.recommendedCalories === verification.calculatedCalories) return mealTotals

  const ratio = verification.recommendedCalories / verification.calculatedCalories
  const scaled = Object.fromEntries(
    Object.entries(mealTotals).map(([key, value]) => [key, typeof value === 'number' ? value * ratio : value]),
  ) as unknown as NutritionTotals

  return roundNutrition(scaled)
}
