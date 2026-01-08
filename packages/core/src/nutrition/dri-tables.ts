/**
 * 日本人の食事摂取基準（2020年版）参照テーブル
 * 
 * 厚生労働省「日本人の食事摂取基準（2020年版）」
 * https://www.mhlw.go.jp/stf/newpage_08517.html
 */

import type { DRIAgeGroup, DRIBasisType, Gender } from './types';

// ============================================
// 基準URL（一次情報）
// ============================================

export const DRI2020_SOURCES = {
  main: {
    url: 'https://www.mhlw.go.jp/stf/newpage_08517.html',
    title: '「日本人の食事摂取基準（2020年版）」策定検討会報告書',
  },
  report: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586553.pdf',
    title: '報告書全文（PDF）',
  },
  energy_pfc: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586560.pdf',
    title: 'エネルギー産生栄養素バランス（PDF）',
    section: 'エネルギー産生栄養素バランス',
  },
  vitamin_fat_soluble: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586561.pdf',
    title: 'ビタミン（脂溶性ビタミン）（PDF）',
    section: 'ビタミンA/D/E/K',
  },
  vitamin_water_soluble: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586563.pdf',
    title: 'ビタミン（水溶性ビタミン）（PDF）',
    section: 'ビタミンB群/C/葉酸等',
  },
  mineral_macro: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586565.pdf',
    title: 'ミネラル（多量ミネラル）（PDF）',
    section: 'カリウム/カルシウム/リン等',
  },
  mineral_trace: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586568.pdf',
    title: 'ミネラル（微量ミネラル）（PDF）',
    section: '鉄/亜鉛/ヨウ素等',
  },
  hypertension: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586583.pdf',
    title: '高血圧（PDF）',
  },
  dyslipidemia: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586590.pdf',
    title: '脂質異常症（PDF）',
  },
  diabetes: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586592.pdf',
    title: '糖尿病（PDF）',
  },
  ckd: {
    url: 'https://www.mhlw.go.jp/content/10904750/000586595.pdf',
    title: '慢性腎臓病（CKD）（PDF）',
  },
} as const;

// ============================================
// 年齢 → DRI年齢階級のマッピング
// ============================================

export function ageToAgeGroup(age: number): DRIAgeGroup {
  if (age < 1) return '6-11m';
  if (age <= 2) return '1-2';
  if (age <= 5) return '3-5';
  if (age <= 7) return '6-7';
  if (age <= 9) return '8-9';
  if (age <= 11) return '10-11';
  if (age <= 14) return '12-14';
  if (age <= 17) return '15-17';
  if (age <= 29) return '18-29';
  if (age <= 49) return '30-49';
  if (age <= 64) return '50-64';
  if (age <= 74) return '65-74';
  return '75+';
}

// ============================================
// ビタミン・ミネラル DRI 参照テーブル
// 
// 構造: { [nutrient]: { [ageGroup]: { male, female } } }
// 値は推奨量(RDA)または目安量(AI)、単位は types.ts の定義に従う
// ============================================

type DRIValueByAgeGender = {
  [ageGroup in DRIAgeGroup]?: {
    male: number;
    female: number;
  };
};

interface NutrientDRIEntry {
  unit: string;
  basisType: DRIBasisType;
  source: typeof DRI2020_SOURCES[keyof typeof DRI2020_SOURCES];
  values: DRIValueByAgeGender;
  // 妊娠・授乳中の追加量（18-49歳のみ適用）
  pregnancyAddition?: number;
  nursingAddition?: number;
  // 上限量（あれば）
  upperLimit?: DRIValueByAgeGender;
}

// ============================================
// ビタミンA (µgRAE)
// ============================================
export const VITAMIN_A_DRI: NutrientDRIEntry = {
  unit: 'µgRAE',
  basisType: 'RDA',
  source: DRI2020_SOURCES.vitamin_fat_soluble,
  values: {
    '1-2':   { male: 400, female: 350 },
    '3-5':   { male: 450, female: 450 },
    '6-7':   { male: 400, female: 400 },
    '8-9':   { male: 500, female: 500 },
    '10-11': { male: 600, female: 600 },
    '12-14': { male: 800, female: 700 },
    '15-17': { male: 900, female: 650 },
    '18-29': { male: 850, female: 650 },
    '30-49': { male: 900, female: 700 },
    '50-64': { male: 900, female: 700 },
    '65-74': { male: 850, female: 700 },
    '75+':   { male: 800, female: 650 },
  },
  pregnancyAddition: 80, // 初期+0、中期+0、後期+80
  nursingAddition: 450,
  upperLimit: {
    '18-29': { male: 2700, female: 2700 },
    '30-49': { male: 2700, female: 2700 },
    '50-64': { male: 2700, female: 2700 },
    '65-74': { male: 2700, female: 2700 },
    '75+':   { male: 2700, female: 2700 },
  },
};

