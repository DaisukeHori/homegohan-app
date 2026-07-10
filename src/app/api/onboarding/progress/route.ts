import { createClient } from '@/lib/supabase/server'
import { createLogger, generateRequestId } from '@/lib/db-logger'
import { NextResponse } from 'next/server'
import { OnboardingAnswersSchema } from '@/schemas/onboarding'

// #1045 (F6-12): ニックネームは HTML エスケープせず raw のまま保存する。
// 画面表示は必ず React の JSX テキストノード経由 (dangerouslySetInnerHTML は不使用) のため
// React の自動エスケープで XSS は防げる。ここで &lt;script&gt; のようにエスケープして保存すると
// 表示時に二重エスケープされてユーザーには文字化けした文字列として見えてしまっていた。
function normalizeNickname(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 100) // ニックネームの最大長を制限
}

// オンボーディング進捗保存API (OB-API-01)
export async function POST(request: Request) {
  const requestId = generateRequestId()
  const logger = createLogger('POST /api/onboarding/progress', requestId)
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: any
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const { currentStep, answers, totalQuestions } = body

    if (typeof currentStep !== 'number' || !answers || typeof totalQuestions !== 'number') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    // #1045 (F6-12): age="abc" のような型崩れ・許可されていない enum 値を保存前に弾く。
    // 未知フィールドはエラーにしない (z.object のデフォルト strip 挙動)。
    const answersValidation = OnboardingAnswersSchema.safeParse(answers)
    if (!answersValidation.success) {
      return NextResponse.json(
        { error: 'Invalid answers', details: answersValidation.error.flatten() },
        { status: 400 },
      )
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
      .select('onboarding_started_at, onboarding_completed_at')
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

    // #276: upsert で completed_at を上書きしないよう既存値を保持
    if (existingProfile?.onboarding_completed_at) {
      updates.onboarding_completed_at = existingProfile.onboarding_completed_at
    }

    // 回答内容を対応カラムにも反映（リアルタイム同期）
    // #1045 (F6-12): nickname は raw 保存 (表示側の React エスケープに任せる)
    if (answers.nickname) updates.nickname = normalizeNickname(answers.nickname)
    if (answers.gender) updates.gender = answers.gender
    if (answers.age) {
      // #1045 (F6-12): 上の Zod バリデーションで非数値は既に 400 で弾かれるが、
      // 念のため NaN が age_group ("NaNs" 等) に混入しないよう二重に防御する
      const parsedAge = parseInt(answers.age)
      if (Number.isFinite(parsedAge)) {
        updates.age = parsedAge
        updates.age_group = `${Math.floor(parsedAge / 10) * 10}s`
      }
    }
    if (answers.occupation) updates.occupation = answers.occupation
    if (answers.height) updates.height = parseFloat(answers.height)
    if (answers.weight) updates.weight = parseFloat(answers.weight)
    if (answers.nutrition_goal) updates.nutrition_goal = answers.nutrition_goal
    if (answers.target_weight) updates.target_weight = parseFloat(answers.target_weight)
    if (answers.target_date) updates.target_date = answers.target_date
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
    // 体の悩み（個別フラグに展開）
    if (answers.body_concerns?.length) {
      updates.cold_sensitivity = answers.body_concerns.includes('cold_sensitivity')
      updates.swelling_prone = answers.body_concerns.includes('swelling_prone')
      // 将来的に他のフラグも追加可能
    }
    if (answers.sleep_quality) updates.sleep_quality = answers.sleep_quality
    if (answers.stress_level) updates.stress_level = answers.stress_level
    if (answers.pregnancy_status) updates.pregnancy_status = answers.pregnancy_status
    if (answers.medications && !answers.medications.includes('none')) {
      updates.medications = answers.medications
    }
    // diet_flags（アレルギーと苦手な食材）
    if (answers.allergies?.length || answers.dislikes?.length) {
      updates.diet_flags = {
        allergies: answers.allergies || [],
        dislikes: answers.dislikes || [],
      }
    }
    // 好きな食材
    if (answers.favorite_ingredients?.length) {
      updates.favorite_ingredients = answers.favorite_ingredients
    }
    if (answers.diet_style) updates.diet_style = answers.diet_style
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
    if (answers.servings_config) updates.servings_config = answers.servings_config
    if (answers.shopping_frequency) updates.shopping_frequency = answers.shopping_frequency
    if (answers.weekly_food_budget && answers.weekly_food_budget !== 'none') {
      updates.weekly_food_budget = parseInt(answers.weekly_food_budget)
    }
    // 調理器具
    const appliances: string[] = []
    if (answers.kitchen_appliances?.length) appliances.push(...answers.kitchen_appliances)
    if (answers.stove_type) appliances.push(answers.stove_type)
    if (appliances.length > 0) updates.kitchen_appliances = appliances
    // 趣味
    if (answers.hobbies?.length) {
      updates.hobbies = answers.hobbies
    }

    // Performance OS v3: performance_profile 構築
    if (answers.nutrition_goal === 'athlete_performance') {
      const sportId = answers.sport_type === 'custom' ? 'custom' : answers.sport_type
      const sportName = answers.sport_type === 'custom' ? answers.sport_custom_name : null

      // 基本的なperformance_profileを構築
      const performanceProfile: Record<string, any> = {
        sport: {
          id: sportId || null,
          name: sportName || null,
          role: null, // ロールはプロフィール画面で設定可能
          experience: answers.sport_experience || 'intermediate',
          phase: answers.training_phase || 'training',
          demandVector: null, // complete時にプリセットから取得
        },
        growth: {
          isUnder18: answers.age ? parseInt(answers.age) < 18 : false,
          heightChangeRecent: null,
          growthProtectionEnabled: answers.age ? parseInt(answers.age) < 18 : false,
        },
        cut: {
          enabled: answers.training_phase === 'cut',
          targetWeight: answers.target_weight ? parseFloat(answers.target_weight) : null,
          targetDate: answers.competition_date || answers.target_date || null,
          strategy: 'gradual',
        },
        priorities: {
          protein: 'high',
          carbs: answers.training_phase === 'competition' ? 'high' : 'moderate',
          fat: 'moderate',
          hydration: 'high',
        },
      }

      updates.performance_profile = performanceProfile
    } else if (answers.nutrition_goal) {
      // #1045 (F6-13): 「戻る」で nutrition_goal を athlete_performance から
      // 別の目標に変更した場合、前回保存された performance_profile が upsert で
      // 上書きされず残留し、矛盾したプロフィールが確定してしまうのを防ぐ
      updates.performance_profile = null
    }

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
      logger.error('Onboarding progress save error', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      progress: data.onboarding_progress,
    })
  } catch (error: any) {
    logger.error('API Error', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
