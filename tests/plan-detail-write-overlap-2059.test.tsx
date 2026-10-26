/**
 * #2059 (Q4) 運営のプランの詳細 (/super-admin/plans/[id]) で、保存と状態の変更 (公開・非公開・再公開・廃止・廃止の取り消し) を
 * 重ねて送らないことのテスト
 *
 * 以前の画面は、保存のボタンが isSaving || isReloading だけ、状態のボタンが isChangingStatus だけを見ていたので、
 * 保存の応答を待つあいだに「非公開にする」「廃止する」などを押せ、その逆もできた。route は直前に読んだ status を条件に書くので、
 * 重ねて送ると後に着いた方が 409 CONFLICT_STALE_DATA で断られ、画面は読み直して「別の運営が先にこのプランを変えていました」と出していた
 * (自分の操作どうしの競合なのに、別の運営が変えたように見える)。
 *   - 保存と状態の変更は、どちらかの応答 (とそのあとの読み直し) を待つあいだ、もう一方のボタンも止める (押しても送らない)
 *   - 再描画の前に続けて押されても (同じ一瞬の 2 回の押下)、送るのは先に押した方だけ
 *   - 応答が届いたら (断られても)、どちらのボタンもまた押せる
 * (クーポン・機能パッケージの詳細の writeInFlightRef と同じ形。#2053)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PLAN_ID = '20592059-2059-4059-8059-205920592059';

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
  plan_key: 'pro_2059',
  display_name: '重ねないプラン',
  plan_type: 'personal',
  description: '重ねないプランの説明',
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

/** 画面の上に出る、別の運営が先に変えた旨の文 (page の STALE_PLAN_MESSAGE の書き出し) */
const STALE_NOTICE_HEAD = '別の運営が先にこのプランを変えていました';

type PatchBody = Record<string, unknown>;

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
 * サーバーの代わり。route と同じく、PATCH は届いたときに読んだ status を条件に書く。
 * 応答を返す前 (関所で止めているあいだ) に別の PATCH が届くと、その PATCH は先の書き込みと重なったので
 * 409 CONFLICT_STALE_DATA で断る (route は読んでから書くまでに status が変わると断る)。
 * holdPatch(body) が関所を返した PATCH は、書くのはすぐ・応答を返すのは関所が開いてから。
 * holdGet() が関所を返した GET (読み直し) は、関所が開いてから今の行を返す
 */
function mockServer(options: {
  row?: Record<string, unknown>;
  holdPatch?: (body: PatchBody) => Promise<void> | undefined;
  holdGet?: () => Promise<void> | undefined;
  failPatch?: (body: PatchBody) => Response | undefined;
}) {
  let current: Record<string, unknown> = { ...PLAN, ...(options.row ?? {}) };
  let patchesInFlight = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.pathname !== PATH) throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    if (method === 'GET') {
      const wait = options.holdGet?.();
      if (wait) await wait;
      return jsonResponse(200, { data: { ...current } });
    }
    if (method !== 'PATCH') throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
    const body = JSON.parse(String(init?.body)) as PatchBody;
    if (patchesInFlight > 0) {
      return jsonResponse(409, { error: { code: 'CONFLICT_STALE_DATA', message: '画面を読み込み直してください' } });
    }
    const failure = options.failPatch?.(body);
    if (failure) return failure;
    current = { ...current, ...body };
    delete current.ends_at;
    // expected_status (画面が見ていた status。#2064) は書く条件で、列には書かない (route と同じ)
    delete current.expected_status;
    const written = { ...current };
    patchesInFlight += 1;
    try {
      const wait = options.holdPatch?.(body);
      if (wait) await wait;
    } finally {
      patchesInFlight -= 1;
    }
    return jsonResponse(200, { data: written });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { serverRow: () => current };
}

const patchBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'PATCH')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as PatchBody);

const text = () => container.textContent ?? '';

/** 見出しの状態の札 (表示名の隣) */
const statusBadge = () => container.querySelector('h1')?.nextElementSibling?.textContent ?? null;

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
  const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  expect(found, `「${label}」ボタンが見つからない`).toBeDefined();
  return found!;
}

/** 待っている Promise を流しきる */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 押して、届いている応答を流しきる */
async function clickButton(label: string) {
  const target = button(label);
  await act(async () => {
    target.click();
  });
  await settle();
}

/** 関所を開けて、その応答を画面まで流す */
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
  vi.spyOn(window, 'prompt').mockReturnValue('2027-01-01');
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

