import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// オンボーディング完了API (OB-API-02)
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

    // 栄養目標を計算・保存
    try {
      const targetData = calculateNutritionTargets(profile)
      
      const { data: existingTarget } = await supabase
        .from('nutrition_targets')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle()

      if (existingTarget) {
        await supabase
          .from('nutrition_targets')
          .update(targetData)
          .eq('user_id', user.id)
      } else {
        await supabase
          .from('nutrition_targets')
          .insert({ ...targetData, user_id: user.id })
      }
    } catch (nutritionError) {
      console.error('Nutrition targets calculation error:', nutritionError)
      // 栄養目標のエラーは無視して続行
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// 栄養目標を計算する関数
function calculateNutritionTargets(profile: any) {
  const age = profile.age || 30
  const gender = profile.gender || 'unspecified'
  const height = profile.height || 170
  const weight = profile.weight || 60
  const goal = profile.nutrition_goal || 'maintain'
  const activityLevel = getActivityLevel(profile)

  // 基礎代謝（Mifflin-St Jeor式）
  let bmr: number
  if (gender === 'male') {
    bmr = 10 * weight + 6.25 * height - 5 * age + 5
  } else if (gender === 'female') {
    bmr = 10 * weight + 6.25 * height - 5 * age - 161
  } else {
    bmr = 10 * weight + 6.25 * height - 5 * age - 78
  }

  // 活動係数
  const activityMultipliers: Record<string, number> = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    very_active: 1.9,
  }
  const multiplier = activityMultipliers[activityLevel] || 1.55

  // TDEE（総消費カロリー）
  let tdee = Math.round(bmr * multiplier)

  // 目標に応じた調整
  if (goal === 'lose_weight') {
    const rate = profile.weight_change_rate || 'moderate'
    const deficit = rate === 'slow' ? 250 : rate === 'aggressive' ? 750 : 500
    tdee -= deficit
  } else if (goal === 'gain_muscle') {
    const rate = profile.weight_change_rate || 'moderate'
    const surplus = rate === 'slow' ? 250 : rate === 'aggressive' ? 500 : 350
    tdee += surplus
  }

  // マクロ栄養素
  const protein = Math.round(weight * (goal === 'gain_muscle' ? 2.0 : goal === 'lose_weight' ? 1.8 : 1.5))
  const fat = Math.round((tdee * 0.25) / 9)
  const carbs = Math.round((tdee - protein * 4 - fat * 9) / 4)

  return {
    calories: tdee,
    protein,
    fat,
    carbs,
    fiber: gender === 'female' ? 18 : 21,
    sodium: 2000,
    sugar: Math.round(tdee * 0.05 / 4),
    updated_at: new Date().toISOString(),
  }
}

function getActivityLevel(profile: any): string {
  const workStyle = profile.work_style
  const exerciseFreq = profile.exercise_frequency || 0
  const exerciseIntensity = profile.exercise_intensity

  // 仕事スタイルベースの基準
  let base = 'moderate'
  if (workStyle === 'sedentary') base = 'sedentary'
  else if (workStyle === 'light_active') base = 'light'
  else if (workStyle === 'moderately_active') base = 'moderate'
  else if (workStyle === 'very_active') base = 'active'

  // 運動による補正
  if (exerciseFreq >= 5 && exerciseIntensity === 'athlete') {
    return 'very_active'
  } else if (exerciseFreq >= 4 && (exerciseIntensity === 'intense' || exerciseIntensity === 'athlete')) {
    return 'active'
  } else if (exerciseFreq >= 3) {
    return base === 'sedentary' ? 'light' : base
  }

  return base
}
