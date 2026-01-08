/**
 * 栄養目標計算モジュール
 * 
 * 日本人の食事摂取基準（2020年版）に準拠した栄養目標の計算
 * Web/Mobileで共通利用するSingle Source of Truth
 */

// 型定義
export * from './types';

// DRI2020参照テーブル
export {
  DRI2020_SOURCES,
  ageToAgeGroup,
  getDRIValue,
  DRI_TABLES,
  VITAMIN_A_DRI,
  VITAMIN_D_DRI,
  VITAMIN_E_DRI,
  VITAMIN_K_DRI,
  VITAMIN_B1_DRI,
  VITAMIN_B2_DRI,
  VITAMIN_B6_DRI,
  VITAMIN_B12_DRI,
  VITAMIN_C_DRI,
  FOLIC_ACID_DRI,
  POTASSIUM_DRI,
  CALCIUM_DRI,
  PHOSPHORUS_DRI,
  IRON_DRI,
  ZINC_DRI,
  IODINE_DRI,
  SALT_EQUIVALENT_DRI,
  FIBER_DRI,
  CHOLESTEROL_APP_DEFAULT,
  SUGAR_APP_DEFAULT,
} from './dri-tables';

// メイン計算関数
export { calculateNutritionTargets } from './calculate';
