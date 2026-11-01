import { WebViewScreen } from '../../src/components/web/WebViewScreen';

// AI 相談のシートが提案を実行してデータを変えたら読み込み直す (#2189 W2。WebViewScreen の reloadOnAiConsultationDataChange)
export default function MenusTab() {
  return <WebViewScreen path="/menus/weekly" testID="webview-menus" reloadOnAiConsultationDataChange />;
}
