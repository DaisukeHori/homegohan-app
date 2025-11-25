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
          .select('role, nickname')
          .eq('id', user.id)
          .single()
        
        // 管理者の場合は強制的に管理画面へ
        if (profile?.role === 'admin') {
          next = '/admin'
        }
        // プロフィールが存在しない、またはニックネームが未設定（オンボーディング未完了）の場合はオンボーディングへ
        else if (!profile || !profile.nickname) {
          next = '/onboarding'
        }
      }
    }
  }

  return NextResponse.redirect(new URL(next, requestUrl.origin))
}
