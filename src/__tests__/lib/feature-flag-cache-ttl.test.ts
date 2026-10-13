// @vitest-environment node
/**
 * #1496 機能フラグの行をメモリに覚える時間 (FEATURE_FLAG_CACHE_TTL_MS) の読み方。
 * 既定は 30 秒のまま。環境変数で上書きできるのは正の整数だけで、それ以外は既定に戻す。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FEATURE_FLAG_CACHE_TTL_DEFAULT_MS,
  FEATURE_FLAG_CACHE_TTL_ENV,
  resolveFeatureFlagCacheTtlMs,
} from '@/lib/feature-flag-cache-ttl';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('resolveFeatureFlagCacheTtlMs', () => {
  it('既定は 30 秒 (以前の固定値と同じ)', () => {
    expect(FEATURE_FLAG_CACHE_TTL_DEFAULT_MS).toBe(30_000);
    expect(resolveFeatureFlagCacheTtlMs(undefined)).toBe(30_000);
    expect(resolveFeatureFlagCacheTtlMs('')).toBe(30_000);
    expect(resolveFeatureFlagCacheTtlMs('   ')).toBe(30_000);
  });

  it('正の整数ならその値 (前後の空白は許す)', () => {
    expect(resolveFeatureFlagCacheTtlMs('2000')).toBe(2000);
    expect(resolveFeatureFlagCacheTtlMs(' 1 ')).toBe(1);
    expect(resolveFeatureFlagCacheTtlMs('60000')).toBe(60_000);
  });

  it('正の整数でない (0・負・小数・数字でない・安全な整数の外) ときは既定', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '2s', 'NaN', 'Infinity', String(Number.MAX_SAFE_INTEGER + 2)]) {
      expect(resolveFeatureFlagCacheTtlMs(bad), bad).toBe(FEATURE_FLAG_CACHE_TTL_DEFAULT_MS);
    }
  });

  it('引数を省略すると環境変数 FEATURE_FLAG_CACHE_TTL_MS を読む', () => {
    expect(FEATURE_FLAG_CACHE_TTL_ENV).toBe('FEATURE_FLAG_CACHE_TTL_MS');
    vi.stubEnv(FEATURE_FLAG_CACHE_TTL_ENV, '2000');
    expect(resolveFeatureFlagCacheTtlMs()).toBe(2000);
    vi.stubEnv(FEATURE_FLAG_CACHE_TTL_ENV, 'oops');
    expect(resolveFeatureFlagCacheTtlMs()).toBe(30_000);
  });

  it('src/lib/feature-flags.ts の FEATURE_FLAG_CACHE_TTL_MS は、読み込んだときの環境変数で決まる (未設定なら 30 秒)', async () => {
    vi.stubEnv(FEATURE_FLAG_CACHE_TTL_ENV, '2000');
    vi.resetModules();
    expect((await import('@/lib/feature-flags')).FEATURE_FLAG_CACHE_TTL_MS).toBe(2000);
    vi.stubEnv(FEATURE_FLAG_CACHE_TTL_ENV, '');
    vi.resetModules();
    expect((await import('@/lib/feature-flags')).FEATURE_FLAG_CACHE_TTL_MS).toBe(30_000);
  });
});
