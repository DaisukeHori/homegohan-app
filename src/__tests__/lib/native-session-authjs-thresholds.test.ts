/**
 * NativeSessionWatcher の閾値と、auth-js (ブラウザの supabase-js) が更新を試みる閾値の関係のテスト (#1038 F7-05)
 *
 * モバイルアプリの WebView の Web 側は、ネイティブから借りたセッションで動く。その refresh_token は更新に使えない値なので、
 * auth-js が更新を試みると必ず失敗する。auth-js 2.117 は、access token が有効なうちの失敗ではセッションを捨てず (失敗を 60 秒控える)、
 * 失効した後の失敗でセッションを捨てる (SIGNED_OUT)。
 * 前面で使っているときは、auth-js が更新を試みるより先に、NativeSessionWatcher がネイティブへ再ブリッジを頼む必要がある。
 * 以前の閾値 (120 秒) は auth-js の自動更新の tick と同じで、tick が先に走ると (およそ 3 回に 1 回) 失敗していた。
 *
 * auth-js の閾値は、コメントに書いた数字ではなく、インストールされている auth-js の定数と本物の GoTrueClient の動きで確かめる
 * (auth-js を上げて閾値が変わったら、このテストが落ちて気づける)。
 */
import {
  AUTO_REFRESH_TICK_DURATION_MS,
  AUTO_REFRESH_TICK_THRESHOLD,
  EXPIRY_MARGIN_MS,
  REFRESH_FAILURE_COOLDOWN_MS,
} from '@supabase/auth-js/dist/main/lib/constants'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { REFRESH_AHEAD_SECONDS, SESSION_CHECK_INTERVAL_MS } from '@/components/native-app/NativeSessionWatcher'
import {
  ALREADY_EXPIRED_REMAINING_SECONDS,
  BORROWED_ACCESS_TOKEN,
  clearAllCookies,
  createFakeSupabaseFetch,
  createRealBrowserClient,
  fakeJwt,
  type FakeSupabaseFetch,
  refreshRequests,
  seedBorrowedSession,
  SIGNED_OUT_AFTER_EXPIRY_MAX_MS,
  STORAGE_KEY,
} from '../helpers/real-auth-js'

/** auth-js の自動更新の tick が更新を試みる、有効期限までの残り (秒)。tick は floor(残り / 30 秒) <= THRESHOLD で更新する */
const TICK_REFRESHES_BELOW_SECONDS = ((AUTO_REFRESH_TICK_THRESHOLD + 1) * AUTO_REFRESH_TICK_DURATION_MS) / 1000
/** getSession() とバックグラウンドからの復帰が更新を試みる、有効期限までの残り (秒) */
const GET_SESSION_REFRESHES_BELOW_SECONDS = EXPIRY_MARGIN_MS / 1000
/** ネイティブの再ブリッジ (自分のセッションの確認 + コードの発行 + 読み込み) にかかる時間の見込み (秒) */
const REBRIDGE_LATENCY_BUDGET_SECONDS = 30

/** 本文が JSON でない 5xx (auth-js の handleError が AuthRetryableFetchError にする状態) */
const TRANSIENT_GATEWAY_STATUS = 503
const TRANSIENT_GATEWAY_BODY = 'upstream error'
/** tick (残り 120 秒未満) も getSession() (残り 90 秒未満) も更新を試みない残り (秒)。main-layout-signed-out の A-5〜A-7 の種と同じ */
const LONG_REMAINING_SECONDS = 3_000
const MS_PER_SECOND = 1_000
/** 失効前の更新の失敗の控えを確かめるため、更新を試みる残りの種 */
const REFRESH_ATTEMPT_REMAINING_SECONDS = [100, 60]

let fakeFetch: ReturnType<typeof createFakeSupabaseFetch>
let client: ReturnType<typeof createRealBrowserClient>

beforeEach(() => {
  const originalWarn = console.warn.bind(console)
  const originalError = console.error.bind(console)
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('Multiple GoTrueClient instances')) originalWarn(...args)
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('Invalid Refresh Token')) originalError(...args)
  })
  // setImmediate / queueMicrotask は偽物にしない (Response の本文の読み取りなどが使う)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(new Date('2026-10-08T00:00:00Z'))
  clearAllCookies()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  fakeFetch = createFakeSupabaseFetch()
})

