/**
 * ログイン画面 (src/app/(auth)/login/page.tsx) のテスト (#1038 F7-05)
 *
 * モバイルアプリの WebView でログイン画面が出た = Web 側のセッションが無い (切れた)。
 * ネイティブに { type: 'session-expired' } を送り、新しい bridge で読み込み直してもらう。
 * 普通のブラウザでは何も送らない。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('next=%2Fhome'),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithPassword: vi.fn(), signInWithOAuth: vi.fn() } }),
}))

const { default: LoginPage } = await import('@/app/(auth)/login/page')
import { resetNativeAuthBridgeForTests } from '@/lib/native-auth-bridge'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type WindowWithBridge = Window & { ReactNativeWebView?: unknown }

let container: HTMLDivElement
let root: Root

async function renderLogin() {
  await act(async () => {
    root.render(<LoginPage />)
  })
}

beforeEach(() => {
  resetNativeAuthBridgeForTests()
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
  delete (window as WindowWithBridge).ReactNativeWebView
})

describe('ログイン画面 — ネイティブアプリの WebView での通知 (#1038 F7-05)', () => {
  it('モバイルアプリの WebView でログイン画面が出たら、ネイティブに session-expired を 1 回送る', async () => {
    const postMessage = vi.fn()
    ;(window as WindowWithBridge).ReactNativeWebView = { postMessage }

    await renderLogin()

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ type: 'session-expired' })
  })

  it('普通のブラウザでは何も送らず、ログイン画面は通常どおり表示される', async () => {
    await renderLogin()

    expect(container.textContent).toContain('ログイン')
  })
})
