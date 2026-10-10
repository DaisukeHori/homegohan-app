// @vitest-environment node
/**
 * #1433: 献立生成に渡す日付 (targetSlots の date など) は、YYYY-MM-DD の実在する日付だけを入口で受け付ける。
 *
 * 以前の POST /api/ai/menu/v4/generate・v5/generate の validateTargetSlots は日付の形 (正規表現) しか見なかったので、
 * 2026-02-30 のような存在しない日付が通り、前後 7 日の文脈の期間を求める addDaysToDate が RangeError を投げて 500 になっていた。
 * 献立生成の Edge Function (generate-menu-v4 / v5) の工程 1 も、DB の target_slots が空のときは本文の targetSlots の日付を
 * addDays に渡すので、2026/10/10 のような値 (DB の date 型は日付として読むが、YYYY-MM-DD ではない) が届くと裏の処理が落ちていた。
 *
 * ここでは
 *   - Next.js の 4 本 (v4 / v5 の generate・1 食の generate・栄養分析の献立変更の POST) が、DB に触れる前・Edge Function を呼ぶ前に 400 にすること
 *   - Edge Function の入口の判定 (findInvalidTargetSlotDate / isCalendarDate) と、それをハンドラが AI へ送る前に呼んでいること
 * を確かめる。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  callV4: vi.fn(),
  callV5: vi.fn(),
  requireAiConsent: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: h.getUser }, from: h.from }),
}));
vi.mock('@/lib/generate-menu-v4-retry', () => ({
  callGenerateMenuV4WithRetry: h.callV4,
  markWeeklyMenuRequestFailed: vi.fn(),
}));
vi.mock('@/lib/generate-menu-v5-retry', () => ({ callGenerateMenuV5WithRetry: h.callV5 }));
vi.mock('@/lib/ai/consent-guard', () => ({
  requireAiConsent: h.requireAiConsent,
  checkUserAiConsent: vi.fn(),
  aiConsentSkippedField: vi.fn(() => ({})),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.checkRateLimit,
  rateLimitExceededResponse: vi.fn(),
}));
vi.mock('@/lib/feature-flags', () => ({ isFeatureEnabled: vi.fn(async () => false) }));
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

import { POST as postV4Generate } from '../src/app/api/ai/menu/v4/generate/route';
import { POST as postV5Generate } from '../src/app/api/ai/menu/v5/generate/route';
import { POST as postMealGenerate } from '../src/app/api/ai/menu/meal/generate/route';
import { POST as postNutritionAnalysisChange } from '../src/app/api/ai/nutrition-analysis/route';
import { findInvalidTargetSlotDate } from '../supabase/functions/generate-menu-v4/step-utils';
import { isCalendarDate as isCalendarDateEdge } from '../supabase/functions/_shared/jst-date';
import { isCalendarDate as isCalendarDateNext } from '../src/lib/date-utils';

/** 実在しない日付・YYYY-MM-DD ではない日付 (DB の date 型が日付として読むものも含む) */
const INVALID_DATES = [
  '2026-02-30', // 存在しない日 (以前は形のチェックを通り、addDaysToDate の RangeError で 500)
  '2027-02-29', // 平年の 2/29
  '2026-13-01', // 13 月
  '2026-10-00', // 0 日
  '2026/10/10', // DB の date 型は日付として読むが、YYYY-MM-DD ではない
  '20261010',
  '2026-10-10T00:00:00Z',
] as const;

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  h.requireAiConsent.mockResolvedValue(null);
  h.checkRateLimit.mockResolvedValue({ success: true });
  h.from.mockImplementation(() => {
    throw new Error('DB に触れた');
  });
});

