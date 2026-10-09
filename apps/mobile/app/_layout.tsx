import {
  NotoSansJP_400Regular,
  NotoSansJP_500Medium,
  NotoSansJP_700Bold,
  useFonts,
} from '@expo-google-fonts/noto-sans-jp';
import * as SplashScreen from 'expo-splash-screen';
import { Stack } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { useEffect } from "react";
import { LogBox } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorFallback } from "../src/components/ErrorFallback";
import { ensurePushTokenRegistered } from "../src/lib/pushNotifications";
import { AuthProvider, useAuth } from "../src/providers/AuthProvider";
import { ProfileProvider } from "../src/providers/ProfileProvider";

// E2E テスト中に LogBox の自動ポップアップがタップを横取りして失敗するため抑制する
// (console.error は引き続き Metro ログに出力される)
LogBox.ignoreAllLogs();

SplashScreen.preventAutoHideAsync();

// 画面の描画中に起きた例外を受ける、ルートの境界 (#1207)。
// expo-router は、この export がある layout の中で起きた描画の例外を受けて、画面の代わりにこれを出す。
// 無いとアプリ全体がクラッシュする (白い画面)。グループ専用の境界を持たない画面 (献立・食事・レシピ・健康・AI など、
// app 直下の画面) の例外は、ここで受ける。
// ルートの境界は Provider ごと置き換えて描画されるため、Provider に頼らない最小の画面にしている。
// 移動先のナビゲーションも残っていないので、「再試行」だけを出す。
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ErrorFallback {...props} boundary="root" />;
}

function PushTokenRegistrar() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        // 登録済みの印は、トークンを保存できたときだけ付く (権限の拒否などで未登録なら、次の起動でまた試す)
        await ensurePushTokenRegistered(user.id);
      } catch {
        // silent — 失敗は registerAndSaveExpoPushToken() が端末のコンソールに出す。user can retry via settings toggle
      }
    })();
  }, [user?.id]);

  return null;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    NotoSansJP_400Regular,
    NotoSansJP_500Medium,
    NotoSansJP_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

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
            <Stack.Screen name="(support)" />
            <Stack.Screen name="(super-admin)" />
            <Stack.Screen name="meals/new" options={{ presentation: "modal" }} />
          </Stack>
        </ProfileProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
