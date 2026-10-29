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
 *   - 保存に成功したら、保存の応答の行 (書いたあとの最新の行) が新しい初めの値になり、手を付けていない入力欄もその行の値に揃える。
 *     応答の行の送らなかった欄には、画面を開いたあとに別の運営が変えた値が入っていることがある。比べる元だけを新しくして
 *     入力欄を古いままにすると、次の保存 (何も変えずに押しても) で開いたときの古い値を送り、別の運営の変更を上書きする
 *   - 応答を待つあいだに変えた欄は、保存の成功のあとも書きかけとして残し、次の保存で送る
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

type MockApiOptions = {
  /**
   * 画面を開いたあと、最初の保存の前に別の運営が書いた変更 (DB の行の値)。最初の PATCH を書く前に行へ重ねるので、
   * 保存の応答の行の送らなかった欄にこの値が入る (route は .update().select() で書いたあとの行全体を返す)
   */
  concurrentChange?: Record<string, unknown>;
  /** 最初の PATCH の応答を、返された release() を呼ぶまで返さない (応答を待つあいだの入力を試すため) */
  holdFirstPatch?: boolean;
};

/**
 * GET は row を返し、PATCH は送られた項目を row に重ねた行を返す (route と同じく、送られなかった項目はそのまま)。
 * 戻り値の release() は holdFirstPatch のときに最初の PATCH の応答を返す
 */
function mockApi(row: Record<string, unknown>, options: MockApiOptions = {}) {
  let current = { ...row };
  let patchCount = 0;
  let releaseHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patchCount += 1;
      if (patchCount === 1 && options.concurrentChange) current = { ...current, ...options.concurrentChange };
      current = { ...current, ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
      const written = { ...current };
      if (patchCount === 1 && options.holdFirstPatch) await held;
      return jsonResponse(200, { data: written });
    }
    return jsonResponse(200, { data: current });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    release: async () => {
      await act(async () => {
        releaseHeld();
      });
    },
  };
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

  it('保存の応答の行に別の運営が変えた最大利用回数・有効期限が入っていたら、入力欄をその値に揃え、次の保存で送らない', async () => {
    mockApi(COUPON, { concurrentChange: { max_uses: 200, valid_until: '2027-03-31T14:59:59.999999Z' } });
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '秋のクーポン (改)');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(patchBodies()).toEqual([{ display_name: '秋のクーポン (改)' }]);
    // 送らなかった欄の入力欄は、開いたときの値 (100・2026-12-31) でなく、応答の行 (別の運営の変更) の値になる
    expect(field('最大利用回数').value).toBe('200');
    expect(field('有効期限').value).toBe('2027-03-31');

    // 何も変えずに押しても送らない (開いたときの 100・2026-12-31 で別の運営の変更を上書きしない)
    await clickSave();
    expect(patchBodies()).toHaveLength(1);
    expect(text()).toContain(NO_CHANGES_MESSAGE);

    // 別の欄 (表示名) だけを変えたら、表示名だけを送る
    await typeInto(field('表示名'), '秋のクーポン (再)');
    await clickSave();
    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[1]).toEqual({ display_name: '秋のクーポン (再)' });
  });

  it('保存の応答の行に別の運営が変えた表示名が入っていたら、最大利用回数だけを変えた次の保存で表示名を送らない', async () => {
    mockApi(COUPON, { concurrentChange: { display_name: '冬のクーポン' } });
    await render(<CouponDetailPage />);
    await typeInto(field('最大利用回数'), '150');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(field('表示名').value).toBe('冬のクーポン');

    await typeInto(field('最大利用回数'), '160');
    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()).toEqual([{ max_uses: 150 }, { max_uses: 160 }]);
  });

  it('応答を待つあいだに変えた欄は、保存の成功のあとも残して次の保存で送る (手を付けていない欄だけ応答の行に揃える)', async () => {
    const api = mockApi(COUPON, {
      concurrentChange: { max_uses: 200, valid_until: '2027-03-31T14:59:59.999999Z' },
      holdFirstPatch: true,
    });
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '秋のクーポン (改)');
    await clickSave();
    // 応答を待つあいだに、送った欄 (表示名) と送らなかった欄 (最大利用回数) を書き換える
    await typeInto(field('表示名'), '秋のクーポン (改2)');
    await typeInto(field('最大利用回数'), '150');

    await api.release();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(field('表示名').value).toBe('秋のクーポン (改2)');
    expect(field('最大利用回数').value).toBe('150');
    // 手を付けていない有効期限は、応答の行 (別の運営の変更) の値になる
    expect(field('有効期限').value).toBe('2027-03-31');

    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[1]).toEqual({ display_name: '秋のクーポン (改2)', max_uses: 150 });
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

  it('保存の応答の行に別の運営が変えた表示名・表示順が入っていたら、入力欄をその値に揃え、次の保存で送らない', async () => {
    mockApi(FEATURE_PACKAGE, { concurrentChange: { display_name: '基本パッケージ (別)', display_order: 5 } });
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '基本の機能 (改)');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(patchBodies()).toEqual([{ description: '基本の機能 (改)' }]);
    // 送らなかった欄の入力欄は、開いたときの値 (基本パッケージ・2) でなく、応答の行 (別の運営の変更) の値になる
    expect(field('表示名 *').value).toBe('基本パッケージ (別)');
    expect(field('表示順').value).toBe('5');

    // 何も変えずに押しても送らない (開いたときの値で別の運営の変更を上書きしない)
    await clickSave();
    expect(patchBodies()).toHaveLength(1);
    expect(text()).toContain(NO_CHANGES_MESSAGE);

    // 別の欄 (説明) だけを変えたら、説明だけを送る
    await typeInto(field('説明'), '基本の機能 (再)');
    await clickSave();
    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[1]).toEqual({ description: '基本の機能 (再)' });
  });

  it('保存の応答の行に別の運営が変えた説明・機能フラグが入っていたら、表示順だけを変えた次の保存で説明・機能フラグを送らない', async () => {
    mockApi(FEATURE_PACKAGE, { concurrentChange: { description: '別の説明', feature_flags: ['flag_a', 'flag_b', 'flag_c'] } });
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('表示順'), '7');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(field('説明').value).toBe('別の説明');
    expect(field('機能フラグ').value).toBe('flag_a\nflag_b\nflag_c');

    await typeInto(field('表示順'), '8');
    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()).toEqual([{ display_order: 7 }, { display_order: 8 }]);
  });

  it('応答を待つあいだに変えた欄は、保存の成功のあとも残して次の保存で送る (手を付けていない欄だけ応答の行に揃える)', async () => {
    const api = mockApi(FEATURE_PACKAGE, { concurrentChange: { display_order: 5 }, holdFirstPatch: true });
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('表示名 *'), '基本パッケージ (改)');
    await clickSave();
    // 応答を待つあいだに、送らなかった欄 (説明) を書き換える
    await typeInto(field('説明'), '書きかけの説明');

    await api.release();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));
    expect(field('表示名 *').value).toBe('基本パッケージ (改)');
    expect(field('説明').value).toBe('書きかけの説明');
    // 手を付けていない表示順は、応答の行 (別の運営の変更) の値になる
    expect(field('表示順').value).toBe('5');

    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[1]).toEqual({ description: '書きかけの説明' });
  });
});

