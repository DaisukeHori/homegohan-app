// @vitest-environment node
/**
 * 利用者向けの API の共通の日本語の文 (src/lib/api/user-api-error-messages.ts・src/lib/onboarding-api-errors.ts) と、
 * 本人の請求の 401 の本文 (src/lib/data-subject-requests/requester-http.ts) が日本語であることを確かめる (#1917)
 *
 * 走査の見張り (tests/api-error-japanese-scan.test.ts) は、route の本文に直接書いた文と、名前をたどれる定数しか見ない。
 * ここは、関数で組み立てる文 (invalidCalendarDateMessage) と、本文を別のファイルで組み立てるもの (DSR_UNAUTHENTICATED_BODY の
 * スプレッド) を、値で確かめる
 */
import { describe, expect, it } from 'vitest';
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import {
  CALENDAR_DATE_PARAM_LABELS,
  CALENDAR_DATE_REQUIREMENT_JA,
  MEAL_NOT_FOUND_MESSAGE,
  MEAL_SAVE_FAILED_MESSAGE,
  NO_FIELDS_TO_UPDATE_MESSAGE,
  REQUIRED_FIELDS_MISSING_MESSAGE,
  invalidCalendarDateMessage,
} from '@/lib/api/user-api-error-messages';
import {
  ONBOARDING_INVALID_ANSWERS_MESSAGE,
  ONBOARDING_INVALID_JSON_MESSAGE,
  ONBOARDING_INVALID_REQUEST_BODY_MESSAGE,
  ONBOARDING_UNAUTHENTICATED_MESSAGE,
} from '@/lib/onboarding-api-errors';
import { DSR_UNAUTHENTICATED_BODY } from '@/lib/data-subject-requests/requester-http';
import { CALENDAR_DATE_MAX, CALENDAR_DATE_MIN } from '@/lib/date-utils';
import { CalendarDateSchema } from '@/lib/calendar-date-schema';
import { aiInvalidDateMessage, aiTargetSlotDateInvalidMessage, AI_CALENDAR_DATE_REQUIREMENT_JA } from '@/lib/ai/ai-api-messages';
import { healthDateInvalidMessage, HEALTH_DATE_PARAM_INVALID_MESSAGE } from '@/lib/health-api-messages';
import { isEnglishOnly, JAPANESE, textPartsOf, walkFiles } from '../helpers/api-error-text-scan';

/** 受け付ける日付の説明の文を持ってよい、ただ 1 つのファイル */
const CALENDAR_DATE_REQUIREMENT_SOURCE = 'src/lib/api/user-api-error-messages.ts';
/** 日付の説明の文の目印 (説明を自前で書くと、この語を含む文字列になる) */
const CALENDAR_DATE_REQUIREMENT_MARKER = '実在する日付';
/** 走査する配下 (API の本文の文を作る route と src/lib) */
const DATE_TEXT_SCAN_DIRS = ['src/app/api', 'src/lib'] as const;

describe('日付の 400 の文', () => {
  it('受け付ける範囲は isCalendarDate と同じ (CALENDAR_DATE_MIN〜CALENDAR_DATE_MAX)', () => {
    expect(CALENDAR_DATE_REQUIREMENT_JA).toBe(`YYYY-MM-DD の形の、${CALENDAR_DATE_MIN} から ${CALENDAR_DATE_MAX} までの実在する日付`);
    expect(CALENDAR_DATE_REQUIREMENT_JA).toBe('YYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付');
  });

  it.each([
    ['date', '日付 (date)は'],
    ['startDate', '開始日 (startDate)は'],
    ['endDate', '終了日 (endDate)は'],
  ] as const)('%s の文は項目の日本語の名前で始まり、英語だけの文ではない', (name, head) => {
    const message = invalidCalendarDateMessage(CALENDAR_DATE_PARAM_LABELS[name]);
    expect(message).toBe(`${head}${CALENDAR_DATE_REQUIREMENT_JA}で指定してください`);
    expect(isEnglishOnly(message)).toBe(false);
  });
});

