import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createLogger, generateRequestId } from '@/lib/db-logger'
import { getSafeRedirectPathOrDefault } from '@/lib/auth/safe-redirect'
import {
  consumeNativeBridgeCode,
  isLegacyNativeBridgeAllowed,
  isWellFormedNativeBridgeCode,
  NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER,
  NativeBridgeCodeError,
  shouldShareRefreshTokenWithWeb,
  type ConsumedNativeBridgeCode,
} from '@/lib/auth/native-bridge-code'

/**
 * ネイティブアプリからの認証ブリッジ
 *
 * ネイティブ側のセッションを WebView (Web) の Cookie セッションに引き継ぐ。
 *
 * 【新方式】ワンタイムコード (#1036)
 *   1. ネイティブ: POST /api/auth/native-bridge/code (Bearer JWT + refresh_token) でコードをもらう
 *   2. WebView が /auth/native-bridge?code=X&next=/home?mode=app を開く
 *   3. このルートがコードを 1 回だけ引き換え (60 秒・使い捨て)、setSession() で Cookie にセッションを保存する
 *   4. next パスへ redirect → 以降の WebView ナビゲーションは Cookie セッション共有で認証済み
 *   URL に載るのはコードだけで、アクセストークン / リフレッシュトークンは URL にもリダイレクト先にも出ない。
 *   Cookie に入れる refresh_token は実際の値ではなく使えない値 (NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER)。
 *   ネイティブと Web が同じ refresh_token を別々にローテーションして、セッションごと失効するのを防ぐため (#1038 F7-05)。
 *   Web 側は期限が近づくと { type: 'session-expired' } でネイティブに知らせ、ネイティブが新しいコードで読み込み直す。
 *   従来の動作 (実際の refresh_token を入れる) へ戻すスイッチ: 環境変数 NATIVE_BRIDGE_SHARE_REFRESH_TOKEN=on
 *
 * 【旧方式】トークンを URL クエリで渡す (access_token / refresh_token)
 *   URL がアクセスログに残り、有効なトークンが漏れるため廃止する。ただし旧アプリが動かなくなるのを避けるため、
 *   LEGACY_SUNSET_AT (src/lib/auth/native-bridge-code.ts) まで、または環境変数 NATIVE_BRIDGE_LEGACY_GET=off に
 *   するまで受け付ける。使われるたびに警告ログを残す。閉じた後は 426 (アプリの更新を促すページ) を返す。
 *
 * どの応答も Cache-Control: no-store / Referrer-Policy: no-referrer。
 * is_native_app Cookie はセッションを作れたときだけ設定する。
 */

/** next が無い・不正なときの遷移先 */
const DEFAULT_NEXT_PATH = '/home?mode=app'

/** `https:` `javascript:` など、スキーム付きの値 */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/

/** @supabase/ssr がセッションを保存する Cookie 名 (sb-<project-ref>-auth-token と、分割時の .0 .1 ...) */
const SUPABASE_AUTH_COOKIE_PATTERN = /^sb-.+-auth-token(?:\.\d+)?$/

