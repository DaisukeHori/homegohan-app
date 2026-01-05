import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// オンボーディング進捗保存API (OB-API-01)
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { currentStep, answers, totalQuestions } = body

    if (typeof currentStep !== 'number' || !answers || typeof totalQuestions !== 'number') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const now = new Date().toISOString()

    const progress = {
      currentStep,
      answers,
      totalQuestions,
      lastUpdatedAt: now,
    }

    // 現在のプロファイルを取得
    const { data: existingProfile } = await supabase
      .from('user_profiles')
      .select('onboarding_started_at')
      .eq('id', user.id)
      .single()

    // 更新データを構築
    const updates: Record<string, any> = {
      id: user.id,
      onboarding_progress: progress,
      updated_at: now,
    }

    // 初回の場合は onboarding_started_at を設定
    if (!existingProfile?.onboarding_started_at) {
      updates.onboarding_started_at = now
    }

    // 回答内容を対応カラムにも反映（リアルタイム同期）
    if (answers.nickname) updates.nickname = answers.nickname
    if (answers.gender) updates.gender = answers.gender
    if (answers.age) {
      updates.age = parseInt(answers.age)
      updates.age_group = `${Math.floor(parseInt(answers.age) / 10) * 10}s`
    }
    if (answers.occupation) updates.occupation = answers.occupation
    if (answers.height) updates.height = parseFloat(answers.height)
    if (answers.weight) updates.weight = parseFloat(answers.weight)
    if (answers.nutrition_goal) updates.nutrition_goal = answers.nutrition_goal
    if (answers.weight_change_rate) updates.weight_change_rate = answers.weight_change_rate
    if (answers.exercise_types && !answers.exercise_types.includes('none')) {
      updates.exercise_types = answers.exercise_types
    }
    if (answers.exercise_frequency) updates.exercise_frequency = parseInt(answers.exercise_frequency)
    if (answers.exercise_intensity) updates.exercise_intensity = answers.exercise_intensity
    if (answers.exercise_duration) updates.exercise_duration_per_session = parseInt(answers.exercise_duration)
    if (answers.work_style) updates.work_style = answers.work_style
    if (answers.health_conditions && !answers.health_conditions.includes('none')) {
      updates.health_conditions = answers.health_conditions
    }
    if (answers.medications && !answers.medications.includes('none')) {
      updates.medications = answers.medications
    }
    if (answers.allergies?.length) {
      updates.diet_flags = {
        allergies: answers.allergies,
        dislikes: [],
      }
    }
    if (answers.cooking_experience) updates.cooking_experience = answers.cooking_experience
    if (answers.cooking_time) updates.weekday_cooking_minutes = parseInt(answers.cooking_time)
    if (answers.cuisine_preference?.length) {
      const prefs: Record<string, number> = {}
      answers.cuisine_preference.forEach((c: string) => {
        prefs[c] = 5
      })
      updates.cuisine_preferences = prefs
    }
    if (answers.family_size) updates.family_size = parseInt(answers.family_size)
    if (answers.shopping_frequency) updates.shopping_frequency = answers.shopping_frequency
    if (answers.weekly_food_budget && answers.weekly_food_budget !== 'none') {
      updates.weekly_food_budget = parseInt(answers.weekly_food_budget)
    }
    // 調理器具
    const appliances: string[] = []
    if (answers.kitchen_appliances?.length) appliances.push(...answers.kitchen_appliances)
    if (answers.stove_type) appliances.push(answers.stove_type)
    if (appliances.length > 0) updates.kitchen_appliances = appliances

    // デフォルト値の補完
    if (!updates.nickname) updates.nickname = 'Guest'
    if (!updates.age_group && !updates.age) updates.age_group = 'unspecified'
    if (!updates.gender) updates.gender = 'unspecified'

    const { data, error } = await supabase
      .from('user_profiles')
      .upsert(updates)
      .select('onboarding_progress')
      .single()

    if (error) {
      console.error('Onboarding progress save error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      progress: data.onboarding_progress,
    })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
