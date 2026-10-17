import { WebViewScreen } from "../../src/components/web/WebViewScreen";
import { DSR_SETTINGS_PATH } from "../../src/lib/data-subject-requests";

/**
 * 開示・訂正・利用停止・消去の請求 (#1812。設計 docs/design/cross/15-data-subject-requests.md §9・§19)
 *
 * 請求の受付・本人確認・一覧は Web の請求の画面 (DSR_SETTINGS_PATH) にあるため、その画面を WebView で開く
 * (画面と文面を 2 か所に持たない)。入口はアカウントの画面 (app/settings/account.tsx) の項目。
 */
export default function DataRequestsSettingsScreen() {
  return <WebViewScreen path={DSR_SETTINGS_PATH} testID="webview-data-requests" />;
}
