/**
 * AI の API (src/app/api/ai/**) が返す本文の日本語の固定の文と code (#1917 の ai の配下)
 *
 * 問題:
 *   Web の画面 (食事の記録・献立表・AI 相談・健康の記録) とモバイルは、AI の API の失敗の本文の文
 *   (`error` / `message`) をそのまま利用者に見せる (例: src/app/(main)/meals/new/page.tsx は `message || error` を alert に出す)。
 *   route ごとに 'Image is required'・'Not found'・'Meal not found' のような英語の文を返していたので、失敗したときだけ英語が画面に出ていた。
 *
 * 決まり:
 *   - 401 / 403 / 404 / 500 の汎用の文は src/lib/api/error-responses.ts の定数を使う。ここには AI の route に固有の文だけを置く
 *   - 写真の読み取りの失敗 (422) の本文は `{ error: '<文>', code: '<コード>', message: '<文>' }`。
 *     以前は `error` に code ('mode_mismatch' / 'unknown_type') を入れていたが、画面は `message` → `error` の順に文を出すので、
 *     `error` も日本語の文にして、code は `code` に移した (Web の画面・モバイルに `error` の code で分岐している所は無い)
 *   - 英語の文が入っていないことは、tests/api-error-japanese-scan.test.ts が src/app/api/ai の全 route を走査して見張る
 *     (配下の一覧は tests/helpers/api-error-japanese-scope.ts)
 *   - route の外の文 (この文の定数と関数・相談の提案の実行の結果 src/lib/ai/consultation-action-executor.ts の result.error と
 *     検証の失敗の文 (errors.push / errors: [...])) は tests/ai-api-error-messages.test.ts が見張る
 */
import { CALENDAR_DATE_REQUIREMENT_JA, invalidCalendarDateMessage } from '@/lib/api/user-api-error-messages';

// ===== 写真の読み取り (analyze-* / classify-photo) =====

/** 400: 写真 (画像の本文・URL) が送られていない */
export const AI_IMAGE_REQUIRED_MESSAGE = '写真が送られていません。写真を選び直してください';
/** 500: 写真の解析 (Edge Function・AI) が失敗した。原因はログにだけ残す */
export const AI_PHOTO_ANALYSIS_FAILED_MESSAGE = '写真を解析できませんでした。時間をおいてもう一度お試しください';
/** 200: 写真の解析を裏で始めた (食事に紐づけて解析するとき。結果は Realtime で届く) */
export const AI_PHOTO_ANALYSIS_STARTED_MESSAGE = '写真の解析を始めました';
/** 422 の code: 写真から、選んだ種類 (食事・冷蔵庫・健康診断・体重計) の中身が読み取れなかった */
export const AI_PHOTO_MODE_MISMATCH_CODE = 'mode_mismatch';
/** 422 の code: 写真の種類を判定できなかった (classify-photo) */
export const AI_PHOTO_UNKNOWN_TYPE_CODE = 'unknown_type';

// ===== 栄養の推定 (nutrition) =====

/** 400: 栄養の値も写真も送られていない */
export const AI_NUTRITION_INPUT_REQUIRED_MESSAGE = '栄養の値か写真のどちらかを指定してください';
/** 400: 写真の URL が文字列でない */
export const AI_IMAGE_URL_INVALID_MESSAGE = '写真の指定が正しくありません。写真を選び直してください';
/** 500: AI の栄養の推定が失敗した・応答を読めなかった。原因はログにだけ残す */
export const AI_NUTRITION_ESTIMATE_FAILED_MESSAGE = '栄養を推定できませんでした。時間をおいてもう一度お試しください';
/** 400: 栄養の振り返り (nutrition/feedback) の POST に、栄養の値と日付が無い */
export const AI_NUTRITION_FEEDBACK_INPUT_REQUIRED_MESSAGE = '栄養の値と日付を指定してください';
/** 400: 栄養の振り返りの GET に、日付も振り返りの ID も無い */
export const AI_NUTRITION_FEEDBACK_QUERY_REQUIRED_MESSAGE = '日付か振り返りの ID を指定してください';

// ===== 献立 (menu/** ・nutrition-analysis) =====

