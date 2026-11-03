import { WebViewScreen } from '../../src/components/web/WebViewScreen';

// スキャンのタブ ('/meals' の配下。スキャン・食事の記録) は入力の途中の画面なので、AI 相談の提案の実行で読み込み直さない
// (reloadOnAiConsultationDataChange を渡さない。読み込み直してよい一覧 webViewBridge.ts の AI_CONSULTATION_RELOADABLE_PATHS にも無い。#2189 W2)
export default function MealsScanTab() {
  return <WebViewScreen path="/meals/new" testID="webview-meals" />;
}
