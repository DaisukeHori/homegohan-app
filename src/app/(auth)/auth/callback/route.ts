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
      // ユーザー情報を取得してロールを確認
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single()
        
        // 管理者の場合は強制的に管理画面へ
        if (profile?.role === 'admin') {
          next = '/admin'
        }
        
        // プロフィールが存在しない（新規登録）場合はオンボーディングへ
        // ただし、管理者の場合はオンボーディングをスキップしても良いが、
        // 基本的に管理者は既存ユーザーから昇格するのでプロフィールはあるはず。
        if (!profile && next !== '/admin') {
          next = '/onboarding'
        }
      }
    }
  }

  return NextResponse.redirect(new URL(next, requestUrl.origin))
}
