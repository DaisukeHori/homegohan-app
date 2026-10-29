/**
 * #2073 S6: 運営のプランの詳細 (/super-admin/plans/[id]) で、状態の変更 (公開・非公開・再公開・廃止・廃止の取り消し) の
 * 通信が reject された (応答を受け取れなかった) ときの画面のテスト
 *
 * 以前の画面は catch で alert を出すだけで、プランを読み直さなかった。サーバーが変更を済ませてから応答が切れると、
 * 画面は古い状態とボタンのまま残り、同じボタンをもう一度押すと expected_status が古いので 409 CONFLICT_STALE_DATA になり、
 * 自分の操作なのに「別の運営が先にこのプランを変えていました」と出た。
 * 直したあと:
 *   - 通信が reject されたら、プランを読み直して今の状態を見せ、自分の操作が済んでいたときにも合う文を画面の上に出す (alert にしない)
 *   - 読み直しにも失敗したら、その旨と「再試行」を出し、読み直せるまで状態のボタンを止める (#2064 と同じ)
 *   - 入力欄の書きかけは読み直しで消さない (#1917 と同じ)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PLAN_ID = '20732073-2073-4073-8073-207320732073';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: PLAN_ID }),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLAN = {
  id: PLAN_ID,
  plan_key: 'pro_2073',
  display_name: '応答の切れるプラン',
  plan_type: 'personal',
  description: '応答の切れるプランの説明',
  monthly_price_jpy: 980,
  yearly_price_jpy: 9800,
  max_members: null,
  stripe_product_id: null,
  stripe_price_id: null,
  stripe_yearly_price_id: null,
  status: 'public',
  display_order: 3,
  trial_days: 0,
  feature_packages: [],
  price_history: [],
};

const PATH = `/api/super-admin/plans/${PLAN_ID}`;
const ENDS_AT_INPUT = '2027-01-01';
const ENDS_AT_ISO = '2027-01-01T00:00:00.000Z';

/** 通信が reject されたときに画面の上に出る文の頭 */
const NO_RESPONSE_HEAD = '状態の変更の応答を受け取れませんでした（通信エラー）';
/** 読み直せたときに続く文 */
const RELOADED_GUIDE = '今の状態を読み込み直したので、状態を確かめてから、必要ならもう一度操作してください';
/** 読み直しにも失敗したときに続く文 */
const RELOAD_FAILED_GUIDE = '今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';
/** 書きかけを残したときに添える文 (page の EDITS_KEPT_SUFFIX) */
const EDITS_KEPT_SUFFIX = '（入力中の表示名・説明・表示順はそのまま残しています）';
/** 409 のあとの文の頭 (自分の操作のときに出してはいけない) */
const STALE_NOTICE_HEAD = '別の運営が先にこのプランを変えていました';

const STATUS_BUTTON_LABELS = ['公開する', '非公開にする', '再公開する', '廃止する', '廃止を取り消す'] as const;

type PatchBody = Record<string, unknown>;
type Row = Record<string, unknown>;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let alertSpy: ReturnType<typeof vi.fn>;

/**
 * サーバーの代わり (route と同じく expected_status が今の status と違えば書かずに 409 CONFLICT_STALE_DATA)。
 * rejectPatch(n) が 'after-write' の n 回目の PATCH (1 始まり) は、書いてから応答を返さずに reject する (応答が切れた)。
 * 'before-write' なら書かずに reject する (届かなかった)。failGet(n) が true の n 回目の GET は 500 を返す
 */
function mockServer(options: {
  row?: Row;
  rejectPatch?: (n: number) => 'after-write' | 'before-write' | undefined;
  failGet?: (n: number) => boolean;
}) {
  let current: Row = { ...PLAN, ...(options.row ?? {}) };
  let gets = 0;
  let patches = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname !== PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    if (method === 'GET') {
      gets += 1;
      if (options.failGet?.(gets)) return jsonResponse(500, { error: { message: '内部エラー' } });
      return jsonResponse(200, { data: { ...current } });
    }
    if (method !== 'PATCH') throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    patches += 1;
    const reject = options.rejectPatch?.(patches);
    if (reject === 'before-write') throw new TypeError('Failed to fetch');
    const body = JSON.parse(String(init?.body)) as PatchBody;
    if (body.expected_status !== undefined && body.expected_status !== current.status) {
      return jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: '画面を読み込み直してください' } });
    }
    const { expected_status: _expected, ...values } = body;
    current = { ...current, ...values };
    if (reject === 'after-write') throw new TypeError('Failed to fetch');
    return jsonResponse(200, { data: { ...current } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { serverRow: () => current };
}

const callsOf = (method: string) =>
  fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method);
const patchBodies = () => callsOf('PATCH').map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PatchBody);

const text = () => container.textContent ?? '';
/** 画面の上の文 (「再試行」のボタンの文字を含めない) */
const notice = () => container.querySelector('[data-testid="plan-reload-notice"] > span')?.textContent ?? null;
const statusBadge = () => container.querySelector('h1')?.nextElementSibling?.textContent ?? null;

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

function button(label: string): HTMLButtonElement {
  const found = findButton(label);
  expect(found, `「${label}」ボタンが見つからない`).toBeDefined();
  return found!;
}