describe('日付の 400 の文を作る所は 1 つ (#1917。健康の記録・AI・Zod の日付の文の作り手が別々の形を持っていた)', () => {
  it('健康の記録・AI の API・Zod の日付の文は、同じ説明 (CALENDAR_DATE_REQUIREMENT_JA) と同じ形 (「名前は説明で指定してください」)', () => {
    expect(healthDateInvalidMessage('record_date')).toBe(invalidCalendarDateMessage('記録の日付 (record_date)'));
    expect(HEALTH_DATE_PARAM_INVALID_MESSAGE).toBe(invalidCalendarDateMessage(CALENDAR_DATE_PARAM_LABELS.date));
    expect(AI_CALENDAR_DATE_REQUIREMENT_JA).toBe(CALENDAR_DATE_REQUIREMENT_JA);
    expect(aiInvalidDateMessage('開始日')).toBe(invalidCalendarDateMessage('開始日'));
    expect(aiTargetSlotDateInvalidMessage(0)).toBe(invalidCalendarDateMessage('1 番目の枠の日付'));
    const parsed = CalendarDateSchema.safeParse('2026-02-30');
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(`${CALENDAR_DATE_REQUIREMENT_JA}を指定してください`);
  });

  it(`src/app/api と src/lib の文字列 (コメントは見ない) で「${CALENDAR_DATE_REQUIREMENT_MARKER}」を書くのは ${CALENDAR_DATE_REQUIREMENT_SOURCE} だけ`, () => {
    const files = DATE_TEXT_SCAN_DIRS.flatMap((dir) => walkFiles(dir, (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)));
    expect(files).toContain(CALENDAR_DATE_REQUIREMENT_SOURCE);
    const writers = files.filter((file) => textPartsOf(file).some((text) => text.includes(CALENDAR_DATE_REQUIREMENT_MARKER)));
    expect(writers).toEqual([CALENDAR_DATE_REQUIREMENT_SOURCE]);
  });
});

describe('共通の固定の文は日本語', () => {
  it.each([
    ['MEAL_NOT_FOUND_MESSAGE', MEAL_NOT_FOUND_MESSAGE, '食事が見つかりません'],
    ['REQUIRED_FIELDS_MISSING_MESSAGE', REQUIRED_FIELDS_MISSING_MESSAGE, '必須の項目が入力されていません'],
    ['NO_FIELDS_TO_UPDATE_MESSAGE', NO_FIELDS_TO_UPDATE_MESSAGE, '更新する項目がありません'],
    ['MEAL_SAVE_FAILED_MESSAGE', MEAL_SAVE_FAILED_MESSAGE, '食事を保存できませんでした。時間をおいて、もう一度お試しください'],
    ['ONBOARDING_INVALID_REQUEST_BODY_MESSAGE', ONBOARDING_INVALID_REQUEST_BODY_MESSAGE, '送信内容が正しくありません'],
    ['ONBOARDING_INVALID_ANSWERS_MESSAGE', ONBOARDING_INVALID_ANSWERS_MESSAGE, '入力内容に誤りがあります'],
  ])('%s', (_name, message, expected) => {
    expect(message).toBe(expected);
    expect(JAPANESE.test(message)).toBe(true);
  });

  it('オンボーディングの画面の対応表の鍵 (サーバーの部品を import しない写し) は、全 API の共通の文と同じ', () => {
    expect(ONBOARDING_UNAUTHENTICATED_MESSAGE).toBe(API_UNAUTHENTICATED_MESSAGE);
    expect(ONBOARDING_INVALID_JSON_MESSAGE).toBe(API_INVALID_JSON_MESSAGE);
  });
});

describe('本人の請求 (/api/account/data-requests/**) の 401 の本文', () => {
  it('文は全 API の共通の日本語の文で、code は従来のまま', () => {
    expect(DSR_UNAUTHENTICATED_BODY).toEqual({ error: API_UNAUTHENTICATED_MESSAGE, code: 'AUTH_UNAUTHENTICATED' });
    expect(isEnglishOnly(DSR_UNAUTHENTICATED_BODY.error)).toBe(false);
  });
});
