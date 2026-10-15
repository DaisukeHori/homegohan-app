// @vitest-environment node
/**
 * #1169 回数制限のカテゴリ csp-report (POST /api/csp-report。key = クライアント IP) の限度値。
 * 設計 docs/design/cross/18-csp-nonce.md §9.5: 30 回/分と、直近 24 時間で 300 回の 2 つの規則。
 * in-memory フォールバック (Upstash を設定しない) で、分あたりと日次の両方の規則が効くことを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

// 構造化ログ。Upstash 未設定の warn を app_logs への保存 (SUPABASE_* 未設定のエラー出力) に流さない
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

/** csp-report の分あたりの上限 (設計 §9.5) */
const PER_MINUTE = 30;
/** csp-report の直近 24 時間の上限 (設計 §9.5) */
const PER_DAY = 300;
const MINUTE_SEC = 60;
const MINUTE_MS = MINUTE_SEC * 1_000;
const DAY_SEC = 24 * 60 * 60;
const DAY_MS = DAY_SEC * 1_000;

type RateLimit = typeof import('@/lib/rate-limit');
let rateLimit: RateLimit;

beforeEach(async () => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  vi.useFakeTimers();
  rateLimit = await import('@/lib/rate-limit');
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.useRealTimers();
});

describe('csp-report カテゴリ (#1169。POST /api/csp-report、in-memory フォールバック)', () => {
  it('csp-report は 30 回/分と 300 回/日の 2 つの規則', async () => {
    // 分あたり: 同じ key では 30 回まで通り、31 回目は windowSec=60 で止まる
    const perMinute = [];
    for (let i = 0; i < PER_MINUTE + 1; i++) {
      perMinute.push(await rateLimit.checkRateLimit('203.0.113.50', 'csp-report'));
    }
    expect(perMinute.slice(0, PER_MINUTE).every((r) => r.success && r.limit === PER_MINUTE && r.windowSec === MINUTE_SEC)).toBe(
      true,
    );
    expect(perMinute[PER_MINUTE - 1].remaining).toBe(0);
    expect(perMinute[PER_MINUTE]).toMatchObject({ success: false, limit: PER_MINUTE, remaining: 0, windowSec: MINUTE_SEC });

    // 日次: 分あたりの枠を戻しながら 300 回まで通り、301 回目は windowSec=86400 で止まる
    const startedAt = Date.now();
    let passed = 0;
    let blocked: Awaited<ReturnType<RateLimit['checkRateLimit']>> | null = null;
    for (let i = 0; i < PER_DAY + 1; i++) {
      const result = await rateLimit.checkRateLimit('203.0.113.51', 'csp-report');
      if (result.success) passed += 1;
      else blocked ??= result;
      // 分あたりの枠 (30 回) を使い切る前に 1 分進めて、日次の判定だけを確かめる
      if ((i + 1) % PER_MINUTE === 0) vi.advanceTimersByTime(MINUTE_MS + 1_000);
    }
    expect(passed).toBe(PER_DAY);
    expect(blocked).toMatchObject({ success: false, limit: PER_DAY, remaining: 0, windowSec: DAY_SEC, reset: startedAt + DAY_MS });

    // ほかのカテゴリ (contact) とは別に数える
    expect(await rateLimit.checkRateLimit('203.0.113.50', 'contact')).toMatchObject({ success: true, remaining: 9 });
  });
});