/**
 * 日付の条件 (YYYY-MM-DD の実在する日付。範囲は isCalendarDate と同じ)。
 * 利用者向けの API と同じ文 (src/lib/api/user-api-error-messages.ts の CALENDAR_DATE_REQUIREMENT_JA。#1917 で 1 つにそろえた)
 */
export const AI_CALENDAR_DATE_REQUIREMENT_JA = CALENDAR_DATE_REQUIREMENT_JA;
/** 400: 日付の項目が条件に合わない (field は利用者に見せる項目の名前)。文の形は invalidCalendarDateMessage と同じ */
export function aiInvalidDateMessage(field: string): string {
  return invalidCalendarDateMessage(field);
}
/** 400: 必須の項目が無い (field は利用者に見せる項目の名前) */
export function aiRequiredFieldMessage(field: string): string {
  return `${field}を指定してください`;
}
/** 404: 指定した日の献立 (user_daily_meals の行) が無い */
export const AI_MENU_DAY_NOT_FOUND_MESSAGE = 'その日の献立が見つかりません';
/** 404: 指定した食事の献立 (planned_meals の行) が無い・本人のものでない */
export const AI_MENU_MEAL_NOT_FOUND_MESSAGE = '献立が見つかりません';
/** 400: 献立の ID の形が正しくない */
export const AI_MENU_MEAL_ID_INVALID_MESSAGE = '献立の指定が正しくありません';
/** 400: 指定した献立の食事の区分が、選んだ枠と違う */
export const AI_MENU_PLANNED_MEAL_TYPE_MISMATCH_MESSAGE = '指定した献立の食事の区分が、選んだ枠と一致しません';
/** 400: 指定した献立の日付が、選んだ枠と違う */
export const AI_MENU_PLANNED_MEAL_DATE_MISMATCH_MESSAGE = '指定した献立の日付が、選んだ枠と一致しません';
/** 409: その枠には献立がすでにある (1 食の生成。作り直しを使う) */
export const AI_MENU_MEAL_ALREADY_EXISTS_MESSAGE = 'この枠にはすでに献立があります。作り直しを使ってください';
/** 500: 生成の受付 (weekly_menu_requests の行) を作れなかった。原因はログにだけ残す */
export const AI_MENU_REQUEST_CREATE_FAILED_MESSAGE = '献立の生成を始められませんでした。時間をおいてもう一度お試しください';
/** 500: 献立の変更 (generate-menu-v4 の呼び出し) が失敗した。原因はログにだけ残す */
export const AI_MENU_REGENERATE_FAILED_MESSAGE = '献立を変更できませんでした。時間をおいてもう一度お試しください';
/** 404: 献立の生成の受付 (weekly_menu_requests の行) が無い・本人のものでない */
export const AI_MENU_REQUEST_NOT_FOUND_MESSAGE = '献立の生成の受付が見つかりません';
/** 400: 献立の変更 (nutrition-analysis の POST) に、日付・食事の区分・指示のどれかが無い */
export const AI_MENU_CHANGE_INPUT_REQUIRED_MESSAGE = '日付・食事の区分・変更の内容を指定してください';
/** 200: 1 食の献立の作り直しを裏で始めた */
export const AI_MENU_MEAL_REGENERATION_STARTED_MESSAGE = '献立の作り直しを始めました';
/** 200: 1 日の献立の作り直しを裏で始めた */
export const AI_MENU_DAY_REGENERATION_STARTED_MESSAGE = '1 日の献立の作り直しを始めました';
/** 200: 献立の生成を裏で始めた (結果は状態の確認・Realtime で届く) */
export const AI_MENU_GENERATION_STARTED_MESSAGE = '献立の生成を始めました';
/** 200: 進まなくなった生成の受付を片付けた / 片付けるものが無かった (menu/weekly/cleanup) */
export const AI_MENU_STUCK_REQUESTS_CLEANED_MESSAGE = '進まなくなった献立の生成を片付けました';
export const AI_MENU_NO_STUCK_REQUESTS_MESSAGE = '進まなくなった献立の生成はありません';

// ===== 献立の生成の枠 (menu/v4・v5 の targetSlots) =====

