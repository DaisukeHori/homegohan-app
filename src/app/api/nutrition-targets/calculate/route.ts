import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

/**
 * 栄養目標を自動計算するAPI
 * 
 * 計算ロジック:
 * 1. 基礎代謝（BMR）をMifflin-St Jeor式で計算
 * 2. 活動係数（PAL）を仕事スタイル+運動で決定
 * 3. 総消費カロリー（TDEE）= BMR × PAL
 * 4. 目標に応じてカロリーを調整（減量: -500〜-1000kcal、増量: +300〜+500kcal）
 * 5. PFCバランスを目標に応じて設定
 * 6. ビタミン・ミネラルは厚生労働省の推奨値をベースに
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // ユーザープロフィールを取得
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    // 必要な情報がない場合はデフォルト値を使用
    const age = profile.age || 30;
    const gender = profile.gender || 'unspecified';
    const height = profile.height || 165;
    const weight = profile.weight || 60;
    const workStyle = profile.work_style || 'sedentary';
    const exerciseIntensity = profile.exercise_intensity || 'moderate';
    const exerciseFrequency = profile.exercise_frequency || 3;
    const nutritionGoal = profile.nutrition_goal || 'maintain';
    const weightChangeRate = profile.weight_change_rate || 'moderate';
    const healthConditions = profile.health_conditions || [];
    const medications = profile.medications || [];

    // 1. 基礎代謝（BMR）をMifflin-St Jeor式で計算
    let bmr: number;
    if (gender === 'male') {
      bmr = 10 * weight + 6.25 * height - 5 * age + 5;
    } else if (gender === 'female') {
      bmr = 10 * weight + 6.25 * height - 5 * age - 161;
    } else {
      // 性別不明の場合は中間値
      bmr = 10 * weight + 6.25 * height - 5 * age - 78;
    }

    // 2. 活動係数（PAL）を決定
    // 仕事スタイルベースの係数
    const workStylePAL: Record<string, number> = {
      sedentary: 1.2,      // 座り仕事
      light_active: 1.375, // 軽い活動
      moderately_active: 1.55, // 普通の活動
      very_active: 1.725,  // 激しい活動
      student: 1.375,
      homemaker: 1.375,
    };

    // 運動強度による追加係数
    const exerciseBonus: Record<string, number> = {
      light: 0.05,
      moderate: 0.1,
      intense: 0.15,
      athlete: 0.25,
    };

    // 運動頻度による係数調整（週3日を基準）
    const frequencyMultiplier = exerciseFrequency / 3;

    const basePAL = workStylePAL[workStyle] || 1.375;
    const exerciseAddition = (exerciseBonus[exerciseIntensity] || 0.1) * frequencyMultiplier;
    const pal = Math.min(basePAL + exerciseAddition, 2.5); // 上限2.5

    // 3. 総消費カロリー（TDEE）
    const tdee = Math.round(bmr * pal);

    // 4. 目標に応じたカロリー調整
    let targetCalories: number;
    let proteinRatio: number; // タンパク質の割合
    let fatRatio: number;     // 脂質の割合
    let carbsRatio: number;   // 炭水化物の割合

    switch (nutritionGoal) {
      case 'lose_weight':
        // 減量: カロリー不足を作る
        const deficitMap: Record<string, number> = {
          slow: 300,      // ゆっくり
          moderate: 500,  // 普通
          aggressive: 750, // 積極的
        };
        const deficit = deficitMap[weightChangeRate] || 500;
        targetCalories = tdee - deficit;
        // 減量時は高タンパク（筋肉維持のため）
        proteinRatio = 0.30; // 30%
        fatRatio = 0.25;     // 25%
        carbsRatio = 0.45;   // 45%
        break;

      case 'gain_muscle':
        // 増量: カロリー過剰を作る
        const surplusMap: Record<string, number> = {
          slow: 200,
          moderate: 350,
          aggressive: 500,
        };
        const surplus = surplusMap[weightChangeRate] || 350;
        targetCalories = tdee + surplus;
        // 増量時は高タンパク・高炭水化物
        proteinRatio = 0.30; // 30%
        fatRatio = 0.20;     // 20%
        carbsRatio = 0.50;   // 50%
        break;

      case 'athlete_performance':
        // 競技パフォーマンス: 高カロリー・高タンパク
        targetCalories = tdee + 300;
        proteinRatio = 0.25; // 25%
        fatRatio = 0.25;     // 25%
        carbsRatio = 0.50;   // 50%（エネルギー源として重要）
        break;

      default: // maintain
        targetCalories = tdee;
        proteinRatio = 0.20; // 20%
        fatRatio = 0.25;     // 25%
        carbsRatio = 0.55;   // 55%
    }

    // 最低カロリーの保証（1200kcal未満にならない）
    targetCalories = Math.max(targetCalories, gender === 'male' ? 1500 : 1200);

    // 5. マクロ栄養素の計算
    const proteinG = Math.round((targetCalories * proteinRatio) / 4); // 1g = 4kcal
    const fatG = Math.round((targetCalories * fatRatio) / 9);         // 1g = 9kcal
    const carbsG = Math.round((targetCalories * carbsRatio) / 4);     // 1g = 4kcal

    // 6. 持病・薬による調整
    let sodiumG = 7.0; // デフォルト（日本人の平均的な摂取量）
    let potassiumMg = 2500;
    let fiberG = 21;
    let fiberSolubleG = 7; // 水溶性食物繊維（目標の約1/3）
    let fiberInsolubleG = 14; // 不溶性食物繊維（目標の約2/3）
    let cholesterolMg = 300;
    let sugarG = 50;
    let calciumMg = 650;
    let ironMg = gender === 'female' ? 10.5 : 7.5;
    let vitaminKUg = 150;

    // 高血圧: 塩分制限
    if (healthConditions.includes('高血圧')) {
      sodiumG = 6.0; // 6g以下に制限
      potassiumMg = 3500; // カリウム増加（ナトリウム排出促進）
    }

    // 糖尿病: 糖質・炭水化物制限
    if (healthConditions.includes('糖尿病')) {
      sugarG = 25; // 糖質を半分に
      carbsRatio = 0.40;
    }

    // 脂質異常症: 脂質・コレステロール制限
    if (healthConditions.includes('脂質異常症')) {
      fatRatio = 0.20;
      cholesterolMg = 200;
    }

    // 腎臓病: タンパク質・カリウム制限
    if (healthConditions.includes('腎臓病')) {
      proteinRatio = 0.15;
      potassiumMg = 2000;
    }

    // 心臓病: 塩分・飽和脂肪酸制限
    if (healthConditions.includes('心臓病')) {
      sodiumG = 6.0;
      cholesterolMg = 200;
    }

    // 骨粗しょう症: カルシウム・ビタミンD増加
    if (healthConditions.includes('骨粗しょう症')) {
      calciumMg = 1000;
    }

    // 貧血: 鉄分・ビタミンB12・葉酸増加
    if (healthConditions.includes('貧血')) {
      ironMg = 15;
    }

    // 痛風: プリン体制限（タンパク質の質に注意が必要だが、量は調整）
    // if (healthConditions.includes('痛風')) { /* 特別な調整は献立生成時に */ }

    // 薬による調整
    // ワーファリン: ビタミンK制限
    if (medications.includes('warfarin')) {
      vitaminKUg = 80; // 一定量を維持（変動を避ける）
    }

    // 降圧剤（ACE阻害薬）: カリウム過剰に注意
    if (medications.includes('antihypertensive')) {
      potassiumMg = Math.min(potassiumMg, 2500);
    }

    // 7. 厚生労働省推奨値ベースのビタミン・ミネラル
    const vitaminB1Mg = targetCalories / 1000 * 0.54; // カロリー1000kcalあたり0.54mg
    const vitaminB2Mg = targetCalories / 1000 * 0.60;
    const vitaminB6Mg = 1.2;
    const vitaminB12Ug = 2.4;
    const vitaminCMg = 100;
    const vitaminDUg = 8.5;
    const vitaminEMg = gender === 'male' ? 6.5 : 6.0;
    const vitaminAUg = gender === 'male' ? 850 : 650;
    const folicAcidUg = 240;
    const zincMg = gender === 'male' ? 11 : 8;
    const phosphorusMg = 800;
    const iodineUg = 130;

    // 脂肪酸の目安
    const saturatedFatG = Math.round(targetCalories * 0.07 / 9); // 7%以下
    const monounsaturatedFatG = Math.round(targetCalories * 0.10 / 9);
    const polyunsaturatedFatG = Math.round(targetCalories * 0.08 / 9);

    // 計算根拠を保存
    const calculationBasis = {
      bmr: Math.round(bmr),
      pal: Math.round(pal * 100) / 100,
      tdee,
      goal: nutritionGoal,
      weightChangeRate,
      adjustments: {
        healthConditions,
        medications,
      },
      calculatedAt: new Date().toISOString(),
    };

    // 8. nutrition_targetsを更新/作成
    const targetData = {
      user_id: user.id,
      daily_calories: targetCalories,
      protein_g: proteinG,
      fat_g: fatG,
      carbs_g: carbsG,
      fiber_g: fiberG,
      fiber_soluble_g: fiberSolubleG,
      fiber_insoluble_g: fiberInsolubleG,
      sodium_g: sodiumG,
      sugar_g: sugarG,
      potassium_mg: potassiumMg,
      calcium_mg: calciumMg,
      phosphorus_mg: phosphorusMg,
      iron_mg: ironMg,
      zinc_mg: zincMg,
      iodine_ug: iodineUg,
      cholesterol_mg: cholesterolMg,
      vitamin_b1_mg: Math.round(vitaminB1Mg * 100) / 100,
      vitamin_b2_mg: Math.round(vitaminB2Mg * 100) / 100,
      vitamin_c_mg: vitaminCMg,
      vitamin_b6_mg: vitaminB6Mg,
      vitamin_b12_ug: vitaminB12Ug,
      folic_acid_ug: folicAcidUg,
      vitamin_a_ug: vitaminAUg,
      vitamin_d_ug: vitaminDUg,
      vitamin_k_ug: vitaminKUg,
      vitamin_e_mg: vitaminEMg,
      saturated_fat_g: saturatedFatG,
      monounsaturated_fat_g: monounsaturatedFatG,
      polyunsaturated_fat_g: polyunsaturatedFatG,
      calculation_basis: calculationBasis,
      last_calculated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // 既存レコードがあるか確認
    const { data: existing } = await supabase
      .from('nutrition_targets')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (existing) {
      // 更新
      const { error: updateError } = await supabase
        .from('nutrition_targets')
        .update(targetData)
        .eq('user_id', user.id);

      if (updateError) throw updateError;
    } else {
      // 新規作成
      const { error: insertError } = await supabase
        .from('nutrition_targets')
        .insert(targetData);

      if (insertError) throw insertError;
    }

    // user_profilesにも運動・目標情報を保存
    const { error: profileUpdateError } = await supabase
      .from('user_profiles')
      .update({
        nutrition_goal: nutritionGoal,
        weight_change_rate: weightChangeRate,
        exercise_intensity: exerciseIntensity,
        exercise_frequency: exerciseFrequency,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (profileUpdateError) {
      console.error('Profile update error:', profileUpdateError);
    }

    return NextResponse.json({
      success: true,
      targets: {
        calories: targetCalories,
        protein: proteinG,
        fat: fatG,
        carbs: carbsG,
        fiber: fiberG,
        sodium: sodiumG,
      },
      calculation: {
        bmr: Math.round(bmr),
        pal: Math.round(pal * 100) / 100,
        tdee,
        goal: nutritionGoal,
      },
    });

  } catch (error: any) {
    console.error('Nutrition targets calculation error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

