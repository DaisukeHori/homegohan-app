/**
 * @supabase/ssr 0.12 の Cookie の読み書きの互換のテスト (#1768。docs/design/mobile/05-auth-session.md §9.8・§9.9 E)
 *
 * すでにログインしている利用者のセッション (ssr 0.1.0 が書いた JSON の Cookie・分割あり) が、更新 (本番デプロイ) のあとも切れないこと、
 * 更新のあとに書く Cookie を、デプロイの前に開いたタブ (ssr 0.1.0 + auth-js 2.105.3) とロールバックした旧サーバーが読めること
 * (書式は JSON = cookieEncoding 'raw')、更新をまたぐ PKCE の verifier を読めることを、本物の @supabase/ssr と本物の auth-js で固定する。
 * 製品の呼び出し口 (lib/supabase/client.ts・server.ts・middleware.ts) と同じ cookieEncoding を渡す。
 */
import { createBrowserClient, createServerClient, type CookieOptions } from '@supabase/ssr'
import { createChunks, MAX_CHUNK_SIZE } from '@supabase/ssr/dist/main/utils/chunker'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { SUPABASE_COOKIE_ENCODING } from '@/lib/supabase/cookie-encoding'
import {
  BORROWED_ACCESS_TOKEN,
  buildBorrowedSession,
  clearAllCookies,
  createFakeSupabaseFetch,
  fakeJwt,
  seedBorrowedSession,
  STORAGE_KEY,
  SUPABASE_URL,
} from '../helpers/real-auth-js'

const ANON_KEY = 'anon-key'
/** tick (残り 120 秒未満) も getSession() (残り 90 秒未満) も更新を試みない残り (秒) */
const SESSION_VALID_FOR_SECONDS = 3_000
/** getSession() が更新を試みる (残り 90 秒未満) 残り (秒) */
const NEARLY_EXPIRED_SECONDS = 60
const MS_PER_SECOND = 1_000
const BASE64_PREFIX = 'base64-'
const REFRESHED_REFRESH_TOKEN = 'RT-new'
/** 更新の前 (ssr 0.1 + auth-js 2.105) に始めた PKCE の flow が従来のキー (<STORAGE_KEY>-code-verifier) に置いた verifier */
const LEGACY_CODE_VERIFIER = 'legacy-code-verifier-value'
const AUTH_CODE = 'auth-code-1'
const OAUTH_CALLBACK_URL = 'https://example.com/auth/callback'
const LEGACY_VERIFIER_KEY = `${STORAGE_KEY}-code-verifier`
const FLOWS_INDEX_KEY = `${STORAGE_KEY}-flows-code-verifier`
/** 2.105.3 の getCodeChallengeAndMethod が、パスワードの再設定の flow の verifier に付ける印 (docs/design §9.9 E-6) */
const RECOVERY_SUFFIX = '/recovery'

type SetAllEntry = { name: string; value: string; options: CookieOptions }

/** サーバーの Cookie の入れ物。getAll は呼び出し口の request.cookies.getAll()、setAll は応答の Set-Cookie に当たる */
function createServerCookieStore(initial: Record<string, string>) {
  const jar = new Map<string, string>(Object.entries(initial))
  const writes: SetAllEntry[] = []
  const headersSeen: Array<Record<string, string>> = []
  return {
    jar,
    writes,
    headersSeen,
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (cookies: SetAllEntry[], headers: Record<string, string>) => {
      headersSeen.push(headers)
      for (const cookie of cookies) {
        writes.push(cookie)
        if (cookie.options.maxAge === 0) jar.delete(cookie.name)
        else jar.set(cookie.name, cookie.value)
      }
    },
  }
}
type ServerCookieStore = ReturnType<typeof createServerCookieStore>

