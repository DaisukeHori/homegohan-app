/**
 * エビデンス検証（evidence-verifier.ts）
 * 
 * 計算された栄養素をdataset_recipesの類似レシピと比較し、
 * 妥当性を検証する
 */

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { NutritionTotals } from './nutrition-calculator-v2.ts'

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

// ============================================
// 類似レシピ検索
// ============================================

export async function searchSimilarRecipes(
  supabase: SupabaseClient,
  dishName: string,
  threshold: number = 0.3,
  limit: number = 5
): Promise<ReferenceRecipe[]> {
  const { data, error } = await supabase.rpc('search_recipes_with_nutrition', {
    query_name: dishName,
    similarity_threshold: threshold,
    result_limit: limit,
  })

  if (error) {
    console.error('Recipe search error:', error)
    return []
  }

  return (data || []).map((r: any) => ({
    id: r.id,
    name: r.name,
    name_norm: r.name_norm,
    source_url: r.source_url,
    ingredients_text: r.ingredients_text,
    calories_kcal: r.calories_kcal,
    protein_g: r.protein_g,
    fat_g: r.fat_g,
    carbs_g: r.carbs_g,
    similarity: r.similarity,
  }))
}

// ============================================
// カロリー偏差計算
// ============================================

function calculateDeviation(calculated: number, reference: number): number {
  if (reference === 0) return 0
  return Math.abs((calculated - reference) / reference) * 100
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
      referenceCalories: refCalories,
      deviationPercent: Math.round(deviation * 10) / 10,
      reason: 'ok',
      warning: null,
      referenceRecipe: best,
      allReferences: references,
    }
  } else if (deviation <= 50) {
    // 20-50%: 警告付きで採用
    return {
      isVerified: true,
      calculatedCalories: calculatedNutrition.calories_kcal,
      referenceCalories: refCalories,
      deviationPercent: Math.round(deviation * 10) / 10,
      reason: 'high_deviation',
      warning: `計算値と参照値の差が${Math.round(deviation)}%あります`,
      referenceRecipe: best,
      allReferences: references,
    }
  } else {
    // 50%超: 大幅な乖離
    return {
      isVerified: false,
      calculatedCalories: calculatedNutrition.calories_kcal,
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
  verification: VerificationResult
): number {
  // 基本スコア: マッチ率（0-1）
  let score = matchRate

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
  usedFallback: boolean = false
): EvidenceInfo {
  const confidenceScore = calculateConfidenceScore(matchRate, verification)

  return {
    calculationMethod: usedFallback ? 'llm_fallback' : 'ingredient_based',
    matchedIngredients,
    referenceRecipes,
    verification,
    confidenceScore,
  }
}
