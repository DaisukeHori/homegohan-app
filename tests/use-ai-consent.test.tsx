/**
 * T15 (#1154) useAiConsent() の挙動テスト: AI の入口で「初回だけ同意画面を出す」フック
 *
 * オーナーの決定: 外国の AI 事業者へのデータ送信は止めない。したがって、このフックは次を守る。
 *   [止めない]
 *     - ensureAiConsent() は reject しない。「あとで」でも、同意の記録に失敗しても、状況が取れなくても、必ず戻る
 *     - 「あとで」は記録せず (サーバーに拒否の行を作らない)、同じブラウザで 24 時間は画面を出さない
 *     - 状況が取れていないときは、操作を長く待たせない (最大 1.5 秒。取得に失敗した直後は待たない)
 *     - 呼び出し側が consentModal を描画し忘れても、1 秒で諦めて進める
 *   [初回だけ出す]
 *     - 同意済みなら画面を出さず、ネットワークも待たない
 *     - 未同意なら画面を出し、「同意する」「あとで」のどちらかが選ばれるまで待つ
 *   [離れたら再開しない]
 *     - 画面が出ている間にページを離れたら、待っていた操作は再開しない
 */
import { act, createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConsentStatus } from '@/lib/ai/consent-config';

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  grant: vi.fn(),
}));

vi.mock('@/lib/ai/consent-client', () => ({
  fetchAiConsentStatus: mocks.fetchStatus,
  postAiConsentGrant: mocks.grant,
  postAiConsentRevoke: vi.fn(),
}));

vi.mock('next/link', async () => {
  const react = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode } & Record<string, unknown>) =>
      react.createElement('a', { href, ...rest }, children),
  };
});

