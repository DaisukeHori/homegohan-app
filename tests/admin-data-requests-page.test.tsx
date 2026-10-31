/**
 * #1178 / #1702 段 C 運営の「開示等の請求」の画面 (/admin/data-requests・/admin/data-requests/[id]) の component テスト
 * (設計 docs/design/cross/15-data-subject-requests.md §9.2・§15)。
 *
 * 確認すること:
 *   - 一覧の既定のタブは「受付済み」(status=received で読む)。タブを切り替えると絞り込みが変わる (期限超過は overdue=1)
 *   - 期限超過の行は期限を赤で出す。退会済みの請求者は「退会済み」
 *   - 詳細の保存は PATCH で、ヘッダ If-Unmodified-Since に最後に取得した updated_at をそのまま送る
 *   - 状態を変えずに保存すると、本文に status を入れない (応答・内部メモだけ)。状態を変えたときだけ入れる
 *   - 412 / 409 は「別の運営者が更新しました。再読み込みしてください」、422 は「応答を書いてください」
 *   - 本人確認待ちと終わった請求 (対応済み・対応できず・取り下げ) は select・応答・内部メモ・保存が disabled
 *   - 状態の select は遷移表に無い選択肢を disabled にする
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DsrAdminDetailDto, DsrAdminSummaryDto, DsrStatus } from '@/lib/data-subject-requests/core';

// useRouter は本物と同じく、描画のたびに同じ物を返す (毎回新しい物を返すと、router を依存に持つ読み込みが描画のたびに走る)
const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { id: '', push, router: { push } };
});

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: nav.id }),
  usePathname: () => '/admin/data-requests',
}));

const { default: AdminDataRequestsPage } = await import('@/app/admin/data-requests/page');
const { default: AdminDataRequestDetailPage } = await import('@/app/admin/data-requests/[id]/page');
const { DSR_ADMIN_API_PATH, DSR_ADMIN_LIST_LIMITS } = await import('@/lib/data-subject-requests/core');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const UPDATED_AT = '2026-10-15T01:02:03.456789+00:00';

function summary(overrides: Partial<DsrAdminSummaryDto> = {}): DsrAdminSummaryDto {
  return {
    id: REQUEST_ID,
    user_id: USER_ID,
    requester_nickname: 'たろう',
    request_type: 'disclosure',
    status: 'received',
    verified_at: '2026-10-01T00:00:00.000Z',
    due_at: '2026-10-31T00:00:00.000Z',
    overdue: false,
    resolved_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function detail(overrides: Partial<DsrAdminDetailDto> = {}): DsrAdminDetailDto {
  return {
    ...summary(),
    details: '登録している情報を開示してください',
    verification_method: 'email_link',
    verification_sent_at: '2026-10-01T00:00:00.000Z',
    verification_expires_at: '2026-10-02T00:00:00.000Z',
    verification_send_count: 1,
    response_note: null,
    admin_notes: '前回も同じ請求あり',
    requester: { user_id: USER_ID, nickname: 'たろう', email: 'taro@example.com' },
    ...overrides,
  };
}

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: unknown };
let fetchCalls: FetchCall[];
let respond: (call: FetchCall) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function render(element: ReturnType<typeof createElement>) {
  await act(async () => {
    root.render(element);
  });
  await flush();
}

const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function click(el: HTMLElement | null | undefined) {
  expect(el, 'クリック対象が見つからない').toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function selectValue(el: HTMLElement | null, value: string) {
  const select = el as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function typeInto(el: HTMLElement | null, value: string) {
  const textarea = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const listCalls = () => fetchCalls.filter((c) => c.method === 'GET' && c.url.startsWith(`${DSR_ADMIN_API_PATH}?`));
const queryOf = (call: FetchCall) => new URL(call.url, 'http://localhost').searchParams;
const patchCalls = () => fetchCalls.filter((c) => c.method === 'PATCH');

beforeEach(() => {
  fetchCalls = [];
  nav.id = REQUEST_ID;
  nav.push.mockReset();
  respond = () => {
    throw new Error('respond を設定していない');
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const call: FetchCall = {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      fetchCalls.push(call);
      return respond(call);
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// 一覧
// ─────────────────────────────────────────────────────────────────────────────

describe('/admin/data-requests (一覧)', () => {
  it('既定のタブは「受付済み」で、status=received・page=1・per_page=既定 で読む', async () => {
    respond = () => json({ data: [summary()], meta: { total: 1, page: 1, per_page: DSR_ADMIN_LIST_LIMITS.default } });
    await render(createElement(AdminDataRequestsPage));
    expect(listCalls()).toHaveLength(1);
    const query = queryOf(listCalls()[0]);
    expect(query.get('status')).toBe('received');
    expect(query.get('overdue')).toBeNull();
    expect(query.get('page')).toBe('1');
    expect(query.get('per_page')).toBe(String(DSR_ADMIN_LIST_LIMITS.default));
    expect(byTestId('admin-dsr-tab-received')?.getAttribute('aria-selected')).toBe('true');
    expect(byTestId('admin-dsr-list')?.textContent).toContain('たろう');
    expect(byTestId('admin-dsr-list')?.textContent).toContain('開示');
  });

  it('タブ「期限超過」は overdue=1 で読み (status を付けない)、「すべて」は絞り込みなし、「終了」は状態を選べる', async () => {
    respond = () => json({ data: [], meta: { total: 0, page: 1, per_page: DSR_ADMIN_LIST_LIMITS.default } });
    await render(createElement(AdminDataRequestsPage));

    await click(byTestId('admin-dsr-tab-overdue'));
    let query = queryOf(listCalls().at(-1)!);
    expect(query.get('overdue')).toBe('1');
    expect(query.get('status')).toBeNull();

    await click(byTestId('admin-dsr-tab-all'));
    query = queryOf(listCalls().at(-1)!);
    expect(query.get('overdue')).toBeNull();
    expect(query.get('status')).toBeNull();

    await click(byTestId('admin-dsr-tab-finished'));
    expect(queryOf(listCalls().at(-1)!).get('status')).toBe('fulfilled');
    await selectValue(byTestId('admin-dsr-finished-status'), 'withdrawn');
    await flush();
    expect(queryOf(listCalls().at(-1)!).get('status')).toBe('withdrawn');

    await click(byTestId('admin-dsr-tab-pending_verification'));
    expect(queryOf(listCalls().at(-1)!).get('status')).toBe('pending_verification');
  });

  it('期限超過の行は期限を赤で出し、そうでない行は赤にしない。退会済みは「退会済み」', async () => {
    respond = () =>
      json({
        data: [
          summary({ id: '11111111-1111-4111-8111-111111111111', overdue: true, due_at: '2026-10-01T00:00:00.000Z' }),
          summary({ id: '22222222-2222-4222-8222-222222222222', user_id: null, requester_nickname: null }),
        ],
        meta: { total: 2, page: 1, per_page: DSR_ADMIN_LIST_LIMITS.default },
      });
    await render(createElement(AdminDataRequestsPage));
    const dues = Array.from(document.querySelectorAll('[data-testid="admin-dsr-due"]'));
    expect(dues).toHaveLength(2);
    expect(dues[0].getAttribute('data-overdue')).toBe('true');
    expect(dues[0].className).toContain('text-red-600');
    expect(dues[0].textContent).toContain('期限超過');
    expect(dues[1].getAttribute('data-overdue')).toBe('false');
    expect(dues[1].className).not.toContain('text-red-600');
    const rows = Array.from(document.querySelectorAll('[data-testid="admin-dsr-row"]'));
    expect(rows[1].textContent).toContain('退会済み');
  });

  it('行を押すと詳細 (/admin/data-requests/[id]) へ移る', async () => {
    respond = () => json({ data: [summary()], meta: { total: 1, page: 1, per_page: DSR_ADMIN_LIST_LIMITS.default } });
    await render(createElement(AdminDataRequestsPage));
    await click(byTestId('admin-dsr-row'));
    expect(nav.push).toHaveBeenCalledWith(`/admin/data-requests/${REQUEST_ID}`);
  });

  it('403 は権限の文を出す', async () => {
    respond = () => json({ error: { code: 'OP_PERMISSION_DENIED', message: '権限がありません' } }, 403);
    await render(createElement(AdminDataRequestsPage));
    expect(document.body.textContent).toContain('権限がありません');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 詳細・対応
// ─────────────────────────────────────────────────────────────────────────────

describe('/admin/data-requests/[id] (詳細・対応)', () => {
  const detailUrl = `${DSR_ADMIN_API_PATH}/${REQUEST_ID}`;

  it('請求の内容・請求者・内部メモを出す', async () => {
    respond = () => json({ data: detail() });
    await render(createElement(AdminDataRequestDetailPage));
    expect(fetchCalls[0]).toMatchObject({ url: detailUrl, method: 'GET' });
    const page = byTestId('admin-dsr-detail');
    expect(page?.textContent).toContain('登録している情報を開示してください');
    expect(byTestId('admin-dsr-requester')?.textContent).toContain('taro@example.com');
    expect((byTestId('admin-dsr-admin-notes') as HTMLTextAreaElement).value).toBe('前回も同じ請求あり');
  });

  it('利用停止の案内は凍結を手段に挙げない', async () => {
    respond = () => json({ data: detail({ request_type: 'suspension' }) });
    await render(createElement(AdminDataRequestDetailPage));
    const guide = byTestId('admin-dsr-guide')?.textContent ?? '';
    expect(guide).toContain('凍結は利用停止の手段に使わないでください');
  });

  it('保存は PATCH で、If-Unmodified-Since に取得した updated_at をそのまま送る。状態を変えたときだけ status を入れる', async () => {
    respond = (call) => {
      if (call.method === 'PATCH') return json({ data: detail({ status: 'fulfilled', response_note: '開示します', updated_at: '2026-10-16T00:00:00.000000+00:00' }) });
      return json({ data: detail() });
    };
    await render(createElement(AdminDataRequestDetailPage));
    await selectValue(byTestId('admin-dsr-status-select'), 'fulfilled');
    await typeInto(byTestId('admin-dsr-response-note'), '開示します');
    await click(byTestId('admin-dsr-save'));

    expect(patchCalls()).toHaveLength(1);
    const call = patchCalls()[0];
    expect(call.url).toBe(detailUrl);
    expect(call.headers['if-unmodified-since']).toBe(UPDATED_AT);
    expect(call.body).toEqual({ status: 'fulfilled', response_note: '開示します', admin_notes: '前回も同じ請求あり' });
    expect(byTestId('admin-dsr-status')?.textContent).toBe('対応済み');
  });

  it('状態を変えずに保存すると、本文に status を入れない', async () => {
    respond = (call) => (call.method === 'PATCH' ? json({ data: detail({ admin_notes: '電話済み' }) }) : json({ data: detail() }));
    await render(createElement(AdminDataRequestDetailPage));
    await typeInto(byTestId('admin-dsr-admin-notes'), '電話済み');
    await click(byTestId('admin-dsr-save'));
    expect(patchCalls()).toHaveLength(1);
    expect(patchCalls()[0].body).toEqual({ response_note: '', admin_notes: '電話済み' });
    expect(patchCalls()[0].body).not.toHaveProperty('status');
  });

  it('保存のあとの 2 回目の保存は、保存の応答が返した updated_at を送る', async () => {
    const nextUpdatedAt = '2026-10-16T00:00:00.000000+00:00';
    respond = (call) =>
      call.method === 'PATCH' ? json({ data: detail({ updated_at: nextUpdatedAt }) }) : json({ data: detail() });
    await render(createElement(AdminDataRequestDetailPage));
    await click(byTestId('admin-dsr-save'));
    await click(byTestId('admin-dsr-save'));
    expect(patchCalls().map((c) => c.headers['if-unmodified-since'])).toEqual([UPDATED_AT, nextUpdatedAt]);
  });

  it.each([
    ['412', 412, 'CONFLICT_OPTIMISTIC_LOCK'],
    ['409 (UPDATE が 0 行)', 409, 'CONFLICT_STALE_DATA'],
    ['409 (状態が変わった)', 409, 'DSR_INVALID_TRANSITION'],
  ])('%s は「別の運営者が更新しました。再読み込みしてください」', async (_label, status, code) => {
    respond = (call) =>
      call.method === 'PATCH' ? json({ error: { code, message: 'x' } }, status) : json({ data: detail() });
    await render(createElement(AdminDataRequestDetailPage));
    await click(byTestId('admin-dsr-save'));
    expect(byTestId('admin-dsr-save-error')?.textContent).toBe('別の運営者が更新しました。再読み込みしてください');
  });

  it('422 は「応答を書いてください」', async () => {
    respond = (call) =>
      call.method === 'PATCH'
        ? json({ error: { code: 'DSR_RESPONSE_NOTE_REQUIRED', message: 'x' } }, 422)
        : json({ data: detail() });
    await render(createElement(AdminDataRequestDetailPage));
    await selectValue(byTestId('admin-dsr-status-select'), 'rejected');
    await click(byTestId('admin-dsr-save'));
    expect(byTestId('admin-dsr-save-error')?.textContent).toBe('応答を書いてください');
  });

  it.each<[string, DsrStatus]>([
    ['本人確認待ち', 'pending_verification'],
    ['対応済み', 'fulfilled'],
    ['対応できず', 'rejected'],
    ['取り下げ', 'withdrawn'],
  ])('%s の請求は select・応答・内部メモ・保存が disabled で、保存を押しても PATCH しない', async (_label, status) => {
    respond = () => json({ data: detail({ status }) });
    await render(createElement(AdminDataRequestDetailPage));
    expect((byTestId('admin-dsr-status-select') as HTMLSelectElement).disabled).toBe(true);
    expect((byTestId('admin-dsr-response-note') as HTMLTextAreaElement).disabled).toBe(true);
    expect((byTestId('admin-dsr-admin-notes') as HTMLTextAreaElement).disabled).toBe(true);
    expect((byTestId('admin-dsr-save') as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId('admin-dsr-read-only')).not.toBeNull();
    await click(byTestId('admin-dsr-save'));
    expect(patchCalls()).toEqual([]);
  });

  it.each<[DsrStatus, Record<string, boolean>]>([
    ['received', { received: false, in_progress: false, fulfilled: false, rejected: false }],
    ['in_progress', { in_progress: false, fulfilled: false, rejected: false }],
  ])('%s の select は遷移表にある遷移先だけを選べる', async (status, expected) => {
    respond = () => json({ data: detail({ status }) });
    await render(createElement(AdminDataRequestDetailPage));
    const options = Array.from((byTestId('admin-dsr-status-select') as HTMLSelectElement).options);
    expect(Object.fromEntries(options.map((o) => [o.value, o.disabled]))).toEqual(expected);
    expect((byTestId('admin-dsr-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('期限超過は期限を赤で出す', async () => {
    respond = () => json({ data: detail({ status: 'in_progress', overdue: true, due_at: '2026-10-01T00:00:00.000Z' }) });
    await render(createElement(AdminDataRequestDetailPage));
    const due = byTestId('admin-dsr-due');
    expect(due?.getAttribute('data-overdue')).toBe('true');
    expect(due?.className).toContain('text-red-600');
  });

  it('退会済みの請求者は「退会済み」', async () => {
    respond = () => json({ data: detail({ user_id: null, requester_nickname: null, requester: null }) });
    await render(createElement(AdminDataRequestDetailPage));
    expect(byTestId('admin-dsr-requester')?.textContent).toBe('退会済み');
  });

  it('404 は「請求が見つかりません」', async () => {
    respond = () => json({ error: { code: 'NOT_FOUND', message: '請求が見つかりません' } }, 404);
    await render(createElement(AdminDataRequestDetailPage));
    expect(document.body.textContent).toContain('請求が見つかりません');
    expect(byTestId('admin-dsr-detail')).toBeNull();
  });
});
