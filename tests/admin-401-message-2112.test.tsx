/**
 * #2112 Z4 のテスト: 運営の画面の 401 (ログインが切れた) の文を「ログインし直してください」(UNAUTHENTICATED_SCREEN_MESSAGE) に揃える
 *
 * 以前:
 *   - 同じ「ログインが切れた」に、画面ごとに「ログインし直してください」「ログインの有効期限が切れました。ログインし直してください」
 *     「ログインの有効期限が切れています。…」「認証が必要です」(API の本文の文) が混ざっていた。
 *     読み込み・書き込みの共通の関数 (fetchAdminJson・adminScreenErrorOfResponse・adminActionErrorOfBody・operationFailureMessage) は、
 *     401 の本文の文 (「認証が必要です」) をそのまま出していた (価格の変更の画面は初めの読み込みの 401 と読み直しの 401 で文がずれた)
 *   - チケットの担当者の設定・ステータスの変更は、401 でも「割り当て失敗」「ステータス変更失敗」とだけ出した (ログインし直せばよいと分からない)
 *   - 運営のメンバーシップの画面 (/operator/membership) の強制譲渡・強制解散の POST (postOperatorForceAction) は、
 *     401 の本文の文 (「認証が必要です」) を確認の枠に出した (同じ画面の読み込みの 401 は「ログインし直してください」で、文がずれた)
 *   - 監査ログ (/super-admin/audit-logs) の CSV の書き出しは、401 でも「CSV エクスポートに失敗しました」と出した
 *     (同じ画面の一覧の読み込みの 401 は fetchAdminJson で「ログインし直してください」)
 * 直したあと (不変条件):
 *   - 共通の関数は 401 なら本文の文に関わらず「ログインし直してください」にする (ほかの status は今までどおり)
 *   - チケットの担当者の設定・ステータスの変更の 401 は「ログインし直してください」
 *   - 強制譲渡・強制解散の POST の 401 は「ログインし直してください」(本文の無い 502 / 503 / 504 の「応答を受け取れなかった」は今までどおり)
 *   - 監査ログの CSV の書き出しの 401 は「ログインし直してください」(一覧の読み込みの 401 と同じ文。500 は今までどおり)
 *   - 運営の画面のソースに 401 の文を直書きしない (UNAUTHENTICATED_SCREEN_MESSAGE を使う)
 * 続き (#2112。デプロイ後整合ゲートの指摘):
 *   - プラン詳細 (/super-admin/plans/{id}) の初めの読み込み・状態の変更・保存 (Stripe の Product ID の保存を含む) は、
 *     401 の本文の文 (「認証が必要です」) をそのまま出していた (同じ画面の読み直しの 401 は「ログインし直してください」で、文がずれた)
 *   - 組織の画面 (/admin/organizations) の作成の確かめの読み直しの 401 は「ログインの有効期限が切れました。ログインし直してください」、
 *     一覧の読み込み・作成・プランの変更の 401 は本文の文 (「認証が必要です」) を出していた
 *   直したあと: どれも「ログインし直してください」。運営の画面のソースで本文の文 (screenApiErrorMessage / extractApiErrorMessage) を
 *   出す呼び出しは、401 を先に拾っているもの (と、401 にならない分岐の中・文を出さない null の比べ) だけを、理由つきの一覧で許す (見張り)
 * ほかの画面の 401 の回帰テスト: /support/users の一覧 (tests/support-users-list-1717.test.tsx)・二段階認証の解除
 * (tests/mfa-pages-browser.test.tsx)・DR 訓練の記録 (tests/admin-reread-unavailable-after-no-response-2101.test.tsx)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNAUTHENTICATED_SCREEN_MESSAGE, operationFailureMessage } from '@/lib/admin/api-error-message';
import {
  AdminActionNoResponseError,
  AdminScreenError,
  adminActionErrorOfBody,
  adminActionErrorOfResponse,
  adminScreenErrorOfResponse,
  adminActionHttpFailedMessage,
  adminLoadFailedMessage,
  fetchAdminJson,
  screenFailureMessage,
} from '@/lib/admin/admin-screen-messages';
import {
  OPERATOR_FORCE_ACTION_LABELS,
  OperatorLoadUnavailableError,
  OperatorScreenError,
  type OperatorForceAction,
  operatorForceActionHttpFailedMessage,
  postOperatorForceAction,
} from '@/lib/membership/operator-screen-messages';

const TICKET_ID = '21122112-2112-4112-8112-211221122112';

const nav = vi.hoisted(() => {
  const push = vi.fn();
  return {
    push,
    pathname: '/admin',
    router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  useParams: () => ({ id: TICKET_ID }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: TicketDetailPage } = await import('@/app/admin/support/[id]/page');
const { default: AuditLogsPage } = await import('@/app/super-admin/audit-logs/page');
const { default: PlanDetailPage } = await import('@/app/super-admin/plans/[id]/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 画面の文 (UNAUTHENTICATED_SCREEN_MESSAGE と同じもの。定数が書き換わったときに気づけるよう、文そのものでも持つ) */
const RELOGIN_MESSAGE = 'ログインし直してください';
/** 401 の route の本文の文 (画面に出さない) */
const API_UNAUTHENTICATED_MESSAGE = '認証が必要です';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const unauthenticatedBody = { error: { code: 'AUTH_UNAUTHENTICATED', message: API_UNAUTHENTICATED_MESSAGE } };
const unauthenticated = () => jsonResponse(HTTP_UNAUTHORIZED, unauthenticatedBody);
/** 本文が JSON でない応答 (手前のプロキシ・ホスティングの応答) */
const htmlResponse = (status: number) =>
  new Response('<html><body>Unauthorized</body></html>', { status, headers: { 'content-type': 'text/html' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('共通の関数: 401 は本文の文に関わらず「ログインし直してください」(#2112 Z4)', () => {
  it('文はこれまでの UNAUTHENTICATED_SCREEN_MESSAGE と同じ', () => {
    expect(UNAUTHENTICATED_SCREEN_MESSAGE).toBe(RELOGIN_MESSAGE);
  });

  it('screenFailureMessage: 401 は「ログインし直してください」、ほかは本文の日本語の文 (無ければ null)', () => {
    expect(screenFailureMessage(HTTP_UNAUTHORIZED, unauthenticatedBody)).toBe(RELOGIN_MESSAGE);
    expect(screenFailureMessage(HTTP_UNAUTHORIZED, null)).toBe(RELOGIN_MESSAGE);
    expect(screenFailureMessage(HTTP_INTERNAL_SERVER_ERROR, { error: { message: '保存できませんでした' } })).toBe('保存できませんでした');
    expect(screenFailureMessage(HTTP_INTERNAL_SERVER_ERROR, { error: { message: 'Internal error' } })).toBeNull();
    expect(screenFailureMessage(HTTP_INTERNAL_SERVER_ERROR, null)).toBeNull();
  });

  it('adminScreenErrorOfResponse: 401 は本文が JSON でも HTML でも「ログインし直してください」、500 は今までどおり', async () => {
    const fallbackOf = (status: number) => adminLoadFailedMessage('プラン', status);
    expect((await adminScreenErrorOfResponse(unauthenticated(), fallbackOf)).message).toBe(RELOGIN_MESSAGE);
    expect((await adminScreenErrorOfResponse(htmlResponse(HTTP_UNAUTHORIZED), fallbackOf)).message).toBe(RELOGIN_MESSAGE);
    expect((await adminScreenErrorOfResponse(htmlResponse(HTTP_INTERNAL_SERVER_ERROR), fallbackOf)).message).toBe(
      adminLoadFailedMessage('プラン', HTTP_INTERNAL_SERVER_ERROR),
    );
  });

  it('adminActionErrorOfBody / adminActionErrorOfResponse: 401 は「<操作>に失敗しました (HTTP 401)」でも本文の文でもなく「ログインし直してください」', async () => {
    const fromBody = adminActionErrorOfBody(unauthenticatedBody, HTTP_UNAUTHORIZED, '保存');
    expect(fromBody).toBeInstanceOf(AdminScreenError);
    expect(fromBody).not.toBeInstanceOf(AdminActionNoResponseError);
    expect(fromBody.message).toBe(RELOGIN_MESSAGE);

    const fromHtml = await adminActionErrorOfResponse(htmlResponse(HTTP_UNAUTHORIZED), '保存');
    expect(fromHtml).not.toBeInstanceOf(AdminActionNoResponseError);
    expect(fromHtml.message).toBe(RELOGIN_MESSAGE);

    // 本文に API の文の無い 502 は今までどおり「応答を受け取れなかった」、500 の本文の文は今までどおり
    expect(await adminActionErrorOfResponse(htmlResponse(HTTP_BAD_GATEWAY), '保存')).toBeInstanceOf(AdminActionNoResponseError);
    expect(adminActionErrorOfBody(null, HTTP_INTERNAL_SERVER_ERROR, '保存').message).toBe(
      adminActionHttpFailedMessage('保存', HTTP_INTERNAL_SERVER_ERROR),
    );
  });

  it('fetchAdminJson: 401 は本文の文 (「認証が必要です」) ではなく「ログインし直してください」の AdminScreenError を投げる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => unauthenticated()));
    const failure = await fetchAdminJson('/api/super-admin/plans/x', 'プラン').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(AdminScreenError);
    expect((failure as AdminScreenError).message).toBe(RELOGIN_MESSAGE);
    expect((failure as AdminScreenError).message).not.toContain(API_UNAUTHENTICATED_MESSAGE);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(HTTP_OK, { data: { id: 'x' } })));
    await expect(fetchAdminJson('/api/super-admin/plans/x', 'プラン')).resolves.toEqual({ data: { id: 'x' } });
  });

  it('operationFailureMessage: 401 は「<操作>（ログインし直してください）」、ほかは今までどおり', () => {
    expect(operationFailureMessage('メモの追加に失敗しました', HTTP_UNAUTHORIZED, unauthenticatedBody)).toBe(
      'メモの追加に失敗しました（ログインし直してください）',
    );
    expect(operationFailureMessage('メモの追加に失敗しました', HTTP_INTERNAL_SERVER_ERROR, { error: { message: '内部エラー' } })).toBe(
      'メモの追加に失敗しました（内部エラー）',
    );
    expect(operationFailureMessage('メモの追加に失敗しました', HTTP_INTERNAL_SERVER_ERROR, null)).toBe(
      `メモの追加に失敗しました（HTTP ${HTTP_INTERNAL_SERVER_ERROR}）`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 運営のメンバーシップの画面: 強制譲渡・強制解散の POST の 401
// ─────────────────────────────────────────────────────────────────────────────

describe.each<{ action: OperatorForceAction; url: string }>([
  { action: 'transfer', url: '/api/operator/membership/family/x/transfer' },
  { action: 'dissolve', url: '/api/operator/membership/org/x/dissolve' },
])('postOperatorForceAction ($action): 401 は本文の文 (「認証が必要です」) ではなく「ログインし直してください」(#2112 Z4)', ({ action, url }) => {
  async function postWith(response: () => Response): Promise<unknown> {
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    return postOperatorForceAction(url, { reason: 'テスト' }, action).catch((err: unknown) => err);
  }

  it('401 (本文が API の文の JSON でも、JSON でなくても) は「ログインし直してください」の OperatorScreenError を投げる', async () => {
    for (const response of [unauthenticated, () => htmlResponse(HTTP_UNAUTHORIZED)]) {
      const failure = await postWith(response);
      expect(failure).toBeInstanceOf(OperatorScreenError);
      // 書き込みの失敗なので、読み込みの「読み込み直しても変わらない」の印 (OperatorLoadUnavailableError) は付けない
      expect(failure).not.toBeInstanceOf(OperatorLoadUnavailableError);
      expect((failure as OperatorScreenError).message).toBe(RELOGIN_MESSAGE);
      expect((failure as OperatorScreenError).message).not.toContain(API_UNAUTHENTICATED_MESSAGE);
      expect((failure as OperatorScreenError).message).not.toContain(OPERATOR_FORCE_ACTION_LABELS[action]);
    }
  });

  it('本文に API の文の無い 502 は今までどおり「応答を受け取れなかった」(no-response)、500 の本文の文・本文の無い 500 も今までどおり', async () => {
    await expect(postWith(() => htmlResponse(HTTP_BAD_GATEWAY))).resolves.toEqual({ kind: 'no-response', status: HTTP_BAD_GATEWAY });

    const withMessage = await postWith(() => jsonResponse(HTTP_INTERNAL_SERVER_ERROR, { error: { message: '内部エラー' } }));
    expect(withMessage).toBeInstanceOf(OperatorScreenError);
    expect((withMessage as OperatorScreenError).message).toBe('内部エラー');

    const withoutMessage = await postWith(() => htmlResponse(HTTP_INTERNAL_SERVER_ERROR));
    expect((withoutMessage as OperatorScreenError).message).toBe(
      operatorForceActionHttpFailedMessage(action, HTTP_INTERNAL_SERVER_ERROR),
    );
  });

  it('成功の応答は今までどおり ok', async () => {
    await expect(postWith(() => jsonResponse(HTTP_OK, { data: {} }))).resolves.toEqual({ kind: 'ok' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// チケットの詳細: 担当者の設定・ステータスの変更の 401
// ─────────────────────────────────────────────────────────────────────────────

describe('チケットの詳細: 担当者の設定・ステータスの変更が 401 なら「ログインし直してください」(#2112 Z4)', () => {
  const TICKET_URL = `/api/admin/support/tickets/${TICKET_ID}`;
  const ASSIGN_URL = `${TICKET_URL}/assign`;
  const TICKET = {
    id: TICKET_ID,
    user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    subject: 'ログインの切れる問い合わせ',
    category: 'other',
    priority: 'medium',
    status: 'open',
    assignee_id: null,
    first_response_at: null,
    resolved_at: null,
    created_at: '2026-10-30T00:00:00.000Z',
    updated_at: '2026-10-30T00:00:00.000Z',
    messages: [],
  };

  let container: HTMLDivElement;
  let root: Root;
  let calls: string[];

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    });
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

  const text = () => container.textContent ?? '';

  /** GET はチケットを返し、書き込み (assign の POST・PATCH) は 401 */
  function mockServer() {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input).split('?')[0];
      const key = `${(init?.method ?? 'GET').toUpperCase()} ${url}`;
      calls.push(key);
      if (key === `GET ${TICKET_URL}`) return jsonResponse(HTTP_OK, { data: TICKET });
      if (key === `POST ${ASSIGN_URL}` || key === `PATCH ${TICKET_URL}`) return unauthenticated();
      throw new Error(`テストに無い fetch: ${key}`);
    });
  }

  async function renderTicket() {
    nav.pathname = `/admin/support/${TICKET_ID}`;
    await act(async () => {
      root.render(createElement(Suspense, { fallback: null }, createElement(TicketDetailPage, { params: Promise.resolve({ id: TICKET_ID }) })));
    });
    await settle();
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    calls = [];
    nav.push.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // メッセージの一覧の末尾へのスクロール (テストの DOM には無いので、何もしない関数を置く)
    Element.prototype.scrollIntoView = () => undefined;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('担当者の設定が 401 なら、「割り当て失敗」ではなく「ログインし直してください」を出す', async () => {
    mockServer();
    await renderTicket();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="ユーザー UUID"]');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await click(findButton('担当者を設定'), '「担当者を設定」ボタン');

    expect(calls.filter((c) => c === `POST ${ASSIGN_URL}`)).toHaveLength(1);
    expect(text()).toContain(RELOGIN_MESSAGE);
    expect(text()).not.toContain('割り当て失敗');
    expect(text()).not.toContain(API_UNAUTHENTICATED_MESSAGE);
  });

  it('ステータスの変更が 401 なら、「ステータス変更失敗」ではなく「ログインし直してください」を出す', async () => {
    mockServer();
    await renderTicket();

    await click(findButton('対応中'), '「対応中」ボタン');

    expect(calls.filter((c) => c === `PATCH ${TICKET_URL}`)).toHaveLength(1);
    expect(text()).toContain(RELOGIN_MESSAGE);
    expect(text()).not.toContain('ステータス変更失敗');
    expect(text()).not.toContain(API_UNAUTHENTICATED_MESSAGE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 監査ログ: 一覧の読み込みと CSV の書き出しの 401
// ─────────────────────────────────────────────────────────────────────────────

describe('監査ログ: 一覧の読み込みと CSV の書き出しの 401 は同じ「ログインし直してください」(#2112 Z4)', () => {
  const CSV_EXPORT_FAILURE_MESSAGE = 'CSV エクスポートに失敗しました';
  const isCsv = (url: string) => url.includes('format=csv');

  let container: HTMLDivElement;
  let root: Root;
  let alertMock: ReturnType<typeof vi.fn>;

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** 一覧の GET は list、CSV の書き出しの GET は csv の応答を返す */
  function mockServer(list: () => Response, csv: () => Response) {
    vi.stubGlobal('fetch', async (input: string | URL) => (isCsv(String(input)) ? csv() : list()));
    vi.stubGlobal('alert', alertMock);
  }

  async function renderAuditLogs() {
    await act(async () => {
      root.render(createElement(AuditLogsPage));
    });
    await settle();
  }

  async function clickCsvExport() {
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'CSV エクスポート');
    expect(button, '「CSV エクスポート」ボタンが見つからない').toBeDefined();
    await act(async () => {
      button!.click();
    });
    await settle();
  }

  const alerted = () => alertMock.mock.calls.map((call) => String(call[0]));
  const emptyList = () => jsonResponse(HTTP_OK, { data: [], meta: { total: 0 } });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    alertMock = vi.fn();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('CSV の書き出しが 401 なら、「CSV エクスポートに失敗しました」でも本文の文でもなく「ログインし直してください」を出す', async () => {
    mockServer(emptyList, unauthenticated);
    await renderAuditLogs();
    await clickCsvExport();

    expect(alerted()).toEqual([RELOGIN_MESSAGE]);
    expect(alerted().join('\n')).not.toContain(CSV_EXPORT_FAILURE_MESSAGE);
    expect(alerted().join('\n')).not.toContain(API_UNAUTHENTICATED_MESSAGE);
  });

  it('一覧の読み込みの 401 も同じ「ログインし直してください」(同じ画面で文がずれない)', async () => {
    mockServer(unauthenticated, unauthenticated);
    await renderAuditLogs();

    expect(container.textContent).toContain(RELOGIN_MESSAGE);
    expect(container.textContent).not.toContain(API_UNAUTHENTICATED_MESSAGE);
  });

  it('CSV の書き出しが 500 なら、これまでどおり「CSV エクスポートに失敗しました」(401 の文にしない)', async () => {
    mockServer(emptyList, () => jsonResponse(HTTP_INTERNAL_SERVER_ERROR, { error: { code: 'INTERNAL_ERROR', message: '内部エラー' } }));
    await renderAuditLogs();
    await clickCsvExport();

    expect(alerted()).toEqual([CSV_EXPORT_FAILURE_MESSAGE]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// プラン詳細: 初めの読み込み・状態の変更・保存の 401 (#2112。整合ゲートの指摘)
// ─────────────────────────────────────────────────────────────────────────────

describe('プラン詳細: 初めの読み込み・状態の変更・保存が 401 なら「ログインし直してください」(#2112)', () => {
  /** useParams の id (このファイルの next/navigation のモックは TICKET_ID を返す) */
  const PLAN_ID = TICKET_ID;
  const PLAN_URL = `/api/super-admin/plans/${PLAN_ID}`;
  /** 販売開始の前の Stripe の商品の ID (保存で送る値) */
  const PRODUCT_ID = 'prod_relogin_2112';
  /** 公開中・販売開始の前 (Product ID も Price ID も無い。Product ID の欄を入力できる) のプラン */
  const PLAN = {
    id: PLAN_ID,
    plan_key: 'pro',
    display_name: 'Pro',
    plan_type: 'personal',
    description: null,
    monthly_price_jpy: 580,
    yearly_price_jpy: 5800,
    max_members: null,
    stripe_product_id: null,
    stripe_price_id: null,
    stripe_yearly_price_id: null,
    status: 'public',
    display_order: 20,
    trial_days: 7,
    feature_packages: [],
    price_history: [],
  };

  let container: HTMLDivElement;
  let root: Root;
  let calls: string[];
  let patchBodies: unknown[];
  let alertMock: ReturnType<typeof vi.fn>;

  async function settle() {
    await act(async () => {
      for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** GET は get、PATCH は patch の応答を返す */
  function mockServer(get: () => Response, patch: () => Response) {
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input).split('?')[0];
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      if (url !== PLAN_URL) throw new Error(`テストに無い fetch: ${method} ${url}`);
      if (method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init?.body)));
        return patch();
      }
      return get();
    });
    vi.stubGlobal('alert', alertMock);
  }

  async function renderPlan() {
    await act(async () => {
      root.render(createElement(Suspense, { fallback: null }, createElement(PlanDetailPage)));
    });
    await settle();
  }

  const text = () => container.textContent ?? '';
  const loadedPlan = () => jsonResponse(HTTP_OK, { data: PLAN });
  const buttonWith = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

  async function click(element: HTMLElement | undefined, what: string) {
    expect(element, `${what}が見つからない`).toBeDefined();
    await act(async () => {
      element!.click();
    });
    await settle();
  }

  async function typeProductId(value: string) {
    const input = container.querySelector<HTMLInputElement>('[data-testid="plan-stripe-product-id"]');
    expect(input, 'Stripe の Product ID の入力欄が見つからない').not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    calls = [];
    patchBodies = [];
    alertMock = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('初めの読み込みが 401 なら、「プランの取得に失敗しました」でも本文の文でもなく「ログインし直してください」を出す', async () => {
    mockServer(unauthenticated, unauthenticated);
    await renderPlan();

    expect(calls).toEqual([`GET ${PLAN_URL}`]);
    expect(text()).toContain(RELOGIN_MESSAGE);
    expect(text()).not.toContain(API_UNAUTHENTICATED_MESSAGE);
    expect(text()).not.toContain('プランの取得に失敗しました');
  });

  it('初めの読み込みの 401 でない失敗は今までどおり (本文の日本語の文。401 の文にしない)', async () => {
    mockServer(() => jsonResponse(HTTP_INTERNAL_SERVER_ERROR, { error: { code: 'OP_DB_ERROR', message: 'プランを読み込めませんでした' } }), unauthenticated);
    await renderPlan();

    expect(text()).toContain('プランを読み込めませんでした');
    expect(text()).not.toContain(RELOGIN_MESSAGE);
  });

  it('状態の変更 (非公開にする) が 401 なら、alert に本文の文でなく「ログインし直してください」を出す', async () => {
    mockServer(loadedPlan, unauthenticated);
    await renderPlan();

    await click(buttonWith('非公開にする'), '「非公開にする」のボタン');

    expect(patchBodies).toEqual([{ status: 'private', expected_status: 'public' }]);
    expect(alertMock.mock.calls.map((call) => String(call[0]))).toEqual([RELOGIN_MESSAGE]);
  });

  it('状態の変更の 401 でない失敗は今までどおり (本文の文が無ければ「ステータス変更に失敗しました (HTTP 500)」)', async () => {
    mockServer(loadedPlan, () => htmlResponse(HTTP_INTERNAL_SERVER_ERROR));
    await renderPlan();

    await click(buttonWith('非公開にする'), '「非公開にする」のボタン');

    expect(alertMock.mock.calls.map((call) => String(call[0]))).toEqual([`ステータス変更に失敗しました (HTTP ${HTTP_INTERNAL_SERVER_ERROR})`]);
  });

  it('Stripe の Product ID の保存 (販売開始の手順) が 401 なら、「保存に失敗しました」でも本文の文でもなく「ログインし直してください」を出す', async () => {
    mockServer(loadedPlan, unauthenticated);
    await renderPlan();

    await typeProductId(PRODUCT_ID);
    await click(buttonWith('保存する'), '「保存する」のボタン');

    expect(patchBodies).toEqual([{ stripe_product_id: PRODUCT_ID }]);
    expect(text()).toContain(RELOGIN_MESSAGE);
    expect(text()).not.toContain(API_UNAUTHENTICATED_MESSAGE);
    expect(text()).not.toContain('保存に失敗しました');
    expect(text()).not.toContain('保存しました');
  });

  it('保存の 401 でない失敗は今までどおり (本文の日本語の文)', async () => {
    mockServer(loadedPlan, () => jsonResponse(HTTP_INTERNAL_SERVER_ERROR, { error: { code: 'OP_DB_ERROR', message: 'プランを保存できませんでした' } }));
    await renderPlan();

    await typeProductId(PRODUCT_ID);
    await click(buttonWith('保存する'), '「保存する」のボタン');

    expect(text()).toContain('プランを保存できませんでした');
    expect(text()).not.toContain(RELOGIN_MESSAGE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 見張り: 運営の画面のソースに 401 の文を直書きしない
// ─────────────────────────────────────────────────────────────────────────────

describe('見張り: 運営の画面のソースに 401 の文を直書きしない (UNAUTHENTICATED_SCREEN_MESSAGE を使う。#2112 Z4)', () => {
  const ROOT = process.cwd();
  /** 運営の画面のソースの置き場所 */
  const OPERATOR_SCREEN_DIRS = [
    'src/app/admin',
    'src/app/super-admin',
    'src/app/(support)',
    'src/components/admin',
    'src/components/operator',
    // 運営のメンバーシップの画面 (強制譲渡・強制解散・監査ログ) と、その通信と文の置き場所 (#2112 Z4)
    'src/app/(operator)',
    'src/lib/membership',
    // 運営の画面の文と読み込みの共通の関数の置き場所 (#2112 Z4)
    'src/lib/admin',
    'src/lib/super-admin',
  ];
  /** 画面のソースの拡張子 */
  const SOURCE_FILE = /\.tsx?$/;
  /**
   * 直書きを見張る 401 の文 (以前の運営の画面にあった言い回しと、利用者の画面の言い回し)。
   * 見張れるのはソースに書いた文だけ (code から文を引く表 (src/lib/auth/mfa/client.ts の mfaErrorMessage など) を通る文は、
   * 画面ごとの回帰テストが見る: 二段階認証の解除は tests/mfa-pages-browser.test.tsx)
   */
  const HARDCODED_401_TEXT = /ログインの有効期限が切れ|ログインが切れました|もう一度ログインしてください/;

  function listSources(dir: string): string[] {
    const abs = join(ROOT, dir);
    const out: string[] = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) out.push(...listSources(relative(ROOT, path)));
      else if (SOURCE_FILE.test(entry.name)) out.push(relative(ROOT, path));
    }
    return out;
  }

  const sources = OPERATOR_SCREEN_DIRS.flatMap(listSources);

  it('見張る範囲にファイルがある (置き場所が変わって空振りしていない)', () => {
    expect(sources).toContain('src/app/super-admin/backups/page.tsx');
    expect(sources).toContain('src/app/admin/announcements/AnnouncementsManager.tsx');
    expect(sources).toContain('src/components/admin/UserFreezeForm.tsx');
    expect(sources).toContain('src/app/(operator)/operator/membership/families/[id]/transfer/page.tsx');
    expect(sources).toContain('src/lib/membership/operator-screen-messages.ts');
  });

  it('401 の文 (「ログインの有効期限が切れ…」など) を直書きしているファイルは無い (組織の画面も揃えた。#2112)', () => {
    expect(sources).toContain('src/app/admin/organizations/OrganizationsManager.tsx');
    const offenders = sources.filter((file) => HARDCODED_401_TEXT.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 見張り: 運営の画面で失敗の本文の文をそのまま出す呼び出しは、401 を先に拾っているものだけ (#2112)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 呼び出しが 401 の本文の文 (「認証が必要です」) を画面に出さないと言える理由の種類 (ソースの木から機械で決める)。
 *   - unauthorized-first: 同じ関数の中で、呼び出しより前に 401 を拾っている
 *     (rereadUnavailableMessage / screenFailureMessage を呼ぶ・status を 401 (HTTP_UNAUTHORIZED…) と比べる)
 *   - non-401-branch    : 401 にならない分岐 (status を 401 でない数と比べた if・isStaleDataConflict の if) の中
 *   - not-displayed     : 戻り値を null と比べるだけ (文を出さない)
 *   - none              : どれでもない (401 の本文の文を出しうる)
 */
type BodyMessageGuard = 'unauthorized-first' | 'non-401-branch' | 'not-displayed' | 'none';

interface BodyMessageCall {
  /** リポジトリの根からのパス */
  file: string;
  /** 呼び出しを囲む関数の名前 (名前の無い関数は、名前のある外側の関数の名前に「/(無名)」を付ける) */
  fn: string;
  /** 呼んでいる関数 (screenApiErrorMessage / extractApiErrorMessage) */
  callee: string;
  guard: BodyMessageGuard;
}

/** 失敗の応答の本文から文を取り出す関数 (運営の画面が直接呼ぶもの) */
const BODY_MESSAGE_FUNCTIONS = new Set(['screenApiErrorMessage', 'extractApiErrorMessage']);
/** 401 を拾う共通の関数 (401 なら「ログインし直してください」を返す) */
const UNAUTHORIZED_AWARE_FUNCTIONS = new Set(['rereadUnavailableMessage', 'screenFailureMessage']);
/** 401 の数と、401 を表す定数の名前 */
const UNAUTHORIZED_STATUS = '401';
const UNAUTHORIZED_CONSTANT = /^HTTP_UNAUTHORIZED\w*$/;
/** status を数と比べる式の、数の側 (3 桁の HTTP のステータス) */
const HTTP_STATUS_LITERAL = /^\d{3}$/;

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** 関数の名前 (function f・const f = () => …・const f = useCallback(() => …)・メソッド)。無ければ null */
function functionNameOf(node: ts.FunctionLikeDeclaration): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name) {
    return node.name.getText();
  }
  let parent = node.parent;
  // useCallback(() => …) のように関数の呼び出しの引数なら、その呼び出しを代入した変数の名前
  if (parent && ts.isCallExpression(parent)) parent = parent.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

/** 呼び出しを囲む関数と、その名前 */
function enclosingFunctionOf(node: ts.Node): { scope: ts.Node; name: string } {
  let scope: ts.Node | null = null;
  let anonymous = false;
  for (let current = node.parent; current; current = current.parent) {
    if (!isFunctionLike(current)) continue;
    scope ??= current;
    const name = functionNameOf(current);
    if (name !== null) return { scope, name: anonymous ? `${name}/(無名)` : name };
    anonymous = true;
  }
  return { scope: scope ?? node.getSourceFile(), name: '(ファイルの直下)' };
}

/** 式が「status === 401」(status は res.status など・401 は数か HTTP_UNAUTHORIZED…) か */
function isUnauthorizedComparison(node: ts.Node): boolean {
  if (!ts.isBinaryExpression(node)) return false;
  const kind = node.operatorToken.kind;
  if (kind !== ts.SyntaxKind.EqualsEqualsEqualsToken && kind !== ts.SyntaxKind.EqualsEqualsToken) return false;
  const sides = [node.left, node.right];
  const hasStatus = sides.some((side) => /(^|\.)status$/.test(side.getText()));
  const hasUnauthorized = sides.some((side) => side.getText() === UNAUTHORIZED_STATUS || UNAUTHORIZED_CONSTANT.test(side.getText()));
  return hasStatus && hasUnauthorized;
}

/** scope の中で、position より前に 401 を拾う式があるか */
function handlesUnauthorizedBefore(scope: ts.Node, position: number): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found || node.getStart() >= position) return;
    if (isUnauthorizedComparison(node)) found = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && UNAUTHORIZED_AWARE_FUNCTIONS.has(node.expression.text)) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}

/** if の条件が、401 にならない status に絞っているか (status を 401 でない数と比べる・isStaleDataConflict(…)) */
function isNon401Condition(condition: ts.Expression): boolean {
  if (ts.isCallExpression(condition) && ts.isIdentifier(condition.expression) && condition.expression.text === 'isStaleDataConflict') {
    return true;
  }
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
  const sides = [condition.left, condition.right];
  return (
    sides.some((side) => /(^|\.)status$/.test(side.getText())) &&
    sides.some((side) => HTTP_STATUS_LITERAL.test(side.getText()) && side.getText() !== UNAUTHORIZED_STATUS)
  );
}

/** 呼び出しが、401 にならない分岐 (if の then の側) の中にあるか (囲む関数の中だけを見る) */
function isInsideNon401Branch(call: ts.Node, scope: ts.Node): boolean {
  let child: ts.Node = call;
  for (let current = call.parent; current && current !== scope; current = current.parent) {
    if (ts.isIfStatement(current) && current.thenStatement === child && isNon401Condition(current.expression)) return true;
    child = current;
  }
  return false;
}

/** 戻り値を null と比べるだけか (extractApiErrorMessage(body) === null など) */
function isNullComparisonOnly(call: ts.CallExpression): boolean {
  const parent = call.parent;
  if (!ts.isBinaryExpression(parent)) return false;
  const kind = parent.operatorToken.kind;
  const isEquality =
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    kind === ts.SyntaxKind.EqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsToken;
  const other = parent.left === call ? parent.right : parent.left;
  return isEquality && other.kind === ts.SyntaxKind.NullKeyword;
}

/** ソースの中の、失敗の本文の文を取り出す呼び出しを集め、401 を出さないと言える理由を決める */
function bodyMessageCallsOf(file: string, source: string): BodyMessageCall[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const calls: BodyMessageCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && BODY_MESSAGE_FUNCTIONS.has(node.expression.text)) {
      const { scope, name } = enclosingFunctionOf(node);
      const guard: BodyMessageGuard = isNullComparisonOnly(node)
        ? 'not-displayed'
        : isInsideNon401Branch(node, scope)
          ? 'non-401-branch'
          : handlesUnauthorizedBefore(scope, node.getStart())
            ? 'unauthorized-first'
            : 'none';
      calls.push({ file, fn: name, callee: node.expression.text, guard });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

describe('見張り: 運営の画面で失敗の本文の文を出す呼び出しは、401 を先に拾っているものだけ (#2112)', () => {
  const ROOT = process.cwd();
  /** 運営の画面のソースの置き場所 (画面だけ。共通の関数の src/lib は上の共通の関数のテストが見る) */
  const OPERATOR_SCREEN_DIRS = [
    'src/app/admin',
    'src/app/super-admin',
    'src/app/(support)',
    'src/app/(operator)',
    'src/components/admin',
    'src/components/operator',
  ];
  const SOURCE_FILE = /\.tsx?$/;

  function listSources(dir: string): string[] {
    const abs = join(ROOT, dir);
    const out: string[] = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = join(abs, entry.name);
      if (entry.isDirectory()) out.push(...listSources(relative(ROOT, path)));
      else if (SOURCE_FILE.test(entry.name)) out.push(relative(ROOT, path));
    }
    return out;
  }

  /**
   * 許す呼び出しの一覧 (理由つき)。呼び出しを足したら、401 を先に拾ってからここに足す。
   * guard はソースの木から機械で決めた種類と同じでなければならない (理由の書き換えだけでは通らない)
   */
  const ALLOWED_CALLS: ReadonlyArray<BodyMessageCall & { reason: string }> = [
    {
      file: 'src/app/admin/announcements/AnnouncementsManager.tsx',
      fn: 'handleSubmit',
      callee: 'extractApiErrorMessage',
      guard: 'non-401-branch',
      reason: '400 (入力の誤り) の分岐の中だけで本文の文を出す。401 は failureMessage が「ログインし直してください」にする',
    },
    {
      file: 'src/app/admin/announcements/AnnouncementsManager.tsx',
      fn: 'handleSubmit',
      callee: 'extractApiErrorMessage',
      guard: 'not-displayed',
      reason: '本文に API の文が無い 502 / 503 / 504 を見分けるために null と比べるだけ',
    },
    {
      file: 'src/app/admin/organizations/OrganizationsManager.tsx',
      fn: 'confirmReadFailureGuide',
      callee: 'screenApiErrorMessage',
      guard: 'unauthorized-first',
      reason: '作成の確かめの読み直しの 403 の本文の理由の文。401 は先に「ログインし直してください」を返す',
    },
    {
      file: 'src/app/admin/organizations/OrganizationsManager.tsx',
      fn: 'confirmReadFailureGuide',
      callee: 'screenApiErrorMessage',
      guard: 'unauthorized-first',
      reason: '作成の確かめの読み直しの 500 などの本文の文。401 は先に「ログインし直してください」を返す',
    },
    {
      file: 'src/app/admin/organizations/OrganizationsManager.tsx',
      fn: 'failureMessageOf',
      callee: 'extractApiErrorMessage',
      guard: 'unauthorized-first',
      reason: '一覧の読み込み・プランの変更・組織の作成の失敗の文。401 は先に「ログインし直してください」を返す',
    },
    {
      file: 'src/app/admin/organizations/OrganizationsManager.tsx',
      fn: 'handleCreate',
      callee: 'extractApiErrorMessage',
      guard: 'not-displayed',
      reason: '本文に API の文が無い 502 / 503 / 504 を見分けるために null と比べるだけ (文は failureMessageOf が出す)',
    },
    {
      file: 'src/app/super-admin/experiments/[id]/page.tsx',
      fn: 'loadExperiment',
      callee: 'screenApiErrorMessage',
      guard: 'unauthorized-first',
      reason: '初めの読み込みの失敗の文。401 / 403 は先に rereadUnavailableMessage の理由の文にする (#2101 X4)',
    },
    {
      file: 'src/app/super-admin/experiments/page.tsx',
      fn: 'loadExperiments',
      callee: 'screenApiErrorMessage',
      guard: 'unauthorized-first',
      reason: '一覧の初めの読み込みの失敗の文。401 / 403 は先に rereadUnavailableMessage の理由の文にする (#2101 X4)',
    },
    {
      file: 'src/app/super-admin/llm/quotas/page.tsx',
      fn: 'fetchQuotaList',
      callee: 'screenApiErrorMessage',
      guard: 'unauthorized-first',
      reason: '一覧の読み込みの失敗の文。401 / 403 は先に rereadUnavailableMessage の理由の文の例外にする (#2093 W6)',
    },
    {
      file: 'src/components/admin/UserFreezeForm.tsx',
      fn: 'send',
      callee: 'extractApiErrorMessage',
      guard: 'non-401-branch',
      reason: '409 CONFLICT_STALE_DATA (isStaleDataConflict) の分岐の中だけで本文の文を出す',
    },
    {
      file: 'src/components/admin/UserFreezeForm.tsx',
      fn: 'send',
      callee: 'extractApiErrorMessage',
      guard: 'unauthorized-first',
      reason: 'ほかの失敗の本文の文。401 は先に「ログインし直してください」にする (#2112 Z4)',
    },
  ];

  const sortKey = (call: BodyMessageCall) => `${call.file}\u0000${call.fn}\u0000${call.callee}\u0000${call.guard}`;
  const sorted = (calls: readonly BodyMessageCall[]) =>
    calls.map(({ file, fn, callee, guard }) => ({ file, fn, callee, guard })).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const found = OPERATOR_SCREEN_DIRS.flatMap(listSources).flatMap((file) => bodyMessageCallsOf(file, readFileSync(join(ROOT, file), 'utf8')));

  it('見張る範囲に呼び出しがある (置き場所・関数の名前が変わって空振りしていない)', () => {
    expect(found.some((call) => call.callee === 'screenApiErrorMessage')).toBe(true);
    expect(found.some((call) => call.callee === 'extractApiErrorMessage')).toBe(true);
  });

  it('401 を拾わずに本文の文を出す呼び出しは無い (プラン詳細の 3 か所・組織の画面は直した)', () => {
    expect(found.filter((call) => call.guard === 'none')).toEqual([]);
  });

  it('呼び出しは、理由つきの一覧にあるものだけ (足したら 401 を先に拾い、一覧に理由を書く)', () => {
    for (const allowed of ALLOWED_CALLS) expect(allowed.reason.trim()).not.toBe('');
    expect(sorted(found)).toEqual(sorted(ALLOWED_CALLS));
  });

  it('プラン詳細は本文の文を直接出さない (初めの読み込み・状態の変更・保存は screenFailureMessage を通す)', () => {
    expect(found.filter((call) => call.file === 'src/app/super-admin/plans/[id]/page.tsx')).toEqual([]);
  });

  describe('見張りの判定そのもの (見張りが空振りしないこと)', () => {
    const judge = (source: string) => bodyMessageCallsOf('sample.ts', source).map(({ fn, guard }) => ({ fn, guard }));

    it('401 を拾わずに本文の文を出す呼び出しは none', () => {
      expect(
        judge(`async function load(res) {
          const body = await res.json();
          setError(screenApiErrorMessage(body) ?? '失敗しました');
        }`),
      ).toEqual([{ fn: 'load', guard: 'none' }]);
    });

    it('401 の比べが呼び出しより後ろ・別の関数の中なら拾ったことにしない', () => {
      expect(
        judge(`function show(status, body) {
          const message = screenApiErrorMessage(body);
          if (status === 401) return 'ログインし直してください';
          return message;
        }
        function other(status) { return status === HTTP_UNAUTHORIZED; }`),
      ).toEqual([{ fn: 'show', guard: 'none' }]);
    });

    it('先に 401 を比べる・rereadUnavailableMessage / screenFailureMessage を呼ぶなら unauthorized-first', () => {
      expect(
        judge(`const load = useCallback(async (res, body) => {
          if (res.status === HTTP_UNAUTHORIZED) return;
          setError(extractApiErrorMessage(body));
        });
        function reload(res, body) {
          const unavailable = rereadUnavailableMessage(res.status, body, null);
          return unavailable ?? screenApiErrorMessage(body);
        }`),
      ).toEqual([
        { fn: 'load', guard: 'unauthorized-first' },
        { fn: 'reload', guard: 'unauthorized-first' },
      ]);
    });

    it('401 でない status の if の中なら non-401-branch、401 の if の中・else の側は拾ったことにしない', () => {
      expect(
        judge(`function a(res, body) { if (res.status === 400) setError(extractApiErrorMessage(body)); }
        function b(res, body) { if (res.status === 401) { } else { setError(extractApiErrorMessage(body)); } }
        function c(res, body) { if (res.status === 400) { } else { setError(extractApiErrorMessage(body)); } }`),
      ).toEqual([
        { fn: 'a', guard: 'non-401-branch' },
        // 401 の if を先に通る (else の側は 401 でない)
        { fn: 'b', guard: 'unauthorized-first' },
        { fn: 'c', guard: 'none' },
      ]);
    });

    it('null と比べるだけなら not-displayed', () => {
      expect(judge(`function a(body) { return extractApiErrorMessage(body) === null; }`)).toEqual([{ fn: 'a', guard: 'not-displayed' }]);
    });
  });
});