/** 400: targetSlots が空・配列でない */
export const AI_TARGET_SLOTS_REQUIRED_MESSAGE = '献立を作る枠を 1 つ以上指定してください';
/** 400: targetSlots の数が上限を超えた */
export function aiTargetSlotsTooManyMessage(maxSlots: number, maxDays: number, mealsPerDay: number): string {
  return `献立を作る枠は ${maxSlots} 個 (${maxDays} 日 × ${mealsPerDay} 食) までです`;
}
/** 400: targetSlots の日付の幅が上限を超えた (最も早い日〜最も遅い日を含めて) */
export function aiTargetSlotsSpanTooLongMessage(maxDays: number): string {
  return `献立を作る期間は、最初の日から最後の日まで含めて ${maxDays} 日以内にしてください`;
}
/** 400: targetSlots の 1 つの枠がオブジェクトでない */
export function aiTargetSlotNotObjectMessage(index: number): string {
  return `${index + 1} 番目の枠の指定が正しくありません`;
}
/** 400: targetSlots の 1 つの枠の日付が条件に合わない */
export function aiTargetSlotDateInvalidMessage(index: number): string {
  return invalidCalendarDateMessage(`${index + 1} 番目の枠の日付`);
}
/** 400: targetSlots の 1 つの枠の食事の区分が、受け付ける区分でない。受け付ける英字の値は括弧に入れて添える (healthEnumMessage・MEAL_TYPE_MESSAGE と同じ形。#1917 の続き) */
export function aiTargetSlotMealTypeInvalidMessage(index: number, validMealTypes: readonly string[]): string {
  return `${index + 1} 番目の枠の食事の区分 (mealType) は次のいずれかを指定してください (${validMealTypes.join(' / ')})`;
}
/** 400: targetSlots の 1 つの枠の献立の ID の形が正しくない */
export function aiTargetSlotPlannedMealIdInvalidMessage(index: number): string {
  return `${index + 1} 番目の枠の献立の指定が正しくありません`;
}
/** 400: 同じ日・同じ食事の区分の枠が 2 つ以上ある */
export function aiTargetSlotDuplicateMessage(date: string, mealType: string): string {
  return `同じ枠 (${date} の ${mealType}) が 2 回指定されています`;
}

// ===== 相談 (consultation/**) =====

/** 404: 相談 (ai_consultation_sessions の行) が無い・本人のものでない */
export const AI_CONSULTATION_SESSION_NOT_FOUND_MESSAGE = '相談が見つかりません';
/** 404: 相談の中のメッセージが無い */
export const AI_CONSULTATION_MESSAGE_NOT_FOUND_MESSAGE = 'メッセージが見つかりません';
/** 400: 終了した相談をもう一度終了しようとした */
export const AI_CONSULTATION_SESSION_ALREADY_CLOSED_MESSAGE = 'この相談はすでに終了しています';
/** 400: 重要なメッセージの一覧は、この API では取れない (一覧の API を使う) */
export const AI_CONSULTATION_IMPORTANT_LIST_MOVED_MESSAGE =
  '重要なメッセージの一覧は、/api/ai/consultation/important-messages から取得してください';
/** 404: AI が提案した操作 (ai_action_logs の行) が無い・本人のものでない・処理を待っていない */
export const AI_CONSULTATION_ACTION_NOT_FOUND_MESSAGE = '提案された操作が見つかりません';
/** 400: AI が提案した操作が、すでに実行・却下されている */
export const AI_CONSULTATION_ACTION_ALREADY_PROCESSED_MESSAGE = 'この操作はすでに処理されています';
/** 400: AI が提案した操作の種類に対応していない (ai_action_logs の result にも入る) */
export const AI_CONSULTATION_ACTION_UNKNOWN_TYPE_MESSAGE = 'この種類の操作には対応していません';
/**
 * AI が提案した操作の値が検証を通らなかった (ai_action_logs の result にも入る)。検証が日本語でない文を返したとき、
 * その文の代わりに出す。元の文はログにだけ残す (健康の記録・目標の検証 src/lib/health-payloads.ts は /api/health/** と共有で、
 * 以前は英語の文を返していた。#1983 で日本語の文になったが、英語の文が入り直したときの守りとして残す)
 */
export const AI_CONSULTATION_ACTION_INVALID_VALUES_MESSAGE = '提案された値の形が正しくないため、保存できませんでした';

// ===== 画像の生成 (image/generate) =====

/** 400: 画像の生成の指示 (prompt) が無い */
export const AI_IMAGE_PROMPT_REQUIRED_MESSAGE = '作る画像の内容を指定してください';
