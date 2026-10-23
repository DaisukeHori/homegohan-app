/**
 * 利用者の画面とモバイルが受ける API (献立・食事・買い物リスト・冷蔵庫・パフォーマンス など) の失敗の本文で、
 * 複数の route が同じ意味で返す日本語の固定の文 (#1917)
 *
 * 認可の失敗 (401 / 403)・JSON が読めない (400)・見つからない (404)・内部エラー (500) の文は
 * src/lib/api/error-responses.ts の定数を使う。ここに置くのは、それ以外で複数の route に出てくる文だけ
 * (route に 1 か所しか出ない文は、その route の中に名前付きの定数で置く)。
 */
import { CALENDAR_DATE_MAX, CALENDAR_DATE_MIN } from '@/lib/date-utils';

/**
 * 400 の文で使う、受け付ける日付の説明 (isCalendarDate と同じ範囲)。
 * 英語の CALENDAR_DATE_REQUIREMENT (packages/shared の date-utils) の日本語の版
 */
export const CALENDAR_DATE_REQUIREMENT_JA = `YYYY-MM-DD の形の、${CALENDAR_DATE_MIN} から ${CALENDAR_DATE_MAX} までの実在する日付`;

/** 400: 日付の指定が正しくない。label は「開始日 (startDate)」のような、項目の日本語の名前 (と要求の項目名) */
export function invalidCalendarDateMessage(label: string): string {
  return `${label}は${CALENDAR_DATE_REQUIREMENT_JA}で指定してください`;
}

/** 日付の要求の項目名 → 日本語の名前 (query の date / startDate / endDate) */
export const CALENDAR_DATE_PARAM_LABELS = {
  date: '日付 (date)',
  startDate: '開始日 (startDate)',
  endDate: '終了日 (endDate)',
} as const;

/** 404: 自分の食事が見つからない (他人のもの・消されたものを含む。在るかどうかを区別して見せない) */
export const MEAL_NOT_FOUND_MESSAGE = '食事が見つかりません';

/** 400: 必須の項目が足りない */
export const REQUIRED_FIELDS_MISSING_MESSAGE = '必須の項目が入力されていません';

/** 400: 更新する項目が 1 つも無い */
export const NO_FIELDS_TO_UPDATE_MESSAGE = '更新する項目がありません';

/** 500: 食事 (献立の食事・お試しの記録) を保存できなかった。原因はサーバーのログにだけ残す */
export const MEAL_SAVE_FAILED_MESSAGE = '食事を保存できませんでした。時間をおいて、もう一度お試しください';
