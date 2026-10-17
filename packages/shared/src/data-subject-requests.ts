/**
 * 開示・訂正・利用停止・消去の請求 (DSR。#1178 / #1702) の画面の入口の定数 — Web とアプリ (apps/mobile) で共用する (#1812)。
 *
 * 請求の画面は Web (src/app/(main)/settings/data-requests/page.tsx) にだけあり、アプリはネイティブの設定のアカウントの画面
 * (apps/mobile/app/settings/account.tsx) の項目から、同じ画面を WebView (apps/mobile/app/settings/data-requests.tsx) で開く。
 * パスと見出し・説明の文を 2 か所に持たないよう、ここだけに置く。Web の正典 src/lib/data-subject-requests/core.ts は
 * ここの値を再び export し、Web の各画面・メールは今までどおり core.ts から読む (設計 docs/design/cross/15-data-subject-requests.md §5・§9)。
 * 同意ゲートと初期設定の差し戻しから外すパス (lib/onboarding-routing.ts の DATA_SUBJECT_REQUESTS_PATH) もこの値を使う。
 */

/** 請求の画面 (本人が請求を出す・一覧を見る Web の画面) のパス */
export const DSR_SETTINGS_PATH = '/settings/data-requests';

/** 設定画面の入口の見出し (Web の設定の「データとプライバシー」と、アプリのアカウントの画面の項目) */
export const DSR_SETTINGS_ENTRY_TITLE = '開示・訂正・利用停止の請求';

/** 設定画面の入口の説明の文 (見出しの下の 1 行。Web とアプリで同じ文) */
export const DSR_SETTINGS_ENTRY_DESCRIPTION = '個人情報の開示・訂正・利用停止・消去を請求する';
