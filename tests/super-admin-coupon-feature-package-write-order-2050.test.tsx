/**
 * #2050 (P3) 運営のクーポン詳細 (/super-admin/coupons/[id]) と機能パッケージ詳細 (/super-admin/feature-packages/[id]) で、
 * 保存と状態の変更 (一時停止・再開・廃止) を重ねたとき、後に届いた応答の古い行で表示を上書きしないことのテスト
 *
 * #2037 から、保存も状態の変更も PATCH の応答の行 (書いたあとの行) をそのまま画面の行にする。
 * 以前の画面は保存のボタンが isSaving だけ、状態を変えるボタンが isChangingStatus / isDeprecating だけを見ていたので、
 * 保存の応答を待つあいだに一時停止を押せた。サーバーは保存 → 一時停止の順に書くが、応答が一時停止 → 保存の順に届くと、
 * 保存の応答の行 (一時停止の前の status) が最後に置かれ、画面は「有効」のまま (DB は停止中) になっていた。
 *   - 保存と状態の変更は、どちらかの応答を待つあいだ、もう一方のボタンも止める (押しても送らない)
 *   - 再描画の前に続けて押されても (同じ一瞬の 2 回の押下)、送るのは先に押した方だけ
 *   - 応答が届いたら、どちらのボタンもまた押せる
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する
 * (tests/super-admin-status-change-errors.test.tsx と同じ)。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROW_ID = '20502050-2050-4050-8050-205020502050';

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
  code: 'ORDER2050',
  display_name: '順番のクーポン',
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
  package_key: 'pkg_2050',
  display_name: '順番のパッケージ',
  description: '順番の説明',
  feature_flags: ['flag_a', 'flag_b'],
  display_order: 2,
  status: 'active',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

/** クーポンの状態の表示 (page の STATUS_LABELS と同じ) */
const COUPON_STATUS_LABELS: Record<string, string> = { active: '有効', paused: '停止中' };
/** 機能パッケージの状態の表示 (page と同じ。active のほかは「廃止」) */
const featurePackageStatusLabel = (status: unknown) => (status === 'active' ? '有効' : '廃止');

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type PatchBody = Record<string, unknown>;

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** 外から開ける関所 (応答を返すのを、テストが開けるまで止める) */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

/**
 * サーバーの代わり。PATCH は届いた順に行へ書き、その時点の行を応答にする (route と同じく書いたあとの行全体)。
 * hold(body) が関所を返した PATCH は、書くのはすぐ・応答を返すのは関所が開いてから (応答の届く順を入れ替えるため)。
 * serverRow() は DB の今の行
 */
function mockServer(row: Record<string, unknown>, hold: (body: PatchBody) => Promise<void> | undefined) {
  let current = { ...row };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as PatchBody;
      current = { ...current, ...body };
      const written = { ...current };
      const wait = hold(body);
      if (wait) await wait;
      return jsonResponse(200, { data: written });
    }
    return jsonResponse(200, { data: current });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { serverRow: () => current };
}

const patchBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PatchBody);

const text = () => container.textContent ?? '';

/** クーポンの見出しの状態の札 (コードの隣) */
const couponBadge = () => container.querySelector('code')?.nextElementSibling?.textContent ?? null;
/** 機能パッケージの見出しの状態の札 (表示名の隣) */
const featurePackageBadge = () => container.querySelector('h1')?.nextElementSibling?.textContent ?? null;

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

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
  expect(found, `「${label}」ボタンが見つからない`).toBeDefined();
  return found!;
}

/** 押して、届いている応答を流しきる */
async function clickButton(label: string) {
  const target = button(label);
  await act(async () => {
    target.click();
  });
  await settle();
}

