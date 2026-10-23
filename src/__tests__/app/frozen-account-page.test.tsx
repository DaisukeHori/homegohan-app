/**
 * #1445: 凍結 (BAN) 中の利用者も、退会とデータの書き出しをできるようにする (凍結の画面から行ける)。
 *
 * - 凍結の画面 (src/app/frozen/page.tsx) に、退会と書き出しの画面 (/frozen/account) へのリンクがある
 * - 退会と書き出しの画面 (src/app/frozen/account/page.tsx):
 *   - 書き出し: GET /api/account/export を呼び、JSON をファイルとして保存する。429 / 失敗は画面に文で出す
 *   - 退会: 「削除します」と入力するまで押せない。POST /api/account/delete { confirm: true } のあと、
 *     端末のユーザー別データを消してから signOut し (CLAUDE.md の規約)、/login へ移る
 *   - 組織のオーナー・家族の代表者 (409) は、サーバーの文と FROZEN_DISSOLVE_GUIDANCE (譲渡はできない・解散すると退会できる) を出し、
 *     その場に解散の区画を出す (#1917 docs/design/family/11-self-dissolve.md §15.4)。409 の本文に立場の id が無ければ、サポートへの案内だけ
 *   - この画面は凍結中でも止めない API (FROZEN_ALLOWED_API_PATHS) のうち、退会と書き出しと、409 のときの家族グループ / 組織の解散の 4 つ以外を呼ばない
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
import {
  BLOCKED_SCOPE_UNKNOWN_GUIDANCE,
  FAMILY_PLAN_CONTINUES_AFTER_DISSOLVE,
  FROZEN_DISSOLVE_GUIDANCE,
  SELF_DISSOLVED_NEXT_STEP,
} from '@/lib/membership/self-dissolve'
import { resetNativeAuthBridgeForTests } from '@/lib/native-auth-bridge'
import { STORE_SUBSCRIPTION_DELETION_NOTICE } from '@homegohan/shared'

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

/** 解散の区画の入力欄 (data-testid は SelfDissolveSection の self-dissolve-<scope>-keyword) に入力する */
async function typeDissolveKeyword(scope: 'family' | 'organization', value: string) {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="self-dissolve-${scope}-keyword"]`)
  expect(input, `self-dissolve-${scope}-keyword`).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function dissolveSubmit(scope: 'family' | 'organization'): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="self-dissolve-${scope}-submit"]`)
}

const ORG_OWNER_MESSAGE = '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。'
const FAMILY_REPRESENTATIVE_MESSAGE = '家族グループの代表者です。先に代表者を譲渡するか家族グループを解散してください。'
const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55'
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66'
const DISSOLVED_AT = '2026-10-19T05:00:00.123456+00:00'

function calledPaths(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]))
}

