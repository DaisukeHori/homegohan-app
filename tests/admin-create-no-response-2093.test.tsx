/**
 * #2093 W1: 運営・管理の作成と送信の画面が、通信切れ・本文に API の文の無い 502 / 503 / 504 のあとに押し直しで二重に作らない
 *
 * 以前の画面は、fetch の reject と本文に文の無い 502 / 504 を「失敗」として文を出すだけで、状態を読み直さなかった。
 * サーバーは済ませてから応答が切れていることがある (返信の route は insert のあと顧客へのメールの送信を待ってから応答する) ので、
 * 押し直すと、サポートの返信 (顧客へのメール)・チケット・リードが二重に作られた (この 3 つの表には一意の制約が無い)。
 * 直したあと (不変条件):
 *   - 返信 (admin/support/[id]): 応答を受け取れなかったら、チケットを読み直す。送る前に無かった、送った本文と同じ種類 (外部返信 / 内部メモ) の行が
 *     あれば済んだとして入力欄を空にし、その旨を出す。無ければ本文を残して「まだ送られていません」。読み直しにも失敗したら送信を止め、
 *     「再試行」(読み直し) で確かめるまで送らせない
 *   - 作成 (admin/support/new・admin/sales/new): 応答を受け取れなかったら、送信を止め、「済んだか分かりません。一覧で確かめてから作り直してください」と
 *     一覧へのリンクを出す。押し直しても送らない。続けて押しても 1 回しか送らない
 *   - 本文に API の文がある 502 / 503 / 504 と、ほかの失敗 (500 など) は、これまでどおり失敗として文を出し、押し直せる
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminActionNoResponseError,
  AdminScreenError,
  ADMIN_ACTION_NO_RESPONSE_STATUSES,
  adminActionErrorOfResponse,
  adminActionNoResponseSummary,
  sendAdminAction,
} from '@/lib/admin/admin-screen-messages';
import { isReplyDelivered } from '@/lib/admin/support-reply-no-response';

const TICKET_ID = '20932093-2093-4093-8093-209320932093';
const KNOWN_MESSAGE_ID = '20932093-0000-4000-8000-000000000001';
const DELIVERED_MESSAGE_ID = '20932093-0000-4000-8000-000000000002';

const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined } };
});
const routerPush = nav.push;

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '20932093-2093-4093-8093-209320932093' }),
  useRouter: () => nav.router,
  usePathname: () => '/admin/support',
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: TicketDetailPage } = await import('@/app/admin/support/[id]/page');
const { default: NewTicketPage } = await import('@/app/admin/support/new/page');
const { default: NewLeadPage } = await import('@/app/admin/sales/new/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 本文が JSON でない失敗の応答 (手前のプロキシ・ホスティングの応答) */
const proxyResponse = (status: number) =>
  new Response('<html><body>Gateway Timeout</body></html>', { status, headers: { 'content-type': 'text/html' } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root.render(createElement(Suspense, { fallback: null }, element));
  });
  await settle();
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

