import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { internalError } from '@/lib/api/errors'
import { API_NOT_FOUND_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses'
import { refreshProfileCompleteness } from '@/lib/profile-completeness'

/**
 * プロフィールの完成度 (user_profiles.profile_completeness) を、今の行から計算し直す (#2206 G4)。
 *
 * モバイルのオンボーディングの途中保存は、答えを画面から直接 user_profiles に upsert する (apps/mobile/app/onboarding/questions.tsx の
 * saveProgress)。Web の途中保存 (POST /api/onboarding/progress) は書いた後に計算し直すが、モバイルは計算し直さず、途中でやめた
 * 利用者の完成度が古いまま (0 のまま) 残り、Web と食い違っていた。モバイルは保存のあとにこれを呼ぶ。
 * 計算と書き方は refreshProfileCompleteness (読んだときの完成度のままの行にだけ書く) と同じ。本文は読まない。
 *
 * 応答: 200 { profileCompleteness } / 401 ログインしていない / 404 プロフィールの行が無い / 500 読み書きの失敗
 */
export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    const outcome = await refreshProfileCompleteness(supabase, user.id)
    if (outcome.status === 'not_found') {
      return NextResponse.json({ error: API_NOT_FOUND_MESSAGE }, { status: 404 })
    }
    if (outcome.status === 'error') {
      return internalError('POST /api/profile/completeness', outcome.error, { userId: user.id })
    }
    return NextResponse.json({ profileCompleteness: outcome.completeness })
  } catch (error: unknown) {
    return internalError('POST /api/profile/completeness', error)
  }
}
