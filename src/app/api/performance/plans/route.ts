import { createClient } from '@/lib/supabase/server'
import { jstToday } from '@/lib/jst-day-ranges'
import { NextRequest, NextResponse } from 'next/server'
import { toPerformancePlan, fromPerformancePlan } from '@/lib/converter'
import { internalError } from '@/lib/api/errors'
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character'
import { API_INVALID_JSON_MESSAGE, API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses'
import { isUuid } from '@/lib/http-params'
import { LIST_ORDERS, orderListBy } from '@/lib/api/list-order'

/** 400: 調整の種類 (adjustmentType) と理由 (rationale) が無い */
const ADJUSTMENT_FIELDS_REQUIRED_MESSAGE = '調整の種類 (adjustmentType) と理由 (rationale) を指定してください'
/** 400: 更新する計画 (planId) が無い */
const PLAN_ID_REQUIRED_MESSAGE = '計画 (planId) を指定してください'

/**
 * GET /api/performance/plans
 *
 * パフォーマンス調整計画を取得
 * Query params:
 *   - status: 'active' | 'superseded' | 'archived' (デフォルト: active)
 *   - all: true の場合、全ステータスを取得
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'active'
    const all = searchParams.get('all') === 'true'

    // 始まる日の新しい順。同じ日に始まる計画は id の順 (#2139 T1)
    let query = orderListBy(supabase.from('performance_plans').select('*').eq('user_id', user.id), LIST_ORDERS.performancePlans)

    if (!all) {
      query = query.eq('status', status)
    }

    const { data, error } = await query.limit(50)

    if (error) {
      return internalError('GET /api/performance/plans', error, { userId: user.id })
    }

    return NextResponse.json({
      plans: data.map(toPerformancePlan),
    })
  } catch (error: any) {
    return internalError('GET /api/performance/plans', error)
  }
}

/**
 * POST /api/performance/plans
 *
 * 新しい調整計画を作成
 * 既存のactive計画はsupersededに更新
 */
export async function POST(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request)
  if (nullCharacterRejection) return nullCharacterRejection
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 })
    }
    const {
      adjustmentType,
      adjustmentValue,
      rationale,
      triggerData,
      evidenceUrls,
      startDate,
      endDate,
    } = body

    if (!adjustmentType || !rationale) {
      return NextResponse.json(
        { error: ADJUSTMENT_FIELDS_REQUIRED_MESSAGE },
        { status: 400 }
      )
    }

    // トランザクション的に処理
    // 1. 既存のactive計画をsupersededに更新
    const { error: updateError } = await supabase
      .from('performance_plans')
      .update({
        status: 'superseded',
        // 開始日の指定が無ければ JST の今日 (#1433)
        end_date: startDate || jstToday(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)
      .eq('status', 'active')

    if (updateError) {
      console.error('Plans update error:', updateError)
      // 続行（既存計画がなくてもOK）
    }

    // 2. 新しい計画を作成
    const dbData = fromPerformancePlan({
      userId: user.id,
      startDate: startDate || jstToday(),
      endDate: endDate || undefined,
      status: 'active',
      adjustmentType,
      adjustmentValue: adjustmentValue || {},
      rationale,
      triggerData: triggerData || undefined,
      evidenceUrls: evidenceUrls || undefined,
    })

    const { data, error } = await supabase
      .from('performance_plans')
      .insert(dbData)
      .select()
      .single()

    if (error) {
      return internalError('POST /api/performance/plans', error, { userId: user.id })
    }

    return NextResponse.json({
      success: true,
      plan: toPerformancePlan(data),
    })
  } catch (error: any) {
    return internalError('POST /api/performance/plans', error)
  }
}

/**
 * PATCH /api/performance/plans
 *
 * 計画を更新（アーカイブなど）
 */
export async function PATCH(request: NextRequest) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request)
  if (nullCharacterRejection) return nullCharacterRejection
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 })
    }
    const { planId, status, endDate } = body

    if (!planId) {
      return NextResponse.json({ error: PLAN_ID_REQUIRED_MESSAGE }, { status: 400 })
    }
    // UUID の形でない planId は DB に渡さず 404 (計画が無い id と同じ。uuid 型の列に渡すと 22P02 で失敗し、下の「DB の失敗は 500」に入る。#1917 の続き)
    if (!isUuid(planId)) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 })
    }

    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    }
    if (status) updates.status = status
    if (endDate) updates.end_date = endDate

    const { data, error } = await supabase
      .from('performance_plans')
      .update(updates)
      .eq('id', planId)
      .eq('user_id', user.id)
      .select()
      .maybeSingle()

    // DB の失敗は 500。更新した行が無い (他人の計画・消えた計画) ときだけ 404 (#1917 の続き。.single() は 0 行を失敗にして 500 にしていた)
    if (error) {
      return internalError('PATCH /api/performance/plans', error, { userId: user.id })
    }
    if (!data) {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      plan: toPerformancePlan(data),
    })
  } catch (error: any) {
    return internalError('PATCH /api/performance/plans', error)
  }
}
