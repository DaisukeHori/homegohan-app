/**
 * #1178 応答期限の環境変数 DSR_RESPONSE_DUE_DAYS を読む src/lib/data-subject-requests/config.ts の単体テスト (設計 cross/15 §12・§15)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DSR_RESPONSE_DUE_DAYS_DEFAULT } from '@/lib/data-subject-requests/core';
import { getDsrResponseDueDays } from '@/lib/data-subject-requests/config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getDsrResponseDueDays', () => {
  it("DSR_RESPONSE_DUE_DAYS='10' なら 10 日", () => {
    vi.stubEnv('DSR_RESPONSE_DUE_DAYS', '10');
    expect(getDsrResponseDueDays()).toBe(10);
  });

  it('未設定なら既定 (DSR_RESPONSE_DUE_DAYS_DEFAULT = 30)', () => {
    vi.stubEnv('DSR_RESPONSE_DUE_DAYS', undefined);
    expect(getDsrResponseDueDays()).toBe(DSR_RESPONSE_DUE_DAYS_DEFAULT);
    expect(DSR_RESPONSE_DUE_DAYS_DEFAULT).toBe(30);
  });

  it.each(['abc', '366', '0', '1.5'])('%j は既定 (resolveDsrResponseDueDays に委ねている)', (raw) => {
    vi.stubEnv('DSR_RESPONSE_DUE_DAYS', raw);
    expect(getDsrResponseDueDays()).toBe(DSR_RESPONSE_DUE_DAYS_DEFAULT);
  });

  it('呼ぶたびに今の値を読む (起動時に固定しない)', () => {
    vi.stubEnv('DSR_RESPONSE_DUE_DAYS', '7');
    expect(getDsrResponseDueDays()).toBe(7);
    vi.stubEnv('DSR_RESPONSE_DUE_DAYS', '365');
    expect(getDsrResponseDueDays()).toBe(365);
  });
});
