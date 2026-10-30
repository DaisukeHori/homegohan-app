/**
 * #2120 W4: 問い合わせの返信 (admin/support/[id]) が済んだあとに入力欄を空にするか決める比べ方を、経路によらずそろえる
 *
 * 以前の画面は、送れた (201) 経路では入力欄を送った本文とそのまま (===) 比べ、応答が切れて読み直した経路では前後の空白を除いて比べた。
 * 送信の応答を待つあいだに運営が空白や改行だけを書き足すと、送れたのに送った本文が入力欄に残り、もう一度送ると
 * 顧客に同じ返信のメールが 2 通届きうる。
 * 直したあと (不変条件): どちらの経路も isReplyInputAsSent (前後の空白を除いて比べる) で決める。
 *   - 前後の空白・改行だけを書き足したなら、送れたあと入力欄を空にする
 *   - 文を書き足したなら、送れたあとも残す (#2107 Y7)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPLY_DELIVERED_GUIDE, isReplyInputAsSent } from '@/lib/admin/support-reply-no-response';

const TICKET_ID = '21202120-2120-4120-8120-212021202120';
const KNOWN_MESSAGE_ID = '21202120-0000-4000-8000-000000000001';
const DELIVERED_MESSAGE_ID = '21202120-0000-4000-8000-000000000002';
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_GATEWAY_TIMEOUT = 504;

const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined } };
});

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '21202120-2120-4120-8120-212021202120' }),
  useRouter: () => nav.router,
  usePathname: () => '/admin/support',
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: TicketDetailPage } = await import('@/app/admin/support/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPLY = 'パスワードの再設定をお試しください';
const KNOWN_MESSAGE = {
  id: KNOWN_MESSAGE_ID,
  sender_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  is_internal: false,
  body: 'ログインできません',
  created_at: '2026-10-31T00:00:00.000Z',
};
const TICKET = {
  id: TICKET_ID,
  user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  subject: '返信の入力欄の問い合わせ',
  category: 'other',
  priority: 'medium',
  status: 'open',
  assignee_id: null,
  first_response_at: null,
  resolved_at: null,
  created_at: '2026-10-31T00:00:00.000Z',
  updated_at: '2026-10-31T00:00:00.000Z',
  messages: [KNOWN_MESSAGE],
};
/** route は前後の空白を除いた本文を保存する */
const deliveredTicket = () => ({
  ...TICKET,
  status: 'in_progress',
  messages: [
    KNOWN_MESSAGE,
    { id: DELIVERED_MESSAGE_ID, sender_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', is_internal: false, body: REPLY, created_at: '2026-10-31T00:01:00.000Z' },
  ],
});

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
/** 本文が JSON でない失敗の応答 (手前のプロキシ・ホスティングの応答) */
const proxyResponse = (status: number) =>
  new Response('<html><body>Gateway Timeout</body></html>', { status, headers: { 'content-type': 'text/html' } });

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
}

