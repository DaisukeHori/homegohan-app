/**
 * 運営のクーポン詳細 (/super-admin/coupons/[id]) の「一時停止」「再開する」と、機能パッケージ詳細
 * (/super-admin/feature-packages/[id]) の「廃止する」が、失敗の応答を黙って捨てないことのテスト
 *
 * 以前の画面は `if (res.ok) fetchCoupon();` / `if (res.ok) fetchPkg();` だけで、403 (二段階認証の確認が要る・権限が無い)・
 * 404・500 のとき画面に何も出さず元のままだった (運営は操作が効いたか分からない)。
 * 成功のときも全体を「読み込み中」にして読み直し、入力欄の書きかけを読み直した値に戻していた。
 *   - 失敗したら、操作の名前と理由を画面に出す。403 は理由の文 (二段階認証の確認が要る・凍結) だけを通し、それ以外は「権限がありません」
 *   - 成功したら、PATCH の応答の行で表示を新しくする (全体を「読み込み中」にしない)。入力欄は保存の経路と同じく、
 *     手を付けていない欄だけ応答の行の値に揃え、書きかけは残す
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/super-admin-coupon-feature-package-changed-fields-1917.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_ID = '20252025-2025-4025-8025-202520252025';

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
  code: 'WINTER2025',
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
  status: 'active',
  created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  created_at: '2026-10-01T00:00:00.000Z',
};

const FEATURE_PACKAGE = {
  id: ROW_ID,
  package_key: 'pkg_2025',
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

/** 本文が JSON でない応答 (プロキシの 502 など) */
function nonJsonResponse(status: number): FakeResponse {
  return { ok: false, status, json: () => Promise.reject(new SyntaxError('Unexpected token <')) };
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.fn>;

/**
 * GET は row を返す。状態の変更 (status だけの PATCH) は patch() の応答を返す。
 * patch() を渡さなければ、送られた項目を row に重ねた行 (と concurrentChange) を返す (route と同じく書いたあとの行全体)
 */
function mockApi(
  row: Record<string, unknown>,
  options: { patch?: () => FakeResponse | Promise<FakeResponse>; concurrentChange?: Record<string, unknown> } = {},
) {
  let current = { ...row };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      if (options.patch) return options.patch();
      current = { ...current, ...(options.concurrentChange ?? {}), ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
      return jsonResponse(200, { data: { ...current } });
    }
    return jsonResponse(200, { data: current });
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  alertSpy = vi.fn();
  vi.stubGlobal('alert', alertSpy);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 失敗の応答と、画面に出す理由
const FAILURES: Array<[string, () => FakeResponse, string]> = [
  ['403 (二段階認証の確認が要る)', () => jsonResponse(403, errorBody('OP_PERMISSION_DENIED', '二段階認証の確認が必要です')), '二段階認証の確認が必要です'],
  ['403 (ロールが足りない)', () => jsonResponse(403, errorBody('OP_PERMISSION_DENIED', '権限がありません')), '権限がありません'],
  ['404', () => jsonResponse(404, errorBody('OP_COUPON_NOT_FOUND', 'クーポンが見つかりません')), 'クーポンが見つかりません'],
  ['409', () => jsonResponse(409, errorBody('OP_CONFLICT', '別の理由で断られました')), '別の理由で断られました'],
  ['500', () => jsonResponse(500, errorBody('OP_INTERNAL_ERROR', '内部エラー')), '内部エラー'],
  ['本文が JSON でない 502', () => nonJsonResponse(502), 'HTTP 502'],
];

describe('クーポン詳細: 一時停止・再開の失敗を画面に出す', () => {
  it.each(FAILURES)('一時停止が %s で断られたら、理由を出し、状態の表示はそのまま (読み直さない)', async (_label, response, reason) => {
    mockApi(COUPON, { patch: response });
    await render(<CouponDetailPage />);

    await clickButton('一時停止');

    expect(patchBodies()).toEqual([{ status: 'paused' }]);
    expect(statusError()).toContain('一時停止できませんでした');
    expect(statusError()).toContain(reason);
    expect(text()).toContain('有効');
    expect(text()).not.toContain('停止中');
    expect(getCalls()).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('403 の本文の文が理由の文でなければ (古い route の英語の文など)、そのまま出さず「権限がありません」を出す', async () => {
    mockApi(COUPON, { patch: () => jsonResponse(403, errorBody('FORBIDDEN', 'Forbidden')) });
    await render(<CouponDetailPage />);

    await clickButton('一時停止');

    expect(statusError()).toContain('権限がありません');
    expect(statusError()).not.toContain('Forbidden');
  });

  it('再開が断られたら「再開できませんでした」と理由を出す', async () => {
    mockApi({ ...COUPON, status: 'paused' }, { patch: () => jsonResponse(500, errorBody('OP_INTERNAL_ERROR', '内部エラー')) });
    await render(<CouponDetailPage />);

    await clickButton('再開する');

    expect(patchBodies()).toEqual([{ status: 'active' }]);
    expect(statusError()).toContain('再開できませんでした');
    expect(statusError()).toContain('内部エラー');
    expect(text()).toContain('停止中');
  });

  it('通信エラーでも画面に出す (alert にしない)', async () => {
    mockApi(COUPON, { patch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await render(<CouponDetailPage />);

    await clickButton('一時停止');

    expect(statusError()).toContain('一時停止できませんでした');
    expect(statusError()).toContain('通信エラー');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('確認で取り消したら送らず、文も出さない', async () => {
    mockApi(COUPON);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await render(<CouponDetailPage />);

    await clickButton('一時停止');

    expect(patchBodies()).toEqual([]);
    expect(statusError()).toBeNull();
  });

  it('成功したら応答の行で状態を新しくし、全体を読み直さない。書きかけの入力欄は残し、手を付けていない欄は応答の行の値にする', async () => {
    // 画面を開いたあとに別の運営が最大利用回数を 300 に変えていた
    mockApi(COUPON, { concurrentChange: { max_uses: 300 } });
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '冬のクーポン (書きかけ)');

    await clickButton('一時停止');

    expect(getCalls()).toHaveLength(1);
    expect(text()).toContain('停止中');
    expect(findButton('再開する')).toBeDefined();
    expect(text()).not.toContain('読み込み中');
    expect(statusError()).toBeNull();
    expect(field('表示名').value).toBe('冬のクーポン (書きかけ)');
    expect(field('最大利用回数').value).toBe('300');
  });

  it('成功したあと、書きかけの表示名だけを保存で送る (手を付けていない欄は応答の行の値なので送らない)', async () => {
    mockApi(COUPON, { concurrentChange: { max_uses: 300 } });
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '冬のクーポン (改)');
    await clickButton('一時停止');

    await clickButton('保存する');

    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(patchBodies()).toEqual([{ status: 'paused' }, { display_name: '冬のクーポン (改)' }]);
  });

  it('失敗のあとに成功したら、失敗の文を消す', async () => {
    let attempt = 0;
    mockApi(COUPON, {
      patch: () => {
        attempt += 1;
        return attempt === 1
          ? jsonResponse(500, errorBody('OP_INTERNAL_ERROR', '内部エラー'))
          : jsonResponse(200, { data: { ...COUPON, status: 'paused' } });
      },
    });
    await render(<CouponDetailPage />);
    await clickButton('一時停止');
    expect(statusError()).toContain('内部エラー');

    await clickButton('一時停止');

    expect(statusError()).toBeNull();
    expect(text()).toContain('停止中');
  });

  it('応答を待つあいだは、状態を変えるボタンを押せない (二重に送らない)', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockApi(COUPON, {
      patch: async () => {
        await held;
        return jsonResponse(200, { data: { ...COUPON, status: 'paused' } });
      },
    });
    await render(<CouponDetailPage />);

    await clickButton('一時停止');
    expect(findButton('一時停止')!.disabled).toBe(true);

    await act(async () => {
      release();
    });
    await vi.waitFor(() => expect(text()).toContain('停止中'));
    expect(patchBodies()).toHaveLength(1);
  });
});

describe('機能パッケージ詳細: 廃止の失敗を画面に出す', () => {
  it.each(FAILURES)('廃止が %s で断られたら、理由を出し、状態の表示はそのまま (読み直さない)', async (_label, response, reason) => {
    mockApi(FEATURE_PACKAGE, { patch: response });
    await render(<FeaturePackageDetailPage />);

    await clickButton('廃止する');

    expect(patchBodies()).toEqual([{ status: 'deprecated' }]);
    expect(statusError()).toContain('廃止できませんでした');
    expect(statusError()).toContain(reason);
    expect(findButton('廃止する')).toBeDefined();
    expect(getCalls()).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('403 の本文の文が理由の文でなければ「権限がありません」を出す', async () => {
    mockApi(FEATURE_PACKAGE, { patch: () => jsonResponse(403, errorBody('FORBIDDEN', 'Forbidden')) });
    await render(<FeaturePackageDetailPage />);

    await clickButton('廃止する');

    expect(statusError()).toContain('権限がありません');
    expect(statusError()).not.toContain('Forbidden');
  });

  it('通信エラーでも画面に出す (alert にしない)', async () => {
    mockApi(FEATURE_PACKAGE, { patch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await render(<FeaturePackageDetailPage />);

    await clickButton('廃止する');

    expect(statusError()).toContain('廃止できませんでした');
    expect(statusError()).toContain('通信エラー');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('成功したら応答の行で状態を新しくし、全体を読み直さない。書きかけの入力欄は残し、手を付けていない欄は応答の行の値にする', async () => {
    // 画面を開いたあとに別の運営が表示順を 5 に変えていた
    mockApi(FEATURE_PACKAGE, { concurrentChange: { display_order: 5 } });
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '書きかけの説明');

    await clickButton('廃止する');

    expect(getCalls()).toHaveLength(1);
    expect(text()).toContain('廃止');
    expect(findButton('廃止する')).toBeUndefined();
    expect(text()).not.toContain('読み込み中');
    expect(statusError()).toBeNull();
    expect(field('説明').value).toBe('書きかけの説明');
    expect(field('表示順').value).toBe('5');
  });
});