describe.each([
  { name: 'POST /api/ai/menu/v4/generate', post: postV4Generate },
  { name: 'POST /api/ai/menu/v5/generate', post: postV5Generate },
])('$name: targetSlots の日付は実在する日付だけ (#1433)', ({ post }) => {
  it.each(INVALID_DATES)('date=%s は、DB・認証・Edge Function に触れる前に 400 (本文は { error: 位置を言う文 })', async (date) => {
    const res = await post(
      jsonRequest({
        targetSlots: [
          { date: '2026-10-10', mealType: 'breakfast' },
          { date, mealType: 'lunch' },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'targetSlots[1].date must be YYYY-MM-DD format (an existing calendar date)',
    });
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
    expect(h.callV4).not.toHaveBeenCalled();
    expect(h.callV5).not.toHaveBeenCalled();
  });

  it('うるう年の 2/29・月末・年末の実在する日付は、日付の確認を通る (次の認証へ進む)', async () => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await post(
      jsonRequest({
        targetSlots: [
          { date: '2028-02-29', mealType: 'breakfast' },
          { date: '2026-10-31', mealType: 'lunch' },
          { date: '2026-12-31', mealType: 'dinner' },
        ],
      }),
    );
    // 日付の確認を通ったので認証まで進み、未ログインの 401 になる
    expect(res.status).toBe(401);
    expect(h.getUser).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/ai/menu/meal/generate: dayDate は実在する日付だけ (#1433)', () => {
  it.each(INVALID_DATES)('dayDate=%s は、DB・認証に触れる前に 400', async (dayDate) => {
    const res = await postMealGenerate(jsonRequest({ dayDate, mealType: 'lunch' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'dayDate must be YYYY-MM-DD format (an existing calendar date)' });
    expect(h.getUser).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalled();
    expect(h.callV4).not.toHaveBeenCalled();
    expect(h.callV5).not.toHaveBeenCalled();
  });

  it('実在する日付は日付の確認を通る (次の認証へ進む)', async () => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await postMealGenerate(jsonRequest({ dayDate: '2028-02-29', mealType: 'lunch' }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/ai/nutrition-analysis (献立変更の実行): targetDate は実在する日付だけ (#1433)', () => {
  it.each(INVALID_DATES)('targetDate=%s は、DB に触れる前・Edge Function を呼ぶ前に 400', async (targetDate) => {
    const res = await postNutritionAnalysisChange(
      jsonRequest({ targetDate, targetMealType: 'dinner', prompt: '野菜を増やして' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'targetDate must be YYYY-MM-DD format (an existing calendar date)' });
    expect(h.from).not.toHaveBeenCalled();
    expect(h.callV4).not.toHaveBeenCalled();
  });

  it('実在する日付は日付の確認を通り、その日の行を引きにいく', async () => {
    const tables: string[] = [];
    h.from.mockImplementation((table: string) => {
      tables.push(table);
      const query = {
        select: () => query,
        eq: () => query,
        single: async () => ({ data: null, error: null }),
      };
      return query;
    });
    const res = await postNutritionAnalysisChange(
      jsonRequest({ targetDate: '2026-12-31', targetMealType: 'dinner', prompt: '野菜を増やして' }),
    );
    // 行が無いので 404 (日付の確認は通っている)
    expect(res.status).toBe(404);
    expect(tables).toEqual(['user_daily_meals']);
  });
});

describe('Edge Function (generate-menu-v4 / v5) の入口の判定 findInvalidTargetSlotDate (#1433)', () => {
  it('配列でない (本文に targetSlots が無く、DB の target_slots を使う) ときは null', () => {
    expect(findInvalidTargetSlotDate(undefined)).toBeNull();
    expect(findInvalidTargetSlotDate(null)).toBeNull();
    expect(findInvalidTargetSlotDate({ date: '2026-02-30' })).toBeNull();
  });

  it('全部の要素が実在する日付なら null (うるう年の 2/29・月末・年末)', () => {
    expect(
      findInvalidTargetSlotDate([
        { date: '2028-02-29', mealType: 'breakfast' },
        { date: '2026-10-31', mealType: 'lunch' },
        { date: '2026-12-31', mealType: 'dinner' },
      ]),
    ).toBeNull();
    expect(findInvalidTargetSlotDate([])).toBeNull();
  });

  it.each(INVALID_DATES)('date=%s の要素があれば、その位置を言う文 (Next.js の 400 と同じ文)', (date) => {
    expect(
      findInvalidTargetSlotDate([
        { date: '2026-10-10', mealType: 'breakfast' },
        { date: '2026-10-11', mealType: 'breakfast' },
        { date, mealType: 'lunch' },
      ]),
    ).toBe('targetSlots[2].date must be YYYY-MM-DD format (an existing calendar date)');
  });

  it('date が文字列でない・要素がオブジェクトでないときも文を返す', () => {
    expect(findInvalidTargetSlotDate([{ date: 20261010, mealType: 'lunch' }])).toBe(
      'targetSlots[0].date must be YYYY-MM-DD format (an existing calendar date)',
    );
    expect(findInvalidTargetSlotDate([{ mealType: 'lunch' }])).toBe(
      'targetSlots[0].date must be YYYY-MM-DD format (an existing calendar date)',
    );
    expect(findInvalidTargetSlotDate([null])).toBe('targetSlots[0] is not an object');
    expect(findInvalidTargetSlotDate(['2026-10-10'])).toBe('targetSlots[0] is not an object');
  });

  it('Edge Function の isCalendarDate は、Next.js 側 (packages/shared) の isCalendarDate と同じ答え', () => {
    const samples = [...INVALID_DATES, '2026-10-10', '2028-02-29', '2026-12-31', '2027-01-01', '', ' 2026-10-10', 'yesterday'];
    for (const value of samples) {
      expect(isCalendarDateEdge(value), value).toBe(isCalendarDateNext(value));
    }
    expect(isCalendarDateEdge(undefined)).toBe(false);
    expect(isCalendarDateEdge(20261010)).toBe(false);
  });
});

describe('Edge Function のハンドラが、呼び出し元の確認のあと・AI へ送る前に本文の targetSlots の日付を確かめて 400 にする (#1433)', () => {
  it.each(['generate-menu-v4', 'generate-menu-v5'])('%s/index.ts', (fn) => {
    const source = readFileSync(resolve(__dirname, `../supabase/functions/${fn}/index.ts`), 'utf8');
    const handlerStart = source.indexOf('Deno.serve(');
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = source.slice(handlerStart);
    const ownerCheck = handler.indexOf('weekly_menu_requests.owner_check');
    const slotCheck = handler.indexOf('findInvalidTargetSlotDate(body.targetSlots)');
    const consentCheck = handler.indexOf('checkAiConsent(supabase, userId)');
    const stepRun = handler.indexOf('executeStep');
    expect(ownerCheck).toBeGreaterThan(-1);
    expect(slotCheck).toBeGreaterThan(ownerCheck);
    expect(consentCheck).toBeGreaterThan(slotCheck);
    expect(stepRun).toBeGreaterThan(slotCheck);
    // 判定の直後に 400 で返す
    const afterCheck = handler.slice(slotCheck, consentCheck);
    expect(afterCheck).toContain('if (invalidSlotDate)');
    expect(afterCheck).toContain('status: 400');
  });
});
