/**
 * #1797 手動のプラン付与 段 C: 画面の節 ManualPlanGrantSection のブラウザの動き (billing/02 §8.6・§10・テスト 35〜37)
 * テスト 35〜37 の後ろの 3 本は、§10 の「有効期限 (任意)」のセル・付与の失敗・読み込みの失敗の行を画面を通して見る追加の it
 * (期限つきの付与が無期限で送られる・失敗の文が出ない・成功後の入力が残る、の変異を落とすため)。
 * 送信の状態の守り (送信中は押せない・二重送信を送らない・送信の開始で前の結果の文と失敗の文を消す) は付与と取り消しの両方で見る
 * (付与は最初の it と「付与の失敗」の it、取り消しは 2 本目の it)。
 *
 * @/lib/billing/manual-grant-client の通信の 3 関数だけを vi.fn にし、manualGrantErrorMessage・定数は本物を使う。
 * tests/mfa-pages-browser.test.tsx の OperatorMfaResetSection の it と同じく react-dom/client + act。
 *
 * プラン (今の契約・履歴・成功の文) は plan_key ではなく運営の画面の表示名 (adminPlanKeyLabel。pro → 「個人 Pro」・family_pro → 「家族 Pro」)
 * で出る (#2112 Z3)。公式の 9 種に無い plan_key (family_plus) は表示名が無いので plan_key のまま出る。
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

/** pro・family_pro の運営の画面の表示名 (src/lib/admin/plan-key-labels.ts の ADMIN_PLAN_KEY_LABELS。#2112 Z3) */
const PRO_LABEL = '個人 Pro';
const FAMILY_PRO_LABEL = '家族 Pro';

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
const REVOKE_REASON = '検証の終了';
/** 付与のフォームの有効期限の欄に入れる日付 (その日の終わり = EXPIRES_AT_ISO) */
const EXPIRES_ON = '2026-12-31';
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
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe(`${PRO_LABEL} を付与しました (有効期限: ${NO_EXPIRY_DISPLAY})`);
    expect(byTestId('manual-plan-grant-error')).toBeNull();
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(2);
    expect(byTestId('manual-plan-grant-current')).not.toBeNull();
    expect(byTestId('manual-plan-grant-submit')).toBeNull();
    expect(byTestId('manual-plan-revoke-submit')).not.toBeNull();
    // 理由の state は付与と取り消しのフォームで共有しているので、付与の成功で空に戻す (付与の理由を取り消しの理由に持ち越さない)
    expect(byTestId<HTMLTextAreaElement>('manual-plan-revoke-reason')?.value).toBe('');
    expect(byTestId('manual-plan-revoke-submit')?.hasAttribute('disabled')).toBe(true);
  });

  it('ManualPlanGrantSection: with a manual contract shows plan/由来 手動付与/有効期限 and the revoke form; confirm ok calls revokeManualPlanRequest once; failure shows manualGrantErrorMessage(code) (OP_INVALID_INPUT → MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE), clears the previous result and keeps the reason; while revoking the button is disabled and a second submit is ignored; the next successful revoke clears the error', async () => {
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
    expect(Array.from(current?.querySelectorAll('dd') ?? []).map((n) => n.textContent)).toEqual([PRO_LABEL, '手動付与', EXPIRES_AT_DISPLAY]);
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
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe(`${PRO_LABEL} の付与を取り消しました`);
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(2);
    expect(byTestId('manual-plan-grant-current')).toBeNull();
    expect(byTestId('manual-plan-grant-submit')).not.toBeNull();
    // 取り消しの成功で理由を空に戻す (取り消しの理由を付与の理由に持ち越さない)。プラン・期限も空
    expect(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason')?.value).toBe('');
    expect(byTestId<HTMLSelectElement>('manual-plan-grant-plan')?.value).toBe('');
    expect(byTestId<HTMLInputElement>('manual-plan-grant-expires-on')?.value).toBe('');
    expect(byTestId<HTMLButtonElement>('manual-plan-grant-submit')?.disabled).toBe(true);

    // 付与を成功させて、結果の文 (付与しました) が出ている取り消しのフォームにする。
    // 再マウントすると結果の文が最初から無く、取り消しの送信が前の結果の文を消すか (handleRevoke の setMessage(null)) を見られないため、画面の操作でこの状態を作る
    const grantedAgain: ManualPlanGrantResult = {
      subscription_id: SUBSCRIPTION_ID,
      user_id: TARGET_USER_ID,
      plan_key: 'pro',
      status: 'active',
      expires_at: EXPIRES_AT_ISO,
    };
    await setFieldValue(byTestId<HTMLSelectElement>('manual-plan-grant-plan'), 'pro');
    await setFieldValue(byTestId<HTMLInputElement>('manual-plan-grant-expires-on'), EXPIRES_ON);
    await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason'), REASON);
    mocks.grantManualPlanRequest.mockResolvedValueOnce(ok(grantedAgain));
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(manualView));
    await submitForm(byTestId<HTMLButtonElement>('manual-plan-grant-submit'));
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(3);
    expect(submit()).not.toBeNull();
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe(`${PRO_LABEL} を付与しました (有効期限: ${EXPIRES_AT_DISPLAY})`);
    expect(byTestId('manual-plan-grant-error')).toBeNull();

    // 失敗は manualGrantErrorMessage(code) の文。応答の本文の文面は読まない (client は code だけを返す)。
    // 読み直さず、前の結果の文 (1 回目は上の「付与しました」) は消えてエラーの文だけが出る
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
      // 失敗では読み直さず、入力した理由は残り、もう一度押せる
      expect(mocks.fetchManualPlanView.mock.calls.length, code).toBe(fetchCallsBefore);
      expect(reason()?.value, code).toBe(REASON);
      expect(submit()?.disabled, code).toBe(false);
      expect(submit()?.textContent, code).toBe('取り消す');
    }
    expect(mocks.revokeManualPlanRequest).toHaveBeenCalledTimes(5);
    // OP_INVALID_INPUT は画面用の文であって API の文面ではない (付与の失敗の表示は下の「付与の失敗」の it が画面を通して見る)
    expect(MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE).toBe(manualGrantErrorMessage('OP_INVALID_INPUT'));

    // 失敗の文が出ている状態から取り消しを送る: 送信を始めた時点で前の失敗の文を消し、送信中は押せず (取り消し中…)、2 回目を送らない
    let resolveRevoke: (value: ManualGrantClientResult<ManualPlanRevokeResult>) => void = () => undefined;
    mocks.revokeManualPlanRequest.mockImplementationOnce(
      () =>
        new Promise<ManualGrantClientResult<ManualPlanRevokeResult>>((resolve) => {
          resolveRevoke = resolve;
        }),
    );
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    expect(byTestId('manual-plan-grant-error')?.textContent).toBe(MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE);
    await act(async () => {
      submit()?.form?.requestSubmit(submit());
    });
    expect(submit()?.disabled).toBe(true);
    expect(submit()?.textContent).toBe('取り消し中…');
    expect(byTestId('manual-plan-grant-error')).toBeNull();
    expect(byTestId('manual-plan-grant-result')).toBeNull();
    await act(async () => {
      submit()?.form?.requestSubmit(submit());
    });
    expect(mocks.revokeManualPlanRequest).toHaveBeenCalledTimes(6);
    expect(mocks.revokeManualPlanRequest).toHaveBeenLastCalledWith(TARGET_USER_ID, { reason: REASON });

    // 成功: 失敗の文は消えたまま結果の文を出し、読み直して付与のフォームに戻る
    await act(async () => {
      resolveRevoke(ok(revoked));
    });
    await flush();
    expect(byTestId('manual-plan-grant-error')).toBeNull();
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe(`${PRO_LABEL} の付与を取り消しました`);
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(4);
    expect(byTestId('manual-plan-grant-current')).toBeNull();
    expect(byTestId('manual-plan-revoke-submit')).toBeNull();
    expect(byTestId('manual-plan-grant-submit')).not.toBeNull();
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
    expect(Array.from(current?.querySelectorAll('dd') ?? []).map((n) => n.textContent)).toEqual([PRO_LABEL, 'Stripe', EXPIRES_AT_DISPLAY]);
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
    expect(text(rows[0])).toContain(PRO_LABEL);
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

  it('ManualPlanGrantSection: with a store contract (billing/03 §8.6) shows 由来 ストア, the store note and no grant / revoke form', async () => {
    mocks.fetchManualPlanView.mockResolvedValueOnce(
      ok(
        viewOf({
          current: {
            subscription_id: SUBSCRIPTION_ID,
            plan_key: 'family_pro',
            status: 'trialing',
            source: 'store',
            starts_at: '2026-10-01T00:00:00.000Z',
            expires_at: EXPIRES_AT_ISO,
          },
        }),
      ),
    );
    await renderSection();

    const current = byTestId('manual-plan-grant-current');
    expect(Array.from(current?.querySelectorAll('dt') ?? []).map((n) => n.textContent)).toEqual(['プラン', '由来', '次回更新']);
    expect(Array.from(current?.querySelectorAll('dd') ?? []).map((n) => n.textContent)).toEqual([FAMILY_PRO_LABEL, 'ストア (アプリ内課金)', EXPIRES_AT_DISPLAY]);
    expect(MANUAL_PLAN_SOURCE_LABELS.store).toBe('ストア (アプリ内課金)');
    expect(byTestId('manual-plan-grant-store-note')?.textContent).toBe(
      'ストアの契約があります。手動付与はできません (解約は利用者が App Store・Google Play の定期購読の管理で行います)。',
    );
    expect(byTestId('manual-plan-grant-stripe-note')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(byTestId('manual-plan-grant-submit')).toBeNull();
    expect(byTestId('manual-plan-revoke-submit')).toBeNull();
  });

  it('ManualPlanGrantSection: a grant with an expiry date sends expires_on as the date and shows the JST end time; after grant then revoke the grant form comes back with plan/expiry/reason all empty', async () => {
    const grantedWithExpiry: ManualPlanGrantResult = {
      subscription_id: SUBSCRIPTION_ID,
      user_id: TARGET_USER_ID,
      plan_key: 'family_plus',
      status: 'active',
      expires_at: EXPIRES_AT_ISO,
    };
    const manualWithExpiry = viewOf({
      current: {
        subscription_id: SUBSCRIPTION_ID,
        plan_key: 'family_plus',
        status: 'active',
        source: 'manual',
        starts_at: '2026-10-17T00:00:00.000Z',
        expires_at: EXPIRES_AT_ISO,
      },
    });
    const revoked: ManualPlanRevokeResult = {
      subscription_id: SUBSCRIPTION_ID,
      user_id: TARGET_USER_ID,
      plan_key: 'family_plus',
      status_from: 'active',
      status_to: 'cancelled',
    };
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    vi.stubGlobal('confirm', vi.fn(() => true));
    await renderSection();

    // 期限を入れて付与する: expires_on は入れた日付そのもの (null にしない)
    await setFieldValue(byTestId<HTMLSelectElement>('manual-plan-grant-plan'), 'family_plus');
    await setFieldValue(byTestId<HTMLInputElement>('manual-plan-grant-expires-on'), EXPIRES_ON);
    await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason'), REASON);
    mocks.grantManualPlanRequest.mockResolvedValueOnce(ok(grantedWithExpiry));
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(manualWithExpiry));
    await submitForm(byTestId<HTMLButtonElement>('manual-plan-grant-submit'));
    expect(mocks.grantManualPlanRequest).toHaveBeenCalledTimes(1);
    expect(mocks.grantManualPlanRequest).toHaveBeenCalledWith(TARGET_USER_ID, { plan_key: 'family_plus', expires_on: EXPIRES_ON, reason: REASON });
    // 成功の文の期限は応答の expires_at を JST の日時で出す (日付に丸めない)
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe(`family_plus を付与しました (有効期限: ${EXPIRES_AT_DISPLAY})`);
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(2);
    expect(Array.from(byTestId('manual-plan-grant-current')?.querySelectorAll('dd') ?? []).map((n) => n.textContent)).toEqual([
      'family_plus',
      '手動付与',
      EXPIRES_AT_DISPLAY,
    ]);
    expect(byTestId<HTMLTextAreaElement>('manual-plan-revoke-reason')?.value).toBe('');

    // 取り消して契約なしに戻すと、付与のフォームは前の付与の入力 (プラン・期限・理由) を持ち越さない
    await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-revoke-reason'), REVOKE_REASON);
    mocks.revokeManualPlanRequest.mockResolvedValueOnce(ok(revoked));
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    await submitForm(byTestId<HTMLButtonElement>('manual-plan-revoke-submit'));
    expect(mocks.revokeManualPlanRequest).toHaveBeenCalledWith(TARGET_USER_ID, { reason: REVOKE_REASON });
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe('family_plus の付与を取り消しました');
    expect(byTestId<HTMLSelectElement>('manual-plan-grant-plan')?.value).toBe('');
    expect(byTestId<HTMLInputElement>('manual-plan-grant-expires-on')?.value).toBe('');
    expect(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason')?.value).toBe('');
    expect(byTestId<HTMLButtonElement>('manual-plan-grant-submit')?.disabled).toBe(true);
  });

  it('ManualPlanGrantSection: a failed grant shows manualGrantErrorMessage(code), clears the previous result, does not reload and keeps plan/expiry/reason; the next successful grant clears the error', async () => {
    const manualView = viewOf({
      current: {
        subscription_id: SUBSCRIPTION_ID,
        plan_key: 'pro',
        status: 'active',
        source: 'manual',
        starts_at: '2026-10-17T00:00:00.000Z',
        expires_at: null,
      },
    });
    const revoked: ManualPlanRevokeResult = {
      subscription_id: SUBSCRIPTION_ID,
      user_id: TARGET_USER_ID,
      plan_key: 'pro',
      status_from: 'active',
      status_to: 'cancelled',
    };
    const granted: ManualPlanGrantResult = {
      subscription_id: SUBSCRIPTION_ID,
      user_id: TARGET_USER_ID,
      plan_key: 'pro',
      status: 'active',
      expires_at: EXPIRES_AT_ISO,
    };
    const afterGrant = viewOf({
      current: {
        subscription_id: SUBSCRIPTION_ID,
        plan_key: 'pro',
        status: 'active',
        source: 'manual',
        starts_at: '2026-10-17T00:00:00.000Z',
        expires_at: EXPIRES_AT_ISO,
      },
    });
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(manualView));
    vi.stubGlobal('confirm', vi.fn(() => true));
    await renderSection();

    // 先に取り消しを成功させ、結果の文が出ている付与のフォームにする (付与の送信が前の結果の文を消すことを見るため)
    await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-revoke-reason'), REVOKE_REASON);
    mocks.revokeManualPlanRequest.mockResolvedValueOnce(ok(revoked));
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    await submitForm(byTestId<HTMLButtonElement>('manual-plan-revoke-submit'));
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe(`${PRO_LABEL} の付与を取り消しました`);

    const plan = () => byTestId<HTMLSelectElement>('manual-plan-grant-plan');
    const expiresOn = () => byTestId<HTMLInputElement>('manual-plan-grant-expires-on');
    const reason = () => byTestId<HTMLTextAreaElement>('manual-plan-grant-reason');
    const submit = () => byTestId<HTMLButtonElement>('manual-plan-grant-submit');
    await setFieldValue(plan(), 'pro');
    await setFieldValue(expiresOn(), EXPIRES_ON);
    await setFieldValue(reason(), REASON);
    for (const [status, code, expected] of [
      [409, 'OP_SUBSCRIPTION_ALREADY_ACTIVE', 'すでに有効な契約があります'],
      [422, 'OP_PLAN_NOT_GRANTABLE', 'このプランは手動で付与できません'],
      [400, 'OP_INVALID_INPUT', MANUAL_GRANT_CLIENT_INVALID_INPUT_MESSAGE],
      [404, 'NOT_FOUND', 'ユーザーが見つかりません'],
      [500, 'SOMETHING_UNKNOWN', MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE],
    ] as const) {
      mocks.grantManualPlanRequest.mockResolvedValueOnce(fail(status, code));
      const fetchCallsBefore = mocks.fetchManualPlanView.mock.calls.length;
      await submitForm(submit());
      expect(mocks.grantManualPlanRequest, code).toHaveBeenLastCalledWith(TARGET_USER_ID, { plan_key: 'pro', expires_on: EXPIRES_ON, reason: REASON });
      expect(byTestId('manual-plan-grant-error')?.textContent, code).toBe(expected);
      expect(byTestId('manual-plan-grant-result'), code).toBeNull();
      // 失敗では読み直さず、入力は残り、もう一度押せる
      expect(mocks.fetchManualPlanView.mock.calls.length, code).toBe(fetchCallsBefore);
      expect(plan()?.value, code).toBe('pro');
      expect(expiresOn()?.value, code).toBe(EXPIRES_ON);
      expect(reason()?.value, code).toBe(REASON);
      expect(submit()?.disabled, code).toBe(false);
      expect(submit()?.textContent, code).toBe('付与する');
    }
    expect(mocks.grantManualPlanRequest).toHaveBeenCalledTimes(5);

    // 次の送信が成功すると、前の失敗の文は消える
    mocks.grantManualPlanRequest.mockResolvedValueOnce(ok(granted));
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(afterGrant));
    await submitForm(submit());
    expect(byTestId('manual-plan-grant-error')).toBeNull();
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe(`${PRO_LABEL} を付与しました (有効期限: ${EXPIRES_AT_DISPLAY})`);
  });

  it('ManualPlanGrantSection: a failed load shows manualGrantErrorMessage(code) and no form/current/history; a failed reload after a grant keeps the result and the next successful reload clears the load error', async () => {
    // 開いたときの読み込みの失敗: 文だけを出し、フォーム・現在の契約・履歴は描かない
    for (const [status, code, expected] of [
      [500, 'SOMETHING_UNKNOWN', MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE],
      [401, 'AUTH_UNAUTHENTICATED', 'ログインし直してください'],
      [403, 'OP_SELF_MODIFY', '自分自身のプランは、ここでは変更できません'],
    ] as const) {
      mocks.fetchManualPlanView.mockResolvedValueOnce(fail(status, code));
      await act(async () => {
        root.unmount();
      });
      root = createRoot(container);
      await renderSection();
      const loadError = byTestId('manual-plan-grant-load-error');
      expect(loadError?.textContent, code).toBe(expected);
      expect(loadError?.getAttribute('role'), code).toBe('alert');
      expect(container.querySelector('form'), code).toBeNull();
      expect(byTestId('manual-plan-grant-current'), code).toBeNull();
      expect(byTestId('manual-plan-grant-history'), code).toBeNull();
      expect(byTestId('manual-plan-grant-stripe-note'), code).toBeNull();
    }
    expect(MANUAL_GRANT_CLIENT_FALLBACK_MESSAGE).toBe(manualGrantErrorMessage('SOMETHING_UNKNOWN'));
    expect(mocks.grantManualPlanRequest).not.toHaveBeenCalled();
    expect(mocks.revokeManualPlanRequest).not.toHaveBeenCalled();

    // 付与の後の読み直しが失敗: 結果の文は残り、読み込みの失敗の文を足す。次に読み直しが成功すると読み込みの失敗の文は消える
    mocks.fetchManualPlanView.mockReset();
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await renderSection();
    expect(byTestId('manual-plan-grant-load-error')).toBeNull();
    vi.stubGlobal('confirm', vi.fn(() => true));
    const granted: ManualPlanGrantResult = {
      subscription_id: SUBSCRIPTION_ID,
      user_id: TARGET_USER_ID,
      plan_key: 'pro',
      status: 'active',
      expires_at: null,
    };
    await setFieldValue(byTestId<HTMLSelectElement>('manual-plan-grant-plan'), 'pro');
    await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason'), REASON);
    mocks.grantManualPlanRequest.mockResolvedValueOnce(ok(granted));
    mocks.fetchManualPlanView.mockResolvedValueOnce(fail(500, 'INTERNAL_ERROR'));
    await submitForm(byTestId<HTMLButtonElement>('manual-plan-grant-submit'));
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(2);
    expect(byTestId('manual-plan-grant-load-error')?.textContent).toBe('処理中にエラーが発生しました。しばらくしてからお試しください');
    expect(byTestId('manual-plan-grant-result')?.textContent).toBe(`${PRO_LABEL} を付与しました (有効期限: ${NO_EXPIRY_DISPLAY})`);

    // 読み直しに失敗した間は前の表示 (契約なし) のまま。もう一度送って読み直しが成功すると、読み込みの失敗の文は消える
    await setFieldValue(byTestId<HTMLSelectElement>('manual-plan-grant-plan'), 'pro');
    await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason'), REASON);
    mocks.grantManualPlanRequest.mockResolvedValueOnce(ok(granted));
    mocks.fetchManualPlanView.mockResolvedValueOnce(
      ok(
        viewOf({
          current: {
            subscription_id: SUBSCRIPTION_ID,
            plan_key: 'pro',
            status: 'active',
            source: 'manual',
            starts_at: '2026-10-17T00:00:00.000Z',
            expires_at: null,
          },
        }),
      ),
    );
    await submitForm(byTestId<HTMLButtonElement>('manual-plan-grant-submit'));
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(3);
    expect(byTestId('manual-plan-grant-load-error')).toBeNull();
    expect(byTestId('manual-plan-grant-current')).not.toBeNull();
  });
});
