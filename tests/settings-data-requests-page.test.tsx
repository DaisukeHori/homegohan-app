/**
 * #1178 / #1702 設定の「開示・訂正・利用停止の請求」の画面 (/settings/data-requests・/settings/data-requests/verify) の component テスト
 * (設計 docs/design/cross/15-data-subject-requests.md §9.1・§15)。
 *
 * 確認すること:
 *   - 新しい請求の送信で POST を呼び、送ったあとに一覧を読み直す。409・429 は API の文 / Retry-After の文を出す
 *   - 本人確認待ちの請求には「確認メールを再送」と、リンクの期限切れの表示が出る。再送は POST resend-verification
 *   - 取り下げは確認ダイアログの後にだけ POST withdraw を呼ぶ
 *   - 対応済み・対応できずの請求は、運営からの応答 (response_note) を本文で出す
 *   - 本人確認の画面は開いた時点で 1 回だけ POST verify を呼び、200・410・400 で文を出し分ける
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DsrOwnDto, DsrStatus } from '@/lib/data-subject-requests/core';
import { STORE_SUBSCRIPTION_DELETION_NOTICE } from '@homegohan/shared';

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});
vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.searchParams,
  useRouter: () => ({ push: vi.fn() }),
}));

const { default: DataRequestsSettingsPage } = await import('@/app/(main)/settings/data-requests/page');
const { default: DataRequestVerifyPage } = await import('@/app/(main)/settings/data-requests/verify/page');
const { DSR_ACCOUNT_API_PATH } = await import('@/lib/data-subject-requests/core');
const { dsrRateLimitedMessage } = await import('@/lib/data-subject-requests/client-messages');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'c'.repeat(64);
/** 429 の Retry-After (秒)。2 分ちょうど */
const RETRY_AFTER_SEC = 120;

function dto(overrides: Partial<DsrOwnDto> = {}): DsrOwnDto {
  return {
    id: REQUEST_ID,
    request_type: 'disclosure',
    status: 'received',
    details: '開示してください',
    verification_method: 'email_link',
    verification_sent_at: '2026-10-15T00:00:00.000Z',
    verification_expires_at: '2026-10-16T00:00:00.000Z',
    verification_send_count: 1,
    verification_expired: false,
    verified_at: '2026-10-15T01:00:00.000Z',
    due_at: '2026-11-14T01:00:00.000Z',
    response_note: null,
    resolved_at: null,
    created_at: '2026-10-15T00:00:00.000Z',
    updated_at: '2026-10-15T01:00:00.000Z',
    ...overrides,
  };
}

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[];
/** URL とメソッドごとの応答 (関数なら呼ぶたびに作る) */
let routes: Map<string, () => Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function route(method: string, url: string, respond: () => Response) {
  routes.set(`${method} ${url}`, respond);
}

