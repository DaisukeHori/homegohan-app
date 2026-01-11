import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  // APIルートの場合は、セッション更新のみ行い、リダイレクトはしない
  // これにより、不要な getUser() 呼び出しを減らす
  const isApiRoute = request.nextUrl.pathname.startsWith('/api/')
  
  // レスポンスを作成（クッキーを蓄積するために1つのインスタンスを使い回す）
  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: any) {
          // リクエストとレスポンスの両方にクッキーを設定
          request.cookies.set({
            name,
            value,
            ...options,
          })
          // 同じレスポンスインスタンスにクッキーを追加（蓄積する）
          supabaseResponse.cookies.set({
            name,
            value,
            ...options,
          })
        },
        remove(name: string, options: any) {
          request.cookies.set({
            name,
            value: '',
            ...options,
          })
          supabaseResponse.cookies.set({
            name,
            value: '',
            ...options,
          })
        },
      },
    }
  )

  // APIルートの場合はセッション更新のみ（getUser()は各ルートで行う）
  // これにより、ミドルウェアでの認証チェックを最小限に抑える
  if (isApiRoute) {
    // getSession()でセッションを取得し、必要に応じてトークンをリフレッシュ
    // getUser()よりも軽量で、サーバーへの追加リクエストを行わない
    await supabase.auth.getSession()
    return supabaseResponse
  }

  // ページナビゲーションの場合は getUser() で認証を確認
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const publicPaths = ['/', '/login', '/signup', '/auth', '/onboarding']
  const isPublicPath = publicPaths.some(path => 
    request.nextUrl.pathname === path || 
    request.nextUrl.pathname.startsWith(path + '/')
  )

  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // 認証済みユーザーがルートにアクセスした場合、またはホームにアクセスした場合
  // オンボーディング状態に応じてリダイレクト
  if (user && (request.nextUrl.pathname === '/' || request.nextUrl.pathname === '/home')) {
    // user_profiles からオンボーディング状態を取得
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('roles, onboarding_started_at, onboarding_completed_at')
      .eq('id', user.id)
      .maybeSingle()

    const roles = profile?.roles || []

    // 管理者の場合は管理画面へ
    if (roles.includes('admin') || roles.includes('super_admin')) {
      const url = request.nextUrl.clone()
      url.pathname = '/admin'
      return NextResponse.redirect(url)
    }
    // オンボーディング未完了の場合はオンボーディングへ
    else if (!profile?.onboarding_completed_at) {
      // オンボーディング進行中 → 再開ページへ
      if (profile?.onboarding_started_at) {
        const url = request.nextUrl.clone()
        url.pathname = '/onboarding/resume'
        return NextResponse.redirect(url)
      }
      // 未開始 → ウェルカムページへ
      else {
        const url = request.nextUrl.clone()
        url.pathname = '/onboarding/welcome'
        return NextResponse.redirect(url)
      }
    }
    // オンボーディング完了済みでルートにアクセスした場合はホームへ
    else if (request.nextUrl.pathname === '/') {
      const url = request.nextUrl.clone()
      url.pathname = '/home'
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}
