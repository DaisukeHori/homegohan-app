import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

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
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
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
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
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
        onboarding_progress: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