async function typeInto(element: HTMLTextAreaElement | null, value: string) {
  expect(element).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** あとから解決する応答 (送信の応答を待つあいだに入力を書き換える筋書きに使う) */
function deferredResponse() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const methodOf = (init: unknown) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
const postCount = () => fetchMock.mock.calls.filter(([, init]) => methodOf(init) === 'POST').length;
const replyTextarea = () => container.querySelector<HTMLTextAreaElement>('textarea');
const text = () => container.textContent ?? '';

/** POST は post の応答を待たせ、GET は 1 回目に送る前のチケット、2 回目からは返信の届いたチケットを返す */
function stubDeferredPost(post: ReturnType<typeof deferredResponse>) {
  let gets = 0;
  fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') return post.promise;
    gets += 1;
    return jsonResponse(HTTP_OK, { data: gets === 1 ? TICKET : deliveredTicket() });
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** チケットを開いて返信を送り、送信の応答を待つあいだに入力欄を rewritten に書き換えてから、応答を返す */
async function sendAndRewriteWhilePending(rewritten: string, response: () => Response) {
  const post = deferredResponse();
  stubDeferredPost(post);
  await act(async () => {
    root.render(createElement(Suspense, { fallback: null }, createElement(TicketDetailPage, { params: Promise.resolve({ id: TICKET_ID }) })));
  });
  await settle();
  await typeInto(replyTextarea(), REPLY);
  const send = findButton('返信を送信');
  expect(send, '「返信を送信」ボタンが見つからない').toBeDefined();
  await act(async () => {
    send!.click();
  });
  await settle();
  await typeInto(replyTextarea(), rewritten);
  await act(async () => {
    post.resolve(response());
  });
  await settle();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  nav.push.mockReset();
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

describe('isReplyInputAsSent: 入力欄が送った本文のままか (#2120 W4)', () => {
  it('前後の空白・改行だけの違いは、送った本文のままと見なす', () => {
    expect(isReplyInputAsSent(REPLY, REPLY)).toBe(true);
    expect(isReplyInputAsSent(`${REPLY}  `, REPLY)).toBe(true);
    expect(isReplyInputAsSent(`\n ${REPLY}\n\n`, REPLY)).toBe(true);
    expect(isReplyInputAsSent(REPLY, `${REPLY} \n`)).toBe(true);
  });

  it('文を書き足した・書き換えたなら、送った本文のままと見なさない', () => {
    expect(isReplyInputAsSent(`${REPLY}\n追記`, REPLY)).toBe(false);
    expect(isReplyInputAsSent(`${REPLY}。`, REPLY)).toBe(false);
    expect(isReplyInputAsSent('', REPLY)).toBe(false);
  });
});

describe('問い合わせの返信: 送れたあと入力欄を空にするか決める比べ方を、経路によらずそろえる (#2120 W4)', () => {
  it('送れた (201) 経路: 応答を待つあいだに末尾へ空白と改行だけを書き足しても、送れたあと入力欄を空にする', async () => {
    await sendAndRewriteWhilePending(`${REPLY}  \n`, () =>
      jsonResponse(HTTP_CREATED, { data: { id: DELIVERED_MESSAGE_ID }, email: { status: 'sent' } }),
    );

    expect(postCount()).toBe(1);
    expect(replyTextarea()!.value).toBe('');
  });

  it('送れた (201) 経路: 応答を待つあいだに先頭へ空白だけを書き足しても、送れたあと入力欄を空にする', async () => {
    await sendAndRewriteWhilePending(`  ${REPLY}`, () =>
      jsonResponse(HTTP_CREATED, { data: { id: DELIVERED_MESSAGE_ID }, email: { status: 'sent' } }),
    );

    expect(postCount()).toBe(1);
    expect(replyTextarea()!.value).toBe('');
  });

  it('送れた (201) 経路: 応答を待つあいだに文を書き足したなら、送れたあとも残す', async () => {
    const rewritten = `${REPLY}\n追記`;
    await sendAndRewriteWhilePending(rewritten, () =>
      jsonResponse(HTTP_CREATED, { data: { id: DELIVERED_MESSAGE_ID }, email: { status: 'sent' } }),
    );

    expect(postCount()).toBe(1);
    expect(replyTextarea()!.value).toBe(rewritten);
  });

  it('読み直しの経路 (本文の無い 504): 応答を待つあいだに末尾へ空白と改行だけを書き足しても、届いていたと分かったら入力欄を空にする', async () => {
    await sendAndRewriteWhilePending(`${REPLY}  \n`, () => proxyResponse(HTTP_GATEWAY_TIMEOUT));

    expect(postCount()).toBe(1);
    expect(text()).toContain(REPLY_DELIVERED_GUIDE);
    expect(replyTextarea()!.value).toBe('');
  });

  it('読み直しの経路 (本文の無い 504): 応答を待つあいだに文を書き足したなら、届いていたと分かっても残す', async () => {
    const rewritten = `${REPLY}\n追記`;
    await sendAndRewriteWhilePending(rewritten, () => proxyResponse(HTTP_GATEWAY_TIMEOUT));

    expect(postCount()).toBe(1);
    expect(text()).toContain(REPLY_DELIVERED_GUIDE);
    expect(replyTextarea()!.value).toBe(rewritten);
  });
});
