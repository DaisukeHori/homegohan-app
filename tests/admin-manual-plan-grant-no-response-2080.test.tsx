/**
 * #2080 U9: 運営の手動のプラン付与・取り消し (/admin/users/{id} の ManualPlanGrantSection) で、通信が切れたら今の契約を読み直す
 *
 * 以前の画面は、付与・取り消しの応答を受け取れない (fetch の reject・2xx なのに本文が形に合わない。manual-grant-client の
 * NO_RESPONSE_FAILURE) と、manualGrantErrorMessage の既定の文を出すだけで読み直さなかった。サーバーが付与を済ませてから
 * 応答が切れると、画面は付与のフォームのまま残り、もう一度押すと 409 OP_SUBSCRIPTION_ALREADY_ACTIVE「すでに有効な契約があります」になった
 * (#2073 で運営の画面に入れた読み直しと同じ型の取りこぼし)。
 *
 * 直したあとの不変条件:
 *   - 応答を受け取れなかったら、今の契約を読み直して見せ、「<付与|取り消し>の応答を受け取れませんでした（通信エラー）」に続けて
 *     読み直した旨を出す (付与が済んでいたときにも合う文。「すでに有効な契約があります」に頼らない)
 *   - 読み直した契約で操作が済んでいた (付与なら契約がある・取り消しなら手動付与の契約が無い) ときは、入力欄 (プラン・期限・理由) を空にする
 *     (付与の理由が取り消しの理由の欄に残らないように)。済んでいなければ入力欄を残す (押し直せるように)
 *   - 読み直しにも失敗したら、その旨と「再試行」を出し、読み直せるまで付与・取り消しのボタンを止める (押しても送らない)
 *   - 読み直しが 401 / 403 / 404 で断られたら (読み込み直しても変わらない)、その理由の文を出し、「再試行」は出さない
 *   - 応答を受け取れた失敗 (409 など) は今までどおり読み直さない
 *
 * @/lib/billing/manual-grant-client の通信の 3 関数だけを vi.fn にし、定数 (MANUAL_GRANT_CLIENT_NO_STATUS など) は本物を使う。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MANUAL_GRANT_CLIENT_NO_STATUS,
  MANUAL_GRANT_CLIENT_UNKNOWN_CODE,
  type ManualGrantClientResult,
} from '@/lib/billing/manual-grant-client';
import type { ManualPlanView } from '@/lib/billing/manual-grant';

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

const { ManualPlanGrantSection } = await import('@/components/admin/ManualPlanGrantSection');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET_USER_ID = '20802080-2080-4080-8080-208020802081';
const SUBSCRIPTION_ID = '20802080-2080-4080-8080-208020802082';
const REASON = '社内検証のため付与する';
const REVOKE_REASON = '検証の終了';
const EXPIRES_ON = '2026-12-31';

/** 読み直せたときに続く文 */
const STATE_RELOADED_GUIDE = '今の状態を読み込み直したので、状態を確かめてから、必要ならもう一度操作してください';
/** 読み直しにも失敗したときに続く文 */
const STATE_RELOAD_FAILED_GUIDE = '今の状態を読み込めませんでした。「再試行」で読み込み直してから、もう一度操作してください';
/** 押し直したときに以前出ていた文 (自分の付与なのに出る) */
const ALREADY_ACTIVE_MESSAGE = 'すでに有効な契約があります';

const PLANS: ManualPlanView['plans'] = [{ plan_key: 'pro', display_name: 'プロ', plan_type: 'personal', max_members: null }];

function viewOf(overrides: Partial<ManualPlanView> = {}): ManualPlanView {
  return { current: null, plans: PLANS, history: [], ...overrides };
}

const MANUAL_VIEW = viewOf({
  current: {
    subscription_id: SUBSCRIPTION_ID,
    plan_key: 'pro',
    status: 'active',
    source: 'manual',
    starts_at: '2026-10-29T00:00:00.000Z',
    expires_at: null,
  },
});

