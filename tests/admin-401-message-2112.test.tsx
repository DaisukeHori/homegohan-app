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
 * 直したあと (不変条件):
 *   - 共通の関数は 401 なら本文の文に関わらず「ログインし直してください」にする (ほかの status は今までどおり)
 *   - チケットの担当者の設定・ステータスの変更の 401 は「ログインし直してください」
 *   - 強制譲渡・強制解散の POST の 401 は「ログインし直してください」(本文の無い 502 / 503 / 504 の「応答を受け取れなかった」は今までどおり)
 *   - 運営の画面のソースに 401 の文を直書きしない (UNAUTHENTICATED_SCREEN_MESSAGE を使う)
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
  ];
  /** 画面のソースの拡張子 */
  const SOURCE_FILE = /\.tsx?$/;
  /** 直書きを見張る 401 の文 (以前の画面にあった言い回し) */
  const HARDCODED_401_TEXT = /ログインの有効期限が切れ/;
  /**
   * まだ直書きが残っているファイル (別の案件の範囲。#2112 Z2 の組織の画面がマージされたあとに揃え、ここから外す)
   */
  const PENDING_FILES = new Set(['src/app/admin/organizations/OrganizationsManager.tsx']);

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

  it('「ログインの有効期限が切れ…」を直書きしているのは、まだ揃えていないファイルだけ', () => {
    const offenders = sources.filter((file) => HARDCODED_401_TEXT.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(offenders.filter((file) => !PENDING_FILES.has(file))).toEqual([]);
  });
});
