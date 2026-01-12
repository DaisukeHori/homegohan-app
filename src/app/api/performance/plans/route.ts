import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { toPerformancePlan, fromPerformancePlan } from '@/lib/converter'

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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'active'
    const all = searchParams.get('all') === 'true'

    let query = supabase
      .from('performance_plans')
      .select('*')
      .eq('user_id', user.id)
      .order('start_date', { ascending: false })

    if (!all) {
      query = query.eq('status', status)
    }

    const { data, error } = await query.limit(50)

    if (error) {
      console.error('Plans fetch error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      plans: data.map(toPerformancePlan),
    })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * POST /api/performance/plans
 *
 * 新しい調整計画を作成
 * 既存のactive計画はsupersededに更新
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
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
        { error: 'adjustmentType and rationale are required' },
        { status: 400 }
      )
    }

    // トランザクション的に処理
    // 1. 既存のactive計画をsupersededに更新
    const { error: updateError } = await supabase
      .from('performance_plans')
      .update({
        status: 'superseded',
        end_date: startDate || new Date().toISOString().split('T')[0],
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
      startDate: startDate || new Date().toISOString().split('T')[0],
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
      console.error('Plan create error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      plan: toPerformancePlan(data),
    })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * PATCH /api/performance/plans
 *
 * 計画を更新（アーカイブなど）
 */
export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { planId, status, endDate } = body

    if (!planId) {
      return NextResponse.json({ error: 'planId is required' }, { status: 400 })
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
      .single()

    if (error) {
      console.error('Plan update error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      plan: toPerformancePlan(data),
    })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