function visibleStatusButtons(): HTMLButtonElement[] {
  return STATUS_BUTTON_LABELS.map((label) => findButton(label)).filter((b): b is HTMLButtonElement => b !== undefined);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickButton(label: string) {
  const target = button(label);
  await act(async () => {
    target.click();
  });
  await settle();
}

/** 止まったボタンにも click を直に出す (handler の守りを確かめる) */
async function forceClick(label: string) {
  const target = button(label);
  await act(async () => {
    target.disabled = false;
    target.click();
  });
  await settle();
}

async function typeDisplayName(value: string) {
  const input = Array.from(container.querySelectorAll('label'))
    .find((l) => l.textContent === '表示名 *')!
    .parentElement!.querySelector('input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const displayNameValue = () =>
  (
    Array.from(container.querySelectorAll('label'))
      .find((l) => l.textContent === '表示名 *')!
      .parentElement!.querySelector('input') as HTMLInputElement
  ).value;

async function render() {
  await act(async () => {
    root.render(createElement(PlanDetailPage));
  });
  await settle();
  await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(window, 'prompt').mockReturnValue(ENDS_AT_INPUT);
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

describe('状態の変更の通信が、サーバーが書いたあとに reject された: 読み直して今の状態を見せる (#2073 S6)', () => {
  it.each([
    { from: 'draft', label: '公開する', badge: '公開中' },
    { from: 'public', label: '非公開にする', badge: '非公開' },
    { from: 'private', label: '再公開する', badge: '公開中' },
    { from: 'public', label: '廃止する', badge: '廃止' },
    { from: 'deprecated', label: '廃止を取り消す', badge: '非公開' },
  ])('$from の「$label」: 読み直して $badge を出し、自分の操作でも合う文を出す (alert にしない)', async ({ from, label, badge }) => {
    const server = mockServer({ row: { status: from }, rejectPatch: () => 'after-write' });
    await render();

    await clickButton(label);

    expect(patchBodies()).toHaveLength(1);
    // 初めの読み込みと、reject のあとの読み直しの 2 回
    expect(callsOf('GET')).toHaveLength(2);
    expect(statusBadge()).toBe(badge);
    expect(server.serverRow().status).not.toBe(from);
    expect(notice()).toBe(`${NO_RESPONSE_HEAD}。${RELOADED_GUIDE}`);
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
    expect(alertSpy).not.toHaveBeenCalled();
    // 読み直した状態のボタンを押せる
    for (const b of visibleStatusButtons()) expect(b.disabled, `「${b.textContent}」が止まっている`).toBe(false);
  });

  it('読み直したあとにもう一度押すと、今の状態を expected_status にして送り、409 の「別の運営が先に…」は出ない', async () => {
    mockServer({ rejectPatch: (n) => (n === 1 ? 'after-write' : undefined) });
    await render();

    await clickButton('非公開にする');
    expect(statusBadge()).toBe('非公開');

    await clickButton('再公開する');
    expect(patchBodies()).toEqual([
      { status: 'private', expected_status: 'public' },
      { status: 'public', expected_status: 'private' },
    ]);
    expect(statusBadge()).toBe('公開中');
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('サーバーに届かずに reject されたときも読み直し、元の状態のまま同じ文を出す (済んだと言わない・失敗とも言い切らない)', async () => {
    const server = mockServer({ rejectPatch: () => 'before-write' });
    await render();

    await clickButton('廃止する');

    expect(server.serverRow().status).toBe('public');
    expect(callsOf('GET')).toHaveLength(2);
    expect(statusBadge()).toBe('公開中');
    expect(notice()).toBe(`${NO_RESPONSE_HEAD}。${RELOADED_GUIDE}`);
    expect(button('廃止する').disabled).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('入力欄の書きかけは読み直しで消さず、その旨を添える', async () => {
    mockServer({ rejectPatch: () => 'after-write' });
    await render();
    await typeDisplayName('応答の切れるプラン (書きかけ)');

    await clickButton('非公開にする');

    expect(statusBadge()).toBe('非公開');
    expect(displayNameValue()).toBe('応答の切れるプラン (書きかけ)');
    expect(notice()).toBe(`${NO_RESPONSE_HEAD}。${RELOADED_GUIDE}${EDITS_KEPT_SUFFIX}`);
  });
});

describe('状態の変更の通信が reject され、読み直しにも失敗した (#2073 S6)', () => {
  it('その旨と「再試行」を出し、状態のボタンを止める (押しても送らない)。「再試行」で読み直せたら今の状態にして、ボタンを戻す', async () => {
    // 1 回目の GET (初めの読み込み) は通し、2 回目 (reject のあとの読み直し) を失敗させる
    const server = mockServer({ rejectPatch: () => 'after-write', failGet: (n) => n === 2 });
    await render();

    await clickButton('非公開にする');

    expect(server.serverRow().status).toBe('private');
    expect(statusBadge()).toBe('公開中');
    expect(notice()).toBe(`${NO_RESPONSE_HEAD}。${RELOAD_FAILED_GUIDE}`);
    expect(alertSpy).not.toHaveBeenCalled();
    for (const b of visibleStatusButtons()) expect(b.disabled, `「${b.textContent}」が止まっていない`).toBe(true);
    await forceClick('非公開にする');
    expect(patchBodies()).toHaveLength(1);

    await clickButton('再試行');

    expect(statusBadge()).toBe('非公開');
    expect(notice()).toBe(`${NO_RESPONSE_HEAD}。${RELOADED_GUIDE}`);
    expect(findButton('再試行')).toBeUndefined();
    expect(button('再公開する').disabled).toBe(false);
    expect(button('廃止する').disabled).toBe(false);
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
  });
});
