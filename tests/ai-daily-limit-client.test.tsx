/**
 * #1149 (T40) Web の画面: AI の API に「今日の AI の利用回数の上限に達しました」(429 AI_DAILY_LIMIT) で止められたときの文
 *
 *   - aiDailyLimitMessageOfResponse: 429 + AI_DAILY_LIMIT のときだけ、limit から作った固定の文を返す (本文の文はそのまま使わない)。
 *     本文は clone して読むので、呼び出し側はあとで本文を読める。レート制限の 429 (RATE_LIMITED) やほかの状態では null
 *   - aiFetch: 429 AI_DAILY_LIMIT を受けたら AI_DAILY_LIMIT_EVENT (detail は文) を出す。同意の 403 は従来どおり同意の案内だけ
 *   - AiDailyLimitHost: イベントを受けたら文を role="alert" で出す。「閉じる」で消える。少しの間で消える
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { AI_DAILY_LIMIT_EVENT, aiDailyLimitMessageOfResponse, notifyAiDailyLimit } = await import('@/lib/ai/daily-limit-client');
const { AI_CONSENT_REQUIRED_EVENT, aiFetch } = await import('@/lib/ai/consent-required');
const { AiDailyLimitHost } = await import('@/components/consent/AiDailyLimitHost');
const { aiDailyLimitMessage, AI_DAILY_LIMIT_FALLBACK_MESSAGE } = await import('../supabase/functions/_shared/ai-daily-limit');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const limitBody = { error: '<b>本文の文</b>', code: 'AI_DAILY_LIMIT', limit: 10, retryAfter: 3600 };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('aiDailyLimitMessageOfResponse', () => {
  it('429 + AI_DAILY_LIMIT: limit から作った固定の文。本文はあとで読める', async () => {
    const res = json(429, limitBody);
    await expect(aiDailyLimitMessageOfResponse(res)).resolves.toBe(aiDailyLimitMessage(10));
    await expect(res.json()).resolves.toEqual(limitBody);
  });

  it('limit が読めなければ回数なしの文', async () => {
    await expect(aiDailyLimitMessageOfResponse(json(429, { code: 'AI_DAILY_LIMIT' }))).resolves.toBe(AI_DAILY_LIMIT_FALLBACK_MESSAGE);
  });

  it('レート制限の 429・ほかの状態・JSON でない本文は null', async () => {
    await expect(aiDailyLimitMessageOfResponse(json(429, { error: 'Too many', code: 'RATE_LIMITED', retryAfter: 30 }))).resolves.toBeNull();
    await expect(aiDailyLimitMessageOfResponse(json(403, { code: 'AI_DAILY_LIMIT', limit: 10 }))).resolves.toBeNull();
    await expect(aiDailyLimitMessageOfResponse(json(200, { ok: true }))).resolves.toBeNull();
    await expect(aiDailyLimitMessageOfResponse(new Response('Too Many Requests', { status: 429 }))).resolves.toBeNull();
  });
});

describe('aiFetch: 上限で止められたら AI_DAILY_LIMIT_EVENT を出す', () => {
  const limitEvents: string[] = [];
  let consentEvents = 0;
  const onLimit = (event: Event) => limitEvents.push(String((event as CustomEvent).detail));
  const onConsent = () => {
    consentEvents += 1;
  };

  beforeEach(() => {
    limitEvents.length = 0;
    consentEvents = 0;
    window.addEventListener(AI_DAILY_LIMIT_EVENT, onLimit);
    window.addEventListener(AI_CONSENT_REQUIRED_EVENT, onConsent);
  });

  afterEach(() => {
    window.removeEventListener(AI_DAILY_LIMIT_EVENT, onLimit);
    window.removeEventListener(AI_CONSENT_REQUIRED_EVENT, onConsent);
    vi.unstubAllGlobals();
  });

  it('429 AI_DAILY_LIMIT: 文をイベントで知らせ、応答はそのまま返す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(429, limitBody)));
    const res = await aiFetch('/api/ai/menu/v5/generate', { method: 'POST' });
    expect(res.status).toBe(429);
    expect(limitEvents).toEqual([aiDailyLimitMessage(10)]);
    expect(consentEvents).toBe(0);
    await expect(res.json()).resolves.toEqual(limitBody);
  });

  it('同意の 403・レート制限の 429・200 では、上限のイベントを出さない', async () => {
    for (const [status, body] of [
      [403, { error: '同意が必要です', code: 'AI_CONSENT_REQUIRED' }],
      [429, { error: 'Too many', code: 'RATE_LIMITED' }],
      [200, { ok: true }],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => json(status, body)));
      await aiFetch('/api/ai/x');
    }
    expect(limitEvents).toEqual([]);
    expect(consentEvents).toBe(1);
  });
});

describe('AiDailyLimitHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(AiDailyLimitHost));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  const notice = () => container.querySelector('[data-testid="ai-daily-limit-notice"]');

  it('はじめは何も出さない。イベントを受けたら文を role="alert" で出し、少しの間で消える', () => {
    expect(notice()).toBeNull();
    act(() => {
      notifyAiDailyLimit(aiDailyLimitMessage(10));
    });
    expect(notice()?.getAttribute('role')).toBe('alert');
    expect(notice()?.textContent).toContain('今日の AI の利用回数の上限 (10 回) に達しました。明日 0 時から使えます。');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(notice()).toBeNull();
  });

  it('「閉じる」ですぐ消える', () => {
    act(() => {
      notifyAiDailyLimit(aiDailyLimitMessage(3));
    });
    const close = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '閉じる')!;
    act(() => {
      close.click();
    });
    expect(notice()).toBeNull();
  });

  it('文が空・文字列でないイベントは無視する', () => {
    act(() => {
      window.dispatchEvent(new CustomEvent(AI_DAILY_LIMIT_EVENT, { detail: '' }));
      window.dispatchEvent(new CustomEvent(AI_DAILY_LIMIT_EVENT, { detail: { html: '<b>x</b>' } }));
    });
    expect(notice()).toBeNull();
  });
});
