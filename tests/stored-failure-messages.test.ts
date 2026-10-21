/**
 * 生成のリクエストの行に書く失敗の文と、画面に出すときの絞り込み (#1478。#1172 の続き)
 *
 * weekly_menu_requests.error_message / shopping_list_requests.result.error は、Web の画面が
 * Realtime・直接の select・状態の確認の API で受けて、そのまま表示する (アプリは weekly_menu_requests.error_message だけを
 * 生成のフックで受ける。買い物リストのネイティブの画面は #1598 で消した)。
 *   1. 保存の結果のまとめ (summarizeSaveResults) は、枠ごとの理由 (例外の文面を含む) を errorMessage に入れず、定型の文だけを返す
 *      (枠ごとの理由は issueDetails でログ用に返す)
 *   2. 上限 (1 日・究極モード #1142) で止めたときの文の見分け (isAiDailyLimitMessage)。
 *      行に書く側 (aiDailyLimitMessageOfDenied) が作りうる文は、読む側がすべて既知の文として通す (契約)
 *   3. 読む側の絞り込み: こちらで書いた文 (定型・同意・上限) はそのまま、それ以外は汎用の文。
 *      Web (src/lib/weekly-menu-request-error.ts) とアプリ (apps/mobile/src/lib/menu-request-error.ts) が同じ答えを出す
 *   4. 買い物リストの状態の確認の API の絞り込み (src/lib/shopping-list-request-error.ts)
 */
import { describe, expect, it } from 'vitest';
import { summarizeSaveResults } from '../supabase/functions/generate-menu-v4/step-utils';
import {
  AI_AUTO_SAFETY_CAP_MESSAGE,
  AI_DAILY_CAPPED_FEATURES,
  AI_DAILY_LIMIT_CODE,
  AI_DAILY_LIMIT_FALLBACK_MESSAGE,
  AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE,
  AI_PLAN_CAPPED_FEATURES,
  aiDailyLimitMessage,
  aiDailyLimitMessageOfBody,
  aiDailyLimitMessageOfDenied,
  aiFeatureDailyLimitMessage,
  aiFeatureNotInPlanMessage,
  aiUltimateModeDailyLimitMessage,
  isAiDailyLimitMessage,
} from '../supabase/functions/_shared/ai-daily-limit';
import { AI_CONSENT_CHECK_FAILED_MESSAGE, AI_CONSENT_REQUIRED_MESSAGE } from '../supabase/functions/_shared/ai-consent';
import {
  MENU_REQUEST_CANCELLED_MESSAGE,
  MENU_REQUEST_EXISTING_PROTECTED_MESSAGE,
  MENU_REQUEST_FAILED_MESSAGE,
  MENU_REQUEST_FIXED_MESSAGES,
  MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE,
  MENU_REQUEST_PARTIAL_SAVE_MESSAGE,
  MENU_REQUEST_STALE_DISPLAY_MESSAGE,
  MENU_REQUEST_STALE_MESSAGE,
  SHOPPING_LIST_REQUEST_FAILED_MESSAGE,
} from '../supabase/functions/_shared/stored-failure-messages';
import {
  WEEKLY_MENU_REQUEST_FAILED_MESSAGE,
  weeklyMenuRequestErrorMessageForDisplay,
  weeklyMenuRequestErrorMessageForResponse,
} from '../src/lib/weekly-menu-request-error';
import {
  shoppingListRequestErrorMessageForDisplay,
  shoppingListRequestErrorMessageForResponse,
} from '../src/lib/shopping-list-request-error';
import { menuRequestErrorMessageForDisplay } from '../apps/mobile/src/lib/menu-request-error';

/** 例外の文面・DB の生のエラー文の例 (画面に出してはいけないもの) */
const RAW_MESSAGES = [
  'duplicate key value violates unique constraint "planned_meals_pkey"',
  'relation "public.secret_table" does not exist',
  'Fast LLM API error: 500 - {"error":"upstream"}',
  'TypeError: Cannot read properties of undefined (reading \'date\')',
  '2026-10-10:dinner: timeout',
  // 上限の文に似せた、回数が数字でない・後ろに文が付いた文 (上限の文としては扱わない)
  '今日の AI の利用回数の上限 (x 回) に達しました。明日 0 時から使えます。',
  `${aiDailyLimitMessage(10)} detail: secret`,
  // 究極モードの上限の文 (#1142) に似せた文: 回数が負・数字でない・先頭に 0・1 文字違う・後ろに文が付いた・機能名だけ違う
  '今日の究極モードの利用回数の上限 (-1 回) に達しました。明日 0 時から使えます。',
  '今日の究極モードの利用回数の上限 (x 回) に達しました。明日 0 時から使えます。',
  '今日の究極モードの利用回数の上限 (01 回) に達しました。明日 0 時から使えます。',
  '今日の究極モードの利用回数の上限 (1 回) に達しました。明日 1 時から使えます。',
  `${aiUltimateModeDailyLimitMessage(1)} detail: secret`,
  '今日の秘密モードの利用回数の上限 (1 回) に達しました。明日 0 時から使えます。',
];

