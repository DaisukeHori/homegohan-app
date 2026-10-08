/**
 * src/lib/user-storage.ts の broadcastSignOut のテスト (#1038 F7-04)
 *
 * Web でログアウトしたとき、開いている他のタブ (BroadcastChannel) に加えて、
 * モバイルアプリの WebView の中ならネイティブアプリにも { type: 'sign-out' } を伝える。
 * 伝えないと、Web だけがログアウトし、ネイティブは保存済みのセッションを持ったままになる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { broadcastSignOut } from '@/lib/user-storage'
import { resetNativeAuthBridgeForTests } from '@/lib/native-auth-bridge'

type WindowWithBridge = Window & { ReactNativeWebView?: unknown }

beforeEach(() => {
  resetNativeAuthBridgeForTests()
  delete (window as WindowWithBridge).ReactNativeWebView
})

afterEach(() => {
  delete (window as WindowWithBridge).ReactNativeWebView
  vi.unstubAllGlobals()
})

describe('broadcastSignOut', () => {
  it('モバイルアプリの WebView の中なら、ネイティブにログアウトを伝える', () => {
    const postMessage = vi.fn()
    ;(window as WindowWithBridge).ReactNativeWebView = { postMessage }

    broadcastSignOut()

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ type: 'sign-out' })
  })

  it('他のタブにも従来どおり SIGNED_OUT を BroadcastChannel で伝える', () => {
    const channelPost = vi.fn()
    const channelClose = vi.fn()
    const Channel = vi.fn(function (this: unknown) {
      return { postMessage: channelPost, close: channelClose }
    })
    vi.stubGlobal('BroadcastChannel', Channel)

    broadcastSignOut()

    expect(Channel).toHaveBeenCalledWith('auth')
    expect(channelPost).toHaveBeenCalledWith('SIGNED_OUT')
    expect(channelClose).toHaveBeenCalledTimes(1)
  })

  it('BroadcastChannel が無い WebView (iOS 15.4 未満など) でも、ネイティブには伝わる', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const postMessage = vi.fn()
    ;(window as WindowWithBridge).ReactNativeWebView = { postMessage }

    expect(() => broadcastSignOut()).not.toThrow()

    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('普通のブラウザでは、ネイティブ向けには何もしない (従来どおり)', () => {
    vi.stubGlobal('BroadcastChannel', undefined)

    expect(() => broadcastSignOut()).not.toThrow()
  })
})
