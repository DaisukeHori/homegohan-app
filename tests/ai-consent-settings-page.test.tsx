/**
 * T15 (#1154) 設定ページ「AI へのデータ提供の同意」(/settings/ai-consent) の component テスト
 *
 * 確認すること:
 *   - 同意済み / 未同意 / 撤回済み / 古い版 (再確認が必要) の状況が、事業者ごとに分かる形で出る
 *   - 未同意なら「同意する」、有効な同意があれば「同意を撤回する」が出る。撤回は確認ダイアログを通る
 *   - 撤回の説明は「撤回すると AI 機能は使えなくなる」と書く (未同意なら、サーバーが AI へ送らずに止める)
 *   - 読み込み・同意・撤回に失敗したときは、メッセージを出して、もう一度試せる
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConsentStatus } from '@/lib/ai/consent-config';

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('@/lib/ai/consent-client', () => ({
  fetchAiConsentStatus: mocks.fetchStatus,
  postAiConsentGrant: mocks.grant,
  postAiConsentRevoke: mocks.revoke,
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

const { default: AiConsentSettingsPage } = await import('@/app/(main)/settings/ai-consent/page');
const { AI_CONSENT_COPY, AI_CONSENT_PROVIDERS, AI_CONSENT_VERSION } = await import('@/lib/ai/consent-config');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ProviderState = AiConsentStatus['providers'][number]['state'];

function status(overrides: Partial<AiConsentStatus> & { states?: ProviderState[] } = {}): AiConsentStatus {
  const states = overrides.states ?? AI_CONSENT_PROVIDERS.map(() => 'none' as const);
  const consented = states.every((s) => s === 'granted');
  return {
    version: AI_CONSENT_VERSION,
    consented,
    providers: AI_CONSENT_PROVIDERS.map((provider, i) => ({
      provider,
      state: states[i],
      consentedAt: states[i] === 'none' ? null : '2026-10-08T08:30:00.000Z',
      policyVersion: states[i] === 'granted' ? AI_CONSENT_VERSION : states[i] === 'outdated' ? 'old' : null,
      revokedAt: null,
    })),
    consentedAt: consented ? '2026-10-08T08:30:00.000Z' : null,
    revokedAt: null,
    ...overrides,
  };
}

const granted = () => status({ states: AI_CONSENT_PROVIDERS.map(() => 'granted' as const) });

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPage() {
  await act(async () => {
    root.render(createElement(AiConsentSettingsPage as never));
  });
  await flush();
}

const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const bodyText = () => document.body.textContent ?? '';
const buttonByText = (label: string) =>
  Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
/**
 * 確認ダイアログの中のボタンを、表示の文字が完全に一致するもので探す。
 * ページ本体にも「同意を撤回する」ボタンがあるため、buttonByText('撤回する') (部分一致) だと本体のボタンを押してしまう
 */
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchStatus.mockReset();
  mocks.grant.mockReset();
  mocks.revoke.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.style.overflow = '';
});

