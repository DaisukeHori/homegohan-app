/**
 * 栄養計算ロジック
 * - 基礎代謝計算（Mifflin-St Jeor式）
 * - 活動係数計算
 * - 目標に基づくカロリー調整
 * - 健康状態に基づく栄養素調整
 */

import type { UserProfile, NutritionTarget, MealConstraints, HealthFocusItem } from '@/types/domain';

// ==============================
// 基礎代謝計算（Mifflin-St Jeor式）
// ==============================
export function calculateBMR(profile: UserProfile): number {
  const { weight, height, age, gender } = profile;
  
  if (!weight || !height || !age) {
    return 1800; // デフォルト値
  }
  
  // Mifflin-St Jeor Equation
  if (gender === 'male') {
    return Math.round(10 * weight + 6.25 * height - 5 * age + 5);
  } else {
    return Math.round(10 * weight + 6.25 * height - 5 * age - 161);
  }
}

// ==============================
// 活動係数計算
// ==============================
export function calculateActivityMultiplier(profile: UserProfile): number {
  let base = 1.2; // 座位中心（デフォルト）
  
  // 仕事スタイルによる調整
  const workStyle = profile.workStyle || profile.lifestyle?.workStyle;
  const workStyleStr = workStyle as string | undefined;
  if (workStyleStr === 'physical' || workStyleStr === 'hard_work' || workStyleStr === 'shift') {
    base = 1.6;
  } else if (workStyleStr === 'stand' || workStyleStr === 'active_work' || workStyleStr === 'parttime') {
    base = 1.4;
  } else if (workStyleStr === 'student' || workStyleStr === 'homemaker') {
    base = 1.3;
  }
  
  // デスクワーク時間による調整
  if (profile.deskHoursPerDay) {
    if (profile.deskHoursPerDay >= 8) {
      base = Math.min(base, 1.25);
    } else if (profile.deskHoursPerDay < 4) {
      base += 0.1;
    }
  }
  
  // 通勤による調整
  if (profile.commute) {
    if (profile.commute.method === 'walk' || profile.commute.method === 'bike') {
      const bonus = Math.min(profile.commute.minutes / 60 * 0.1, 0.15);
      base += bonus;
    }
  }
  
  // 運動習慣による調整
  const weeklyExercise = profile.weeklyExerciseMinutes || 0;
  if (weeklyExercise > 300) {
    base += 0.3;
  } else if (weeklyExercise > 150) {
    base += 0.2;
  } else if (weeklyExercise > 60) {
    base += 0.1;
  }
  
  // ジム会員・パーソナルトレーナー
  if (profile.gymMember) base += 0.05;
  if (profile.personalTrainer) base += 0.05;
  
  // スポーツ活動による調整
  if (profile.sportsActivities && profile.sportsActivities.length > 0) {
    for (const sport of profile.sportsActivities) {
      if (sport.frequency === 'daily' || sport.frequency === 'weekly_3plus') {
        if (sport.intensity === 'intense') {
          base += 0.15;
        } else if (sport.intensity === 'moderate') {
          base += 0.1;
        } else {
          base += 0.05;
        }
      }
    }
  }
  
  // 上限を設定
  return Math.min(base, 2.2);
}

// ==============================
// 1日の目標カロリー計算
// ==============================
export function calculateDailyCalories(profile: UserProfile): number {
  const bmr = calculateBMR(profile);
  const activityMultiplier = calculateActivityMultiplier(profile);
  let tdee = bmr * activityMultiplier;
  
  // 目標による調整
  const goals = profile.fitnessGoals || [];
  
  if (goals.includes('lose_weight')) {
    // 減量: 安全な赤字（体重の0.5-1%/週）
    const deficit = Math.min(500, profile.weight ? profile.weight * 5 : 400);
    tdee -= deficit;
  } else if (goals.includes('gain_weight') || goals.includes('build_muscle')) {
    // 増量/筋肉増加: 300-500kcal増
    tdee += goals.includes('build_muscle') ? 400 : 300;
  }
  
  // 妊娠・授乳中の調整
  if (profile.pregnancyStatus === 'pregnant') {
    tdee += 300; // 妊娠後期
  } else if (profile.pregnancyStatus === 'nursing') {
    tdee += 500; // 授乳中
  }
  
  // 最低値を保証
  const minCalories = profile.gender === 'male' ? 1500 : 1200;
  return Math.max(Math.round(tdee), minCalories);
}