/** input / textarea に値を入れる (React の onChange を通す) */
async function typeInto(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(element).not.toBeNull();
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitForm() {
  await act(async () => {
    container.querySelector('form')!.requestSubmit();
  });
  await settle();
}

const text = () => container.textContent ?? '';
const textarea = () => container.querySelector<HTMLTextAreaElement>('textarea');

type FetchMock = ReturnType<typeof vi.fn>;
const postCalls = (fetchMock: FetchMock) =>
  fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === 'POST');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routerPush.mockReset();
  // メッセージの一覧の末尾へのスクロール (テストの DOM には無いので、何もしない関数を置く)
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin-screen-messages: 書き込みの応答を受け取れなかったかの分け方 (#2093 W1)', () => {
  it('応答を受け取れなかったとみなすのは 502 / 503 / 504 (運営のメンバーシップの強制操作と同じ)', () => {
    expect([...ADMIN_ACTION_NO_RESPONSE_STATUSES]).toEqual([502, 503, 504]);
  });

  it('fetch の reject は AdminActionNoResponseError (status は null。文は「（通信エラー）」)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw networkFailure();
    }));
    const err = await sendAdminAction('/api/x', { method: 'POST' }, 'リードの作成').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminActionNoResponseError);
    expect((err as AdminActionNoResponseError).status).toBeNull();
    expect((err as AdminActionNoResponseError).message).toBe('リードの作成の応答を受け取れませんでした（通信エラー）');
  });

  it.each([502, 503, 504])('本文に API の文の無い %i は AdminActionNoResponseError (文は「(HTTP n)」)', async (status) => {
    const err = await adminActionErrorOfResponse(proxyResponse(status), 'リードの作成');
    expect(err).toBeInstanceOf(AdminActionNoResponseError);
    expect((err as AdminActionNoResponseError).status).toBe(status);
    expect(err.message).toBe(`リードの作成の応答を受け取れませんでした (HTTP ${status})`);
    expect(adminActionNoResponseSummary('リードの作成', status)).toBe(err.message);
  });

  it('本文に API の文がある 503 は route の応答なので、ふつうの失敗 (AdminScreenError の文)', async () => {
    const err = await adminActionErrorOfResponse(
      jsonResponse(503, { error: { code: 'SERVICE_UNAVAILABLE', message: 'ただいま混み合っています' } }),
      'リードの作成',
    );
    expect(err).not.toBeInstanceOf(AdminActionNoResponseError);
    expect(err).toBeInstanceOf(AdminScreenError);
    expect(err.message).toBe('ただいま混み合っています');
  });

  it('本文に英字だけの API の文がある 502 も route の応答なので、ふつうの失敗 (文は「(HTTP n)」の固定の文)', async () => {
    const err = await adminActionErrorOfResponse(jsonResponse(502, { error: 'upstream failed' }), 'リードの作成');
    expect(err).not.toBeInstanceOf(AdminActionNoResponseError);
    expect(err.message).toBe('リードの作成に失敗しました (HTTP 502)');
  });

  it('500 は本文が無くてもふつうの失敗 (応答を受け取れなかったとはみなさない)', async () => {
    const err = await adminActionErrorOfResponse(proxyResponse(500), 'リードの作成');
    expect(err).not.toBeInstanceOf(AdminActionNoResponseError);
    expect(err.message).toBe('リードの作成に失敗しました (HTTP 500)');
  });
});

describe('isReplyDelivered: 読み直したメッセージから、送った返信が届いていたかを決める (#2093 W1)', () => {
  const known = new Set([KNOWN_MESSAGE_ID]);
  const row = (id: string, body: string, isInternal: boolean) => ({ id, body, is_internal: isInternal });

  it('送る前に無かった、送った本文 (前後の空白を除いたもの。route が trim して保存する) と同じ種類の行があれば届いている', () => {
    expect(isReplyDelivered([row(DELIVERED_MESSAGE_ID, 'お待たせしました', false)], known, { body: '  お待たせしました\n', isInternal: false })).toBe(true);
  });

  it('送る前からあった行は数えない (同じ本文でも)', () => {
    expect(isReplyDelivered([row(KNOWN_MESSAGE_ID, 'お待たせしました', false)], known, { body: 'お待たせしました', isInternal: false })).toBe(false);
  });

  it('種類 (外部返信 / 内部メモ) が違う行は数えない', () => {
    expect(isReplyDelivered([row(DELIVERED_MESSAGE_ID, 'お待たせしました', true)], known, { body: 'お待たせしました', isInternal: false })).toBe(false);
  });

  it('本文が違う行は数えない', () => {
    expect(isReplyDelivered([row(DELIVERED_MESSAGE_ID, 'お待たせしました。', false)], known, { body: 'お待たせしました', isInternal: false })).toBe(false);
  });
});

