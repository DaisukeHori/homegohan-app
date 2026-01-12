import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { toPerformancePlan, fromPerformancePlan, toUserProfile, toPerformanceProfile } from '@/lib/converter'
import { analyzeCheckinLoop, applyRecommendations, type CheckinAverages as CoreCheckinAverages } from '@homegohan/core'
import type { NutritionGoal } from '@homegohan/core'

/**
 * GET /api/performance/analyze
 *
 * チェックインデータを分析し、調整提案を返す
 * Query params:
 *   - date: 分析基準日（YYYY-MM-DD、デフォルト: 今日）
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0]

    // 1. ユーザープロフィールを取得（nutrition_goal含む）
    const { data: profileData, error: profileError } = await supabase
      .from('user_profiles')
      .select('weight, nutrition_goal, performance_profile')
      .eq('id', user.id)
      .single()

    if (profileError || !profileData) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    // 2. 現在の栄養目標を取得
    const { data: targetsData, error: targetsError } = await supabase
      .from('nutrition_targets')
      .select('daily_calories, protein_g, fat_g, carbs_g')
      .eq('user_id', user.id)
      .single()

    if (targetsError || !targetsData) {
      return NextResponse.json({ error: 'Nutrition targets not found' }, { status: 404 })
    }

    // 3. 7日移動平均を取得
    const { data: avgData, error: avgError } = await supabase.rpc('get_7d_checkin_averages', {
      p_user_id: user.id,
      p_date: date,
    })

    if (avgError) {
      console.error('Checkin averages error:', avgError)
      return NextResponse.json({ error: avgError.message }, { status: 500 })
    }

    const rawAvg = avgData?.[0] || null
    if (!rawAvg) {
      return NextResponse.json({
        eligible: false,
        eligibilityReason: 'チェックインデータがありません',
        analysis: null,
        date,
      })
    }

    // RPC結果をcore用の型に変換
    const averages: CoreCheckinAverages = {
      sleepHoursAvg: rawAvg.avg_sleep_hours ?? null,
      sleepQualityAvg: rawAvg.avg_sleep_quality ?? null,
      fatigueAvg: rawAvg.avg_fatigue ?? null,
      focusAvg: rawAvg.avg_focus ?? null,
      trainingLoadAvg: rawAvg.avg_training_rpe ?? null,
      hungerAvg: rawAvg.avg_hunger ?? null,
      weightStart: rawAvg.weight_start ?? null,
      weightEnd: rawAvg.weight_end ?? null,
      checkinCount: rawAvg.checkin_count ?? 0,
    }

    // 4. 分析を実行
    const performanceProfile = toPerformanceProfile(profileData.performance_profile)
    const analysis = analyzeCheckinLoop(
      averages,
      {
        calories: targetsData.daily_calories,
        protein: targetsData.protein_g,
        fat: targetsData.fat_g,
        carbs: targetsData.carbs_g,
      },
      {
        nutritionGoal: (profileData.nutrition_goal as NutritionGoal) || 'maintain',
        weight: profileData.weight || 60,
        performanceProfile,
      }
    )

    return NextResponse.json({
      eligible: analysis.eligible,
      eligibilityReason: analysis.eligibilityReason,
      analysis: {
        trends: analysis.trends,
        recommendations: analysis.recommendations,
        nextAction: analysis.nextAction,
      },
      currentTargets: {
        calories: targetsData.daily_calories,
        protein: targetsData.protein_g,
        fat: targetsData.fat_g,
        carbs: targetsData.carbs_g,
      },
      date,
    })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * POST /api/performance/analyze
 *
 * 分析結果に基づいて調整を適用し、performance_planを作成
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { recommendations, applyTop = 1 } = body

    if (!recommendations || !Array.isArray(recommendations) || recommendations.length === 0) {
      return NextResponse.json({ error: 'recommendations are required' }, { status: 400 })
    }

    // 1. 現在の栄養目標を取得
    const { data: targetsData, error: targetsError } = await supabase
      .from('nutrition_targets')
      .select('daily_calories, protein_g, fat_g, carbs_g')
      .eq('user_id', user.id)
      .single()

    if (targetsError || !targetsData) {
      return NextResponse.json({ error: 'Nutrition targets not found' }, { status: 404 })
    }

    // 2. 調整を適用
    const adjusted = applyRecommendations(
      {
        calories: targetsData.daily_calories,
        protein: targetsData.protein_g,
        fat: targetsData.fat_g,
        carbs: targetsData.carbs_g,
      },
      recommendations,
      { applyTop }
    )

    // 3. 調整があれば栄養目標を更新
    if (adjusted.appliedRecommendations.length > 0) {
      const { error: updateError } = await supabase
        .from('nutrition_targets')
        .update({
          daily_calories: adjusted.calories,
          protein_g: adjusted.protein,
          fat_g: adjusted.fat,
          carbs_g: adjusted.carbs,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', user.id)

      if (updateError) {
        console.error('Nutrition targets update error:', updateError)
        return NextResponse.json({ error: updateError.message }, { status: 500 })
      }
    }

    // 4. 既存のactive planをsupersededに
    const today = new Date().toISOString().split('T')[0]
    await supabase
      .from('performance_plans')
      .update({
        status: 'superseded',
        end_date: today,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)
      .eq('status', 'active')

    // 5. 新しいperformance_planを作成
    const adjustmentValue: Record<string, number> = {}
    for (const rec of adjusted.appliedRecommendations) {
      adjustmentValue[rec.type] = rec.delta
    }

    const rationale = adjusted.appliedRecommendations
      .map(r => r.reason)
      .join('\n')

    const planData = fromPerformancePlan({
      userId: user.id,
      startDate: today,
      status: 'active',
      adjustmentType: 'adaptive_loop',
      adjustmentValue,
      rationale,
      triggerData: {
        source: '7d_checkin_analysis',
        appliedRecommendations: adjusted.appliedRecommendations,
      },
    })

    const { data: planResult, error: planError } = await supabase
      .from('performance_plans')
      .insert(planData)
      .select()
      .single()

    if (planError) {
      console.error('Plan create error:', planError)
      return NextResponse.json({ error: planError.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      adjustedTargets: {
        calories: adjusted.calories,
        protein: adjusted.protein,
        fat: adjusted.fat,
        carbs: adjusted.carbs,
      },
      appliedRecommendations: adjusted.appliedRecommendations,
      plan: toPerformancePlan(planResult),
    })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
