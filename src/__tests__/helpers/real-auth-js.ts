/**
 * テスト用: 本物の auth-js (GoTrueClient) を載せたブラウザ用 Supabase クライアントと、借り物のセッションの Cookie (#1038 F7-05)
 *
 * モバイルアプリの WebView の Web 側は、ネイティブから借りたセッション (Cookie) で動く。その refresh_token は
 * 更新に使えない値 (NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER)。auth-js が更新を試みると /token が 400 を返し、
 * auth-js はセッションを捨てて SIGNED_OUT を出す。この動きを auth-js をモックせずに確かめるための部品。
 * (auth-js をモックすると、更新の失敗から SIGNED_OUT が出るまでの本物の動きと、更新を始める時点の閾値を確かめられない)
 *
 * 使う側は、jsdom の環境で、クライアントを作る前に vi.useFakeTimers() を呼ぶこと (auth-js の自動更新の tick は setInterval で動く)。
 */
import { createBrowserClient } from '@supabase/ssr'
import { vi } from 'vitest'

import { NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER } from '@/lib/native-auth-bridge'

export const SUPABASE_URL = 'https://abcdefghijklmnop.supabase.co'
/** supabase-js の既定の保存キー: sb-<ホスト名の最初のラベル>-auth-token */
export const STORAGE_KEY = 'sb-abcdefghijklmnop-auth-token'

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
    // @supabase/ssr 0.1.0 は options を渡すと cookies の既定値 ({}) が undefined で上書きされるので、空のまま渡す
    cookies: {},
    isSingleton: false,
    global: { fetch: fakeFetch as unknown as typeof fetch },
  })
}

/** native-bridge が張るのと同じ形で、Cookie にセッションを置く (@supabase/ssr のブラウザ用ストレージは document.cookie を使う) */
export function seedBorrowedSession(remainingSeconds: number, refreshToken: string = NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER) {
  const session = {
    access_token: 'borrowed-access-token',
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
