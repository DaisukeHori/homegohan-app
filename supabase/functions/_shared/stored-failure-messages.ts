/**
 * 生成のリクエストの行に書く、利用者向けの定型の失敗の文 (#1478。#1172 の続き)
 *   - weekly_menu_requests.error_message (generate-menu-v4 / v5 と Next.js の API が書く)
 *   - shopping_list_requests.result.error (regenerate-shopping-list-v2 が書く)
 *
 * どちらの欄も、Web の画面が Supabase Realtime・直接の select・状態の確認の API で受けて、そのまま表示する
 * (アプリは weekly_menu_requests.error_message だけを、生成のフック useV4MenuGeneration が Realtime・直接の select で受ける。
 * 買い物リストのネイティブの画面は #1598 で消した)。
 * そのため、ここには catch で捕まえた例外の文面・DB (PostgREST) の生のエラー文・外部の AI の応答の本文を入れない。
 * 元の文は、書く側が console と構造化ログ (_shared/db-logger.ts の app_logs) にだけ残す。
 *
 * 行に書いてよい文は、ここの定型の文と、同意の判定で止めたときの文 (_shared/ai-consent.ts の aiConsentDeniedStoredMessage)・
 * 上限 (1 日・機能ごと) とそのプランでは使えない機能 (billing/03) の文 (_shared/ai-daily-limit.ts の aiDailyLimitMessageOfDenied が作る文。
 * 1 日の上限の aiDailyLimitMessage・機能ごとの上限の aiFeatureDailyLimitMessage・使えない機能の aiFeatureNotInPlanMessage など。
 * 読む側は isAiDailyLimitMessage で見分ける) だけ。
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
 * 進まなくなった行を失敗にしたときの印 (Next.js の src/lib/weekly-menu-request-stale.ts が書く)。
 * 行には英語の印のまま書く (cleanup・状態の確認・統合テストがこの値で見分ける) が、利用者には出さない。
 * 画面・応答の本文へ出すときは、読む側の絞り込み (Web は src/lib/weekly-menu-request-error.ts、アプリは
 * apps/mobile/src/lib/menu-request-error.ts) が MENU_REQUEST_STALE_DISPLAY_MESSAGE に置き換える (#1576)
 */
export const MENU_REQUEST_STALE_MESSAGE = "stale_request_timeout";

/**
 * 進まなくなった行 (印 MENU_REQUEST_STALE_MESSAGE) を画面に出すときの文 (#1576)。行には書かない。
 * 読む側の絞り込みを 2 回通しても変わらないよう、読む側は既知の文として扱う
 */
export const MENU_REQUEST_STALE_DISPLAY_MESSAGE =
  "献立の生成が時間内に終わらなかったため、中断しました。もう一度お試しください。";

/**
 * 呼び出しの本文の targetSlots の日付が正しくなかったときの文 (generate-menu-v4 / v5 の入口の判定。#1433・#1576)。
 * 判定の英語の文 (findInvalidTargetSlotDate の戻り値。どの要素が正しくないか) は行に書かず、console にだけ残す
 */
export const MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE =
  "献立を作る日の指定が正しくありません。日付を選び直して、もう一度お試しください。";

/** 利用者が中止したときの文 (Next.js の POST /api/ai/menu/weekly/status が書く。UX2-11) */
export const MENU_REQUEST_CANCELLED_MESSAGE = "中止しました";

/**
 * weekly_menu_requests.error_message に書く、こちらで書いた定型の文の一覧 (同意・上限 (1 日・機能ごと) とそのプランでは使えない機能 (billing/03) の文を除く)。
 * 読む側は、これと同意の文 (aiConsentReasonOfStoredError)・上限の文 (isAiDailyLimitMessage) だけをそのまま出す
 */
export const MENU_REQUEST_FIXED_MESSAGES: readonly string[] = Object.freeze([
  MENU_REQUEST_FAILED_MESSAGE,
  MENU_REQUEST_EXISTING_PROTECTED_MESSAGE,
  MENU_REQUEST_PARTIAL_SAVE_MESSAGE,
  MENU_REQUEST_STALE_MESSAGE,
  MENU_REQUEST_CANCELLED_MESSAGE,
  MENU_REQUEST_INVALID_TARGET_SLOTS_MESSAGE,
]);

/**
 * 読む側が既知の文と見分けた値を、画面・応答の本文に出す文へ置き換える (#1576)。
 * 進まなくなった行の印 (英語の MENU_REQUEST_STALE_MESSAGE) だけを MENU_REQUEST_STALE_DISPLAY_MESSAGE にし、ほかはそのまま。
 * Web (src/lib/weekly-menu-request-error.ts) とアプリ (apps/mobile/src/lib/menu-request-error.ts) が同じ置き換えをするため、ここに置く
 */
export function menuRequestKnownMessageForDisplay(known: string): string {
  return known === MENU_REQUEST_STALE_MESSAGE ? MENU_REQUEST_STALE_DISPLAY_MESSAGE : known;
}

/** 買い物リストの作り直しの失敗の文 */
export const SHOPPING_LIST_REQUEST_FAILED_MESSAGE = "買い物リストの再生成に失敗しました。もう一度お試しください。";
