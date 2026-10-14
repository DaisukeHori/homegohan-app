/**
 * 生成のリクエストの行に書く、利用者向けの定型の失敗の文 (#1478。#1172 の続き)
 *   - weekly_menu_requests.error_message (generate-menu-v4 / v5 と Next.js の API が書く)
 *   - shopping_list_requests.result.error (regenerate-shopping-list-v2 が書く)
 *
 * どちらの欄も、Web とアプリの画面が Supabase Realtime・直接の select・状態の確認の API で受けて、そのまま表示する。
 * そのため、ここには catch で捕まえた例外の文面・DB (PostgREST) の生のエラー文・外部の AI の応答の本文を入れない。
 * 元の文は、書く側が console と構造化ログ (_shared/db-logger.ts の app_logs) にだけ残す。
 *
 * 行に書いてよい文は、ここの定型の文と、同意の判定で止めたときの文 (_shared/ai-consent.ts の aiConsentDeniedStoredMessage)・
 * 1 日の上限で止めたときの文 (_shared/ai-daily-limit.ts の aiDailyLimitMessage) だけ。
 * 読む側の絞り込み (既知の文だけをそのまま出し、それ以外は汎用の文にする) は、Web は src/lib/weekly-menu-request-error.ts と
 * src/lib/shopping-list-request-error.ts、アプリは apps/mobile/src/lib/menu-request-error.ts。
 *
 * このファイルが守る制約 (崩すと Edge Functions・Next.js・モバイルのどれかが動かなくなる):
 *  - 純粋な TypeScript。import なし、Deno / Node / ブラウザ / React Native 固有の API なし (ai-daily-limit.ts と同じ)。
 *    モバイルが相対パスで import するので、EAS のビルドに入るよう .easignore で残している。
 */

/** 献立の生成の失敗の文 (例外で止まった・1 件も保存できなかった)。画面が error_message の無いときに出す既定の文と同じ */
export const MENU_REQUEST_FAILED_MESSAGE = "献立の生成に失敗しました。もう一度お試しください。";

/** 対象の枠がすべて、すでにある献立を守るために保存されなかったときの文 (状態は failed) */
export const MENU_REQUEST_EXISTING_PROTECTED_MESSAGE = "対象スロットは既存献立を保護したため保存されませんでした。";

/**
 * 一部の枠だけ保存できなかったときの文 (状態は completed。保存できなかった枠がある・既存の献立を守って保存しなかった枠がある)。
 * 件数は progress.message (「保存完了（成功 n/m、スキップ k、エラー e）」) が持つ
 */
export const MENU_REQUEST_PARTIAL_SAVE_MESSAGE = "一部の献立を保存できませんでした。";

/**
 * 進まなくなった行を失敗にしたときの文 (Next.js の src/lib/weekly-menu-request-stale.ts が書く)。
 * 画面に出す文ではなく印 (画面は自分の既定の文を出す) だが、こちらで書いた値なので既知の文に含める
 */
export const MENU_REQUEST_STALE_MESSAGE = "stale_request_timeout";

/** 利用者が中止したときの文 (Next.js の POST /api/ai/menu/weekly/status が書く。UX2-11) */
export const MENU_REQUEST_CANCELLED_MESSAGE = "中止しました";

/**
 * weekly_menu_requests.error_message に書く、こちらで書いた定型の文の一覧 (同意・1 日の上限の文を除く)。
 * 読む側は、これと同意の文 (aiConsentReasonOfStoredError)・上限の文 (isAiDailyLimitMessage) だけをそのまま出す
 */
export const MENU_REQUEST_FIXED_MESSAGES: readonly string[] = Object.freeze([
  MENU_REQUEST_FAILED_MESSAGE,
  MENU_REQUEST_EXISTING_PROTECTED_MESSAGE,
  MENU_REQUEST_PARTIAL_SAVE_MESSAGE,
  MENU_REQUEST_STALE_MESSAGE,
  MENU_REQUEST_CANCELLED_MESSAGE,
]);

/** 買い物リストの作り直しの失敗の文 */
export const SHOPPING_LIST_REQUEST_FAILED_MESSAGE = "買い物リストの再生成に失敗しました。もう一度お試しください。";