// ==============================
// PFCバランス計算
// ==============================
export function calculateMacros(profile: UserProfile, dailyCalories: number): { protein: number; fat: number; carbs: number } {
  const goals = profile.fitnessGoals || [];
  
  let proteinRatio = 0.20; // 20%
  let fatRatio = 0.25;     // 25%
  let carbsRatio = 0.55;   // 55%
  
  // 筋肉増加目標
  if (goals.includes('build_muscle')) {
    proteinRatio = 0.30;
    fatRatio = 0.25;
    carbsRatio = 0.45;
  }
  
  // 減量目標
  if (goals.includes('lose_weight')) {
    proteinRatio = 0.25;
    fatRatio = 0.30;
    carbsRatio = 0.45;
  }
  
  // 糖尿病
  if (profile.healthConditions?.includes('糖尿病')) {
    carbsRatio = 0.40;
    proteinRatio = 0.25;
    fatRatio = 0.35;
  }
  
  // 脂質異常症
  if (profile.healthConditions?.includes('脂質異常症')) {
    fatRatio = 0.20;
    carbsRatio = 0.55;
    proteinRatio = 0.25;
  }
  
  return {
    protein: Math.round((dailyCalories * proteinRatio) / 4), // 1g = 4kcal
    fat: Math.round((dailyCalories * fatRatio) / 9),         // 1g = 9kcal
    carbs: Math.round((dailyCalories * carbsRatio) / 4),     // 1g = 4kcal
  };
}

// ==============================
// 栄養目標の総合計算
// ==============================
export function calculateNutritionTarget(profile: UserProfile): NutritionTarget {
  const dailyCalories = calculateDailyCalories(profile);
  const macros = calculateMacros(profile, dailyCalories);
  
  // 食物繊維目標
  let fiber = profile.gender === 'male' ? 21 : 18;
  if (profile.fitnessGoals?.includes('gut_health')) {
    fiber += 5;
  }
  
  // ナトリウム目標
  let sodium = 2300; // mg
  if (profile.healthConditions?.includes('高血圧')) {
    sodium = 1500;
  }
  
  return {
    dailyCalories,
    protein: macros.protein,
    fat: macros.fat,
    carbs: macros.carbs,
    fiber,
    sodium,
  };
}

