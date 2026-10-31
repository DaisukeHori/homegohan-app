/**
 * #2101 X3・X4・X5・X8 (triage-1030b) のテスト: 運営の画面の 401 / 403 の残り・/login の next・壊れた一覧の応答
 *
 * 以前:
 *   - X3 チケットの返信の応答を受け取れず、チケットの読み直しが 401 / 403 で断られても、「再試行」を出し続けた (押しても必ず断られる)。
 *     止めているあいだに担当者・ステータスを変えると、送信は止まったまま止めている理由の文だけが消えた (fetchTicket の setError(null))
 *   - X4 運営の強制譲渡の応答を受け取れず、候補の読み直しが 401 / 403 で断られても「再試行」を出し続けた。候補の初めの読み込みの
 *     401 / 403 も「再試行」を出した。強制解散の一覧の読み直しの 401 / 403 は「「更新」で読み込み直して」と案内した。
 *     A/B テストの一覧・詳細、AI の利用上限の初めの読み込みの 401 / 403 は「読み込めませんでした (HTTP 401)」と「再試行」を出した
 *   - X5 運営の画面の 401 で /login へ移すとき next を付けず、ログインし直しても元の画面へ戻らなかった
 *   - X8 営業・チケット・クーポン・機能パッケージ・プランの一覧は、200 で data が配列でない壊れた応答を 0 件と見せた
 * 直したあと (不変条件):
 *   - X3 読み直しの 401 は「ログインし直してください」、403 は理由の文、404 は「チケットが見つかりません」を添え、「再試行」は出さない。
 *     送信は止めたまま。止めている理由の文はエラー欄と別に出し、担当者の設定・ステータスの変更のあとも消えない
 *   - X4 強制譲渡・強制解散の読み直しの 401 / 403 は理由の文を添え、「再試行」も「更新」も促さない (譲渡・解散は止めたまま)。
 *     候補の初めの読み込みの 401 / 403 も「再試行」を出さない。A/B テストの一覧・詳細・AI の利用上限の初めの読み込みの 401 / 403 は
 *     読み直しと同じ理由の文にし、「再試行」を出さない。メール送信の一覧の再送の通信が切れたあとの読み直しの 401 / 403 (同じ型) も
 *     理由の文を出し、「再試行」を出さない
 *   - X5 401 では /login?next=<今の画面のパス> へ移す。運営の画面に '/login' の直書きを増やさない (見張り)
 *   - X8 200 で data が配列でなければ読み込みの失敗の文を出し、「0 件」「〜がありません」と見せない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 * 一覧の Server Component (クーポン・機能パッケージ・プラン) は renderToStaticMarkup で描く。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_MFA_REQUIRED_MESSAGE } from '@/lib/api/forbidden-reason-messages';
import { listRowsOfBody, listTotalOfBody } from '@/lib/admin/admin-screen-messages';
import {
  OperatorLoadUnavailableError,
  OperatorScreenError,
  fetchOperatorRows,
} from '@/lib/membership/operator-screen-messages';

const TICKET_ID = '21012101-2101-4101-8101-210121012101';
const KNOWN_MESSAGE_ID = '21012101-0000-4000-8000-000000000001';
const FAMILY_ID = '21012101-1111-4111-8111-111111111111';
const ORG_ID = '21012101-3333-4333-8333-333333333333';
const MEMBER_A_ID = '21012101-5555-4555-8555-555555555555';
const MEMBER_B_ID = '21012101-6666-4666-8666-666666666666';
const DSR_ID = '21012101-4444-4444-8444-444444444444';
const EXPERIMENT_ID = '21012101-7777-4777-8777-777777777777';

/** 画面の文 (画面と同じもの) */
const RELOGIN_MESSAGE = 'ログインし直してください';
const RETRY_LABEL = '再試行';

const nav = vi.hoisted(() => {
  const push = vi.fn();
  return {
    push,
    pathname: '/admin',
    params: { id: '' },
    router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined },
  };
});

