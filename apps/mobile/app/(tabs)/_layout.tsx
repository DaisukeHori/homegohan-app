import { Ionicons } from "@expo/vector-icons";
import { Tabs, Redirect, router } from "expo-router";
import { ActivityIndicator, Platform, View } from "react-native";

import { colors } from "../../src/theme";
import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";
import { AIFloatingFab } from "../../src/components/ai/AIFloatingFab";

export default function TabsLayout() {
  const { session, isLoading } = useAuth();
  const { isLoading: profileLoading, profile } = useProfile();

  if (!session) return <Redirect href="/" />;

  if (isLoading || profileLoading) {
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
            tabBarButtonTestID: "tab-meals",
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
    </View>
  );
}
