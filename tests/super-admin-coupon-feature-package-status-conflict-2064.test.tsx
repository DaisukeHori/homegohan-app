/**
 * #2064 R2: クーポン詳細 (/super-admin/coupons/[id]) の「一時停止」「再開する」と、機能パッケージ詳細
 * (/super-admin/feature-packages/[id]) の「廃止する」が、409 (遷移表に無い変更・同時の変更) を受けたときの画面のテスト
 *
 * PATCH は状態の遷移を検査し、画面の status が古いとき (別の操作で期限切れ・一時停止・廃止にされていた) は
 * 409 OP_COUPON_INVALID_TRANSITION / OP_FEATURE_PACKAGE_INVALID_TRANSITION か 409 CONFLICT_STALE_DATA で断る (書かない)。
 * 以前の画面は 409 の文を出すだけで読み直さず、古い status のボタンを出し続けた。
 *
 * 直したあとの不変条件:
 *  - この 2 つの 409 を受けたら、行を読み直して状態の表示とボタンを今の状態にする (全体を「読み込み中」にしない)
 *  - 文は日本語の固定の文 (英字の状態の値を出さない)。読み直しが失敗したら、その旨を出す
 *  - 入力欄の書きかけは消さない。手を付けていない欄は読み直した行の値に揃える (成功のときと同じ。#1917)
 *  - ほかの 409 (別の code) は従来どおり API の文を出し、読み直さない (tests/super-admin-status-change-errors.test.tsx)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/super-admin-status-change-errors.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_ID = '20642064-2064-4064-8064-206420642064';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ROW_ID }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: CouponDetailPage } = await import('@/app/super-admin/coupons/[id]/page');
const { default: FeaturePackageDetailPage } = await import('@/app/super-admin/feature-packages/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COUPON = {
  id: ROW_ID,
  code: 'WINTER2064',
  display_name: '冬のクーポン',
  discount_type: 'fixed',
  discount_value: 500,
  applicable_to: 'all',
  applicable_plans: [],
  valid_from: '2026-10-01T00:00:00.000Z',
  // JST の 2026-12-31 23:59:59
  valid_until: '2026-12-31T14:59:59.000Z',
  max_uses: 100,
  uses_count: 3,
  per_user_limit: 1,
  duration_months: null,
  gross_margin_preview_jpy: null,
  status: 'paused',
  created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  created_at: '2026-10-01T00:00:00.000Z',
};

const FEATURE_PACKAGE = {
  id: ROW_ID,
  package_key: 'pkg_2064',
  display_name: '基本パッケージ',
  description: '基本の機能',
  feature_flags: ['flag_a', 'flag_b'],
  display_order: 2,
  status: 'active',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

/** API が遷移表に無い変更を断るときの本文 (文に英字の状態の値が括弧で入る) */
const COUPON_TRANSITION_409 = () =>
  jsonResponse(
    409,
    errorBody(
      'OP_COUPON_INVALID_TRANSITION',
      'クーポンの状態は 期限切れ (expired) から 有効 (active) へは変えられません (変えられるのは 有効 (active) → 停止中 (paused)・停止中 (paused) → 有効 (active) だけです)',
    ),
  );
const STALE_409 = () => jsonResponse(409, errorBody('CONFLICT_STALE_DATA', '別の操作で状態が先に変わりました。読み込み直してください'));
const PACKAGE_TRANSITION_409 = () =>
  jsonResponse(
    409,
    errorBody(
      'OP_FEATURE_PACKAGE_INVALID_TRANSITION',
      '機能パッケージの状態は 廃止 (deprecated) から 廃止 (deprecated) へは変えられません (変えられるのは 有効 (active) → 廃止 (deprecated) だけです)',
    ),
  );

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * 1 回目の GET は row を返し、2 回目からは reread() の応答を返す (409 のあとの読み直し)。PATCH は patch() の応答を返す
 */
function mockApi(row: Record<string, unknown>, options: { patch: () => FakeResponse; reread: () => FakeResponse }) {
  let gets = 0;
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return options.patch();
    gets += 1;
    return gets === 1 ? jsonResponse(200, { data: row }) : options.reread();
  });
  vi.stubGlobal('fetch', fetchMock);
}

const getCalls = () => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET');
const patchBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const text = () => container.textContent ?? '';
const statusError = () => container.querySelector('[data-testid="status-change-error"]')?.textContent ?? null;

/** ラベルの文字で入力欄を探す (ラベルの次の input / textarea) */
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelElement = Array.from(container.querySelectorAll('label')).find((l) => l.textContent === label);
  expect(labelElement, `「${label}」の欄が見つからない`).toBeDefined();
  const element = labelElement!.parentElement!.querySelector('input, textarea');
  expect(element, `「${label}」の入力欄が見つからない`).not.toBeNull();
  return element as HTMLInputElement | HTMLTextAreaElement;
}

/** React の制御された入力欄へ値を入れる (value の setter を通してから input イベントを出す) */
async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
}

async function clickButton(label: string) {
  const button = findButton(label);
  expect(button, `「${label}」ボタンが見つからない`).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
  await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
}

