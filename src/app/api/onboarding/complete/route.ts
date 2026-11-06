import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { calculateNutritionTargets } from '@homegohan/core'
import { PROFILE_NAME_PLACEHOLDER } from '@homegohan/shared'
import { buildNutritionCalculatorInput } from '@/lib/build-nutrition-input'
import { getHandsonTourStatusInternal } from '@/lib/handson-tour/getStatus'
import { internalError } from '@/lib/api/errors'
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses'
import { refreshProfileCompleteness } from '@/lib/profile-completeness'
import { answeredOnboardingNutritionGoal, onboardingWeeklyExerciseDecision } from '@/lib/onboarding-derived-columns'

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
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    const now = new Date().toISOString()

    // 現在のプロファイルを取得
    // #1045 (F6-11): welcome 画面の「あとで設定する」は質問に一つも答えないまま
    // このAPIを呼ぶため、user_profiles 行がまだ存在しないことがある。
    // .single() は 0 行のとき error を返してしまうため .maybeSingle() に変更する。
    const { data: fetchedProfile, error: fetchError } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle()

    if (fetchError) {
      return internalError('POST /api/onboarding/complete', fetchError, { userId: user.id })
    }

    let profile = fetchedProfile

    if (!profile) {
      // #1045 (F6-11): プロファイル行が存在しない場合は最低限のデフォルト値で作成してから
      // 完了処理を続行する (行が無いまま update すると 0 行更新で完了扱いになれない)
      const { data: upsertedProfile, error: upsertError } = await supabase
        .from('user_profiles')
        .upsert({
          id: user.id,
          nickname: PROFILE_NAME_PLACEHOLDER,
          gender: 'unspecified',
          age_group: 'unspecified',
          onboarding_started_at: now,
        })
        .select('*')
        .single()

      if (upsertError || !upsertedProfile) {
        return internalError('POST /api/onboarding/complete', upsertError, { userId: user.id })
      }

      profile = upsertedProfile
    }

    // ===== 自動変換処理 =====
    // 答えから作る 3 つの欄 (体づくりの目標・目標の文・週の運動の分) は、元の質問に答えたときだけ書く。答えずに完了した
    // (あとで設定する・途中のスキップ) ときは列に触れない。元の列 (栄養の目標・運動の日数・1 回の時間) には DB の既定値
    // ('maintain'・3・60) があり、答えなくても欄が埋まって完成度に数えていた (#2283 判断待ち 7 の選択 B。判定は src/lib/onboarding-derived-columns.ts)
    const nutritionGoalAnswered = answeredOnboardingNutritionGoal(profile)
    // nutrition_goal → fitness_goals への変換
    const goalToFitnessMapping: Record<string, string[]> = {
      'lose_weight': ['lose_weight'],
      'gain_muscle': ['build_muscle'],
      'maintain': ['improve_energy'],
      'athlete_performance': ['build_muscle', 'improve_energy'],
    }
    const fitnessGoals = profile.nutrition_goal
      ? goalToFitnessMapping[profile.nutrition_goal] || []
      : []

    // nutrition_goal → goal_text への変換
    const goalToTextMapping: Record<string, string> = {
      'lose_weight': '健康的に減量する',
      'gain_muscle': '筋肉をつける',
      'maintain': '現在の体型を維持する',
      'athlete_performance': 'アスリートとしてパフォーマンスを向上させる',
    }
    const goalText = profile.nutrition_goal
      ? goalToTextMapping[profile.nutrition_goal] || ''
      : ''

    // exercise_frequency × exercise_duration_per_session → weekly_exercise_minutes (運動していないと答えたら 0)
    const weeklyExercise = onboardingWeeklyExerciseDecision(profile)

    // Performance OS v3: performance_profile を完成させる
    let finalPerformanceProfile = profile.performance_profile || {}

    if (profile.nutrition_goal === 'athlete_performance' && finalPerformanceProfile?.sport?.id) {
      const sportId = finalPerformanceProfile.sport.id

      // プリセットスポーツの場合、demand_vectorを取得
      if (sportId !== 'custom') {
        const { data: sportPreset } = await supabase
          .from('sport_presets')
          .select('demand_vector, roles, name_ja')
          .eq('id', sportId)
          .single()

        if (sportPreset) {
          finalPerformanceProfile = {
            ...finalPerformanceProfile,
            sport: {
              ...finalPerformanceProfile.sport,
              name: sportPreset.name_ja,
              demandVector: sportPreset.demand_vector,
              availableRoles: sportPreset.roles, // 選択可能なロール一覧を保存
            },
          }
        }
      }
    }

    // 完了フラグを設定（自動変換データも同時に保存）
    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({
        onboarding_completed_at: now,
        updated_at: now,
        // 自動変換データ (答えた質問の分だけ)
        ...(nutritionGoalAnswered ? { fitness_goals: fitnessGoals, goal_text: goalText } : {}),
        ...(weeklyExercise.write ? { weekly_exercise_minutes: weeklyExercise.minutes } : {}),
        // Performance OS v3
        performance_profile: finalPerformanceProfile,
      })
      .eq('id', user.id)

    if (updateError) {
      return internalError('POST /api/onboarding/complete', updateError, { userId: user.id })
    }

    // オンボーディングの答え (web は /api/onboarding/progress、モバイルは画面から直接 user_profiles に書く) と上の自動変換の欄
    // (体づくりの目標・目標の文・週の運動の分。元の質問に答えたときだけ書く) はプロフィールの完成度に数える欄なので、書いた後の行から計算し直す
    // (失敗してもオンボーディングの完了は成功のまま。完成度は次の書き込みで直る。#2201 U4)
    const completenessRefresh = await refreshProfileCompleteness(supabase, user.id)
    if (completenessRefresh.status === 'error') {
      console.error('Profile completeness refresh error:', completenessRefresh.error)
    }

    // 栄養目標を計算・保存（共通モジュール使用）
    try {
      // 共通ヘルパーで入力を組み立て（4ルート一致保証）
      // Performance OS v3: finalPerformanceProfile を extra として渡す
      const calculatorInput = buildNutritionCalculatorInput(profile, user.id, {
        performance_profile: finalPerformanceProfile,
      })
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

    let nextRoute: '/handson-tour' | '/home' = '/home';
    try {
      const tourStatus = await getHandsonTourStatusInternal(user.id);
      nextRoute = tourStatus.should_show ? '/handson-tour' : '/home';
    } catch {
      nextRoute = '/home';
    }

    return NextResponse.json({ success: true, next_route: nextRoute })
  } catch (error: unknown) {
    return internalError('POST /api/onboarding/complete', error)
  }
}
