/**
 * src/lib/native-auth-bridge.ts のテスト (#1038 F7-04 / F7-05)
 *
 * モバイルアプリの WebView の中で動いているときだけ、window.ReactNativeWebView 経由でネイティブに
 * { type: 'sign-out' } / { type: 'session-expired' } を送る。普通のブラウザでは何もしない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER,
  SESSION_EXPIRED_MIN_INTERVAL_MS,
  isInNativeWebView,
  isNativeBridgedSession,
  notifyNativeLegalConsentAccepted,
  notifyNativeSessionExpired,
  notifyNativeSignOut,
  requestNativeMfaVerify,
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

  it('このページでは二度目を送らない: signOut の前に呼んだあと、broadcastSignOut() がもう一度呼んでも、ネイティブへ二重に届けない', () => {
    const postMessage = installBridge()

    expect(notifyNativeSignOut()).toBe(true)
    expect(notifyNativeSignOut()).toBe(false)

    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('普通のブラウザで呼んでも、あとで WebView になる (テストでの差し替えなど) ときの送信を妨げない', () => {
    expect(notifyNativeSignOut()).toBe(false)
    const postMessage = installBridge()

    expect(notifyNativeSignOut()).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
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

// #1176 運営ロールの MFA: WebView の中の確認画面がネイティブの確認画面を頼む・借り物のセッションの判定 (docs/design/cross/12-operator-mfa.md §16.4.1・§21.7)
describe('requestNativeMfaVerify', () => {
  it('requestNativeMfaVerify: { type: "mfa-verify-required" } を JSON 文字列でネイティブに送り true / 普通のブラウザでは何も送らず false / postMessage が例外を投げても例外にしない', () => {
    expect(requestNativeMfaVerify()).toBe(false)

    const postMessage = installBridge()
    expect(requestNativeMfaVerify()).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
    const sent = postMessage.mock.calls[0][0]
    expect(typeof sent).toBe('string')
    expect(JSON.parse(sent)).toEqual({ type: 'mfa-verify-required' })

    // 回数は絞らない (利用者が押したときと描画の後の 1 回だけなので)
    expect(requestNativeMfaVerify()).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(2)

    installBridge(
      vi.fn(() => {
        throw new Error('bridge closed')
      }),
    )
    expect(() => requestNativeMfaVerify()).not.toThrow()
    expect(requestNativeMfaVerify()).toBe(false)
  })
})

// #1442 同意画面 (/legal-consent) が、同意を記録できたことをネイティブに知らせる (docs/design/cross/13b-legal-consent-mobile.md §6.6.16・T-W1)
describe('notifyNativeLegalConsentAccepted', () => {
  it('notifyNativeLegalConsentAccepted: { type: "legal-consent-accepted" } を JSON 文字列でネイティブに送り true / 普通のブラウザでは何も送らず false / postMessage が例外を投げても例外にしない', () => {
    expect(notifyNativeLegalConsentAccepted()).toBe(false)

    const postMessage = installBridge()
    expect(notifyNativeLegalConsentAccepted()).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(1)
    const sent = postMessage.mock.calls[0][0]
    expect(typeof sent).toBe('string')
    expect(JSON.parse(sent)).toEqual({ type: 'legal-consent-accepted' })

    // 回数は絞らない (記録できた 1 回だけ送るので)
    expect(notifyNativeLegalConsentAccepted()).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(2)

    installBridge(
      vi.fn(() => {
        throw new Error('bridge closed')
      }),
    )
    expect(() => notifyNativeLegalConsentAccepted()).not.toThrow()
    expect(notifyNativeLegalConsentAccepted()).toBe(false)
  })

  it('sign-out を送った後でも送る (ログアウト通知済みの印に左右されない)', () => {
    const postMessage = installBridge()
    expect(notifyNativeSignOut()).toBe(true)
    expect(notifyNativeLegalConsentAccepted()).toBe(true)
    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(JSON.parse(postMessage.mock.calls[1][0])).toEqual({ type: 'legal-consent-accepted' })
  })
})

describe('isNativeBridgedSession', () => {
  it('isNativeBridgedSession: refresh_token が NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER のときだけ true (実際の値・null・undefined・session が null は false)', () => {
    expect(isNativeBridgedSession({ refresh_token: NATIVE_BRIDGE_WEB_REFRESH_TOKEN_PLACEHOLDER })).toBe(true)
    expect(isNativeBridgedSession({ refresh_token: 'real-refresh-token' })).toBe(false)
    expect(isNativeBridgedSession({ refresh_token: null })).toBe(false)
    expect(isNativeBridgedSession({ refresh_token: undefined })).toBe(false)
    expect(isNativeBridgedSession({})).toBe(false)
    expect(isNativeBridgedSession(null)).toBe(false)
    expect(isNativeBridgedSession(undefined)).toBe(false)
  })
})
