import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { toPerformancePlan, fromPerformancePlan, toUserProfile, toPerformanceProfile } from '@/lib/converter'
import {
  analyzeCheckinLoop,
  applyRecommendations,
  type AdjustmentRecommendation,
  type CheckinAverages as CoreCheckinAverages,
} from '@homegohan/core'
import type { NutritionGoal } from '@homegohan/core'
import { RECORD_DATE_PATTERN } from '@/lib/health-payloads'

type SupabaseLike = Awaited<ReturnType<typeof createClient>>

type AnalysisRunResult =
  | {
      ok: true
      eligible: boolean
      eligibilityReason?: string
      recommendations: AdjustmentRecommendation[]
      trends: ReturnType<typeof analyzeCheckinLoop>['trends'] | null
      nextAction: ReturnType<typeof analyzeCheckinLoop>['nextAction']
      currentTargets: { calories: number; protein: number; fat: number; carbs: number }
    }
  | { ok: false; status: number; error: string }

/**
 * #1048 F2-18: GET/POST 双方で同じ「プロフィール→栄養目標→7日平均→分析」の
 * 手順を共有する。POST はこの結果のみを信頼し、クライアントが送った
 * recommendations は使用しない（サーバー側で再計算した提案だけを適用する）。
 */
async function runAnalysis(supabase: SupabaseLike, userId: string, date: string): Promise<AnalysisRunResult> {
  // 1. ユーザープロフィールを取得（nutrition_goal含む）
  const { data: profileData, error: profileError } = await supabase
    .from('user_profiles')
    .select('weight, nutrition_goal, performance_profile')
    .eq('id', userId)
    .single()

  if (profileError || !profileData) {
    return { ok: false, status: 404, error: 'Profile not found' }
  }

  // 2. 現在の栄養目標を取得
  const { data: targetsData, error: targetsError } = await supabase
    .from('nutrition_targets')
    .select('daily_calories, protein_g, fat_g, carbs_g')
    .eq('user_id', userId)
    .single()

  if (targetsError || !targetsData) {
    return { ok: false, status: 404, error: 'Nutrition targets not found' }
  }

  const currentTargets = {
    calories: targetsData.daily_calories,
    protein: targetsData.protein_g,
    fat: targetsData.fat_g,
    carbs: targetsData.carbs_g,
  }

  // 3. 7日移動平均を取得
  const { data: avgData, error: avgError } = await supabase.rpc('get_7d_checkin_averages', {
    p_user_id: userId,
    p_date: date,
  })

  if (avgError) {
    console.error('Checkin averages error:', avgError)
    return { ok: false, status: 500, error: avgError.message }
  }

  const rawAvg = avgData?.[0] || null
  if (!rawAvg) {
    return {
      ok: true,
      eligible: false,
      eligibilityReason: 'チェックインデータがありません',
      recommendations: [],
      trends: null,
      nextAction: null,
      currentTargets,
    }
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
  const analysis = analyzeCheckinLoop(averages, currentTargets, {
    nutritionGoal: (profileData.nutrition_goal as NutritionGoal) || 'maintain',
    weight: profileData.weight || 60,
    performanceProfile,
  })

  return {
    ok: true,
    eligible: analysis.eligible,
    eligibilityReason: analysis.eligibilityReason,
    recommendations: analysis.recommendations,
    trends: analysis.trends,
    nextAction: analysis.nextAction,
    currentTargets,
  }
}

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
    const rawDate = searchParams.get('date')
    const date = rawDate && RECORD_DATE_PATTERN.test(rawDate) ? rawDate : new Date().toISOString().split('T')[0]

    const run = await runAnalysis(supabase, user.id, date)
    if (!run.ok) {
      return NextResponse.json({ error: run.error }, { status: run.status })
    }

    if (!run.eligible) {
      return NextResponse.json({
        eligible: false,
        eligibilityReason: run.eligibilityReason,
        analysis: null,
        date,
      })
    }

    return NextResponse.json({
      eligible: true,
      analysis: {
        trends: run.trends,
        recommendations: run.recommendations,
        nextAction: run.nextAction,
      },
      currentTargets: run.currentTargets,
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
 *
 * #1048 F2-18: 従来はクライアントが送った `recommendations`（delta を含む）を
 * そのまま `applyRecommendations` に渡しており、クライアントが任意の delta を
 * 捏造すれば nutrition_targets を無制限に書き換えられた。
 * date のみを受け取り、GET と同じロジックでサーバー側が recommendations を
 * 再計算し、その結果だけを適用する。
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const rawDate = typeof body?.date === 'string' ? body.date : null
    const date = rawDate && RECORD_DATE_PATTERN.test(rawDate) ? rawDate : new Date().toISOString().split('T')[0]

    const rawApplyTop = body?.applyTop
    const applyTop =
      typeof rawApplyTop === 'number' && Number.isInteger(rawApplyTop)
        ? Math.min(Math.max(rawApplyTop, 1), 5)
        : 1

    // 1. サーバー側で分析を再計算する（クライアント入力の recommendations は使用しない）
    const run = await runAnalysis(supabase, user.id, date)
    if (!run.ok) {
      return NextResponse.json({ error: run.error }, { status: run.status })
    }
    if (!run.eligible || run.recommendations.length === 0) {
      return NextResponse.json(
        { error: run.eligibilityReason || '調整可能な提案がありません' },
        { status: 400 },
      )
    }

    // 2. 調整を適用
    const adjusted = applyRecommendations(run.currentTargets, run.recommendations, { applyTop })

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