/** 待っている Promise を流しきる */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 関所を開けて、その応答を画面まで流す */
async function openGate(g: { open: () => void }) {
  await act(async () => {
    g.open();
  });
  await settle();
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

describe('クーポン詳細: 保存と状態の変更を重ねない (#2050)', () => {
  it('保存の応答を待つあいだは「一時停止」を押せず送らない。応答のあとの表示は DB の行と同じで、また押せる', async () => {
    const saveGate = gate();
    const server = mockServer(COUPON, (body) => ('display_name' in body ? saveGate.wait : undefined));
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '順番のクーポン (改)');

    await clickButton('保存する');
    expect(button('一時停止').disabled).toBe(true);
    await clickButton('一時停止');
    expect(patchBodies()).toEqual([{ display_name: '順番のクーポン (改)' }]);

    await openGate(saveGate);
    expect(text()).toContain('保存しました');
    expect(couponBadge()).toBe(COUPON_STATUS_LABELS[String(server.serverRow().status)]);
    expect(couponBadge()).toBe('有効');

    // 応答が届いたら、また押せる
    expect(button('一時停止').disabled).toBe(false);
    await clickButton('一時停止');
    expect(patchBodies()).toEqual([{ display_name: '順番のクーポン (改)' }, { status: 'paused' }]);
    expect(couponBadge()).toBe('停止中');
    expect(server.serverRow().status).toBe('paused');
  });

  it('一時停止の応答を待つあいだは「保存する」を押せず送らない。書きかけは残り、応答のあとに保存で送る', async () => {
    const statusGate = gate();
    const server = mockServer(COUPON, (body) => ('status' in body ? statusGate.wait : undefined));
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '順番のクーポン (書きかけ)');

    await clickButton('一時停止');
    expect(button('保存する').disabled).toBe(true);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ status: 'paused' }]);

    await openGate(statusGate);
    expect(couponBadge()).toBe('停止中');
    expect(field('表示名').value).toBe('順番のクーポン (書きかけ)');

    expect(button('保存する').disabled).toBe(false);
    await clickButton('保存する');
    expect(text()).toContain('保存しました');
    expect(patchBodies()).toEqual([{ status: 'paused' }, { display_name: '順番のクーポン (書きかけ)' }]);
    expect(server.serverRow()).toMatchObject({ status: 'paused', display_name: '順番のクーポン (書きかけ)' });
    expect(couponBadge()).toBe('停止中');
  });

  it('再開の応答を待つあいだも「保存する」を押せない', async () => {
    const statusGate = gate();
    mockServer({ ...COUPON, status: 'paused' }, (body) => ('status' in body ? statusGate.wait : undefined));
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '順番のクーポン (再開)');

    await clickButton('再開する');
    expect(button('保存する').disabled).toBe(true);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ status: 'active' }]);

    await openGate(statusGate);
    expect(couponBadge()).toBe('有効');
    expect(button('保存する').disabled).toBe(false);
  });

  it('再描画の前に「保存する」と「一時停止」を続けて押しても、送るのは先に押した保存だけ', async () => {
    const saveGate = gate();
    const server = mockServer(COUPON, (body) => ('display_name' in body ? saveGate.wait : undefined));
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '順番のクーポン (同時)');
    const save = button('保存する');
    const pause = button('一時停止');

    await act(async () => {
      save.click();
      pause.click();
    });
    await settle();
    expect(patchBodies()).toEqual([{ display_name: '順番のクーポン (同時)' }]);

    await openGate(saveGate);
    expect(couponBadge()).toBe(COUPON_STATUS_LABELS[String(server.serverRow().status)]);
    expect(button('一時停止').disabled).toBe(false);
  });

  it('再描画の前に「一時停止」と「保存する」を続けて押しても、送るのは先に押した一時停止だけ', async () => {
    const statusGate = gate();
    mockServer(COUPON, (body) => ('status' in body ? statusGate.wait : undefined));
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '順番のクーポン (同時 2)');
    const pause = button('一時停止');
    const save = button('保存する');

    await act(async () => {
      pause.click();
      save.click();
    });
    await settle();
    expect(patchBodies()).toEqual([{ status: 'paused' }]);

    await openGate(statusGate);
    expect(couponBadge()).toBe('停止中');
    expect(button('保存する').disabled).toBe(false);
  });

  it('保存が断られても、そのあと「一時停止」を押せる (止めたままにしない)', async () => {
    let current: Record<string, unknown> = { ...COUPON };
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as PatchBody;
        if ('display_name' in body) return jsonResponse(500, { error: { message: '内部エラー' } });
        current = { ...current, ...body };
        return jsonResponse(200, { data: { ...current } });
      }
      return jsonResponse(200, { data: current });
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '順番のクーポン (失敗)');

    await clickButton('保存する');
    expect(text()).toContain('内部エラー');

    expect(button('一時停止').disabled).toBe(false);
    await clickButton('一時停止');
    expect(patchBodies()).toEqual([{ display_name: '順番のクーポン (失敗)' }, { status: 'paused' }]);
    expect(couponBadge()).toBe('停止中');
  });

  it('何も変えずに保存を押した (送らなかった) あとも、「一時停止」を押せる', async () => {
    mockServer(COUPON, () => undefined);
    await render(<CouponDetailPage />);

    await clickButton('保存する');
    expect(container.querySelector('[data-testid="save-info"]')).not.toBeNull();

    expect(button('一時停止').disabled).toBe(false);
    await clickButton('一時停止');
    expect(patchBodies()).toEqual([{ status: 'paused' }]);
    expect(couponBadge()).toBe('停止中');
  });

  it('確認で一時停止を取り消したあとも、「保存する」を押せる', async () => {
    mockServer(COUPON, () => undefined);
    await render(<CouponDetailPage />);
    await typeInto(field('表示名'), '順番のクーポン (取消のあと)');
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    await clickButton('一時停止');
    expect(patchBodies()).toEqual([]);

    expect(button('保存する').disabled).toBe(false);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ display_name: '順番のクーポン (取消のあと)' }]);
  });
});

