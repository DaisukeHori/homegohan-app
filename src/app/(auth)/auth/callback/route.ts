import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  let next = requestUrl.searchParams.get('next') ?? '/home'

  if (code) {
    const supabase = createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    
    if (!error) {
      // ユーザー情報を取得してロールとオンボーディング状態を確認
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('roles, nickname, onboarding_started_at, onboarding_completed_at')
          .eq('id', user.id)
          .single()
        
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
        // 未開始 → 初回ウェルカムへ
        else {
          next = '/onboarding/welcome'
        }
      }
    }
  }

  return NextResponse.redirect(new URL(next, requestUrl.origin))
}
