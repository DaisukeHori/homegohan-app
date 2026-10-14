import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  const res = await updateSession(request)

  // ?mode=app が付いていれば is_native_app Cookie をセット
  // これにより SSR 初回レンダリング時に cookies() で native 判定できる
  const isAppMode = request.nextUrl.searchParams.get('mode') === 'app'
  const existingCookie = request.cookies.get('is_native_app')?.value
  if (isAppMode && existingCookie !== '1') {
    res.cookies.set('is_native_app', '1', {
      maxAge: 60 * 60 * 24 * 30,
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
    })
  }

  return res
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - manifest.json (PWA manifest — must not be redirected to /login)
     * - robots.txt (crawler instructions)
     * - sw.js / workbox-* (service worker files)
     * - api/health (死活監視用ヘルスチェック #1181。ちょうどこのパスだけ。
     *   Supabase のセッション処理を通さず、認証基盤の不調に引きずられないようにする。
     *   末尾の $ があるので /api/health/* (健康記録 API) は従来どおり対象のまま)
     * - _vercel/ (Vercel が扱うパス。Speed Insights のスクリプトと計測値の送信先 /_vercel/speed-insights/* など #1179。
     *   アプリのページではないので、未ログインの訪問者を /login へ送ったり、オンボーディングへ差し戻したりしない。
     *   Vercel 上で有効にした機能のパスは、Vercel がこのミドルウェアより前に応答する (本番で確認: script.js は 200)。
     *   なので、Vercel 上で計測を守っているのはこの除外ではない。除外が効くのは、Vercel が応答しないとき
     *   (有効にしていない機能、存在しないパス、next start で Vercel の外に置いたとき) に、/_vercel/* の応答が
     *   ログイン画面の HTML にすり替わるのを防ぐ場面。害は無いので残す)
     * Feel free to modify this pattern to include more paths.
     */
    '/((?!_next/static|_next/image|_vercel/|favicon\\.ico|manifest\\.json|robots\\.txt|sw\\.js|workbox-|api/health$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}



