/**
 * NativeSessionWatcher の閾値と、auth-js (ブラウザの supabase-js) が更新を試みる閾値の関係のテスト (#1038 F7-05)
 *
 * モバイルアプリの WebView の Web 側は、ネイティブから借りたセッションで動く。その refresh_token は更新に使えない値なので、
 * auth-js が更新を試みると必ず失敗して、セッションが捨てられる (SIGNED_OUT)。
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
} from '@supabase/auth-js/dist/main/lib/constants'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { REFRESH_AHEAD_SECONDS, SESSION_CHECK_INTERVAL_MS } from '@/components/native-app/NativeSessionWatcher'
import {
  clearAllCookies,
  createFakeSupabaseFetch,
  createRealBrowserClient,
  refreshRequests,
  seedBorrowedSession,
} from '../helpers/real-auth-js'

/** auth-js の自動更新の tick が更新を試みる、有効期限までの残り (秒)。tick は floor(残り / 30 秒) <= THRESHOLD で更新する */
const TICK_REFRESHES_BELOW_SECONDS = ((AUTO_REFRESH_TICK_THRESHOLD + 1) * AUTO_REFRESH_TICK_DURATION_MS) / 1000
/** getSession() とバックグラウンドからの復帰が更新を試みる、有効期限までの残り (秒) */
const GET_SESSION_REFRESHES_BELOW_SECONDS = EXPIRY_MARGIN_MS / 1000
/** ネイティブの再ブリッジ (自分のセッションの確認 + コードの発行 + 読み込み) にかかる時間の見込み (秒) */
const REBRIDGE_LATENCY_BUDGET_SECONDS = 30

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
