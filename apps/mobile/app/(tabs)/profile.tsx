import { router } from 'expo-router';

import { WebViewScreen } from '../../src/components/web/WebViewScreen';

// Issue #1037: マイページ (WebView) からネイティブの設定画面
// (ログアウト・アカウント削除・通知設定) へ到達できる導線が存在しなかったため、
// ヘッダーに歯車アイコンを追加し、ネイティブ設定タブへ直接遷移できるようにする。
export default function ProfileTab() {
  return (
    <WebViewScreen
      path="/profile"
      testID="webview-profile"
      headerAction={{
        icon: 'settings-outline',
        testID: 'profile-settings-button',
        accessibilityLabel: '設定',
        onPress: () => router.push('/(tabs)/settings'),
      }}
    />
  );
}
