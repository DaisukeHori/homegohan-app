/**
 * #1917 の続き (整合 1025b): 運営の画面 (問い合わせのチケット・営業リード・開示等の請求) が、API の 403 の本文の理由の文
 * (二段階認証の確認・登録が要る) を、固定の「権限がありません」で上書きしないことのテスト
 *
 * 以前は、どの画面も 403 を受けると本文を読まずに「権限がありません」を出していた。運営の route は、ゲートの後で
 * セッションの状態が変わったとき 403 の本文に二段階認証の文を入れる (#2014) ので、二段階認証が要るのに権限が無いように見えた。
 *
 * 直したあとの不変条件 (下の CASES の画面ごと):
 *   - 403 の本文の文が二段階認証の文なら、その文を出し、「権限がありません」は出さない
 *   - ロールが足りない 403 (本文の文が「権限がありません」・「この操作を行う権限がありません」) や、本文が読めない 403 は「権限がありません」
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// useRouter は描画のたびに同じ物を返す (router を依存に持つ読み込みが描画のたびに走らないように)
const nav = vi.hoisted(() => ({ router: { push: () => undefined, replace: () => undefined, refresh: () => undefined } }));
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: '44444444-4444-4444-8444-444444444444' }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = '44444444-4444-4444-8444-444444444444';
const MFA_REQUIRED_MESSAGE = '二段階認証の確認が必要です';
const MFA_ENROLLMENT_REQUIRED_MESSAGE = '二段階認証の登録が必要です';
const FORBIDDEN_MESSAGE = '権限がありません';

/**
 * 解決済みの params。React の use() は status が fulfilled の thenable なら止まらずに value を返すので、
 * 描画を Suspense で止めずに済む
 */
function fulfilledParams(): Promise<{ id: string }> {
  const value = { id: ID };
  return Object.assign(Promise.resolve(value), { status: 'fulfilled' as const, value });
}

interface PageCase {
  name: string;
  load: () => Promise<ComponentType<{ params: Promise<{ id: string }> }>>;
  /** 描画のあと、403 を受ける操作をする (読み込みで受ける画面は何もしない) */
  act?: (container: HTMLElement) => Promise<void>;
}

/** 入力欄に値を入れる (React の onChange を発火させる) */
async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitForm(container: HTMLElement) {
  const form = container.querySelector('form');
  expect(form, 'フォームが見つからない').not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const CASES: PageCase[] = [
  {
    name: '/admin/support (チケットの一覧の読み込み)',
    load: async () => (await import('@/app/admin/support/page')).default as ComponentType<{ params: Promise<{ id: string }> }>,
  },
  {
    name: '/admin/support/[id] (チケットの詳細の読み込み)',
    load: async () => (await import('@/app/admin/support/[id]/page')).default,
  },
  {
    name: '/admin/support/new (チケットの作成)',
    load: async () => (await import('@/app/admin/support/new/page')).default as ComponentType<{ params: Promise<{ id: string }> }>,
    act: async (container) => {
      const inputs = container.querySelectorAll('input');
      await typeInto(inputs[0] as HTMLInputElement, ID);
      await typeInto(inputs[1] as HTMLInputElement, '件名');
      await typeInto(container.querySelector('textarea') as HTMLTextAreaElement, '本文');
      await submitForm(container);
    },
  },
  {
    name: '/admin/sales (リードの一覧の読み込み)',
    load: async () => (await import('@/app/admin/sales/page')).default as ComponentType<{ params: Promise<{ id: string }> }>,
  },
  {
    name: '/admin/sales/new (リードの作成)',
    load: async () => (await import('@/app/admin/sales/new/page')).default as ComponentType<{ params: Promise<{ id: string }> }>,
    act: async (container) => {
      await typeInto(container.querySelector('input') as HTMLInputElement, '株式会社テスト');
      await submitForm(container);
    },
  },
  {
    name: '/admin/sales/[id] (リードの詳細の読み込み)',
    load: async () => (await import('@/app/admin/sales/[id]/page')).default,
  },
  {
    name: '/admin/data-requests (開示等の請求の一覧の読み込み)',
    load: async () => (await import('@/app/admin/data-requests/page')).default as ComponentType<{ params: Promise<{ id: string }> }>,
  },
  {
    name: '/admin/data-requests/[id] (開示等の請求の詳細の読み込み)',
    load: async () => (await import('@/app/admin/data-requests/[id]/page')).default as ComponentType<{ params: Promise<{ id: string }> }>,
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

/** どの要求にも、与えた 403 の応答を返す */
function stubForbidden(response: () => Response) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const forbiddenJson = (message: string) =>
  new Response(JSON.stringify({ error: { code: 'OP_PERMISSION_DENIED', message } }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });

async function renderCase(pageCase: PageCase) {
  const Page = await pageCase.load();
  await act(async () => {
    root.render(createElement(Suspense, { fallback: null }, createElement(Page, { params: fulfilledParams() })));
  });
  await settle();
  if (pageCase.act) await pageCase.act(container);
}

describe.each(CASES)('$name の 403 (#1917)', (pageCase) => {
  it.each([MFA_REQUIRED_MESSAGE, MFA_ENROLLMENT_REQUIRED_MESSAGE])(
    '本文の文が二段階認証の文 (%s) なら、その文を出し「権限がありません」は出さない',
    async (message) => {
      const fetchMock = stubForbidden(() => forbiddenJson(message));
      await renderCase(pageCase);

      expect(fetchMock).toHaveBeenCalled();
      expect(container.textContent).toContain(message);
      expect(container.textContent).not.toContain(FORBIDDEN_MESSAGE);
    },
  );

  it.each([
    ['運営の route のロールが足りない文', () => forbiddenJson(FORBIDDEN_MESSAGE)],
    ['既定の表のロールが足りない文', () => forbiddenJson('この操作を行う権限がありません')],
    ['本文が JSON として読めない', () => new Response('<html>Forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } })],
  ])('%s なら「権限がありません」を出す', async (_label, response) => {
    const fetchMock = stubForbidden(response);
    await renderCase(pageCase);

    expect(fetchMock).toHaveBeenCalled();
    expect(container.textContent).toContain(FORBIDDEN_MESSAGE);
    expect(container.textContent).not.toContain('二段階認証');
    expect(container.textContent).not.toContain('Forbidden');
  });
});