// ============================================
// ビタミンD (µg)
// ============================================
export const VITAMIN_D_DRI: NutrientDRIEntry = {
  unit: 'µg',
  basisType: 'AI', // 目安量
  source: DRI2020_SOURCES.vitamin_fat_soluble,
  values: {
    '1-2':   { male: 3.0, female: 3.5 },
    '3-5':   { male: 3.5, female: 4.0 },
    '6-7':   { male: 4.5, female: 5.0 },
    '8-9':   { male: 5.0, female: 6.0 },
    '10-11': { male: 6.5, female: 8.0 },
    '12-14': { male: 8.0, female: 9.5 },
    '15-17': { male: 9.0, female: 8.5 },
    '18-29': { male: 8.5, female: 8.5 },
    '30-49': { male: 8.5, female: 8.5 },
    '50-64': { male: 8.5, female: 8.5 },
    '65-74': { male: 8.5, female: 8.5 },
    '75+':   { male: 8.5, female: 8.5 },
  },
  pregnancyAddition: 0,
  nursingAddition: 0,
  upperLimit: {
    '18-29': { male: 100, female: 100 },
    '30-49': { male: 100, female: 100 },
    '50-64': { male: 100, female: 100 },
    '65-74': { male: 100, female: 100 },
    '75+':   { male: 100, female: 100 },
  },
};

// ============================================
// ビタミンE α-トコフェロール (mg)
// ============================================
export const VITAMIN_E_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'AI',
  source: DRI2020_SOURCES.vitamin_fat_soluble,
  values: {
    '1-2':   { male: 3.0, female: 3.0 },
    '3-5':   { male: 4.0, female: 4.0 },
    '6-7':   { male: 5.0, female: 5.0 },
    '8-9':   { male: 5.0, female: 5.0 },
    '10-11': { male: 5.5, female: 5.5 },
    '12-14': { male: 7.0, female: 6.0 },
    '15-17': { male: 7.0, female: 5.5 },
    '18-29': { male: 6.0, female: 5.0 },
    '30-49': { male: 6.0, female: 5.5 },
    '50-64': { male: 7.0, female: 6.0 },
    '65-74': { male: 7.0, female: 6.5 },
    '75+':   { male: 6.5, female: 6.5 },
  },
  pregnancyAddition: 0,
  nursingAddition: 3.0,
  upperLimit: {
    '18-29': { male: 850, female: 650 },
    '30-49': { male: 900, female: 700 },
    '50-64': { male: 850, female: 700 },
    '65-74': { male: 850, female: 650 },
    '75+':   { male: 750, female: 650 },
  },
};

// ============================================
// ビタミンK (µg)
// ============================================
export const VITAMIN_K_DRI: NutrientDRIEntry = {
  unit: 'µg',
  basisType: 'AI',
  source: DRI2020_SOURCES.vitamin_fat_soluble,
  values: {
    '1-2':   { male: 50, female: 60 },
    '3-5':   { male: 60, female: 70 },
    '6-7':   { male: 80, female: 90 },
    '8-9':   { male: 90, female: 110 },
    '10-11': { male: 110, female: 140 },
    '12-14': { male: 140, female: 170 },
    '15-17': { male: 160, female: 150 },
    '18-29': { male: 150, female: 150 },
    '30-49': { male: 150, female: 150 },
    '50-64': { male: 150, female: 150 },
    '65-74': { male: 150, female: 150 },
    '75+':   { male: 150, female: 150 },
  },
  pregnancyAddition: 0,
  nursingAddition: 0,
};

// ============================================
// ビタミンB1 (mg) - カロリーに依存
// ============================================
export const VITAMIN_B1_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.vitamin_water_soluble,
  values: {
    '1-2':   { male: 0.5, female: 0.5 },
    '3-5':   { male: 0.7, female: 0.7 },
    '6-7':   { male: 0.8, female: 0.8 },
    '8-9':   { male: 1.0, female: 0.9 },
    '10-11': { male: 1.2, female: 1.1 },
    '12-14': { male: 1.4, female: 1.3 },
    '15-17': { male: 1.5, female: 1.2 },
    '18-29': { male: 1.4, female: 1.1 },
    '30-49': { male: 1.4, female: 1.1 },
    '50-64': { male: 1.3, female: 1.1 },
    '65-74': { male: 1.3, female: 1.1 },
    '75+':   { male: 1.2, female: 0.9 },
  },
  pregnancyAddition: 0.2,
  nursingAddition: 0.2,
};