function postsTo(url: string): FetchCall[] {
  return fetchCalls.filter((c) => c.method === 'POST' && c.url === url);
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function render(element: ReturnType<typeof createElement>) {
  await act(async () => {
    root.render(element);
  });
  await flush();
}

const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const dialogButton = (label: string) =>
  Array.from(byTestId('confirm-delete-modal')?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;

async function click(el: HTMLElement | null | undefined) {
  expect(el, 'クリック対象が見つからない').toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function typeDetails(value: string) {
  const textarea = byTestId('dsr-details') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function fillAndSubmit(type: string, details: string) {
  await click(byTestId(`dsr-type-${type}`));
  await typeDetails(details);
  await click(byTestId('dsr-submit'));
}

beforeEach(() => {
  fetchCalls = [];
  routes = new Map();
  mocks.searchParams = new URLSearchParams();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, method, body });
      const respond = routes.get(`${method} ${url}`);
      if (!respond) throw new Error(`想定外の fetch: ${method} ${url}`);
      return respond();
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.style.overflow = '';
  vi.unstubAllGlobals();
});

describe('/settings/data-requests: 新しい請求', () => {
  it('種類と内容を入れて送信すると POST { request_type, details } を呼び、送ったあとに一覧を読み直して案内を出す', async () => {
    let listed: DsrOwnDto[] = [];
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: listed }));
    route('POST', DSR_ACCOUNT_API_PATH, () => {
      listed = [dto({ status: 'pending_verification', request_type: 'correction', verified_at: null, due_at: null })];
      return json({ request: listed[0] }, 201);
    });
    await render(createElement(DataRequestsSettingsPage));
    expect(byTestId('dsr-list-empty')).not.toBeNull();

    await fillAndSubmit('correction', '住所を直してください');

    expect(postsTo(DSR_ACCOUNT_API_PATH)).toEqual([
      { url: DSR_ACCOUNT_API_PATH, method: 'POST', body: { request_type: 'correction', details: '住所を直してください' } },
    ]);
    expect(fetchCalls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(byTestId('dsr-notice')?.textContent).toContain('本人確認のメール');
    expect(byTestId('dsr-list')?.textContent).toContain('訂正');
    expect(byTestId('dsr-list')?.textContent).toContain('本人確認待ち');
  });

  it('種類を選ぶまで・内容が空のうちは送信できない', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [] }));
    await render(createElement(DataRequestsSettingsPage));
    const submit = byTestId('dsr-submit') as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    await click(byTestId('dsr-type-erasure'));
    expect(submit.disabled).toBe(true);
    await typeDetails('消してください');
    expect(submit.disabled).toBe(false);
  });

  it('409 (同じ種類が開いている) は API の文をそのまま出し、一覧は読み直さない', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [] }));
    const message = '同じ種類の請求がすでに受け付けられています。先にその請求の完了か取り下げをお待ちください';
    route('POST', DSR_ACCOUNT_API_PATH, () => json({ error: message, code: 'DSR_ALREADY_OPEN' }, 409));
    await render(createElement(DataRequestsSettingsPage));

    await fillAndSubmit('disclosure', '開示してください');

    expect(byTestId('dsr-form-error')?.textContent).toBe(message);
    expect(fetchCalls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('429 は Retry-After から分の文を出す (dsrRateLimitedMessage)', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [] }));
    route('POST', DSR_ACCOUNT_API_PATH, () =>
      json({ error: 'リクエストが多すぎます。', code: 'RATE_LIMITED', retryAfter: RETRY_AFTER_SEC }, 429, {
        'Retry-After': String(RETRY_AFTER_SEC),
      }),
    );
    await render(createElement(DataRequestsSettingsPage));

    await fillAndSubmit('suspension', '広告への利用を止めてください');

    expect(byTestId('dsr-form-error')?.textContent).toBe(dsrRateLimitedMessage(RETRY_AFTER_SEC));
    expect(byTestId('dsr-form-error')?.textContent).toContain('2分ほど');
  });

  it('開示と消去の説明に、自分で書き出す方法・すぐに削除できることを添える', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [] }));
    await render(createElement(DataRequestsSettingsPage));
    const form = byTestId('dsr-new-form')?.textContent ?? '';

    expect(form).toContain('データをエクスポート');
    expect(form).toContain('アカウントの削除は設定画面からすぐにできます');
  });

  it('#1912 P6: 消去の説明にだけ、ストアの購読は退会で解約されないこと (STORE_SUBSCRIPTION_DELETION_NOTICE) を添える', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [] }));
    await render(createElement(DataRequestsSettingsPage));
    const labelTextOf = (type: string) => byTestId(`dsr-type-${type}`)?.closest('label')?.textContent ?? '';

    expect(labelTextOf('erasure')).toContain(STORE_SUBSCRIPTION_DELETION_NOTICE);
    expect(labelTextOf('erasure').split(STORE_SUBSCRIPTION_DELETION_NOTICE)).toHaveLength(2);
    for (const type of ['disclosure', 'correction', 'suspension']) {
      const text = labelTextOf(type);
      // 描画が空で素通りしないこと
      expect(text.length, type).toBeGreaterThan(0);
      expect(text, type).not.toContain(STORE_SUBSCRIPTION_DELETION_NOTICE);
    }
  });
});

