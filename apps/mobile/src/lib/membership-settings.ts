/**
 * メンバーシップ設定の画面への入口 (#1917。設計 docs/design/family/11-self-dissolve.md §15.5)
 *
 * 家族・組織の所属、代表者・オーナーの譲渡へのリンク、家族グループ・組織の解散は Web のメンバーシップ設定 (/settings/membership) にだけある。
 * アプリは、アカウントの画面 (app/settings/account.tsx) の退会が 409 (組織のオーナー・家族の代表者) で止まったときの Alert から、
 * 同じ Web の画面を WebView で開く画面 (app/settings/membership.tsx) へ移る (DSR の画面 src/lib/data-subject-requests.ts と同じ開き方)。
 * パスは Web と共用の @homegohan/shared の値をそのまま使う (2 か所に持たない)。
 */
import { MEMBERSHIP_SETTINGS_PATH } from "@homegohan/shared";

export { MEMBERSHIP_SETTINGS_PATH };

/**
 * アプリのメンバーシップ設定の画面 (Web の MEMBERSHIP_SETTINGS_PATH を WebView で開く app/settings/membership.tsx) の経路。
 * 画面のファイルを Web と同じパスに置いているので、経路は Web のパスと同じ値になる (DSR_SCREEN_ROUTE と同じ形)。
 * 一致は __tests__/settings/membership-entry.test.tsx が確かめる
 */
export const MEMBERSHIP_SETTINGS_SCREEN_ROUTE = MEMBERSHIP_SETTINGS_PATH;
