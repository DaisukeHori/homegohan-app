import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { calculateNutritionTargets, type NutritionCalculatorInput } from '@homegohan/core'

/**
 * オンボーディング完了API (OB-API-02)
 * 
 * 1. onboarding_completed_at を設定
 * 2. 共通モジュール（DRI2020準拠）で栄養目標を計算・保存
 */
export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const now = new Date().toISOString()

    // 現在のプロファイルを取得
    const { data: profile, error: fetchError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (fetchError) {
      console.error('Profile fetch error:', fetchError)
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    // 完了フラグを設定
    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({
        onboarding_completed_at: now,
        updated_at: now,
      })
      .eq('id', user.id)

    if (updateError) {
      console.error('Onboarding complete error:', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // 栄養目標を計算・保存（共通モジュール使用）
    try {
      // プロフィールをNutritionCalculatorInputに変換
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
      }

      const { targetData } = calculateNutritionTargets(calculatorInput)
      
      // user_idは計算結果に含まれているのでそのまま使用
      const { data: existingTarget } = await supabase
        .from('nutrition_targets')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle()

      if (existingTarget) {
        const { error: nutritionUpdateError } = await supabase
          .from('nutrition_targets')
          .update(targetData)
          .eq('user_id', user.id)
        
        if (nutritionUpdateError) {
          console.error('Nutrition targets update error:', nutritionUpdateError)
          // エラーをログに記録するが、オンボーディング自体は成功とする
        }
      } else {
        const { error: nutritionInsertError } = await supabase
          .from('nutrition_targets')
          .insert(targetData)
        
        if (nutritionInsertError) {
          console.error('Nutrition targets insert error:', nutritionInsertError)
          // エラーをログに記録するが、オンボーディング自体は成功とする
        }
      }
    } catch (nutritionError) {
      console.error('Nutrition targets calculation error:', nutritionError)
      // 栄養目標のエラーは無視して続行（オンボーディング完了は成功）
    }

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    console.error('API Error:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
