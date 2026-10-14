/**
 * #1594: チャレンジ (/health/challenges) の「残り N 日」と「期限切れ」を、日本の暦日 (todayLocal) で求める。
 *
 * 終了日 (end_date) は date 型で、作成時に JST の今日から求めた日本の暦日 (src/app/api/health/challenges/route.ts の challengePeriod)。
 * 以前は終了日を new Date(endDate) (その日の UTC の 0 時 = 日本の 9 時) にして今の時刻と比べていたので、
 *   - 終了日が昨日のチャレンジは、日本の 9:00 まで「期限切れ」にならなかった
 *   - 残りの日数が日本の 9:00 を境に変わった (終了日が今日なら 0:00〜8:59 は「残り1日」、9:00 から「残り0日」)
 * 時計 (Date だけ) を日本の 0:30 と 9:30 に固定し、どちらの時刻でも同じ表示になることを確かめる (テストは TZ=UTC で流れる)。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する (frozen-account-page.test.tsx と同じ)。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))

const { default: HealthChallengesPage } = await import('@/app/(main)/health/challenges/page')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 時計 (Date) を固定する時刻。どちらも日本の暦日では 2026-10-14。
 *   - JST 0:30 : UTC では前日 (10-13) の 15:30。以前は、終了日が昨日のものが「残り0日」、今日のものが「残り1日」だった
 *   - JST 9:30 : UTC でも同じ日 (10-14) の 0:30
 */
const CLOCKS = [
  { label: 'JST 0:30 (UTC の前日の 15:30)', at: '2026-10-13T15:30:00.000Z' },
  { label: 'JST 9:30 (UTC の同じ日の 0:30)', at: '2026-10-14T00:30:00.000Z' },
] as const

/**
 * チャレンジと、期待する表示。終了日は、日本の今日 (2026-10-14) から手で数えた固定値 (実装の関数で求めない)
 */
const CASES: ReadonlyArray<{ id: string; title: string; endDate: string; expected: string }> = [
  { id: 'ended-yesterday', title: '昨日までのチャレンジ', endDate: '2026-10-13', expected: '期限切れ' },
  { id: 'ends-today', title: '今日までのチャレンジ', endDate: '2026-10-14', expected: '残り0日' },
  { id: 'ends-tomorrow', title: '明日までのチャレンジ', endDate: '2026-10-15', expected: '残り1日' },
]

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () =>
    Response.json({
      challenges: CASES.map((c) => ({
        id: c.id,
        challenge_type: 'steps',
        title: c.title,
        description: '',
        start_date: '2026-10-01',
        end_date: c.endDate,
        target_metric: 'steps',
        target_value: 10,
        target_unit: '回',
        current_value: 1,
        status: 'active',
      })),
      templates: [],
    }),
  )
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

/** チャレンジの題名の行から、そのチャレンジの右上の表示 (期限切れ / 残り N 日) の文字を取る */
function badgeTextOf(title: string): string {
  const titleEl = Array.from(container.querySelectorAll('p')).find((p) => p.textContent === title)
  expect(titleEl, title).toBeDefined()
  // 題名の <p> → 題名と説明の <div> → その隣 (右上の表示)
  const badge = titleEl!.parentElement!.nextElementSibling
  expect(badge, title).not.toBeNull()
  return (badge!.textContent ?? '').trim()
}

describe.each(CLOCKS)('チャレンジ — 残りの日数と期限切れは日本の暦日で求める (#1594): $label', ({ at }) => {
  it('終了日が昨日 = 期限切れ / 今日 = 残り0日 / 明日 = 残り1日', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(at))
    expect(new Date().toISOString()).toBe(at)

    await act(async () => {
      root.render(<HealthChallengesPage />)
    })
    // 一覧の取得 (fetch) のあとの描画を流しきる
    await act(async () => {
      await Promise.resolve()
    })

    const actual = CASES.map((c) => ({ id: c.id, badge: badgeTextOf(c.title) }))
    expect(actual).toEqual(CASES.map((c) => ({ id: c.id, badge: c.expected })))
  })
})