describe('凍結の画面 (/frozen)', () => {
  it('退会と書き出しの画面 (/frozen/account) へのリンクがある', async () => {
    await render(<FrozenPage />)

    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === '退会・データの書き出し')
    expect(link?.getAttribute('href')).toBe('/frozen/account')
  })

  it('有料プランの解約の画面 (/frozen/billing) へのリンクがある', async () => {
    await render(<FrozenPage />)

    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === '有料プランの解約・お支払い')
    expect(link?.getAttribute('href')).toBe('/frozen/billing')
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

  it('退会: 削除の節に STORE_SUBSCRIPTION_DELETION_NOTICE (ストアの購読は退会で解約されない) の文を出す', async () => {
    await render(<FrozenAccountPage />)

    // 退会の節 (見出し「アカウントを削除する (退会)」の section) の中に、ストアの購読の文がちょうど 1 回出る (billing/03 §10.4・S35)
    const deleteSection = Array.from(container.querySelectorAll('section')).find((section) =>
      (section.querySelector('h2')?.textContent ?? '').includes('アカウントを削除する'),
    )
    expect(deleteSection, '退会の節').toBeDefined()
    const notices = Array.from(deleteSection!.querySelectorAll('p')).filter((p) => p.textContent === STORE_SUBSCRIPTION_DELETION_NOTICE)
    expect(notices).toHaveLength(1)
    // 書き出しの節には出さない
    expect(container.textContent?.split(STORE_SUBSCRIPTION_DELETION_NOTICE)).toHaveLength(2)
    // 文を出すだけで、読み込みの時に API を呼ばない (契約の有無を読みに行かない固定の文)
    expect(calledPaths()).toEqual([])
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

  it('退会: 409 の本文に立場の id が無ければ、サーバーの文と BLOCKED_SCOPE_UNKNOWN_GUIDANCE (サポートへ) を出し、解散の区画は出さない。ログアウトしない', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
          message: ORG_OWNER_MESSAGE,
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
    expect(alert).toBe(`${ORG_OWNER_MESSAGE} ${BLOCKED_SCOPE_UNKNOWN_GUIDANCE}`)
    expect(dissolveSubmit('organization')).toBeNull()
    expect(dissolveSubmit('family')).toBeNull()
    expect(signOutMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
    // もう一度押せる
    expect(buttonByText('アカウントを削除').disabled).toBe(false)
  })

  it('退会: 組織のオーナー (409。本文に organization の id と名前) は、サーバーの文と FROZEN_DISSOLVE_GUIDANCE (譲渡はできない・解散すると退会できる) を出し、組織名つきの解散の区画を出す。ログアウトしない', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER', message: ORG_OWNER_MESSAGE, organization: { id: ORG_ID, name: '株式会社テスト' } }),
        { status: 409 },
      ),
    )
    await render(<FrozenAccountPage />)

    await typeConfirm('削除します')
    await click(buttonByText('アカウントを削除'))

    expect(container.textContent).toContain(`${ORG_OWNER_MESSAGE} ${FROZEN_DISSOLVE_GUIDANCE}`)
    expect(container.textContent).not.toContain(BLOCKED_SCOPE_UNKNOWN_GUIDANCE)
    expect(container.textContent).toContain('「株式会社テスト」を解散する')
    expect(dissolveSubmit('organization')).not.toBeNull()
    expect(signOutMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('退会: 家族の代表者 (409。本文に family_group) は、家族名つきの解散の区画を出す', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
          message: FAMILY_REPRESENTATIVE_MESSAGE,
          family_group: { id: FAMILY_ID, name: '山田家' },
        }),
        { status: 409 },
      ),
    )
    await render(<FrozenAccountPage />)

    await typeConfirm('削除します')
    await click(buttonByText('アカウントを削除'))

    expect(container.textContent).toContain(`${FAMILY_REPRESENTATIVE_MESSAGE} ${FROZEN_DISSOLVE_GUIDANCE}`)
    expect(container.textContent).toContain('「山田家」を解散する')
    expect(dissolveSubmit('family')).not.toBeNull()
    expect(dissolveSubmit('organization')).toBeNull()
  })

  it('退会: 家族の代表者の解散の区画は、家族プランの解約を凍結中に開ける「有料プランの解約・お支払い」(/frozen/billing) へ案内し、凍結中は開けない「プランとお支払い」(/account/billing) を名指さない', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
          message: FAMILY_REPRESENTATIVE_MESSAGE,
          family_group: { id: FAMILY_ID, name: '山田家' },
        }),
        { status: 409 },
      ),
    )
    await render(<FrozenAccountPage />)

    await typeConfirm('削除します')
    await click(buttonByText('アカウントを削除'))

    const lines = Array.from(container.querySelectorAll('li')).map((li) => li.textContent)
    expect(lines).toContain(FAMILY_PLAN_CONTINUES_AFTER_DISSOLVE.frozen)
    expect(lines).not.toContain(FAMILY_PLAN_CONTINUES_AFTER_DISSOLVE.settings)
    expect(container.textContent).toContain('「有料プランの解約・お支払い」')
    expect(container.textContent).not.toContain('「プランとお支払い」')
  })

  it('解散の区画で解散すると (POST /api/org/dissolve が 200)、区画が消えて「解散しました。「削除します」と入力して退会を続けてください。」が出る。そのあとの退会は 200 で /login へ', async () => {
    let deleteCalls = 0
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/api/account/delete') {
        deleteCalls += 1
        return deleteCalls === 1
          ? new Response(
              JSON.stringify({ error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER', message: ORG_OWNER_MESSAGE, organization: { id: ORG_ID, name: '株式会社テスト' } }),
              { status: 409 },
            )
          : new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      if (input === '/api/org/dissolve') {
        return new Response(JSON.stringify({ data: { organization_id: ORG_ID, dissolved_at: DISSOLVED_AT } }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    await render(<FrozenAccountPage />)

    await typeConfirm('削除します')
    await click(buttonByText('アカウントを削除'))
    await typeDissolveKeyword('organization', '解散します')
    await click(dissolveSubmit('organization')!)

    const dissolveCall = fetchMock.mock.calls.find((call) => call[0] === '/api/org/dissolve')
    expect(JSON.parse(String((dissolveCall?.[1] as RequestInit).body))).toEqual({ organization_id: ORG_ID, confirm: true })
    expect(dissolveSubmit('organization')).toBeNull()
    expect(container.textContent).toContain(SELF_DISSOLVED_NEXT_STEP)
    expect(SELF_DISSOLVED_NEXT_STEP).toBe('解散しました。「削除します」と入力して退会を続けてください。')

    await click(buttonByText('アカウントを削除'))
    expect(events).toEqual(['signOut:storage=cleared'])
    expect(pushMock).toHaveBeenCalledWith('/login')
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
    // 409 → 解散 → 退会の流れも通す (#1917。呼ぶのは退会・書き出し・解散で、どれも 7 本の一覧にある)
    let deleteCalls = 0
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/api/account/delete') {
        deleteCalls += 1
        return deleteCalls === 1
          ? new Response(
              JSON.stringify({
                error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE',
                message: FAMILY_REPRESENTATIVE_MESSAGE,
                family_group: { id: FAMILY_ID, name: '山田家' },
              }),
              { status: 409 },
            )
          : new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      if (input === '/api/family/dissolve') {
        return new Response(JSON.stringify({ data: { family_id: FAMILY_ID, dissolved_at: DISSOLVED_AT } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
    await render(<FrozenAccountPage />)

    await click(buttonByText('データをエクスポート'))
    await typeConfirm('削除します')
    await click(buttonByText('アカウントを削除'))
    await typeDissolveKeyword('family', '解散します')
    await click(dissolveSubmit('family')!)
    await click(buttonByText('アカウントを削除'))

    expect(new Set(calledPaths())).toEqual(new Set(['/api/account/export', '/api/account/delete', '/api/family/dissolve']))

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
