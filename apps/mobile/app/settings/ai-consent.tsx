import { WebViewScreen } from "../../src/components/web/WebViewScreen";

/**
 * 外国の AI 事業者への提供の同意 (T15 / #1154): 状況の確認・同意・撤回
 *
 * 文面・事業者の一覧・同意の記録は Web と同じものを使うため、Web の /settings/ai-consent を WebView で開く
 * (文面を 2 か所に持たない)。AI の API に「同意が必要です」(403 AI_CONSENT_REQUIRED) で止められた画面は、
 * src/lib/ai-consent.ts の案内からここへ移る。
 */
export default function AiConsentSettingsScreen() {
  return <WebViewScreen path="/settings/ai-consent" testID="webview-ai-consent" />;
}
