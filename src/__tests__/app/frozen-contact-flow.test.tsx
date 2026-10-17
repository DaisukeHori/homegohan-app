/**
 * #1871: 凍結 (BAN) 中の利用者も、凍結の画面 (/frozen) から問い合わせを送れる。
 *
 * #1871 のオーナーの選択 (2026-10-18): 「凍結中も送れるようにする。/api/contact を凍結中も通す。今の回数の制限は、そのまま効かせる。」
 *
 * 凍結の画面の「サポートに問い合わせる」→ お問い合わせの画面 (/contact) → 送信 (POST /api/contact) の道を、
 * 本物の middleware (lib/supabase/middleware.ts の updateSession) に凍結中の利用者として通して確かめる:
 *   - 凍結の画面に /contact へのリンクがあり、凍結中でも /contact の画面は /frozen へ差し戻されない
 *   - お問い合わせの画面の送信は POST /api/contact で、middleware が凍結中でも route へ通し、画面は「送信完了」になる
 *   - 同じパスの GET (お問い合わせの履歴) は、凍結中は今までどおり 403 AUTH_ACCOUNT_FROZEN
 * 回数の制限が凍結中も効くこと (route が利用者の状態を見ずに IP で数える) は src/__tests__/api/contact-rate-limit.test.ts。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (frozen-account-page.test.tsx と同じ)。
 */
import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { pushMock, signOutMock, mockGetSession, mockGetUser, mockMaybeSingle } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  signOutMock: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetUser: vi.fn(),
  mockMaybeSingle: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signOut: signOutMock } }) }))
// middleware が読む Supabase (凍結中の利用者のプロフィールを返す)
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getSession: mockGetSession, getUser: mockGetUser },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }) }),
  }),
}))
// メンテナンスモードは OFF の前提 (DB を読みに行かせない)
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }))
// アニメーションは描画の確認に要らない (AnimatePresence の mode="wait" が送信完了の表示を遅らせないように、子をそのまま出す)
vi.mock('framer-motion', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    motion: new Proxy({}, { get: () => passthrough }),
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  }
})

const { default: FrozenPage } = await import('@/app/frozen/page')
const { default: ContactPage } = await import('@/app/contact/page')
const { updateSession } = await import('@/lib/supabase/middleware')
import { CONTACT_API_PATH, CONTACT_SUBMIT_METHOD } from '@/lib/auth/frozen'
import { stubSupabasePublicEnv } from '../../../lib/supabase/__tests__/supabase-public-env'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FROZEN_PROFILE = { frozen_at: '2026-07-01T00:00:00.000Z', unban_at: null, roles: ['user'] }
const ORIGIN = 'http://localhost'
/** route (src/app/api/contact/route.ts) が受け付けたときの本文の形 (画面は ok かどうかと error だけを読む) */
const ROUTE_ACCEPTED_BODY = { success: true, message: 'お問い合わせを受け付けました。', inquiryId: 'inquiry-1' }

let container: HTMLDivElement
let root: Root
/** 画面が呼んだ API (middleware を通した結果つき) */
let apiCalls: Array<{ url: string; method: string; middlewareStatus: number; passed: boolean }>

/**
 * 画面の fetch を、本物の middleware に通す。middleware が route へ通したとき (x-middleware-next) だけ、
 * route が受け付けた応答を返す。止めたときは middleware の応答 (403 など) をそのまま返す。
 */
async function fetchThroughMiddleware(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const res = await updateSession(
    new NextRequest(new URL(url, ORIGIN), {
      method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body as string | undefined,
    }),
  )
  const passed = res.status === 200 && res.headers.get('x-middleware-next') === '1'
  apiCalls.push({ url, method, middlewareStatus: res.status, passed })
  if (passed) return new Response(JSON.stringify(ROUTE_ACCEPTED_BODY), { status: 200 })
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  stubSupabasePublicEnv()
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null })
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockMaybeSingle.mockResolvedValue({ data: FROZEN_PROFILE, error: null })
  apiCalls = []
  vi.stubGlobal('fetch', vi.fn(fetchThroughMiddleware))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
})

afterAll(() => {
  vi.unstubAllEnvs()
})

async function render(element: ReactElement) {
  await act(async () => {
    root.render(element)
  })
}

/** React の制御された入力に値を入れる (setter を直接呼んでから input を発火する) */
async function fill(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function fillAndSubmitContactForm() {
  const email = container.querySelector<HTMLInputElement>('input[type="email"]')
  const subject = container.querySelector<HTMLInputElement>('input[type="text"]')
  const message = container.querySelector<HTMLTextAreaElement>('textarea')
  const form = container.querySelector<HTMLFormElement>('form')
  expect(email && subject && message && form).toBeTruthy()
  await fill(email!, 'frozen-user@example.com')
  await fill(subject!, '凍結について')
  await fill(message!, '凍結の理由を教えてください。')
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('#1871: 凍結の画面から問い合わせを送れる', () => {
  it('凍結の画面に「サポートに問い合わせる」(/contact) があり、凍結中でも /contact の画面は /frozen へ差し戻されない', async () => {
    await render(<FrozenPage />)
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'サポートに問い合わせる')
    expect(link?.getAttribute('href')).toBe('/contact')

    const page = await updateSession(new NextRequest(new URL(link!.getAttribute('href')!, ORIGIN)))
    expect(page.status).toBe(200)
    expect(page.headers.get('location')).toBeNull()
    // 凍結を判定した上で通している (判定を飛ばしたのではない)
    expect(mockMaybeSingle).toHaveBeenCalled()
  })

  it('お問い合わせの画面の送信 (POST /api/contact) は凍結中でも middleware を通り、画面は「送信完了しました！」になる', async () => {
    await render(<ContactPage />)

    await fillAndSubmitContactForm()

    expect(apiCalls).toEqual([
      { url: CONTACT_API_PATH, method: CONTACT_SUBMIT_METHOD, middlewareStatus: 200, passed: true },
    ])
    const sent = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse(String(sent[1]?.body))).toEqual({
      inquiryType: 'general',
      email: 'frozen-user@example.com',
      subject: '凍結について',
      message: '凍結の理由を教えてください。',
    })
    expect(container.textContent).toContain('送信完了しました！')
  })

  it('同じパスの GET (お問い合わせの履歴) は、凍結中は今までどおり 403 AUTH_ACCOUNT_FROZEN', async () => {
    const res = await fetch(CONTACT_API_PATH, { method: 'GET' })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'アカウントが凍結されています' },
    })
    expect(apiCalls).toEqual([{ url: CONTACT_API_PATH, method: 'GET', middlewareStatus: 403, passed: false }])
  })
})
