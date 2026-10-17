/**
 * 開示・訂正・利用停止・消去の請求 (DSR) の画面への入口 (#1812。設計 docs/design/cross/15-data-subject-requests.md §9・§19)
 *
 * 請求の画面は Web (/settings/data-requests) にだけある。アプリは、アカウントの画面 (app/settings/account.tsx) の項目から、
 * 同じ Web の画面を WebView で開く画面 (app/settings/data-requests.tsx) へ移る。AI へのデータ提供の同意の画面
 * (app/settings/ai-consent.tsx。src/lib/ai-consent.ts の AI_CONSENT_SCREEN_PATH) と同じ開き方 (WebViewScreen・ブリッジの code の受け渡し)。
 * パス・見出し・説明の文は Web と共用の @homegohan/shared の値をそのまま使う (2 か所に持たない)。
 */
import { DSR_SETTINGS_ENTRY_DESCRIPTION, DSR_SETTINGS_ENTRY_TITLE, DSR_SETTINGS_PATH } from "@homegohan/shared";

export { DSR_SETTINGS_ENTRY_DESCRIPTION, DSR_SETTINGS_ENTRY_TITLE, DSR_SETTINGS_PATH };

/**
 * アプリの請求の画面 (Web の DSR_SETTINGS_PATH を WebView で開く app/settings/data-requests.tsx) の経路。
 * 画面のファイルを Web と同じパスに置いているので、経路は Web のパスと同じ値になる (AI_CONSENT_SCREEN_PATH と同じ形)。
 * 一致は __tests__/settings/data-requests-entry.test.tsx が確かめる
 */
export const DSR_SCREEN_ROUTE = DSR_SETTINGS_PATH;
