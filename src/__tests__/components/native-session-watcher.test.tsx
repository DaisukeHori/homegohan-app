/**
 * src/components/native-app/NativeSessionWatcher.tsx のテスト (#1038 F7-05)
 *
 * モバイルアプリの WebView の中で、Web 側のセッションの寿命を見張り、切れる前にネイティブへ
 * { type: 'session-expired' } を送って再ブリッジを頼む。
 * Web 側のセッションは refresh_token を持たず自分では更新できないので (native-bridge)、この通知が更新の代わりになる。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSession = vi.fn()
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession } }),
}))

import {
  NativeSessionWatcher,
  REFRESH_AHEAD_SECONDS,
  SESSION_CHECK_INTERVAL_MS,
} from '@/components/native-app/NativeSessionWatcher'
import { NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER, resetNativeAuthBridgeForTests } from '@/lib/native-auth-bridge'

// React に「テスト環境 (act で包む)」であることを伝える
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type WindowWithBridge = Window & { ReactNativeWebView?: unknown }

let container: HTMLDivElement
let root: Root
let postMessage: ReturnType<typeof vi.fn>

const nowSeconds = () => Math.floor(Date.now() / 1000)
/** ネイティブから借りたセッション (refresh_token が使えない値) で、あと seconds 秒で切れる */
const sessionExpiringIn = (seconds: number, refreshToken: string = NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER) => ({
  data: { session: { expires_at: nowSeconds() + seconds, access_token: 'a', refresh_token: refreshToken } },
  error: null,
})

async function mount() {
  await act(async () => {
    root.render(<NativeSessionWatcher />)
  })
}

/** タイマーを進め、その中で起きる非同期処理 (getSession の解決など) も流す */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const sentTypes = () => postMessage.mock.calls.map(([message]) => JSON.parse(message as string).type)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-08T00:00:00Z'))
  resetNativeAuthBridgeForTests()
  getSession.mockReset()
  getSession.mockResolvedValue(sessionExpiringIn(3600))
  postMessage = vi.fn()
  ;(window as WindowWithBridge).ReactNativeWebView = { postMessage }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  delete (window as WindowWithBridge).ReactNativeWebView
  vi.useRealTimers()
})

