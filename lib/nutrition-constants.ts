/**
 * 栄養素の定義（レーダーチャート・推奨量計算用）
 * 
 * DRI (Dietary Reference Intakes) は日本人の食事摂取基準2020年版を参考
 * 成人（18-49歳）の推奨量/目安量を基準としています
 */

export interface NutrientDefinition {
  key: string;           // DB/コードで使用するキー
  label: string;         // 表示名
  unit: string;          // 単位
  dri: number;           // 1日の推奨量/目安量
  decimals: number;      // 小数点以下桁数
  category: 'basic' | 'mineral' | 'vitamin' | 'fat'; // カテゴリ
  description?: string;  // 説明
}

// 栄養素定義マスター
export const NUTRIENT_DEFINITIONS: NutrientDefinition[] = [
  // === 基本栄養素 ===
  { key: 'caloriesKcal', label: 'エネルギー', unit: 'kcal', dri: 2000, decimals: 0, category: 'basic', description: '1日の活動エネルギー源' },
  { key: 'proteinG', label: 'タンパク質', unit: 'g', dri: 60, decimals: 1, category: 'basic', description: '筋肉・臓器の構成成分' },
  { key: 'fatG', label: '脂質', unit: 'g', dri: 55, decimals: 1, category: 'basic', description: 'エネルギー源・細胞膜の構成成分' },
  { key: 'carbsG', label: '炭水化物', unit: 'g', dri: 300, decimals: 1, category: 'basic', description: '主要なエネルギー源' },
  { key: 'fiberG', label: '食物繊維', unit: 'g', dri: 21, decimals: 1, category: 'basic', description: '腸内環境を整える' },
  { key: 'sugarG', label: '糖質', unit: 'g', dri: 250, decimals: 1, category: 'basic', description: '即効性のあるエネルギー' },
  
  // === ミネラル ===
  { key: 'sodiumG', label: '塩分', unit: 'g', dri: 7.5, decimals: 1, category: 'mineral', description: '目標量（控えめに）' },
  { key: 'potassiumMg', label: 'カリウム', unit: 'mg', dri: 2500, decimals: 0, category: 'mineral', description: '血圧調整・むくみ防止' },
  { key: 'calciumMg', label: 'カルシウム', unit: 'mg', dri: 700, decimals: 0, category: 'mineral', description: '骨・歯の形成' },
  { key: 'magnesiumMg', label: 'マグネシウム', unit: 'mg', dri: 340, decimals: 0, category: 'mineral', description: '酵素反応の補助' },
  { key: 'phosphorusMg', label: 'リン', unit: 'mg', dri: 1000, decimals: 0, category: 'mineral', description: '骨・歯の形成' },
  { key: 'ironMg', label: '鉄分', unit: 'mg', dri: 7.5, decimals: 1, category: 'mineral', description: '酸素運搬（ヘモグロビン）' },
  { key: 'zincMg', label: '亜鉛', unit: 'mg', dri: 10, decimals: 1, category: 'mineral', description: '免疫機能・味覚' },
  { key: 'iodineUg', label: 'ヨウ素', unit: 'µg', dri: 130, decimals: 0, category: 'mineral', description: '甲状腺ホルモンの材料' },
  
  // === ビタミン ===
  { key: 'vitaminAUg', label: 'ビタミンA', unit: 'µg', dri: 850, decimals: 0, category: 'vitamin', description: '視力・皮膚の健康' },
  { key: 'vitaminB1Mg', label: 'ビタミンB1', unit: 'mg', dri: 1.3, decimals: 2, category: 'vitamin', description: '糖質代謝' },
  { key: 'vitaminB2Mg', label: 'ビタミンB2', unit: 'mg', dri: 1.5, decimals: 2, category: 'vitamin', description: '脂質代謝・皮膚' },
  { key: 'vitaminB6Mg', label: 'ビタミンB6', unit: 'mg', dri: 1.4, decimals: 2, category: 'vitamin', description: 'タンパク質代謝' },
  { key: 'vitaminB12Ug', label: 'ビタミンB12', unit: 'µg', dri: 2.4, decimals: 1, category: 'vitamin', description: '神経機能・赤血球' },
  { key: 'vitaminCMg', label: 'ビタミンC', unit: 'mg', dri: 100, decimals: 0, category: 'vitamin', description: '抗酸化・コラーゲン合成' },
  { key: 'vitaminDUg', label: 'ビタミンD', unit: 'µg', dri: 8.5, decimals: 1, category: 'vitamin', description: 'カルシウム吸収' },
  { key: 'vitaminEMg', label: 'ビタミンE', unit: 'mg', dri: 6.5, decimals: 1, category: 'vitamin', description: '抗酸化作用' },
  { key: 'vitaminKUg', label: 'ビタミンK', unit: 'µg', dri: 150, decimals: 0, category: 'vitamin', description: '血液凝固・骨形成' },
  { key: 'folicAcidUg', label: '葉酸', unit: 'µg', dri: 240, decimals: 0, category: 'vitamin', description: '細胞分裂・胎児発育' },
  
  // === 脂質詳細 ===
  { key: 'saturatedFatG', label: '飽和脂肪酸', unit: 'g', dri: 16, decimals: 1, category: 'fat', description: '摂りすぎ注意' },
  { key: 'cholesterolMg', label: 'コレステロール', unit: 'mg', dri: 300, decimals: 0, category: 'fat', description: '細胞膜・ホルモン材料' },
];

// キーからNutrientDefinitionを取得
export const getNutrientDefinition = (key: string): NutrientDefinition | undefined => {
  return NUTRIENT_DEFINITIONS.find(n => n.key === key);
};

// 推奨量に対する割合を計算（%）
export const calculateDriPercentage = (key: string, value: number | null | undefined): number => {
  if (value == null) return 0;
  const def = getNutrientDefinition(key);
  if (!def) return 0;
  return Math.round((value / def.dri) * 100);
};

// デフォルトのレーダーチャート栄養素（5角形）
export const DEFAULT_RADAR_NUTRIENTS = [
  'caloriesKcal',
  'proteinG',
  'fatG',
  'carbsG',
  'fiberG',
];

// カテゴリごとにグループ化
export const NUTRIENT_BY_CATEGORY = {
  basic: NUTRIENT_DEFINITIONS.filter(n => n.category === 'basic'),
  mineral: NUTRIENT_DEFINITIONS.filter(n => n.category === 'mineral'),
  vitamin: NUTRIENT_DEFINITIONS.filter(n => n.category === 'vitamin'),
  fat: NUTRIENT_DEFINITIONS.filter(n => n.category === 'fat'),
};

// カテゴリ表示名
export const CATEGORY_LABELS: Record<string, string> = {
  basic: '基本栄養素',
  mineral: 'ミネラル',
  vitamin: 'ビタミン',
  fat: '脂質詳細',
};