// ============================================
// ビタミンB2 (mg)
// ============================================
export const VITAMIN_B2_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.vitamin_water_soluble,
  values: {
    '1-2':   { male: 0.6, female: 0.5 },
    '3-5':   { male: 0.8, female: 0.8 },
    '6-7':   { male: 0.9, female: 0.9 },
    '8-9':   { male: 1.1, female: 1.0 },
    '10-11': { male: 1.4, female: 1.3 },
    '12-14': { male: 1.6, female: 1.4 },
    '15-17': { male: 1.7, female: 1.4 },
    '18-29': { male: 1.6, female: 1.2 },
    '30-49': { male: 1.6, female: 1.2 },
    '50-64': { male: 1.5, female: 1.2 },
    '65-74': { male: 1.5, female: 1.2 },
    '75+':   { male: 1.3, female: 1.0 },
  },
  pregnancyAddition: 0.3,
  nursingAddition: 0.6,
};

// ============================================
// ビタミンB6 (mg)
// ============================================
export const VITAMIN_B6_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.vitamin_water_soluble,
  values: {
    '1-2':   { male: 0.5, female: 0.5 },
    '3-5':   { male: 0.6, female: 0.6 },
    '6-7':   { male: 0.8, female: 0.7 },
    '8-9':   { male: 0.9, female: 0.9 },
    '10-11': { male: 1.1, female: 1.1 },
    '12-14': { male: 1.4, female: 1.3 },
    '15-17': { male: 1.5, female: 1.3 },
    '18-29': { male: 1.4, female: 1.1 },
    '30-49': { male: 1.4, female: 1.1 },
    '50-64': { male: 1.4, female: 1.1 },
    '65-74': { male: 1.4, female: 1.1 },
    '75+':   { male: 1.4, female: 1.1 },
  },
  pregnancyAddition: 0.2,
  nursingAddition: 0.3,
  upperLimit: {
    '18-29': { male: 55, female: 45 },
    '30-49': { male: 60, female: 45 },
    '50-64': { male: 55, female: 45 },
    '65-74': { male: 50, female: 40 },
    '75+':   { male: 50, female: 40 },
  },
};

// ============================================
// ビタミンB12 (µg)
// ============================================
export const VITAMIN_B12_DRI: NutrientDRIEntry = {
  unit: 'µg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.vitamin_water_soluble,
  values: {
    '1-2':   { male: 0.9, female: 0.9 },
    '3-5':   { male: 1.0, female: 1.0 },
    '6-7':   { male: 1.3, female: 1.3 },
    '8-9':   { male: 1.5, female: 1.5 },
    '10-11': { male: 1.9, female: 1.9 },
    '12-14': { male: 2.4, female: 2.4 },
    '15-17': { male: 2.4, female: 2.4 },
    '18-29': { male: 2.4, female: 2.4 },
    '30-49': { male: 2.4, female: 2.4 },
    '50-64': { male: 2.4, female: 2.4 },
    '65-74': { male: 2.4, female: 2.4 },
    '75+':   { male: 2.4, female: 2.4 },
  },
  pregnancyAddition: 0.4,
  nursingAddition: 0.8,
};

// ============================================
// ビタミンC (mg)
// ============================================
export const VITAMIN_C_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.vitamin_water_soluble,
  values: {
    '1-2':   { male: 40, female: 40 },
    '3-5':   { male: 50, female: 50 },
    '6-7':   { male: 60, female: 60 },
    '8-9':   { male: 70, female: 70 },
    '10-11': { male: 85, female: 85 },
    '12-14': { male: 100, female: 100 },
    '15-17': { male: 100, female: 100 },
    '18-29': { male: 100, female: 100 },
    '30-49': { male: 100, female: 100 },
    '50-64': { male: 100, female: 100 },
    '65-74': { male: 100, female: 100 },
    '75+':   { male: 100, female: 100 },
  },
  pregnancyAddition: 10,
  nursingAddition: 45,
};