describe('NativeSessionWatcher', () => {
  it('普通のブラウザ (window.ReactNativeWebView が無い) では、セッションを確かめもしない', async () => {
    delete (window as WindowWithBridge).ReactNativeWebView

    await mount()
    await advance(SESSION_CHECK_INTERVAL_MS * 3)

    expect(getSession).not.toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('セッションの有効期限に余裕があれば、何も送らない (表示直後と、一定間隔ごとに確かめる)', async () => {
    await mount()
    expect(getSession).toHaveBeenCalledTimes(1)

    await advance(SESSION_CHECK_INTERVAL_MS)
    expect(getSession).toHaveBeenCalledTimes(2)

    expect(postMessage).not.toHaveBeenCalled()
  })

  it('有効期限までの残りが閾値を切ったら、ネイティブに session-expired を送る', async () => {
    getSession.mockResolvedValue(sessionExpiringIn(REFRESH_AHEAD_SECONDS - 5))

    await mount()

    expect(sentTypes()).toEqual(['session-expired'])
  })

  it('残りがちょうど閾値より長ければ送らない', async () => {
    getSession.mockResolvedValue(sessionExpiringIn(REFRESH_AHEAD_SECONDS + 30))

    await mount()

    expect(postMessage).not.toHaveBeenCalled()
  })

  it('時間が経って残りが閾値を切ったら、そのとき初めて送る', async () => {
    // 最初は 300 秒の余裕がある。1 回の確認ごとに時間が進むので、いずれ閾値を切る
    let remaining = 300
    getSession.mockImplementation(async () => sessionExpiringIn(remaining))

    await mount()
    expect(postMessage).not.toHaveBeenCalled()

    remaining = REFRESH_AHEAD_SECONDS - 10
    await advance(SESSION_CHECK_INTERVAL_MS)

    expect(sentTypes()).toEqual(['session-expired'])
  })

  it('実際の refresh_token を持つセッション (Web が自分で更新できる) は、期限が近くても何も送らない', async () => {
    // 旧アプリの bridge、または Web のログイン画面で普通にログインした場合。読み込み直させる必要がない
    getSession.mockResolvedValue(sessionExpiringIn(10, 'real-refresh-token-abcdef'))

    await mount()
    await advance(SESSION_CHECK_INTERVAL_MS)

    expect(postMessage).not.toHaveBeenCalled()
  })

  it('Web 側のセッションが既に無ければ (Cookie が消えた)、送る', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null })

    await mount()

    expect(sentTypes()).toEqual(['session-expired'])
  })

  it('通信エラー (AuthRetryableFetchError) で状態が分からないときは、「切れた」と誤判定して読み込み直させない', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: Object.assign(new Error('Network request failed'), { name: 'AuthRetryableFetchError' }),
    })

    await mount()

    expect(postMessage).not.toHaveBeenCalled()
  })

  it('失効を示すエラー (refresh_token_not_found) で session: null のときは、送る', async () => {
    getSession.mockResolvedValue({
      data: { session: null },
      error: Object.assign(new Error('Invalid Refresh Token'), { name: 'AuthApiError' }),
    })

    await mount()

    expect(sentTypes()).toEqual(['session-expired'])
  })

  it('getSession が例外を投げても、何も送らず、見張りも止めない', async () => {
    getSession.mockRejectedValueOnce(new Error('boom'))

    await mount()
    expect(postMessage).not.toHaveBeenCalled()

    getSession.mockResolvedValue(sessionExpiringIn(10))
    await advance(SESSION_CHECK_INTERVAL_MS)
    expect(sentTypes()).toEqual(['session-expired'])
  })

  it('期限切れが続いても、ネイティブには続けて送らない (最小間隔を空ける)。間隔が過ぎたらまた送る', async () => {
    getSession.mockResolvedValue(sessionExpiringIn(10))

    await mount() // 表示直後に 1 回送る
    expect(sentTypes()).toEqual(['session-expired'])

    // 1 秒後にアプリが前面に戻って確認が走っても、最小間隔の内なので送らない
    await advance(1000)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(getSession).toHaveBeenCalledTimes(2)
    expect(sentTypes()).toEqual(['session-expired'])

    // 定期確認 (20 秒ごと) が最小間隔 (15 秒) を過ぎてから走れば、また送る
    await advance(SESSION_CHECK_INTERVAL_MS)
    expect(sentTypes()).toEqual(['session-expired', 'session-expired'])
  })

  it('アプリが前面に戻ったとき (visibilitychange → visible) は、次の定期確認を待たずにすぐ確かめる', async () => {
    await mount()
    expect(getSession).toHaveBeenCalledTimes(1)

    getSession.mockResolvedValue(sessionExpiringIn(5))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(getSession).toHaveBeenCalledTimes(2)
    expect(sentTypes()).toEqual(['session-expired'])
  })

  it('背面に回ったとき (hidden) は確かめない', async () => {
    await mount()
    expect(getSession).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(getSession).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  it('アンマウントしたら、定期確認も visibilitychange も止める', async () => {
    await mount()
    expect(getSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.unmount()
    })
    // afterEach の unmount と二重にならないよう、新しい root に差し替えておく
    root = createRoot(container)

    await advance(SESSION_CHECK_INTERVAL_MS * 3)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it('ログアウトをネイティブに知らせた後は、セッションが無くても session-expired を送らない', async () => {
    const { notifyNativeSignOut } = await import('@/lib/native-auth-bridge')
    getSession.mockResolvedValue({ data: { session: null }, error: null })

    notifyNativeSignOut()
    await mount()

    expect(sentTypes()).toEqual(['sign-out'])
  })
})
