// @vitest-environment node
/**
 * 健康の記録の API の失敗の文が日本語であること (#1917・モジュール health)
 *
 * 問題:
 *   健康の記録の画面 (src/app/(main)/health/**) は、API の失敗の本文の `error` の文をそのまま見せる。
 *   route の固定の文は tests/api-error-japanese-scan.test.ts の走査 (src/app/api/health) が見張るが、
 *   入力の検証 (src/lib/health-payloads.ts) が返す文は `errors.join(', ')` で本文に入るので、走査では見えない
 *   (以前は 'weight must be a finite number or null' のような英語の文が画面に出ていた)。
 *
 * このテストが確かめること:
 *   1. src/lib/health-api-messages.ts の文 (定数と、項目名を入れて作る文) が、どれも日本語で、英語だけの文ではない
 *   2. 入力の検証の関数 (sanitize*) に、どの種類の誤り (型・時刻・日付・選択肢・範囲・本文の形・必須) を入れても、
 *      返る文がどれも英語だけの文ではない (誤りの種類を全部通ったことも確かめる)
 *   3. 本文が JSON のオブジェクトでないときの文が、共通の関数の文 (API_INVALID_JSON_MESSAGE) と同じ
 */
import { describe, expect, it } from 'vitest';
import { API_INVALID_JSON_MESSAGE } from '@/lib/api/error-responses';
import * as messages from '@/lib/health-api-messages';
import {
  sanitizeBloodTestPayload,
  sanitizeHealthCheckupPayload,
  sanitizeHealthGoalCreate,
  sanitizeHealthGoalUpdate,
  sanitizeHealthRecordPayload,
  sanitizeNotificationPreferences,
} from '@/lib/health-payloads';
import { JAPANESE, isEnglishOnly } from './helpers/api-error-text-scan';

/** 項目名を入れて作る文の関数に渡す、英語の項目名 (項目名だけが英語でも、文は日本語になること) */
const SAMPLE_FIELD = 'record_date';
const SAMPLE_CHOICES = ['standard', 'minimal'] as const;

/** 入力の検証の関数が見る項目 (src/lib/health-payloads.ts の各 Payload の型の項目の和) */
const ALL_PAYLOAD_KEYS = [
  // 通知の設定
  'enabled', 'quiet_hours_start', 'quiet_hours_end', 'record_mode', 'personality_type', 'morning_reminder_enabled',
  'morning_reminder_time', 'evening_reminder_enabled', 'evening_reminder_time', 'vacation_mode', 'vacation_until',
  // 健康の記録
  'weight', 'body_fat_percentage', 'muscle_mass', 'systolic_bp', 'diastolic_bp', 'heart_rate', 'sleep_hours', 'sleep_quality',
  'mood_score', 'stress_level', 'overall_condition', 'water_intake', 'step_count', 'body_temp', 'bowel_movement', 'energy_level',
  'daily_note', 'notes', 'data_source',
  // 目標
  'goal_type', 'target_value', 'current_value', 'target_unit', 'target_date', 'note',
  // 健康診断・血液検査
  'checkup_date', 'facility_name', 'checkup_type', 'image_url', 'height', 'bmi', 'waist_circumference',
  'blood_pressure_systolic', 'blood_pressure_diastolic', 'hemoglobin', 'hba1c', 'fasting_glucose', 'total_cholesterol',
  'ldl_cholesterol', 'hdl_cholesterol', 'triglycerides', 'ast', 'alt', 'gamma_gtp', 'creatinine', 'egfr', 'uric_acid',
  'test_date', 'test_facility', 'bun',
] as const;

/** どの項目にも入れてみる誤った値 (型の誤り・形の誤り・範囲の外) */
const BAD_VALUES: readonly unknown[] = [
  { nested: true }, // 文字列でも数値でも真偽値でもない
  'abc', // 数値でない文字列・選択肢に無い文字列・時刻でない文字列・日付でない文字列
  '0x10', // 16進数の文字列
  1.5, // 整数でない数値
  true, // 真偽値 (文字列・数値の項目には誤り)
  '2026-02-30', // 実在しない日付
  '25:99', // 時刻の形だが実在しない
  -1_000_000, // 下限より小さい
  1_000_000, // 上限より大きい
];

/** 誤りの文の種類 (全部の種類を通ったことを確かめるための目印) */
const MESSAGE_KINDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['文字列か null', /は文字列か null で指定してください$/],
  ['文字列', /は文字列で指定してください$/],
  ['時刻', /は HH:MM の形の時刻で指定してください$/],
  ['真偽値', /は true か false で指定してください$/],
  ['数値', /は数値で指定してください$/],
  ['整数', /は整数で指定してください$/],
  ['選択肢', /のいずれかを指定してください$/],
  ['日付', /は YYYY-MM-DD の形の、.+までの実在する日付で指定してください$/],
  ['下限', /以上の値を入力してください$/],
  ['上限', /以下の値を入力してください$/],
  ['本文の形', /^リクエストボディが不正です$/],
  ['必須', /^目標の種類 \(goal_type\)・目標値 \(target_value\)・単位 \(target_unit\) を指定してください$/],
];

