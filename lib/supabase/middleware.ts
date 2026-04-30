import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { resolveOnboardingRedirect } from '@/lib/onboarding-routing'

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
  // エラー時は安全側に倒して /login へリダイレクトする
  let user: { id: string } | null = null
  let getUserFailed = false
  try {
    const { data } = await supabase.auth.getUser()
    user = data.user
  } catch {
    // #86: getUser() が例外を投げた場合 (ネットワークエラー等) は未認証扱いにする
    // RSC payload fetch 時はリダイレクトよりも 200 を返す方が安全なため、フラグを立てる
    user = null
    getUserFailed = true
  }

  // #86: RSC payload fetch (_rsc クエリパラメータ) 時に getUser が例外を投げた場合は
  // リダイレクトせず supabaseResponse を返す（RSC fetch failure を防止）
  if (getUserFailed && request.nextUrl.searchParams.has('_rsc')) {
    return supabaseResponse
  }

  // 認証不要のパス (ホワイトリスト)
  // 注: '/' エントリの startsWith チェックは '//' になるため '/home' は含まれない
  const publicPaths = [
    '/',
    '/login',
    '/signup',
    '/auth',
    '/onboarding',
    '/about',
    '/pricing',
    '/guide',
    '/faq',
    '/contact',
    '/legal',
    '/company',
    '/news',
  ]
  const isPublicPath = publicPaths.some(
    (path) =>
      request.nextUrl.pathname === path ||
      request.nextUrl.pathname.startsWith(path + '/'),
  )

  if (!user && !isPublicPath) {
    const url = request.nextUrl.clone()
    const next = request.nextUrl.pathname + (request.nextUrl.search ?? '')
    url.pathname = '/login'
    url.search = `?next=${encodeURIComponent(next)}`
    return NextResponse.redirect(url)
  }

  if (user) {
    // user_profiles からオンボーディング状態を取得
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('roles, onboarding_started_at, onboarding_completed_at')
      .eq('id', user.id)
      .maybeSingle()

    const redirectPath = resolveOnboardingRedirect({
      pathname: request.nextUrl.pathname,
      roles: profile?.roles || [],
      onboardingStartedAt: profile?.onboarding_started_at ?? null,
      onboardingCompletedAt: profile?.onboarding_completed_at ?? null,
    })

    if (redirectPath && redirectPath !== request.nextUrl.pathname) {
      const url = request.nextUrl.clone()
      url.pathname = redirectPath
      return NextResponse.redirect(url)
    }
  }

  // 認証保護ルートのレスポンスを CDN にキャッシュさせない
  if (!isPublicPath) {
    supabaseResponse.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  }

  return supabaseResponse
}
