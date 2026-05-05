import { useLocalSearchParams } from 'expo-router';
import { WebViewScreen } from '../src/components/web/WebViewScreen';

/**
 * ネイティブ側で AI 解析した結果を Web の /meals/new に渡す中継画面。
 * クエリパラメータ:
 *   path    - Web 側のパス (例: /meals/new)
 *   prefill - encodeURIComponent(JSON.stringify(analysisResult))
 */
export default function WebPrefillScreen() {
  const { path, prefill } = useLocalSearchParams<{ path: string; prefill: string }>();
  const resolvedPath = path ?? '/meals/new';
  const query = prefill ? `&prefill=${prefill}` : '';
  return <WebViewScreen path={`${resolvedPath}?mode=app${query}`} />;
}