const { useAiConsent, resetAiConsentClientStateForTests, forgetAiConsentStatus } = await import('@/hooks/useAiConsent');
const { AI_CONSENT_LATER_SNOOZE_MS, AI_CONSENT_LATER_STORAGE_KEY, AI_CONSENT_PROVIDERS, AI_CONSENT_VERSION } = await import(
  '@/lib/ai/consent-config'
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Outcome = Awaited<ReturnType<ReturnType<typeof useAiConsent>['ensureAiConsent']>>;

function status(consented: boolean): AiConsentStatus {
  return {
    version: AI_CONSENT_VERSION,
    consented,
    providers: AI_CONSENT_PROVIDERS.map((provider) => ({
      provider,
      state: consented ? 'granted' : 'none',
      consentedAt: consented ? '2026-10-08T00:00:00.000Z' : null,
      policyVersion: consented ? AI_CONSENT_VERSION : null,
      revokedAt: null,
    })),
    consentedAt: consented ? '2026-10-08T00:00:00.000Z' : null,
    revokedAt: null,
  };
}

let container: HTMLDivElement;
let root: Root;
let ensure: () => Promise<Outcome>;

/** consentModal を描画する、ふつうの呼び出し側 */
function Harness() {
  const consent = useAiConsent();
  ensure = consent.ensureAiConsent;
  return createElement('div', { 'data-testid': 'harness' }, consent.consentModal);
}

/** prefetch の有無を外から切り替えられる、全ページに常駐する部品のような呼び出し側 (AIChatBubble) */
let setPrefetch: (value: boolean) => void;
function HarnessWithPrefetch({ initial }: { initial: boolean }) {
  const [prefetch, setPrefetchState] = useState(initial);
  setPrefetch = setPrefetchState;
  const consent = useAiConsent({ prefetch });
  ensure = consent.ensureAiConsent;
  return createElement('div', { 'data-testid': 'harness' }, consent.consentModal);
}

/** consentModal を描画し忘れた呼び出し側 */
function HarnessWithoutModal() {
  const consent = useAiConsent();
  ensure = consent.ensureAiConsent;
  return createElement('div', { 'data-testid': 'harness' });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(component: () => ReactNode = Harness as never) {
  act(() => {
    root.render(createElement(component as never));
  });
}

const modal = () => document.body.querySelector('[data-testid="ai-consent-modal"]') as HTMLElement | null;
const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function click(el: HTMLElement | null) {
  expect(el, 'クリック対象が見つからない').not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** ensure() を呼び、結果を後から確かめられるようにする */
function startEnsure() {
  const result: { outcome?: Outcome; settled: boolean } = { settled: false };
  void ensure().then((outcome) => {
    result.outcome = outcome;
    result.settled = true;
  });
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchStatus.mockReset();
  mocks.grant.mockReset();
  resetAiConsentClientStateForTests();
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  act(() => root.unmount());
  container.remove();
  document.body.style.overflow = '';
});

describe('useAiConsent: 同意済みなら何も出さず、待たない', () => {
  it('同意済み: 画面を出さずに consented で戻る。操作のときにネットワークを待たない', async () => {
    mocks.fetchStatus.mockResolvedValue(status(true));
    mount();
    await flush();
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1); // ページを開いたときの先読み

    await expect(ensure()).resolves.toBe('consented');
    await expect(ensure()).resolves.toBe('consented');

    expect(modal()).toBeNull();
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1); // 操作のたびに取り直さない
  });

  it('ページを開いたときの先読みは、複数のフックが同時に開いても 1 回だけ', async () => {
    mocks.fetchStatus.mockResolvedValue(status(true));
    act(() => {
      root.render(createElement('div', null, createElement(Harness as never), createElement(Harness as never)));
    });
    await flush();
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('直近に取れた状況は、ページを開き直しても取り直さない (60 秒以内)', async () => {
    mocks.fetchStatus.mockResolvedValue(status(true));
    mount();
    await flush();
    act(() => root.unmount());
    root = createRoot(container);
    mount();
    await flush();
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('forgetAiConsentStatus() のあとは、次に開いたとき取り直す (設定ページで撤回・同意した直後など)', async () => {
    mocks.fetchStatus.mockResolvedValue(status(true));
    mount();
    await flush();
    forgetAiConsentStatus();
    act(() => root.unmount());
    root = createRoot(container);
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await flush();
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);

    const pending = startEnsure();
    await flush();
    expect(modal()).not.toBeNull();
    expect(pending.settled).toBe(false);
  });
});

describe('useAiConsent: prefetch オプション (全ページに常駐する部品は、使われるまで取得しない)', () => {
  it('prefetch: false なら、ページを開いても同意の状況を取りにいかない', async () => {
    mocks.fetchStatus.mockResolvedValue(status(true));
    act(() => {
      root.render(createElement(HarnessWithPrefetch as never, { initial: false }));
    });
    await flush();

    expect(mocks.fetchStatus).not.toHaveBeenCalled();
  });

  it('prefetch が false → true になったとき (相談の画面を開いたとき) に、取得を始める', async () => {
    mocks.fetchStatus.mockResolvedValue(status(true));
    act(() => {
      root.render(createElement(HarnessWithPrefetch as never, { initial: false }));
    });
    await flush();
    expect(mocks.fetchStatus).not.toHaveBeenCalled();

    await act(async () => {
      setPrefetch(true);
    });
    await flush();

    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    await expect(ensure()).resolves.toBe('consented'); // 取得済みなので待たない
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('prefetch: false のままでも、ensureAiConsent() のときに取得して、未同意なら画面を出す (AI の操作は止めない)', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    act(() => {
      root.render(createElement(HarnessWithPrefetch as never, { initial: false }));
    });
    await flush();
    expect(mocks.fetchStatus).not.toHaveBeenCalled();

    const pending = startEnsure();
    await flush();

    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    expect(modal()).not.toBeNull();
    expect(pending.settled).toBe(false);

    await click(byTestId('ai-consent-later'));
    expect(pending.outcome).toBe('later');
  });

  it('prefetch: false のまま、取得が間に合わなければ (1.5 秒)、画面を出さずに skipped で戻る', async () => {
    vi.useFakeTimers();
    mocks.fetchStatus.mockReturnValue(new Promise(() => {}));
    act(() => {
      root.render(createElement(HarnessWithPrefetch as never, { initial: false }));
    });
    await act(async () => {});

    const pending = startEnsure();
    await act(async () => {
      vi.advanceTimersByTime(1_600);
    });

    expect(pending.outcome).toBe('skipped');
    expect(modal()).toBeNull();
  });
});

describe('useAiConsent: 未同意なら初回だけ画面を出す。どちらを選んでも操作は進む', () => {
  it('未同意: 画面を出し、選ばれるまで待つ', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await flush();

    const pending = startEnsure();
    await flush();

    expect(modal()).not.toBeNull();
    expect(pending.settled).toBe(false);
  });

  it('「あとで」: later で戻り、画面は閉じる。サーバーには何も送らず (拒否の行を作らない)、24 時間の期限を覚える', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await flush();
    const before = Date.now();
    const pending = startEnsure();
    await flush();

    await click(byTestId('ai-consent-later'));
    await flush();

    expect(pending.outcome).toBe('later');
    expect(modal()).toBeNull();
    expect(mocks.grant).not.toHaveBeenCalled();
    const until = Number(localStorage.getItem(AI_CONSENT_LATER_STORAGE_KEY));
    expect(until).toBeGreaterThanOrEqual(before + AI_CONSENT_LATER_SNOOZE_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + AI_CONSENT_LATER_SNOOZE_MS);
  });

  it('「あとで」のあと 24 時間は、画面を出さず待たずに later で戻る', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await flush();
    startEnsure();
    await flush();
    await click(byTestId('ai-consent-later'));
    await flush();

    await expect(ensure()).resolves.toBe('later');
    await expect(ensure()).resolves.toBe('later');

    expect(modal()).toBeNull();
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('期限が切れたら、もう一度画面を出す', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    localStorage.setItem(AI_CONSENT_LATER_STORAGE_KEY, String(Date.now() - 1));
    mount();
    await flush();

    const pending = startEnsure();
    await flush();

    expect(modal()).not.toBeNull();
    expect(pending.settled).toBe(false);
  });

  it('壊れた期限の値 (数字でない) は、期限切れとして扱う', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    localStorage.setItem(AI_CONSENT_LATER_STORAGE_KEY, 'not-a-number');
    mount();
    await flush();

    startEnsure();
    await flush();

    expect(modal()).not.toBeNull();
  });

  it('Esc キーは「あとで」: later で戻り、画面は閉じる', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await flush();
    const pending = startEnsure();
    await flush();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();

    expect(pending.outcome).toBe('later');
    expect(modal()).toBeNull();
  });

  it('「同意する」: 同意を記録して consented で戻り、画面は閉じる。以後は待たずに consented', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mocks.grant.mockResolvedValue({ ok: true, data: status(true) });
    localStorage.setItem(AI_CONSENT_LATER_STORAGE_KEY, String(Date.now() - 1));
    mount();
    await flush();
    const pending = startEnsure();
    await flush();

    await click(byTestId('ai-consent-accept'));
    await flush();

    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(pending.outcome).toBe('consented');
    expect(modal()).toBeNull();
    expect(localStorage.getItem(AI_CONSENT_LATER_STORAGE_KEY)).toBeNull(); // 同意したので「あとで」の期限は不要
    await expect(ensure()).resolves.toBe('consented');
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('同時に何度 ensure() を呼んでも、画面は 1 つで、1 回の選択で全員が戻る', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await flush();
    const first = startEnsure();
    const second = startEnsure();
    await flush();

    expect(document.body.querySelectorAll('[data-testid="ai-consent-modal"]')).toHaveLength(1);
    await click(byTestId('ai-consent-later'));
    await flush();

    expect(first.outcome).toBe('later');
    expect(second.outcome).toBe('later');
  });
});

