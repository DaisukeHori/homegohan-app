/**
 * #2101 の整合ゲート (integrity-1030c): 応答を受け取れなかったあとの読み直しが 401 / 403 で断られたら、
 * 「確かめ直す」を出さず、理由の文 (401 は「ログインし直してください」・403 は理由の文) を添え、送信は止めたままにする。
 *
 * 以前の画面:
 *   - DR 訓練の記録 (/super-admin/backups) は、読み直しの 401 / 403 / その他の失敗の区別が消え (reload が null を返すだけ)、
 *     401 / 403 でも「確かめ直す」を出し続けた。押しても必ず同じ理由で断られ、401 では「ログインし直してください」も出なかった
 *     (同じ #2101 X2 のお知らせ・営業のリードの活動は、読み直しても変わらない 401 / 403 では「確かめ直す」を出さない)。
 *   - 価格の変更 (/super-admin/plans/[id]/price-change) は、読み直しが 401 のとき「済んだか分かりません」だけを出し、ログインし直す案内を出さなかった。
 * 直したあと (不変条件):
 *   - 読み直しが 401 / 403 なら、送信を止めたまま、理由の文を添え、「確かめ直す」を出さない (押し直せない)
 *   - 読み直しがほかの失敗 (500 など) なら、これまでどおり送信を止めたまま「確かめ直す」を出す (DR 訓練の記録)。理由の文は添えない
 *   - 理由の文に英字の内部の値 (エラーのコード・英字の文) を出さない
 *
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, createElement, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DR_TEST_AUDIT_ACTIONS,
  DR_TEST_AUDIT_TARGET_TYPE,
  SUPER_ADMIN_BACKUPS_API_PATH,
  SUPER_ADMIN_DR_TESTS_API_PATH,
  type BackupAuditRow,
} from '@/lib/backups/core';
import { jstToday } from '@/lib/jst-day-ranges';
import { UNAUTHENTICATED_SCREEN_MESSAGE } from '@/lib/admin/api-error-message';
import { API_MFA_REQUIRED_MESSAGE } from '@/lib/api/forbidden-reason-messages';

const PLAN_ID = '21012101-3333-4333-8333-333333333333';

const nav = vi.hoisted(() => {
  const push = vi.fn();
  return { push, router: { push, replace: () => undefined, refresh: () => undefined, back: () => undefined } };
});
const routerPush = nav.push;

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '21012101-3333-4333-8333-333333333333' }),
  useRouter: () => nav.router,
}));

vi.mock('next/link', () => ({
  default: (props: { href: string; children?: React.ReactNode; className?: string }) =>
    createElement('a', { href: props.href, className: props.className }, props.children),
}));

const { default: SuperAdminBackupsPage } = await import('@/app/super-admin/backups/page');
const { default: PriceChangePage } = await import('@/app/super-admin/plans/[id]/price-change/page');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 本文が JSON でない失敗の応答 (手前のプロキシ・ホスティングの応答) */
const proxyResponse = (status: number) =>
  new Response('<html><body>Gateway Timeout</body></html>', { status, headers: { 'content-type': 'text/html' } });
/** 通信の reject (応答が切れた・届かなかった) */
const networkFailure = () => new TypeError('Failed to fetch');
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 401 の本文 (英字のコードと文。画面に出してはいけない) */
const UNAUTHORIZED_CODE = 'AUTH_UNAUTHENTICATED';
const UNAUTHORIZED_ENGLISH = 'Unauthorized';
/** 403 のロールが足りないときの本文 (英字のコードと文。画面に出してはいけない) */
const FORBIDDEN_CODE = 'OP_PERMISSION_DENIED';
const FORBIDDEN_ENGLISH = 'Forbidden: super_admin only';
/** 500 の本文の英字のコード (画面に出してはいけない) */
const INTERNAL_CODE = 'INTERNAL_ERROR';