// ============================================
// 葉酸 (µg)
// ============================================
export const FOLIC_ACID_DRI: NutrientDRIEntry = {
  unit: 'µg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.vitamin_water_soluble,
  values: {
    '1-2':   { male: 90, female: 90 },
    '3-5':   { male: 110, female: 110 },
    '6-7':   { male: 140, female: 140 },
    '8-9':   { male: 160, female: 160 },
    '10-11': { male: 190, female: 190 },
    '12-14': { male: 240, female: 240 },
    '15-17': { male: 240, female: 240 },
    '18-29': { male: 240, female: 240 },
    '30-49': { male: 240, female: 240 },
    '50-64': { male: 240, female: 240 },
    '65-74': { male: 240, female: 240 },
    '75+':   { male: 240, female: 240 },
  },
  pregnancyAddition: 240, // 妊娠中は倍量
  nursingAddition: 100,
  upperLimit: {
    '18-29': { male: 1000, female: 1000 },
    '30-49': { male: 1000, female: 1000 },
    '50-64': { male: 1000, female: 1000 },
    '65-74': { male: 1000, female: 1000 },
    '75+':   { male: 1000, female: 1000 },
  },
};

// ============================================
// カリウム (mg) - 目標量
// ============================================
export const POTASSIUM_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'DG', // 目標量
  source: DRI2020_SOURCES.mineral_macro,
  values: {
    '1-2':   { male: 900, female: 800 },
    '3-5':   { male: 1100, female: 1000 },
    '6-7':   { male: 1300, female: 1200 },
    '8-9':   { male: 1600, female: 1500 },
    '10-11': { male: 1900, female: 1800 },
    '12-14': { male: 2400, female: 2200 },
    '15-17': { male: 2800, female: 2100 },
    '18-29': { male: 2500, female: 2000 },
    '30-49': { male: 2500, female: 2000 },
    '50-64': { male: 2500, female: 2000 },
    '65-74': { male: 2500, female: 2000 },
    '75+':   { male: 2500, female: 2000 },
  },
  pregnancyAddition: 0,
  nursingAddition: 400,
};

// ============================================
// カルシウム (mg)
// ============================================
export const CALCIUM_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.mineral_macro,
  values: {
    '1-2':   { male: 450, female: 400 },
    '3-5':   { male: 600, female: 550 },
    '6-7':   { male: 600, female: 550 },
    '8-9':   { male: 650, female: 750 },
    '10-11': { male: 700, female: 750 },
    '12-14': { male: 1000, female: 800 },
    '15-17': { male: 800, female: 650 },
    '18-29': { male: 800, female: 650 },
    '30-49': { male: 750, female: 650 },
    '50-64': { male: 750, female: 650 },
    '65-74': { male: 750, female: 650 },
    '75+':   { male: 700, female: 600 },
  },
  pregnancyAddition: 0,
  nursingAddition: 0,
  upperLimit: {
    '18-29': { male: 2500, female: 2500 },
    '30-49': { male: 2500, female: 2500 },
    '50-64': { male: 2500, female: 2500 },
    '65-74': { male: 2500, female: 2500 },
    '75+':   { male: 2500, female: 2500 },
  },
};

// ============================================
// リン (mg)
// ============================================
export const PHOSPHORUS_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'AI',
  source: DRI2020_SOURCES.mineral_macro,
  values: {
    '1-2':   { male: 500, female: 500 },
    '3-5':   { male: 700, female: 600 },
    '6-7':   { male: 800, female: 700 },
    '8-9':   { male: 1000, female: 900 },
    '10-11': { male: 1100, female: 1000 },
    '12-14': { male: 1200, female: 1000 },
    '15-17': { male: 1200, female: 900 },
    '18-29': { male: 1000, female: 800 },
    '30-49': { male: 1000, female: 800 },
    '50-64': { male: 1000, female: 800 },
    '65-74': { male: 1000, female: 800 },
    '75+':   { male: 1000, female: 800 },
  },
  pregnancyAddition: 0,
  nursingAddition: 0,
  upperLimit: {
    '18-29': { male: 3000, female: 3000 },
    '30-49': { male: 3000, female: 3000 },
    '50-64': { male: 3000, female: 3000 },
    '65-74': { male: 3000, female: 3000 },
    '75+':   { male: 3000, female: 3000 },
  },
};

