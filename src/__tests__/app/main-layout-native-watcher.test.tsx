/**
 * 認証が必要なページの共通レイアウト (src/app/(main)/MainLayout.tsx) のテスト (#1038 F7-05)
 *
 * モバイルアプリの WebView の中で、Web 側のセッションの寿命を見張って、切れる前にネイティブへ再ブリッジを頼む
 * NativeSessionWatcher が、このレイアウトに載っていること。(載っていないと、Web 側のセッションが切れても
 * ネイティブに伝わらず、WebView がログイン画面のまま残る。)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  return { motion: new Proxy({}, { get: () => passthrough }), AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> }
})
// icons はディレクトリ (src/components/icons/index.tsx)。描画に関係ないので差し替える
vi.mock('@/components/icons', () => ({ Icons: new Proxy({}, { get: () => () => null }) }))
vi.mock('@/components/AIChatBubble', () => ({ default: () => null }))
vi.mock('@/components/native-app/NativeAppTabRouter', () => ({ NativeAppTabRouter: () => null }))
vi.mock('@/components/native-app/NativeSessionWatcher', () => ({
  NativeSessionWatcher: () => <span data-testid="native-session-watcher" />,
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  }),
}))

const { default: MainLayout } = await import('@/app/(main)/MainLayout')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('MainLayout — NativeSessionWatcher (#1038 F7-05)', () => {
  it('認証が必要なページの共通レイアウトに NativeSessionWatcher が載っている', async () => {
    await act(async () => {
      root.render(
        <MainLayout initialIsNativeApp>
          <p>page body</p>
        </MainLayout>,
      )
    })

    expect(container.querySelector('[data-testid="native-session-watcher"]')).not.toBeNull()
    expect(container.textContent).toContain('page body')
  })
})
