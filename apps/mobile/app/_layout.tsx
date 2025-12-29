import { Stack } from "expo-router";

import { AuthProvider } from "../src/providers/AuthProvider";
import { ProfileProvider } from "../src/providers/ProfileProvider";

export default function RootLayout() {
  return (
    <AuthProvider>
      <ProfileProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(public)" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="(org)" />
          <Stack.Screen name="(admin)" />
          <Stack.Screen name="(support)" />
          <Stack.Screen name="(super-admin)" />
        </Stack>
      </ProfileProvider>
    </AuthProvider>
  );
}


