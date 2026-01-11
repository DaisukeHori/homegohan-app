import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const token_hash = requestUrl.searchParams.get('token_hash')
  const type = requestUrl.searchParams.get('type')
  let next = requestUrl.searchParams.get('next') ?? '/home'

  const supabase = createClient()
  let authSuccess = false

  // OAuth コールバック（code パラメータ）
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    authSuccess = !error
    if (error) {
      console.error('OAuth code exchange error:', error)
    }
  }
  // メール確認コールバック（token_hash パラメータ）
  else if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash,
      type: type as 'signup' | 'email' | 'recovery' | 'invite',
    })
    authSuccess = !error
    if (error) {
      console.error('Email verification error:', error)
    }
  }

  if (authSuccess) {
    // ユーザー情報を取得してロールとオンボーディング状態を確認
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      // maybeSingle() を使用（行がない場合もエラーにならない）
      const { data: profile, error: profileError } = await supabase
        .from('user_profiles')
        .select('roles, nickname, onboarding_started_at, onboarding_completed_at')
        .eq('id', user.id)
        .maybeSingle()

      // プロファイル取得エラーの場合も安全にオンボーディングへ
      if (profileError) {
        console.error('Profile fetch error in callback:', profileError)
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
    } else {
      // ユーザー取得に失敗した場合もオンボーディングへ
      next = '/onboarding/welcome'
    }
  }

  return NextResponse.redirect(new URL(next, requestUrl.origin))
}
