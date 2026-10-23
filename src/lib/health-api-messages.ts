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
import { invalidCalendarDateMessage } from '@/lib/api/user-api-error-messages';

/**
 * 本文が JSON のオブジェクトでない (src/lib/api/error-responses.ts の API_INVALID_JSON_MESSAGE と同じ文。
 * 同じであることは tests/health-api-messages.test.ts が確かめる)
 */
export const HEALTH_INVALID_BODY_MESSAGE = 'リクエストボディが不正です';

/**
 * 健康の記録の入力の項目のキー → 失敗の文に出す日本語の名前 (#1917)。
 * 文には「日本語の名前 (キー)」の形で出す (healthFieldLabel)。英字のキーだけの文 ('daily_note は文字列か…') を画面に出さないため。
 * 数値の項目は src/lib/health-payloads.ts の表の label (単位つき) を使うので、ここには数値の項目の多くは載せない。
 * 利用者が送るキーで引くので、プロトタイプのキー ('constructor' など) に当たらないよう Map で持つ
 */
const HEALTH_FIELD_NAMES: ReadonlyMap<string, string> = new Map([
  // 記録 (health_records)
  ['record_date', '記録の日付'],
  ['start_date', '開始日'],
  ['end_date', '終了日'],
  ['daily_note', '1 日のメモ'],
  ['notes', 'メモ'],
  ['data_source', '記録の取り込み元'],
  // 目標 (health_goals)
  ['goal_type', '目標の種類'],
  ['target_value', '目標値'],
  ['current_value', '現在の値'],
  ['target_unit', '単位'],
  ['target_date', '目標の日付'],
  ['note', 'メモ'],
  // 健康診断・血液検査
  ['checkup_date', '受診日'],
  ['facility_name', '受診した施設'],
  ['checkup_type', '健診の種類'],
  ['image_url', '画像の URL'],
  ['test_date', '検査日'],
  ['test_facility', '検査した施設'],
  // 通知の設定 (health_notification_preferences。画面 src/app/(main)/health/settings/page.tsx の見出しの名前)
  ['enabled', '通知'],
  ['quiet_hours_start', '静かな時間の開始'],
  ['quiet_hours_end', '静かな時間の終了'],
  ['record_mode', '記録モード'],
  ['personality_type', '通知スタイル'],
  ['morning_reminder_enabled', '朝のリマインダー'],
  ['morning_reminder_time', '朝のリマインダーの時刻'],
  ['evening_reminder_enabled', '夜のリマインダー'],
  ['evening_reminder_time', '夜のリマインダーの時刻'],
  ['vacation_mode', 'お休みモード'],
  ['vacation_until', 'お休みモードの終わりの日'],
]);

/** 表に無いキーの日本語の名前 (英字のキーだけの文にしないため、括弧の外は日本語にする) */
const HEALTH_FIELD_FALLBACK_NAME = '項目';

/** 項目のキーを、失敗の文に出す「日本語の名前 (キー)」にする (表に無いキーは「項目 (キー)」) */
export function healthFieldLabel(key: string): string {
  return `${HEALTH_FIELD_NAMES.get(key) ?? HEALTH_FIELD_FALLBACK_NAME} (${key})`;
}

/**
 * 日付の項目の値が、YYYY-MM-DD の形の実在する日付でない。
 * 文の形は利用者向けの API と同じ (src/lib/api/user-api-error-messages.ts の invalidCalendarDateMessage。#1917 で 1 つにそろえた)
 */
export function healthDateInvalidMessage(field: string): string {
  return invalidCalendarDateMessage(healthFieldLabel(field));
}

/** URL の日付 (/api/health/records/[date]) が、YYYY-MM-DD の形の実在する日付でない */
export const HEALTH_DATE_PARAM_INVALID_MESSAGE = invalidCalendarDateMessage('日付 (date)');
/** 記録の日付 (record_date) が、YYYY-MM-DD の形の実在する日付でない */
export const HEALTH_RECORD_DATE_INVALID_MESSAGE = healthDateInvalidMessage('record_date');
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

/** 項目の値が文字列か null でない (field は項目のキー。文には healthFieldLabel の名前で出す) */
export function healthStringOrNullMessage(field: string): string {
  return `${healthFieldLabel(field)} は文字列か null で指定してください`;
}

/** 項目の値が文字列でない (field は項目のキー) */
export function healthStringMessage(field: string): string {
  return `${healthFieldLabel(field)} は文字列で指定してください`;
}

/** 項目の値が HH:MM の形の時刻でない (field は項目のキー) */
export function healthTimeMessage(field: string): string {
  return `${healthFieldLabel(field)} は HH:MM の形の時刻で指定してください`;
}

/** 項目の値が真偽値でない (field は項目のキー) */
export function healthBooleanMessage(field: string): string {
  return `${healthFieldLabel(field)} は true か false で指定してください`;
}

/** 項目の値が数値 (または null) でない。label は画面の項目名 (無ければ healthFieldLabel(項目のキー)) */
export function healthNumberMessage(label: string): string {
  return `${label} は数値で指定してください`;
}

/** 項目の値が整数 (または null) でない。label は画面の項目名 (無ければ healthFieldLabel(項目のキー)) */
export function healthIntegerMessage(label: string): string {
  return `${label} は整数で指定してください`;
}

/** 項目の値が、受け付ける値のどれでもない (field は項目のキー) */
export function healthEnumMessage(field: string, allowed: readonly string[]): string {
  return `${healthFieldLabel(field)} は ${allowed.join(', ')} のいずれかを指定してください`;
}