/**
 * 状態の変更 (クーポンの一時停止・再開、機能パッケージの廃止) に成功したあとも、書きかけの入力欄を残す (#1917 の続き)。
 * 以前は成功のあとの読み直しが入力欄を全部読み直した値にしていたので、まだ保存していない入力が黙って消えていた。
 * いまは成功したら PATCH の応答の行 (書いたあとの最新の行) で表示を新しくし、全体を読み直さない。保存の経路と同じく、
 * 手を付けていない欄は応答の行の値 (別の運営の変更) にし、書きかけは残す (inputAfterSave)
 */
describe('状態の変更に成功したあとも、書きかけの入力欄を残す (#1917 の続き)', () => {
  const hasButton = (label: string) =>
    Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes(label));

  async function clickButton(label: string) {
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
    expect(button, `「${label}」ボタンが見つからない`).toBeDefined();
    await act(async () => {
      button!.click();
    });
  }

  beforeEach(() => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('クーポン: 一時停止に成功したら、書きかけの表示名を残し、手を付けていない欄は応答の行の値にする。次の保存で表示名だけを送る', async () => {
    mockApi(COUPON, { concurrentChange: { max_uses: 200 } });
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '書きかけの表示名');

    await clickButton('一時停止');

    await vi.waitFor(() => expect(text()).toContain('停止中'));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
    expect(patchBodies()).toEqual([{ status: 'paused' }]);
    expect(field('表示名').value).toBe('書きかけの表示名');
    expect(field('最大利用回数').value).toBe('200');
    expect(field('有効期限').value).toBe('2026-12-31');

    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[1]).toEqual({ display_name: '書きかけの表示名' });
  });

  it('クーポン: 一時停止の応答を待つあいだに変えた欄も残す', async () => {
    const api = mockApi(COUPON, { holdFirstPatch: true });
    await render(<CouponDetailPage />);

    await clickButton('一時停止');
    await typeInto(field('最大利用回数'), '150');
    await api.release();

    await vi.waitFor(() => expect(text()).toContain('停止中'));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
    expect(field('最大利用回数').value).toBe('150');
    expect(field('表示名').value).toBe('秋のクーポン');
  });

  it('クーポン: 書きかけの欄が無ければ、全部の欄を応答の行の値にする', async () => {
    mockApi(COUPON, { concurrentChange: { display_name: '冬のクーポン', max_uses: 200 } });
    await render(<CouponDetailPage />);

    await clickButton('一時停止');

    await vi.waitFor(() => expect(text()).toContain('停止中'));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
    expect(field('表示名').value).toBe('冬のクーポン');
    expect(field('最大利用回数').value).toBe('200');

    await clickSave();
    expect(patchBodies()).toHaveLength(1);
    expect(text()).toContain(NO_CHANGES_MESSAGE);
  });

  /**
   * 保存のあと、状態の変更の前に別の運営が変えた値 (secondChange) を、2 回目の PATCH (状態の変更) を書く前に行へ重ねる。
   * GET はいまの行を返し、PATCH は送られた項目を重ねた行を返す
   */
  function mockApiWithChangeBeforeSecondPatch(row: Record<string, unknown>, secondChange: Record<string, unknown>) {
    let current = { ...row };
    let patchCount = 0;
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patchCount += 1;
        if (patchCount === 2) current = { ...current, ...secondChange };
        current = { ...current, ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
        return jsonResponse(200, { data: { ...current } });
      }
      return jsonResponse(200, { data: current });
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('クーポン: 保存した欄は書きかけとして残さない (保存のあとに別の運営が変えた値を、一時停止の応答の行から出す)', async () => {
    mockApiWithChangeBeforeSecondPatch(COUPON, { display_name: '別の運営の表示名' });
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '秋のクーポン (改)');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));

    await clickButton('一時停止');

    await vi.waitFor(() => expect(text()).toContain('停止中'));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
    expect(field('表示名').value).toBe('別の運営の表示名');
    await clickSave();
    expect(patchBodies()).toEqual([{ display_name: '秋のクーポン (改)' }, { status: 'paused' }]);
    expect(text()).toContain(NO_CHANGES_MESSAGE);
  });

  it('機能パッケージ: 保存した欄は書きかけとして残さない (保存のあとに別の運営が変えた値を、廃止の応答の行から出す)', async () => {
    mockApiWithChangeBeforeSecondPatch(FEATURE_PACKAGE, { description: '別の運営の説明' });
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '基本の機能 (改)');
    await clickSave();
    await vi.waitFor(() => expect(text()).toContain('保存しました'));

    await clickButton('廃止する');

    await vi.waitFor(() => expect(hasButton('廃止する')).toBe(false));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
    expect(field('説明').value).toBe('別の運営の説明');
    await clickSave();
    expect(patchBodies()).toEqual([{ description: '基本の機能 (改)' }, { status: 'deprecated' }]);
    expect(text()).toContain(NO_CHANGES_MESSAGE);
  });

  it('機能パッケージ: 廃止に成功したら、書きかけの説明を残し、手を付けていない欄は応答の行の値にする。次の保存で説明だけを送る', async () => {
    mockApi(FEATURE_PACKAGE, { concurrentChange: { display_order: 5, feature_flags: ['flag_a', 'flag_b', 'flag_c'] } });
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '書きかけの説明');

    await clickButton('廃止する');

    await vi.waitFor(() => expect(hasButton('廃止する')).toBe(false));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
    expect(patchBodies()).toEqual([{ status: 'deprecated' }]);
    expect(field('表示順').value).toBe('5');
    expect(field('説明').value).toBe('書きかけの説明');
    expect(field('機能フラグ').value).toBe('flag_a\nflag_b\nflag_c');
    expect(field('表示名 *').value).toBe('基本パッケージ');

    await clickSave();

    await vi.waitFor(() => expect(patchBodies()).toHaveLength(2));
    expect(patchBodies()[1]).toEqual({ description: '書きかけの説明' });
  });

  it('機能パッケージ: 廃止の応答を待つあいだに変えた欄も残す', async () => {
    const api = mockApi(FEATURE_PACKAGE, { holdFirstPatch: true });
    await render(<FeaturePackageDetailPage />);

    await clickButton('廃止する');
    await typeInto(field('機能フラグ'), 'flag_a\nflag_z');
    await typeInto(field('表示順'), '9');
    await api.release();

    // 応答が返ると状態が「廃止」になり、「廃止する」ボタンが消える
    await vi.waitFor(() => expect(hasButton('廃止する')).toBe(false));
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
    expect(field('機能フラグ').value).toBe('flag_a\nflag_z');
    expect(field('表示順').value).toBe('9');
    expect(field('説明').value).toBe('基本の機能');
  });
});