// ==============================
// 健康状態に基づく食事制約
// ==============================
export function buildHealthFocus(profile: UserProfile): HealthFocusItem[] {
  const focuses: HealthFocusItem[] = [];
  const conditions = profile.healthConditions || [];
  const goals = profile.fitnessGoals || [];
  const checkup = profile.healthCheckupResults || {};
  
  // 高血圧
  if (conditions.includes('高血圧') || (checkup.bloodPressure?.systolic && checkup.bloodPressure.systolic > 140)) {
    focuses.push({
      condition: 'high_blood_pressure',
      actions: ['reduce_salt_to_6g', 'increase_potassium', 'increase_magnesium', 'dash_diet'],
      excludeIngredients: ['漬物', '梅干し', 'ラーメン', '味噌汁（濃い）', 'カップ麺', '塩辛'],
      preferIngredients: ['バナナ', 'ほうれん草', 'アボカド', '納豆', 'かぼちゃ', 'さつまいも'],
    });
  }
  
  // 糖尿病
  if (conditions.includes('糖尿病') || (checkup.hba1c && checkup.hba1c > 6.5)) {
    focuses.push({
      condition: 'diabetes',
      actions: ['low_gi', 'reduce_sugar', 'increase_fiber', 'control_portions'],
      excludeIngredients: ['白米（大量）', '砂糖', 'ジュース', '菓子パン', 'ケーキ', '飴'],
      preferIngredients: ['玄米', 'オートミール', '野菜', 'きのこ', '海藻', '豆類'],
    });
  }
  
  // 脂質異常症
  if (conditions.includes('脂質異常症') || (checkup.cholesterol?.ldl && checkup.cholesterol.ldl > 140)) {
    focuses.push({
      condition: 'dyslipidemia',
      actions: ['reduce_saturated_fat', 'increase_omega3', 'increase_fiber'],
      excludeIngredients: ['バター', '生クリーム', '脂身の多い肉', 'ソーセージ', 'ベーコン'],
      preferIngredients: ['青魚', 'オリーブオイル', 'ナッツ', '海藻', 'こんにゃく', '大豆'],
    });
  }
  
  // 貧血
  if (conditions.includes('貧血') || profile.gender === 'female') {
    focuses.push({
      condition: 'anemia',
      actions: ['increase_iron', 'increase_vitamin_c', 'avoid_tannin_with_meals'],
      preferIngredients: ['レバー', '赤身肉', 'ほうれん草', '小松菜', 'あさり', '牡蠣', '枝豆'],
    });
  }
  
  // 痛風
  if (conditions.includes('痛風') || (checkup.uricAcid && checkup.uricAcid > 7.0)) {
    focuses.push({
      condition: 'gout',
      actions: ['reduce_purine', 'increase_water', 'avoid_alcohol'],
      excludeIngredients: ['レバー', '白子', 'あん肝', 'ビール', '干物'],
      preferIngredients: ['卵', '豆腐', '野菜', '乳製品', '海藻'],
    });
  }
  
  // 美肌目標
  if (goals.includes('improve_skin') || profile.skinCondition !== 'good') {
    focuses.push({
      condition: 'skin_improvement',
      actions: ['increase_vitamin_a', 'increase_vitamin_c', 'increase_vitamin_e', 'increase_collagen'],
      preferIngredients: ['にんじん', 'トマト', 'パプリカ', '鶏手羽', '豚足', 'アボカド', 'ナッツ'],
    });
  }
  
  // 腸活
  if (goals.includes('gut_health') || profile.bowelMovement !== 'good') {
    focuses.push({
      condition: 'gut_health',
      actions: ['increase_fiber', 'increase_fermented_foods', 'increase_prebiotics'],
      preferIngredients: ['ヨーグルト', '納豆', 'キムチ', '味噌', 'ごぼう', 'オートミール', 'バナナ'],
    });
  }
  
  // 筋肉増加
  if (goals.includes('build_muscle')) {
    focuses.push({
      condition: 'muscle_building',
      actions: ['high_protein', 'post_workout_protein', 'adequate_carbs'],
      preferIngredients: ['鶏むね肉', '卵', 'ギリシャヨーグルト', '豆腐', 'サーモン', '牛赤身肉'],
    });
  }
  
  // 免疫力向上
  if (goals.includes('immunity')) {
    focuses.push({
      condition: 'immunity_boost',
      actions: ['increase_vitamin_c', 'increase_zinc', 'increase_vitamin_d'],
      preferIngredients: ['柑橘類', 'ブロッコリー', '牡蠣', 'きのこ', '卵', 'にんにく', '生姜'],
    });
  }
  
  // 集中力向上
  if (goals.includes('focus')) {
    focuses.push({
      condition: 'focus_improvement',
      actions: ['low_gi', 'increase_omega3', 'steady_blood_sugar'],
      preferIngredients: ['青魚', 'ナッツ', 'ブルーベリー', '卵', 'アボカド', 'ダークチョコレート'],
    });
  }
  
  // 冷え性
  if (profile.coldSensitivity) {
    focuses.push({
      condition: 'cold_sensitivity',
      actions: ['warming_foods', 'increase_circulation'],
      preferIngredients: ['生姜', 'ねぎ', 'にんにく', '唐辛子', 'シナモン', '根菜類'],
    });
  }
  
  // むくみ
  if (profile.swellingProne) {
    focuses.push({
      condition: 'swelling',
      actions: ['increase_potassium', 'reduce_sodium', 'increase_water'],
      preferIngredients: ['きゅうり', 'スイカ', 'バナナ', 'アボカド', '小豆', 'とうもろこし'],
    });
  }
  
  return focuses;
}

