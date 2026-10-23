import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses'

/** 本番では使えない (403)。E2E の道具 (Maestro の reset-onboarding.js) がログに出す文 */
const E2E_NOT_AVAILABLE_IN_PRODUCTION_MESSAGE = '本番環境では使えません'

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
    return NextResponse.json({ error: E2E_NOT_AVAILABLE_IN_PRODUCTION_MESSAGE }, { status: 403 })
  }

  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
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
      return internalError('POST /api/e2e/reset-onboarding', error, { userId: user.id })
    }

    return NextResponse.json({ ok: true })
  } catch (e: unknown) {
    return internalError('POST /api/e2e/reset-onboarding', e)
  }
}
