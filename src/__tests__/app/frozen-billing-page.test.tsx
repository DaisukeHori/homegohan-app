/**
 * billing/01 §10.5・§9.8 (#1701 段 C): 凍結 (BAN) 中の利用者の「有料プランの解約・お支払い」の画面 (/frozen/billing)。
 *
 * - GET /api/billing/subscription の要約を読み、状態の文 (billingStatusLines) を出す
 * - 解約できる Stripe の契約: 「解約する」→ 確認 → POST /api/billing/subscription/cancel → 返った要約で置き換え (「…に解約されます」・ボタンが消える)
 * - 「お支払い方法・請求書 (Stripe)」→ POST /api/billing/portal → 応答の url へ移る
 * - 「解約を取り消す」と /pricing へのリンクは出さない。呼ぶ API はどれも FROZEN_ALLOWED_API_PATHS に入っている
 * - 契約が無い / 手動の契約 / アプリの WebView / 409・429・500 / 401 の扱い
 * - App Store / Google Play の契約は解約のボタンを出さず、ストアの定期購読の管理から解約できることを出す (billing/03 §10.4・テスト 88)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (frozen-account-page.test.tsx と同じ)。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IAP_STORE_LABELS, STORE_SUBSCRIPTION_MANAGEMENT_URL, PURCHASE_STORES } from '@homegohan/shared'
import { EMPTY_PLAN_FEATURES, type BillingSummary } from '@/lib/billing/core'

const { pushMock, nativeMock } = vi.hoisted(() => ({ pushMock: vi.fn(), nativeMock: { value: false } }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))
vi.mock('@/lib/native-auth-bridge', () => ({ isInNativeWebView: () => nativeMock.value }))

const { default: FrozenBillingPage } = await import('@/app/frozen/billing/page')
import { FROZEN_ALLOWED_API_PATHS } from '@/lib/auth/frozen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const UNKNOWN_ERROR_TEXT = '処理中にエラーが発生しました。時間をおいて再度お試しください。'

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn()
const confirmMock = vi.fn()
let locationMock: { assign: ReturnType<typeof vi.fn> }

/** 要約。既定は Stripe の契約が active・解約できる */
function summaryOf(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    plan_key: 'pro',
    effective_plan_key: 'pro',
    status: 'active',
    source: 'stripe',
    billing_interval: 'month',
    // 日本時間で 2026年11月21日
    current_period_end: '2026-11-20T15:30:00Z',
    trial_ends_at: null,
    cancel_at_period_end: false,
    cancel_at: null,
    has_customer: true,
    can_purchase: false,
    can_cancel: true,
    can_resume: false,
    manage_in_store: null,
    features: EMPTY_PLAN_FEATURES,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  pushMock.mockReset()
  nativeMock.value = false
  fetchMock.mockReset()
  confirmMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('confirm', confirmMock)
  locationMock = { assign: vi.fn() }
  vi.stubGlobal('location', locationMock)
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

async function render() {
  await act(async () => {
    root.render(<FrozenBillingPage />)
  })
  await act(async () => {})
}

function buttonTexts(): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '')
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
  await act(async () => {})
}

function calledPaths(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]))
}

function alertText(): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null
}