function tokenResponseBody(accessToken: string, refreshToken: string) {
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: SESSION_VALID_FOR_SECONDS,
    refresh_token: refreshToken,
    user: buildBorrowedSession(0).user,
  }
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function requestUrl(input: RequestInfo | URL) {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function futureJwt() {
  return fakeJwt(Math.floor(Date.now() / MS_PER_SECOND) + SESSION_VALID_FOR_SECONDS)
}

/** /token の更新 (refresh_token) と PKCE の交換 (pkce) が成功する偽の fetch。PKCE の交換で渡された code_verifier を記録する */
function createPkceExchangeFetch() {
  const base = createFakeSupabaseFetch()
  const codeVerifiers: Array<string | undefined> = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input)
    if (url.includes('/auth/v1/token?grant_type=pkce')) {
      const body = JSON.parse(String(init?.body)) as { code_verifier?: string }
      codeVerifiers.push(body.code_verifier)
      return jsonResponse(tokenResponseBody(futureJwt(), REFRESHED_REFRESH_TOKEN))
    }
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
      return jsonResponse(tokenResponseBody(futureJwt(), REFRESHED_REFRESH_TOKEN))
    }
    return base(input)
  })
  return { fn, codeVerifiers }
}

function asFetch(fn: unknown) {
  return fn as typeof fetch
}

function createServerClientFor(store: ServerCookieStore, fetchFn: unknown = createFakeSupabaseFetch()) {
  return createServerClient(SUPABASE_URL, ANON_KEY, {
    cookieEncoding: SUPABASE_COOKIE_ENCODING,
    cookies: { getAll: store.getAll, setAll: store.setAll },
    global: { fetch: asFetch(fetchFn) },
  })
}

/** 製品の lib/supabase/client.ts と同じ引数 (cookieEncoding だけ)。テストのために isSingleton と fetch だけ足す */
function createBrowserClientFor(fetchFn: unknown) {
  return createBrowserClient(SUPABASE_URL, ANON_KEY, {
    cookieEncoding: SUPABASE_COOKIE_ENCODING,
    isSingleton: false,
    global: { fetch: asFetch(fetchFn) },
  })
}

function sessionJson(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ ...buildBorrowedSession(SESSION_VALID_FOR_SECONDS), ...extra })
}

/** セッションの JSON を、ssr 0.1.0 が書いたのと同じ形 (そのまま・長ければ .0 / .1 に分割) で Cookie の入れ物の初期値にする */
function legacyCookies(json: string) {
  return Object.fromEntries(createChunks(STORAGE_KEY, json).map(({ name, value }) => [name, value]))
}

/** 旧バンドル (ssr 0.1.0 の combineChunks + auth-js 2.105.3 の getItemAsync) が読むのと同じ手順で、Cookie の値からセッションを取り出す */
function readLikeLegacyReader(jar: Map<string, string>) {
  const single = jar.get(STORAGE_KEY)
  if (single) return JSON.parse(decodeURIComponent(single)) as { access_token: string }
  const chunks: string[] = []
  for (let index = 0; jar.has(`${STORAGE_KEY}.${index}`); index += 1) chunks.push(jar.get(`${STORAGE_KEY}.${index}`) as string)
  return JSON.parse(decodeURIComponent(chunks.join(''))) as { access_token: string }
}

function documentCookies() {
  const entries = document.cookie
    .split('; ')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const separator = pair.indexOf('=')
      return [pair.slice(0, separator), decodeURIComponent(pair.slice(separator + 1))] as const
    })
  return new Map<string, string>(entries)
}

let warnSpy: MockInstance<typeof console.warn>
const browserClients: Array<ReturnType<typeof createBrowserClientFor>> = []

