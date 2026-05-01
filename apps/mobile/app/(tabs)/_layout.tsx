import { Ionicons } from "@expo/vector-icons";
import { Tabs, Redirect, router } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { colors } from "../../src/theme";
import { useAuth } from "../../src/providers/AuthProvider";
import { useProfile } from "../../src/providers/ProfileProvider";

export default function TabsLayout() {
  const { session, isLoading } = useAuth();
  const { isLoading: profileLoading, profile } = useProfile();

  if (isLoading || profileLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!session) return <Redirect href="/" />;

  // profileがnullの場合（ロード直後等）はリダイレクトせずそのまま表示
  if (profile && !profile.onboardingCompletedAt) {
    if (profile.onboardingStartedAt) {
      return <Redirect href="/onboarding/resume" />;
    } else {
      return <Redirect href="/onboarding/welcome" />;
    }
  }

  return (
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
        }}
      />
      <Tabs.Screen
        name="menus"
        options={{
          title: "献立",
          tabBarIcon: ({ color, size }) => <Ionicons name="restaurant" size={size} color={color} />,
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
        listeners={{
          tabPress: (e) => {
            e.preventDefault();
            router.push("/meals/new");
          },
        }}
      />
      <Tabs.Screen
        name="favorites"
        options={{
          title: "お気に入り",
          tabBarIcon: ({ color, size }) => <Ionicons name="heart" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="comparison"
        options={{
          title: "比較",
          tabBarIcon: ({ color, size }) => <Ionicons name="bar-chart" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "マイページ",
          tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
        }}
      />
      {/* タブバーに表示しないが(tabs)グループ内に必要なファイル */}
      <Tabs.Screen name="health" options={{ href: null }} />
      <Tabs.Screen name="settings" options={{ href: null }} />
    </Tabs>
  );
}
