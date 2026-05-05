import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { View } from "react-native";

import { colors } from "../../src/theme";
import { AIFloatingFab } from "../../src/components/ai/AIFloatingFab";

// 認証ガードを削除: 認証は WebView 内 (Web 版の middleware) で処理する。
// ネイティブ側でのセッションチェック・onboarding リダイレクトはすべて廃止。

export default function TabsLayout() {
  return (
    <>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
            height: 88,
            paddingBottom: 30,
            paddingTop: 8,
          },
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        }}
      >
        <Tabs.Screen
          name="home"
          options={{
            title: "ホーム",
            tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
            tabBarButtonTestID: "tab-home",
          }}
        />
        <Tabs.Screen
          name="menus"
          options={{
            title: "献立",
            tabBarIcon: ({ color, size }) => <Ionicons name="book-outline" size={size} color={color} />,
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
          }}
        />
        <Tabs.Screen
          name="favorites"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="comparison"
          options={{
            title: "比較",
            tabBarIcon: ({ color, size }) => <Ionicons name="bar-chart" size={size} color={color} />,
            tabBarButtonTestID: "tab-comparison",
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "マイページ",
            tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
            tabBarButtonTestID: "tab-profile",
          }}
        />
        {/* タブバーに表示しないが(tabs)グループ内に必要なファイル */}
        <Tabs.Screen name="health" options={{ href: null }} />
        <Tabs.Screen name="settings" options={{ href: null }} />
      </Tabs>
      <AIFloatingFab />
    </>
  );
}
