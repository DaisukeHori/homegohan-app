import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'

// オンボーディング状態取得API (OB-API-03)
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile, error: fetchError } = await supabase
      .from('user_profiles')
      .select('nickname, onboarding_started_at, onboarding_completed_at, onboarding_progress')
      .eq('id', user.id)
      .maybeSingle()

    if (fetchError) {
      return internalError('GET /api/onboarding/status', fetchError, { userId: user.id })
    }

    // 状態判定
    let status: 'not_started' | 'in_progress' | 'completed'

    if (profile?.onboarding_completed_at) {
      status = 'completed'
    } else if (profile?.onboarding_started_at) {
      status = 'in_progress'
    } else {
      status = 'not_started'
    }

    const response: {
      status: 'not_started' | 'in_progress' | 'completed'
      progress?: any
      nickname?: string
    } = { status }

    if (status === 'in_progress' && profile?.onboarding_progress) {
      response.progress = profile.onboarding_progress
    }

    if (profile?.nickname && profile.nickname !== 'Guest') {
      response.nickname = profile.nickname
    }

    return NextResponse.json(response)
  } catch (error: any) {
    return internalError('GET /api/onboarding/status', error)
  }
}

// 進捗リセットAPI（最初からやり直す場合）
export async function DELETE() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { error: updateError } = await supabase
      .from('user_profiles')
      .update({
        onboarding_started_at: null,
        onboarding_completed_at: null,
        onboarding_progress: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)

    if (updateError) {
      return internalError('DELETE /api/onboarding/status', updateError, { userId: user.id })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    return internalError('DELETE /api/onboarding/status', error)
  }
}
