import AsyncStorage from "@react-native-async-storage/async-storage";
import { Stack } from "expo-router";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { registerAndSaveExpoPushToken } from "../src/lib/pushNotifications";
import { AuthProvider, useAuth } from "../src/providers/AuthProvider";
import { ProfileProvider } from "../src/providers/ProfileProvider";

const PUSH_TOKEN_REGISTERED_KEY = "push_token_registered_v1";

function PushTokenRegistrar() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        const key = `${PUSH_TOKEN_REGISTERED_KEY}:${user.id}`;
        const already = await AsyncStorage.getItem(key);
        if (already === "1") return;

        await registerAndSaveExpoPushToken();
        await AsyncStorage.setItem(key, "1");
      } catch {
        // silent — user can retry via settings toggle
      }
    })();
  }, [user?.id]);

  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <ProfileProvider>
          <PushTokenRegistrar />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(public)" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="(org)" />
            <Stack.Screen name="(admin)" />
            <Stack.Screen name="(support)" />
            <Stack.Screen name="(super-admin)" />
            <Stack.Screen name="meals/new" options={{ presentation: "modal" }} />
          </Stack>
        </ProfileProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