describe('useAiConsent: 同意の記録に失敗しても、操作は止めない', () => {
  it('記録に失敗: 画面を閉じずにメッセージを出し、「あとで」で戻れる', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mocks.grant.mockResolvedValue({ ok: false, status: 500, code: 'AI_CONSENT_GRANT_FAILED', message: '同意を記録できませんでした。' });
    mount();
    await flush();
    const pending = startEnsure();
    await flush();

    await click(byTestId('ai-consent-accept'));
    await flush();

    expect(modal()).not.toBeNull();
    expect(byTestId('ai-consent-error')?.textContent).toContain('同意を記録できませんでした');
    expect(pending.settled).toBe(false);
    expect((byTestId('ai-consent-accept') as HTMLButtonElement).disabled).toBe(false);

    await click(byTestId('ai-consent-later'));
    await flush();
    expect(pending.outcome).toBe('later');
    expect(modal()).toBeNull();
  });

  it('記録に失敗したあと、もう一度「同意する」を押して成功すれば consented', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mocks.grant
      .mockResolvedValueOnce({ ok: false, status: 0, code: null, message: '通信できませんでした。' })
      .mockResolvedValueOnce({ ok: true, data: status(true) });
    mount();
    await flush();
    const pending = startEnsure();
    await flush();

    await click(byTestId('ai-consent-accept'));
    await flush();
    expect(byTestId('ai-consent-error')).not.toBeNull();

    await click(byTestId('ai-consent-accept'));
    await flush();

    expect(mocks.grant).toHaveBeenCalledTimes(2);
    expect(pending.outcome).toBe('consented');
    expect(modal()).toBeNull();
  });

  it('文面が更新された (409) 場合も、メッセージを出して「あとで」で戻れる', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mocks.grant.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'AI_CONSENT_VERSION_MISMATCH',
      message: '同意の文面が更新されました。画面を開き直して、あらためてご確認ください。',
    });
    mount();
    await flush();
    const pending = startEnsure();
    await flush();

    await click(byTestId('ai-consent-accept'));
    await flush();
    expect(byTestId('ai-consent-error')?.textContent).toContain('文面が更新されました');

    await click(byTestId('ai-consent-later'));
    await flush();
    expect(pending.outcome).toBe('later');
  });

  it('記録中に「あとで」を押しても戻る。あとから記録が成功しても、画面は開き直さない', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    let resolveGrant!: (value: unknown) => void;
    mocks.grant.mockReturnValue(new Promise((resolve) => (resolveGrant = resolve)));
    mount();
    await flush();
    const pending = startEnsure();
    await flush();

    await click(byTestId('ai-consent-accept'));
    expect((byTestId('ai-consent-accept') as HTMLButtonElement).disabled).toBe(true);
    await click(byTestId('ai-consent-later'));
    await flush();
    expect(pending.outcome).toBe('later');

    await act(async () => resolveGrant({ ok: false, status: 500, code: null, message: '失敗' }));
    await flush();
    expect(modal()).toBeNull();
  });

  it('localStorage が使えなくても (例外)、「あとで」で戻る', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await flush();
    const pending = startEnsure();
    await flush();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    await click(byTestId('ai-consent-later'));
    await flush();

    expect(pending.outcome).toBe('later');
    expect(modal()).toBeNull();
  });
});