describe('summarizeSaveResults: 行の error_message には枠ごとの理由 (例外の文面) を入れない (#1478)', () => {
  const RAW = 'duplicate key value violates unique constraint "planned_meals_pkey"';

  it('1 件も保存できず失敗がある: 状態は failed、errorMessage は失敗の定型の文、理由は issueDetails にだけ入る', () => {
    const summary = summarizeSaveResults({
      totalSlots: 2,
      savedCount: 0,
      skipped: [],
      errors: [
        { key: '2026-10-10:lunch', error: RAW },
        { key: '2026-10-10:dinner', error: 'timeout' },
      ],
      successMessage: '全2件の献立が完成しました！',
    });
    expect(summary.status).toBe('failed');
    expect(summary.errorMessage).toBe(MENU_REQUEST_FAILED_MESSAGE);
    expect(summary.errorMessage).not.toContain('duplicate key');
    expect(summary.issueDetails).toEqual([`2026-10-10:lunch: ${RAW}`, '2026-10-10:dinner: timeout']);
  });

  it('一部だけ保存した: 状態は completed、errorMessage は一部だけ保存の定型の文', () => {
    const summary = summarizeSaveResults({
      totalSlots: 3,
      savedCount: 1,
      skipped: [{ key: '2026-10-10:breakfast', error: '既存献立を保護したため未保存' }],
      errors: [{ key: '2026-10-10:dinner', error: RAW }],
      successMessage: '全3件の献立が完成しました！',
    });
    expect(summary.status).toBe('completed');
    expect(summary.errorMessage).toBe(MENU_REQUEST_PARTIAL_SAVE_MESSAGE);
    expect(summary.issueDetails).toHaveLength(2);
  });

  it('失敗が無く、既存の献立を守った枠だけがある (一部保存): 一部だけ保存の定型の文', () => {
    const summary = summarizeSaveResults({
      totalSlots: 2,
      savedCount: 1,
      skipped: [{ key: '2026-10-10:breakfast', error: '既存献立を保護したため未保存' }],
      errors: [],
      successMessage: '全2件の献立が完成しました！',
    });
    expect(summary.status).toBe('completed');
    expect(summary.errorMessage).toBe(MENU_REQUEST_PARTIAL_SAVE_MESSAGE);
  });

  it('すべて既存の献立を守って保存しなかった: 状態は failed、errorMessage は既存の献立を守った定型の文', () => {
    const summary = summarizeSaveResults({
      totalSlots: 1,
      savedCount: 0,
      skipped: [{ key: '2026-10-10:breakfast', error: '既存スロット 2026-10-10/breakfast を保護しました（plannedMealId 未指定）' }],
      errors: [],
      successMessage: '全1件の献立が完成しました！',
    });
    expect(summary.status).toBe('failed');
    expect(summary.errorMessage).toBe(MENU_REQUEST_EXISTING_PROTECTED_MESSAGE);
  });

  it('すべて保存した: errorMessage は null、issueDetails は空', () => {
    const summary = summarizeSaveResults({
      totalSlots: 1,
      savedCount: 1,
      skipped: [],
      errors: [],
      successMessage: '全1件の献立が完成しました！',
    });
    expect(summary.errorMessage).toBeNull();
    expect(summary.issueDetails).toEqual([]);
  });

  it('errorMessage はどの組み合わせでも、こちらで書いた定型の文か null (読む側の既知の文に入っている)', () => {
    for (const savedCount of [0, 1]) {
      for (const skippedCount of [0, 1]) {
        for (const errorCount of [0, 1]) {
          const summary = summarizeSaveResults({
            totalSlots: 3,
            savedCount,
            skipped: Array.from({ length: skippedCount }, (_, i) => ({ key: `s${i}`, error: '既存献立を保護したため未保存' })),
            errors: Array.from({ length: errorCount }, (_, i) => ({ key: `e${i}`, error: RAW })),
            successMessage: '完成',
          });
          if (summary.errorMessage !== null) {
            expect(MENU_REQUEST_FIXED_MESSAGES).toContain(summary.errorMessage);
            expect(weeklyMenuRequestErrorMessageForDisplay(summary.errorMessage)).toBe(summary.errorMessage);
          }
        }
      }
    }
  });
});

