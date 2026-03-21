import { Redirect, Stack } from "expo-router";

import { LoadingState } from "../../src/components/ui";
import { useAuth } from "../../src/providers/AuthProvider";
import { colors } from "../../src/theme";

export default function OnboardingLayout() {
  const { session, isLoading } = useAuth();

  if (isLoading) {
    return <LoadingState style={{ backgroundColor: colors.bg }} />;
  }

  if (!session) return <Redirect href="/login" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