describe('/settings/ai-consent: 状況の表示', () => {
  it('同意済み: 「同意済みです」と同意した日時 (日本時間)、事業者ごとの「同意済み」、撤回ボタンが出る。同意ボタンは出ない', async () => {
    mocks.fetchStatus.mockResolvedValue(granted());
    await renderPage();

    expect(byTestId('ai-consent-overall')?.textContent).toBe('同意済みです');
    expect(bodyText()).toContain('2026年10月8日 17:30');
    for (const provider of AI_CONSENT_PROVIDERS) {
      expect(byTestId(`ai-consent-status-${provider}`)?.textContent).toContain('同意済み');
    }
    expect(byTestId('ai-consent-revoke')).not.toBeNull();
    expect(byTestId('ai-consent-grant')).toBeNull();
  });

  it('未同意: 「まだ同意していません」と「同意する」が出る。撤回ボタンは出ない', async () => {
    mocks.fetchStatus.mockResolvedValue(status());
    await renderPage();

    expect(byTestId('ai-consent-overall')?.textContent).toBe('まだ同意していません');
    expect(byTestId('ai-consent-grant')?.textContent).toContain(AI_CONSENT_COPY.acceptLabel);
    expect(byTestId('ai-consent-revoke')).toBeNull();
    for (const provider of AI_CONSENT_PROVIDERS) {
      expect(byTestId(`ai-consent-status-${provider}`)?.textContent).toContain('未同意');
    }
  });

  it('撤回済み: 撤回した日時が出る', async () => {
    mocks.fetchStatus.mockResolvedValue(status({ revokedAt: '2026-10-09T01:05:00.000Z' }));
    await renderPage();

    expect(byTestId('ai-consent-overall')?.textContent).toBe('まだ同意していません');
    expect(bodyText()).toContain('2026年10月9日 10:05 に同意を撤回しました');
    expect(bodyText()).toContain('同意するまで、AI 機能はお使いいただけません。');
  });

  it('古い版への同意: 「もう一度ご確認ください」と、同意・撤回の両方のボタンが出る', async () => {
    mocks.fetchStatus.mockResolvedValue(status({ states: AI_CONSENT_PROVIDERS.map(() => 'outdated' as const) }));
    await renderPage();

    expect(byTestId('ai-consent-overall')?.textContent).toBe('もう一度ご確認ください');
    expect(bodyText()).toContain('同意の文面が更新されました');
    expect(byTestId('ai-consent-status-xai')?.textContent).toContain('再確認が必要');
    expect(byTestId('ai-consent-grant')).not.toBeNull();
    expect(byTestId('ai-consent-revoke')).not.toBeNull();
  });

  it('提供先・提供する情報・利用目的・事業者での保存の説明も同じページに出る', async () => {
    mocks.fetchStatus.mockResolvedValue(granted());
    await renderPage();

    expect(byTestId('ai-consent-details')).not.toBeNull();
    expect(bodyText()).toContain('アメリカ合衆国');
    expect(bodyText()).toContain('健康診断・血液検査の写真と数値');
    expect(bodyText()).toContain(AI_CONSENT_COPY.retention);
  });

  it('設定に戻るリンクがあり、ページの見出しは h1', async () => {
    mocks.fetchStatus.mockResolvedValue(granted());
    await renderPage();

    expect(document.body.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(document.body.querySelector('h1')?.textContent).toBe(AI_CONSENT_COPY.settingsTitle);
  });
});

describe('/settings/ai-consent: 撤回', () => {
  it('撤回は確認ダイアログを通る。説明は「撤回すると AI 機能は使えなくなる」と書く', async () => {
    mocks.fetchStatus.mockResolvedValue(granted());
    await renderPage();

    await click(byTestId('ai-consent-revoke'));

    const dialog = byTestId('confirm-delete-modal');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('同意を撤回しますか？');
    expect(dialog!.textContent).toContain(AI_CONSENT_COPY.revokeNote);
    expect(dialog!.textContent).toContain('使えなくなります');
    expect(dialog!.textContent).not.toContain('引き続きお使いいただけます');
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('確認で「撤回する」を押すと撤回され、未同意の表示に変わる', async () => {
    mocks.fetchStatus.mockResolvedValue(granted());
    mocks.revoke.mockResolvedValue({
      ok: true,
      data: { ...status({ revokedAt: '2026-10-09T01:05:00.000Z' }), revokedCount: 3 },
    });
    await renderPage();
    await click(byTestId('ai-consent-revoke'));

    await click(dialogButton('撤回する'));

    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    expect(byTestId('confirm-delete-modal')).toBeNull();
    expect(byTestId('ai-consent-overall')?.textContent).toBe('まだ同意していません');
    expect(byTestId('ai-consent-notice')?.textContent).toBe('同意を撤回しました。');
    expect(byTestId('ai-consent-revoke')).toBeNull();
    expect(byTestId('ai-consent-grant')).not.toBeNull();
  });

  it('確認でキャンセルすれば撤回しない', async () => {
    mocks.fetchStatus.mockResolvedValue(granted());
    await renderPage();
    await click(byTestId('ai-consent-revoke'));

    await click(buttonByText('キャンセル'));

    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(byTestId('confirm-delete-modal')).toBeNull();
    expect(byTestId('ai-consent-overall')?.textContent).toBe('同意済みです');
  });

  it('撤回に失敗したら、メッセージを出して表示は同意済みのまま', async () => {
    mocks.fetchStatus.mockResolvedValue(granted());
    mocks.revoke.mockResolvedValue({ ok: false, status: 500, code: 'AI_CONSENT_REVOKE_FAILED', message: '同意を撤回できませんでした。時間をおいて再度お試しください。' });
    await renderPage();
    await click(byTestId('ai-consent-revoke'));

    await click(dialogButton('撤回する'));

    expect(byTestId('ai-consent-action-error')?.textContent).toContain('同意を撤回できませんでした');
    expect(byTestId('ai-consent-overall')?.textContent).toBe('同意済みです');
  });
});

describe('/settings/ai-consent: 同意と読み込み', () => {
  it('「同意する」を押すと同意が記録され、同意済みの表示に変わる', async () => {
    mocks.fetchStatus.mockResolvedValue(status());
    mocks.grant.mockResolvedValue({ ok: true, data: granted() });
    await renderPage();

    await click(byTestId('ai-consent-grant'));

    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(byTestId('ai-consent-overall')?.textContent).toBe('同意済みです');
    expect(byTestId('ai-consent-notice')?.textContent).toBe('同意を記録しました。');
    expect(byTestId('ai-consent-grant')).toBeNull();
  });

  it('同意の記録に失敗したら、メッセージを出して未同意のまま。もう一度押せる', async () => {
    mocks.fetchStatus.mockResolvedValue(status());
    mocks.grant.mockResolvedValue({ ok: false, status: 0, code: null, message: '同意を記録できませんでした。通信状況を確認して、もう一度お試しください。' });
    await renderPage();

    await click(byTestId('ai-consent-grant'));

    expect(byTestId('ai-consent-action-error')?.textContent).toContain('同意を記録できませんでした');
    expect(byTestId('ai-consent-overall')?.textContent).toBe('まだ同意していません');
    expect((byTestId('ai-consent-grant') as HTMLButtonElement).disabled).toBe(false);
  });

  it('状況を読み込めなかったときは、メッセージと「再読み込み」を出し、押すと取り直す', async () => {
    mocks.fetchStatus.mockResolvedValueOnce(null).mockResolvedValueOnce(granted());
    await renderPage();

    expect(byTestId('ai-consent-load-failed')?.textContent).toContain('読み込めませんでした');
    expect(byTestId('ai-consent-overall')).toBeNull();

    await click(buttonByText('再読み込み'));

    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(byTestId('ai-consent-overall')?.textContent).toBe('同意済みです');
  });
});