afterEach(async () => {
  await client?.auth.stopAutoRefresh()
  clearAllCookies()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** セッションを置いてクライアントを作り、表示直後の自動更新の tick まで流す */
async function startClientWithSession(remainingSeconds: number) {
  seedBorrowedSession(remainingSeconds)
  client = createRealBrowserClient(fakeFetch)
  await vi.advanceTimersByTimeAsync(0)
}

describe('auth-js が更新を試みる閾値 (@supabase/auth-js の定数)', () => {
  it('自動更新の tick は残り 120 秒未満、getSession() は残り 90 秒未満で更新を試みる (NativeSessionWatcher のコメントの前提)', () => {
    expect(TICK_REFRESHES_BELOW_SECONDS).toBe(120)
    expect(GET_SESSION_REFRESHES_BELOW_SECONDS).toBe(90)
    expect(AUTO_REFRESH_TICK_DURATION_MS).toBe(30_000)
  })

  it.each([
    [119, true],
    [110, true],
    [95, true],
    [121, false],
    [130, false],
  ])('自動更新の tick: 残り %i 秒のセッションを更新しようとするか = %s', async (remainingSeconds, shouldRefresh) => {
    await startClientWithSession(remainingSeconds)

    expect(refreshRequests(fakeFetch).length > 0).toBe(shouldRefresh)
  })

  it.each([
    [89, true],
    [91, false],
  ])('getSession() (と、クライアント作成時の復帰処理): 残り %i 秒のセッションを更新しようとするか = %s', async (remainingSeconds, shouldRefresh) => {
    // タイマーは進めないので、自動更新の tick は走らない。getSession() と復帰処理の閾値 (EXPIRY_MARGIN_MS) だけを見る
    seedBorrowedSession(remainingSeconds)
    client = createRealBrowserClient(fakeFetch)
    await client.auth.getSession()

    expect(refreshRequests(fakeFetch).length > 0).toBe(shouldRefresh)
  })
})

describe('NativeSessionWatcher の閾値 (REFRESH_AHEAD_SECONDS)', () => {
  it('確認の間隔の分だけ遅れて気づき、再ブリッジに時間がかかっても、auth-js の自動更新の tick が更新を試みる残り時間より前に頼める', () => {
    const worstCaseRemainingWhenReloaded =
      REFRESH_AHEAD_SECONDS - SESSION_CHECK_INTERVAL_MS / 1000 - REBRIDGE_LATENCY_BUDGET_SECONDS

    expect(worstCaseRemainingWhenReloaded).toBeGreaterThan(TICK_REFRESHES_BELOW_SECONDS)
  })

  it('最悪のタイミングで気づいた (閾値 - 確認の間隔) 残りのセッションを、auth-js はまだ更新しようとしない', async () => {
    await startClientWithSession(REFRESH_AHEAD_SECONDS - SESSION_CHECK_INTERVAL_MS / 1000)

    expect(refreshRequests(fakeFetch)).toHaveLength(0)
    // 自動更新の tick が次に回っても (30 秒後)、残りはまだ 130 秒あり、更新しない
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_TICK_DURATION_MS)
    expect(refreshRequests(fakeFetch)).toHaveLength(0)
  })

  it('getSession() の閾値 (90 秒) よりも十分に大きい', () => {
    expect(REFRESH_AHEAD_SECONDS).toBeGreaterThan(GET_SESSION_REFRESHES_BELOW_SECONDS + SESSION_CHECK_INTERVAL_MS / 1000)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// auth-js 2.117 の更新の失敗の扱い (#1768。docs/design/mobile/05-auth-session.md §9.9 B)
// ---------------------------------------------------------------------------------------------------------------------

function requestUrl(input: RequestInfo | URL) {
  return String(input instanceof Request ? input.url : input)
}

/** createFakeSupabaseFetch と同じ型で、指定した URL の断片に当たる要求へ、本文が JSON でない応答を返す。ほかは createFakeSupabaseFetch に任せる */
function createFetchRespondingWith(respond: (url: string) => Response | null) {
  const base = createFakeSupabaseFetch()
  return vi.fn(async (input: RequestInfo | URL) => respond(requestUrl(input)) ?? base(input))
}

const transientGatewayResponse = () => new Response(TRANSIENT_GATEWAY_BODY, { status: TRANSIENT_GATEWAY_STATUS })

/** /token (refresh_token) だけがやり直せる失敗 (503) を返す */
function createTransientRefreshFailureFetch() {
  return createFetchRespondingWith((url) => (url.includes('/auth/v1/token?grant_type=refresh_token') ? transientGatewayResponse() : null))
}

/** /logout と /token (refresh_token) がやり直せる失敗 (503) を返す */
function createTransientSignOutFailureFetch() {
  return createFetchRespondingWith((url) =>
    url.includes('/auth/v1/logout') || url.includes('/auth/v1/token?grant_type=refresh_token') ? transientGatewayResponse() : null,
  )
}

/** /logout が本文の無い 204 を返す (/token は createFakeSupabaseFetch の 400) */
function createSignOutSuccessFetch() {
  return createFetchRespondingWith((url) => (url.includes('/auth/v1/logout') ? new Response(null, { status: 204 }) : null))
}

const logoutRequests = (fetchFn: FakeSupabaseFetch) =>
  fetchFn.mock.calls.map(([input]) => requestUrl(input)).filter((url) => url.includes('/auth/v1/logout'))

const hasSessionCookie = () => document.cookie.split('; ').some((pair) => pair.startsWith(`${STORAGE_KEY}=`))

/** auth-js の事象のうち SIGNED_OUT の数を数える */
function countSignedOut(auth: ReturnType<typeof createRealBrowserClient>['auth']) {
  const counter = { count: 0 }
  auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') counter.count += 1
  })
  return counter
}

describe('auth-js 2.117 の更新の失敗の扱い (借り物のセッション)', () => {
  it('B-1: 失敗の控えは 60 秒 (REFRESH_FAILURE_COOLDOWN_MS = 2 tick)', () => {
    expect(REFRESH_FAILURE_COOLDOWN_MS).toBe(2 * AUTO_REFRESH_TICK_DURATION_MS)
    expect(REFRESH_FAILURE_COOLDOWN_MS).toBe(60_000)
  })

  it('B-2: 先回りの更新 (残り 100 秒の tick) が失敗しても、セッションは残り (getSession が同じ access_token を返す)、SIGNED_OUT は出ない', async () => {
    seedBorrowedSession(100)
    client = createRealBrowserClient(fakeFetch)
    const signedOut = countSignedOut(client.auth)
    await vi.advanceTimersByTimeAsync(0)

    expect(refreshRequests(fakeFetch)).toHaveLength(1)
    const { data } = await client.auth.getSession()
    expect(data.session?.access_token).toBe(BORROWED_ACCESS_TOKEN)
    expect(signedOut.count).toBe(0)
  })

  it('B-3: 同じ refresh_token での更新の失敗は 60 秒控える: 控えの間の getSession() は /token を呼ばず、控えが切れた最初の契機で 1 回だけ呼び、また控える', async () => {
    // タイマーは進めない (既存の getSession() の it と同じ形)。クライアントの作成時の復帰処理が 1 回更新を試みて失敗する
    seedBorrowedSession(EXPIRY_MARGIN_MS / MS_PER_SECOND - 1)
    client = createRealBrowserClient(fakeFetch)
    const first = await client.auth.getSession()
    expect(first.data.session?.access_token).toBe(BORROWED_ACCESS_TOKEN)
    const attempts = refreshRequests(fakeFetch).length
    expect(attempts).toBeGreaterThanOrEqual(1)

    for (let call = 0; call < 3; call += 1) {
      const { data } = await client.auth.getSession()
      expect(data.session?.access_token).toBe(BORROWED_ACCESS_TOKEN)
    }
    expect(refreshRequests(fakeFetch)).toHaveLength(attempts) // 控えの間は /token を呼ばない

    // 控えが切れた最初の契機 (この間の tick は控えた失敗を受け取り、控えの切れ目の tick が実際に 1 回呼ぶ)
    await vi.advanceTimersByTimeAsync(REFRESH_FAILURE_COOLDOWN_MS)
    expect(refreshRequests(fakeFetch)).toHaveLength(attempts + 1)

    const { data: afterCooldown } = await client.auth.getSession()
    expect(afterCooldown.session?.access_token).toBe(BORROWED_ACCESS_TOKEN) // 残りは 29 秒でも失効前
    expect(refreshRequests(fakeFetch)).toHaveLength(attempts + 1) // 控えを張り直した
  })

  it.each(REFRESH_ATTEMPT_REMAINING_SECONDS)(
    'B-4: [残り %i 秒] access token が失効したあとの更新の失敗で、セッションを捨てて SIGNED_OUT を出す (失効から最大 90 秒)',
    async (remainingSeconds) => {
      await startClientWithSession(remainingSeconds)
      const signedOut = countSignedOut(client.auth)

      await vi.advanceTimersByTimeAsync(remainingSeconds * MS_PER_SECOND + SIGNED_OUT_AFTER_EXPIRY_MAX_MS)

      expect(signedOut.count).toBe(1)
      const { data } = await client.auth.getSession()
      expect(data.session).toBeNull()
      // 失効前の 1 回以上と、失効後の 1 回
      expect(refreshRequests(fakeFetch).length).toBeGreaterThanOrEqual(2)
    },
  )

  it('B-5: /token がやり直せる失敗 (503) のときは、access token が失効していてもセッションを捨てず (Cookie は残る)、失敗を 60 秒控える: 控えの間の getSession() は /token を呼ばずに AuthRetryableFetchError を返し、控えが切れたあとの契機で 1 回呼ぶ', async () => {
    const transientFetch = createTransientRefreshFailureFetch()
    seedBorrowedSession(ALREADY_EXPIRED_REMAINING_SECONDS)
    client = createRealBrowserClient(transientFetch)
    const signedOut = countSignedOut(client.auth)
    const pending = client.auth.getSession()
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_TICK_DURATION_MS) // 初期化のやり直しを流しきる
    const first = await pending

    expect(first.data.session).toBeNull()
    expect(first.error?.name).toBe('AuthRetryableFetchError')
    const attempts = refreshRequests(transientFetch).length
    expect(attempts).toBeGreaterThanOrEqual(1)
    expect(hasSessionCookie()).toBe(true) // 捨てていない

    for (let call = 0; call < 3; call += 1) {
      const { error } = await client.auth.getSession()
      expect(error?.name).toBe('AuthRetryableFetchError')
    }
    expect(refreshRequests(transientFetch)).toHaveLength(attempts)

    // 控えが切れたあとの tick で実際に呼び、そのやり直しも流しきる
    await vi.advanceTimersByTimeAsync(REFRESH_FAILURE_COOLDOWN_MS + AUTO_REFRESH_TICK_DURATION_MS)
    expect(refreshRequests(transientFetch).length).toBeGreaterThan(attempts)
    expect(hasSessionCookie()).toBe(true)
    expect(signedOut.count).toBe(0)
  })

  it.each([
    {
      state: 'access token が有効',
      remainingSeconds: LONG_REMAINING_SECONDS,
      logoutCalls: 1,
      cookieKept: false,
      signedOutCount: 1,
      refreshCalls: 0,
      // 保管が空なので、続く getSession() は null を error なしで返す (規約の同意画面の afterSignOut が入口へ移らない入力。S-29)
      sessionErrorName: null,
      expectation: 'signOut() の /logout が 503 でも、保管を消して SIGNED_OUT を出し { error } を返す',
    },
    {
      state: '失効済みで /token も 503',
      remainingSeconds: ALREADY_EXPIRED_REMAINING_SECONDS,
      logoutCalls: 0,
      cookieKept: true,
      signedOutCount: 0,
      refreshCalls: null,
      // 控えた失敗が getSession() から返る (これも afterSignOut が入口へ移らない入力。S-29)
      sessionErrorName: 'AuthRetryableFetchError',
      expectation: 'signOut() は /logout を呼ばずに { error } を返し、保管は残り SIGNED_OUT も出ない',
    },
  ])('B-6: [$state] $expectation', async ({ remainingSeconds, logoutCalls, cookieKept, signedOutCount, refreshCalls, sessionErrorName }) => {
    // 前提: 有効の行は tick も getSession() も更新を試みない残り
    expect(LONG_REMAINING_SECONDS).toBeGreaterThan(TICK_REFRESHES_BELOW_SECONDS)
    const signOutFetch = createTransientSignOutFailureFetch()
    seedBorrowedSession(remainingSeconds)
    client = createRealBrowserClient(signOutFetch)
    const signedOut = countSignedOut(client.auth)

    const pending = client.auth.signOut()
    await vi.advanceTimersByTimeAsync(AUTO_REFRESH_TICK_DURATION_MS) // 失効済みの行で、初期化の更新のやり直しを流しきる
    const { error } = await pending

    expect(error?.name).toBe('AuthRetryableFetchError')
    expect(error?.status).toBe(TRANSIENT_GATEWAY_STATUS)
    expect(logoutRequests(signOutFetch)).toHaveLength(logoutCalls)
    expect(hasSessionCookie()).toBe(cookieKept)
    expect(signedOut.count).toBe(signedOutCount)
    if (refreshCalls !== null) {
      expect(refreshRequests(signOutFetch)).toHaveLength(refreshCalls)
    }
    // signOut() の後の getSession(): 有効な token の行は保管が空で null (error なし)、失効済みの行は控えた失敗
    const { data, error: sessionError } = await client.auth.getSession()
    expect(data.session).toBeNull()
    expect(sessionError?.name ?? null).toBe(sessionErrorName)
  })

  it.each([
    {
      state: '失効済みで /token が 400',
      seed: LONG_REMAINING_SECONDS,
      expireBeforeSignOut: true,
      scope: 'local' as const,
      logoutCalls: 0,
      refreshCalls: 1,
      cookieKept: false,
      signedOutCount: 1,
      errorName: 'AuthApiError',
      expectation: 'signOut() は更新が捨てて SIGNED_OUT を出し、/logout を呼ばずに { error } を返す',
    },
    {
      state: '保管なし',
      seed: null,
      expireBeforeSignOut: false,
      scope: 'local' as const,
      logoutCalls: 0,
      refreshCalls: 0,
      cookieKept: false,
      signedOutCount: 1,
      errorName: null,
      expectation: 'signOut() は GoTrue を呼ばずに SIGNED_OUT を出し { error: null } を返す',
    },
    {
      state: 'access token が有効・scope others',
      seed: LONG_REMAINING_SECONDS,
      expireBeforeSignOut: false,
      scope: 'others' as const,
      logoutCalls: 1,
      refreshCalls: 0,
      cookieKept: true,
      signedOutCount: 0,
      errorName: null,
      expectation: "signOut({ scope: 'others' }) は /logout (scope=others) を呼び、保管を残し SIGNED_OUT を出さず { error: null } を返す",
    },
    {
      state: '保管なし・scope others',
      seed: null,
      expireBeforeSignOut: false,
      scope: 'others' as const,
      logoutCalls: 0,
      refreshCalls: 0,
      cookieKept: false,
      signedOutCount: 0,
      errorName: null,
      expectation: '何もせず { error: null }・SIGNED_OUT 無し',
    },
  ])(
    'B-7: [$state] $expectation',
    async ({ seed, expireBeforeSignOut, scope, logoutCalls, refreshCalls, cookieKept, signedOutCount, errorName }) => {
      if (seed !== null) seedBorrowedSession(seed)
      const successFetch = createSignOutSuccessFetch()
      client = createRealBrowserClient(successFetch)
      const signedOut = countSignedOut(client.auth)
      await vi.advanceTimersByTimeAsync(MS_PER_SECOND) // 初期化を済ませる
      if (expireBeforeSignOut) {
        // tick を止め、signOut() 自身の更新だけが /token を呼ぶようにする。タイマーは進めず、時計だけを失効の後へ動かす
        // (失効済みの種で作ると初期化の更新が先に 400 で捨てて、signOut() が保管なしの行になるため)
        await client.auth.stopAutoRefresh()
        vi.setSystemTime(Date.now() + LONG_REMAINING_SECONDS * MS_PER_SECOND)
      }
      const refreshBefore = refreshRequests(successFetch).length
      const signedOutBefore = signedOut.count

      const { error } = await client.auth.signOut({ scope })

      expect(error?.name ?? null).toBe(errorName)
      const logouts = logoutRequests(successFetch)
      expect(logouts).toHaveLength(logoutCalls)
      for (const url of logouts) expect(url).toContain(`scope=${scope}`)
      expect(refreshRequests(successFetch).length - refreshBefore).toBe(refreshCalls)
      expect(hasSessionCookie()).toBe(cookieKept)
      expect(signedOut.count - signedOutBefore).toBe(signedOutCount)
    },
  )

  it('B-8: 期限切れの token を getClaims(token) に渡すと、投げずに { data: null, error: AuthInvalidJwtError } を返し、/user を呼ばない', async () => {
    client = createRealBrowserClient(fakeFetch)
    const expiredJwt = fakeJwt(Math.floor(Date.now() / MS_PER_SECOND) + ALREADY_EXPIRED_REMAINING_SECONDS)

    const result = await client.auth.getClaims(expiredJwt)

    expect(result.data).toBeNull()
    expect(result.error?.name).toBe('AuthInvalidJwtError')
    expect(fakeFetch.mock.calls.map(([input]) => requestUrl(input)).filter((url) => url.includes('/auth/v1/user'))).toEqual([])
  })
})
