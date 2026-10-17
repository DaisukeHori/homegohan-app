/**
 * テスト用: 本物の auth-js (GoTrueClient) を載せたブラウザ用 Supabase クライアントと、借り物のセッションの Cookie (#1038 F7-05)
 *
 * モバイルアプリの WebView の Web 側は、ネイティブから借りたセッション (Cookie) で動く。その refresh_token は
 * 更新に使えない値 (NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER)。auth-js が更新を試みると /token が 400 を返す。
 * auth-js 2.117 は、access token が有効なうちの更新の失敗ではセッションを捨てず (失敗を REFRESH_FAILURE_COOLDOWN_MS 控える)、
 * 失効の後の更新の失敗でセッションを捨てて SIGNED_OUT を出す。この動きを auth-js をモックせずに確かめるための部品。
 * (auth-js をモックすると、更新の失敗から SIGNED_OUT が出るまでの本物の動きと、更新を始める時点の閾値を確かめられない)
 *
 * 使う側は、jsdom の環境で、クライアントを作る前に vi.useFakeTimers() を呼ぶこと (auth-js の自動更新の tick は setInterval で動く)。
 */
import { createBrowserClient } from '@supabase/ssr'
import { AUTO_REFRESH_TICK_DURATION_MS, REFRESH_FAILURE_COOLDOWN_MS } from '@supabase/auth-js/dist/main/lib/constants'
import { vi } from 'vitest'

import { NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER } from '@/lib/native-auth-bridge'
import { SUPABASE_COOKIE_ENCODING } from '@/lib/supabase/cookie-encoding'

export const SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co'
/** supabase-js の既定の保存キー: sb-<ホスト名の最初のラベル>-auth-token */
export const STORAGE_KEY = 'sb-abcdefghijklmnop-auth-token'
/** seedBorrowedSession が書く access token。更新が失敗しても「同じ token が残る」を見るのに使う */
export const BORROWED_ACCESS_TOKEN = 'borrowed-access-token'
/** 失効済みの借り物のセッションの残り (秒)。1 時間以上バックグラウンドに置いて戻った状態。期限切れの JWT の exp にも使う */
export const ALREADY_EXPIRED_REMAINING_SECONDS = -1
/**
 * access token の失効から SIGNED_OUT が出るまでの上限 (ミリ秒)。失効の前の最後の実際の更新の失敗の控えが最大 REFRESH_FAILURE_COOLDOWN_MS
 * 効き、その後の最初の tick (AUTO_REFRESH_TICK_DURATION_MS 以内) が失効後の更新で捨てる (docs/design/mobile/05-auth-session.md §9.4 T-4)
 */
export const SIGNED_OUT_AFTER_EXPIRY_MAX_MS = REFRESH_FAILURE_COOLDOWN_MS + AUTO_REFRESH_TICK_DURATION_MS

export type FakeSupabaseFetch = ReturnType<typeof createFakeSupabaseFetch>

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * Supabase への通信の代わり。refresh_token での更新 (/token) は、使えない値なので 400 (refresh_token_not_found) を返す。
 * 本物の GoTrue が、存在しない refresh_token に返すのと同じ形。
 */
export function createFakeSupabaseFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
      return jsonResponse(
        { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' },
        400,
      )
    }
    if (url.includes('/auth/v1/user')) {
      return jsonResponse({
        id: 'user-1',
        aud: 'authenticated',
        role: 'authenticated',
        email: 'user@example.com',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-01-01T00:00:00Z',
      })
    }
    if (url.includes('/rest/v1/user_profiles')) {
      return jsonResponse({ roles: ['user'], org_role: null, organization_id: null })
    }
    return jsonResponse({}, 404)
  })
}

/** 更新 (/token) の呼び出しだけを取り出す */
export function refreshRequests(fakeFetch: FakeSupabaseFetch) {
  return fakeFetch.mock.calls.filter(([input]) =>
    String(input instanceof Request ? input.url : input).includes('grant_type=refresh_token'),
  )
}

/** 本物の auth-js を載せたブラウザ用クライアント。fetch だけを差し替える */
export function createRealBrowserClient(fakeFetch: FakeSupabaseFetch) {
  return createBrowserClient(SUPABASE_URL, 'anon-key', {
    // cookies を省くと document.cookie を読み書きする (製品の lib/supabase/client.ts と同じ書式を渡す)
    cookieEncoding: SUPABASE_COOKIE_ENCODING,
    isSingleton: false,
    global: { fetch: fakeFetch as unknown as typeof fetch },
  })
}

/** native-bridge が張るのと同じ形の借り物のセッション (Cookie に置く JSON の中身) */
export function buildBorrowedSession(remainingSeconds: number, refreshToken: string = NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER) {
  return {
    access_token: BORROWED_ACCESS_TOKEN,
    token_type: 'bearer',
    expires_in: remainingSeconds,
    expires_at: Math.floor(Date.now() / 1000) + remainingSeconds,
    refresh_token: refreshToken,
    user: {
      id: 'user-1',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'user@example.com',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
    },
  }
}

/** native-bridge が張るのと同じ形で、Cookie にセッションを置く (@supabase/ssr のブラウザ用ストレージは document.cookie を使う) */
export function seedBorrowedSession(remainingSeconds: number, refreshToken: string = NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER) {
  const session = buildBorrowedSession(remainingSeconds, refreshToken)
  document.cookie = `${STORAGE_KEY}=${encodeURIComponent(JSON.stringify(session))}; path=/`
}

export function clearAllCookies() {
  for (const pair of document.cookie.split(';')) {
    const name = pair.split('=')[0]?.trim()
    if (name) document.cookie = `${name}=; path=/; max-age=0`
  }
}

/** auth-js の setSession() が読む、有効期限だけを持つ JWT (署名は検証されない) */
export function fakeJwt(expiresAtSeconds: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'user-1', exp: expiresAtSeconds })}.c2ln`
}