describe('プランの詳細: 保存の応答を待つあいだは状態の変更を送らない (#2059)', () => {
  it('保存の応答を待つあいだは「非公開にする」「廃止する」を押せず送らない。別の運営が変えた旨の文を出さず、応答のあとはまた押せる', async () => {
    const saveGate = gate();
    const server = mockServer({ holdPatch: (body) => ('display_name' in body ? saveGate.wait : undefined) });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (改)');

    await clickButton('保存する');
    expect(button('非公開にする').disabled).toBe(true);
    expect(button('廃止する').disabled).toBe(true);
    await clickButton('非公開にする');
    await clickButton('廃止する');
    expect(patchBodies()).toEqual([{ display_name: '重ねないプラン (改)' }]);

    await openGate(saveGate);
    expect(text()).toContain('保存しました');
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
    expect(container.querySelector('[data-testid="plan-reload-notice"]')).toBeNull();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(statusBadge()).toBe('公開中');

    // 応答が届いたら、また押せる
    expect(button('非公開にする').disabled).toBe(false);
    await clickButton('非公開にする');
    expect(patchBodies()).toEqual([{ display_name: '重ねないプラン (改)' }, { status: 'private', expected_status: 'public' }]);
    expect(server.serverRow()).toMatchObject({ status: 'private', display_name: '重ねないプラン (改)' });
    expect(statusBadge()).toBe('非公開');
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
  });

  it('保存のあとの読み直しを待つあいだも「非公開にする」を送らない', async () => {
    let holdReload = false;
    const reloadGate = gate();
    mockServer({ holdGet: () => (holdReload ? reloadGate.wait : undefined) });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (読み直し)');

    holdReload = true;
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ display_name: '重ねないプラン (読み直し)' }]);
    expect(button('非公開にする').disabled).toBe(true);
    await clickButton('非公開にする');
    expect(patchBodies()).toEqual([{ display_name: '重ねないプラン (読み直し)' }]);

    await openGate(reloadGate);
    expect(button('非公開にする').disabled).toBe(false);
  });

  it('再描画の前に「保存する」と「非公開にする」を続けて押しても、送るのは先に押した保存だけ', async () => {
    const saveGate = gate();
    mockServer({ holdPatch: (body) => ('display_name' in body ? saveGate.wait : undefined) });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (同時)');
    const save = button('保存する');
    const makePrivate = button('非公開にする');

    await act(async () => {
      save.click();
      makePrivate.click();
    });
    await settle();
    expect(patchBodies()).toEqual([{ display_name: '重ねないプラン (同時)' }]);

    await openGate(saveGate);
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
    expect(statusBadge()).toBe('公開中');
    expect(button('非公開にする').disabled).toBe(false);
  });

  it('保存が断られても、そのあと「非公開にする」を押せる (止めたままにしない)', async () => {
    mockServer({
      failPatch: (body) => ('display_name' in body ? jsonResponse(500, { error: { message: '内部エラー' } }) : undefined),
    });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (失敗)');

    await clickButton('保存する');
    expect(text()).toContain('内部エラー');

    expect(button('非公開にする').disabled).toBe(false);
    await clickButton('非公開にする');
    expect(patchBodies()).toEqual([{ display_name: '重ねないプラン (失敗)' }, { status: 'private', expected_status: 'public' }]);
    expect(statusBadge()).toBe('非公開');
  });

  it('何も変えずに保存を押した (送らなかった) あとも、「非公開にする」を押せる', async () => {
    mockServer({});
    await render();

    await clickButton('保存する');
    expect(patchBodies()).toEqual([]);
    expect(button('非公開にする').disabled).toBe(false);
    await clickButton('非公開にする');
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }]);
  });
});

