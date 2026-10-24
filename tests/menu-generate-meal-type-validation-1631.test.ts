// @vitest-environment node
/**
 * #1631: POST /api/ai/menu/v4/generate・v5/generate の validateTargetSlots は、受け付ける食事の区分の手書き (5 値の配列 +
 * includes) をやめ、正本 (@homegohan/shared の MEAL_ORDER / isMealType) から導く形に書き換えた。
 * 書き換えた判定の結果を固定する。
 *   - 5 値 (夜食 midnight_snack を含む) は区分の確認を通り、次の認証へ進む
 *   - 5 値以外 (未知の値・大文字・前後の空白・日本語・文字列でない値) は、DB・認証・Edge Function に触れる前に 400
 *   - 400 の本文は位置と、受け付ける 5 値を正本の並びで言う (英字の値は括弧の中。#1917 の続き)
 * 期待値はここで手で書く (正本から導いた値と比べると、導き方の誤りを見逃すため)。
 */
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

import { englishIdentifiersOutsideParentheses } from './helpers/api-error-text-scan';
import { POST as postV4Generate } from '../src/app/api/ai/menu/v4/generate/route';
import { POST as postV5Generate } from '../src/app/api/ai/menu/v5/generate/route';

/** 区分の確認に使う、実在する日付 */
const DATE = '2026-10-10';

/** 400 の本文の「受け付ける区分」(手で書いた期待値。正本 MEAL_ORDER の並び。英字の値は括弧の中に ' / ' で並べる: #1917 の続き) */
const MEAL_TYPE_REQUIREMENT = 'breakfast / lunch / dinner / snack / midnight_snack';

/** 区分の確認を通らない値 */
const INVALID_MEAL_TYPES: Array<[string, unknown]> = [
  ['5 値にない値', 'brunch'],
  ['空文字', ''],
  ['大文字で始まる', 'Breakfast'],
  ['後ろに空白', 'lunch '],
  ['日本語の表示名', '朝食'],
  ['数', 5],
  ['null', null],
  ['配列', ['lunch']],
  ['オブジェクト', { mealType: 'dinner' }],
];

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** HTTP の未ログイン (区分の確認を通って認証まで進んだ印) */
const HTTP_UNAUTHORIZED = 401;
/** HTTP の入力の誤り */
const HTTP_BAD_REQUEST = 400;

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
])('$name: targetSlots の mealType は食事の区分の 5 値だけ (#1631)', ({ post }) => {
  it.each(['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'])(
    'mealType=%s は区分の確認を通る (次の認証へ進む)',
    async (mealType) => {
      h.getUser.mockResolvedValue({ data: { user: null }, error: null });
      const res = await post(jsonRequest({ targetSlots: [{ date: DATE, mealType }] }));
      // 区分の確認を通ったので認証まで進み、未ログインの 401 になる
      expect(res.status).toBe(HTTP_UNAUTHORIZED);
      expect(h.getUser).toHaveBeenCalledTimes(1);
    },
  );

  it.each(INVALID_MEAL_TYPES)(
    '5 値以外 (%s) は、DB・認証・Edge Function に触れる前に 400 (本文は位置と受け付ける 5 値)',
    async (_label, mealType) => {
      const res = await post(
        jsonRequest({
          targetSlots: [
            { date: DATE, mealType: 'breakfast' },
            { date: DATE, mealType },
          ],
        }),
      );
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      const body = (await res.json()) as { error: string };
      expect(body).toEqual({
        error: `2 番目の枠の食事の区分 (mealType) は次のいずれかを指定してください (${MEAL_TYPE_REQUIREMENT})`,
      });
      // Web の献立の生成の画面 (useV4MenuGeneration) とモバイルは error をそのまま出すので、英字の項目名・値は括弧の外に出さない (#1917 の続き)
      expect(englishIdentifiersOutsideParentheses(body.error)).toEqual([]);
      expect(h.getUser).not.toHaveBeenCalled();
      expect(h.from).not.toHaveBeenCalled();
      expect(h.callV4).not.toHaveBeenCalled();
      expect(h.callV5).not.toHaveBeenCalled();
    },
  );
});