function allValidatorErrors(): string[] {
  const errors: string[] = [];
  const sanitizers: ReadonlyArray<(input: unknown) => { errors: string[] }> = [
    sanitizeNotificationPreferences,
    (input) => sanitizeHealthRecordPayload(input, { acceptLegacyNotes: true }),
    (input) => sanitizeHealthGoalUpdate(input, { goalType: 'weight' }),
    (input) => sanitizeHealthGoalUpdate(input),
    sanitizeHealthGoalCreate,
    sanitizeHealthCheckupPayload,
    sanitizeBloodTestPayload,
  ];
  for (const sanitize of sanitizers) {
    // 本文が JSON のオブジェクトでない
    for (const body of [null, undefined, 'text', 5, ['weight']]) errors.push(...sanitize(body).errors);
    // 1 つの項目にだけ誤った値を入れる
    for (const key of ALL_PAYLOAD_KEYS) {
      for (const value of BAD_VALUES) errors.push(...sanitize({ [key]: value }).errors);
    }
  }
  // 目標の作成の必須の不足 (形の誤りが無いとき)
  errors.push(...sanitizeHealthGoalCreate({ goal_type: 'weight', target_value: 60 }).errors);
  return errors;
}

describe('健康の記録の API の文 (src/lib/health-api-messages.ts)', () => {
  const entries = Object.entries(messages);

  it('定数の文は、どれも日本語で、英語だけの文ではない', () => {
    const constants = entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    expect(constants.length).toBeGreaterThan(0);
    for (const [name, text] of constants) {
      expect(JAPANESE.test(text), name).toBe(true);
      expect(isEnglishOnly(text), name).toBe(false);
    }
  });

  it('項目名を入れて作る文は、英語の項目名を入れても日本語の文になる', () => {
    const builders = entries.filter((entry): entry is [string, (...args: never[]) => unknown] => typeof entry[1] === 'function');
    expect(builders.map(([name]) => name).sort()).toEqual(
      [
        'healthBooleanMessage',
        'healthDateInvalidMessage',
        'healthEnumMessage',
        'healthIntegerMessage',
        'healthNumberMessage',
        'healthStringMessage',
        'healthStringOrNullMessage',
        'healthTimeMessage',
      ].sort(),
    );
    const built = [
      messages.healthBooleanMessage(SAMPLE_FIELD),
      messages.healthDateInvalidMessage(SAMPLE_FIELD),
      messages.healthEnumMessage(SAMPLE_FIELD, SAMPLE_CHOICES),
      messages.healthIntegerMessage(SAMPLE_FIELD),
      messages.healthNumberMessage(SAMPLE_FIELD),
      messages.healthStringMessage(SAMPLE_FIELD),
      messages.healthStringOrNullMessage(SAMPLE_FIELD),
      messages.healthTimeMessage(SAMPLE_FIELD),
    ];
    for (const text of built) {
      expect(text.startsWith(`${SAMPLE_FIELD} `), text).toBe(true);
      expect(JAPANESE.test(text), text).toBe(true);
      expect(isEnglishOnly(text), text).toBe(false);
    }
    expect(messages.healthEnumMessage(SAMPLE_FIELD, SAMPLE_CHOICES)).toBe(
      'record_date は standard, minimal のいずれかを指定してください',
    );
    expect(messages.healthDateInvalidMessage(SAMPLE_FIELD)).toBe(
      'record_date は YYYY-MM-DD の形の、0101-01-02 から 9998-12-30 までの実在する日付で指定してください',
    );
  });

  it('本文が JSON のオブジェクトでないときの文は、共通の関数の文と同じ', () => {
    expect(messages.HEALTH_INVALID_BODY_MESSAGE).toBe(API_INVALID_JSON_MESSAGE);
  });
});

describe('入力の検証 (src/lib/health-payloads.ts) が返す文は、英語だけの文ではない', () => {
  const errors = allValidatorErrors();
  const distinct = [...new Set(errors)].sort();

  it('どの誤りの文も日本語を含み、英語だけの文ではない', () => {
    expect(distinct.length).toBeGreaterThan(0);
    expect(distinct.filter((text) => isEnglishOnly(text) || !JAPANESE.test(text))).toEqual([]);
  });

  it.each(MESSAGE_KINDS)('誤りの種類「%s」を通っている (走らせた入力が、その種類の文を作っている)', (_kind, pattern) => {
    expect(distinct.some((text) => pattern.test(text))).toBe(true);
  });

  it('数値の項目の型の誤りは、画面の項目名で知らせる (例: 体重 (kg))', () => {
    expect(sanitizeHealthRecordPayload({ weight: 'abc' }).errors).toEqual(['体重 (kg) は数値で指定してください']);
    expect(sanitizeHealthRecordPayload({ mood_score: 1.5 }).errors).toEqual(['気分スコア (1-5) は整数で指定してください']);
    // 種類が分からない目標の値は「目標値」で知らせる (src/lib/health-payloads.ts の goalValueOpts)
    expect(sanitizeHealthGoalUpdate({ target_value: 'abc' }).errors).toEqual(['目標値 は数値で指定してください']);
  });
});