describe('凍結中の解約とお支払いの画面 (/frozen/billing)', () => {
  it('/frozen/billing reads GET /api/billing/subscription and shows the status lines; for a cancellable Stripe contract it confirms, calls POST /api/billing/subscription/cancel and shows the returned summary with …に解約されます and no cancel button; the Portal button calls POST /api/billing/portal and moves to its url; it never shows 解約を取り消す or a link to /pricing, and every fetched path is in FROZEN_ALLOWED_API_PATHS', async () => {
    const scheduled = summaryOf({ cancel_at_period_end: true, cancel_at: '2026-11-20T15:30:00Z', can_cancel: false, can_resume: true })
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/billing/subscription' && (init?.method ?? 'GET') === 'GET') return jsonResponse({ data: summaryOf() })
      if (input === '/api/billing/subscription/cancel' && init?.method === 'POST') return jsonResponse({ data: scheduled })
      if (input === '/api/billing/portal' && init?.method === 'POST') return jsonResponse({ data: { url: 'https://billing.stripe.test/session/x' } })
      return jsonResponse({}, 404)
    })
    confirmMock.mockReturnValue(true)

    await render()
    expect(calledPaths()).toEqual(['/api/billing/subscription'])
    expect(container.textContent).toContain('有料プランの解約・お支払い')
    expect(container.textContent).toContain('ご利用中')
    expect(buttonTexts()).toEqual(['解約する', 'お支払い方法・請求書 (Stripe)'])

    // 解約: 確認のあと POST し、返った要約で置き換える
    await click(buttonByText('解約する'))
    expect(confirmMock).toHaveBeenCalledWith('有料プランの解約を予約します。2026年11月21日以降は請求されません。よろしいですか？')
    expect(fetchMock).toHaveBeenCalledWith('/api/billing/subscription/cancel', { method: 'POST' })
    expect(container.textContent).toContain('2026年11月21日に解約されます')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('解約を予約しました。')
    expect(buttonTexts()).not.toContain('解約する')
    // 取り消しは凍結中はできないので、can_resume が真でも出さない
    expect(container.textContent).not.toContain('解約を取り消す')

    // Portal: POST して url へ移る
    await click(buttonByText('お支払い方法・請求書 (Stripe)'))
    expect(fetchMock).toHaveBeenCalledWith('/api/billing/portal', { method: 'POST' })
    expect(locationMock.assign).toHaveBeenCalledWith('https://billing.stripe.test/session/x')

    // 購入への導線は無い。リンクは凍結のお知らせとサポートだけ
    expect(container.querySelector('a[href="/pricing"]')).toBeNull()
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(expect.arrayContaining(['/frozen', '/contact']))

    // 呼んだ API はどれも凍結中に止めない一覧に入っている
    expect(calledPaths()).toEqual(['/api/billing/subscription', '/api/billing/subscription/cancel', '/api/billing/portal'])
    for (const path of calledPaths()) {
      expect(FROZEN_ALLOWED_API_PATHS).toContain(path)
    }
  })

  it('/frozen/billing shows 有料プランの契約はありません without buttons when status is null, no cancel button for a manual contract, only the status lines in the app WebView, the fixed message for a 409 / 429 / 500 from cancel, and goes to /login on 401', async () => {
    // 契約が無い
    fetchMock.mockImplementation(async () =>
      jsonResponse({ data: summaryOf({ status: null, plan_key: 'free', effective_plan_key: 'free', source: null, has_customer: false, can_purchase: true, can_cancel: false }) }),
    )
    await render()
    expect(container.textContent).toContain('有料プランの契約はありません。')
    expect(buttonTexts()).toEqual([])
    await act(async () => {
      root.unmount()
    })

    // 手動の契約 (Stripe でない): 解約のボタンは出さない
    root = createRoot(container)
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => jsonResponse({ data: summaryOf({ source: 'manual', has_customer: false, can_cancel: false }) }))
    await render()
    expect(container.textContent).toContain('ご利用中')
    expect(buttonTexts()).toEqual([])
    await act(async () => {
      root.unmount()
    })

    // アプリの WebView: 状態の文だけ
    root = createRoot(container)
    nativeMock.value = true
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => jsonResponse({ data: summaryOf() }))
    await render()
    expect(container.textContent).toContain('ご利用中')
    expect(buttonTexts()).toEqual([])
    await act(async () => {
      root.unmount()
    })
    nativeMock.value = false

    // 解約の失敗: 409 は表の文、429・500 は汎用の文
    const cases: { status: number; body: unknown; text: string }[] = [
      { status: 409, body: { error: { code: 'BILL_NO_LIVE_SUBSCRIPTION', message: 'x' } }, text: '有効な契約がありません' },
      { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'x' } }, text: UNKNOWN_ERROR_TEXT },
      { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'x' } }, text: UNKNOWN_ERROR_TEXT },
    ]
    confirmMock.mockReturnValue(true)
    for (const { status, body, text } of cases) {
      root = createRoot(container)
      fetchMock.mockReset()
      fetchMock.mockImplementation(async (input: string, init?: RequestInit) =>
        input === '/api/billing/subscription/cancel' && init?.method === 'POST' ? jsonResponse(body, status) : jsonResponse({ data: summaryOf() }),
      )
      await render()
      await click(buttonByText('解約する'))
      expect(alertText(), `${status}`).toBe(text)
      // 失敗のあとはまた押せる
      expect(buttonByText('解約する').disabled).toBe(false)
      await act(async () => {
        root.unmount()
      })
    }

    // 401: ログインへ
    root = createRoot(container)
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => jsonResponse({ error: { code: 'AUTH_UNAUTHENTICATED', message: 'x' } }, 401))
    await render()
    expect(pushMock).toHaveBeenCalledWith('/login')
  })

  it('frozen billing page shows the store management wording and no cancel button for a store row', async () => {
    for (const store of PURCHASE_STORES) {
      for (const native of [false, true]) {
        root = createRoot(container)
        nativeMock.value = native
        fetchMock.mockReset()
        // ストアの契約 (summarizeSubscription は can_cancel / can_resume を立てない。has_customer は Stripe の顧客の名残りでも真になりうる)。
        // ここでは can_cancel を真にして、画面が manage_in_store で解約のボタンを止めることを見る
        fetchMock.mockImplementation(async () =>
          jsonResponse({ data: summaryOf({ source: store, manage_in_store: store, has_customer: false, can_cancel: true }) }),
        )
        await render()
        const label = `${store}${native ? ' (アプリ)' : ''}`
        expect(container.textContent, label).toContain('ご利用中')
        expect(container.textContent, label).toContain(`${IAP_STORE_LABELS[store]} の定期購読の管理から解約できます。`)
        expect(buttonTexts(), label).not.toContain('解約する')
        const manageLink = container.querySelector(`a[href="${STORE_SUBSCRIPTION_MANAGEMENT_URL[store]}"]`)
        if (native) {
          // アプリの WebView では文だけ (管理のページへのリンクも出さない)
          expect(manageLink, label).toBeNull()
        } else {
          expect(manageLink?.textContent, label).toBe('定期購読の管理を開く')
          expect(manageLink?.getAttribute('target'), label).toBe('_blank')
        }
        expect(calledPaths(), label).toEqual(['/api/billing/subscription'])
        await act(async () => {
          root.unmount()
        })
      }
    }
    nativeMock.value = false
    // Stripe の契約には出さない
    root = createRoot(container)
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => jsonResponse({ data: summaryOf() }))
    await render()
    expect(container.textContent).not.toContain('の定期購読の管理から解約できます。')
    expect(buttonTexts()).toContain('解約する')
  })
})
