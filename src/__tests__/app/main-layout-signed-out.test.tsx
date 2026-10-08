/**
 * 認証が必要なページの共通レイアウト (src/app/(main)/MainLayout.tsx) が、auth-js の SIGNED_OUT をどう扱うかのテスト (#1038 F7-05)
 *
 * モバイルアプリの WebView の Web 側は、ネイティブから借りたセッション (Cookie) で動く。その refresh_token は
 * 更新に使えない値 (NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER) なので、ブラウザの supabase-js (auth-js) が
 * 更新を試みると /token が 400 を返し、auth-js はセッションを捨てて SIGNED_OUT を出す。
 * 更新を試みるのは次の 2 つで、どちらも「切れる前にネイティブへ頼む」だけでは避けきれない。
 *   - 自動更新の tick (30 秒ごと)。残りが 120 秒を切ると更新する
 *   - getSession() (Supabase への API 呼び出しのたびに走る)・バックグラウンドからの復帰 (visibilitychange)。残り 90 秒未満なら更新する。
 *     バックグラウンドの間はタイマーも止まるので、1 時間以上置いて戻ったときは必ずここに来る
 * この SIGNED_OUT を「利用者のログアウト」として扱うと、ログアウトしていないのに user-scoped の localStorage
 * (v4MenuGenerating など、リロード後に進行中の生成を復元する値) が消え、/login が一瞬出てしまう。
 * WebView の中では「借り物のセッションを失った」ものとして、ネイティブに再ブリッジを頼む。
 *
 * auth-js (GoTrueClient) は本物を使い、fetch だけを差し替える (src/__tests__/helpers/real-auth-js.ts)。auth-js をモックすると、
 * 更新の失敗から SIGNED_OUT が出るまでの本物の動きを確かめられない (watcher のテストは getSession をモックしている)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  clearAllCookies,
  createFakeSupabaseFetch,
  createRealBrowserClient,
  fakeJwt,
  refreshRequests,
  seedBorrowedSession,
} from '../helpers/real-auth-js'

vi.mock('next/navigation', () => ({
  usePathname: () => '/home',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('framer-motion', () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    motion: new Proxy({}, { get: () => passthrough }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  }
})
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }))
vi.mock('@/components/AIChatBubble', () => ({ default: () => null }))
vi.mock('@/components/native-app/NativeAppTabRouter', () => ({ NativeAppTabRouter: () => null }))
// 見張りは別のテスト (native-session-watcher.test.tsx) で確かめる。ここでは MainLayout の SIGNED_OUT の扱いだけを見る
vi.mock('@/components/native-app/NativeSessionWatcher', () => ({ NativeSessionWatcher: () => null }))

// MainLayout が使うクライアントは、本物の auth-js を載せたブラウザ用クライアント (テストごとに作る)
let supabaseClient: ReturnType<typeof createRealBrowserClient>
vi.mock('@/lib/supabase/client', () => ({ createClient: () => supabaseClient }))

const { default: MainLayout } = await import('@/app/(main)/MainLayout')
import {
  NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER,
  NATIVE_REBRIDGE_WAIT_MS,
  resetNativeAuthBridgeForTests,
} from '@/lib/native-auth-bridge'
import { broadcastSignOut, clearUserScopedLocalStorage } from '@/lib/user-storage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type WindowWithBridge = Window & { ReactNativeWebView?: unknown }

/** MainLayout が SIGNED_OUT で消す、user-scoped のキー (src/lib/user-storage.ts の USER_SCOPED_KEYS と同じ) */
const USER_SCOPED_ITEMS: Record<string, string> = {
  v4_range_days: '14',
  v4_include_existing: 'true',
  v4MenuGenerating: '{"startedAt":1790000000000}',
  weeklyMenuGenerating: '1',
  singleMealGenerating: '1',
  shoppingListRegenerating: '1',
  profile_reminder_dismissed: '1',
}

const originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
let hrefSetter: Mock<(href: string) => void>

