/**
 * src/lib/native-auth-bridge.ts のテスト (#1038 F7-04 / F7-05)
 *
 * モバイルアプリの WebView の中で動いているときだけ、window.ReactNativeWebView 経由でネイティブに
 * { type: 'sign-out' } / { type: 'session-expired' } を送る。普通のブラウザでは何もしない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_EXPIRED_MIN_INTERVAL_MS,
  isInNativeWebView,
  notifyNativeSessionExpired,
  notifyNativeSignOut,
  resetNativeAuthBridgeForTests,
} from '@/lib/native-auth-bridge'

type WindowWithBridge = Window & { ReactNativeWebView?: unknown }

function installBridge(postMessage = vi.fn()) {
  ;(window as WindowWithBridge).ReactNativeWebView = { postMessage }
  return postMessage
}

beforeEach(() => {
  resetNativeAuthBridgeForTests()
  delete (window as WindowWithBridge).ReactNativeWebView
})

afterEach(() => {
  delete (window as WindowWithBridge).ReactNativeWebView
})

describe('isInNativeWebView', () => {
  it('window.ReactNativeWebView が無い (普通のブラウザ) なら false', () => {
    expect(isInNativeWebView()).toBe(false)
  })

  it('postMessage 関数を持つ window.ReactNativeWebView があれば true', () => {
    installBridge()
    expect(isInNativeWebView()).toBe(true)
  })

  it('postMessage が関数でないものは WebView とみなさない', () => {
    ;(window as WindowWithBridge).ReactNativeWebView = { postMessage: 'not-a-function' }
    expect(isInNativeWebView()).toBe(false)
  })
})

describe('notifyNativeSignOut', () => {
  it('{ type: "sign-out" } を JSON 文字列でネイティブに送る', () => {
    const postMessage = installBridge()

    expect(notifyNativeSignOut()).toBe(true)

    expect(postMessage).toHaveBeenCalledTimes(1)
    const sent = postMessage.mock.calls[0][0]
    expect(typeof sent).toBe('string')
    expect(JSON.parse(sent)).toEqual({ type: 'sign-out' })
  })

  it('普通のブラウザでは何も送らず false', () => {
    expect(notifyNativeSignOut()).toBe(false)
  })

  it('postMessage が例外を投げても、呼び出し側 (ログアウト処理) を止めない', () => {
    installBridge(
      vi.fn(() => {
        throw new Error('webview is gone')
      }),
    )

    expect(() => notifyNativeSignOut()).not.toThrow()
    expect(notifyNativeSignOut()).toBe(false)
  })
})

describe('notifyNativeSessionExpired', () => {
  it('{ type: "session-expired" } を JSON 文字列でネイティブに送る', () => {
    const postMessage = installBridge()

    expect(notifyNativeSessionExpired(1_000_000)).toBe(true)

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ type: 'session-expired' })
  })

  it('普通のブラウザでは何も送らず false', () => {
    expect(notifyNativeSessionExpired()).toBe(false)
  })

  it('続けて送らない: 最小間隔の間は 2 回目以降を送らず、間隔が過ぎたら送る', () => {
    const postMessage = installBridge()
    const t0 = 5_000_000

    expect(notifyNativeSessionExpired(t0)).toBe(true)
    expect(notifyNativeSessionExpired(t0 + 1)).toBe(false)
    expect(notifyNativeSessionExpired(t0 + SESSION_EXPIRED_MIN_INTERVAL_MS - 1)).toBe(false)
    expect(postMessage).toHaveBeenCalledTimes(1)

    expect(notifyNativeSessionExpired(t0 + SESSION_EXPIRED_MIN_INTERVAL_MS)).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(2)
  })

  it('ログアウトを知らせた後は送らない (ログアウトしたのに、再ブリッジを頼んでしまわない)', () => {
    const postMessage = installBridge()

    notifyNativeSignOut()
    expect(notifyNativeSessionExpired(9_000_000)).toBe(false)

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ type: 'sign-out' })
  })

  it('送信に失敗しても例外にしない', () => {
    installBridge(
      vi.fn(() => {
        throw new Error('boom')
      }),
    )

    expect(() => notifyNativeSessionExpired(1_000_000)).not.toThrow()
  })
})