describe('機能パッケージ詳細: 保存と廃止を重ねない (#2050)', () => {
  it('保存の応答を待つあいだは「廃止する」を押せず送らない。応答のあとの表示は DB の行と同じで、また押せる', async () => {
    const saveGate = gate();
    const server = mockServer(FEATURE_PACKAGE, (body) => ('description' in body ? saveGate.wait : undefined));
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '順番の説明 (改)');

    await clickButton('保存する');
    expect(button('廃止する').disabled).toBe(true);
    await clickButton('廃止する');
    expect(patchBodies()).toEqual([{ description: '順番の説明 (改)' }]);

    await openGate(saveGate);
    expect(text()).toContain('保存しました');
    expect(featurePackageBadge()).toBe(featurePackageStatusLabel(server.serverRow().status));
    expect(featurePackageBadge()).toBe('有効');

    expect(button('廃止する').disabled).toBe(false);
    await clickButton('廃止する');
    expect(patchBodies()).toEqual([{ description: '順番の説明 (改)' }, { status: 'deprecated' }]);
    expect(featurePackageBadge()).toBe('廃止');
    expect(server.serverRow().status).toBe('deprecated');
  });

  it('廃止の応答を待つあいだは「保存する」を押せず送らない。書きかけは残る', async () => {
    const deprecateGate = gate();
    mockServer(FEATURE_PACKAGE, (body) => ('status' in body ? deprecateGate.wait : undefined));
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '順番の説明 (書きかけ)');

    await clickButton('廃止する');
    expect(button('保存する').disabled).toBe(true);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ status: 'deprecated' }]);

    await openGate(deprecateGate);
    expect(featurePackageBadge()).toBe('廃止');
    expect(field('説明').value).toBe('順番の説明 (書きかけ)');
    expect(button('保存する').disabled).toBe(false);
  });

  it('再描画の前に「保存する」と「廃止する」を続けて押しても、送るのは先に押した保存だけ', async () => {
    const saveGate = gate();
    const server = mockServer(FEATURE_PACKAGE, (body) => ('description' in body ? saveGate.wait : undefined));
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '順番の説明 (同時)');
    const save = button('保存する');
    const deprecate = button('廃止する');

    await act(async () => {
      save.click();
      deprecate.click();
    });
    await settle();
    expect(patchBodies()).toEqual([{ description: '順番の説明 (同時)' }]);

    await openGate(saveGate);
    expect(featurePackageBadge()).toBe(featurePackageStatusLabel(server.serverRow().status));
    expect(button('廃止する').disabled).toBe(false);
  });

  it('再描画の前に「廃止する」と「保存する」を続けて押しても、送るのは先に押した廃止だけ', async () => {
    const deprecateGate = gate();
    mockServer(FEATURE_PACKAGE, (body) => ('status' in body ? deprecateGate.wait : undefined));
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '順番の説明 (同時 2)');
    const deprecate = button('廃止する');
    const save = button('保存する');

    await act(async () => {
      deprecate.click();
      save.click();
    });
    await settle();
    expect(patchBodies()).toEqual([{ status: 'deprecated' }]);

    await openGate(deprecateGate);
    expect(featurePackageBadge()).toBe('廃止');
    expect(button('保存する').disabled).toBe(false);
  });

  it('保存が断られても、そのあと「廃止する」を押せる (止めたままにしない)', async () => {
    let current: Record<string, unknown> = { ...FEATURE_PACKAGE };
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as PatchBody;
        if ('description' in body) return jsonResponse(500, { error: { message: '内部エラー' } });
        current = { ...current, ...body };
        return jsonResponse(200, { data: { ...current } });
      }
      return jsonResponse(200, { data: current });
    });
    vi.stubGlobal('fetch', fetchMock);
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '順番の説明 (失敗)');

    await clickButton('保存する');
    expect(text()).toContain('内部エラー');

    expect(button('廃止する').disabled).toBe(false);
    await clickButton('廃止する');
    expect(patchBodies()).toEqual([{ description: '順番の説明 (失敗)' }, { status: 'deprecated' }]);
    expect(featurePackageBadge()).toBe('廃止');
  });

  it('機能フラグが空で保存を断った・何も変えずに保存を押したあとも、「廃止する」を押せる', async () => {
    mockServer(FEATURE_PACKAGE, () => undefined);
    await render(<FeaturePackageDetailPage />);

    await clickButton('保存する');
    expect(container.querySelector('[data-testid="save-info"]')).not.toBeNull();
    await typeInto(field('機能フラグ'), '');
    await clickButton('保存する');
    expect(text()).toContain('機能フラグを少なくとも1つ入力してください');

    expect(button('廃止する').disabled).toBe(false);
    await clickButton('廃止する');
    expect(patchBodies()).toEqual([{ status: 'deprecated' }]);
    expect(featurePackageBadge()).toBe('廃止');
  });

  it('確認で廃止を取り消したあとも、「保存する」を押せる', async () => {
    mockServer(FEATURE_PACKAGE, () => undefined);
    await render(<FeaturePackageDetailPage />);
    await typeInto(field('説明'), '順番の説明 (取消のあと)');
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    await clickButton('廃止する');
    expect(patchBodies()).toEqual([]);

    expect(button('保存する').disabled).toBe(false);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ description: '順番の説明 (取消のあと)' }]);
  });
});