// ==============================
// 食事制約の構築
// ==============================
export function buildMealConstraints(profile: UserProfile): MealConstraints {
  const healthFocus = buildHealthFocus(profile);
  
  // 除外食材
  const excludeIngredients: string[] = [
    ...(profile.dietFlags?.allergies || []),
    ...(profile.dietFlags?.dislikes || []),
  ];
  
  // 健康状態による除外
  for (const focus of healthFocus) {
    if (focus.excludeIngredients) {
      excludeIngredients.push(...focus.excludeIngredients);
    }
  }
  
  // 宗教的制限
  if (profile.religiousRestrictions === 'halal') {
    excludeIngredients.push('豚肉', 'ベーコン', 'ハム', 'ソーセージ', 'ラード', 'アルコール');
  } else if (profile.religiousRestrictions === 'kosher') {
    excludeIngredients.push('豚肉', '甲殻類', 'エビ', 'カニ', 'イカ', 'タコ');
  } else if (profile.religiousRestrictions === 'buddhist') {
    excludeIngredients.push('にんにく', 'ニラ', 'らっきょう', 'ねぎ', 'あさつき');
  }
  
  // 食事スタイルによる除外
  if (profile.dietStyle === 'vegetarian') {
    excludeIngredients.push('肉', '魚', '鶏肉', '豚肉', '牛肉');
  } else if (profile.dietStyle === 'vegan') {
    excludeIngredients.push('肉', '魚', '卵', '乳製品', 'チーズ', 'バター', 'ヨーグルト');
  } else if (profile.dietStyle === 'pescatarian') {
    excludeIngredients.push('肉', '鶏肉', '豚肉', '牛肉');
  } else if (profile.dietStyle === 'gluten_free') {
    excludeIngredients.push('小麦', 'パン', 'パスタ', 'うどん', 'ラーメン', '醤油');
  }
  
  // 優先食材
  const preferredIngredients: string[] = [
    ...(profile.favoriteIngredients || []),
  ];
  
  for (const focus of healthFocus) {
    if (focus.preferIngredients) {
      preferredIngredients.push(...focus.preferIngredients);
    }
  }
  
  // 調理時間
  const maxCookingTime = {
    weekday: profile.weekdayCookingMinutes || 30,
    weekend: profile.weekendCookingMinutes || 60,
  };
  
  // 料理ジャンル比率
  const cuisineRatio: Record<string, number> = (profile.cuisinePreferences as unknown as Record<string, number>) || {
    japanese: 4,
    western: 3,
    chinese: 3,
  };
  
  // 家族への配慮
  const familyConsiderations: string[] = [];
  if (profile.hasChildren && profile.childrenAges?.some(age => age < 10)) {
    familyConsiderations.push('child_friendly', 'mild_taste', 'easy_to_eat');
  }
  if (profile.hasElderly) {
    familyConsiderations.push('soft_texture', 'easy_to_chew', 'low_salt');
  }
  if (profile.householdMembers?.some(m => m.allergies?.length)) {
    familyConsiderations.push('allergy_aware');
  }
  
  return {
    excludeIngredients: [...new Set(excludeIngredients)],
    excludeCookingMethods: profile.dislikedCookingMethods || [],
    preferredIngredients: [...new Set(preferredIngredients)],
    maxCookingTime,
    healthFocus,
    cuisineRatio,
    budget: profile.weeklyFoodBudget || null,
    familyConsiderations,
  };
}