/** 英字の状態の値 (画面の文に出さない) */
const RAW_STATUS_WORDS = /\b(active|paused|expired|deprecated)\b/;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('alert', vi.fn());
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('クーポン詳細: 再開・一時停止の 409 のあと、読み直して今の状態にする', () => {
  it.each([
    ['遷移表に無い変更 (OP_COUPON_INVALID_TRANSITION)', COUPON_TRANSITION_409],
    ['同時の変更 (CONFLICT_STALE_DATA)', STALE_409],
  ])('再開が %s で断られたら、読み直して「期限切れ」を出し、ボタンを消す。文は日本語', async (_label, response) => {
    // 画面を開いたあとに、別の操作でクーポンが期限切れにされていた
    mockApi(COUPON, { patch: response, reread: () => jsonResponse(200, { data: { ...COUPON, status: 'expired' } }) });
    await render(<CouponDetailPage />);
    expect(text()).toContain('停止中');

    await clickButton('再開する');

    expect(patchBodies()).toEqual([{ status: 'active' }]);
    expect(getCalls()).toHaveLength(2);
    expect(text()).toContain('期限切れ');
    expect(text()).not.toContain('停止中');
    expect(findButton('再開する')).toBeUndefined();
    expect(findButton('一時停止')).toBeUndefined();
    expect(statusError()).toBe('再開できませんでした（別の操作でクーポンの状態が先に変わっていました。今の状態を読み込み直しました）');
    expect(statusError()).not.toMatch(RAW_STATUS_WORDS);
    expect(text()).not.toContain('読み込み中');
  });

  it('読み直しても書きかけの表示名は残し、手を付けていない欄は読み直した行の値にする', async () => {
    mockApi(COUPON, {
      patch: STALE_409,
      reread: () => jsonResponse(200, { data: { ...COUPON, status: 'active', max_uses: 300 } }),
    });
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '冬のクーポン (書きかけ)');

    await clickButton('再開する');

    expect(text()).toContain('有効');
    expect(findButton('一時停止')).toBeDefined();
    expect(field('表示名').value).toBe('冬のクーポン (書きかけ)');
    expect(field('最大利用回数').value).toBe('300');
  });

  it('読み直しが失敗したら、その旨を出す (状態の表示は元のまま)', async () => {
    mockApi(COUPON, {
      patch: COUPON_TRANSITION_409,
      reread: () => jsonResponse(500, errorBody('OP_INTERNAL_ERROR', '内部エラー')),
    });
    await render(<CouponDetailPage />);

    await clickButton('再開する');

    expect(getCalls()).toHaveLength(2);
    expect(statusError()).toBe(
      '再開できませんでした（別の操作でクーポンの状態が先に変わっていました。今の状態を読み込めなかったので、ページを読み込み直してください）',
    );
    expect(text()).toContain('停止中');
  });

  it('読み直しが通信エラーでも、その旨を出す', async () => {
    let gets = 0;
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return STALE_409();
      gets += 1;
      if (gets === 1) return jsonResponse(200, { data: COUPON });
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<CouponDetailPage />);

    await clickButton('再開する');

    expect(statusError()).toContain('今の状態を読み込めなかったので、ページを読み込み直してください');
  });
});

describe('機能パッケージ詳細: 廃止の 409 のあと、読み直して今の状態にする', () => {
  it.each([
    ['遷移表に無い変更 (OP_FEATURE_PACKAGE_INVALID_TRANSITION)', PACKAGE_TRANSITION_409],
    ['同時の変更 (CONFLICT_STALE_DATA)', STALE_409],
  ])('廃止が %s で断られたら、読み直して「廃止」を出し、ボタンを消す。文は日本語', async (_label, response) => {
    // 画面を開いたあとに、別の操作でパッケージが廃止されていた
    mockApi(FEATURE_PACKAGE, { patch: response, reread: () => jsonResponse(200, { data: { ...FEATURE_PACKAGE, status: 'deprecated' } }) });
    await render(<FeaturePackageDetailPage />);
    expect(findButton('廃止する')).toBeDefined();

    await clickButton('廃止する');

    expect(patchBodies()).toEqual([{ status: 'deprecated' }]);
    expect(getCalls()).toHaveLength(2);
    expect(findButton('廃止する')).toBeUndefined();
    expect(statusError()).toBe('廃止できませんでした（別の操作で機能パッケージの状態が先に変わっていました。今の状態を読み込み直しました）');
    expect(statusError()).not.toMatch(RAW_STATUS_WORDS);
    expect(text()).not.toContain('読み込み中');
  });

  it('読み直しても書きかけの表示名は残し、手を付けていない欄は読み直した行の値にする', async () => {
    mockApi(FEATURE_PACKAGE, {
      patch: PACKAGE_TRANSITION_409,
      reread: () => jsonResponse(200, { data: { ...FEATURE_PACKAGE, status: 'deprecated', display_order: 7 } }),
    });
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('表示名 *'), '基本パッケージ (書きかけ)');

    await clickButton('廃止する');

    expect(field('表示名 *').value).toBe('基本パッケージ (書きかけ)');
    expect(field('表示順').value).toBe('7');
  });

  it('読み直しが失敗したら、その旨を出す (状態の表示は元のまま)', async () => {
    mockApi(FEATURE_PACKAGE, {
      patch: STALE_409,
      reread: () => jsonResponse(404, errorBody('OP_PACKAGE_NOT_FOUND', '機能パッケージが見つかりません')),
    });
    await render(<FeaturePackageDetailPage />);

    await clickButton('廃止する');

    expect(statusError()).toBe(
      '廃止できませんでした（別の操作で機能パッケージの状態が先に変わっていました。今の状態を読み込めなかったので、ページを読み込み直してください）',
    );
    expect(findButton('廃止する')).toBeDefined();
  });
});
