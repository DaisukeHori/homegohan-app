/**
 * 健康の記録の API (src/app/api/health/**) と、その入力の検証 (src/lib/health-payloads.ts) が返す失敗の文 (#1917)
 *
 * 問題:
 *   健康の記録の画面 (src/app/(main)/health/**・apps/mobile) は、API の失敗の本文の `error` の文をそのまま利用者に見せる
 *   (例: 目標の画面の `setCreateError(data?.error || …)`)。以前の route は 'Unauthorized'・'Goal not found'・
 *   'record_date must be in YYYY-MM-DD format' のような英語の文を返していたので、失敗したときだけ英語が画面に出た。
 *
 * 決まり:
 *   - 文は日本語の固定の文にする。項目名 (record_date など) は、API を呼ぶ人が直す場所を探せるように括弧で添える
 *   - 401・400 (JSON が読めない)・404 の共通の文は src/lib/api/error-responses.ts の定数を使う。ここには健康の記録に固有の文だけを置く
 *   - このファイルは next/server を読み込まない (src/lib/health-payloads.ts は AI の相談の実行 (src/lib/ai/consultation-action-executor.ts)
 *     からも使われるので、応答を作る部品を引き込まない)
 *   - 英語の文が入っていないことは tests/api-error-japanese-scan.test.ts (src/app/api/health の走査) と
 *     tests/health-api-messages.test.ts が見張る
 */
import { CALENDAR_DATE_MAX, CALENDAR_DATE_MIN } from '@/lib/date-utils';

/**
 * 本文が JSON のオブジェクトでない (src/lib/api/error-responses.ts の API_INVALID_JSON_MESSAGE と同じ文。
 * 同じであることは tests/health-api-messages.test.ts が確かめる)
 */
export const HEALTH_INVALID_BODY_MESSAGE = 'リクエストボディが不正です';

/** 日付の形の説明 (isCalendarDate が受け付ける範囲) */
const CALENDAR_DATE_RULE = `YYYY-MM-DD の形の、${CALENDAR_DATE_MIN} から ${CALENDAR_DATE_MAX} までの実在する日付`;

/** 日付の項目の値が、YYYY-MM-DD の形の実在する日付でない */
export function healthDateInvalidMessage(field: string): string {
  return `${field} は ${CALENDAR_DATE_RULE}で指定してください`;
}

/** URL の日付 (/api/health/records/[date]) が、YYYY-MM-DD の形の実在する日付でない */
export const HEALTH_DATE_PARAM_INVALID_MESSAGE = `日付 (date) は ${CALENDAR_DATE_RULE}で指定してください`;
/** 記録の日付 (record_date) が、YYYY-MM-DD の形の実在する日付でない */
export const HEALTH_RECORD_DATE_INVALID_MESSAGE = `記録の日付 (record_date) は ${CALENDAR_DATE_RULE}で指定してください`;
/** 記録の日付 (record_date) が無い */
export const HEALTH_RECORD_DATE_REQUIRED_MESSAGE = '記録の日付 (record_date) を指定してください';
/** 健康の記録の項目が 1 つも無い */
export const HEALTH_RECORD_NO_FIELDS_MESSAGE = '保存する健康の記録の項目がありません';
/** クイック記録で、値の入った項目が 1 つも無い */
export const HEALTH_QUICK_METRIC_REQUIRED_MESSAGE = '体重・体脂肪率・筋肉量・気分・睡眠の質のうち、少なくとも 1 つを入力してください';
/** クイック記録の source が文字列でない */
export const HEALTH_QUICK_SOURCE_INVALID_MESSAGE = '記録の方法 (source) は文字列で指定してください';

/** 目標が見つからない (他人の目標・消された目標を含む) */
export const HEALTH_GOAL_NOT_FOUND_MESSAGE = '目標が見つかりません';
/** 目標の更新で、更新する項目が 1 つも無い */
export const HEALTH_GOAL_NO_FIELDS_MESSAGE = '更新する目標の項目がありません';
/** 目標の更新で、目標値を空にしようとした */
export const HEALTH_GOAL_TARGET_VALUE_NULL_MESSAGE = '目標値 (target_value) は空にできません';
/** 目標の更新で、単位を空にしようとした */
export const HEALTH_GOAL_TARGET_UNIT_NULL_MESSAGE = '単位 (target_unit) は空にできません';
/** 目標の作成で、必須の項目が足りない */
export const HEALTH_GOAL_REQUIRED_FIELDS_MESSAGE =
  '目標の種類 (goal_type)・目標値 (target_value)・単位 (target_unit) を指定してください';

/** 健康診断の記録が見つからない (他人の記録・消された記録を含む) */
export const HEALTH_CHECKUP_NOT_FOUND_MESSAGE = '健康診断の記録が見つかりません';
/** 健康診断の受診日 (checkup_date) が無い */
export const HEALTH_CHECKUP_DATE_REQUIRED_MESSAGE = '受診日 (checkup_date) を指定してください';
/** 健康診断の更新で、受診日を空にしようとした */
export const HEALTH_CHECKUP_DATE_NULL_MESSAGE = '受診日 (checkup_date) は空にできません';
/** 健康診断の更新で、更新する項目が 1 つも無い */
export const HEALTH_CHECKUP_NO_FIELDS_MESSAGE = '更新する健康診断の項目がありません';

/** 血液検査の検査日 (test_date) が無い */
export const HEALTH_BLOOD_TEST_DATE_REQUIRED_MESSAGE = '検査日 (test_date) を指定してください';

/** 通知の設定の更新で、更新する項目が 1 つも無い */
export const HEALTH_PREFERENCES_NO_FIELDS_MESSAGE = '更新する通知の設定の項目がありません';

/** チャレンジの作成で、テンプレート (template_id) が受け付ける種類でない */
export const HEALTH_CHALLENGE_TEMPLATE_INVALID_MESSAGE = 'チャレンジの種類 (template_id) が正しくありません';

/** 連続記録の種類 (type) が受け付ける種類でない */
export const HEALTH_STREAK_TYPE_INVALID_MESSAGE = '連続記録の種類 (type) が正しくありません';

/** 項目の値が文字列か null でない */
export function healthStringOrNullMessage(field: string): string {
  return `${field} は文字列か null で指定してください`;
}

/** 項目の値が文字列でない */
export function healthStringMessage(field: string): string {
  return `${field} は文字列で指定してください`;
}

/** 項目の値が HH:MM の形の時刻でない */
export function healthTimeMessage(field: string): string {
  return `${field} は HH:MM の形の時刻で指定してください`;
}

/** 項目の値が真偽値でない */
export function healthBooleanMessage(field: string): string {
  return `${field} は true か false で指定してください`;
}

/** 項目の値が数値 (または null) でない。label は画面の項目名 (無ければ項目のキー) */
export function healthNumberMessage(label: string): string {
  return `${label} は数値で指定してください`;
}

/** 項目の値が整数 (または null) でない。label は画面の項目名 (無ければ項目のキー) */
export function healthIntegerMessage(label: string): string {
  return `${label} は整数で指定してください`;
}

/** 項目の値が、受け付ける値のどれでもない */
export function healthEnumMessage(field: string, allowed: readonly string[]): string {
  return `${field} は ${allowed.join(', ')} のいずれかを指定してください`;
}
