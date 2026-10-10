// @vitest-environment node
/**
 * #1433: 外から受け取った日付を isCalendarDate (src/lib/date-utils → packages/shared) で確かめるルートは、
 * 実在する日付でも、受け付ける範囲 (0101-01-02〜9998-12-30) の外なら DB に触れる前に 400 にする。
 *
 * 範囲の外の端の日付 (9999-12-31・0100-01-01 など) を通すと、そのあとで前日・翌日・週の端を求める addDaysToDate が
 * 暦の計算で扱える範囲 (0100-01-01〜9999-12-31) の外に出る。addDaysToDate はそのとき RangeError を投げる
 * (以前は "+010000-01"・"0099-12-31" という、YYYY-MM-DD でない・Date.UTC が別の年と読む文字列を黙って返し、DB の条件や
 * 後ろの関数に渡っていた)。ここでは、isCalendarDate を入口に使っている次の 3 本で、端の日付が 400 になることを確かめる
 * (CalendarDateSchema を使う管理画面のルートと、献立生成の入口は、それぞれのルートのテストで確かめる)。
 *   - GET  /api/health/records/[date]  (前日 = date - 1)
 *   - GET  /api/ai/menu/meal/pending?date= (日曜始まりの週 = date ± 6)
 *   - POST /api/ai/menu/weekly/request (startDate から 7 日 + 献立生成の文脈の前後 7 日)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: h.getUser }, from: h.from }),
}));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  callGenerateMenuV4WithRetry: vi.fn(),
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/generate-menu-v5-retry', () => ({ callGenerateMenuV5WithRetry: vi.fn() }));
vi.mock('@/lib/ai/consent-guard', () => ({ requireAiConsent: vi.fn(async () => null) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

import { GET as getHealthRecord } from '../src/app/api/health/records/[date]/route';
import { GET as getMealPending } from '../src/app/api/ai/menu/meal/pending/route';
import { POST as postWeeklyRequest } from '../src/app/api/ai/menu/weekly/request/route';

/** 実在するが、受け付ける範囲 (0101-01-02〜9998-12-30) の外の日付 */
const OUT_OF_RANGE_DATES = ['9999-12-31', '9998-12-31', '0101-01-01', '0100-01-01'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  h.from.mockImplementation(() => {
    throw new Error('DB に触れた');
  });
});

describe('GET /api/health/records/[date]: 範囲の外の日付は 400 (前日を求める前に弾く)', () => {
  it.each(OUT_OF_RANGE_DATES)('date=%s は 400 で、DB に触れない', async (date) => {
    const res = await getHealthRecord(new Request(`http://localhost/api/health/records/${date}`) as never, {
      params: Promise.resolve({ date }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'date must be in YYYY-MM-DD format' });
    expect(h.from).not.toHaveBeenCalled();
  });
});

describe('GET /api/ai/menu/meal/pending: 範囲の外の週の日付は 400 (週の端を求める前に弾く)', () => {
  it.each(OUT_OF_RANGE_DATES)('date=%s は 400 で、DB に触れない', async (date) => {
    const res = await getMealPending(new Request(`http://localhost/api/ai/menu/meal/pending?date=${date}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'date must be YYYY-MM-DD' });
    expect(h.from).not.toHaveBeenCalled();
  });
});

describe('POST /api/ai/menu/weekly/request: 範囲の外の開始日は 400 (7 日分の日付を求める前に弾く)', () => {
  it.each(OUT_OF_RANGE_DATES)('startDate=%s は 400 で、認証・DB に触れない', async (startDate) => {
    const res = await postWeeklyRequest(
      new Request('http://localhost/api/ai/menu/weekly/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'startDate must be YYYY-MM-DD' });
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
  });

  it('受け付ける最後の日 (9998-12-30) は日付の確認を通る (次の認証へ進む)', async () => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await postWeeklyRequest(
      new Request('http://localhost/api/ai/menu/weekly/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: '9998-12-30' }),
      }),
    );
    expect(res.status).toBe(401);
    expect(h.getUser).toHaveBeenCalledTimes(1);
  });
});
