import { WebViewScreen } from '../../src/components/web/WebViewScreen';

// スキャンのタブは入力の途中の画面なので、AI 相談の提案の実行で読み込み直さない (reloadOnAiConsultationDataChange を渡さない。#2189 W2)
export default function MealsScanTab() {
  return <WebViewScreen path="/meals/new" testID="webview-meals" />;
}
