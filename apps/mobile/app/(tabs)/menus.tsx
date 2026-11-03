import { WebViewScreen } from '../../src/components/web/WebViewScreen';

// AI 相談のシートが提案を実行してデータを変えたら読み込み直す (#2189 W2。WebViewScreen の reloadOnAiConsultationDataChange)。
// 読み込み直すのは、今のページが読み込み直してよい一覧 (webViewBridge.ts の AI_CONSULTATION_RELOADABLE_PATHS) にあり、入力の途中でないときだけ
export default function MenusTab() {
  return <WebViewScreen path="/menus/weekly" testID="webview-menus" reloadOnAiConsultationDataChange />;
}
