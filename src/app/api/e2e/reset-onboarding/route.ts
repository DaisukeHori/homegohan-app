import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * E2E テスト用: オンボーディング状態リセットAPI
 *
 * ログイン済みユーザーの onboarding_completed_at / onboarding_started_at /
 * onboarding_progress をリセットし、次回ログイン時にウェルカム画面を
 * 表示させる。
 *
 * NODE_ENV が production の場合は 403 を返す。
 */
export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available in production' }, { status: 403 })
  }

  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { error } = await supabase
      .from('user_profiles')
      .update({
        onboarding_completed_at: null,
        onboarding_started_at: null,
        onboarding_progress: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Unknown error' }, { status: 500 })
  }
}
