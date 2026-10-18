import { Ionicons } from "@expo/vector-icons";
import { Tabs, Redirect, router } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { ActivityIndicator, Platform, View } from "react-native";
import type { ColorValue } from "react-native";

import { colors } from "../../src/theme";
import { useAccountFrozen } from "../../src/providers/AccountFrozenProvider";
import { useAuth } from "../../src/providers/AuthProvider";
import { useLegalConsent } from "../../src/providers/LegalConsentProvider";
import { useProfile } from "../../src/providers/ProfileProvider";
import { AIFloatingFab } from "../../src/components/ai/AIFloatingFab";
import { ErrorFallback } from "../../src/components/ErrorFallback";
import { useFontStyle } from "../../src/components/ui/Text";

// この区画 (ホーム・献立・スキャン・比較・マイページ) の画面で描画の例外が起きたとき、
// アプリ全体をクラッシュさせずに再試行を出す (#1207)。
// 「ホームへ戻る」の移動先は、この区画の外の "/" (入口 → ホーム)。(tabs) の中のホームへ直接移ると、
// この区画のナビゲーターが壊れている間は移動が効かないため。
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorFallback {...props} boundary="tabs" homeHref="/" />;
}

const TAB_BAR_LABEL_STYLE = { fontSize: 11, fontWeight: "600" } as const;

/** expo-router 58 の tabBarIcon の color は ColorValue (null や PlatformColor もありうる)。Ionicons は文字列だけを受けるので、文字列のときだけ渡す (このアプリのタブの色は文字列) */
function iconColorOf(color: ColorValue): string | undefined {
  return typeof color === "string" ? color : undefined;
}

export default function TabsLayout() {
  const { session, isLoading } = useAuth();
  const { isLoading: profileLoading, profile } = useProfile();
  const { state: legalConsentState } = useLegalConsent();
  const { state: frozenState } = useAccountFrozen();
  // タブの見出しは react-navigation が中で Text を描くので、共通の部品と同じ字形に置き換えて渡す (#588)
  const tabBarLabelStyle = useFontStyle(TAB_BAR_LABEL_STYLE);

  if (!session) return <Redirect href="/" />;

  // #1442: 同意の状態が分かるまで・同意が要る間は、タブ (WebView) と AI の FAB を描かない。
  // 描くと WebView の中で Web の同意画面が別に開く
  // #1861: 凍結の状態が分かるまで・凍結中も描かない (AccountFrozenGate が凍結の画面 1 つに畳む。描くとタブの API が凍結の 403 で失敗し続ける)
  if (
    isLoading ||
    profileLoading ||
    legalConsentState === "loading" ||
    legalConsentState === "required" ||
    frozenState === "loading" ||
    frozenState === "frozen"
  ) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  // profileがnullの場合（ロード直後等）はリダイレクトせずそのまま表示
  if (profile && !profile.onboardingCompletedAt) {
    if (profile.onboardingStartedAt) {
      return <Redirect href="/onboarding/resume" />;
    } else {
      return <Redirect href="/onboarding/welcome" />;
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
            height: Platform.OS === 'ios' ? 88 : 64,
            paddingBottom: Platform.OS === 'ios' ? 30 : 8,
            paddingTop: 8,
          },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarLabelStyle,
        }}
      >
        <Tabs.Screen
          name="home"
          options={{
            title: "ホーム",
            tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={iconColorOf(color)} />,
            tabBarButtonTestID: "tab-home",
          }}
        />
        <Tabs.Screen
          name="menus"
          options={{
            title: "献立",
            tabBarIcon: ({ color, size }) => <Ionicons name="book-outline" size={size} color={iconColorOf(color)} />,
            tabBarButtonTestID: "tab-menus",
          }}
        />
        <Tabs.Screen
          name="meals"
          options={{
            title: "スキャン",
            tabBarIcon: () => (
              <View style={{
                width: 48, height: 48, borderRadius: 24,
                backgroundColor: colors.text, alignItems: "center", justifyContent: "center",
                marginBottom: 16,
              }}>
                <Ionicons name="scan" size={24} color="#fff" />
              </View>
            ),
            tabBarLabel: () => null,
            tabBarButtonTestID: "tab-meals",
          }}
        />
        <Tabs.Screen
          name="comparison"
          options={{
            title: "比較",
            tabBarIcon: ({ color, size }) => <Ionicons name="bar-chart" size={size} color={iconColorOf(color)} />,
            tabBarButtonTestID: "tab-comparison",
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "マイページ",
            tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={iconColorOf(color)} />,
            tabBarButtonTestID: "tab-profile",
          }}
        />
        {/* 設定の画面 (マイページの歯車から開く)。(tabs) の中に置き、タブバーには出さない: ボタンを描かず (tabBarButton が null)、枠も取らない (display: none)。
            href: null は使わない (expo-router 58 では route を届かなくし、最初のタブへ戻す。expo-router 5 の href: null はこの 2 つへの展開だった。#1591) */}
        <Tabs.Screen name="settings" options={{ tabBarButton: () => null, tabBarItemStyle: { display: "none" } }} />
      </Tabs>
      <AIFloatingFab />
    </View>
  );
}