describe('useAiConsent: 同意の状況が取れなくても、操作を長く待たせない', () => {
  it('状況の取得に失敗 (null): 画面を出さずに skipped で戻る。直後の操作は取り直さず待たない', async () => {
    mocks.fetchStatus.mockResolvedValue(null);
    mount();
    await flush();

    await expect(ensure()).resolves.toBe('skipped');
    await expect(ensure()).resolves.toBe('skipped');

    expect(modal()).toBeNull();
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('状況の取得が例外を投げても、skipped で戻る (未処理の reject を出さない)', async () => {
    mocks.fetchStatus.mockRejectedValue(new Error('boom'));
    mount();
    await flush();

    await expect(ensure()).resolves.toBe('skipped');
    expect(modal()).toBeNull();
  });

  it('状況の取得が終わらない (通信が詰まった): 1.5 秒待って、画面を出さずに skipped で戻る', async () => {
    vi.useFakeTimers();
    mocks.fetchStatus.mockReturnValue(new Promise(() => {}));
    mount();
    await act(async () => {});

    const pending = startEnsure();
    await act(async () => {
      vi.advanceTimersByTime(1_400);
    });
    expect(pending.settled).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(pending.outcome).toBe('skipped');
    expect(modal()).toBeNull();
  });

  it('取得が間に合った場合 (1.5 秒以内) は、その結果に従う', async () => {
    vi.useFakeTimers();
    let resolveStatus!: (value: AiConsentStatus) => void;
    mocks.fetchStatus.mockReturnValue(new Promise<AiConsentStatus>((resolve) => (resolveStatus = resolve)));
    mount();
    await act(async () => {});

    const pending = startEnsure();
    await act(async () => {
      vi.advanceTimersByTime(800);
      resolveStatus(status(true));
    });

    expect(pending.outcome).toBe('consented');
    expect(modal()).toBeNull();
  });
});

describe('useAiConsent: 画面が出なかったり、ページを離れたりしたとき', () => {
  it('呼び出し側が consentModal を描画し忘れても、1 秒で諦めて skipped で戻る (console.error で知らせる)', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount(HarnessWithoutModal);
    await act(async () => {});

    const pending = startEnsure();
    await act(async () => {});
    expect(pending.settled).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(1_100);
    });

    expect(pending.outcome).toBe('skipped');
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('consentModal'));
  });

  it('画面が正しく表示されていれば、1 秒を過ぎても自動では進めない (選択を待ち続ける)', async () => {
    vi.useFakeTimers();
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await act(async () => {});

    const pending = startEnsure();
    await act(async () => {});
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(modal()).not.toBeNull();
    expect(pending.settled).toBe(false);
  });

  it('画面が出ている間にページを離れたら、待っていた操作は再開しない', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await flush();
    const pending = startEnsure();
    await flush();
    expect(modal()).not.toBeNull();

    act(() => root.unmount());
    await flush();

    expect(pending.settled).toBe(false);
    expect(modal()).toBeNull();
  });

  it('ページを離れたあとに呼ばれた ensure() は、画面を出さず skipped で戻る', async () => {
    mocks.fetchStatus.mockResolvedValue(status(false));
    mount();
    await flush();
    const staleEnsure = ensure;

    act(() => root.unmount());

    await expect(staleEnsure()).resolves.toBe('skipped');
    expect(modal()).toBeNull();
  });
});