beforeEach(() => {
  clearAllCookies()
  // getSession() の「user を信頼するな」の警告と複数クライアントの警告は、この検査の対象ではない
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

afterEach(async () => {
  for (const client of browserClients.splice(0)) await client.auth.stopAutoRefresh()
  clearAllCookies()
  vi.restoreAllMocks()
})

/** @supabase/ssr 自身の警告 (非推奨の get / set / remove・復号の失敗・壊れた値) が出ていないこと */
function ssrWarnings() {
  return warnSpy.mock.calls.filter(([message]) => String(message).includes('@supabase/ssr'))
}

async function expectSessionReadable(store: ServerCookieStore) {
  const client = createServerClientFor(store)
  const { data: sessionData } = await client.auth.getSession()
  expect(sessionData.session?.access_token).toBe(BORROWED_ACCESS_TOKEN)
  const { data: userData, error } = await client.auth.getUser()
  expect(error).toBeNull()
  expect(userData.user?.id).toBe('user-1')
  expect(ssrWarnings()).toEqual([])
}

describe('ssr 0.12 の Cookie の読み (すでにログインしている利用者のセッションが切れない)', () => {
  it('E-1: ssr 0.1 が書いた JSON の Cookie (1 つ) を、getAll / setAll の createServerClient が読み、getSession が同じ access_token を返し、getUser が通る', async () => {
    const json = sessionJson()
    expect(createChunks(STORAGE_KEY, json)).toHaveLength(1)

    await expectSessionReadable(createServerCookieStore(legacyCookies(json)))
  })

  it('E-2: 2 つに分割された JSON の Cookie (.0 / .1) も読む', async () => {
    const json = sessionJson({ filler: 'x'.repeat(MAX_CHUNK_SIZE) })
    const initial = legacyCookies(json)
    expect(Object.keys(initial)).toEqual([`${STORAGE_KEY}.0`, `${STORAGE_KEY}.1`])

    await expectSessionReadable(createServerCookieStore(initial))
  })

  it('E-3: base64url で書かれた base64- の Cookie も読む (あとで base64url へ切り替えたときの読み)', async () => {
    const encoded = BASE64_PREFIX + Buffer.from(sessionJson(), 'utf8').toString('base64url')

    await expectSessionReadable(createServerCookieStore({ [STORAGE_KEY]: encoded }))
  })
})

describe('ssr 0.12 の Cookie の書き (旧バンドル・ロールバックした旧サーバーが読める JSON のまま)', () => {
  it('E-4: SUPABASE_COOKIE_ENCODING (raw) でセッションを書くと、値は base64- で始まらず、つないで JSON.parse できる。1 つに収まるときは古い分割 (.0 / .1) を同じ setAll で maxAge 0 にする', async () => {
    const store = createServerCookieStore(legacyCookies(sessionJson({ filler: 'x'.repeat(MAX_CHUNK_SIZE) })))
    const client = createServerClientFor(store)
    const newAccessToken = futureJwt()

    const { error } = await client.auth.setSession({ access_token: newAccessToken, refresh_token: REFRESHED_REFRESH_TOKEN })
    expect(error).toBeNull()
    await vi.waitFor(() => expect(store.writes.length).toBeGreaterThan(0))

    const written = store.writes.find((entry) => entry.name === STORAGE_KEY)
    expect(written).toBeDefined()
    expect(written?.value.startsWith(BASE64_PREFIX)).toBe(false)
    expect(readLikeLegacyReader(store.jar).access_token).toBe(newAccessToken)
    // 古い分割は消える (maxAge 0・空の値)
    for (const staleName of [`${STORAGE_KEY}.0`, `${STORAGE_KEY}.1`]) {
      const removal = store.writes.find((entry) => entry.name === staleName)
      expect(removal?.options.maxAge).toBe(0)
      expect(removal?.value).toBe('')
      expect(store.jar.has(staleName)).toBe(false)
    }
    // Cookie を書いた応答を共有キャッシュに置かせないヘッダーが、最初の書き込みで渡る
    expect(store.headersSeen[0]?.['Cache-Control']).toContain('no-store')
  })

  it('E-5: createBrowserClient (cookieEncoding だけを渡す) は document.cookie の JSON の Cookie を読み、更新のあとも JSON のまま書く (seedBorrowedSession の形)', async () => {
    // 読み: 更新の要らない残りの JSON の Cookie
    seedBorrowedSession(SESSION_VALID_FOR_SECONDS)
    const readerClient = createBrowserClientFor(createFakeSupabaseFetch())
    browserClients.push(readerClient)
    const { data: readData } = await readerClient.auth.getSession()
    expect(readData.session?.access_token).toBe(BORROWED_ACCESS_TOKEN)
    await readerClient.auth.stopAutoRefresh()
    clearAllCookies()

    // 書き: getSession() が更新を試みる残りで、更新が成功する
    seedBorrowedSession(NEARLY_EXPIRED_SECONDS, 'RT-old')
    const refreshingClient = createBrowserClientFor(createPkceExchangeFetch().fn)
    browserClients.push(refreshingClient)
    const { data: refreshedData } = await refreshingClient.auth.getSession()
    expect(refreshedData.session?.refresh_token).toBe(REFRESHED_REFRESH_TOKEN)

    const stored = documentCookies().get(STORAGE_KEY)
    expect(stored).toBeDefined()
    expect(stored?.startsWith(BASE64_PREFIX)).toBe(false)
    expect((JSON.parse(stored as string) as { refresh_token: string }).refresh_token).toBe(REFRESHED_REFRESH_TOKEN)
    expect(ssrWarnings()).toEqual([])
  })
})

describe('更新をまたぐ PKCE の verifier (S-21・閉包 W-7・W-8)', () => {
  it.each([
    { flow: 'Google ログイン', stored: LEGACY_CODE_VERIFIER, event: 'SIGNED_IN' },
    { flow: 'パスワードの再設定', stored: LEGACY_CODE_VERIFIER + RECOVERY_SUFFIX, event: 'PASSWORD_RECOVERY' },
  ])(
    'E-6: [$flow] 更新の前に書かれた従来の verifier の Cookie を、更新の後のコールバックの route と同じ createServerClient の exchangeCodeForSession(code) (flow id 無し) が読み、その verifier で交換し、セッションを JSON の Cookie に書き、従来の verifier の Cookie を maxAge 0 で消す',
    async ({ stored, event }) => {
      // 2.105.3 の setItemAsync が JSON.stringify して書いた形
      const store = createServerCookieStore({ [LEGACY_VERIFIER_KEY]: JSON.stringify(stored) })
      const { fn, codeVerifiers } = createPkceExchangeFetch()
      const client = createServerClientFor(store, fn)
      const events: string[] = []
      client.auth.onAuthStateChange((authEvent) => {
        events.push(authEvent)
      })

      const { data, error } = await client.auth.exchangeCodeForSession(AUTH_CODE)
      await vi.waitFor(() => expect(store.writes.length).toBeGreaterThan(0))

      expect(error).toBeNull()
      expect(data.session).not.toBeNull()
      // 交換に渡る verifier は印 (/recovery) を除いた本体
      expect(codeVerifiers).toEqual([LEGACY_CODE_VERIFIER])
      expect(events).toContain(event)
      const sessionCookie = store.writes.find((entry) => entry.name === STORAGE_KEY)
      expect(sessionCookie?.value.startsWith(BASE64_PREFIX)).toBe(false)
      expect((JSON.parse(sessionCookie?.value as string) as { refresh_token: string }).refresh_token).toBe(REFRESHED_REFRESH_TOKEN)
      const verifierRemoval = store.writes.find((entry) => entry.name === LEGACY_VERIFIER_KEY)
      expect(verifierRemoval?.options.maxAge).toBe(0)
      expect(store.jar.has(LEGACY_VERIFIER_KEY)).toBe(false)
    },
  )

  it('E-7: 更新の後に始めた flow (createBrowserClient の signInWithOAuth) は、flow ごとの Cookie と一覧の Cookie に加えて従来のキーにも同じ verifier を書き、flow id を渡さないコールバック (createServerClient の exchangeCodeForSession(code)) が従来のキーからその verifier を読んで交換する', async () => {
    const browserClient = createBrowserClientFor(createFakeSupabaseFetch())
    browserClients.push(browserClient)
    const { error: startError } = await browserClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_CALLBACK_URL, skipBrowserRedirect: true },
    })
    expect(startError).toBeNull()

    const cookies = documentCookies()
    const flowIds = JSON.parse(cookies.get(FLOWS_INDEX_KEY) as string) as string[]
    expect(flowIds).toHaveLength(1)
    const slotValue = cookies.get(`${STORAGE_KEY}-flow-${flowIds[0]}-code-verifier`)
    const legacyValue = cookies.get(LEGACY_VERIFIER_KEY)
    expect(legacyValue).toBeDefined()
    expect(slotValue).toBe(legacyValue)

    // ブラウザで始めた flow の Cookie が、コールバックの要求にそのまま届く
    const store = createServerCookieStore(Object.fromEntries(cookies))
    const { fn, codeVerifiers } = createPkceExchangeFetch()
    const serverClient = createServerClientFor(store, fn)
    const { data, error } = await serverClient.auth.exchangeCodeForSession(AUTH_CODE)

    expect(error).toBeNull()
    expect(data.session).not.toBeNull()
    expect(codeVerifiers).toEqual([JSON.parse(legacyValue as string)])
  })
})
