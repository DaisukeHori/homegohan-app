import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockInit = vi.fn();
const mockOptIn = vi.fn();
const mockOptOut = vi.fn();

const mockPosthog: any = {
  __loaded: false,
  init: mockInit,
  opt_in_capturing: mockOptIn,
  opt_out_capturing: mockOptOut,
  identify: vi.fn(),
  capture: vi.fn(),
};

vi.mock('posthog-js', () => ({
  default: mockPosthog,
}));

const {
  initPostHog,
  optInPostHog,
  optOutPostHog,
  getAnalyticsConsent,
  ANALYTICS_CONSENT_KEY,
  ANALYTICS_CONSENT_EVENT,
  redactTokenPath,
} = await import('@/lib/posthog');
const { POSTHOG_DEFAULT_HOST } = await import('@homegohan/shared');

beforeEach(() => {
  vi.clearAllMocks();
  mockPosthog.__loaded = false;
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getAnalyticsConsent', () => {
  it('localStorage が true でない場合は false を返す', () => {
    expect(getAnalyticsConsent()).toBe(false);
  });

  it('localStorage が "true" の場合は true を返す', () => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'true');
    expect(getAnalyticsConsent()).toBe(true);
  });
});

describe('initPostHog (#1044 F6-15: 冒頭の同意ガード)', () => {
  it('同意なしの場合は本番環境・キー設定済みでも init しない', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_key');
    // 同意なし (localStorage 未設定)

    initPostHog();

    expect(mockInit).not.toHaveBeenCalled();
  });

  it('同意ありかつ本番環境・キー設定済みの場合は init する', () => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'true');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_key');

    initPostHog();

    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('同意ありでも開発環境では init しない (既存の graceful degradation を維持)', () => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'true');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_key');

    initPostHog();

    expect(mockInit).not.toHaveBeenCalled();
  });
});

describe('initPostHog: 送信先ホスト (#1197: 既定値は packages/shared の定数)', () => {
  beforeEach(() => {
    localStorage.setItem(ANALYTICS_CONSENT_KEY, 'true');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test_key');
  });

  it('NEXT_PUBLIC_POSTHOG_HOST が未設定なら、共通の既定ホストを api_host に渡す', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', undefined);
    // 定数が読めていないと undefined 同士の比較で空振りするので、先に値の形を確かめる
    expect(POSTHOG_DEFAULT_HOST).toMatch(/^https:\/\/\S+$/);

    initPostHog();

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0][1]).toMatchObject({ api_host: POSTHOG_DEFAULT_HOST });
  });

  it('NEXT_PUBLIC_POSTHOG_HOST が設定されていれば、そのホストを api_host に渡す', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com');

    initPostHog();

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0][1]).toMatchObject({ api_host: 'https://eu.i.posthog.com' });
  });
});

describe('optInPostHog / optOutPostHog (#1044 F6-15: 同一タブ通知)', () => {
  it('optInPostHog は同意状態を保存し、同一タブ向け CustomEvent を発火する', () => {
    const handler = vi.fn();
    window.addEventListener(ANALYTICS_CONSENT_EVENT, handler);

    optInPostHog();

    expect(localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('true');
    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener(ANALYTICS_CONSENT_EVENT, handler);
  });

  it('optOutPostHog は同意状態を保存し、同一タブ向け CustomEvent を発火する', () => {
    const handler = vi.fn();
    window.addEventListener(ANALYTICS_CONSENT_EVENT, handler);

    optOutPostHog();

    expect(localStorage.getItem(ANALYTICS_CONSENT_KEY)).toBe('false');
    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener(ANALYTICS_CONSENT_EVENT, handler);
  });
});

describe('redactTokenPath (#1232: 承認ページのトークンを分析に送らない)', () => {
  it('/family/promotions/{token} のトークンを伏せる', () => {
    const token = 'a'.repeat(64);
    expect(redactTokenPath(`/family/promotions/${token}`)).toBe('/family/promotions/[token]');
    expect(redactTokenPath(`/family/promotions/${token}`)).not.toContain(token);
  });

  it('トークンを含まないパスはそのまま返す', () => {
    expect(redactTokenPath('/family/dashboard')).toBe('/family/dashboard');
    expect(redactTokenPath('/family/promotions')).toBe('/family/promotions');
    expect(redactTokenPath('/home')).toBe('/home');
  });
});