// ============================================
// 鉄 (mg)
// ============================================
export const IRON_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.mineral_trace,
  values: {
    '1-2':   { male: 4.5, female: 4.5 },
    '3-5':   { male: 5.5, female: 5.0 },
    '6-7':   { male: 6.5, female: 6.5 },
    '8-9':   { male: 8.0, female: 8.5 },
    '10-11': { male: 10.0, female: 10.0 }, // 月経なし
    '12-14': { male: 11.5, female: 10.0 }, // 月経ありは14.0
    '15-17': { male: 9.5, female: 7.0 },   // 月経ありは10.5
    '18-29': { male: 7.5, female: 6.5 },   // 月経ありは10.5
    '30-49': { male: 7.5, female: 6.5 },   // 月経ありは10.5
    '50-64': { male: 7.5, female: 6.5 },   // 月経ありは11.0
    '65-74': { male: 7.5, female: 6.0 },
    '75+':   { male: 7.0, female: 6.0 },
  },
  pregnancyAddition: 15.0, // 初期+2.5、中期後期+15.0（平均として15を使用）
  nursingAddition: 2.5,
  upperLimit: {
    '18-29': { male: 50, female: 40 },
    '30-49': { male: 55, female: 40 },
    '50-64': { male: 50, female: 40 },
    '65-74': { male: 50, female: 40 },
    '75+':   { male: 50, female: 40 },
  },
};

// ============================================
// 亜鉛 (mg)
// ============================================
export const ZINC_DRI: NutrientDRIEntry = {
  unit: 'mg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.mineral_trace,
  values: {
    '1-2':   { male: 3, female: 3 },
    '3-5':   { male: 4, female: 4 },
    '6-7':   { male: 5, female: 5 },
    '8-9':   { male: 6, female: 6 },
    '10-11': { male: 7, female: 7 },
    '12-14': { male: 10, female: 8 },
    '15-17': { male: 12, female: 8 },
    '18-29': { male: 11, female: 8 },
    '30-49': { male: 11, female: 8 },
    '50-64': { male: 11, female: 8 },
    '65-74': { male: 11, female: 8 },
    '75+':   { male: 10, female: 8 },
  },
  pregnancyAddition: 2,
  nursingAddition: 4,
  upperLimit: {
    '18-29': { male: 40, female: 35 },
    '30-49': { male: 45, female: 35 },
    '50-64': { male: 45, female: 35 },
    '65-74': { male: 40, female: 35 },
    '75+':   { male: 40, female: 30 },
  },
};

// ============================================
// ヨウ素 (µg)
// ============================================
export const IODINE_DRI: NutrientDRIEntry = {
  unit: 'µg',
  basisType: 'RDA',
  source: DRI2020_SOURCES.mineral_trace,
  values: {
    '1-2':   { male: 50, female: 50 },
    '3-5':   { male: 60, female: 60 },
    '6-7':   { male: 75, female: 75 },
    '8-9':   { male: 90, female: 90 },
    '10-11': { male: 110, female: 110 },
    '12-14': { male: 130, female: 130 },
    '15-17': { male: 140, female: 140 },
    '18-29': { male: 130, female: 130 },
    '30-49': { male: 130, female: 130 },
    '50-64': { male: 130, female: 130 },
    '65-74': { male: 130, female: 130 },
    '75+':   { male: 130, female: 130 },
  },
  pregnancyAddition: 110,
  nursingAddition: 140,
  upperLimit: {
    '18-29': { male: 3000, female: 3000 },
    '30-49': { male: 3000, female: 3000 },
    '50-64': { male: 3000, female: 3000 },
    '65-74': { male: 3000, female: 3000 },
    '75+':   { male: 3000, female: 3000 },
  },
};

// ============================================
// 食塩相当量 (g) - 目標量（上限）
// ============================================
export const SALT_EQUIVALENT_DRI: NutrientDRIEntry = {
  unit: 'g',
  basisType: 'DG', // 目標量（この場合は上限）
  source: DRI2020_SOURCES.mineral_macro,
  values: {
    '1-2':   { male: 3.0, female: 3.5 },
    '3-5':   { male: 4.0, female: 4.5 },
    '6-7':   { male: 5.0, female: 5.5 },
    '8-9':   { male: 5.5, female: 6.0 },
    '10-11': { male: 6.5, female: 7.0 },
    '12-14': { male: 8.0, female: 7.0 },
    '15-17': { male: 7.5, female: 6.5 },
    '18-29': { male: 7.5, female: 6.5 },
    '30-49': { male: 7.5, female: 6.5 },
    '50-64': { male: 7.5, female: 6.5 },
    '65-74': { male: 7.5, female: 6.5 },
    '75+':   { male: 7.5, female: 6.5 },
  },
  pregnancyAddition: 0,
  nursingAddition: 0,
};

