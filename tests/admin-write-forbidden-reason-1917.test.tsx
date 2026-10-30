/**
 * #1917 の続き (整合 1025b の R1): 運営の画面の書き込み・書き出し・一覧の読み込みのうち、403 を受けて画面の固定の文を出していた
 * 経路が、403 の本文の理由の文 (二段階認証の確認・登録が要る) を捨てないことのテスト
 *
 * 以前は次の経路が、403 でも本文を読まずに固定の文を出していた (読み込みの 403 は tests/admin-pages-forbidden-reason-1917.test.tsx)。
 *   - /admin/support/[id] の担当者の割り当て (「割り当て失敗」)・状態の変更 (「ステータス変更失敗」)
 *   - /admin/sales/[id] のステージの変更 (409 CONFLICT_STALE_DATA 以外。「ステージ変更失敗」)
 *   - /super-admin/audit-logs の CSV の書き出し (alert の「CSV エクスポートに失敗しました」)
 *   - /support/users の利用者の一覧の読み込み (「ユーザー一覧を取得できませんでした…」)
 * 運営の route はゲートの後でセッションの状態が変わったとき 403 の本文に二段階認証の文を入れる (#2014) ので、
 * 二段階認証が要るのに、ただ失敗した・権限が無いように見えた。
 *
 * 直したあとの不変条件 (下の CASES の経路ごと):
 *   - 403 の本文の文が二段階認証の文なら、その文を出し、経路の固定の文は出さない
 *   - ロールが足りない 403 (本文の文が「権限がありません」) や、本文が読めない 403 は、経路の固定の文 (直す前と同じ)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// useRouter は描画のたびに同じ物を返す (router を依存に持つ読み込みが描画のたびに走らないように)
const nav = vi.hoisted(() => ({
  router: { push: () => undefined, replace: () => undefined, refresh: () => undefined },
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: '55555555-5555-4555-8555-555555555555' }),
  useSearchParams: () => nav.searchParams,
  usePathname: () => '/admin',
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 問い合わせの詳細の画面はメッセージの末尾へ scrollIntoView する。テストの DOM には無いので、何もしない関数を置く
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => undefined;
}

const ID = '55555555-5555-4555-8555-555555555555';
const ASSIGNEE_ID = '66666666-6666-4666-8666-666666666666';
const MFA_REQUIRED_MESSAGE = '二段階認証の確認が必要です';
const MFA_ENROLLMENT_REQUIRED_MESSAGE = '二段階認証の登録が必要です';
const FORBIDDEN_MESSAGE = '権限がありません';
const CREATED_AT = '2026-10-01T00:00:00.000Z';

/** 解決済みの params (React の use() が Suspense で止まらないように、status が fulfilled の thenable にする) */
function fulfilledParams(): Promise<{ id: string }> {
  const value = { id: ID };
  return Object.assign(Promise.resolve(value), { status: 'fulfilled' as const, value });
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const forbiddenJson = (message: string) => jsonResponse(403, { error: { code: 'OP_PERMISSION_DENIED', message } });

const ticket = {
  id: ID,
  user_id: ASSIGNEE_ID,
  subject: '件名',
  category: 'general',
  priority: 'medium',
  status: 'open',
  assignee_id: null,
  first_response_at: null,
  resolved_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  messages: [],
};

const lead = {
  id: ID,
  company_name: '株式会社テスト',
  industry: null,
  employee_count: null,
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  source: null,
  stage: 'approach',
  assigned_to: null,
  estimated_acv: null,
  notes: null,
  converted_org_id: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  activities: [],
};

interface RouteCase {
  name: string;
  load: () => Promise<ComponentType<{ params: Promise<{ id: string }> }>>;
  /** 経路の固定の文 (ロールが足りない・本文が読めない 403 のときに出す。直す前は 403 でもいつもこの文だった) */
  fixedMessage: string;
  /** 403 を返す要求か (それ以外の要求は画面を描くための成功の応答を返す) */
  isTarget: (url: string, init?: RequestInit) => boolean;
  /** 403 を受けない要求への成功の応答 */
  okResponse: (url: string) => Response;
  /** 描画のあと、403 を受ける操作をする (読み込みで受ける経路は何もしない) */
  act?: (container: HTMLElement) => Promise<void>;
  /** 文を alert で出す経路か */
  viaAlert?: boolean;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 入力欄に値を入れる (React の onChange を発火させる) */
async function typeInto(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 文字が label のボタンを押す */
async function clickButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  expect(button, `ボタン「${label}」が見つからない`).toBeDefined();
  expect(button!.disabled, `ボタン「${label}」が押せない`).toBe(false);
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const CASES: RouteCase[] = [
  {
    name: '/admin/support/[id] の担当者の割り当て',
    load: async () => (await import('@/app/admin/support/[id]/page')).default,
    fixedMessage: '割り当て失敗',
    isTarget: (url) => url.endsWith('/assign'),
    okResponse: () => jsonResponse(200, { data: ticket }),
    act: async (container) => {
      await typeInto(container.querySelector('input[placeholder="ユーザー UUID"]') as HTMLInputElement, ASSIGNEE_ID);
      await clickButton(container, '担当者を設定');
    },
  },
  {
    name: '/admin/support/[id] の状態の変更',
    load: async () => (await import('@/app/admin/support/[id]/page')).default,
    fixedMessage: 'ステータス変更失敗',
    isTarget: (_url, init) => init?.method === 'PATCH',
    okResponse: () => jsonResponse(200, { data: ticket }),
    act: async (container) => {
      await clickButton(container, '対応中');
    },
  },
  {
    name: '/admin/sales/[id] のステージの変更',
    load: async () => (await import('@/app/admin/sales/[id]/page')).default,
    fixedMessage: 'ステージ変更失敗',
    isTarget: (_url, init) => init?.method === 'PATCH',
    okResponse: () => jsonResponse(200, { data: lead }),
    act: async (container) => {
      await clickButton(container, '商談中');
    },
  },
  {
    name: '/super-admin/audit-logs の CSV の書き出し',
    load: async () =>
      (await import('@/app/super-admin/audit-logs/page')).default as ComponentType<{ params: Promise<{ id: string }> }>,
    fixedMessage: 'CSV エクスポートに失敗しました',
    isTarget: (url) => url.includes('format=csv'),
    okResponse: () => jsonResponse(200, { data: [], meta: { total: 0 } }),
    act: async (container) => {
      await clickButton(container, 'CSV エクスポート');
    },
    viaAlert: true,
  },
  {
    name: '/support/users の利用者の一覧の読み込み',
    load: async () =>
      (await import('@/app/(support)/support/users/page')).default as ComponentType<{ params: Promise<{ id: string }> }>,
    fixedMessage: 'ユーザー一覧を取得できませんでした。しばらくしてから、もう一度お試しください。',
    isTarget: (url) => url.startsWith('/api/admin/users'),
    okResponse: () => jsonResponse(200, {}),
  },
];

let container: HTMLDivElement;
let root: Root;
let alertMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  alertMock = vi.fn();
  vi.stubGlobal('alert', alertMock);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

/** 対象の要求にだけ forbidden を返し、ほかの要求には成功の応答を返す */
function stubApi(routeCase: RouteCase, forbidden: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return routeCase.isTarget(url, init) ? forbidden() : routeCase.okResponse(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('alert', alertMock);
  return fetchMock;
}

async function renderCase(routeCase: RouteCase) {
  const Page = await routeCase.load();
  await act(async () => {
    root.render(createElement(Suspense, { fallback: null }, createElement(Page, { params: fulfilledParams() })));
  });
  await settle();
  if (routeCase.act) await routeCase.act(container);
}

/** 画面に出た文 (alert で出す経路は alert に渡した文、それ以外は画面の文字) */
function shownText(routeCase: RouteCase): string {
  return routeCase.viaAlert ? alertMock.mock.calls.map((call) => String(call[0])).join('\n') : container.textContent ?? '';
}

describe.each(CASES)('$name の 403 (#1917)', (routeCase) => {
  it.each([MFA_REQUIRED_MESSAGE, MFA_ENROLLMENT_REQUIRED_MESSAGE])(
    '本文の文が二段階認証の文 (%s) なら、その文を出し、経路の固定の文は出さない',
    async (message) => {
      const fetchMock = stubApi(routeCase, () => forbiddenJson(message));
      await renderCase(routeCase);

      expect(fetchMock.mock.calls.some(([input, init]) => routeCase.isTarget(String(input), init))).toBe(true);
      const shown = shownText(routeCase);
      expect(shown).toContain(message);
      expect(shown).not.toContain(routeCase.fixedMessage);
    },
  );

  it.each([
    ['運営の route のロールが足りない文', () => forbiddenJson(FORBIDDEN_MESSAGE)],
    ['本文が JSON として読めない', () => new Response('<html>Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } })],
  ])('%s なら、経路の固定の文を出す (直す前と同じ)', async (_label, response) => {
    const fetchMock = stubApi(routeCase, response);
    await renderCase(routeCase);

    expect(fetchMock.mock.calls.some(([input, init]) => routeCase.isTarget(String(input), init))).toBe(true);
    const shown = shownText(routeCase);
    expect(shown).toContain(routeCase.fixedMessage);
    expect(shown).not.toContain('二段階認証');
    expect(shown).not.toContain('Forbidden');
  });
});