type Responder = () => Response;
const unauthorized: Responder = () => jsonResponse(401, { error: { code: UNAUTHORIZED_CODE, message: UNAUTHORIZED_ENGLISH } });
const forbiddenByRole: Responder = () => jsonResponse(403, { error: { code: FORBIDDEN_CODE, message: FORBIDDEN_ENGLISH } });
const forbiddenByMfa: Responder = () => jsonResponse(403, { error: { code: 'AUTH_2FA_REQUIRED', message: API_MFA_REQUIRED_MESSAGE } });
const internalError: Responder = () => jsonResponse(500, { error: { code: INTERNAL_CODE, message: 'boom' } });

/** 画面に出てはいけない英字の値 */
const ENGLISH_LEAKS = [UNAUTHORIZED_CODE, UNAUTHORIZED_ENGLISH, FORBIDDEN_CODE, FORBIDDEN_ENGLISH, INTERNAL_CODE, 'Failed to fetch', 'Gateway Timeout'];

/** 送信を止めたときの案内の断片 */
const CREATE_UNCONFIRMED_GUIDE = '済んだか分かりません。一覧で確かめてから作り直してください';
const REOPEN_GUIDE = 'もう一度送るときは、画面を開き直してください';
/** 読み込みの失敗の文 (時間をおけば読めうるときの文。401 / 403 には出さない) */
const LOAD_FAILED_TEXT = 'バックアップの状態を読み込めませんでした。時間をおいてもう一度開いてください';
/** 403 のロールが足りないときの、DR 訓練の記録の画面の固定の文 */
const BACKUPS_FORBIDDEN_TEXT = 'この画面を見る権限がありません';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderElement(element: React.ReactElement) {
  await act(async () => {
    root.render(createElement(Suspense, { fallback: null }, element));
  });
  await settle();
}

const findButton = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
const buttonWith = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

async function click(element: HTMLElement | undefined, what: string) {
  expect(element, `${what}が見つからない`).toBeDefined();
  await act(async () => {
    element!.click();
  });
  await settle();
}

async function typeInto(element: Element | null | undefined, value: string, what: string) {
  expect(element, `${what}が見つからない`).toBeTruthy();
  const target = element as HTMLInputElement | HTMLTextAreaElement;
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const text = () => container.textContent ?? '';
const methodOf = (init: unknown) => ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
const postCount = () => fetchMock.mock.calls.filter(([, init]) => methodOf(init) === 'POST').length;

function expectNoLeak() {
  for (const leak of ENGLISH_LEAKS) expect(text(), `「${leak}」が出ている`).not.toContain(leak);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  routerPush.mockReset();
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
// DR 訓練の記録 (/super-admin/backups)
// ─────────────────────────────────────────────────────────────────────────────

const OLD_DR: BackupAuditRow = {
  id: '21012101-4444-4444-8444-000000000001',
  created_at: '2026-10-30T02:00:00.000Z',
  action_type: DR_TEST_AUDIT_ACTIONS.monthly_pitr,
  target_type: DR_TEST_AUDIT_TARGET_TYPE,
  actor_id: '21012101-4444-4444-8444-000000000009',
  severity: 'info',
  details: {
    kind: 'monthly_pitr',
    result: 'success',
    performed_on: '2026-09-01',
    environment: 'local',
    restored_to: null,
    backup_key: null,
    rto_minutes: null,
    smoke: 'passed',
    notes: '',
  },
};

const backupsOk: Responder = () =>
  jsonResponse(200, {
    data: {
      latest: { daily: null, weekly: null, annual: null },
      latest_dr_tests: { monthly_pitr: OLD_DR, quarterly_restore: null, annual_drill: null },
      stale: false,
      stale_after_hours: 36,
      backups: [],
      dr_tests: [OLD_DR],
    },
  });

/** GET は reads を順に返し (最後のものを繰り返す)、POST は通信の reject (応答を受け取れなかった) */
function mockBackups(reads: readonly Responder[]) {
  let gets = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (methodOf(init) === 'POST') {
      expect(input).toBe(SUPER_ADMIN_DR_TESTS_API_PATH);
      throw networkFailure();
    }
    expect(input).toBe(SUPER_ADMIN_BACKUPS_API_PATH);
    const responder = reads[Math.min(gets, reads.length - 1)]!;
    gets += 1;
    return responder();
  });
  vi.stubGlobal('fetch', fetchMock);
}