const LEGACY_CLOSED_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>アプリの更新が必要です</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; background: #fff; color: #222; }
  main { max-width: 28rem; margin: 0 auto; padding: 4rem 1.5rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { font-size: 0.95rem; line-height: 1.7; margin: 0; color: #555; }
</style>
</head>
<body>
<main>
<h1>アプリを最新版に更新してください</h1>
<p>お使いのバージョンのアプリでは、安全にログインを引き継げなくなりました。アプリを最新版に更新してから、もう一度お試しください。</p>
</main>
</body>
</html>
`

/** どの応答にも付ける共通ヘッダ (コード・トークンを含み得る URL を共有キャッシュ / Referer に残さない) */
function finalize<T extends NextResponse>(response: T): T {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Referrer-Policy', 'no-referrer')
  return response
}

/** パスへの 307 リダイレクト。同一オリジン以外には絶対に飛ばさない (多層防御) */
function redirectTo(path: string, requestUrl: string): NextResponse {
  const base = new URL(requestUrl)
  const target = new URL(path, base)
  return finalize(NextResponse.redirect(target.origin === base.origin ? target : new URL(DEFAULT_NEXT_PATH, base)))
}

/** WebView セッション中は is_native_app Cookie を設定する。成功時だけ呼ぶこと */
function withNativeAppCookie(response: NextResponse): NextResponse {
  // これにより SSR 初回レンダリング時から bottom nav を非表示にでき、
  // クライアント hydration 後のちらつき (flash) を防ぐ。
  response.cookies.set('is_native_app', '1', {
    maxAge: 60 * 60 * 24 * 30, // 30 日
    httpOnly: false,            // クライアント側 (document.cookie) からも読み取り可能
    sameSite: 'lax',
    path: '/',
  })
  return response
}

/**
 * next を同一オリジンの相対パスに解決する。
 * - 同一オリジンの絶対 URL は「パス + クエリ + ハッシュ」に落とす (別オリジンは捨てる)
 * - その上で getSafeRedirectPathOrDefault により、`//evil.com` `/\evil.com` `/%2F/evil.com` など
 *   プロトコル相対・バックスラッシュ・エンコードで偽装した外部遷移を拒否する (オープンリダイレクト対策)
 * 不正・不在のときは DEFAULT_NEXT_PATH。
 */
function resolveNextPath(requestUrl: URL): string {
  const rawNext = requestUrl.searchParams.get('next')?.trim()
  if (!rawNext) return DEFAULT_NEXT_PATH

  let candidate: string | null = rawNext
  if (SCHEME_PATTERN.test(rawNext)) {
    try {
      const parsed = new URL(rawNext)
      candidate =
        parsed.origin === requestUrl.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null
    } catch {
      candidate = null
    }
  }
  return getSafeRedirectPathOrDefault(candidate, DEFAULT_NEXT_PATH)
}

/** Supabase のセッション Cookie (sb-*-auth-token と分割分) を削除する。signOut と違い、サーバ側のセッションは失効させない */
function clearSupabaseAuthCookies(cookieStore: ReturnType<typeof cookies>) {
  for (const { name } of cookieStore.getAll()) {
    if (SUPABASE_AUTH_COOKIE_PATTERN.test(name)) {
      // 設定時と同じ path (/) を明示する。省略するとリクエスト URL 由来の既定パス (/auth) になり、ブラウザが消さない
      cookieStore.delete({ name, path: '/' })
    }
  }
}

/**
 * setSession でトークンを Cookie セッションにする。例外は握りつぶさず失敗として返す
 * (コードは引き換えた時点で使用済みなので、500 にせず /login へ戻す)。
 * 成功時は userId (セッションのユーザー ID。取れなければ null) を返す。
 */
async function establishSession(
  supabase: ReturnType<typeof createClient>,
  accessToken: string,
  refreshToken: string,
): Promise<{ ok: true; userId: string | null } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })
    if (error) return { ok: false, message: error.message }
    return { ok: true, userId: data?.session?.user?.id ?? data?.user?.id ?? null }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'setSession threw' }
  }
}

/**
 * コードが無効 (形式不正・存在しない・期限切れ・使用済み・DB 障害) のとき。
 * この WebView が既に Cookie セッションを持っていれば (リロード・二重読み込み) そのまま next へ続ける。
 * 無ければ /login。セッションは作らないので is_native_app も設定しない。
 */
async function continueIfAlreadySignedIn(
  supabase: ReturnType<typeof createClient>,
  nextPath: string,
  requestUrl: string,
) {
  try {
    const { data } = await supabase.auth.getUser()
    if (data?.user) return redirectTo(nextPath, requestUrl)
  } catch {
    // 認証基盤の一時障害などは「セッションなし」として扱う
  }
  console.warn('[auth/native-bridge] Invalid, expired or already used code, redirecting to login')
  return redirectTo('/login', requestUrl)
}

