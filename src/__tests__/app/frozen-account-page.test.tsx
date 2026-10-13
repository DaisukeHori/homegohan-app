/**
 * #1445: 凍結 (BAN) 中の利用者も、退会とデータの書き出しをできるようにする (凍結の画面から行ける)。
 *
 * - 凍結の画面 (src/app/frozen/page.tsx) に、退会と書き出しの画面 (/frozen/account) へのリンクがある
 * - 退会と書き出しの画面 (src/app/frozen/account/page.tsx):
 *   - 書き出し: GET /api/account/export を呼び、JSON をファイルとして保存する。429 / 失敗は画面に文で出す
 *   - 退会: 「削除します」と入力するまで押せない。POST /api/account/delete { confirm: true } のあと、
 *     端末のユーザー別データを消してから signOut し (CLAUDE.md の規約)、/login へ移る
 *   - 組織のオーナー・家族の代表者 (409) は、サーバーの文と、凍結中は譲渡できないのでサポートへ、の案内を出す
 *   - この画面は凍結中でも止めない 2 つの API (FROZEN_ALLOWED_API_PATHS) 以外を呼ばない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (frozen-page-logout.test.tsx と同じ)。
 */
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { pushMock, signOutMock } = vi.hoisted(() => ({ pushMock: vi.fn(), signOutMock: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signOut: signOutMock } }) }))

const { default: FrozenPage } = await import('@/app/frozen/page')
const { default: FrozenAccountPage } = await import('@/app/frozen/account/page')
import { FROZEN_ALLOWED_API_PATHS } from '@/lib/auth/frozen'
import { resetNativeAuthBridgeForTests } from '@/lib/native-auth-bridge'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type WindowWithBridge = Window & { ReactNativeWebView?: unknown }

const USER_SCOPED_KEY = 'v4_range_days'

let container: HTMLDivElement
let root: Root
let events: string[]
const fetchMock = vi.fn()
const createObjectURL = vi.fn((_blob: Blob) => 'blob:mock-url')
const revokeObjectURL = vi.fn()
const downloads: string[] = []
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
const originalClick = HTMLAnchorElement.prototype.click

beforeEach(() => {
  resetNativeAuthBridgeForTests()
  events = []
  downloads.length = 0
  pushMock.mockReset()
  signOutMock.mockReset()
  signOutMock.mockImplementation(async () => {
    events.push(`signOut:storage=${localStorage.getItem(USER_SCOPED_KEY) === null ? 'cleared' : 'kept'}`)
    return { error: null }
  })
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    downloads.push(this.download)
  }
  localStorage.setItem(USER_SCOPED_KEY, '1')
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
  vi.unstubAllGlobals()
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
  HTMLAnchorElement.prototype.click = originalClick
  delete (window as WindowWithBridge).ReactNativeWebView
})

async function render(element: ReactElement) {
  await act(async () => {
    root.render(element)
  })
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text)
  expect(button, text).toBeDefined()
  return button as HTMLButtonElement
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click()
  })
}

async function typeConfirm(value: string) {
  const input = container.querySelector<HTMLInputElement>('#frozen-delete-confirm')
  expect(input).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function calledPaths(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]))
}

describe('凍結の画面 (/frozen)', () => {
  it('退会と書き出しの画面 (/frozen/account) へのリンクがある', async () => {
    await render(<FrozenPage />)

    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === '退会・データの書き出し')
    expect(link?.getAttribute('href')).toBe('/frozen/account')
  })
})

