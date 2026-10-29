/**
 * #1917 一覧の画面が、件数より後ろのページを「0 件」と見せずに最後のページへ取り直すことのテスト
 *
 * 一覧の API は、件数より後ろのページを失敗にせず、空のページと本当の件数で返す (src/lib/api/list-range.ts)。
 * 画面 (運営の問い合わせのチケット・監査ログ・メンバーシップの監査) は、空のページで今のページが件数より後ろなら、
 * 件数から最後のページへ取り直す (src/lib/list-pagination.ts。運営の組織の一覧と同じ扱い)。
 *
 * 確かめる流れ: 1 ページ目 (2 ページぶんの件数) → 「次へ」で 2 ページ目を読むと、その間に行が消えていて空のページと
 * 1 ページぶんの件数が返る → 画面は 1 ページ目を取り直して、その行を出す。
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastPageOf, lastPageToRefetch } from '@/lib/list-pagination';

// 描画のたびに同じ router を返す (画面の useCallback が router に依存するので、毎回別の値を返すと読み込みが止まらない)
const router = vi.hoisted(() => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

// React に「テスト環境 (act で包む)」であることを伝える
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 各画面の 1 ページの件数 (画面の定数と同じ) */
const PER_PAGE = 50;

interface PageCase {
  name: string;
  load: () => Promise<ComponentType>;
  /** 一覧の API のパス */
  apiPath: string;
  /** ページの番号のクエリの名前以外の見分け (この画面の行の目印の文字) */
  row: (n: number) => Record<string, unknown>;
  /** 行の目印 (画面に出る文字) */
  marker: (n: number) => string;
  /** 「次へ」のボタンの文字 */
  nextLabel: string;
}

const CASES: PageCase[] = [
  {
    name: '/admin/support (問い合わせのチケット)',
    load: async () => (await import('@/app/admin/support/page')).default,
    apiPath: '/api/admin/support/tickets',
    row: (n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      user_id: '00000000-0000-4000-8000-0000000000ff',
      subject: `件名${n}`,
      category: 'account',
      priority: 'medium',
      status: 'open',
      assignee_id: null,
      created_at: '2026-10-08T04:30:00.000Z',
      updated_at: '2026-10-08T04:30:00.000Z',
    }),
    marker: (n) => `件名${n}`,
    nextLabel: '次へ',
  },
  {
    name: '/super-admin/audit-logs (監査ログ)',
    load: async () => (await import('@/app/super-admin/audit-logs/page')).default,
    apiPath: '/api/super-admin/audit-logs',
    row: (n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      actor_id: null,
      actor_email_snapshot: null,
      actor_role_snapshot: null,
      action_type: `action.number${n}`,
      target_id: null,
      target_type: null,
      details: {},
      severity: 'info',
      ip_address: null,
      user_agent: null,
      session_id: null,
      impersonated_by: null,
      created_at: '2026-10-08T04:30:00.000Z',
    }),
    marker: (n) => `action.number${n}`,
    nextLabel: '次へ →',
  },
  {
    name: '/operator/membership/audit (メンバーシップの監査)',
    load: async () => (await import('@/app/(operator)/operator/membership/audit/page')).default,
    apiPath: '/api/operator/membership/audit',
    row: (n) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      scope: 'family',
      scope_id: '00000000-0000-4000-8000-0000000000ee',
      action: 'invite_accepted',
      // 行の目印は操作した人の ID の先頭 8 文字 (画面は「<先頭 8 文字>...」と出す)。操作 (action) は日本語の表示名で出すので
      // 目印にできない (#2086 V5。表に無い値は「不明な操作」になる)
      actor_id: `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`,
      target_user_id: null,
      metadata: {},
      created_at: '2026-10-08T04:30:00.000Z',
    }),
    marker: (n) => `${String(n).padStart(8, '0')}...`,
    nextLabel: '次へ',
  },
];

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** fetch の呼び出しのうち、一覧の API の page の値 (呼んだ順) */
function requestedPages(apiPath: string): number[] {
  return fetchMock.mock.calls
    .map(([url]) => new URL(String(url), 'http://localhost'))
    .filter((url) => url.pathname === apiPath)
    .map((url) => Number(url.searchParams.get('page')));
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('lastPageToRefetch', () => {
  it('空のページで、今のページが件数より後ろなら最後のページ。それ以外は取り直さない', () => {
    expect(lastPageToRefetch({ rows: 0, page: 3, total: 60, perPage: PER_PAGE })).toBe(2);
    expect(lastPageToRefetch({ rows: 0, page: 2, total: 0, perPage: PER_PAGE })).toBe(1);
    // 行があるページ・最後のページ以内・1 ページ目は取り直さない (取り直しは必ず止まる)
    expect(lastPageToRefetch({ rows: 1, page: 3, total: 60, perPage: PER_PAGE })).toBeNull();
    expect(lastPageToRefetch({ rows: 0, page: 2, total: 60, perPage: PER_PAGE })).toBeNull();
    expect(lastPageToRefetch({ rows: 0, page: 1, total: 0, perPage: PER_PAGE })).toBeNull();
    expect(lastPageOf(0, PER_PAGE)).toBe(1);
    expect(lastPageOf(PER_PAGE + 1, PER_PAGE)).toBe(2);
  });
});

describe.each(CASES)('$name', ({ load, apiPath, row, marker, nextLabel }) => {
  it('件数より後ろのページ (行が消えたあとの読み直し) は、空のページを見せずに最後のページを取り直す', async () => {
    const firstPage = Array.from({ length: PER_PAGE }, (_, i) => row(i + 1));
    let pageOneCalls = 0;
    fetchMock = vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== apiPath) throw new Error(`想定外の呼び出し: ${url.pathname}`);
      const page = Number(url.searchParams.get('page'));
      if (page === 1) {
        pageOneCalls += 1;
        // 1 回目は 2 ページぶん (51 件)。2 ページ目の唯一の行が消えたあとの 2 回目は 50 件
        const total = pageOneCalls === 1 ? PER_PAGE + 1 : PER_PAGE;
        return jsonResponse(200, { data: firstPage, meta: { total, page, per_page: PER_PAGE } });
      }
      // 2 ページ目: 唯一の行が消えていて、API は空のページと本当の件数 (1 ページぶん) を返す
      return jsonResponse(200, { data: [], meta: { total: PER_PAGE, page, per_page: PER_PAGE } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const Page = await load();
    await act(async () => {
      root.render(<Page />);
    });
    await flush();
    expect(container.textContent).toContain(marker(1));

    const next = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === nextLabel);
    expect(next, '「次へ」のボタン').toBeDefined();
    await act(async () => {
      next!.click();
    });
    await flush();

    // 2 ページ目を読んだあと、1 ページ目 (最後のページ) を取り直し、その行を出している
    expect(requestedPages(apiPath)).toEqual([1, 2, 1]);
    expect(container.textContent).toContain(marker(1));
  });
});
