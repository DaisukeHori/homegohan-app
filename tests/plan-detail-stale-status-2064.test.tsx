/**
 * #2064 (R1) 運営のプランの詳細 (/super-admin/plans/[id]) で、画面に出ている status が古いまま、状態のボタンが
 * 意図しない遷移 (廃止 → 非公開 = 廃止の取り消し) を書かないことのテスト
 *
 * 以前の画面は:
 *   - 状態の変更 (廃止など) に成功したあとの読み直しが失敗すると plan.status が古いまま (公開中) 残り、
 *     「非公開にする」「廃止する」を押せた (disabled は保存・状態の変更の応答を待つあいだだけ)。
 *   - 「再試行」の読み直しを待つあいだも、状態のボタンを押せた。
 *   - 状態の変更の本文は { status } だけで、画面が見ていた status を送らなかった。route は DB の status (deprecated) と
 *     private で遷移を検査し、deprecated → private (廃止の取り消し) は許されるので、確認の文 (「このプランを非公開にしますか？」) に
 *     出ないまま廃止が取り消された。画面を開いているあいだに別の運営が廃止したときも同じ。
 * 直したあと:
 *   - 状態の変更の本文に、画面が見ていた status (expected_status) を入れる。route は DB の status と違えば書かずに 409 にする
 *   - 読み直しが失敗しているあいだ (reload-failed / stale-reload-failed) と、読み直しを待つあいだは、状態のボタンを止める (押しても送らない)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PLAN_ID = '20642064-2064-4064-8064-206420642065';

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
  plan_key: 'pro_2064',
  display_name: '古い状態のプラン',
  plan_type: 'personal',
  description: '古い状態のプランの説明',
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

/** 画面の上に出る、別の運営が先に変えた旨の文 (page の STALE_PLAN_MESSAGE の書き出し) */
const STALE_NOTICE_HEAD = '別の運営が先にこのプランを変えていました';
/** 状態の変更に成功したあとの読み直しに失敗したときの文 (page の PLAN_RELOAD_FAILED_MESSAGE の書き出し) */
const RELOAD_FAILED_HEAD = '最新の内容を読み込めませんでした';

/** プランの状態のボタン (5 つ) の文字 */
const STATUS_BUTTON_LABELS = ['公開する', '非公開にする', '再公開する', '廃止する', '廃止を取り消す'] as const;

type PatchBody = Record<string, unknown>;
type Row = Record<string, unknown>;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
let alertSpy: ReturnType<typeof vi.fn>;

/**
 * サーバーの代わり。route と同じく、PATCH の expected_status が今の行の status と違えば書かずに 409 CONFLICT_STALE_DATA を返し、
 * expected_status を送らなければ今の行の status で遷移を検査して書く (以前の画面の本文 { status } で廃止が取り消される形を再現する)。
 * failGet(n) が true の n 回目の GET (1 始まり) は 500 を返す。holdGet(n) が関所を返した n 回目の GET は、関所が開いてから返す。
 * setRow で別の運営の書き込み (画面の外の変更) を入れる
 */
function mockServer(options: {
  row?: Row;
  failGet?: (n: number) => boolean;
  holdGet?: (n: number) => Promise<void> | undefined;
}) {
  let current: Row = { ...PLAN, ...(options.row ?? {}) };
  let gets = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname !== PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    if (method === 'GET') {
      gets += 1;
      const n = gets;
      const wait = options.holdGet?.(n);
      if (wait) await wait;
      if (options.failGet?.(n)) return jsonResponse(500, { error: { message: '内部エラー' } });
      return jsonResponse(200, { data: { ...current } });
    }
    if (method !== 'PATCH') throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    const body = JSON.parse(String(init?.body)) as PatchBody;
    if (body.expected_status !== undefined && body.expected_status !== current.status) {
      return jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: '画面を読み込み直してください' } });
    }
    const { expected_status: _expected, ...values } = body;
    current = { ...current, ...values };
    return jsonResponse(200, { data: { ...current } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    serverRow: () => current,
    setRow: (patch: Row) => {
      current = { ...current, ...patch };
    },
  };
}

const patchBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PatchBody);

const text = () => container.textContent ?? '';

/** 見出しの状態の札 (表示名の隣) */
const statusBadge = () => container.querySelector('h1')?.nextElementSibling?.textContent ?? null;

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

function button(label: string): HTMLButtonElement {
  const found = findButton(label);
  expect(found, `「${label}」ボタンが見つからない`).toBeDefined();
  return found!;
}

/** いま出ている状態のボタン (5 つのうち描かれているもの) */
function visibleStatusButtons(): HTMLButtonElement[] {
  return STATUS_BUTTON_LABELS.map((label) => findButton(label)).filter((b): b is HTMLButtonElement => b !== undefined);
}

/** 待っている Promise を流しきる */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 押して、届いている応答を流しきる (disabled のボタンでも click イベントを直に出して、handler の守りも確かめる) */
async function forceClick(label: string) {
  const target = button(label);
  await act(async () => {
    target.disabled = false;
    target.click();
  });
  await settle();
}

async function clickButton(label: string) {
  const target = button(label);
  await act(async () => {
    target.click();
  });
  await settle();
}

async function openGate(g: { open: () => void }) {
  await act(async () => {
    g.open();
  });
  await settle();
}

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

describe('廃止の成功 → 読み直しの失敗のあと、古い「公開中」のまま状態のボタンで廃止を取り消さない (#2064)', () => {
  it('読み直しが失敗しているあいだは、状態のボタンを止め、押しても PATCH を送らない。サーバーの行は廃止のまま', async () => {
    // 1 回目の GET (初めの読み込み) は通し、2 回目 (廃止のあとの読み直し) を失敗させる
    const server = mockServer({ failGet: (n) => n === 2 });
    await render();

    await clickButton('廃止する');
    expect(patchBodies()).toEqual([{ status: 'deprecated', ends_at: ENDS_AT_ISO, expected_status: 'public' }]);
    expect(server.serverRow().status).toBe('deprecated');
    // 画面は古い「公開中」のまま、読み直しの失敗の文が出る
    expect(statusBadge()).toBe('公開中');
    expect(text()).toContain(RELOAD_FAILED_HEAD);

    // 状態のボタンは全部止まっている
    const shown = visibleStatusButtons();
    expect(shown.map((b) => b.textContent?.trim())).toEqual(['非公開にする', '廃止する']);
    for (const b of shown) expect(b.disabled, `「${b.textContent}」が止まっていない`).toBe(true);

    // 止まったボタンに click を直に出しても (handler の守り)、送らない
    await forceClick('非公開にする');
    await forceClick('廃止する');
    expect(patchBodies()).toHaveLength(1);
    expect(server.serverRow().status).toBe('deprecated');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('「再試行」で読み直せたら、廃止の札と「廃止を取り消す」になり、押せる', async () => {
    mockServer({ failGet: (n) => n === 2 });
    await render();
    await clickButton('廃止する');
    expect(text()).toContain(RELOAD_FAILED_HEAD);

    await clickButton('再試行');
    expect(statusBadge()).toBe('廃止');
    expect(container.querySelector('[data-testid="plan-reload-notice"]')).toBeNull();
    expect(findButton('非公開にする')).toBeUndefined();
    expect(button('廃止を取り消す').disabled).toBe(false);
  });

  it('「再試行」の読み直しを待つあいだも、状態のボタンを止め、押しても送らない', async () => {
    const retryGate = gate();
    const server = mockServer({ failGet: (n) => n === 2, holdGet: (n) => (n === 3 ? retryGate.wait : undefined) });
    await render();
    await clickButton('廃止する');

    await clickButton('再試行');
    expect(button('読み込み中...').disabled).toBe(true);
    for (const b of visibleStatusButtons()) expect(b.disabled, `「${b.textContent}」が止まっていない`).toBe(true);
    await forceClick('非公開にする');
    expect(patchBodies()).toHaveLength(1);
    expect(server.serverRow().status).toBe('deprecated');

    await openGate(retryGate);
    expect(statusBadge()).toBe('廃止');
    expect(button('廃止を取り消す').disabled).toBe(false);
  });

  it('非公開にしたあとの読み直しが失敗しても、古い「公開中」のまま廃止を送らない', async () => {
    const server = mockServer({ failGet: (n) => n === 2 });
    await render();

    await clickButton('非公開にする');
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }]);
    expect(statusBadge()).toBe('公開中');
    await forceClick('廃止する');
    expect(patchBodies()).toHaveLength(1);
    expect(server.serverRow().status).toBe('private');
  });
});

