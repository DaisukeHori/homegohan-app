/**
 * アカウント凍結ページ (src/app/frozen/page.tsx) のログアウトのテスト (#1038 F7-04)
 *
 * - CLAUDE.md の規約: サインアウトでは Supabase の signOut より前に、端末のユーザー別データ (localStorage) を消す
 * - signOut のあとに broadcastSignOut() を呼び、ほかのタブと、モバイルアプリの WebView の場合はネイティブにもログアウトを伝える
 *   (伝えないと、Web だけがログアウトし、ネイティブは保存済みのセッションを持ったままになる)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { pushMock, signOutMock } = vi.hoisted(() => ({ pushMock: vi.fn(), signOutMock: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signOut: signOutMock } }) }))

const { default: FrozenPage } = await import('@/app/frozen/page')
import { resetNativeAuthBridgeForTests } from '@/lib/native-auth-bridge'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type WindowWithBridge = Window & { ReactNativeWebView?: unknown }

const USER_SCOPED_KEYS = ['v4_range_days', 'v4_include_existing', 'v4MenuGenerating', 'profile_reminder_dismissed']

let container: HTMLDivElement
let root: Root
let events: string[]
let userScopedKeysAtSignOut: string[]

beforeEach(() => {
  resetNativeAuthBridgeForTests()
  events = []
  userScopedKeysAtSignOut = []
  pushMock.mockReset()
  signOutMock.mockReset()
  signOutMock.mockImplementation(async () => {
    events.push('signOut')
    userScopedKeysAtSignOut = USER_SCOPED_KEYS.filter((key) => localStorage.getItem(key) !== null)
    return { error: null }
  })
  for (const key of USER_SCOPED_KEYS) localStorage.setItem(key, '1')
  delete (window as WindowWithBridge).ReactNativeWebView
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  localStorage.clear()
  delete (window as WindowWithBridge).ReactNativeWebView
})

async function clickLogout() {
  await act(async () => {
    root.render(<FrozenPage />)
  })
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'ログアウト')
  expect(button).toBeDefined()
  await act(async () => {
    button!.click()
  })
}

describe('凍結ページのログアウト', () => {
  it('signOut の前に user-scoped の localStorage を消し、signOut のあとに /login へ移る', async () => {
    await clickLogout()

    expect(signOutMock).toHaveBeenCalledTimes(1)
    // signOut が呼ばれた時点で、すでに消えている
    expect(userScopedKeysAtSignOut).toEqual([])
    expect(USER_SCOPED_KEYS.filter((key) => localStorage.getItem(key) !== null)).toEqual([])
    expect(pushMock).toHaveBeenCalledWith('/login')
  })

  it('モバイルアプリの WebView の中なら、ネイティブにも sign-out を送る (signOut のあと)', async () => {
    const postMessage = vi.fn((message: string) => {
      events.push(`post:${JSON.parse(message).type}`)
    })
    ;(window as WindowWithBridge).ReactNativeWebView = { postMessage }

    await clickLogout()

    expect(events).toEqual(['signOut', 'post:sign-out'])
  })

  it('ふつうのブラウザでは、ネイティブへは何も送らずに、同じ流れで終わる', async () => {
    await clickLogout()

    expect(events).toEqual(['signOut'])
    expect(pushMock).toHaveBeenCalledWith('/login')
  })
})