// ==============================
// AIプロンプト用のプロファイルサマリー生成
// ==============================
export function generateProfileSummaryForAI(profile: UserProfile): string {
  const target = calculateNutritionTarget(profile);
  const constraints = buildMealConstraints(profile);
  
  let summary = `
【ユーザープロファイル】
- 年齢: ${profile.age || '不明'}歳
- 性別: ${profile.gender === 'male' ? '男性' : profile.gender === 'female' ? '女性' : '不明'}
- 身長: ${profile.height || '不明'}cm / 体重: ${profile.weight || '不明'}kg
${profile.targetWeight ? `- 目標体重: ${profile.targetWeight}kg` : ''}
- 目標: ${profile.fitnessGoals?.length ? profile.fitnessGoals.join(', ') : profile.goalText || '健康維持'}

【仕事・生活】
- 職種: ${profile.occupation || '未設定'}
${profile.industry ? `- 業界: ${profile.industry}` : ''}
- 勤務形態: ${translateWorkStyle(profile.workStyle)}
${profile.overtimeFrequency ? `- 残業頻度: ${translateFrequency(profile.overtimeFrequency)}` : ''}
- 運動: 週${profile.weeklyExerciseMinutes || 0}分
${profile.sportsActivities?.length ? `- スポーツ: ${profile.sportsActivities.map(s => s.name).join(', ')}` : ''}

【健康状態】
${profile.healthConditions?.length ? `- 持病・注意点: ${profile.healthConditions.join(', ')}` : '- 特になし'}
${profile.sleepQuality ? `- 睡眠の質: ${translateQuality(profile.sleepQuality)}` : ''}
${profile.stressLevel ? `- ストレスレベル: ${translateStress(profile.stressLevel)}` : ''}
${profile.pregnancyStatus && profile.pregnancyStatus !== 'none' ? `- 妊娠・授乳: ${profile.pregnancyStatus === 'pregnant' ? '妊娠中' : '授乳中'}` : ''}

【食事制限】
- アレルギー: ${profile.dietFlags?.allergies?.join(', ') || 'なし'}
- 苦手: ${profile.dietFlags?.dislikes?.join(', ') || 'なし'}
- 食事スタイル: ${translateDietStyle(profile.dietStyle)}
${profile.religiousRestrictions && profile.religiousRestrictions !== 'none' ? `- 宗教的制限: ${profile.religiousRestrictions}` : ''}

【調理環境】
- 料理経験: ${translateCookingExperience(profile.cookingExperience)}
- 平日調理時間: ${profile.weekdayCookingMinutes || 30}分
- 休日調理時間: ${profile.weekendCookingMinutes || 60}分
${profile.kitchenAppliances?.length ? `- 調理器具: ${profile.kitchenAppliances.join(', ')}` : ''}
${profile.mealPrepOk ? '- 作り置き: OK' : '- 作り置き: NG'}

【嗜好】
${profile.favoriteIngredients?.length ? `- 好きな食材: ${profile.favoriteIngredients.join(', ')}` : ''}
${profile.favoriteDishes?.length ? `- 好きな料理: ${profile.favoriteDishes.join(', ')}` : ''}
${formatCuisinePreferences(profile.cuisinePreferences)}

【栄養目標】
- 1日の目標カロリー: ${target.dailyCalories}kcal
- タンパク質: ${target.protein}g
- 脂質: ${target.fat}g
- 炭水化物: ${target.carbs}g
- 食物繊維: ${target.fiber}g以上
${target.sodium < 2300 ? `- 塩分: ${target.sodium / 1000}g以下（減塩）` : ''}

【特別な配慮】
${constraints.healthFocus.map(h => `- ${translateHealthCondition(h.condition)}: ${h.actions.map(a => translateAction(a)).join(', ')}`).join('\n')}

【予算】
${profile.weeklyFoodBudget ? `- 週間予算: ${profile.weeklyFoodBudget.toLocaleString()}円` : '- 特に制限なし'}

【家族構成】
- 人数: ${profile.familySize || 1}人
${profile.hasChildren ? `- 子供あり（${profile.childrenAges?.join('歳, ')}歳）` : ''}
${profile.hasElderly ? '- 高齢者同居' : ''}
`;

  return summary.trim();
}

// ==============================
// ヘルパー関数
// ==============================

function translateWorkStyle(style: string | null | undefined): string {
  const map: Record<string, string> = {
    fulltime: 'フルタイム勤務',
    parttime: 'パートタイム',
    freelance: 'フリーランス',
    remote: 'リモートワーク',
    shift: 'シフト勤務',
    student: '学生',
    homemaker: '主婦/主夫',
    retired: '退職者',
    desk: 'デスクワーク',
    stand: '立ち仕事',
    physical: '肉体労働',
  };
  return map[style || ''] || '未設定';
}