/** window.location.href への代入 (= ページ遷移) を記録する。jsdom は実際には遷移しない */
function stubLocation() {
  hrefSetter = vi.fn<(href: string) => void>()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return 'http://localhost:3000/home'
      },
      set href(value: string) {
        hrefSetter(value)
      },
      origin: 'http://localhost:3000',
      protocol: 'http:',
      host: 'localhost:3000',
      hostname: 'localhost',
      pathname: '/home',
      search: '',
      hash: '',
    },
  })
}

let container: HTMLDivElement
let root: Root
let fakeFetch: ReturnType<typeof createFakeSupabaseFetch>
let postMessage: ReturnType<typeof vi.fn>

async function mountLayout() {
  await act(async () => {
    root.render(
      <MainLayout initialIsNativeApp>
        <p>page body</p>
      </MainLayout>,
    )
  })
}

/** タイマーを進め、その中で起きる非同期処理 (fetch の解決、auth-js の更新、SIGNED_OUT の通知) も流す */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const sentTypes = () => postMessage.mock.calls.map(([message]) => JSON.parse(message as string).type)
const remainingKeys = () => Object.keys(USER_SCOPED_ITEMS).filter((key) => localStorage.getItem(key) !== null)

function enterNativeWebView() {
  ;(window as WindowWithBridge).ReactNativeWebView = { postMessage }
}

