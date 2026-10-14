/**
 * #1594: 食材管理 (/pantry) の「期限間近」の判定を、日本の暦日 (todayLocal) で行う。
 *
 * 以前は期限の日付を new Date(dateStr) (その日の UTC の 0 時 = 日本の 9 時) にして今の時刻と比べていたので、
 *   - 期限が今日の食材は、日本の 9:00 に「期限間近」から外れた
 *   - 3 日後が期限の食材は、日本の 9:00 まで「期限間近」にならなかった
 * 時計 (Date だけ) を日本の 0:30 と 9:30 に固定し、どちらの時刻でも同じ表示になることを確かめる (テストは TZ=UTC で流れる)。
 * この画面には「期限切れ」の表示は無い (期限が過ぎた食材は「期限間近」にもしない。以前と同じ)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (frozen-account-page.test.tsx と同じ)。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
// 同意の状況の取得 (AI の入口) はこの検査に関係しないので止める
vi.mock('@/hooks/useAiConsent', () => ({
  useAiConsent: () => ({ ensureAiConsent: vi.fn(async () => 'consented'), consentModal: null }),
}))

const { default: PantryPage } = await import('@/app/(main)/pantry/page')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 時計 (Date) を固定する時刻。どちらも日本の暦日では 2026-10-14。
 *   - JST 0:30 : UTC では前日 (10-13) の 15:30。以前の判定では、3 日後が期限の食材が「期限間近」にならなかった
 *   - JST 9:30 : UTC でも同じ日 (10-14) の 0:30。以前の判定では、期限が今日の食材が「期限間近」から外れていた
 */
const CLOCKS = [
  { label: 'JST 0:30 (UTC の前日の 15:30)', at: '2026-10-13T15:30:00.000Z' },
  { label: 'JST 9:30 (UTC の同じ日の 0:30)', at: '2026-10-14T00:30:00.000Z' },
] as const

/**
 * 食材と、「期限間近」を出すか。期限の日付は、日本の今日 (2026-10-14) から手で数えた固定値 (実装の関数で求めない)。
 * 「期限間近」の範囲は今日から 3 日後の期限まで (両端を含む)
 */
const CASES: ReadonlyArray<{ id: string; name: string; expirationDate: string; expiringSoon: boolean }> = [
  { id: 'yesterday', name: '昨日が期限の牛乳', expirationDate: '2026-10-13', expiringSoon: false },
  { id: 'today', name: '今日が期限の豆腐', expirationDate: '2026-10-14', expiringSoon: true },
  { id: 'threshold', name: '3日後が期限の卵', expirationDate: '2026-10-17', expiringSoon: true },
  { id: 'after-threshold', name: '4日後が期限のチーズ', expirationDate: '2026-10-18', expiringSoon: false },
]

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: unknown) => {
    if (String(input) === '/api/pantry') {
      return Response.json({
        items: CASES.map((c) => ({
          id: c.id,
          name: c.name,
          amount: null,
          category: 'other',
          expirationDate: c.expirationDate,
          addedAt: '2026-10-01',
        })),
      })
    }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
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
  vi.useRealTimers()
})

/** 食材の名前の行から、その食材のカード (role="button") を探す */
function cardOf(name: string): HTMLElement {
  const nameEl = Array.from(container.querySelectorAll('p')).find((p) => p.textContent === name)
  expect(nameEl, name).toBeDefined()
  const card = nameEl!.closest<HTMLElement>('[role="button"]')
  expect(card, name).not.toBeNull()
  return card!
}

describe.each(CLOCKS)('食材管理 (/pantry) — 「期限間近」は日本の暦日で判定する (#1594): $label', ({ at }) => {
  it('昨日 = なし / 今日・3 日後 = 期限間近 / 4 日後 = なし', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(at))
    expect(new Date().toISOString()).toBe(at)

    await act(async () => {
      root.render(<PantryPage />)
    })
    // 一覧の取得 (fetch) のあとの描画を流しきる
    await act(async () => {
      await Promise.resolve()
    })

    const actual = CASES.map((c) => ({
      id: c.id,
      expiringSoon: cardOf(c.name).querySelector('[data-testid="expiry-soon-badge"]') !== null,
    }))
    expect(actual).toEqual(CASES.map((c) => ({ id: c.id, expiringSoon: c.expiringSoon })))
  })
})