// ============================================
// 食物繊維 (g) - 目標量
// ============================================
export const FIBER_DRI: NutrientDRIEntry = {
  unit: 'g',
  basisType: 'DG',
  source: DRI2020_SOURCES.energy_pfc,
  values: {
    '1-2':   { male: 8, female: 8 }, // 推定
    '3-5':   { male: 10, female: 10 },
    '6-7':   { male: 11, female: 11 },
    '8-9':   { male: 13, female: 13 },
    '10-11': { male: 16, female: 16 },
    '12-14': { male: 19, female: 18 },
    '15-17': { male: 21, female: 18 },
    '18-29': { male: 21, female: 18 },
    '30-49': { male: 21, female: 18 },
    '50-64': { male: 21, female: 18 },
    '65-74': { male: 20, female: 17 },
    '75+':   { male: 20, female: 17 },
  },
  pregnancyAddition: 0,
  nursingAddition: 0,
};

// ============================================
// コレステロール (mg) - DRI2020では基準値なし
// アプリ独自に設定する場合の参考値
// ============================================
export const CHOLESTEROL_APP_DEFAULT = {
  unit: 'mg',
  note: 'DRI2020では基準値が設定されていないため、アプリ独自の目安',
  default: 300,
  dyslipidemia: 200,
};

// ============================================
// 糖類 (g) - DRI2020では基準値なし
// WHOの推奨を参考にアプリ独自に設定
// ============================================
export const SUGAR_APP_DEFAULT = {
  unit: 'g',
  note: 'DRI2020では基準値なし、WHOはエネルギーの10%未満を推奨',
  calculateFromCalories: (calories: number) => Math.round(calories * 0.05 / 4), // 5%目標
};

// ============================================
// DRI全体マップ（lookup用）
// ============================================
export const DRI_TABLES = {
  vitamin_a_ug: VITAMIN_A_DRI,
  vitamin_d_ug: VITAMIN_D_DRI,
  vitamin_e_mg: VITAMIN_E_DRI,
  vitamin_k_ug: VITAMIN_K_DRI,
  vitamin_b1_mg: VITAMIN_B1_DRI,
  vitamin_b2_mg: VITAMIN_B2_DRI,
  vitamin_b6_mg: VITAMIN_B6_DRI,
  vitamin_b12_ug: VITAMIN_B12_DRI,
  vitamin_c_mg: VITAMIN_C_DRI,
  folic_acid_ug: FOLIC_ACID_DRI,
  potassium_mg: POTASSIUM_DRI,
  calcium_mg: CALCIUM_DRI,
  phosphorus_mg: PHOSPHORUS_DRI,
  iron_mg: IRON_DRI,
  zinc_mg: ZINC_DRI,
  iodine_ug: IODINE_DRI,
  sodium_g: SALT_EQUIVALENT_DRI,
  fiber_g: FIBER_DRI,
} as const;

/**
 * DRIテーブルから値を取得するユーティリティ
 */
export function getDRIValue(
  nutrientKey: keyof typeof DRI_TABLES,
  ageGroup: DRIAgeGroup,
  gender: Gender,
  pregnancyStatus: 'none' | 'pregnant' | 'nursing' = 'none'
): { value: number; basisType: DRIBasisType; source: typeof DRI2020_SOURCES[keyof typeof DRI2020_SOURCES] } | null {
  const entry = DRI_TABLES[nutrientKey];
  if (!entry) return null;
  
  const genderKey = gender === 'unspecified' ? 'male' : gender;
  const ageValues = entry.values[ageGroup];
  
  if (!ageValues) {
    // フォールバック: 成人の値を使用
    const fallbackValues = entry.values['30-49'];
    if (!fallbackValues) return null;
    
    let value = fallbackValues[genderKey];
    
    // 妊娠・授乳追加
    if (pregnancyStatus === 'pregnant' && entry.pregnancyAddition) {
      value += entry.pregnancyAddition;
    } else if (pregnancyStatus === 'nursing' && entry.nursingAddition) {
      value += entry.nursingAddition;
    }
    
    return {
      value,
      basisType: entry.basisType,
      source: entry.source,
    };
  }
  
  let value = ageValues[genderKey];
  
  // 妊娠・授乳追加
  if (pregnancyStatus === 'pregnant' && entry.pregnancyAddition) {
    value += entry.pregnancyAddition;
  } else if (pregnancyStatus === 'nursing' && entry.nursingAddition) {
    value += entry.nursingAddition;
  }
  
  return {
    value,
    basisType: entry.basisType,
    source: entry.source,
  };
}