function ok<T>(data: T): ManualGrantClientResult<T> {
  return { ok: true, data };
}
function fail(status: number, code: string): ManualGrantClientResult<never> {
  return { ok: false, status, code };
}
/** 応答を受け取れなかった (manual-grant-client の NO_RESPONSE_FAILURE と同じ形) */
const noResponse = (): ManualGrantClientResult<never> => fail(MANUAL_GRANT_CLIENT_NO_STATUS, MANUAL_GRANT_CLIENT_UNKNOWN_CODE);

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

/** ボタンの disabled を外してでもフォームを送る (handler の守りを確かめる) */
async function submitForm(button: HTMLButtonElement | null, options: { force?: boolean } = {}) {
  expect(button).not.toBeNull();
  await act(async () => {
    if (options.force && button) button.disabled = false;
    button?.form?.requestSubmit(button);
  });
  await flush();
}

const errorText = () => byTestId('manual-plan-grant-error')?.textContent ?? null;
const retryButton = () => byTestId<HTMLButtonElement>('manual-plan-grant-retry');
const grantSubmit = () => byTestId<HTMLButtonElement>('manual-plan-grant-submit');
const revokeSubmit = () => byTestId<HTMLButtonElement>('manual-plan-revoke-submit');

async function fillGrantForm() {
  await setFieldValue(byTestId<HTMLSelectElement>('manual-plan-grant-plan'), 'pro');
  await setFieldValue(byTestId<HTMLInputElement>('manual-plan-grant-expires-on'), EXPIRES_ON);
  await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason'), REASON);
}

