import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { calculateNutritionTargets, type NutritionCalculatorInput } from '@homegohan/core';

/**
 * 栄養目標を計算・保存するAPI
 * 
 * 共通モジュール（DRI2020準拠）を使用
 * - BMR: Mifflin-St Jeor式
 * - PAL: 仕事スタイル + 運動で決定
 * - PFC: 目標 + 持病に応じて調整
 * - ビタミン・ミネラル: DRI2020参照
 */
export async function POST() {
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

    // 共通モジュールで計算
    const calculatorInput: NutritionCalculatorInput = {
      id: user.id,
      age: profile.age,
      gender: profile.gender,
      height: profile.height,
      weight: profile.weight,
      work_style: profile.work_style,
      exercise_intensity: profile.exercise_intensity,
      exercise_frequency: profile.exercise_frequency,
      exercise_duration_per_session: profile.exercise_duration_per_session,
      nutrition_goal: profile.nutrition_goal,
      weight_change_rate: profile.weight_change_rate,
      health_conditions: profile.health_conditions,
      medications: profile.medications,
      pregnancy_status: profile.pregnancy_status,
    };

    const { targetData, summary, calculationBasis } = calculateNutritionTargets(calculatorInput);

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

    // user_profilesにも運動・目標情報を保存（必要に応じて）
    const { error: profileUpdateError } = await supabase
      .from('user_profiles')
      .update({
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    if (profileUpdateError) {
      console.error('Profile update error:', profileUpdateError);
    }

    return NextResponse.json({
      success: true,
      targets: {
        calories: summary.calories,
        protein: summary.protein,
        fat: summary.fat,
        carbs: summary.carbs,
        fiber: summary.fiber,
        sodium: summary.sodium,
      },
      calculation: {
        bmr: calculationBasis.energy.bmr.result_kcal,
        pal: calculationBasis.energy.pal.result,
        tdee: calculationBasis.energy.tdee_kcal,
        goal: calculationBasis.inputs.nutrition_goal,
      },
      calculationBasis,
    });

  } catch (error: unknown) {
    console.error('Nutrition targets calculation error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
