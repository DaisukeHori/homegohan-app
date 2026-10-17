/**
 * #1797 手動のプラン付与 段 C: 画面の節 ManualPlanGrantSection のブラウザの動き (billing/02 §8.6・§10・テスト 35〜37)
 *
 * @/lib/billing/manual-grant-client の通信の 3 関数だけを vi.fn にし、manualGrantErrorMessage・定数は本物を使う。
 * tests/mfa-pages-browser.test.tsx の OperatorMfaResetSection の it と同じく react-dom/client + act。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualGrantClientResult } from '@/lib/billing/manual-grant-client';
import {
  MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE,
  MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE,
  manualGrantErrorMessage,
  type ManualPlanGrantResult,
  type ManualPlanRevokeResult,
  type ManualPlanView,
} from '@/lib/billing/manual-grant';

const mocks = vi.hoisted(() => ({
  fetchManualPlanView: vi.fn(),
  grantManualPlanRequest: vi.fn(),
  revokeManualPlanRequest: vi.fn(),
}));

vi.mock('@/lib/billing/manual-grant-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/manual-grant-client')>();
  return {
    ...actual,
    fetchManualPlanView: mocks.fetchManualPlanView,
    grantManualPlanRequest: mocks.grantManualPlanRequest,
    revokeManualPlanRequest: mocks.revokeManualPlanRequest,
  };
});

const {
  ManualPlanGrantSection,
  GRANT_CONFIRM_MESSAGE,
  REVOKE_CONFIRM_MESSAGE,
  MANUAL_GRANT_HISTORY_LABELS,
  MANUAL_PLAN_SOURCE_LABELS,
} = await import('@/components/admin/ManualPlanGrantSection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET_USER_ID = '88888888-8888-4888-8888-888888888888';
const SUBSCRIPTION_ID = '11111111-1111-4111-8111-111111111111';
const HISTORY_ID_GRANT = '22222222-2222-4222-8222-222222222221';
const HISTORY_ID_REVOKE = '22222222-2222-4222-8222-222222222222';
const HISTORY_ID_EXPIRED = '22222222-2222-4222-8222-222222222223';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const REASON = '社内検証のため 3 か月だけ付与する';
/** 2026-12-31 の終わり (JST) = 2026-12-31T15:00:00.000Z。画面は JST で「2027/1/1 0:00:00」と出す */
const EXPIRES_AT_ISO = '2026-12-31T15:00:00.000Z';
const EXPIRES_AT_DISPLAY = '2027/1/1 0:00:00';
const NO_EXPIRY_DISPLAY = '期限なし';

const PLANS: ManualPlanView['plans'] = [
  { plan_key: 'pro', display_name: 'プロ', plan_type: 'personal', max_members: null },
  { plan_key: 'family_plus', display_name: 'ファミリー', plan_type: 'family', max_members: 5 },
];

function viewOf(overrides: Partial<ManualPlanView> = {}): ManualPlanView {
  return { current: null, plans: PLANS, history: [], ...overrides };
}