describe('/settings/data-requests: 一覧', () => {
  it('本人確認待ちの請求には「確認メールを再送」と期限切れの表示が出て、再送は POST resend-verification を呼ぶ', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () =>
      json({ requests: [dto({ status: 'pending_verification', verified_at: null, due_at: null, verification_expired: true })] }),
    );
    const resendUrl = `${DSR_ACCOUNT_API_PATH}/${REQUEST_ID}/resend-verification`;
    route('POST', resendUrl, () => json({ request: dto({ status: 'pending_verification', verification_send_count: 2 }) }));
    await render(createElement(DataRequestsSettingsPage));

    expect(byTestId('dsr-item-verification')?.textContent).toContain('期限が切れています');
    await click(byTestId('dsr-item-resend'));

    expect(postsTo(resendUrl)).toHaveLength(1);
    expect(byTestId('dsr-notice')?.textContent).toContain('送り直しました');
  });

  it('再送が上限 (409 DSR_VERIFICATION_LIMIT) なら API の文を出す', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [dto({ status: 'pending_verification', verified_at: null, due_at: null })] }));
    const message = '確認メールの送信回数が上限に達しました。お問い合わせください';
    route('POST', `${DSR_ACCOUNT_API_PATH}/${REQUEST_ID}/resend-verification`, () =>
      json({ error: message, code: 'DSR_VERIFICATION_LIMIT' }, 409),
    );
    await render(createElement(DataRequestsSettingsPage));

    await click(byTestId('dsr-item-resend'));

    expect(byTestId('dsr-action-error')?.textContent).toBe(message);
  });

  it('期限内の本人確認待ちは期限切れの表示を出さない', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [dto({ status: 'pending_verification', verified_at: null, due_at: null })] }));
    await render(createElement(DataRequestsSettingsPage));

    expect(byTestId('dsr-item-verification')?.textContent).not.toContain('期限が切れています');
  });

  it('取り下げは確認ダイアログの「取り下げる」を押した後にだけ POST withdraw を呼ぶ (キャンセルでは呼ばない)', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [dto({ status: 'in_progress' })] }));
    const withdrawUrl = `${DSR_ACCOUNT_API_PATH}/${REQUEST_ID}/withdraw`;
    route('POST', withdrawUrl, () => json({ request: dto({ status: 'withdrawn', resolved_at: '2026-10-16T00:00:00.000Z' }) }));
    await render(createElement(DataRequestsSettingsPage));

    await click(byTestId('dsr-item-withdraw'));
    expect(byTestId('confirm-delete-modal')).not.toBeNull();
    expect(postsTo(withdrawUrl)).toHaveLength(0);
    await click(dialogButton('キャンセル'));
    expect(postsTo(withdrawUrl)).toHaveLength(0);

    await click(byTestId('dsr-item-withdraw'));
    await click(dialogButton('取り下げる'));
    expect(postsTo(withdrawUrl)).toHaveLength(1);
    expect(byTestId('dsr-notice')?.textContent).toContain('取り下げました');
  });

  it.each(['fulfilled', 'rejected'] as const)('%s の請求は運営からの応答を本文で出し、取り下げは出さない', async (status) => {
    route('GET', DSR_ACCOUNT_API_PATH, () =>
      json({ requests: [dto({ status, response_note: '保有している情報は次のとおりです', resolved_at: '2026-10-20T00:00:00.000Z' })] }),
    );
    await render(createElement(DataRequestsSettingsPage));

    expect(byTestId('dsr-item-response')?.textContent).toContain('保有している情報は次のとおりです');
    expect(byTestId('dsr-item-withdraw')).toBeNull();
    expect(byTestId('dsr-item-resend')).toBeNull();
  });

  it.each<[DsrStatus, boolean]>([
    ['pending_verification', true],
    ['received', true],
    ['in_progress', true],
    ['fulfilled', false],
    ['rejected', false],
    ['withdrawn', false],
  ])('%s: 取り下げのボタンは開いている請求にだけ出る (%s)', async (status, expected) => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [dto({ status })] }));
    await render(createElement(DataRequestsSettingsPage));

    expect(byTestId('dsr-item-withdraw') !== null).toBe(expected);
  });

  it('受付番号 (id の先頭 8 桁)・状態・期限 (日本時間) を出す', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ requests: [dto({ status: 'received', due_at: '2026-11-14T16:00:00.000Z' })] }));
    await render(createElement(DataRequestsSettingsPage));
    const text = byTestId('dsr-list')?.textContent ?? '';

    expect(text).toContain(REQUEST_ID.slice(0, 8));
    expect(text).toContain('受付済み');
    // 16:00Z は日本時間の翌日
    expect(byTestId('dsr-item-due')?.textContent).toBe('2026年11月15日');
  });

  it('一覧の読み込みに失敗したら文と再読み込みのボタンを出す', async () => {
    route('GET', DSR_ACCOUNT_API_PATH, () => json({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' }, 500));
    await render(createElement(DataRequestsSettingsPage));

    expect(byTestId('dsr-load-failed')).not.toBeNull();
  });
});

describe('/settings/data-requests/verify: 本人確認', () => {
  const verifyUrl = `${DSR_ACCOUNT_API_PATH}/${REQUEST_ID}/verify`;

  function openLink(params: Record<string, string>) {
    mocks.searchParams = new URLSearchParams(params);
  }

  it('開いた時点で POST verify { token } を 1 回だけ呼び、200 なら「受け付けました」と応答の期限 (日本時間) を出す', async () => {
    openLink({ id: REQUEST_ID, token: TOKEN });
    route('POST', verifyUrl, () => json({ request: dto({ status: 'received', due_at: '2026-11-14T16:00:00.000Z' }) }));

    await render(createElement(DataRequestVerifyPage));
    await flush();

    expect(postsTo(verifyUrl)).toEqual([{ url: verifyUrl, method: 'POST', body: { token: TOKEN } }]);
    const result = byTestId('dsr-verify-result');
    expect(result?.getAttribute('data-outcome')).toBe('received');
    expect(result?.textContent).toContain('受け付けました');
    expect(result?.textContent).toContain('2026年11月15日');
    expect(byTestId('dsr-verify-list-link')?.getAttribute('href')).toBe('/settings/data-requests');
  });

  it('410 は「リンクの期限が切れています」', async () => {
    openLink({ id: REQUEST_ID, token: TOKEN });
    route('POST', verifyUrl, () => json({ error: '確認リンクの期限が切れています。', code: 'DSR_VERIFICATION_EXPIRED' }, 410));

    await render(createElement(DataRequestVerifyPage));

    expect(byTestId('dsr-verify-result')?.getAttribute('data-outcome')).toBe('expired');
    expect(byTestId('dsr-verify-result')?.textContent).toContain('リンクの期限が切れています');
  });

  it.each([400, 404, 409])('%s は「このリンクは使えません」', async (status) => {
    openLink({ id: REQUEST_ID, token: TOKEN });
    route('POST', verifyUrl, () => json({ error: '使えません', code: 'X' }, status));

    await render(createElement(DataRequestVerifyPage));

    expect(byTestId('dsr-verify-result')?.getAttribute('data-outcome')).toBe('unusable');
    expect(byTestId('dsr-verify-result')?.textContent).toContain('このリンクは使えません');
    expect(byTestId('dsr-verify-list-link')).not.toBeNull();
  });

  it('id か token が無いリンクは POST を呼ばずに「このリンクは使えません」', async () => {
    openLink({ id: REQUEST_ID });

    await render(createElement(DataRequestVerifyPage));

    expect(fetchCalls).toHaveLength(0);
    expect(byTestId('dsr-verify-result')?.getAttribute('data-outcome')).toBe('unusable');
  });

  it('描き直しても POST は 1 回だけ', async () => {
    openLink({ id: REQUEST_ID, token: TOKEN });
    route('POST', verifyUrl, () => json({ request: dto() }));

    await render(createElement(DataRequestVerifyPage));
    await render(createElement(DataRequestVerifyPage));

    expect(postsTo(verifyUrl)).toHaveLength(1);
  });
});
