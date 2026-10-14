/**
 * T15 (#1154) 画面: AI の API に「同意が必要です」(403 AI_CONSENT_REQUIRED) で止められたときに、同意画面を出す
 *
 *   - aiFetch: 403 + AI_CONSENT_REQUIRED のときだけ AI_CONSENT_REQUIRED_EVENT を出す。応答はそのまま返し、本文はあとで読める
 *   - AiConsentRequiredHost: イベントを受けたら「この機能を使うには、次の内容への同意が必要です。」つきの同意画面を出す。
 *     「同意する」で記録し、「もう一度、操作をやり直してください」と知らせる。「同意しない」で閉じる
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { AI_CONSENT_REQUIRED_EVENT, aiFetch, isAiConsentRequiredResponse } = await import('@/lib/ai/consent-required');
const { AiConsentRequiredHost } = await import('@/components/consent/AiConsentRequiredHost');
const { resetAiConsentClientStateForTests } = await import('@/hooks/useAiConsent');
const { AI_CONSENT_COPY } = await import('@/lib/ai/consent-config');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const requiredBody = { error: '同意が必要です', code: 'AI_CONSENT_REQUIRED' };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('aiFetch / isAiConsentRequiredResponse', () => {
  let events = 0;
  const onEvent = () => {
    events += 1;
  };

  beforeEach(() => {
    events = 0;
    window.addEventListener(AI_CONSENT_REQUIRED_EVENT, onEvent);
  });

  afterEach(() => {
    window.removeEventListener(AI_CONSENT_REQUIRED_EVENT, onEvent);
    vi.unstubAllGlobals();
  });

  it('403 + AI_CONSENT_REQUIRED: イベントを出し、応答をそのまま返す (本文はあとで読める)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, requiredBody)));
    const res = await aiFetch('/api/ai/analyze-fridge', { method: 'POST' });
    expect(events).toBe(1);
    expect(res.status).toBe(403);
    await expect(isAiConsentRequiredResponse(res)).resolves.toBe(true);
    await expect(res.json()).resolves.toEqual(requiredBody);
  });

  it('ほかの 403・503 (判定に失敗)・200 ではイベントを出さない', async () => {
    for (const [status, body] of [
      [403, { error: 'Forbidden' }],
      [503, { error: '一時的に使えません', code: 'AI_CONSENT_CHECK_FAILED' }],
      [200, { ok: true }],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => json(status, body)));
      const res = await aiFetch('/api/ai/x');
      await expect(isAiConsentRequiredResponse(res)).resolves.toBe(false);
    }
    // 本文が JSON でない 403
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));
    await aiFetch('/api/ai/x');
    expect(events).toBe(0);
  });
});

describe('AiConsentRequiredHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAiConsentClientStateForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(AiConsentRequiredHost)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.overflow = '';
  });

  const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  async function fire() {
    await act(async () => {
      window.dispatchEvent(new Event(AI_CONSENT_REQUIRED_EVENT));
    });
  }

  async function click(el: HTMLElement | null) {
    expect(el).not.toBeNull();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('はじめは何も出さず、状況も取りにいかない', () => {
    expect(byTestId('ai-consent-modal')).toBeNull();
    expect(mocks.fetchStatus).not.toHaveBeenCalled();
  });

  it('止められたら「同意が必要です」の一文つきの同意画面を出し、「同意する」で記録して、やり直しを案内する', async () => {
    mocks.grant.mockResolvedValue({
      ok: true,
      data: { version: 'v', consented: true, providers: [], consentedAt: null, revokedAt: null },
    });
    await fire();
    expect(byTestId('ai-consent-modal')).not.toBeNull();
    expect(byTestId('ai-consent-required-lead')?.textContent).toBe(AI_CONSENT_COPY.requiredLead);

    await click(byTestId('ai-consent-accept'));
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(byTestId('ai-consent-modal')).toBeNull();
    expect(byTestId('ai-consent-retry-notice')?.textContent).toContain('もう一度、操作をやり直してください');
  });

  it('「同意しない」で閉じる。記録しない', async () => {
    await fire();
    await click(byTestId('ai-consent-decline'));
    expect(byTestId('ai-consent-modal')).toBeNull();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(byTestId('ai-consent-retry-notice')).toBeNull();
  });
});
