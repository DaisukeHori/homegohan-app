import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'

/**
 * ネイティブアプリからの認証ブリッジ
 *
 * ネイティブ側で取得した Supabase session token を受け取り、
 * Web 側の Cookie に setSession() でセッションを設定してから next へリダイレクトする。
 *
 * フロー:
 *   1. ネイティブ: supabase.auth.getSession() → access_token / refresh_token 取得
 *   2. WebView が /auth/native-bridge?access_token=X&refresh_token=Y&next=/home?mode=app を開く
 *   3. このルートが setSession() を呼び Cookie に session 保存
 *   4. next パスへ redirect → 以降の WebView ナビゲーションは Cookie session 共有で認証済み
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const accessToken = url.searchParams.get('access_token')
  const refreshToken = url.searchParams.get('refresh_token')
  const next = url.searchParams.get('next') ?? '/home?mode=app'

  if (!accessToken || !refreshToken) {
    console.warn('[auth/native-bridge] Missing access_token or refresh_token, redirecting to login')
    return NextResponse.redirect(new URL('/login', req.url))
  }

  const cookieStore = cookies()
  const supabase = createClient(cookieStore)

  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  })

  if (error) {
    console.error('[auth/native-bridge] setSession error:', error.message)
    return NextResponse.redirect(new URL('/login', req.url))
  }

  // next は相対パスまたは絶対 URL のどちらも受け付けるが、
  // セキュリティのため同一オリジン内パスのみ許可する
  let redirectUrl: URL
  try {
    // next が '/' で始まる相対パスの場合は同一オリジンとみなす
    if (next.startsWith('/')) {
      redirectUrl = new URL(next, req.url)
    } else {
      // 絶対 URL の場合はオリジンが一致するか検証
      const parsed = new URL(next)
      const reqOrigin = new URL(req.url).origin
      if (parsed.origin !== reqOrigin) {
        console.warn('[auth/native-bridge] Cross-origin redirect blocked:', next)
        redirectUrl = new URL('/home?mode=app', req.url)
      } else {
        redirectUrl = parsed
      }
    }
  } catch {
    redirectUrl = new URL('/home?mode=app', req.url)
  }

  return NextResponse.redirect(redirectUrl)
}
