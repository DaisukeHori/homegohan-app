import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)

  // 全パラメータをログ出力（デバッグ用）
  console.log('[auth/callback] ========== AUTH CALLBACK START ==========')
  console.log('[auth/callback] Full URL:', requestUrl.toString())
  console.log('[auth/callback] All params:', Object.fromEntries(requestUrl.searchParams.entries()))

  // クッキー情報をログ（PKCE code verifier の確認）
  const cookieStore = cookies()
  const allCookies = cookieStore.getAll()
  console.log('[auth/callback] Cookies:', allCookies.map(c => ({ name: c.name, hasValue: !!c.value })))
  const codeVerifier = allCookies.find(c => c.name.includes('code_verifier'))
  console.log('[auth/callback] PKCE code_verifier cookie present:', !!codeVerifier)

  // Supabase からのエラーパラメータをチェック
  const error_param = requestUrl.searchParams.get('error')
  const error_description = requestUrl.searchParams.get('error_description')
  const error_code = requestUrl.searchParams.get('error_code')

  if (error_param) {
    console.error('[auth/callback] Supabase returned error:', {
      error: error_param,
      description: error_description,
      code: error_code
    })
    // エラーページにリダイレクト（エラー情報付き）
    const loginUrl = new URL('/login', requestUrl.origin)
    loginUrl.searchParams.set('error', error_description || error_param || 'Authentication failed')
    return NextResponse.redirect(loginUrl)
  }

  const code = requestUrl.searchParams.get('code')
  const token_hash = requestUrl.searchParams.get('token_hash')
  const token = requestUrl.searchParams.get('token') // PKCE token
  const type = requestUrl.searchParams.get('type')
  let next = requestUrl.searchParams.get('next') ?? '/home'

  console.log('[auth/callback] Auth params:', { code: !!code, token_hash: !!token_hash, token: !!token, type })

  const supabase = createClient()
  let authSuccess = false

  // OAuth/PKCE コールバック（code パラメータ）
  if (code) {
    console.log('[auth/callback] Processing code exchange (PKCE/OAuth)')
    try {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code)
      authSuccess = !error
      if (error) {
        console.error('[auth/callback] Code exchange error:', error.message, error)
      } else {
        console.log('[auth/callback] Code exchange successful, user:', data.user?.email)
      }
    } catch (e) {
      console.error('[auth/callback] Code exchange exception:', e)
    }
  }
  // メール確認コールバック（token_hash パラメータ）
  else if (token_hash && type) {
    console.log('[auth/callback] Processing email verification with token_hash, type:', type)
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash,
        type: type as 'signup' | 'email' | 'recovery' | 'invite',
      })
      authSuccess = !error
      if (error) {
        console.error('[auth/callback] Email verification error:', error.message, error)
      } else {
        console.log('[auth/callback] Email verification successful, user:', data.user?.email)
      }
    } catch (e) {
      console.error('[auth/callback] Email verification exception:', e)
    }
  }
  // PKCE token パラメータ（Supabase が直接渡す場合）
  else if (token && type) {
    console.log('[auth/callback] Processing PKCE token, type:', type)
    try {
      // token パラメータは通常 Supabase サーバーが処理するが、
      // フォールバックとして verifyOtp を試行
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash: token,
        type: type as 'signup' | 'email' | 'recovery' | 'invite',
      })
      authSuccess = !error
      if (error) {
        console.error('[auth/callback] PKCE token verification error:', error.message, error)
      } else {
        console.log('[auth/callback] PKCE token verification successful, user:', data.user?.email)
      }
    } catch (e) {
      console.error('[auth/callback] PKCE token verification exception:', e)
    }
  } else {
    console.log('[auth/callback] No auth params found, checking for existing session')
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