function translateFrequency(freq: string | null | undefined): string {
  const map: Record<string, string> = {
    never: 'なし',
    rarely: 'ほとんどなし',
    sometimes: '時々',
    often: '頻繁',
    daily: '毎日',
  };
  return map[freq || ''] || '未設定';
}

function translateQuality(quality: string | null | undefined): string {
  const map: Record<string, string> = {
    good: '良好',
    average: '普通',
    poor: '悪い',
  };
  return map[quality || ''] || '未設定';
}

function translateStress(stress: string | null | undefined): string {
  const map: Record<string, string> = {
    low: '低い',
    medium: '普通',
    high: '高い',
  };
  return map[stress || ''] || '未設定';
}

function translateDietStyle(style: string | null | undefined): string {
  const map: Record<string, string> = {
    normal: '通常',
    vegetarian: 'ベジタリアン',
    vegan: 'ヴィーガン',
    pescatarian: 'ペスカタリアン',
    flexitarian: 'フレキシタリアン',
    gluten_free: 'グルテンフリー',
    low_fodmap: '低FODMAP',
    keto: 'ケトジェニック',
  };
  return map[style || ''] || '通常';
}

function translateCookingExperience(exp: string | null | undefined): string {
  const map: Record<string, string> = {
    beginner: '初心者（1年未満）',
    intermediate: '中級者（1-3年）',
    advanced: '上級者（3年以上）',
  };
  return map[exp || ''] || '初心者';
}

function translateHealthCondition(condition: string): string {
  const map: Record<string, string> = {
    high_blood_pressure: '高血圧対策',
    diabetes: '糖尿病対策',
    dyslipidemia: '脂質異常症対策',
    anemia: '貧血対策',
    gout: '痛風対策',
    skin_improvement: '美肌対策',
    gut_health: '腸活',
    muscle_building: '筋肉増加',
    immunity_boost: '免疫力向上',
    focus_improvement: '集中力向上',
    cold_sensitivity: '冷え性対策',
    swelling: 'むくみ対策',
  };
  return map[condition] || condition;
}

function translateAction(action: string): string {
  const map: Record<string, string> = {
    reduce_salt_to_6g: '塩分6g以下',
    increase_potassium: 'カリウム増',
    increase_magnesium: 'マグネシウム増',
    dash_diet: 'DASH食',
    low_gi: '低GI',
    reduce_sugar: '糖質制限',
    increase_fiber: '食物繊維増',
    control_portions: '適量',
    reduce_saturated_fat: '飽和脂肪酸減',
    increase_omega3: 'オメガ3増',
    increase_iron: '鉄分増',
    increase_vitamin_c: 'ビタミンC増',
    avoid_tannin_with_meals: '食事中のタンニン回避',
    reduce_purine: 'プリン体制限',
    increase_water: '水分増',
    avoid_alcohol: 'アルコール回避',
    increase_vitamin_a: 'ビタミンA増',
    increase_vitamin_e: 'ビタミンE増',
    increase_collagen: 'コラーゲン増',
    increase_fermented_foods: '発酵食品増',
    increase_prebiotics: 'プレバイオティクス増',
    high_protein: '高タンパク',
    post_workout_protein: '運動後タンパク質',
    adequate_carbs: '適切な炭水化物',
    increase_zinc: '亜鉛増',
    increase_vitamin_d: 'ビタミンD増',
    steady_blood_sugar: '血糖値安定',
    warming_foods: '温め食材',
    increase_circulation: '血行促進',
    reduce_sodium: '減塩',
  };
  return map[action] || action;
}

function formatCuisinePreferences(prefs: any): string {
  if (!prefs) return '';
  
  const labels: Record<string, string> = {
    japanese: '和食',
    western: '洋食',
    chinese: '中華',
    italian: 'イタリアン',
    french: 'フレンチ',
    ethnic: 'エスニック',
    korean: '韓国料理',
    mexican: 'メキシカン',
  };
  
  const items = Object.entries(prefs)
    .filter(([_, v]) => typeof v === 'number' && v >= 4)
    .map(([k]) => labels[k] || k);
  
  if (items.length === 0) return '';
  return `- 好きなジャンル: ${items.join(', ')}`;
}