beforeEach(() => {
  for (const fn of [mocks.fetchManualPlanView, mocks.grantManualPlanRequest, mocks.revokeManualPlanRequest]) fn.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ManualPlanGrantSection: 付与・取り消しの応答を受け取れなかったら今の契約を読み直す (#2080 U9)', () => {
  it('サーバーが付与を済ませてから応答が切れたら、読み直して手動付与の契約を見せ、付与の入力を空にし、自分の付与でも合う文を出す', async () => {
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    await renderSection();
    await fillGrantForm();
    mocks.grantManualPlanRequest.mockResolvedValueOnce(noResponse());
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(MANUAL_VIEW));

    await submitForm(grantSubmit());

    expect(mocks.grantManualPlanRequest).toHaveBeenCalledTimes(1);
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(2);
    expect(byTestId('manual-plan-grant-current')).not.toBeNull();
    expect(grantSubmit()).toBeNull();
    expect(errorText()).toBe(`付与の応答を受け取れませんでした（通信エラー）。${STATE_RELOADED_GUIDE}`);
    expect(errorText()).not.toContain(ALREADY_ACTIVE_MESSAGE);
    expect(retryButton()).toBeNull();
    // 付与の理由を取り消しの理由の欄に持ち越さない (押せば取り消しになる欄に、付与の理由が入ったままにしない)
    expect(byTestId<HTMLTextAreaElement>('manual-plan-revoke-reason')?.value).toBe('');
    expect(revokeSubmit()?.disabled).toBe(true);
  });

  it('応答が切れて読み直したら付与が済んでいなかった (契約なし) ときは、付与のフォームと入力を残し、押し直せる', async () => {
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    await renderSection();
    await fillGrantForm();
    mocks.grantManualPlanRequest.mockResolvedValueOnce(noResponse());
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));

    await submitForm(grantSubmit());

    expect(errorText()).toBe(`付与の応答を受け取れませんでした（通信エラー）。${STATE_RELOADED_GUIDE}`);
    expect(byTestId<HTMLSelectElement>('manual-plan-grant-plan')?.value).toBe('pro');
    expect(byTestId<HTMLInputElement>('manual-plan-grant-expires-on')?.value).toBe(EXPIRES_ON);
    expect(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason')?.value).toBe(REASON);
    expect(grantSubmit()?.disabled).toBe(false);
  });

  it('読み直しにも失敗したら「再試行」を出し、付与のボタンを止める (押しても送らない)。「再試行」で読み直せたら今の契約を見せる', async () => {
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    await renderSection();
    await fillGrantForm();
    mocks.grantManualPlanRequest.mockResolvedValueOnce(noResponse());
    mocks.fetchManualPlanView.mockResolvedValueOnce(noResponse());

    await submitForm(grantSubmit());

    expect(errorText()).toBe(`付与の応答を受け取れませんでした（通信エラー）。${STATE_RELOAD_FAILED_GUIDE}`);
    expect(retryButton()?.textContent).toBe('再試行');
    expect(grantSubmit()?.disabled).toBe(true);
    await submitForm(grantSubmit(), { force: true });
    expect(mocks.grantManualPlanRequest).toHaveBeenCalledTimes(1);

    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(MANUAL_VIEW));
    await act(async () => {
      retryButton()?.click();
    });
    await flush();

    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(3);
    expect(byTestId('manual-plan-grant-current')).not.toBeNull();
    expect(errorText()).toBe(`付与の応答を受け取れませんでした（通信エラー）。${STATE_RELOADED_GUIDE}`);
    expect(retryButton()).toBeNull();
    expect(byTestId<HTMLTextAreaElement>('manual-plan-revoke-reason')?.value).toBe('');
  });

  it('読み直しが 403 で断られたら、その理由の文を出し、「再試行」は出さない', async () => {
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    await renderSection();
    await fillGrantForm();
    mocks.grantManualPlanRequest.mockResolvedValueOnce(noResponse());
    mocks.fetchManualPlanView.mockResolvedValueOnce(fail(403, 'OP_PERMISSION_DENIED'));

    await submitForm(grantSubmit());

    expect(errorText()).toBe('付与の応答を受け取れませんでした（通信エラー）。権限がありません');
    expect(retryButton()).toBeNull();
    expect(errorText()).not.toContain('OP_PERMISSION_DENIED');
  });

  it('サーバーが取り消しを済ませてから応答が切れたら、読み直して契約なしにし、取り消しの理由を付与の理由の欄に持ち越さない', async () => {
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(MANUAL_VIEW));
    await renderSection();
    await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-revoke-reason'), REVOKE_REASON);
    mocks.revokeManualPlanRequest.mockResolvedValueOnce(noResponse());
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));

    await submitForm(revokeSubmit());

    expect(mocks.revokeManualPlanRequest).toHaveBeenCalledTimes(1);
    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(2);
    expect(byTestId('manual-plan-grant-current')).toBeNull();
    expect(revokeSubmit()).toBeNull();
    expect(errorText()).toBe(`取り消しの応答を受け取れませんでした（通信エラー）。${STATE_RELOADED_GUIDE}`);
    expect(byTestId<HTMLTextAreaElement>('manual-plan-grant-reason')?.value).toBe('');
  });

  it('取り消しの応答が切れて読み直しにも失敗したら、取り消しのボタンを止めて「再試行」を出す', async () => {
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(MANUAL_VIEW));
    await renderSection();
    await setFieldValue(byTestId<HTMLTextAreaElement>('manual-plan-revoke-reason'), REVOKE_REASON);
    mocks.revokeManualPlanRequest.mockResolvedValueOnce(noResponse());
    mocks.fetchManualPlanView.mockResolvedValueOnce(fail(500, 'INTERNAL_ERROR'));

    await submitForm(revokeSubmit());

    expect(errorText()).toBe(`取り消しの応答を受け取れませんでした（通信エラー）。${STATE_RELOAD_FAILED_GUIDE}`);
    expect(revokeSubmit()?.disabled).toBe(true);
    await submitForm(revokeSubmit(), { force: true });
    expect(mocks.revokeManualPlanRequest).toHaveBeenCalledTimes(1);
    expect(retryButton()).not.toBeNull();
  });

  it('応答を受け取れた失敗 (409) は今までどおり読み直さず、その文を出す', async () => {
    mocks.fetchManualPlanView.mockResolvedValueOnce(ok(viewOf()));
    await renderSection();
    await fillGrantForm();
    mocks.grantManualPlanRequest.mockResolvedValueOnce(fail(409, 'OP_SUBSCRIPTION_ALREADY_ACTIVE'));

    await submitForm(grantSubmit());

    expect(mocks.fetchManualPlanView).toHaveBeenCalledTimes(1);
    expect(errorText()).toBe(ALREADY_ACTIVE_MESSAGE);
    expect(retryButton()).toBeNull();
  });
});