const serverMocks = vi.hoisted(() => ({ requireRoleForPage: vi.fn(), adminFetch: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  useParams: () => nav.params,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

vi.mock('@/lib/auth/page-guard', () => ({ requireRoleForPage: serverMocks.requireRoleForPage }));
vi.mock('@/lib/admin/fetch', () => ({ adminFetch: serverMocks.adminFetch }));

const { default: TicketDetailPage } = await import('@/app/admin/support/[id]/page');
const { default: TicketsPage } = await import('@/app/admin/support/page');
const { default: NewTicketPage } = await import('@/app/admin/support/new/page');
const { default: LeadsPage } = await import('@/app/admin/sales/page');
const { default: NewLeadPage } = await import('@/app/admin/sales/new/page');
const { default: DataRequestsPage } = await import('@/app/admin/data-requests/page');
const { default: DataRequestDetailPage } = await import('@/app/admin/data-requests/[id]/page');
const { default: FamilyTransferPage } = await import('@/app/(operator)/operator/membership/families/[id]/transfer/page');
const { default: OrgTransferPage } = await import('@/app/(operator)/operator/membership/orgs/[id]/transfer/page');
const { default: InactiveFamiliesPage } = await import('@/app/(operator)/operator/membership/families/inactive/page');
const { default: InactiveOrgsPage } = await import('@/app/(operator)/operator/membership/orgs/inactive/page');
const { default: ExperimentsPage } = await import('@/app/super-admin/experiments/page');
const { default: ExperimentDetailPage } = await import('@/app/super-admin/experiments/[id]/page');
const { default: LLMQuotasPage } = await import('@/app/super-admin/llm/quotas/page');
const { default: EmailOutboxPage } = await import('@/app/super-admin/email-outbox/page');
const { default: CouponsPage } = await import('@/app/super-admin/coupons/page');
const { default: FeaturePackagesPage } = await import('@/app/super-admin/feature-packages/page');
const { default: PlansPage } = await import('@/app/super-admin/plans/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** HTTP ステータス */
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;
const HTTP_GATEWAY_TIMEOUT = 504;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
/** 本文が JSON でない応答 (手前のプロキシ・ホスティングの応答) */
const proxyResponse = (status: number) =>
  new Response('<html><body>Gateway Timeout</body></html>', { status, headers: { 'content-type': 'text/html' } });
/** 401 の route の本文の文 (画面に出さない。#2112 Z4) */
const API_UNAUTHENTICATED_MESSAGE = '認証が必要です';
/** 401 (ログインが切れた) の route の応答 */
const unauthenticated = () => jsonResponse(HTTP_UNAUTHORIZED, { error: { code: 'AUTH_UNAUTHENTICATED', message: API_UNAUTHENTICATED_MESSAGE } });
/** 403 (二段階認証の確認が要る) の route の応答。理由の文は画面にそのまま出す */
const mfaForbidden = () => jsonResponse(HTTP_FORBIDDEN, { error: { code: 'OP_MFA_REQUIRED', message: API_MFA_REQUIRED_MESSAGE } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = (): never => {
  throw new TypeError('Failed to fetch');
};

type Responder = () => Response | Promise<Response>;
/** 呼ぶたびに順に返す (最後の応答は繰り返す) */
function sequence(...responders: Responder[]): Responder {
  let i = 0;
  return () => {
    const responder = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return responder();
  };
}

let container: HTMLDivElement;
let root: Root;
/** `<METHOD> <URL>` -> 応答。URL の ? より後ろは見ない */
let routes: Map<string, Responder>;
let calls: string[];

function route(method: string, url: string, responder: Responder) {
  routes.set(`${method} ${url}`, responder);
}
const countCalls = (key: string) => calls.filter((c) => c === key).length;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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

async function click(element: HTMLElement | null | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeTruthy();
  await act(async () => {
    element!.click();
  });
  await settle();
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(element).not.toBeNull();
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
    element!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const text = () => container.textContent ?? '';

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  nav.push.mockReset();
  nav.pathname = '/admin';
  nav.params = { id: '' };
  routes = new Map();
  calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input).split('?')[0];
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
    calls.push(key);
    const responder = routes.get(key);
    if (!responder) throw new Error(`テストに無い fetch: ${key}`);
    return responder();
  });
  // メッセージの一覧の末尾へのスクロール (テストの DOM には無いので、何もしない関数を置く)
  Element.prototype.scrollIntoView = () => undefined;
  serverMocks.requireRoleForPage.mockReset();
  serverMocks.adminFetch.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// X3: チケットの返信の読み直しの 401 / 403 / 404
// ─────────────────────────────────────────────────────────────────────────────

describe('X3 チケットの返信: 応答を受け取れず、読み直しも読み込み直しても変わらない理由で断られたら、「再試行」を出さずに止める', () => {
  const TICKET_URL = `/api/admin/support/tickets/${TICKET_ID}`;
  const MESSAGES_URL = `${TICKET_URL}/messages`;
  const ASSIGN_URL = `${TICKET_URL}/assign`;
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
    subject: '読み直しが断られる問い合わせ',
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
  const SEND_NO_RESPONSE = 'メッセージの送信の応答を受け取れませんでした（通信エラー）';
  const RELOAD_UNAVAILABLE = 'チケットも読み込めなかったため、送られたか分かりません';
  const RELOAD_FAILED_RETRY = '「再試行」で読み込み直して確かめるまで、もう一度は送れません';

  const textarea = () => container.querySelector<HTMLTextAreaElement>('textarea');
  const blockedReason = () => container.querySelector('[data-testid="blocked-send-reason"]')?.textContent ?? '';

  async function openTypeAndSend() {
    nav.pathname = `/admin/support/${TICKET_ID}`;
    await renderElement(createElement(TicketDetailPage, { params: Promise.resolve({ id: TICKET_ID }) }));
    await typeInto(textarea(), REPLY);
    await click(findButton('返信を送信'), '「返信を送信」ボタン');
  }

  it.each([
    { name: '401 (ログインが切れた)', reread: unauthenticated, reason: RELOGIN_MESSAGE },
    { name: '403 (二段階認証の確認が要る)', reread: mfaForbidden, reason: API_MFA_REQUIRED_MESSAGE },
    {
      name: '404 (チケットが消えた)',
      reread: () => jsonResponse(HTTP_NOT_FOUND, { error: { code: 'NOT_FOUND', message: 'not found' } }),
      reason: 'チケットが見つかりません',
    },
  ])('読み直しが $name なら、理由の文を添えて送信を止め、「再試行」を出さない', async ({ reread, reason }) => {
    route('GET', TICKET_URL, sequence(() => jsonResponse(HTTP_OK, { data: TICKET }), reread));
    route('POST', MESSAGES_URL, networkFailure);
    await openTypeAndSend();

    expect(blockedReason()).toBe(`${SEND_NO_RESPONSE}。${RELOAD_UNAVAILABLE}。${reason}`);
    expect(text()).not.toContain(RELOAD_FAILED_RETRY);
    expect(findButton(RETRY_LABEL)).toBeUndefined();
    // 送信は止めたまま (送れたか分からないので、押し直させない)
    expect(findButton('返信を送信')!.disabled).toBe(true);
    expect(textarea()!.value).toBe(REPLY);
    expect(countCalls(`POST ${MESSAGES_URL}`)).toBe(1);
    // 401 でもログインの画面へは移さない (送れたか分からないことを知らせたまま)
    expect(nav.push).not.toHaveBeenCalled();
    expect(text()).not.toContain('認証が必要です');
  });

  it('読み直しが 500 / 本文の無い 502 / 通信の失敗なら、これまでどおり「再試行」を出す (読み込み直せば変わりうる)', async () => {
    route('GET', TICKET_URL, sequence(() => jsonResponse(HTTP_OK, { data: TICKET }), () => proxyResponse(HTTP_BAD_GATEWAY)));
    route('POST', MESSAGES_URL, networkFailure);
    await openTypeAndSend();

    expect(blockedReason()).toContain(RELOAD_FAILED_RETRY);
    expect(findButton(RETRY_LABEL)).toBeDefined();
  });

  it('「再試行」の読み直しが 401 なら、理由の文にして「再試行」を外す (送信は止めたまま)', async () => {
    route(
      'GET',
      TICKET_URL,
      sequence(() => jsonResponse(HTTP_OK, { data: TICKET }), () => proxyResponse(HTTP_BAD_GATEWAY), unauthenticated),
    );
    route('POST', MESSAGES_URL, networkFailure);
    await openTypeAndSend();
    await click(findButton(RETRY_LABEL), '「再試行」ボタン');

    expect(blockedReason()).toBe(`${SEND_NO_RESPONSE}。${RELOAD_UNAVAILABLE}。${RELOGIN_MESSAGE}`);
    expect(findButton(RETRY_LABEL)).toBeUndefined();
    expect(findButton('返信を送信')!.disabled).toBe(true);
    expect(countCalls(`POST ${MESSAGES_URL}`)).toBe(1);
  });

  it('止めているあいだにステータスを変えても、止めている理由の文は消えず、送信も「再試行」も止めたまま', async () => {
    route(
      'GET',
      TICKET_URL,
      sequence(
        () => jsonResponse(HTTP_OK, { data: TICKET }),
        () => proxyResponse(HTTP_BAD_GATEWAY),
        () => jsonResponse(HTTP_OK, { data: { ...TICKET, status: 'pending' } }),
      ),
    );
    route('POST', MESSAGES_URL, networkFailure);
    route('PATCH', TICKET_URL, () => jsonResponse(HTTP_OK, { data: { ...TICKET, status: 'pending' } }));
    await openTypeAndSend();
    const reasonBefore = blockedReason();
    expect(reasonBefore).toContain('送られたか分かりません');

    await click(findButton('保留'), '「保留」ボタン');

    expect(countCalls(`PATCH ${TICKET_URL}`)).toBe(1);
    expect(blockedReason()).toBe(reasonBefore);
    expect(findButton('返信を送信')!.disabled).toBe(true);
    expect(findButton(RETRY_LABEL)).toBeDefined();
    expect(countCalls(`POST ${MESSAGES_URL}`)).toBe(1);
  });

  it('止めているあいだに担当者を設定しても、止めている理由の文は消えない (読み込み直しても変わらない理由のときも)', async () => {
    route(
      'GET',
      TICKET_URL,
      sequence(
        () => jsonResponse(HTTP_OK, { data: TICKET }),
        mfaForbidden,
        () => jsonResponse(HTTP_OK, { data: { ...TICKET, assignee_id: MEMBER_A_ID } }),
      ),
    );
    route('POST', MESSAGES_URL, () => proxyResponse(HTTP_GATEWAY_TIMEOUT));
    route('POST', ASSIGN_URL, () => jsonResponse(HTTP_OK, { data: {} }));
    await openTypeAndSend();
    const reasonBefore = blockedReason();
    expect(reasonBefore).toContain(API_MFA_REQUIRED_MESSAGE);

    await typeInto(container.querySelector<HTMLInputElement>('input[placeholder="ユーザー UUID"]'), MEMBER_A_ID);
    await click(findButton('担当者を設定'), '「担当者を設定」ボタン');

    expect(countCalls(`POST ${ASSIGN_URL}`)).toBe(1);
    expect(blockedReason()).toBe(reasonBefore);
    expect(findButton('返信を送信')!.disabled).toBe(true);
    expect(findButton(RETRY_LABEL)).toBeUndefined();
    expect(countCalls(`POST ${MESSAGES_URL}`)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// X4: 強制譲渡・強制解散の読み直しの 401 / 403、super-admin の一覧の初めの読み込みの 401 / 403
// ─────────────────────────────────────────────────────────────────────────────

describe('X4 運営のメンバーシップの読み込み: 401 / 403 は OperatorLoadUnavailableError (読み込み直しても変わらない)', () => {
  it('401 は「ログインし直してください」、403 は本文の理由の文の OperatorLoadUnavailableError (OperatorScreenError の子)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => unauthenticated()));
    const unauth = await fetchOperatorRows('/api/operator/membership/orgs/inactive', '組織の一覧').catch((e: unknown) => e);
    expect(unauth).toBeInstanceOf(OperatorLoadUnavailableError);
    expect(unauth).toBeInstanceOf(OperatorScreenError);
    expect((unauth as Error).message).toBe(RELOGIN_MESSAGE);

    vi.stubGlobal('fetch', vi.fn(async () => mfaForbidden()));
    const forbidden = await fetchOperatorRows('/api/operator/membership/orgs/inactive', '組織の一覧').catch((e: unknown) => e);
    expect(forbidden).toBeInstanceOf(OperatorLoadUnavailableError);
    expect((forbidden as Error).message).toBe(API_MFA_REQUIRED_MESSAGE);
  });

  it('500・本文の無い 502・通信の失敗は OperatorLoadUnavailableError にしない (「再試行」で変わりうる)', async () => {
    for (const responder of [() => jsonResponse(500, { error: { message: '内部エラー' } }), () => proxyResponse(HTTP_BAD_GATEWAY), networkFailure]) {
      vi.stubGlobal('fetch', vi.fn(async () => responder()));
      const error = await fetchOperatorRows('/api/operator/membership/orgs/inactive', '組織の一覧').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OperatorScreenError);
      expect(error).not.toBeInstanceOf(OperatorLoadUnavailableError);
    }
  });
});

const TRANSFER_NO_RESPONSE = '強制譲渡の応答を受け取れませんでした（通信エラー）';
const TRANSFER_RELOAD_UNAVAILABLE = '候補も読み込めなかったため、譲渡が済んだか分かりません';
const TRANSFER_RELOAD_FAILED_RETRY = '「再試行」で候補を読み込み直して確かめるまで、もう一度は実行できません';

describe.each([
  {
    name: '家族の代表者の強制譲渡',
    scopeId: FAMILY_ID,
    page: () => createElement(FamilyTransferPage),
    candidatesUrl: `/api/operator/membership/family/${FAMILY_ID}/candidates`,
    transferUrl: `/api/operator/membership/family/${FAMILY_ID}/transfer`,
    candidateA: { id: MEMBER_A_ID, nickname: 'Aさん', role: 'adult', last_login_at: null, email: 'a@example.com' },
    candidateB: { id: MEMBER_B_ID, nickname: 'Bさん', role: 'adult', last_login_at: null, email: 'b@example.com' },
  },
  {
    name: '組織のオーナーの強制譲渡',
    scopeId: ORG_ID,
    page: () => createElement(OrgTransferPage),
    candidatesUrl: `/api/operator/membership/org/${ORG_ID}/candidates`,
    transferUrl: `/api/operator/membership/org/${ORG_ID}/transfer`,
    candidateA: { id: MEMBER_A_ID, nickname: 'Aさん', org_role: 'member', last_login_at: null, email: 'a@example.com' },
    candidateB: { id: MEMBER_B_ID, nickname: 'Bさん', org_role: 'admin', last_login_at: null, email: 'b@example.com' },
  },
])('X4 $name: 読み直しが 401 / 403 なら理由の文を出し、「再試行」を出さない (譲渡は止めたまま)', (c) => {
  async function confirmTransferToA() {
    const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${MEMBER_A_ID}"]`);
    await click(radio, '候補 A のラジオ');
    await typeInto(container.querySelector('textarea'), '代表者が長期不在のため');
    await click(findButton('強制譲渡を実行'), '「強制譲渡を実行」');
    await click(findButton('実行する'), '確認の枠の「実行する」');
  }

  beforeEach(() => {
    nav.params = { id: c.scopeId };
  });

  it.each([
    { status: '401', reread: unauthenticated, reason: RELOGIN_MESSAGE },
    { status: '403', reread: mfaForbidden, reason: API_MFA_REQUIRED_MESSAGE },
  ])('譲渡の通信が切れ、候補の読み直しが $status なら、済んだか分からない文に理由の文を添え、「再試行」を出さない', async ({ reread, reason }) => {
    route('GET', c.candidatesUrl, sequence(() => jsonResponse(HTTP_OK, { data: [c.candidateA, c.candidateB] }), reread));
    route('POST', c.transferUrl, networkFailure);
    await renderElement(c.page());

    await confirmTransferToA();

    expect(text()).toContain(`${TRANSFER_NO_RESPONSE}。${TRANSFER_RELOAD_UNAVAILABLE}。${reason}`);
    expect(text()).not.toContain(TRANSFER_RELOAD_FAILED_RETRY);
    expect(findButton(RETRY_LABEL)).toBeUndefined();
    // 済んだか分からないまま同じ譲渡を押し直せない
    expect(findButton('実行する')).toBeUndefined();
    expect(findButton('強制譲渡を実行')).toBeUndefined();
    expect(countCalls(`POST ${c.transferUrl}`)).toBe(1);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('候補の読み直しが本文の無い 502 なら「再試行」を出し、その「再試行」の読み直しが 401 なら理由の文にして「再試行」を外す', async () => {
    route(
      'GET',
      c.candidatesUrl,
      sequence(() => jsonResponse(HTTP_OK, { data: [c.candidateA, c.candidateB] }), () => proxyResponse(HTTP_BAD_GATEWAY), unauthenticated),
    );
    route('POST', c.transferUrl, networkFailure);
    await renderElement(c.page());

    await confirmTransferToA();
    expect(text()).toContain(TRANSFER_RELOAD_FAILED_RETRY);
    await click(findButton(RETRY_LABEL), '「再試行」ボタン');

    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(3);
    expect(text()).toContain(`${TRANSFER_NO_RESPONSE}。${TRANSFER_RELOAD_UNAVAILABLE}。${RELOGIN_MESSAGE}`);
    expect(findButton(RETRY_LABEL)).toBeUndefined();
    expect(findButton('強制譲渡を実行')).toBeUndefined();
    expect(countCalls(`POST ${c.transferUrl}`)).toBe(1);
  });

  it.each([
    { status: '401', initial: unauthenticated, message: RELOGIN_MESSAGE },
    { status: '403', initial: mfaForbidden, message: API_MFA_REQUIRED_MESSAGE },
  ])('候補の初めの読み込みが $status なら、理由の文を出し「再試行」を出さない', async ({ initial, message }) => {
    route('GET', c.candidatesUrl, initial);
    await renderElement(c.page());

    expect(text()).toContain(message);
    expect(findButton(RETRY_LABEL)).toBeUndefined();
  });

  it('候補の初めの読み込みが本文の無い 502 なら、これまでどおり「再試行」を出す', async () => {
    route('GET', c.candidatesUrl, () => proxyResponse(HTTP_BAD_GATEWAY));
    await renderElement(c.page());

    expect(findButton(RETRY_LABEL)).toBeDefined();
  });

  it('譲渡の POST が 401 なら、確認の枠に本文の文 (「認証が必要です」) ではなく「ログインし直してください」を出す (#2112 Z4。読み込みの 401 と同じ文)', async () => {
    route('GET', c.candidatesUrl, () => jsonResponse(HTTP_OK, { data: [c.candidateA, c.candidateB] }));
    route('POST', c.transferUrl, unauthenticated);
    await renderElement(c.page());

    await confirmTransferToA();

    expect(text()).toContain(RELOGIN_MESSAGE);
    expect(text()).not.toContain(API_UNAUTHENTICATED_MESSAGE);
    // 応答は受け取れている (401) ので、済んだかを確かめる候補の読み直しはしない
    expect(countCalls(`GET ${c.candidatesUrl}`)).toBe(1);
    expect(countCalls(`POST ${c.transferUrl}`)).toBe(1);
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe.each([
  {
    name: '家族グループの強制解散',
    page: () => createElement(InactiveFamiliesPage),
    listUrl: '/api/operator/membership/families/inactive',
    dissolveUrl: `/api/operator/membership/family/${FAMILY_ID}/dissolve`,
    rowName: '山田家',
    rows: [{ family_id: FAMILY_ID, family_name: '山田家', representative_user_id: MEMBER_A_ID, representative_email: 'a@example.com', member_count: 3 }],
  },
  {
    name: '組織の強制解散',
    page: () => createElement(InactiveOrgsPage),
    listUrl: '/api/operator/membership/orgs/inactive',
    dissolveUrl: `/api/operator/membership/org/${ORG_ID}/dissolve`,
    rowName: '山田商店',
    rows: [
      { organization_id: ORG_ID, organization_name: '山田商店', owner_user_id: MEMBER_A_ID, owner_email: 'a@example.com', owner_last_sign_in: null, member_count: 3, dissolved: false },
    ],
  },
])('X4 $name: 解散の応答を受け取れず、一覧の読み直しが 401 なら「更新」を促さず理由の文を出す', (c) => {
  it('済んだか分からない文に「ログインし直してください」を添え、「「更新」で読み込み直して」とは言わない (一覧と解散のボタンは出さない)', async () => {
    route('GET', c.listUrl, sequence(() => jsonResponse(HTTP_OK, { data: c.rows }), unauthenticated));
    route('POST', c.dissolveUrl, networkFailure);
    await renderElement(c.page());

    const row = Array.from(container.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes(c.rowName));
    await click(Array.from(row?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '解散'), '行の「解散」');
    await typeInto(container.querySelector('textarea'), '代表者が長期不在のため');
    await click(findButton('次へ'), '「次へ」');
    await click(findButton('実行する'), '確認の枠の「実行する」');

    expect(text()).toContain(
      `強制解散の応答を受け取れませんでした（通信エラー）。一覧も読み込めなかったため、解散が済んだか分かりません。${RELOGIN_MESSAGE}`,
    );
    expect(text()).not.toContain('「更新」で一覧を読み込み直して');
    expect(container.querySelector('tbody')).toBeNull();
    expect(countCalls(`POST ${c.dissolveUrl}`)).toBe(1);
  });

  it('解散の POST が 401 なら、確認の枠に本文の文 (「認証が必要です」) ではなく「ログインし直してください」を出す (#2112 Z4。読み込みの 401 と同じ文)', async () => {
    route('GET', c.listUrl, () => jsonResponse(HTTP_OK, { data: c.rows }));
    route('POST', c.dissolveUrl, unauthenticated);
    await renderElement(c.page());

    const row = Array.from(container.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.includes(c.rowName));
    await click(Array.from(row?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '解散'), '行の「解散」');
    await typeInto(container.querySelector('textarea'), '代表者が長期不在のため');
    await click(findButton('次へ'), '「次へ」');
    await click(findButton('実行する'), '確認の枠の「実行する」');

    expect(text()).toContain(RELOGIN_MESSAGE);
    expect(text()).not.toContain(API_UNAUTHENTICATED_MESSAGE);
    // 応答は受け取れている (401) ので、済んだかを確かめる一覧の読み直しはしない
    expect(countCalls(`GET ${c.listUrl}`)).toBe(1);
    expect(countCalls(`POST ${c.dissolveUrl}`)).toBe(1);
  });
});

describe('X4 (同じ型) メール送信の一覧: 再送の通信が切れたあとの一覧の読み直しが 401 / 403 なら、理由の文を出し「再試行」を出さない', () => {
  const LIST_URL = '/api/super-admin/email-outbox';
  const ROW_ID = '21012101-8888-4888-8888-888888888888';
  const REQUEUE_URL = `${LIST_URL}/${ROW_ID}/requeue`;
  const TEMPLATE = 'family_invite';
  const CREATED_AT = '2026-10-30T05:00:01.000000+00:00';
  const deadRow = {
    id: ROW_ID,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    status: 'dead',
    template: TEMPLATE,
    recipient: 't***@example.com',
    redacted: false,
    user_id: null,
    attempts: 1,
    requeue_count: 0,
    next_attempt_at: CREATED_AT,
    lease_expires_at: null,
    last_error_code: 'validation_error',
    last_error_message: 'The domain is not verified',
    last_status_code: 403,
    sent_at: null,
    dead_at: CREATED_AT,
    requeued_at: null,
  };
  const listBody = { data: [deadRow], meta: { limit: 50, has_more: false, next_cursor: null } };
  const noticeParagraph = () => container.querySelector('[data-testid="email-outbox-reload-notice"] p');
  const requeueButton = () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('tbody tr button')).find((b) => b.textContent?.trim() === '再送');

  it.each([
    { status: '401', reread: unauthenticated, reason: RELOGIN_MESSAGE },
    { status: '403', reread: mfaForbidden, reason: API_MFA_REQUIRED_MESSAGE },
  ])('読み直しが $status なら「…の再送の応答を受け取れませんでした（通信エラー）。<理由の文>」を出し、「再試行」を出さない', async ({ reread, reason }) => {
    route('GET', LIST_URL, sequence(() => jsonResponse(HTTP_OK, listBody), reread));
    route('POST', REQUEUE_URL, networkFailure);
    await renderElement(createElement(EmailOutboxPage));

    await click(requeueButton(), '「再送」ボタン');

    expect(countCalls(`POST ${REQUEUE_URL}`)).toBe(1);
    expect(countCalls(`GET ${LIST_URL}`)).toBe(2);
    expect(noticeParagraph()?.textContent).toBe(`「${TEMPLATE}」の再送の応答を受け取れませんでした（通信エラー）。${reason}`);
    expect(noticeParagraph()?.getAttribute('role')).toBe('alert');
    expect(findButton(RETRY_LABEL)).toBeUndefined();
  });

  it('読み直しが 500 なら、これまでどおり「再試行」を出す', async () => {
    route('GET', LIST_URL, sequence(() => jsonResponse(HTTP_OK, listBody), () => jsonResponse(500, { error: { message: '内部エラー' } })));
    route('POST', REQUEUE_URL, networkFailure);
    await renderElement(createElement(EmailOutboxPage));

    await click(requeueButton(), '「再送」ボタン');

    expect(noticeParagraph()?.textContent).toContain('「再試行」で読み込み直してから');
    expect(findButton(RETRY_LABEL)).toBeDefined();
  });
});

describe('X4 super-admin の画面の初めの読み込みの 401 / 403: 読み直しと同じ理由の文にし、「再試行」を出さない', () => {
  const QUOTAS_URL = '/api/super-admin/llm/quotas';

  it.each([
    { status: '401', responder: unauthenticated, message: RELOGIN_MESSAGE },
    { status: '403', responder: mfaForbidden, message: API_MFA_REQUIRED_MESSAGE },
  ])('AI の利用上限: 初めの読み込みが $status なら理由の文を出し、「再試行」を出さない', async ({ responder, message }) => {
    route('GET', QUOTAS_URL, responder);
    await renderElement(createElement(LLMQuotasPage));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(text()).not.toContain('HTTP 401');
    expect(findButton(RETRY_LABEL)).toBeUndefined();
  });

  it('AI の利用上限: 初めの読み込みが本文の無い 502 なら、これまでどおり「再試行」を出す', async () => {
    route('GET', QUOTAS_URL, () => proxyResponse(HTTP_BAD_GATEWAY));
    await renderElement(createElement(LLMQuotasPage));

    expect(text()).toContain('AI の利用上限を読み込めませんでした (HTTP 502)');
    expect(findButton(RETRY_LABEL)).toBeDefined();
  });

  it.each([
    { status: '401', responder: unauthenticated, message: RELOGIN_MESSAGE },
    { status: '403', responder: mfaForbidden, message: API_MFA_REQUIRED_MESSAGE },
  ])('A/B テストの一覧: 初めの読み込みが $status なら理由の文を出す (「読み込めませんでした (HTTP n)」にしない)', async ({ responder, message }) => {
    route('GET', '/api/super-admin/experiments', responder);
    await renderElement(createElement(ExperimentsPage));

    expect(text()).toContain(message);
    expect(text()).not.toContain('実験の一覧を読み込めませんでした');
    expect(findButton(RETRY_LABEL)).toBeUndefined();
  });

  it('A/B テストの詳細: 初めの読み込みが 401 なら「ログインし直してください」(「読み込めませんでした (HTTP 401)」にしない)', async () => {
    route('GET', `/api/super-admin/experiments/${EXPERIMENT_ID}`, unauthenticated);
    route('GET', `/api/super-admin/experiments/${EXPERIMENT_ID}/results`, unauthenticated);
    await renderElement(createElement(ExperimentDetailPage, { params: Promise.resolve({ id: EXPERIMENT_ID }) }));

    expect(text()).toContain(RELOGIN_MESSAGE);
    expect(text()).not.toContain('HTTP 401');
    expect(findButton(RETRY_LABEL)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// X5: 401 で /login へ移すときに next を付ける
// ─────────────────────────────────────────────────────────────────────────────

/** ログインの画面へ移す URL (ログインのあとに戻る画面を next に付ける) */
const loginWithNext = (path: string) => `/login?next=${encodeURIComponent(path)}`;

describe('X5 運営の画面の 401: /login?next=<今の画面> へ移し、ログインし直したあと元の画面に戻れるようにする', () => {
  it('チケットの詳細の読み込みの 401', async () => {
    const path = `/admin/support/${TICKET_ID}`;
    nav.pathname = path;
    route('GET', `/api/admin/support/tickets/${TICKET_ID}`, unauthenticated);
    await renderElement(createElement(TicketDetailPage, { params: Promise.resolve({ id: TICKET_ID }) }));

    expect(nav.push).toHaveBeenCalledWith(loginWithNext(path));
  });

  it('チケットの一覧の読み込みの 401', async () => {
    nav.pathname = '/admin/support';
    route('GET', '/api/admin/support/tickets', unauthenticated);
    await renderElement(createElement(TicketsPage));

    expect(nav.push).toHaveBeenCalledWith(loginWithNext('/admin/support'));
  });

  it('リードの一覧の読み込みの 401', async () => {
    nav.pathname = '/admin/sales';
    route('GET', '/api/admin/sales/leads', unauthenticated);
    await renderElement(createElement(LeadsPage));

    expect(nav.push).toHaveBeenCalledWith(loginWithNext('/admin/sales'));
  });

  it('チケットの起票の 401', async () => {
    nav.pathname = '/admin/support/new';
    route('POST', '/api/admin/support/tickets', unauthenticated);
    await renderElement(createElement(NewTicketPage));
    await typeInto(container.querySelector<HTMLInputElement>('#user_id'), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await typeInto(container.querySelector<HTMLInputElement>('#subject'), 'ログインできない');
    await typeInto(container.querySelector<HTMLTextAreaElement>('#body'), '詳しい内容');
    await act(async () => {
      container.querySelector('form')!.requestSubmit();
    });
    await settle();

    expect(nav.push).toHaveBeenCalledWith(loginWithNext('/admin/support/new'));
  });

  it('リードの登録の 401', async () => {
    nav.pathname = '/admin/sales/new';
    route('POST', '/api/admin/sales/leads', unauthenticated);
    await renderElement(createElement(NewLeadPage));
    await typeInto(container.querySelector<HTMLInputElement>('#company_name'), '株式会社テスト');
    await act(async () => {
      container.querySelector('form')!.requestSubmit();
    });
    await settle();

    expect(nav.push).toHaveBeenCalledWith(loginWithNext('/admin/sales/new'));
  });

  it('開示等の請求の一覧の読み込みの 401', async () => {
    nav.pathname = '/admin/data-requests';
    route('GET', '/api/admin/data-requests', unauthenticated);
    await renderElement(createElement(DataRequestsPage));

    expect(nav.push).toHaveBeenCalledWith(loginWithNext('/admin/data-requests'));
  });

  it('開示等の請求の詳細の読み込みの 401', async () => {
    const path = `/admin/data-requests/${DSR_ID}`;
    nav.pathname = path;
    nav.params = { id: DSR_ID };
    route('GET', `/api/admin/data-requests/${DSR_ID}`, unauthenticated);
    await renderElement(createElement(DataRequestDetailPage));

    expect(nav.push).toHaveBeenCalledWith(loginWithNext(path));
  });

  it('開示等の請求の詳細の保存の 401', async () => {
    const path = `/admin/data-requests/${DSR_ID}`;
    nav.pathname = path;
    nav.params = { id: DSR_ID };
    const detail = {
      id: DSR_ID,
      user_id: MEMBER_A_ID,
      requester_nickname: 'たろう',
      request_type: 'disclosure',
      status: 'received',
      verified_at: '2026-10-01T00:00:00.000Z',
      due_at: '2026-10-31T00:00:00.000Z',
      overdue: false,
      resolved_at: null,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-15T01:02:03.456789+00:00',
      details: '登録している情報を開示してください',
      verification_method: 'email_link',
      verification_sent_at: '2026-10-01T00:00:00.000Z',
      verification_expires_at: '2026-10-02T00:00:00.000Z',
      verification_send_count: 1,
      response_note: null,
      admin_notes: null,
      requester: { user_id: MEMBER_A_ID, nickname: 'たろう', email: 'taro@example.com' },
    };
    route('GET', `/api/admin/data-requests/${DSR_ID}`, () => jsonResponse(HTTP_OK, { data: detail }));
    route('PATCH', `/api/admin/data-requests/${DSR_ID}`, unauthenticated);
    await renderElement(createElement(DataRequestDetailPage));
    await typeInto(container.querySelector<HTMLTextAreaElement>('[data-testid="admin-dsr-admin-notes"]'), '電話済み');
    await click(container.querySelector<HTMLButtonElement>('[data-testid="admin-dsr-save"]'), '「保存」ボタン');

    expect(countCalls(`PATCH /api/admin/data-requests/${DSR_ID}`)).toBe(1);
    expect(nav.push).toHaveBeenCalledWith(loginWithNext(path));
  });
});

describe('X5 見張り: 運営の画面のソースに /login の直書きを増やさない (401 は loginPathWithNext で next を付ける)', () => {
  const REPO_ROOT = join(__dirname, '..');
  /** 運営の画面のソースの置き場所 */
  const OPERATOR_SCREEN_ROOTS = ['src/app/admin', 'src/app/super-admin', 'src/app/(operator)', 'src/components/admin', 'src/components/operator'];
  /** 文字列の '/login' だけ (クエリ付きの '/login?redirect=…' などは数えない) */
  const BARE_LOGIN_LITERAL = /(['"`])\/login\1/g;
  /**
   * 既知の残り (ファイル -> 数) と理由。いまは空 = どの運営の画面も '/login' を直書きしていない。
   * 最後の残りだった src/app/admin/sales/[id]/page.tsx は #2103 (X2) が 401 を loginPathWithNext に替えた。
   * 直書きが増えたら赤になる (やむを得ず残すときは理由を添えて行を足す)
   */
  const KNOWN_REMAINING: Readonly<Record<string, { count: number; reason: string }>> = {};

  function sourceFiles(dir: string): string[] {
    const absolute = join(REPO_ROOT, dir);
    return (readdirSync(absolute, { recursive: true }) as string[])
      .filter((name) => /\.(ts|tsx)$/.test(name))
      .map((name) => relative(REPO_ROOT, join(absolute, name)));
  }

  /** コメントの行を除いて、文字列の '/login' を数える */
  function countBareLogin(file: string): number {
    return readFileSync(join(REPO_ROOT, file), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .reduce((sum, line) => sum + (line.match(BARE_LOGIN_LITERAL)?.length ?? 0), 0);
  }

  it("運営の画面で '/login' を直書きしているのは既知の残りだけ", () => {
    const found: Record<string, number> = {};
    for (const root of OPERATOR_SCREEN_ROOTS) {
      for (const file of sourceFiles(root)) {
        const count = countBareLogin(file);
        if (count > 0) found[file] = count;
      }
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(KNOWN_REMAINING).map(([file, { count }]) => [file, count])));
  });

  it('見張りが走査している (直したページは loginPathWithNext を使っている)', () => {
    const fixed = [
      'src/app/admin/support/[id]/page.tsx',
      'src/app/admin/support/new/page.tsx',
      'src/app/admin/support/page.tsx',
      'src/app/admin/sales/new/page.tsx',
      'src/app/admin/sales/page.tsx',
      'src/app/admin/data-requests/[id]/page.tsx',
      'src/app/admin/data-requests/page.tsx',
    ];
    const scanned = new Set(OPERATOR_SCREEN_ROOTS.flatMap(sourceFiles));
    for (const file of fixed) {
      expect(scanned.has(file), `${file} が走査に入っていない`).toBe(true);
      expect(readFileSync(join(REPO_ROOT, file), 'utf8')).toContain('router.push(loginPathWithNext(pathname))');
    }
    // 元の既知の残り (#2103 X2 が直した): 戻り先はリードの詳細のパス
    const leadDetail = 'src/app/admin/sales/[id]/page.tsx';
    expect(scanned.has(leadDetail), `${leadDetail} が走査に入っていない`).toBe(true);
    expect(readFileSync(join(REPO_ROOT, leadDetail), 'utf8')).toContain('router.push(loginPathWithNext(leadDetailPath(params.id)))');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// X8: 200 で data が配列でない壊れた一覧の応答を 0 件と見せない
// ─────────────────────────────────────────────────────────────────────────────

describe('X8 listRowsOfBody / listTotalOfBody', () => {
  it('data が配列なら行を返し、配列でない・本文が読めないなら null', () => {
    expect(listRowsOfBody<{ id: string }>({ data: [{ id: 'a' }] })).toEqual([{ id: 'a' }]);
    expect(listRowsOfBody({ data: [] })).toEqual([]);
    for (const broken of [null, {}, { data: null }, { data: {} }, { data: 'x' }, 'text']) {
      expect(listRowsOfBody(broken)).toBeNull();
    }
  });

  it('meta.total が数ならそれ、無い・数でないなら 0', () => {
    expect(listTotalOfBody({ meta: { total: 12 } })).toBe(12);
    expect(listTotalOfBody({ meta: { total: '12' } })).toBe(0);
    expect(listTotalOfBody({ data: [] })).toBe(0);
    expect(listTotalOfBody(null)).toBe(0);
  });
});

describe.each([
  { name: 'data が null', body: { data: null, meta: { total: 0 } } },
  { name: 'data が無い', body: { meta: { total: 0 } } },
  { name: 'data がオブジェクト', body: { data: {}, meta: { total: 0 } } },
])('X8 運営の一覧 (クライアント): 200 で $name の壊れた応答は読み込みの失敗にする', ({ body }) => {
  it('リードの一覧は「リードの一覧を読み込めませんでした（通信エラー）」を出し、0 件の文を出さない', async () => {
    route('GET', '/api/admin/sales/leads', () => jsonResponse(HTTP_OK, body));
    await renderElement(createElement(LeadsPage));

    expect(text()).toContain('リードの一覧を読み込めませんでした（通信エラー）');
    expect(text()).not.toContain('見込み顧客 0 件');
    // 空のカンバン (列ごとの「なし」) も出さない
    expect(text()).not.toContain('アプローチ');
  });

  it('チケットの一覧は「チケット一覧の取得に失敗しました」を出し、0 件の文を出さない', async () => {
    route('GET', '/api/admin/support/tickets', () => jsonResponse(HTTP_OK, body));
    await renderElement(createElement(TicketsPage));

    expect(text()).toContain('チケット一覧の取得に失敗しました');
    expect(text()).not.toContain('チケットはありません');
    expect(text()).not.toContain('全 0 件');
  });
});

describe('X8 運営の一覧 (クライアント): 壊れていない応答はこれまでどおり', () => {
  it('チケットの一覧の 0 件は 0 件の文を出し、失敗の文を出さない', async () => {
    route('GET', '/api/admin/support/tickets', () => jsonResponse(HTTP_OK, { data: [], meta: { total: 0 } }));
    await renderElement(createElement(TicketsPage));

    expect(text()).toContain('チケットはありません');
    expect(text()).not.toContain('チケット一覧の取得に失敗しました');
  });

  it('リードの一覧の行を出す', async () => {
    const lead = {
      id: MEMBER_A_ID,
      company_name: '株式会社テスト',
      industry: null,
      contact_name: null,
      contact_email: null,
      stage: 'approach',
      assigned_to: null,
      estimated_acv: null,
      created_at: '2026-10-30T00:00:00.000Z',
      updated_at: '2026-10-30T00:00:00.000Z',
    };
    route('GET', '/api/admin/sales/leads', () => jsonResponse(HTTP_OK, { data: [lead], meta: { total: 1 } }));
    await renderElement(createElement(LeadsPage));

    expect(text()).toContain('株式会社テスト');
    expect(text()).toContain('見込み顧客 1 件');
    expect(text()).not.toContain('読み込めませんでした');
  });
});

describe.each([
  { name: 'クーポン', Page: CouponsPage, empty: 'クーポンがありません' },
  { name: '機能パッケージ', Page: FeaturePackagesPage, empty: '機能パッケージがありません' },
  { name: 'プラン', Page: PlansPage, empty: 'プランがありません' },
])('X8 $name の一覧 (Server Component): 200 で data が配列でない応答を 0 件と見せない', ({ Page, empty }) => {
  const FETCH_FAILED_TEXT = 'データの取得に失敗しました';
  const okResponse = (body: unknown) => ({ ok: true, status: HTTP_OK, json: () => Promise.resolve(body) });

  it.each([
    { name: 'data が null', body: { data: null } },
    { name: 'data がオブジェクト', body: { data: {} } },
    { name: '本文が読めない', body: undefined },
  ])('$name なら取得の失敗の文を出し、0 件の文を出さない', async ({ body }) => {
    serverMocks.adminFetch.mockResolvedValue(
      body === undefined
        ? { ok: true, status: HTTP_OK, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }
        : okResponse(body),
    );
    const html = renderToStaticMarkup(await Page());

    expect(html).toContain(FETCH_FAILED_TEXT);
    expect(html).not.toContain(empty);
  });

  it('data が空の配列なら 0 件の文を出す (これまでどおり)', async () => {
    serverMocks.adminFetch.mockResolvedValue(okResponse({ data: [], meta: { total: 0 } }));
    const html = renderToStaticMarkup(await Page());

    expect(html).toContain(empty);
    expect(html).not.toContain(FETCH_FAILED_TEXT);
  });
});