describe('画面を開いているあいだに別の運営が廃止した: 古い「公開中」のまま「非公開にする」で廃止を取り消さない (#2064)', () => {
  it('本文に画面が見ていた status (public) を入れ、route が 409 を返すので廃止は取り消されない。画面は読み直して廃止を出す', async () => {
    const server = mockServer({});
    await render();
    expect(statusBadge()).toBe('公開中');

    // 別の運営が廃止する (画面は知らない)
    server.setRow({ status: 'deprecated', ends_at: ENDS_AT_ISO });

    await clickButton('非公開にする');
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }]);
    expect(server.serverRow().status).toBe('deprecated');
    // 409 のあと読み直して、廃止の札と別の運営が変えた旨の文を出す
    expect(statusBadge()).toBe('廃止');
    expect(text()).toContain(STALE_NOTICE_HEAD);
    expect(button('廃止を取り消す').disabled).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('409 のあとの読み直しも失敗したら (stale-reload-failed)、状態のボタンを止め、押しても送らない', async () => {
    const server = mockServer({ failGet: (n) => n === 2 });
    await render();
    server.setRow({ status: 'deprecated', ends_at: ENDS_AT_ISO });

    await clickButton('非公開にする');
    expect(text()).toContain('最新の内容を読み込み直せませんでした');
    expect(statusBadge()).toBe('公開中');
    for (const b of visibleStatusButtons()) expect(b.disabled, `「${b.textContent}」が止まっていない`).toBe(true);
    await forceClick('非公開にする');
    await forceClick('廃止する');
    expect(patchBodies()).toHaveLength(1);
    expect(server.serverRow().status).toBe('deprecated');
  });
});

describe('状態のボタンは、どれも画面が見ていた status を expected_status として送る (#2064)', () => {
  it.each([
    { from: 'draft', label: '公開する', body: { status: 'public', expected_status: 'draft' }, badge: '公開中' },
    { from: 'public', label: '非公開にする', body: { status: 'private', expected_status: 'public' }, badge: '非公開' },
    { from: 'private', label: '再公開する', body: { status: 'public', expected_status: 'private' }, badge: '公開中' },
    { from: 'public', label: '廃止する', body: { status: 'deprecated', ends_at: ENDS_AT_ISO, expected_status: 'public' }, badge: '廃止' },
    { from: 'private', label: '廃止する', body: { status: 'deprecated', ends_at: ENDS_AT_ISO, expected_status: 'private' }, badge: '廃止' },
    { from: 'deprecated', label: '廃止を取り消す', body: { status: 'private', expected_status: 'deprecated' }, badge: '非公開' },
  ])('$from の「$label」は $body を送り、書けたら $badge になる', async ({ from, label, body, badge }) => {
    mockServer({ row: { status: from } });
    await render();

    await clickButton(label);
    expect(patchBodies()).toEqual([body]);
    expect(statusBadge()).toBe(badge);
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
  });

  it('保存 (表示名・説明・表示順) の本文には expected_status を入れない (状態の変更だけ)', async () => {
    mockServer({});
    await render();
    const input = Array.from(container.querySelectorAll('label'))
      .find((l) => l.textContent === '表示名 *')!
      .parentElement!.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '古い状態のプラン (改)');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ display_name: '古い状態のプラン (改)' }]);
  });
});
