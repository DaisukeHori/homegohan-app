import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { calculateNutritionTargets, type NutritionCalculatorInput } from '@homegohan/core';

/**
 * 栄養目標の取得・更新API
 * 
 * GET: 栄養目標を取得（auto_calculate=true または未設定の場合は自動計算）
 * PUT: 栄養目標を更新
 */

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

      // 共通モジュールで計算
      const calculatorInput: NutritionCalculatorInput = {
        id: user.id,
        age: profile?.age,
        gender: profile?.gender,
        height: profile?.height,
        weight: profile?.weight,
        work_style: profile?.work_style,
        exercise_intensity: profile?.exercise_intensity,
        exercise_frequency: profile?.exercise_frequency,
        exercise_duration_per_session: profile?.exercise_duration_per_session,
        nutrition_goal: profile?.nutrition_goal,
        weight_change_rate: profile?.weight_change_rate,
        health_conditions: profile?.health_conditions,
        medications: profile?.medications,
        pregnancy_status: profile?.pregnancy_status,
      };

      const { targetData } = calculateNutritionTargets(calculatorInput);
      
      return NextResponse.json({
        targets: {
          id: null,
          userId: user.id,
          dailyCalories: targetData.daily_calories,
          proteinG: targetData.protein_g,
          fatG: targetData.fat_g,
          carbsG: targetData.carbs_g,
          sodiumG: targetData.sodium_g,
          sugarG: targetData.sugar_g,
          fiberG: targetData.fiber_g,
          potassiumMg: targetData.potassium_mg,
          calciumMg: targetData.calcium_mg,
          phosphorusMg: targetData.phosphorus_mg,
          ironMg: targetData.iron_mg,
          zincMg: targetData.zinc_mg,
          iodineUg: targetData.iodine_ug,
          cholesterolMg: targetData.cholesterol_mg,
          vitaminB1Mg: targetData.vitamin_b1_mg,
          vitaminB2Mg: targetData.vitamin_b2_mg,
          vitaminB6Mg: targetData.vitamin_b6_mg,
          vitaminB12Ug: targetData.vitamin_b12_ug,
          folicAcidUg: targetData.folic_acid_ug,
          vitaminCMg: targetData.vitamin_c_mg,
          vitaminAUg: targetData.vitamin_a_ug,
          vitaminDUg: targetData.vitamin_d_ug,
          vitaminKUg: targetData.vitamin_k_ug,
          vitaminEMg: targetData.vitamin_e_mg,
          saturatedFatG: targetData.saturated_fat_g,
          autoCalculate: true,
          calculationBasis: targetData.calculation_basis,
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
        calculationBasis: targets.calculation_basis,
      },
      isCalculated: false,
    });

  } catch (error: unknown) {
    console.error('Failed to fetch nutrition targets:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
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
    const dbData: Record<string, unknown> = {
      user_id: user.id,
      auto_calculate: body.autoCalculate ?? false,
      updated_at: new Date().toISOString(),
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

  } catch (error: unknown) {
    console.error('Failed to update nutrition targets:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