describe('isAiDailyLimitMessage: 上限 (1 日・究極モード) で止めたときの文の見分け', () => {
  it('aiDailyLimitMessage(n)・回数の分からないときの文・安全弁の文は上限の文', () => {
    for (const value of [aiDailyLimitMessage(0), aiDailyLimitMessage(10), aiDailyLimitMessage(300), AI_DAILY_LIMIT_FALLBACK_MESSAGE, AI_AUTO_SAFETY_CAP_MESSAGE]) {
      expect(isAiDailyLimitMessage(value)).toBe(true);
    }
  });

  it('(#1142) 究極モードの 1 日の上限の文 aiUltimateModeDailyLimitMessage(n) も上限の文', () => {
    for (const value of [aiUltimateModeDailyLimitMessage(0), aiUltimateModeDailyLimitMessage(1), aiUltimateModeDailyLimitMessage(5)]) {
      expect(isAiDailyLimitMessage(value)).toBe(true);
    }
  });

  it('(#1142 契約) 行に書く側 (aiDailyLimitMessageOfDenied) と応答の本文から作る側 (aiDailyLimitMessageOfBody) が作りうる文は、すべて上限の文として通る', () => {
    const limits = [0, 1, 3, 10];
    const denieds = limits.flatMap((limit) => [
      { limit },
      { limit, safetyCap: true as const },
      ...AI_DAILY_CAPPED_FEATURES.map((cappedFeature) => ({ limit, cappedFeature })),
    ]);
    for (const denied of denieds) {
      const written = aiDailyLimitMessageOfDenied(denied);
      expect(isAiDailyLimitMessage(written)).toBe(true);
      const shown = aiDailyLimitMessageOfBody({ code: AI_DAILY_LIMIT_CODE, ...denied });
      expect(shown).not.toBeNull();
      expect(isAiDailyLimitMessage(shown)).toBe(true);
    }
    // 回数の分からない本文 (limit なし) の文も通る
    expect(isAiDailyLimitMessage(aiDailyLimitMessageOfBody({ code: AI_DAILY_LIMIT_CODE }))).toBe(true);
  });

  it('似せた文・文字列でない値・空は上限の文ではない', () => {
    for (const value of [...RAW_MESSAGES, '', null, undefined, 10, { limit: 10 }]) {
      expect(isAiDailyLimitMessage(value)).toBe(false);
    }
  });
});