describe('退会と書き出しの画面 (/frozen/account)', () => {
  it('書き出し: GET /api/account/export を呼び、JSON をファイルとして保存する', async () => {
    fetchMock.mockResolvedValue(new Response('{"user_id":"u1"}', { status: 200 }))
    await render(<FrozenAccountPage />)

    await click(buttonByText('データをエクスポート'))

    expect(fetchMock).toHaveBeenCalledWith('/api/account/export', { method: 'GET' })
    expect(downloads).toHaveLength(1)
    expect(downloads[0]).toMatch(/^homegohan-export-\d{4}-\d{2}-\d{2}\.json$/)
    expect(container.textContent).toContain('データを書き出しました。')
  })

  it('書き出し: モバイルアプリの WebView の中では、本文をネイティブへ送って保存してもらう', async () => {
    const postMessage = vi.fn()
    ;(window as WindowWithBridge).ReactNativeWebView = { postMessage }
    fetchMock.mockResolvedValue(new Response('{"user_id":"u1"}', { status: 200 }))
    await render(<FrozenAccountPage />)

    await click(buttonByText('データをエクスポート'))

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(JSON.parse(postMessage.mock.calls[0][0] as string)).toMatchObject({
      type: 'download',
      content: '{"user_id":"u1"}',
      mimeType: 'application/json',
    })
    expect(downloads).toHaveLength(0)
  })

  it('書き出し: 連打の上限 (429) は、待つ時間を画面に出す', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }))
    await render(<FrozenAccountPage />)

    await click(buttonByText('データをエクスポート'))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('2分ほど待ってから')
    expect(downloads).toHaveLength(0)
  })

  it('書き出し: 失敗 (500) は、失敗の文を画面に出す', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }))
    await render(<FrozenAccountPage />)

    await click(buttonByText('データをエクスポート'))

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'データのエクスポートに失敗しました。時間をおいて再度お試しください。',
    )
  })

  it('退会: 「削除します」と入力するまで押せない', async () => {
    await render(<FrozenAccountPage />)

    expect(buttonByText('アカウントを削除').disabled).toBe(true)
    await typeConfirm('削除')
    expect(buttonByText('アカウントを削除').disabled).toBe(true)
    await typeConfirm('削除します')
    expect(buttonByText('アカウントを削除').disabled).toBe(false)
  })

  it('退会: POST /api/account/delete { confirm: true } のあと、端末のユーザー別データを消してから signOut し、/login へ移る', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
    await render(<FrozenAccountPage />)

    await typeConfirm('削除します')
    await click(buttonByText('アカウントを削除'))

    expect(fetchMock).toHaveBeenCalledWith('/api/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    })
    expect(events).toEqual(['signOut:storage=cleared'])
    expect(pushMock).toHaveBeenCalledWith('/login')
  })

  it('退会: 組織のオーナー (409) は、サーバーの文と、凍結中は譲渡できないのでサポートへ、の案内を出す。ログアウトしない', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
          message: '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。',
        }),
        { status: 409 },
      ),
    )
    await render(<FrozenAccountPage />)

    await typeConfirm('削除します')
    await click(buttonByText('アカウントを削除'))

    const alert = container.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('組織のオーナーです。')
    expect(alert).toContain('サポートにお問い合わせください')
    expect(signOutMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
    // もう一度押せる
    expect(buttonByText('アカウントを削除').disabled).toBe(false)
  })

  it('退会: 失敗 (500) は、失敗の文を出し、ログアウトしない', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }))
    await render(<FrozenAccountPage />)

    await typeConfirm('削除します')
    await click(buttonByText('アカウントを削除'))

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'アカウントの削除に失敗しました。時間をおいて再度お試しください。',
    )
    expect(signOutMock).not.toHaveBeenCalled()
  })

  it('この画面は、凍結中でも止めない API (FROZEN_ALLOWED_API_PATHS) 以外を呼ばない', async () => {
    fetchMock.mockImplementation(async (input: string) =>
      input === '/api/account/delete'
        ? new Response(JSON.stringify({ success: true }), { status: 200 })
        : new Response('{}', { status: 200 }),
    )
    await render(<FrozenAccountPage />)

    await click(buttonByText('データをエクスポート'))
    await typeConfirm('削除します')
    await click(buttonByText('アカウントを削除'))

    expect(calledPaths().length).toBeGreaterThan(0)
    for (const path of calledPaths()) {
      expect(FROZEN_ALLOWED_API_PATHS).toContain(path)
    }
  })

  it('問い合わせ先と、凍結のお知らせへ戻るリンクがある', async () => {
    await render(<FrozenAccountPage />)

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(expect.arrayContaining(['/contact', '/frozen']))
  })
})
