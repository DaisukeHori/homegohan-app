// Mock データ完全定義
// Canonical: docs/design/family/09-onboarding-handson-tour/14-mocks-i18n.md §1.2-1.4
// v1 freeze 方針 (§14 §1.5): 値の変更は v2 で実施。改変禁止。

// ============================================================
// §1.2 MOCK_PHOTO_RESPONSE
// ============================================================

export const MOCK_PHOTO_RESPONSE = {
  dishName: '鶏の唐揚げ定食',
  calories: 780,
  protein_g: 38,
  fat_g: 32,
  carbs_g: 88,
  confidence: 0.95,
  detected_items: [
    { name: '鶏の唐揚げ', portion_g: 200 },
    { name: '白米', portion_g: 200 },
    { name: '味噌汁', portion_g: 150 },
    { name: 'キャベツ千切り', portion_g: 50 },
  ],
  ai_provider: 'gemini-2.0-flash',
  detected_at: null,
  /** 食材アレルギー警告 (mock では空) */
  allergy_warnings: [] as string[],
  /** AI コメント (mock では固定) */
  ai_comment: 'バランスのよい和食定食です。たんぱく質が豊富!',
} as const;

export type MockPhotoResponse = typeof MOCK_PHOTO_RESPONSE;

// ============================================================
// §1.3 MOCK_MENU_RESPONSE
// ============================================================

export const MOCK_MENU_RESPONSE = {
  date_offset_days: 1,
  meal_type: 'dinner' as const,
  dish_name: '豚肉と野菜の生姜焼き',
  calories: 620,
  protein_g: 35,
  fat_g: 22,
  carbs_g: 70,
  cooking_time_minutes: 20,
  servings: 2,
  difficulty: 'easy' as const,
  ingredients: [
    { name: '豚ロース薄切り', quantity_g: 200, unit: 'g' as const },
    { name: '玉ねぎ', quantity_g: 80, unit: 'g' as const },
    { name: 'ピーマン', quantity_g: 60, unit: 'g' as const },
    { name: 'しょうが', quantity_g: 10, unit: 'g' as const },
    { name: '醤油', quantity_g: 15, unit: 'ml' as const },
    { name: 'みりん', quantity_g: 15, unit: 'ml' as const },
    { name: '砂糖', quantity_g: 5, unit: 'g' as const },
    { name: 'サラダ油', quantity_g: 10, unit: 'ml' as const },
  ],
  instructions: [
    '豚肉に塩こしょうし、軽く片栗粉をまぶす',
    '野菜を一口大に切る (玉ねぎは 1 cm、ピーマンは細切り)',
    'しょうがをすりおろす',
    'フライパンに油を熱し、豚肉を中火で焼く',
    '野菜を加えて炒める',
    '醤油・みりん・砂糖・しょうがを混ぜたタレを加える',
    '全体に火が通ったら盛り付けて完成',
  ],
  ai_provider: 'gemini-2.0-flash',
  generated_at: null,
  /** 個人化情報 (mock では空) */
  personalization: {
    excluded_ingredients: [] as string[],
    cooking_difficulty_adjusted: 'easy',
  },
} as const;

export type MockMenuResponse = typeof MOCK_MENU_RESPONSE;

// ============================================================
// §1.4 サンプル画像メタデータ
// ============================================================

export const SAMPLE_MEAL_IMAGE = {
  webPath: '/handson-tour/sample-meal.jpg',
  webPathWebp: '/handson-tour/sample-meal.webp',
  mobileAssetModule: () => require('../../../apps/mobile/assets/handson-tour/sample-meal.jpg'),
  width: 1024,
  height: 768,
  fileSizeBytes: 200_000,
  mimeType: 'image/jpeg',
  altText: '唐揚げ定食 (ご飯・味噌汁・キャベツ千切り付き)',
  altTextEn: 'Karaage (Japanese fried chicken) set meal with rice, miso soup, and shredded cabbage',
} as const;