function ok<T>(data: T): ManualGrantClientResult<T> {
  return { ok: true, data };
}
function fail(status: number, code: string): ManualGrantClientResult<never> {
  return { ok: false, status, code };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function renderSection() {
  await act(async () => {
    root.render(createElement(ManualPlanGrantSection, { userId: TARGET_USER_ID }));
  });
  await flush();
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return container.querySelector<T>(`[data-testid="${id}"]`);
}

/** React の制御された textarea / select / input に値を入れる (textarea・input は input、select は change で onChange を起こす) */
async function setFieldValue(field: HTMLTextAreaElement | HTMLSelectElement | HTMLInputElement | null, value: string) {
  expect(field).not.toBeNull();
  await act(async () => {
    const proto =
      field instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : field instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
    field?.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

async function submitForm(button: HTMLButtonElement | null) {
  expect(button).not.toBeNull();
  await act(async () => {
    button?.form?.requestSubmit(button);
  });
  await flush();
}

beforeEach(() => {
  for (const fn of [mocks.fetchManualPlanView, mocks.grantManualPlanRequest, mocks.revokeManualPlanRequest]) fn.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ManualPlanGrantSection (billing/02 §8.6・§10)', () => {
  it('ManualPlanGrantSection: loads the view on mount; with no contract shows the grant form whose submit is disabled until a plan and a non-blank reason are set; confirm cancel does not call grantManualPlanRequest; confirm ok calls it once with expires_on null when the date is empty and reloads on success', async () => {
    const granted: ManualPlanGrantResult = {
      subscription_id: SUBSCRIPTION_ID,
      user_id: TARGET_USER_ID,
      plan_key: 'pro',
      status: 'active',
      expires_at: null,
    };
    const afterGrant = viewOf({
      current: {
        subscription_id: SUBSCRIPTION_ID,
        plan_key: 'pro',
        status: 'active',
        source: 'manual',
        starts_at: '2026-10-17T00:00:00.000Z',
        expires_at: null,
      },
    });
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);

    await renderSection();
    // 開いたとき 1 回読む (対象の利用者の id で)
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(1);
    expect(mocks.fetchManualPlanView).toHaveBeenCalledWith(TARGET_USER_ID);
    expect(container.querySelector('h2')?.textContent).toBe('手動のプラン付与');
    expect(byTestId('manual-plan-grant-load-error')).toBeNull();
    expect(byTestId('manual-plan-grant-current')).toBeNull();
    expect(byTestId('manual-plan-revoke-submit')).toBeNull();

    // 付与のフォーム: プランの選択肢は「表示名 (plan_key)」。理由は 500 文字まで
    const plan = () => byTestId<HTMLSelectElement>('manual-plan-grant-plan');
    const expiresOn = () => byTestId<HTMLInputElement>('manual-plan-grant-expires-on');
    const reason = () => byTestId<HTMLTextAreaElement>('manual-plan-grant-reason');
    const submit = () => byTestId<HTMLButtonElement>('manual-plan-grant-submit');
    expect(Array.from(plan()?.options ?? []).map((o) => [o.value, o.textContent])).toEqual([
      ['', '選択してください'],
      ['pro', 'プロ (pro)'],
      ['family_plus', 'ファミリー (family_plus)'],
    ]);
    expect(expiresOn()?.type).toBe('date');
    expect(reason()?.maxLength).toBe(500);
    expect(submit()?.textContent).toBe('付与する');

    // プランと空白でない理由がそろうまで押せない
    expect(submit()?.disabled).toBe(true);
    await setFieldValue(plan(), 'pro');
    expect(submit()?.disabled).toBe(true);
    await setFieldValue(reason(), '   ');
    expect(submit()?.disabled).toBe(true);
    await setFieldValue(reason(), REASON);
    expect(submit()?.disabled).toBe(false);
    await setFieldValue(plan(), '');
    expect(submit()?.disabled).toBe(true);
    await setFieldValue(plan(), 'pro');
    expect(submit()?.disabled).toBe(false);

    // confirm で取り消すと呼ばない
    await submitForm(submit());
    expect(confirmMock).toHaveBeenCalledWith(GRANT_CONFIRM_MESSAGE);
    expect(GRANT_CONFIRM_MESSAGE).toBe('この利用者に有料プランを手動で付与します。利用者は課金なしでプランを使えるようになります。続けますか?');
    expect(mocks.grantManualPlanRequest).not.toHaveBeenCalled();
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(1);

    // OK で 1 回呼ぶ (日付が空なら expires_on は null)。送信中は押せず、2 回目を送らない
    confirmMock.mockReturnValue(true);
    let resolveGrant: (value: ManualGrantClientResult<ManualPlanGrantResult>) => void = () => undefined;
    mocks.grantManualPlanRequest.mockImplementationOnce(
      () =>
        new Promise<ManualGrantClientResult<ManualPlanGrantResult>>((resolve) => {
          resolveGrant = resolve;
        }),
    );
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(afterGrant));
    await act(async () => {
      submit()?.form?.requestSubmit(submit());
    });
    expect(submit()?.disabled).toBe(true);
    expect(submit()?.textContent).toBe('付与中…');
    await act(async () => {
      submit()?.form?.requestSubmit(submit());
    });
    expect(mocks.grantManualPlanRequest).toHaveBeenCalledTimes(1);
    expect(mocks.grantManualPlanRequest).toHaveBeenCalledWith(TARGET_USER_ID, { plan_key: 'pro', expires_on: null, reason: REASON });

    // 成功: 結果の文を出し、読み直して表示が現在の契約 (手動付与) に変わる
    await act(async () => {
      resolveGrant(ok(granted));
    });
    await flush();
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe(`pro を付与しました (有効期限: ${NO_EXPIRY_DISPLAY})`);
    expect(byTestId('manual-plan-grant-error')).toBeNull();
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(2);
    expect(byTestId('manual-plan-grant-current')).not.toBeNull();
    expect(byTestId('manual-plan-grant-submit')).toBeNull();
    expect(byTestId('manual-plan-revoke-submit')).not.toBeNull();
  });

  it('ManualPlanGrantSection: with a manual contract shows plan/由来 手動付与/有効期限 and the revoke form; confirm ok calls revokeManualPlanRequest once; failure shows manualGrantErrorMessage(code) (OP_INVALID_INPUT → MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE)', async () => {
    const manualView = viewOf({
      current: {
        subscription_id: SUBSCRIPTION_ID,
        plan_key: 'pro',
        status: 'active',
        source: 'manual',
        starts_at: '2026-10-17T00:00:00.000Z',
        expires_at: EXPIRES_AT_ISO,
      },
    });
    const revoked: ManualPlanRevokeResult = {
      subscription_id: SUBSCRIPTION_ID,
      user_id: TARGET_USER_ID,
      plan_key: 'pro',
      status_from: 'active',
      status_to: 'cancelled',
    };
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(manualView));
    const confirmMock = vi.fn(() => false);
    vi.stubGlobal('confirm', confirmMock);

    await renderSection();
    // 現在の契約: プラン・由来「手動付与」・有効期限 (JST の日時。日付に丸めない)
    const current = byTestId('manual-plan-grant-current');
    expect(Array.from(current?.querySelectorAll('dt') ?? []).map((n) => n.textContent)).toEqual(['プラン', '由来', '有効期限']);
    expect(Array.from(current?.querySelectorAll('dd') ?? []).map((n) => n.textContent)).toEqual(['pro', '手動付与', EXPIRES_AT_DISPLAY]);
    expect(MANUAL_PLAN_SOURCE_LABELS.manual).toBe('手動付与');
    // 付与のフォームは描かない・Stripe の注記も出さない
    expect(byTestId('manual-plan-grant-submit')).toBeNull();
    expect(byTestId('manual-plan-grant-stripe-note')).toBeNull();

    // 取り消しのフォーム: 理由が空白でない間だけ押せる
    const reason = () => byTestId<HTMLTextAreaElement>('manual-plan-revoke-reason');
    const submit = () => byTestId<HTMLButtonElement>('manual-plan-revoke-submit');
    expect(reason()?.maxLength).toBe(500);
    expect(submit()?.textContent).toBe('取り消す');
    expect(submit()?.disabled).toBe(true);
    await setFieldValue(reason(), '   ');
    expect(submit()?.disabled).toBe(true);
    await setFieldValue(reason(), REASON);
    expect(submit()?.disabled).toBe(false);

    // confirm で取り消すと呼ばない
    await submitForm(submit());
    expect(confirmMock).toHaveBeenCalledWith(REVOKE_CONFIRM_MESSAGE);
    expect(REVOKE_CONFIRM_MESSAGE).toBe('手動で付与したプランを取り消します。利用者はすぐに無料プランに戻ります。続けますか?');
    expect(mocks.revokeManualPlanRequest).not.toHaveBeenCalled();

    // OK で 1 回呼ぶ。成功は結果の文を出して読み直す (取り消し後は契約なし = 付与のフォームに戻る)
    confirmMock.mockReturnValue(true);
    mocks.revokeManualPlanRequest.mockResolvedValueOnce(ok(revoked));
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    await submitForm(submit());
    expect(mocks.revokeManualPlanRequest).toHaveBeenCalledTimes(1);
    expect(mocks.revokeManualPlanRequest).toHaveBeenCalledWith(TARGET_USER_ID, { reason: REASON });
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe('pro の付与を取り消しました');
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(2);
    expect(byTestId('manual-plan-grant-current')).toBeNull();
    expect(byTestId('manual-plan-grant-submit')).not.toBeNull();

    // 失敗は manualGrantErrorMessage(code) の文。応答の本文の文面は読まない (client は code だけを返す)。読み直さず、結果の文は消える
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(manualView));
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderSection();
    for (const [status, code, expected] of [
      [400, 'OP_INVALID_INPUT', MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE],
      [409, 'OP_NO_MANUAL_SUBSCRIPTION', manualGrantErrorMessage('OP_NO_MANUAL_SUBSCRIPTION')],
      [401, 'AUTH_UNAUTHENTICATED', 'ログインし直してください'],
      [500, 'SOMETHING_UNKNOWN', MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE],
    ] as const) {
      await setFieldValue(reason(), REASON);
      mocks.revokeManualPlanRequest.mockResolvedValueOnce(fail(status, code));
      const fetchCallsBefore = mocks.fetchManualPlanView.mock.calls.length;
      await submitForm(submit());
      expect(byTestId('manual-plan-grant-error')?.textContent, code).toBe(expected);
      expect(byTestId('manual-plan-grant-result'), code).toBeNull();
      // 失敗では読み直さず、入力した理由は残る
      expect(mocks.fetchManualPlanView.mock.calls.length, code).toBe(fetchCallsBefore);
      expect(reason()?.value, code).toBe(REASON);
    }
    expect(mocks.revokeManualPlanRequest).toHaveBeenCalledTimes(5);
    // 付与の失敗の表示も同じ文 (OP_INVALID_INPUT は画面用の文であって API の文面ではない)
    expect(MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE).toBe(manualGrantErrorMessage('OP_INVALID_INPUT'));
  });

  it('ManualPlanGrantSection: with a stripe contract shows the note and no form; history rows show label/plan/期限/reason', async () => {
    mocks.fetchManualPlanView.mockResolvedValueOnce(
      ok(
        viewOf({
          current: {
            subscription_id: SUBSCRIPTION_ID,
            plan_key: 'pro',
            status: 'active',
            source: 'stripe',
            starts_at: '2026-09-01T00:00:00.000Z',
            expires_at: EXPIRES_AT_ISO,
          },
          history: [
            {
              id: HISTORY_ID_EXPIRED,
              action_type: 'system.billing.manual_grant_expired',
              actor_id: null,
              created_at: '2026-10-10T15:00:00.000Z',
              plan_key: 'pro',
              expires_at: EXPIRES_AT_ISO,
              reason: null,
            },
            {
              id: HISTORY_ID_REVOKE,
              action_type: 'admin.billing.manual_revoke',
              actor_id: ACTOR_ID,
              created_at: '2026-10-05T03:00:00.000Z',
              plan_key: 'pro',
              expires_at: null,
              reason: '検証の終了',
            },
            {
              id: HISTORY_ID_GRANT,
              action_type: 'admin.billing.manual_grant',
              actor_id: ACTOR_ID,
              created_at: '2026-10-01T03:00:00.000Z',
              plan_key: 'pro',
              expires_at: EXPIRES_AT_ISO,
              reason: REASON,
            },
          ],
        }),
      ),
    );
    await renderSection();

    // Stripe の契約: 由来「Stripe」・「次回更新」・注記。フォームは 1 つも描かない
    const current = byTestId('manual-plan-grant-current');
    expect(Array.from(current?.querySelectorAll('dt') ?? []).map((n) => n.textContent)).toEqual(['プラン', '由来', '次回更新']);
    expect(Array.from(current?.querySelectorAll('dd') ?? []).map((n) => n.textContent)).toEqual(['pro', 'Stripe', EXPIRES_AT_DISPLAY]);
    expect(MANUAL_PLAN_SOURCE_LABELS.stripe).toBe('Stripe');
    expect(byTestId('manual-plan-grant-stripe-note')?.textContent).toBe(
      'Stripe の契約があるため、手動付与はできません (解約は利用者の操作か Stripe で行います)。',
    );
    expect(container.querySelector('form')).toBeNull();
    expect(byTestId('manual-plan-grant-submit')).toBeNull();
    expect(byTestId('manual-plan-revoke-submit')).toBeNull();

    // 履歴: 新しい順にそのまま。ラベル・プラン・期限 (あるときだけ)・理由 (あるときだけ)・日時
    const history = byTestId('manual-plan-grant-history');
    expect(history?.querySelector('h3')?.textContent).toBe('履歴 (直近 3 件)');
    const rows = Array.from(history?.querySelectorAll(':scope > div') ?? []);
    expect(rows).toHaveLength(3);
    expect(MANUAL_GRANT_HISTORY_LABELS).toEqual({
      'admin.billing.manual_grant': '付与',
      'admin.billing.manual_revoke': '取り消し',
      'system.billing.manual_grant_expired': '期限切れ',
    });
    const text = (row: Element) => row.textContent ?? '';
    expect(text(rows[0])).toContain('期限切れ');
    expect(text(rows[0])).toContain('pro');
    expect(text(rows[0])).toContain(`期限: ${EXPIRES_AT_DISPLAY}`);
    expect(text(rows[0])).toContain('2026/10/11 0:00:00');
    expect(text(rows[1])).toContain('取り消し');
    expect(text(rows[1])).toContain('検証の終了');
    expect(text(rows[1])).not.toContain('期限:');
    expect(text(rows[2])).toContain('付与');
    expect(text(rows[2])).toContain(REASON);
    expect(text(rows[2])).toContain(`期限: ${EXPIRES_AT_DISPLAY}`);
    expect(text(rows[2])).toContain('2026/10/1 12:00:00');
  });
});