const drForm = () => container.querySelector<HTMLFormElement>('[data-testid="dr-test-form"]');
const drSubmitButton = () => drForm()?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
const drUnconfirmed = () => container.querySelector('[data-testid="dr-test-form-unconfirmed"]')?.textContent ?? '';

async function submitDrForm() {
  const form = drForm();
  expect(form).not.toBeNull();
  await act(async () => {
    form!.requestSubmit();
  });
  await settle();
}

/** 送信を止めたまま: 送信のボタンは押せず、送っても POST しない */
async function expectDrSubmitStopped() {
  expect(drSubmitButton()?.disabled).toBe(true);
  const before = postCount();
  await submitDrForm();
  expect(postCount()).toBe(before);
}

describe('DR 訓練の記録: 応答を受け取れなかったあとの読み直しが 401 / 403 なら「確かめ直す」を出さない (#2101 integrity-1030c)', () => {
  it('読み直しが 401 なら、「ログインし直してください」を添え、「確かめ直す」は出さず、送信を止めたまま', async () => {
    mockBackups([backupsOk, unauthorized]);
    await renderElement(createElement(SuperAdminBackupsPage));
    await typeInto(container.querySelector('#dr-test-notes'), 'pitr ok', 'メモの欄');
    await submitDrForm();

    expect(postCount()).toBe(1);
    const unconfirmed = drUnconfirmed();
    expect(unconfirmed).toContain('DR 訓練の記録の応答を受け取れませんでした（通信エラー）');
    expect(unconfirmed).toContain(CREATE_UNCONFIRMED_GUIDE);
    expect(unconfirmed).toContain(UNAUTHENTICATED_SCREEN_MESSAGE);
    expect(unconfirmed).toContain(REOPEN_GUIDE);
    expect(findButton('確かめ直す')).toBeUndefined();
    // 読み込みの欄も、時間をおけば読めうる文ではなく、ログインし直す文にする
    expect(text()).not.toContain(LOAD_FAILED_TEXT);
    expectNoLeak();
    await expectDrSubmitStopped();
  });

  it.each([
    ['ロールが足りない (英字の本文)', forbiddenByRole, BACKUPS_FORBIDDEN_TEXT],
    ['二段階認証の確認が要る', forbiddenByMfa, API_MFA_REQUIRED_MESSAGE],
  ] as const)('読み直しが 403 (%s) なら、理由の文を添え、「確かめ直す」は出さず、送信を止めたまま', async (_label, reread, reason) => {
    mockBackups([backupsOk, reread]);
    await renderElement(createElement(SuperAdminBackupsPage));
    await submitDrForm();

    expect(postCount()).toBe(1);
    const unconfirmed = drUnconfirmed();
    expect(unconfirmed).toContain(CREATE_UNCONFIRMED_GUIDE);
    expect(unconfirmed).toContain(reason);
    expect(unconfirmed).not.toContain(UNAUTHENTICATED_SCREEN_MESSAGE);
    expect(findButton('確かめ直す')).toBeUndefined();
    expectNoLeak();
    await expectDrSubmitStopped();
  });

  it.each([
    ['500', internalError],
    ['本文の無い 502', () => proxyResponse(502)],
    ['通信の reject', () => { throw networkFailure(); }],
  ] as const)('読み直しが %s なら、これまでどおり「確かめ直す」を出し、理由の文は添えない (送信は止めたまま)', async (_label, reread) => {
    mockBackups([backupsOk, reread]);
    await renderElement(createElement(SuperAdminBackupsPage));
    await submitDrForm();

    expect(postCount()).toBe(1);
    const unconfirmed = drUnconfirmed();
    expect(unconfirmed).toContain(CREATE_UNCONFIRMED_GUIDE);
    expect(unconfirmed).not.toContain(UNAUTHENTICATED_SCREEN_MESSAGE);
    expect(unconfirmed).not.toContain(BACKUPS_FORBIDDEN_TEXT);
    expect(findButton('確かめ直す')).toBeDefined();
    expectNoLeak();
    await expectDrSubmitStopped();
  });

  it('「確かめ直す」の読み直しが 401 になったら、そこで「確かめ直す」を消し、「ログインし直してください」を添える (送信は止めたまま)', async () => {
    mockBackups([backupsOk, internalError, unauthorized]);
    await renderElement(createElement(SuperAdminBackupsPage));
    await submitDrForm();
    expect(findButton('確かめ直す')).toBeDefined();
    expect(drUnconfirmed()).not.toContain(UNAUTHENTICATED_SCREEN_MESSAGE);

    await click(findButton('確かめ直す'), '「確かめ直す」ボタン');
    expect(postCount()).toBe(1);
    expect(drUnconfirmed()).toContain(CREATE_UNCONFIRMED_GUIDE);
    expect(drUnconfirmed()).toContain(UNAUTHENTICATED_SCREEN_MESSAGE);
    expect(findButton('確かめ直す')).toBeUndefined();
    expectNoLeak();
    await expectDrSubmitStopped();
  });

  it('初めの読み込みが 401 なら、読み込みの欄に「ログインし直してください」を出す (時間をおいて開き直す文にしない)', async () => {
    mockBackups([unauthorized]);
    await renderElement(createElement(SuperAdminBackupsPage));

    const loadError = container.querySelector('[data-testid="backups-load-error"]')?.textContent ?? '';
    expect(loadError).toContain(UNAUTHENTICATED_SCREEN_MESSAGE);
    expect(loadError).not.toContain(LOAD_FAILED_TEXT);
    expectNoLeak();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 価格の変更 (/super-admin/plans/[id]/price-change)
// ─────────────────────────────────────────────────────────────────────────────

const OLD_MONTHLY = 580;
const NEW_MONTHLY = 680;
const PLAN_PATH = `/api/super-admin/plans/${PLAN_ID}`;
const IMPACT_PATH = `/api/super-admin/plans/${PLAN_ID}/price-impact`;
const CHANGE_PATH = `/api/super-admin/plans/${PLAN_ID}/price-change`;
const HISTORY_PATH = `/super-admin/plans/${PLAN_ID}?tab=history`;
/** 価格の変更の読み直しに失敗したときの案内 */
const PRICE_UNCONFIRMED_GUIDE = '済んだか分かりません。履歴で確かめてください';
/** 403 のロールが足りないときの既定の文 */
const DEFAULT_FORBIDDEN_TEXT = '権限がありません';

const planOk: Responder = () =>
  jsonResponse(200, {
    data: {
      id: PLAN_ID,
      plan_key: 'pro',
      plan_type: 'personal',
      display_name: 'Pro',
      monthly_price_jpy: OLD_MONTHLY,
      yearly_price_jpy: null,
      status: 'public',
    },
  });

/** GET /plans/{id} は plans を順に返し (最後のものを繰り返す)、POST price-change は通信の reject */
function mockPriceChange(plans: readonly Responder[]) {
  let planCalls = 0;
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = methodOf(init);
    if (url.pathname === PLAN_PATH && method === 'GET') {
      const responder = plans[Math.min(planCalls, plans.length - 1)]!;
      planCalls += 1;
      return responder();
    }
    if (url.pathname === IMPACT_PATH) {
      return jsonResponse(200, {
        data: {
          affected_subscription_count: 0,
          affected_mrr_change_jpy: 0,
          current_monthly_price_jpy: OLD_MONTHLY,
          new_monthly_price_jpy: NEW_MONTHLY,
          applies_to: 'new_only',
          effective_timing: 'new_only',
        },
      });
    }
    if (url.pathname === CHANGE_PATH && method === 'POST') throw networkFailure();
    throw new Error(`想定していない fetch: ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function executePriceChange() {
  await typeInto(container.querySelectorAll('input[type="number"]')[0], String(NEW_MONTHLY), '新しい月額の欄');
  await click(buttonWith('影響をシミュレーション'), 'シミュレーションのボタン');
  await click(buttonWith('確認ステップへ'), '確認ステップへ');
  await typeInto(container.querySelector('textarea'), '価格の見直し', '変更理由の欄');
  await click(buttonWith('価格変更を実行する'), '実行のボタン');
}

const priceUnconfirmed = () => container.querySelector('[data-testid="price-change-unconfirmed"]')?.textContent ?? '';

/** 送信を止めたまま: 実行のボタンは押せず、押しても POST しない */
async function expectPriceSubmitStopped() {
  const executeButton = buttonWith('価格変更を実行する');
  expect(executeButton?.disabled).toBe(true);
  await act(async () => {
    executeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
  expect(postCount()).toBe(1);
}

describe('価格の変更: 応答を受け取れなかったあとの読み直しが 401 / 403 なら理由の文を添える (#2101 integrity-1030c)', () => {
  it('読み直しが 401 なら、「済んだか分かりません」に「ログインし直してください」を添え、送信を止めたまま', async () => {
    mockPriceChange([planOk, unauthorized]);
    await renderElement(createElement(PriceChangePage));
    await executePriceChange();

    expect(routerPush).not.toHaveBeenCalled();
    const unconfirmed = priceUnconfirmed();
    expect(unconfirmed).toContain('価格変更の応答を受け取れませんでした（通信エラー）');
    expect(unconfirmed).toContain(PRICE_UNCONFIRMED_GUIDE);
    expect(unconfirmed).toContain(UNAUTHENTICATED_SCREEN_MESSAGE);
    expect(Array.from(container.querySelectorAll('a')).some((a) => a.getAttribute('href') === HISTORY_PATH)).toBe(true);
    expectNoLeak();
    await expectPriceSubmitStopped();
  });

  it.each([
    ['ロールが足りない (英字の本文)', forbiddenByRole, DEFAULT_FORBIDDEN_TEXT],
    ['二段階認証の確認が要る', forbiddenByMfa, API_MFA_REQUIRED_MESSAGE],
  ] as const)('読み直しが 403 (%s) なら、理由の文を添え、送信を止めたまま', async (_label, reread, reason) => {
    mockPriceChange([planOk, reread]);
    await renderElement(createElement(PriceChangePage));
    await executePriceChange();

    expect(routerPush).not.toHaveBeenCalled();
    const unconfirmed = priceUnconfirmed();
    expect(unconfirmed).toContain(PRICE_UNCONFIRMED_GUIDE);
    expect(unconfirmed).toContain(reason);
    expect(unconfirmed).not.toContain(UNAUTHENTICATED_SCREEN_MESSAGE);
    expectNoLeak();
    await expectPriceSubmitStopped();
  });

  it.each([
    ['500', internalError],
    ['本文の無い 502', () => proxyResponse(502)],
    ['通信の reject', () => { throw networkFailure(); }],
    ['404', () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'Plan not found' } })],
  ] as const)('読み直しが %s なら、これまでどおり「済んだか分かりません」だけを出し、ログイン・権限の文は添えない (送信は止めたまま)', async (_label, reread) => {
    mockPriceChange([planOk, reread]);
    await renderElement(createElement(PriceChangePage));
    await executePriceChange();

    const unconfirmed = priceUnconfirmed();
    expect(unconfirmed).toContain(PRICE_UNCONFIRMED_GUIDE);
    expect(unconfirmed).not.toContain(UNAUTHENTICATED_SCREEN_MESSAGE);
    expect(unconfirmed).not.toContain(DEFAULT_FORBIDDEN_TEXT);
    expect(text()).not.toContain('Plan not found');
    expectNoLeak();
    await expectPriceSubmitStopped();
  });
});