describe('問い合わせの詳細: 返信の送信の応答を受け取れなかったら、読み直して二重に送らない (#2093 W1)', () => {
  const KNOWN_MESSAGE = {
    id: KNOWN_MESSAGE_ID,
    sender_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    is_internal: false,
    body: 'ログインできません',
    created_at: '2026-10-30T00:00:00.000Z',
  };
  const TICKET = {
    id: TICKET_ID,
    user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    subject: '通信の切れる問い合わせ',
    category: 'other',
    priority: 'medium',
    status: 'open',
    assignee_id: null,
    first_response_at: null,
    resolved_at: null,
    created_at: '2026-10-30T00:00:00.000Z',
    updated_at: '2026-10-30T00:00:00.000Z',
    messages: [KNOWN_MESSAGE],
  };
  const REPLY = 'パスワードの再設定をお試しください';
  const deliveredTicket = (isInternal = false) => ({
    ...TICKET,
    status: 'in_progress',
    messages: [
      KNOWN_MESSAGE,
      { id: DELIVERED_MESSAGE_ID, sender_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', is_internal: isInternal, body: REPLY, created_at: '2026-10-30T00:01:00.000Z' },
    ],
  });

  /** GET はキューの順に返し (尽きたら最後のもの)、POST は postResult を返す fetch */
  function stubTicketFetch(getResults: Array<() => Response>, postResult: () => Response) {
    let getIndex = 0;
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') return postResult();
      const next = getResults[Math.min(getIndex, getResults.length - 1)];
      getIndex += 1;
      return next();
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function openAndType(body: string) {
    await renderElement(createElement(TicketDetailPage, { params: Promise.resolve({ id: TICKET_ID }) }));
    await typeInto(textarea(), body);
  }

  it('通信が切れたあと、読み直して返信が届いていれば済んだとして入力欄を空にし、もう一度は送らない', async () => {
    const fetchMock = stubTicketFetch(
      [() => jsonResponse(200, { data: TICKET }), () => jsonResponse(200, { data: deliveredTicket() })],
      () => {
        throw networkFailure();
      },
    );
    await openAndType(`${REPLY}\n`);
    await click(findButton('返信を送信'), '「返信を送信」ボタン');

    expect(postCalls(fetchMock)).toHaveLength(1);
    expect(textarea()!.value).toBe('');
    expect(text()).toContain('メッセージの送信の応答を受け取れませんでした（通信エラー）');
    expect(text()).toContain('読み込み直したところ、送った内容は保存されていました');
    expect(text()).toContain('お客様へのメールの通知が届いたかは分かりません');
    expect(text()).not.toContain('Failed to fetch');
    // 読み直したチケットを出す (返信の行が見え、状態は対応中)
    expect(text()).toContain(REPLY);
    expect(findButton('返信を送信')!.disabled).toBe(true);
  });

  it('本文の無い 504 のあと、読み直しても返信が無ければ本文を残し「まだ送られていません」。押し直せる', async () => {
    const fetchMock = stubTicketFetch([() => jsonResponse(200, { data: TICKET })], () => proxyResponse(504));
    await openAndType(REPLY);
    await click(findButton('返信を送信'), '「返信を送信」ボタン');

    expect(textarea()!.value).toBe(REPLY);
    expect(text()).toContain('メッセージの送信の応答を受け取れませんでした (HTTP 504)');
    expect(text()).toContain('まだ送られていません');
    expect(findButton('返信を送信')!.disabled).toBe(false);
    expect(postCalls(fetchMock)).toHaveLength(1);
  });

  it('送る前からあった同じ本文の行は「届いた」と数えない (本文を残す)', async () => {
    stubTicketFetch([() => jsonResponse(200, { data: TICKET })], () => proxyResponse(502));
    await openAndType(KNOWN_MESSAGE.body);
    await click(findButton('返信を送信'), '「返信を送信」ボタン');

    expect(textarea()!.value).toBe(KNOWN_MESSAGE.body);
    expect(text()).toContain('まだ送られていません');
  });

  it('内部メモを送って応答が切れたとき、同じ本文の外部返信の行は「届いた」と数えない', async () => {
    stubTicketFetch(
      [() => jsonResponse(200, { data: TICKET }), () => jsonResponse(200, { data: deliveredTicket(false) })],
      () => proxyResponse(503),
    );
    await renderElement(createElement(TicketDetailPage, { params: Promise.resolve({ id: TICKET_ID }) }));
    await click(findButton('内部メモ'), '「内部メモ」ボタン');
    await typeInto(textarea(), REPLY);
    await click(findButton('メモを保存'), '「メモを保存」ボタン');

    expect(textarea()!.value).toBe(REPLY);
    expect(text()).toContain('メッセージの送信の応答を受け取れませんでした (HTTP 503)');
    expect(text()).toContain('まだ送られていません');
  });

  it('内部メモが届いていれば済んだとして空にする (メールの文は添えない)', async () => {
    stubTicketFetch(
      [() => jsonResponse(200, { data: TICKET }), () => jsonResponse(200, { data: deliveredTicket(true) })],
      () => proxyResponse(503),
    );
    await renderElement(createElement(TicketDetailPage, { params: Promise.resolve({ id: TICKET_ID }) }));
    await click(findButton('内部メモ'), '「内部メモ」ボタン');
    await typeInto(textarea(), REPLY);
    await click(findButton('メモを保存'), '「メモを保存」ボタン');

    expect(textarea()!.value).toBe('');
    expect(text()).toContain('読み込み直したところ、送った内容は保存されていました');
    expect(text()).not.toContain('メールの通知');
  });

  it('読み直しにも失敗したら送信を止め、「再試行」で読み直して確かめるまで送らない', async () => {
    const fetchMock = stubTicketFetch(
      [() => jsonResponse(200, { data: TICKET }), () => proxyResponse(502), () => jsonResponse(200, { data: deliveredTicket() })],
      () => {
        throw networkFailure();
      },
    );
    await openAndType(REPLY);
    await click(findButton('返信を送信'), '「返信を送信」ボタン');

    expect(text()).toContain('送られたか分かりません');
    expect(textarea()!.value).toBe(REPLY);
    expect(findButton('返信を送信')!.disabled).toBe(true);
    // 押しても送らない (ボタンが止まっていても、押されたときに送らないことを確かめる)
    await act(async () => {
      findButton('返信を送信')!.disabled = false;
    });
    await click(findButton('返信を送信'), '「返信を送信」ボタン');
    expect(postCalls(fetchMock)).toHaveLength(1);

    await click(findButton('再試行'), '「再試行」ボタン');

    expect(postCalls(fetchMock)).toHaveLength(1);
    expect(textarea()!.value).toBe('');
    expect(text()).toContain('読み込み直したところ、送った内容は保存されていました');
    expect(findButton('再試行')).toBeUndefined();
  });

  it('「再試行」で読み直して届いていなければ、本文を残して送信を戻す', async () => {
    const fetchMock = stubTicketFetch(
      [() => jsonResponse(200, { data: TICKET }), () => proxyResponse(502), () => jsonResponse(200, { data: TICKET })],
      () => proxyResponse(504),
    );
    await openAndType(REPLY);
    await click(findButton('返信を送信'), '「返信を送信」ボタン');
    await click(findButton('再試行'), '「再試行」ボタン');

    expect(textarea()!.value).toBe(REPLY);
    expect(text()).toContain('まだ送られていません');
    expect(findButton('返信を送信')!.disabled).toBe(false);
    expect(findButton('再試行')).toBeUndefined();
    expect(postCalls(fetchMock)).toHaveLength(1);
  });

  it('本文に API の文がある 502 はふつうの失敗 (読み直さずに文を出し、本文を残す)', async () => {
    const fetchMock = stubTicketFetch(
      [() => jsonResponse(200, { data: TICKET })],
      () => jsonResponse(502, { error: { code: 'EMAIL_PROVIDER_DOWN', message: '送信の準備に失敗しました' } }),
    );
    await openAndType(REPLY);
    await click(findButton('返信を送信'), '「返信を送信」ボタン');

    expect(text()).toContain('送信の準備に失敗しました');
    expect(text()).not.toContain('応答を受け取れませんでした');
    expect(textarea()!.value).toBe(REPLY);
    // 初めの読み込みの 1 回だけ (読み直さない)
    expect(fetchMock.mock.calls.length - postCalls(fetchMock).length).toBe(1);
  });
});

describe.each([
  {
    name: '問い合わせの起票 (admin/support/new)',
    Page: () => NewTicketPage,
    fill: async () => {
      await typeInto(container.querySelector<HTMLInputElement>('#user_id'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      await typeInto(container.querySelector<HTMLInputElement>('#subject'), 'ログインできない');
      await typeInto(container.querySelector<HTMLTextAreaElement>('#body'), '詳しい内容');
    },
    action: 'チケットの作成',
    subject: 'チケット',
    listHref: '/admin/support',
    submitLabel: 'チケットを起票',
  },
  {
    name: 'リードの登録 (admin/sales/new)',
    Page: () => NewLeadPage,
    fill: async () => {
      await typeInto(container.querySelector<HTMLInputElement>('#company_name'), '株式会社テスト');
    },
    action: 'リードの作成',
    subject: 'リード',
    listHref: '/admin/sales',
    submitLabel: 'リードを登録',
  },
])('$name: 作成の応答を受け取れなかったら、送信を止めて一覧で確かめさせる (#2093 W1)', ({ Page, fill, action, subject, listHref, submitLabel }) => {
  async function open() {
    await renderElement(createElement(Page()));
    await fill();
  }
  const listLink = () =>
    Array.from(container.querySelectorAll('a')).find((a) => a.getAttribute('href') === listHref && a.textContent?.includes('一覧で確かめる'));

  it('通信が切れたら「済んだか分かりません。一覧で確かめてから作り直してください」と一覧へのリンクを出し、押し直しても送らない', async () => {
    const fetchMock = vi.fn(async () => {
      throw networkFailure();
    });
    vi.stubGlobal('fetch', fetchMock);
    await open();
    await submitForm();

    expect(text()).toContain(`${action}の応答を受け取れませんでした（通信エラー）`);
    expect(text()).toContain('済んだか分かりません。一覧で確かめてから作り直してください');
    expect(listLink()).toBeDefined();
    expect(findButton(submitLabel)!.disabled).toBe(true);
    expect(text()).not.toContain('Failed to fetch');

    await submitForm();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
  });

  it.each([502, 503, 504])('本文の無い %i も同じ (送信を止める)', async (status) => {
    const fetchMock = vi.fn(async () => proxyResponse(status));
    vi.stubGlobal('fetch', fetchMock);
    await open();
    await submitForm();

    expect(text()).toContain(`${action}の応答を受け取れませんでした (HTTP ${status})`);
    expect(text()).toContain('済んだか分かりません');
    expect(listLink()).toBeDefined();
    await submitForm();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('500 などのふつうの失敗は文を出し、押し直せる (送信を止めない)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'サーバーでエラーが発生しました' } }));
    vi.stubGlobal('fetch', fetchMock);
    await open();
    await submitForm();

    expect(text()).toContain('サーバーでエラーが発生しました');
    expect(text()).not.toContain('済んだか分かりません');
    expect(findButton(submitLabel)!.disabled).toBe(false);
    await submitForm();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('続けて 2 回押しても (ボタンが止まる前でも) 1 回しか送らない', async () => {
    let resolvePost: (res: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvePost = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await open();
    await act(async () => {
      const form = container.querySelector('form')!;
      form.requestSubmit();
      form.requestSubmit();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePost(jsonResponse(201, { data: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } }));
    });
    await settle();
    expect(routerPush).toHaveBeenCalledWith(`${listHref}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`);
  });

  it('作成できたあと (画面が移る前) に押し直しても送らない', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { data: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } }));
    vi.stubGlobal('fetch', fetchMock);
    await open();
    await submitForm();
    expect(routerPush).toHaveBeenCalledTimes(1);

    await submitForm();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('作成の応答 (201) の本文が読めないときは、作成は済んでいるので送信を止め、一覧で確かめさせる', async () => {
    const fetchMock = vi.fn(async () => new Response('<html></html>', { status: 201, headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetchMock);
    await open();
    await submitForm();

    expect(text()).toContain(`${subject}は作成されましたが、作成した${subject}を開けませんでした。一覧で確かめてください`);
    expect(text()).not.toContain('SyntaxError');
    expect(listLink()).toBeDefined();
    await submitForm();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routerPush).not.toHaveBeenCalled();
  });
});
