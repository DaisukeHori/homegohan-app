/**
 * 運営の機能フラグ画面 (src/app/super-admin/flags/page.tsx) の「対象ユーザー数」の表示 (#1148)
 *
 * GET /api/super-admin/flags の active_user_count (今 ON になっているユーザー数) を一覧に出す。
 *   - 数えられたフラグは「1,234 人」のように出す (0 人も出す)
 *   - 数えられなかったフラグ (null: ユーザーが多すぎる・集計の失敗) は「—」
 *   - ON/OFF を切り替えたら一覧を読み直し、人数を新しい値にする
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { default: FlagsPage } = await import('@/app/super-admin/flags/page')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface FlagRow {
  key: string
  description: string
  enabled: boolean
  rollout_strategy: { type: string; value?: number } | null
  constraints: Record<string, unknown> | null
  active_user_count: number | null
  updated_at: string
}

function row(key: string, overrides: Partial<FlagRow> = {}): FlagRow {
  return {
    key,
    description: '',
    enabled: true,
    rollout_strategy: null,
    constraints: null,
    active_user_count: 0,
    updated_at: '2026-10-10T00:00:00Z',
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  fetchMock.mockReset()
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
})

async function render() {
  await act(async () => {
    root.render(<FlagsPage />)
  })
  // 一覧の読み込み (fetch → json) を待つ
  await act(async () => {
    await Promise.resolve()
  })
}

function cellTextOf(key: string): string[] {
  const rows = [...container.querySelectorAll('tbody tr')]
  const target = rows.find((tr) => tr.querySelector('code')?.textContent === key)
  if (!target) throw new Error(`${key} の行が無い`)
  return [...target.querySelectorAll('td')].map((td) => td.textContent ?? '')
}

function userCountColumnIndex(): number {
  const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent)
  const index = headers.indexOf('対象ユーザー数')
  if (index < 0) throw new Error('「対象ユーザー数」の列が無い')
  return index
}

describe('機能フラグ画面: 対象ユーザー数 (#1148)', () => {
  it('数えられたフラグは人数を、数えられなかったフラグ (null) は「—」を出す', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          row('many', { active_user_count: 1234 }),
          row('off_flag', { enabled: false, active_user_count: 0 }),
          row('too_many', { rollout_strategy: { type: 'percentage', value: 10 }, active_user_count: null }),
        ],
      }),
    )

    await render()

    const column = userCountColumnIndex()
    expect(cellTextOf('many')[column]).toBe('1,234 人')
    expect(cellTextOf('off_flag')[column]).toBe('0 人')
    expect(cellTextOf('too_many')[column]).toBe('—')
  })

  it('ON/OFF を切り替えたら一覧を読み直し、人数を新しい値にする', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [row('f', { enabled: true, active_user_count: 50 })] }))
      .mockResolvedValueOnce(jsonResponse({ data: { key: 'f', enabled: false } }))
      .mockResolvedValueOnce(jsonResponse({ data: [row('f', { enabled: false, active_user_count: 0 })] }))

    await render()
    const column = userCountColumnIndex()
    expect(cellTextOf('f')[column]).toBe('50 人')

    const toggle = container.querySelector('tbody tr button')
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('切り替えのボタンが無い')
    await act(async () => {
      toggle.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(fetchMock.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
      ['/api/super-admin/flags', 'GET'],
      ['/api/super-admin/flags/f', 'PATCH'],
      ['/api/super-admin/flags', 'GET'],
    ])
    expect(cellTextOf('f')[column]).toBe('0 人')
  })

  it('切り替えのあとの読み直しに失敗しても、エラー画面にせず、切り替えた結果を出したままにする', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [row('f', { enabled: true, active_user_count: 50 })] }))
      .mockResolvedValueOnce(jsonResponse({ data: { key: 'f', enabled: false } }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500))

    await render()
    const toggle = container.querySelector('tbody tr button')
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('切り替えのボタンが無い')
    await act(async () => {
      toggle.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('boom')
    expect(cellTextOf('f').join(' ')).toContain('OFF')
  })
})
