import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

// デフォルトの栄養目標値（成人）
const DEFAULT_TARGETS = {
  daily_calories: 2000,
  protein_g: 60,
  fat_g: 55,
  carbs_g: 300,
  sodium_g: 2.0,
  sugar_g: 25,
  fiber_g: 20,
  potassium_mg: 2500,
  calcium_mg: 650,
  phosphorus_mg: 800,
  iron_mg: 7.5,
  zinc_mg: 10,
  iodine_ug: 130,
  cholesterol_mg: 300,
  vitamin_b1_mg: 1.2,
  vitamin_b2_mg: 1.4,
  vitamin_b6_mg: 1.4,
  vitamin_b12_ug: 2.4,
  folic_acid_ug: 240,
  vitamin_c_mg: 100,
  vitamin_a_ug: 850,
  vitamin_d_ug: 8.5,
  vitamin_k_ug: 150,
  vitamin_e_mg: 6.5,
  saturated_fat_g: 16,
};

// 栄養目標を取得
export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // ユーザーの栄養目標を取得
    const { data: targets, error } = await supabase
      .from('nutrition_targets')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    // 目標がない場合、またはauto_calculateがtrueの場合は自動計算
    if (!targets || targets.auto_calculate) {
      // ユーザープロフィールを取得して計算
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single();

      const calculatedTargets = calculateNutritionTargets(profile);
      
      return NextResponse.json({
        targets: {
          ...calculatedTargets,
          autoCalculate: true,
        },
        isCalculated: true,
      });
    }

    // キャメルケースに変換
    return NextResponse.json({
      targets: {
        id: targets.id,
        userId: targets.user_id,
        dailyCalories: targets.daily_calories,
        proteinG: targets.protein_g,
        fatG: targets.fat_g,
        carbsG: targets.carbs_g,
        sodiumG: targets.sodium_g,
        sugarG: targets.sugar_g,
        fiberG: targets.fiber_g,
        potassiumMg: targets.potassium_mg,
        calciumMg: targets.calcium_mg,
        phosphorusMg: targets.phosphorus_mg,
        ironMg: targets.iron_mg,
        zincMg: targets.zinc_mg,
        iodineUg: targets.iodine_ug,
        cholesterolMg: targets.cholesterol_mg,
        vitaminB1Mg: targets.vitamin_b1_mg,
        vitaminB2Mg: targets.vitamin_b2_mg,
        vitaminB6Mg: targets.vitamin_b6_mg,
        vitaminB12Ug: targets.vitamin_b12_ug,
        folicAcidUg: targets.folic_acid_ug,
        vitaminCMg: targets.vitamin_c_mg,
        vitaminAUg: targets.vitamin_a_ug,
        vitaminDUg: targets.vitamin_d_ug,
        vitaminKUg: targets.vitamin_k_ug,
        vitaminEMg: targets.vitamin_e_mg,
        saturatedFatG: targets.saturated_fat_g,
        autoCalculate: targets.auto_calculate,
      },
      isCalculated: false,
    });

  } catch (error: any) {
    console.error('Failed to fetch nutrition targets:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 栄養目標を更新
export async function PUT(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    
    // スネークケースに変換
    const dbData: any = {
      user_id: user.id,
      auto_calculate: body.autoCalculate ?? false,
    };

    if (body.dailyCalories !== undefined) dbData.daily_calories = body.dailyCalories;
    if (body.proteinG !== undefined) dbData.protein_g = body.proteinG;
    if (body.fatG !== undefined) dbData.fat_g = body.fatG;
    if (body.carbsG !== undefined) dbData.carbs_g = body.carbsG;
    if (body.sodiumG !== undefined) dbData.sodium_g = body.sodiumG;
    if (body.sugarG !== undefined) dbData.sugar_g = body.sugarG;
    if (body.fiberG !== undefined) dbData.fiber_g = body.fiberG;
    if (body.potassiumMg !== undefined) dbData.potassium_mg = body.potassiumMg;
    if (body.calciumMg !== undefined) dbData.calcium_mg = body.calciumMg;
    if (body.phosphorusMg !== undefined) dbData.phosphorus_mg = body.phosphorusMg;
    if (body.ironMg !== undefined) dbData.iron_mg = body.ironMg;
    if (body.zincMg !== undefined) dbData.zinc_mg = body.zincMg;
    if (body.iodineUg !== undefined) dbData.iodine_ug = body.iodineUg;
    if (body.cholesterolMg !== undefined) dbData.cholesterol_mg = body.cholesterolMg;
    if (body.vitaminB1Mg !== undefined) dbData.vitamin_b1_mg = body.vitaminB1Mg;
    if (body.vitaminB2Mg !== undefined) dbData.vitamin_b2_mg = body.vitaminB2Mg;
    if (body.vitaminB6Mg !== undefined) dbData.vitamin_b6_mg = body.vitaminB6Mg;
    if (body.vitaminB12Ug !== undefined) dbData.vitamin_b12_ug = body.vitaminB12Ug;
    if (body.folicAcidUg !== undefined) dbData.folic_acid_ug = body.folicAcidUg;
    if (body.vitaminCMg !== undefined) dbData.vitamin_c_mg = body.vitaminCMg;
    if (body.vitaminAUg !== undefined) dbData.vitamin_a_ug = body.vitaminAUg;
    if (body.vitaminDUg !== undefined) dbData.vitamin_d_ug = body.vitaminDUg;
    if (body.vitaminKUg !== undefined) dbData.vitamin_k_ug = body.vitaminKUg;
    if (body.vitaminEMg !== undefined) dbData.vitamin_e_mg = body.vitaminEMg;
    if (body.saturatedFatG !== undefined) dbData.saturated_fat_g = body.saturatedFatG;

    // UPSERT
    const { data, error } = await supabase
      .from('nutrition_targets')
      .upsert(dbData, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, targets: data });

  } catch (error: any) {
    console.error('Failed to update nutrition targets:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// 栄養目標を自動計算
function calculateNutritionTargets(profile: any) {
  const targets = { ...DEFAULT_TARGETS };
  
  if (!profile) return targets;

  // 基礎代謝計算（Mifflin-St Jeor式）
  let bmr = 1800;
  if (profile.weight && profile.height && profile.age) {
    if (profile.gender === 'male') {
      bmr = Math.round(10 * profile.weight + 6.25 * profile.height - 5 * profile.age + 5);
    } else {
      bmr = Math.round(10 * profile.weight + 6.25 * profile.height - 5 * profile.age - 161);
    }
  }

  // 活動係数
  let activityMultiplier = 1.3;
  const weeklyExercise = profile.weekly_exercise_minutes || 0;
  if (weeklyExercise > 300) activityMultiplier = 1.7;
  else if (weeklyExercise > 150) activityMultiplier = 1.5;
  else if (weeklyExercise > 60) activityMultiplier = 1.4;

  let tdee = bmr * activityMultiplier;

  // 目標による調整
  const goals = profile.fitness_goals || [];
  if (goals.includes('lose_weight')) {
    tdee -= 500;
  } else if (goals.includes('gain_weight') || goals.includes('build_muscle')) {
    tdee += 300;
  }

  targets.daily_calories = Math.max(Math.round(tdee), 1200);

  // PFCバランス
  let proteinRatio = 0.20;
  let fatRatio = 0.25;
  let carbsRatio = 0.55;

  if (goals.includes('build_muscle')) {
    proteinRatio = 0.30;
    carbsRatio = 0.45;
  } else if (goals.includes('lose_weight')) {
    proteinRatio = 0.25;
    fatRatio = 0.30;
    carbsRatio = 0.45;
  }

  targets.protein_g = Math.round((targets.daily_calories * proteinRatio) / 4);
  targets.fat_g = Math.round((targets.daily_calories * fatRatio) / 9);
  targets.carbs_g = Math.round((targets.daily_calories * carbsRatio) / 4);

  // 健康状態による調整
  const conditions = profile.health_conditions || [];
  if (conditions.includes('高血圧')) {
    targets.sodium_g = 1.5;
    targets.potassium_mg = 3500;
  }
  if (conditions.includes('糖尿病')) {
    targets.sugar_g = 15;
    targets.fiber_g = 25;
  }
  if (conditions.includes('脂質異常症')) {
    targets.cholesterol_mg = 200;
    targets.saturated_fat_g = 10;
  }
  if (conditions.includes('貧血')) {
    targets.iron_mg = 15;
    targets.vitamin_b12_ug = 3.0;
    targets.folic_acid_ug = 400;
  }

  // 性別による調整
  if (profile.gender === 'female') {
    targets.iron_mg = 10.5;
    targets.folic_acid_ug = 240;
    if (profile.pregnancy_status === 'pregnant') {
      targets.folic_acid_ug = 480;
      targets.iron_mg = 21.5;
      targets.calcium_mg = 800;
    } else if (profile.pregnancy_status === 'nursing') {
      targets.daily_calories += 350;
      targets.calcium_mg = 800;
    }
  }

  return targets;
}

