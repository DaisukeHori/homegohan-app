import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { toPerformanceCheckin, fromPerformanceCheckin, toCheckinAverages } from '@/lib/converter'

/**
 * GET /api/performance/checkins
 *
 * パフォーマンスチェックインを取得
 * Query params:
 *   - date: 特定日付のチェックインを取得（YYYY-MM-DD）
 *   - startDate / endDate: 期間指定
 *   - averages: true の場合、7日移動平均を返す
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const averages = searchParams.get('averages') === 'true'

    // 7日移動平均を取得
    if (averages) {
      const targetDate = date || new Date().toISOString().split('T')[0]
      const { data, error } = await supabase.rpc('get_7d_checkin_averages', {
        p_user_id: user.id,
        p_date: targetDate,
      })

      if (error) {
        console.error('Checkin averages error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      // RPC returns a single row
      const avgData = data?.[0] || null
      return NextResponse.json({
        averages: avgData ? toCheckinAverages(avgData) : null,
        date: targetDate,
      })
    }

    // 特定日付のチェックインを取得
    if (date) {
      const { data, error } = await supabase
        .from('user_performance_checkins')
        .select('*')
        .eq('user_id', user.id)
        .eq('checkin_date', date)
        .maybeSingle()

      if (error) {
        console.error('Checkin fetch error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({
        checkin: data ? toPerformanceCheckin(data) : null,
      })
    }

    // 期間指定
    let query = supabase
      .from('user_performance_checkins')
      .select('*')
      .eq('user_id', user.id)
      .order('checkin_date', { ascending: false })

    if (startDate) {
      query = query.gte('checkin_date', startDate)
    }
    if (endDate) {
      query = query.lte('checkin_date', endDate)
    }

    // デフォルトは直近30日
    if (!startDate && !endDate) {
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
      query = query.gte('checkin_date', thirtyDaysAgo.toISOString().split('T')[0])
    }

    const { data, error } = await query.limit(100)

    if (error) {
      console.error('Checkins fetch error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      checkins: data.map(toPerformanceCheckin),
    })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

/**
 * POST /api/performance/checkins
 *
 * 日次チェックインを作成/更新（upsert）
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { checkinDate, ...checkinData } = body

    if (!checkinDate) {
      return NextResponse.json({ error: 'checkinDate is required' }, { status: 400 })
    }

    // DBフォーマットに変換
    const dbData = fromPerformanceCheckin({
      userId: user.id,
      checkinDate,
      ...checkinData,
    })

    // Upsert（日付でユニーク制約あり）
    const { data, error } = await supabase
      .from('user_performance_checkins')
      .upsert(dbData, {
        onConflict: 'user_id,checkin_date',
      })
      .select()
      .single()

    if (error) {
      console.error('Checkin upsert error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // 体重が更新された場合、user_profiles.weightも更新
    if (checkinData.weight !== undefined) {
      await supabase
        .from('user_profiles')
        .update({
          weight: checkinData.weight,
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.id)
    }

    return NextResponse.json({
      success: true,
      checkin: toPerformanceCheckin(data),
    })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