/** 新方式: ?code=... */
async function handleCode(requestUrl: URL, rawUrl: string, nextPath: string) {
  const code = requestUrl.searchParams.get('code') ?? ''
  const cookieStore = cookies()
  const supabase = createClient(cookieStore)
  const logger = createLogger('auth/native-bridge', generateRequestId())

  let consumed: ConsumedNativeBridgeCode | null = null
  // 形式が不正なコードは DB に問い合わせない
  if (isWellFormedNativeBridgeCode(code)) {
    try {
      consumed = await consumeNativeBridgeCode(code)
    } catch (error) {
      // DB 障害など。コードの状態は分からないので無効扱いにする (コード自体はログに出さない)
      logger.error(
        'consume_native_bridge_code failed',
        error,
        { pg_code: error instanceof NativeBridgeCodeError ? error.pgCode : undefined },
      )
    }
  }

  if (!consumed) {
    return continueIfAlreadySignedIn(supabase, nextPath, rawUrl)
  }

  // トークンは URL (クエリ) ではなく、引き換えた行から取り出す。
  // Cookie に入れる refresh_token は実際の値ではなく使えない値にする (Web が更新してネイティブとフォークするのを防ぐ。#1038 F7-05)
  const refreshTokenForWeb = shouldShareRefreshTokenWithWeb()
    ? consumed.refreshToken
    : NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER
  const session = await establishSession(supabase, consumed.accessToken, refreshTokenForWeb)
  if (!session.ok) {
    console.error('[auth/native-bridge] setSession error:', session.message)
    return redirectTo('/login', rawUrl)
  }

  // 行の持ち主 (コード発行時に検証済みの user_id) とセッションのユーザーが一致することを確認する。
  // 不一致 (DB の行の改ざん等) なら、setSession が書いた Cookie を消して拒否する。
  // signOut は使わない (他人の実セッションをサーバ側で失効させてしまうため)。
  if (session.userId !== consumed.userId) {
    clearSupabaseAuthCookies(cookieStore)
    logger
      .withUser(consumed.userId)
      .error('native bridge code user mismatch', new Error('session user does not match code owner'), {
        session_user_id: session.userId,
      })
    return redirectTo('/login', rawUrl)
  }

  return withNativeAppCookie(redirectTo(nextPath, rawUrl))
}

/** 旧方式: ?access_token=...&refresh_token=... (期限つき。#1036) */
async function handleLegacy(
  req: NextRequest,
  accessToken: string,
  refreshToken: string,
  nextPath: string,
) {
  if (!isLegacyNativeBridgeAllowed()) {
    // 認証なしで誰でも到達できるため、ここでは DB ログを書かない (Vercel のログのみ)
    console.warn('[auth/native-bridge] Legacy token-in-query bridge is closed, returning 426')
    return finalize(
      new NextResponse(LEGACY_CLOSED_HTML, {
        status: 426,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    )
  }

  const supabase = createClient(cookies())
  const session = await establishSession(supabase, accessToken, refreshToken)
  if (!session.ok) {
    console.error('[auth/native-bridge] setSession error:', session.message)
    return redirectTo('/login', req.url)
  }

  // 旧アプリがどれだけ残っているかを数えるための記録 (トークンの値は一切渡さない)。
  // 'legacy token-in-query bridge used' が 0 件になったら旧方式を削除できる。
  const logger = createLogger('auth/native-bridge', generateRequestId())
  const metadata = { ua: (req.headers.get('user-agent') ?? '').slice(0, 200) }
  if (session.userId) {
    logger.withUser(session.userId).warn('legacy token-in-query bridge used', metadata)
  } else {
    logger.warn('legacy token-in-query bridge used', metadata)
  }

  return withNativeAppCookie(redirectTo(nextPath, req.url))
}

export async function GET(req: NextRequest) {
  // req.nextUrl ではなく new URL(req.url) を使う (単体テストが素の Request を渡すため)
  const url = new URL(req.url)
  const nextPath = resolveNextPath(url)

  // code があれば最優先。旧方式のトークンが同時に付いていても使わない
  if (url.searchParams.has('code')) {
    return handleCode(url, req.url, nextPath)
  }

  const accessToken = url.searchParams.get('access_token')
  const refreshToken = url.searchParams.get('refresh_token')
  if (accessToken && refreshToken) {
    return handleLegacy(req, accessToken, refreshToken, nextPath)
  }

  console.warn('[auth/native-bridge] Missing code, redirecting to login')
  return redirectTo('/login', req.url)
}
