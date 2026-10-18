/**
 * Next 16 の proxy (旧 middleware。#1744)。全リクエストの前に動き、CSP の nonce を付けてから updateSession
 * (lib/supabase/middleware.ts: セッションの同期・メンテナンス・凍結・同意ゲート・認証の振り分け) に渡す。
 * Next 16 で middleware の名前が非推奨になり proxy に変わった。proxy は Node.js の runtime だけで動く
 * (config に runtime を書くと next build が失敗する)。そのため config には matcher だけを書く。
 * 全リクエストで読み込まれるので、zod を持つ src/lib/env.ts には到達させない (tests/env-source-scan.test.ts)。
 */
import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { getSupabaseUrl } from '@/lib/env-required'
import {
  CSP_HEADER,
  CSP_NONCE_HEADER,
  CSP_REPORT_ONLY_HEADER,
  buildContentSecurityPolicy,
  cspHeaderName,
  generateCspNonce,
  isCspReportOnly,
} from '@/lib/security/csp'

/** Supabase の URL (ローカルの Supabase なら方針に origin を足す)。無ければ undefined (updateSession が 500 で止める。ここでは止めない) */
function supabaseUrlOrUndefined(): string | undefined {
  try {
    return getSupabaseUrl()
  } catch {
    return undefined
  }
}

/**
 * #1169: このリクエストの nonce と方針を作り、リクエストヘッダーに載せる (Next は content-security-policy から nonce を読み、
 * 画面は x-csp-nonce から読める)。クライアントが同じ名前のヘッダーを送ってきても、捨てて付け直す (#1174 の x-legal-consent-pending と同じ)。
 * updateSession は NextResponse.next({ request }) を作るので、呼ぶ前に載せる。
 * request.headers.set は try / catch で包まない (載せられないと Next が nonce を付けられず、強制の方針が全ページを止める。黙って壊れるより止まる)
 */
function attachCspToRequest(request: NextRequest): { headerName: string; policy: string } {
  const nonce = generateCspNonce()
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    supabaseUrl: supabaseUrlOrUndefined(),
  })
  const headerName = cspHeaderName(isCspReportOnly())
  request.headers.delete(CSP_NONCE_HEADER)
  request.headers.delete(CSP_HEADER)
  request.headers.delete(CSP_REPORT_ONLY_HEADER)
  request.headers.set(CSP_NONCE_HEADER, nonce)
  request.headers.set(headerName, policy)
  return { headerName, policy }
}

export async function proxy(request: NextRequest) {
  const csp = attachCspToRequest(request)
  const res = await updateSession(request)
  // どの分岐の応答 (next / redirect / 403 / 503 / 500) にも同じ方針を付ける
  res.headers.set(csp.headerName, csp.policy)

  // ?mode=app が付いていれば is_native_app Cookie をセット (既存。変えない)
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
     * - sitemap.xml (サイトマップ #1867。src/app/sitemap.ts。ちょうどこのパスだけ。未ログインのクローラーを /login へ送らない。
     *   XML で文書ではないので CSP も要らない。robots.txt と同じ扱い)
     * - sw.js / workbox-* (service worker files)
     * - api/health (死活監視用ヘルスチェック #1181。ちょうどこのパスだけ。
     *   Supabase のセッション処理を通さず、認証基盤の不調に引きずられないようにする。
     *   末尾の $ があるので /api/health/* (健康記録 API) は従来どおり対象のまま)
     * - _vercel/ (Vercel が扱うパス。Speed Insights のスクリプトと計測値の送信先 /_vercel/speed-insights/* など #1179。
     *   アプリのページではないので、未ログインの訪問者を /login へ送ったり、オンボーディングへ差し戻したりしない。
     *   Vercel 上で有効にした機能のパスは、Vercel がこの proxy より前に応答する (本番で確認: script.js は 200)。
     *   なので、Vercel 上で計測を守っているのはこの除外ではない。除外が効くのは、Vercel が応答しないとき
     *   (有効にしていない機能、存在しないパス、next start で Vercel の外に置いたとき) に、/_vercel/* の応答が
     *   ログイン画面の HTML にすり替わるのを防ぐ場面。害は無いので残す)
     * - opengraph-image / twitter-image (OGP / Twitter Card の画像 #1845。src/app/opengraph-image.tsx・twitter-image.tsx。
     *   ちょうどこのパスだけ。拡張子の無いパスなので下の画像の拡張子の除外に当たらない。SNS のクローラーは未ログインなので、
     *   通すと /login へ送られ、画像の代わりにログイン画面の HTML が返る。画像は文書ではないので CSP も要らない)
     */
    '/((?!_next/static|_next/image|_vercel/|favicon\\.ico|manifest\\.json|robots\\.txt|sitemap\\.xml$|sw\\.js|workbox-|api/health$|opengraph-image$|twitter-image$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
