/**
 * posthog.test.ts
 * apps/mobile/src/lib/posthog.ts の initPostHogMobile のテスト (#1197)
 * - EXPO_PUBLIC_POSTHOG_HOST 未設定 → packages/shared の POSTHOG_DEFAULT_HOST (Web と共通の既定ホスト) で初期化する
 * - EXPO_PUBLIC_POSTHOG_HOST 設定済み → そのホストで初期化する
 * - EXPO_PUBLIC_POSTHOG_KEY 未設定 → 初期化しない (graceful degradation)
 */

// --- モック設定 ---

const mockPostHogConstructor = jest.fn();
const mockReady = jest.fn();

jest.mock('posthog-react-native', () => ({
  __esModule: true,
  default: class MockPostHog {
    ready = mockReady;
    constructor(...args: unknown[]) {
      mockPostHogConstructor(...args);
    }
  },
}));

import { POSTHOG_DEFAULT_HOST } from '@homegohan/shared';

const ORIGINAL_ENV = { ...process.env };

/** モジュール内の初期化済みクライアント (_posthog) を持ち越さないよう、毎回読み込み直す */
function loadModule(): typeof import('../../src/lib/posthog') {
  let loaded: typeof import('../../src/lib/posthog') | undefined;
  jest.isolateModules(() => {
    loaded = require('../../src/lib/posthog');
  });
  return loaded as typeof import('../../src/lib/posthog');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReady.mockResolvedValue(undefined);
  process.env = { ...ORIGINAL_ENV };
  delete process.env['EXPO_PUBLIC_POSTHOG_KEY'];
  delete process.env['EXPO_PUBLIC_POSTHOG_HOST'];
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('initPostHogMobile — 送信先ホスト', () => {
  it('EXPO_PUBLIC_POSTHOG_HOST が未設定なら、共通の既定ホストで初期化する', async () => {
    process.env['EXPO_PUBLIC_POSTHOG_KEY'] = 'phc_test_key';
    // 定数が読めていないと undefined 同士の比較で空振りするので、先に値の形を確かめる
    expect(POSTHOG_DEFAULT_HOST).toMatch(/^https:\/\/\S+$/);
    const { initPostHogMobile } = loadModule();

    const client = await initPostHogMobile();

    expect(client).not.toBeNull();
    expect(mockPostHogConstructor).toHaveBeenCalledTimes(1);
    expect(mockPostHogConstructor).toHaveBeenCalledWith('phc_test_key', { host: POSTHOG_DEFAULT_HOST });
  });

  it('EXPO_PUBLIC_POSTHOG_HOST が設定されていれば、そのホストで初期化する', async () => {
    process.env['EXPO_PUBLIC_POSTHOG_KEY'] = 'phc_test_key';
    process.env['EXPO_PUBLIC_POSTHOG_HOST'] = 'https://eu.i.posthog.com';
    const { initPostHogMobile } = loadModule();

    await initPostHogMobile();

    expect(mockPostHogConstructor).toHaveBeenCalledWith('phc_test_key', { host: 'https://eu.i.posthog.com' });
  });
});

describe('initPostHogMobile — キー未設定', () => {
  it('EXPO_PUBLIC_POSTHOG_KEY が未設定なら、何も初期化せず null を返す', async () => {
    const { initPostHogMobile, getPostHogClient } = loadModule();

    const client = await initPostHogMobile();

    expect(client).toBeNull();
    expect(getPostHogClient()).toBeNull();
    expect(mockPostHogConstructor).not.toHaveBeenCalled();
  });
});