describe('画面に出すときの絞り込み (Web とアプリが同じ答え)', () => {
  // 進まなくなった行の英語の印は、そのままではなく日本語の文にして出す (下の #1576 のテストで見る)
  const KNOWN = [
    ...MENU_REQUEST_FIXED_MESSAGES.filter((message) => message !== MENU_REQUEST_STALE_MESSAGE),
    AI_CONSENT_REQUIRED_MESSAGE,
    AI_CONSENT_CHECK_FAILED_MESSAGE,
    aiDailyLimitMessage(10),
    AI_DAILY_LIMIT_FALLBACK_MESSAGE,
    // 究極モードの 1 日の上限 (#1142) で止めたとき、generate-menu-v4 / v5 が行に書く文
    aiDailyLimitMessageOfDenied({ limit: 1, cappedFeature: 'menu_generation_ultimate' }),
    aiUltimateModeDailyLimitMessage(3),
  ];

  it.each(KNOWN)('こちらで書いた文 %s はそのまま出す', (stored) => {
    expect(weeklyMenuRequestErrorMessageForDisplay(stored)).toBe(stored);
    expect(weeklyMenuRequestErrorMessageForResponse(stored)).toBe(stored);
    expect(menuRequestErrorMessageForDisplay(stored)).toBe(stored);
  });

  it.each(RAW_MESSAGES)('こちらで書いた文でない %s は汎用の文に寄せる', (stored) => {
    expect(weeklyMenuRequestErrorMessageForDisplay(stored)).toBe(MENU_REQUEST_FAILED_MESSAGE);
    expect(menuRequestErrorMessageForDisplay(stored)).toBe(MENU_REQUEST_FAILED_MESSAGE);
  });

  it('使えない機能の文 (AI_PLAN_CAPPED_FEATURES の 4 つの aiFeatureNotInPlanMessage と AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE)・機能ごとの上限の文 (aiFeatureDailyLimitMessage)・aiDailyLimitMessageOfDenied が planLocked と AI_PLAN_CAPPED_FEATURES の cappedFeature から作る文は、Web (weeklyMenuRequestErrorMessageForDisplay / ForResponse) とアプリ (menuRequestErrorMessageForDisplay) がどちらもそのまま出す', () => {
    // billing/03 §8.8: 行に書く側 (generate-menu-v4 / v5 の aiDailyLimitMessageOfDenied) が作りうる新しい文を、読む側がすべて通す
    const stored = [
      ...AI_PLAN_CAPPED_FEATURES.map((feature) => aiFeatureNotInPlanMessage(feature)),
      AI_FEATURE_NOT_IN_PLAN_FALLBACK_MESSAGE,
      ...AI_PLAN_CAPPED_FEATURES.flatMap((feature) => [aiFeatureDailyLimitMessage(feature, 3), aiFeatureDailyLimitMessage(feature, 15)]),
      ...AI_PLAN_CAPPED_FEATURES.map((feature) => aiDailyLimitMessageOfDenied({ limit: 0, cappedFeature: feature, planLocked: true })),
      ...AI_PLAN_CAPPED_FEATURES.map((feature) => aiDailyLimitMessageOfDenied({ limit: 10, cappedFeature: feature })),
    ];
    for (const message of stored) {
      expect(weeklyMenuRequestErrorMessageForDisplay(message), message).toBe(message);
      expect(weeklyMenuRequestErrorMessageForResponse(message), message).toBe(message);
      expect(menuRequestErrorMessageForDisplay(message), message).toBe(message);
    }
    // 似せた文 (機能名だけ違う・後ろに文が付いた) は汎用の文に寄せる
    for (const fake of ['写真の解析は、有料プランでお使いいただけます。', `${aiFeatureNotInPlanMessage('image_generation')} detail: secret`]) {
      expect(weeklyMenuRequestErrorMessageForDisplay(fake), fake).toBe(MENU_REQUEST_FAILED_MESSAGE);
      expect(menuRequestErrorMessageForDisplay(fake), fake).toBe(MENU_REQUEST_FAILED_MESSAGE);
    }
  });

  it('空 (null・undefined・空文字) は null (画面は自分の既定の文を出す)。文字列でない値は汎用の文', () => {
    for (const stored of [null, undefined, '']) {
      expect(weeklyMenuRequestErrorMessageForDisplay(stored)).toBeNull();
      expect(menuRequestErrorMessageForDisplay(stored)).toBeNull();
    }
    for (const stored of [42, { message: 'raw' }]) {
      expect(weeklyMenuRequestErrorMessageForDisplay(stored)).toBe(MENU_REQUEST_FAILED_MESSAGE);
      expect(menuRequestErrorMessageForDisplay(stored)).toBe(MENU_REQUEST_FAILED_MESSAGE);
    }
  });

  // #1576: 'stale_request_timeout' は状態の確認の API と画面の失敗の表示で英語のまま利用者に出ていた
  it('進まなくなった行の英語の印は、Web とアプリのどちらも日本語の文にして出す (#1576)', () => {
    expect(weeklyMenuRequestErrorMessageForDisplay(MENU_REQUEST_STALE_MESSAGE)).toBe(MENU_REQUEST_STALE_DISPLAY_MESSAGE);
    expect(weeklyMenuRequestErrorMessageForResponse(MENU_REQUEST_STALE_MESSAGE)).toBe(MENU_REQUEST_STALE_DISPLAY_MESSAGE);
    expect(menuRequestErrorMessageForDisplay(MENU_REQUEST_STALE_MESSAGE)).toBe(MENU_REQUEST_STALE_DISPLAY_MESSAGE);
    expect(MENU_REQUEST_STALE_DISPLAY_MESSAGE).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    expect(MENU_REQUEST_STALE_DISPLAY_MESSAGE).not.toMatch(/[A-Za-z]/);
  });

  it('出した文をもう一度通しても同じ文 (状態の確認の API が置き換えた文を画面が通しても変わらない。#1576)', () => {
    for (const stored of [...MENU_REQUEST_FIXED_MESSAGES, ...KNOWN, ...RAW_MESSAGES]) {
      const web = weeklyMenuRequestErrorMessageForDisplay(stored);
      const mobile = menuRequestErrorMessageForDisplay(stored);
      expect(mobile).toBe(web);
      expect(weeklyMenuRequestErrorMessageForDisplay(web)).toBe(web);
      expect(menuRequestErrorMessageForDisplay(mobile)).toBe(mobile);
    }
  });

  it('Web の固定の文は Edge Function と共用の定型の文と同じ値 (2 か所に別々に持たない)', () => {
    expect(WEEKLY_MENU_REQUEST_FAILED_MESSAGE).toBe(MENU_REQUEST_FAILED_MESSAGE);
    expect(MENU_REQUEST_STALE_MESSAGE).toBe('stale_request_timeout');
    expect(MENU_REQUEST_CANCELLED_MESSAGE).toBe('中止しました');
  });
});

