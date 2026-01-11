import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)

  // 全パラメータをログ出力（デバッグ用）
  console.log('[auth/callback] Full URL:', requestUrl.toString())
  console.log('[auth/callback] All params:', Object.fromEntries(requestUrl.searchParams.entries()))

  const code = requestUrl.searchParams.get('code')
  const token_hash = requestUrl.searchParams.get('token_hash')
  const type = requestUrl.searchParams.get('type')
  let next = requestUrl.searchParams.get('next') ?? '/home'

  const supabase = createClient()
  let authSuccess = false

  // OAuth コールバック（code パラメータ）
  if (code) {
    console.log('[auth/callback] Processing OAuth code')
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    authSuccess = !error
    if (error) {
      console.error('[auth/callback] OAuth code exchange error:', error)
    } else {
      console.log('[auth/callback] OAuth code exchange successful')
    }
  }
  // メール確認コールバック（token_hash パラメータ）
  else if (token_hash && type) {
    console.log('[auth/callback] Processing email verification, type:', type)
    const { error } = await supabase.auth.verifyOtp({
      token_hash,
      type: type as 'signup' | 'email' | 'recovery' | 'invite',
    })
    authSuccess = !error
    if (error) {
      console.error('[auth/callback] Email verification error:', error)
    } else {
      console.log('[auth/callback] Email verification successful')
    }
  } else {
    console.log('[auth/callback] No code or token_hash found, checking for existing session')
  }

  // authSuccessでなくても、既存セッションがあるかチェック
  const { data: { user }, error: userError } = await supabase.auth.getUser()
  console.log('[auth/callback] getUser result:', {
    hasUser: !!user,
    userId: user?.id,
    email: user?.email,
    userError: userError?.message
  })

  if (user) {
    // maybeSingle() を使用（行がない場合もエラーにならない）
    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('roles, nickname, onboarding_started_at, onboarding_completed_at')
      .eq('id', user.id)
      .maybeSingle()

    console.log('[auth/callback] Profile:', {
      hasProfile: !!profile,
      onboardingCompleted: profile?.onboarding_completed_at,
      onboardingStarted: profile?.onboarding_started_at,
      profileError: profileError?.message
    })

    // プロファイル取得エラーの場合も安全にオンボーディングへ
    if (profileError) {
      console.error('[auth/callback] Profile fetch error:', profileError)
      next = '/onboarding/welcome'
    } else {
      const roles = profile?.roles || []

      // 管理者の場合は強制的に管理画面へ
      if (roles.includes('admin') || roles.includes('super_admin')) {
        next = '/admin'
      }
      // オンボーディング完了済み → ホームへ
      else if (profile?.onboarding_completed_at) {
        next = '/home'
      }
      // オンボーディング進行中 → 再開ページへ
      else if (profile?.onboarding_started_at) {
        next = '/onboarding/resume'
      }
      // 未開始またはプロファイルなし → 初回ウェルカムへ
      else {
        next = '/onboarding/welcome'
      }
    }
  } else if (!authSuccess) {
    // 認証も失敗し、既存ユーザーもいない場合
    console.log('[auth/callback] No user and auth failed, redirecting to login')
    next = '/login'
  }

  console.log('[auth/callback] Final redirect:', next)
  return NextResponse.redirect(new URL(next, requestUrl.origin))
}