beforeEach(() => {
  // 想定どおりに出るログだけを黙らせる (ほかは通す)
  //   - テストごとに auth-js のクライアントを作り直すので出る警告 (同じ保存キーのクライアントが複数ある)
  //   - 借り物の refresh_token での更新が 400 になったときに auth-js が出すエラー
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
  resetNativeAuthBridgeForTests()
  clearAllCookies()
  localStorage.clear()
  for (const [key, value] of Object.entries(USER_SCOPED_ITEMS)) localStorage.setItem(key, value)
  stubLocation()
  postMessage = vi.fn()
  delete (window as WindowWithBridge).ReactNativeWebView
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  fakeFetch = createFakeSupabaseFetch()
  supabaseClient = createRealBrowserClient(fakeFetch)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  await supabaseClient.auth.stopAutoRefresh()
  delete (window as WindowWithBridge).ReactNativeWebView
  if (originalLocation) Object.defineProperty(window, 'location', originalLocation)
  clearAllCookies()
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MainLayout — モバイルアプリの WebView で auth-js が SIGNED_OUT を出したとき (#1038 F7-05)', () => {
  // 残り 100 秒: 自動更新の tick (120 秒未満) だけが更新を試みる区間。残り 60 秒: getSession() も更新を試みる区間
  it.each([100, 60])(
    '借り物のセッション (残り %i 秒) の更新に auth-js が失敗しても、ログアウト扱いにしない: user-scoped のキーが残り、/login へ移らず、session-expired を送る',
    async (remainingSeconds) => {
      enterNativeWebView()
      seedBorrowedSession(remainingSeconds)

      await mountLayout()
      await advance(1_000) // 自動更新の tick (表示直後に 1 回走る) や getUser() が、更新を試みる

      // 前提: auth-js が本当に借り物の refresh_token で更新を試みて失敗し、セッションを捨てている (= SIGNED_OUT が出ている)
      expect(refreshRequests(fakeFetch).length).toBeGreaterThanOrEqual(1)
      const { data } = await supabaseClient.auth.getSession()
      expect(data.session).toBeNull()

      expect(sentTypes()).toEqual(['session-expired'])
      expect(remainingKeys()).toEqual(Object.keys(USER_SCOPED_ITEMS))
      expect(hrefSetter).not.toHaveBeenCalled()
    },
  )

  it('ネイティブが読み込み直してくれないまま待ち時間を過ぎたら (古いアプリ・再ブリッジが止められたとき)、従来どおりログアウトとして /login へ移し、user-scoped のキーを消す', async () => {
    enterNativeWebView()
    seedBorrowedSession(60)

    await mountLayout()
    await advance(1_000)
    expect(sentTypes()).toEqual(['session-expired'])
    expect(hrefSetter).not.toHaveBeenCalled()

    await advance(NATIVE_REBRIDGE_WAIT_MS - 1_000 - 1)
    expect(hrefSetter).not.toHaveBeenCalled()
    expect(remainingKeys()).toEqual(Object.keys(USER_SCOPED_ITEMS))

    await advance(1)
    expect(hrefSetter).toHaveBeenCalledWith('/login')
    expect(remainingKeys()).toEqual([])
  })

  it('待ち時間の途中でこのレイアウトから離れた (ネイティブが読み込み直したなど) ときは、待ち時間が過ぎても何もしない', async () => {
    enterNativeWebView()
    seedBorrowedSession(60)

    await mountLayout()
    await advance(1_000)
    expect(sentTypes()).toEqual(['session-expired'])

    await act(async () => {
      root.unmount()
    })
    // afterEach の unmount と二重にならないよう、新しい root に差し替えておく
    root = createRoot(container)

    await advance(NATIVE_REBRIDGE_WAIT_MS * 2)
    expect(hrefSetter).not.toHaveBeenCalled()
    expect(remainingKeys()).toEqual(Object.keys(USER_SCOPED_ITEMS))
  })

  it('待っている間にセッションが戻ったとき (別のタブが先に再ブリッジされ、共有の Cookie が新しくなったなど) は、待ち時間が過ぎても何もしない', async () => {
    enterNativeWebView()
    seedBorrowedSession(60)

    await mountLayout()
    await advance(1_000)
    expect(sentTypes()).toEqual(['session-expired'])

    // 新しいセッションが入る (SIGNED_IN)
    await act(async () => {
      await supabaseClient.auth.setSession({
        access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER,
      })
    })
    await advance(NATIVE_REBRIDGE_WAIT_MS * 2)

    expect(hrefSetter).not.toHaveBeenCalled()
    expect(remainingKeys()).toEqual(Object.keys(USER_SCOPED_ITEMS))
  })

  it('利用者が Web でログアウトした場合 (設定・マイページなど): 最後に sign-out をネイティブに送る。/login への移動は従来どおり (自分のタブへの BroadcastChannel の通知)', async () => {
    enterNativeWebView()
    seedBorrowedSession(3000) // 更新が必要ない、普通に使えているセッション
    // 画面側のログアウト処理 (settings / mypage など) と同じ順番
    const logout = async () => {
      clearUserScopedLocalStorage()
      await supabaseClient.auth.signOut()
      broadcastSignOut()
    }

    await mountLayout()
    await advance(1_000)
    await act(async () => {
      await logout()
    })
    // signOut() が出す SIGNED_OUT の分の session-expired も先に届くが、ネイティブは自分のセッションをサーバーで確かめ、
    // 失効していれば (Web のログアウトは全端末のセッションを失効させる) sign-out と同じログアウトに揃える
    expect(sentTypes().at(-1)).toBe('sign-out')
    expect(remainingKeys()).toEqual([]) // 各画面の処理が消している

    // broadcastSignOut() は自分のタブの MainLayout にも届き、従来どおりログイン画面へ移す
    await vi.waitFor(() => expect(hrefSetter).toHaveBeenCalledWith('/login'))

    // ページが移ったあとはこのレイアウトが無い。再ブリッジの待ち時間が過ぎても、二重に移したりしない
    await act(async () => {
      root.unmount()
    })
    root = createRoot(container)
    await advance(NATIVE_REBRIDGE_WAIT_MS * 2)
    expect(hrefSetter).toHaveBeenCalledTimes(1)
  })
})

describe('MainLayout — ふつうのブラウザで SIGNED_OUT になったとき (従来どおり)', () => {
  it('すぐに user-scoped のキーを消して /login へ移る。ネイティブへは何も送らない', async () => {
    // ReactNativeWebView が無い = ふつうのブラウザ。実際の refresh_token を持つ利用者が別のタブでログアウトした、など
    seedBorrowedSession(60)

    await mountLayout()
    await advance(1_000)

    expect(refreshRequests(fakeFetch).length).toBeGreaterThanOrEqual(1)
    expect(hrefSetter).toHaveBeenCalledWith('/login')
    expect(remainingKeys()).toEqual([])
    expect(postMessage).not.toHaveBeenCalled()
  })
})