describe('買い物リストの状態の確認の API の絞り込み (result.error)', () => {
  it('定型の文・同意の文・上限の文はそのまま、それ以外は定型の失敗の文', () => {
    for (const stored of [SHOPPING_LIST_REQUEST_FAILED_MESSAGE, AI_CONSENT_REQUIRED_MESSAGE, aiDailyLimitMessage(10)]) {
      expect(shoppingListRequestErrorMessageForResponse(stored)).toBe(stored);
    }
    for (const stored of RAW_MESSAGES) {
      expect(shoppingListRequestErrorMessageForResponse(stored)).toBe(SHOPPING_LIST_REQUEST_FAILED_MESSAGE);
    }
  });
});

// #1576: Edge Function の入口の targetSlots の判定 (findInvalidTargetSlotDate) の英語の文を行に書いていた
describe('targetSlots の日付が正しくなかったときの文 (#1576)', () => {
  it('定型の文の一覧に入っていて、日本語の文 (英字を含まない)。画面はそのまま出す', () => {
    expect(MENU_REQUEST_FIXED_MESSAGES).toContain(MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE);
    expect(MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    expect(MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE).not.toMatch(/[A-Za-z]/);
    expect(weeklyMenuRequestErrorMessageForDisplay(MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE)).toBe(
      MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE,
    );
    expect(menuRequestErrorMessageForDisplay(MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE)).toBe(
      MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE,
    );
  });

  it('判定の英語の文 (以前は行に書いていた値) は、画面では汎用の文になる (行に書いてはいけない文)', () => {
    for (const stored of ['targetSlots[0] is not an object', 'targetSlots[1].date must be YYYY-MM-DD']) {
      expect(weeklyMenuRequestErrorMessageForDisplay(stored)).toBe(MENU_REQUEST_FAILED_MESSAGE);
      expect(menuRequestErrorMessageForDisplay(stored)).toBe(MENU_REQUEST_FAILED_MESSAGE);
    }
  });
});

// #1576: 買い物リストの作り直しの行 (result.error) を Realtime で受ける画面の絞り込み
// (アプリの買い物リストのネイティブの画面は、通常の操作で届かない画面として消した (#1598)。アプリは WebView で Web の画面を出すので、
// 絞り込みは Web の関数だけを確かめる)
describe('買い物リストの作り直しの行を画面に出すときの絞り込み (#1576)', () => {
  const KNOWN_SHOPPING = [SHOPPING_LIST_REQUEST_FAILED_MESSAGE, AI_CONSENT_REQUIRED_MESSAGE, AI_CONSENT_CHECK_FAILED_MESSAGE, aiDailyLimitMessage(10)];

  it.each(KNOWN_SHOPPING)('こちらで書いた文 %s はそのまま出す', (stored) => {
    expect(shoppingListRequestErrorMessageForDisplay(stored)).toBe(stored);
  });

  it.each(RAW_MESSAGES)('こちらで書いた文でない %s は定型の失敗の文に寄せる', (stored) => {
    expect(shoppingListRequestErrorMessageForDisplay(stored)).toBe(SHOPPING_LIST_REQUEST_FAILED_MESSAGE);
  });

  it('空 (null・undefined・空文字) は null (画面は自分の既定の文を出す)。文字列でない値は定型の失敗の文', () => {
    for (const stored of [null, undefined, '']) {
      expect(shoppingListRequestErrorMessageForDisplay(stored)).toBeNull();
    }
    for (const stored of [42, { message: 'raw' }]) {
      expect(shoppingListRequestErrorMessageForDisplay(stored)).toBe(SHOPPING_LIST_REQUEST_FAILED_MESSAGE);
    }
  });
});
