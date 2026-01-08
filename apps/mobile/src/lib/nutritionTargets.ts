/**
 * 栄養目標計算モジュール（Mobile）
 * 
 * 共通モジュール @homegohan/core からのエクスポート
 * Web/Mobileで同一の計算ロジック（DRI2020準拠）を使用
 */

// 型と計算関数を re-export
export {
  calculateNutritionTargets,
  type NutritionCalculatorInput,
  type NutritionCalculationResult,
  type NutritionTargetData,
  type NutritionTargetSummary,
  type CalculationBasis,
} from '@homegohan/core';
