import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { WebViewScreen } from '../../src/components/web/WebViewScreen';
import { colors } from '../../src/theme';

/**
 * ネイティブの設定画面 (ログアウト・通知の設定・退会) のルート。
 * 設定画面は (tabs) の中の、タブバーに出さない画面 (_layout.tsx の tabBarButton: () => null と tabBarItemStyle の display: none。#1591)。
 */
const NATIVE_SETTINGS_ROUTE = '/(tabs)/settings';

/** 歯車のアイコンの大きさ (タブバーのアイコンと同じくらいにして、押せる場所だと分かるようにする) */
const SETTINGS_ICON_SIZE = 22;
/** 歯車の周りの押せる範囲の広がり (アイコンが小さくても指で押しやすくする) */
const SETTINGS_BUTTON_HIT_SLOP = 8;
/** 歯車を置く帯の高さ (iOS の標準のナビゲーションバーと同じ 44pt) */
const HEADER_BAR_HEIGHT = 44;

/**
 * マイページ (WebView) の上に置く、ネイティブの設定画面への入口 (#1037)。
 *
 * 設計書 docs/design/mobile/01-architecture.md §3.2 では、設定画面 (通知の権限・ログアウトなど OS の機能) はネイティブで作る。
 * マイページは WebView なので、ネイティブの設定画面へ行く道が無かった。ここに歯車を置いて道を作る。
 * アプリの中で開いた Web の画面 (設定・マイページ) では、ログアウトと退会を出さない (ネイティブに一本化する)。
 */
function ProfileSettingsHeader() {
  return (
    <View style={styles.headerBar}>
      <Pressable
        testID="profile-settings-button"
        onPress={() => router.push(NATIVE_SETTINGS_ROUTE)}
        accessibilityRole="button"
        accessibilityLabel="設定"
        hitSlop={SETTINGS_BUTTON_HIT_SLOP}
        style={styles.headerButton}
      >
        <Ionicons name="settings-outline" size={SETTINGS_ICON_SIZE} color={colors.text} />
      </Pressable>
    </View>
  );
}

export default function ProfileTab() {
  // AI 相談のシートが提案を実行してデータ (健康目標・好みなど) を変えたら読み込み直す (#2189 W2)
  return (
    <WebViewScreen
      path="/profile"
      testID="webview-profile"
      header={<ProfileSettingsHeader />}
      reloadOnAiConsultationDataChange
    />
  );
}

const styles = StyleSheet.create({
  headerBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    height: HEADER_BAR_HEIGHT,
    paddingHorizontal: 12,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerButton: {
    padding: 8,
    borderRadius: 20,
  },
});
