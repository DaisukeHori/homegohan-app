/**
 * #1917 運営のクーポン詳細 (/super-admin/coupons/[id]) と機能パッケージ詳細 (/super-admin/feature-packages/[id]) の保存は、
 * 最後に読んだ・保存した値から変えた欄だけを送ることのテスト
 *
 * 以前の画面は、手を付けていない欄 (クーポンの表示名・最大利用回数、機能パッケージの表示名・説明・機能フラグ・表示順) も
 * 保存のたびに送っていた。route は送られた項目をそのまま書くので、画面を開いたあとに別の運営がその欄を変えていると、
 * 別の欄だけを直して保存した運営が、開いたときの古い値で上書きしていた (409 にならない経路)。
 * プラン詳細 (tests/plan-detail-page-stale-1917.test.tsx) と同じ決まりにする。
 *   - 変えた欄だけを送る (空欄は null。これまでと同じ)
 *   - 何も変えていなければ送らず、その旨を出す (route は空の本文を 400 にする・監査に空の変更を残さない)
 *   - 保存に成功したら、保存した行が新しい初めの値になる
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/super-admin-coupon-redemptions-1571.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_ID = '19171917-1917-4917-8917-191719171917';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: ROW_ID }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: CouponDetailPage } = await import('@/app/super-admin/coupons/[id]/page');
const { default: FeaturePackageDetailPage } = await import('@/app/super-admin/feature-packages/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_CHANGES_MESSAGE = '変更した項目がないので、保存していません';

const COUPON = {
  id: ROW_ID,
  code: 'AUTUMN1917',
  display_name: '秋のクーポン',
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
  package_key: 'pkg_1917',
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

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

/** GET は row を返し、PATCH は送られた項目を row に重ねた行を返す (route と同じく、送られなかった項目はそのまま) */
function mockApi(row: Record<string, unknown>) {
  let current = { ...row };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      current = { ...current, ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
      return jsonResponse(200, { data: current });
    }
    return jsonResponse(200, { data: current });
  });
  vi.stubGlobal('fetch', fetchMock);
}

const patchBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

const text = () => container.textContent ?? '';

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

async function clickSave() {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('保存する'));
  expect(button, '「保存する」ボタンが見つからない').toBeDefined();
  await act(async () => {
    button!.click();
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
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('クーポン詳細: 保存は変えた欄だけを送る (#1917)', () => {
  it('表示名だけを変えたら表示名だけを送り、最大利用回数・有効期限は送らない', async () => {
    mockApi(COUPON);
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '秋のクーポン (改)');

    await clickSave();

    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(patchBodies()).toEqual([{ display_name: '秋のクーポン (改)' }]);
  });

  it('最大利用回数だけを変えたら最大利用回数だけを送る。空欄にしたら null (無制限) を送る', async () => {
    mockApi(COUPON);
    await render(<CouponDetailPage />);
    await typeInto(field('最大利用回数'), '200');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));

    await typeInto(field('最大利用回数'), '');
    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()).toEqual([{ max_uses: 200 }, { max_uses: null }]);
  });

  it('表示名を空にしたら display_name: null を送る', async () => {
    mockApi(COUPON);
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '');

    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({ display_name: null });
  });

  it('有効期限だけを変えたら有効期限 (JST の暦日) だけを送る', async () => {
    mockApi(COUPON);
    await render(<CouponDetailPage />);
    await typeInto(field('有効期限'), '2027-01-31');

    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({ valid_until: '2027-01-31' });
  });

  it('何も変えずに保存したら送らず、その旨を出す。入力欄を変えたらその文は消える', async () => {
    mockApi(COUPON);
    await render(<CouponDetailPage />);

    await clickSave();

    expect(patchBodies()).toEqual([]);
    expect(text()).toContain(NO_CHANGES_MESSAGE);
    expect(text()).not.toContain('保存しました');

    await typeInto(field('表示名'), '秋のクーポン (改)');
    expect(text()).not.toContain(NO_CHANGES_MESSAGE);
  });

  it('保存した行が新しい初めの値になり、同じ値でもう一度保存しても送らない', async () => {
    mockApi(COUPON);
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '秋のクーポン (改)');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));

    await clickSave();

    expect(patchBodies()).toHaveLength(1);
    expect(text()).toContain(NO_CHANGES_MESSAGE);
  });
});

describe('機能パッケージ詳細: 保存は変えた欄だけを送る (#1917)', () => {
  it('説明だけを変えたら説明だけを送り、表示名・機能フラグ・表示順は送らない', async () => {
    mockApi(FEATURE_PACKAGE);
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '基本の機能 (改)');

    await clickSave();

    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(patchBodies()).toEqual([{ description: '基本の機能 (改)' }]);
  });

  it('機能フラグを変えたら機能フラグ (並び) だけを送る。並びが同じなら区切りや空白を変えても送らない', async () => {
    mockApi(FEATURE_PACKAGE);
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('機能フラグ'), ' flag_a , flag_b ');
    await clickSave();
    expect(patchBodies()).toEqual([]);
    expect(text()).toContain(NO_CHANGES_MESSAGE);

    await typeInto(field('機能フラグ'), 'flag_b\nflag_a');
    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({ feature_flags: ['flag_b', 'flag_a'] });
  });

  it('表示順だけを変えたら表示順だけを送る。説明を空にしたら description: null を送る', async () => {
    mockApi(FEATURE_PACKAGE);
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('表示順'), '5');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));

    await typeInto(field('説明'), '');
    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()).toEqual([{ display_order: 5 }, { description: null }]);
  });

  it('何も変えずに保存したら送らず、その旨を出す', async () => {
    mockApi(FEATURE_PACKAGE);
    await render(<FeaturePackageDetailPage />);

    await clickSave();

    expect(patchBodies()).toEqual([]);
    expect(text()).toContain(NO_CHANGES_MESSAGE);
    expect(text()).not.toContain('保存しました');
  });

  it('機能フラグを全部消したら、これまでどおり送らずに入力の誤りを出す', async () => {
    mockApi(FEATURE_PACKAGE);
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('機能フラグ'), '');

    await clickSave();

    expect(patchBodies()).toEqual([]);
    expect(text()).toContain('機能フラグを少なくとも1つ入力してください');
    expect(text()).not.toContain(NO_CHANGES_MESSAGE);
  });
});
