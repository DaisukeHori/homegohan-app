import { WebViewScreen } from "../../src/components/web/WebViewScreen";
import { MEMBERSHIP_SETTINGS_PATH } from "../../src/lib/membership-settings";

/**
 * メンバーシップ設定 (#1917。設計 docs/design/family/11-self-dissolve.md §15.5)
 *
 * 家族・組織の所属、代表者・オーナーの譲渡へのリンク、家族グループ・組織の解散は Web のメンバーシップ設定 (MEMBERSHIP_SETTINGS_PATH) にあるため、
 * その画面を WebView で開く (画面と文面を 2 か所に持たない)。入口は、アカウントの画面 (app/settings/account.tsx) の退会が 409 で止まったときの Alert。
 */
export default function MembershipSettingsScreen() {
  return <WebViewScreen path={MEMBERSHIP_SETTINGS_PATH} testID="webview-membership-settings" />;
}