describe('プランの詳細: 状態の変更の応答を待つあいだは保存を送らない (#2059)', () => {
  it('「非公開にする」の応答を待つあいだは「保存する」を押せず送らない。書きかけは残り、応答のあとに保存で送る', async () => {
    const statusGate = gate();
    const server = mockServer({ holdPatch: (body) => ('status' in body ? statusGate.wait : undefined) });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (書きかけ)');

    await clickButton('非公開にする');
    expect(button('保存する').disabled).toBe(true);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }]);

    await openGate(statusGate);
    expect(statusBadge()).toBe('非公開');
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
    expect(field('表示名 *').value).toBe('重ねないプラン (書きかけ)');

    expect(button('保存する').disabled).toBe(false);
    await clickButton('保存する');
    expect(text()).toContain('保存しました');
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }, { display_name: '重ねないプラン (書きかけ)' }]);
    expect(server.serverRow()).toMatchObject({ status: 'private', display_name: '重ねないプラン (書きかけ)' });
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
  });

  it('「再公開する」の応答を待つあいだも「保存する」を押せない', async () => {
    const statusGate = gate();
    mockServer({ row: { status: 'private' }, holdPatch: (body) => ('status' in body ? statusGate.wait : undefined) });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (再公開)');

    await clickButton('再公開する');
    expect(button('保存する').disabled).toBe(true);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ status: 'public', expected_status: 'private' }]);

    await openGate(statusGate);
    expect(statusBadge()).toBe('公開中');
    expect(button('保存する').disabled).toBe(false);
  });

  it('「公開する」(下書き) の応答を待つあいだも「保存する」を押せない', async () => {
    const statusGate = gate();
    mockServer({ row: { status: 'draft' }, holdPatch: (body) => ('status' in body ? statusGate.wait : undefined) });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (公開)');

    await clickButton('公開する');
    expect(button('保存する').disabled).toBe(true);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ status: 'public', expected_status: 'draft' }]);

    await openGate(statusGate);
    expect(statusBadge()).toBe('公開中');
    expect(button('保存する').disabled).toBe(false);
  });

  it('「廃止する」の応答を待つあいだは「保存する」を押せず送らない', async () => {
    const statusGate = gate();
    mockServer({ holdPatch: (body) => ('status' in body ? statusGate.wait : undefined) });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (廃止)');

    await clickButton('廃止する');
    expect(button('保存する').disabled).toBe(true);
    await clickButton('保存する');
    expect(patchBodies()).toHaveLength(1);
    expect(patchBodies()[0]).toMatchObject({ status: 'deprecated' });

    await openGate(statusGate);
    expect(statusBadge()).toBe('廃止');
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('状態の変更のあとの読み直しを待つあいだも「保存する」を送らない', async () => {
    let holdReload = false;
    const reloadGate = gate();
    mockServer({ holdGet: () => (holdReload ? reloadGate.wait : undefined) });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (読み直し 2)');

    holdReload = true;
    await clickButton('非公開にする');
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }]);
    expect(button('保存する').disabled).toBe(true);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }]);

    await openGate(reloadGate);
    expect(button('保存する').disabled).toBe(false);
  });

  it('再描画の前に「非公開にする」と「保存する」を続けて押しても、送るのは先に押した状態の変更だけ', async () => {
    const statusGate = gate();
    mockServer({ holdPatch: (body) => ('status' in body ? statusGate.wait : undefined) });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (同時 2)');
    const makePrivate = button('非公開にする');
    const save = button('保存する');

    await act(async () => {
      makePrivate.click();
      save.click();
    });
    await settle();
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }]);

    await openGate(statusGate);
    expect(statusBadge()).toBe('非公開');
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
    expect(button('保存する').disabled).toBe(false);
  });

  it('再描画の前に「非公開にする」と「廃止する」を続けて押しても、送るのは先に押した方だけ', async () => {
    const statusGate = gate();
    mockServer({ holdPatch: (body) => ('status' in body ? statusGate.wait : undefined) });
    await render();
    const makePrivate = button('非公開にする');
    const deprecate = button('廃止する');

    await act(async () => {
      makePrivate.click();
      deprecate.click();
    });
    await settle();
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }]);

    await openGate(statusGate);
    expect(statusBadge()).toBe('非公開');
    expect(text()).not.toContain(STALE_NOTICE_HEAD);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('状態の変更が断られても、そのあと「保存する」を押せる (止めたままにしない)', async () => {
    mockServer({
      failPatch: (body) =>
        'status' in body ? jsonResponse(500, { error: { message: 'サーバーエラーが発生しました' } }) : undefined,
    });
    await render();
    await typeInto(field('表示名 *'), '重ねないプラン (状態の失敗)');

    await clickButton('非公開にする');
    expect(alertSpy).toHaveBeenCalledWith('サーバーエラーが発生しました');

    expect(button('保存する').disabled).toBe(false);
    await clickButton('保存する');
    expect(patchBodies()).toEqual([{ status: 'private', expected_status: 'public' }, { display_name: '重ねないプラン (状態の失敗)' }]);
    expect(text()).toContain('保存しました');
  });
});
