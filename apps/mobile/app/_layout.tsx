import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { Stack } from "expo-router";
import type { ErrorBoundaryProps } from "expo-router";
import { useEffect } from "react";
import { LogBox } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AccountFrozenGate } from "../src/components/AccountFrozenGate";
import { ConfigErrorScreen } from "../src/components/ConfigErrorScreen";
import { ErrorFallback } from "../src/components/ErrorFallback";
import { FontsReadyProvider } from "../src/components/ui/Text";
import { LegalConsentGate } from "../src/components/legal/LegalConsentGate";
import { NotificationRouter } from "../src/components/NotificationRouter";
import { MobileConfigError, resolveRequiredMobileEnv } from "../src/lib/env";
import { ensurePushTokenRegistered } from "../src/lib/pushNotifications";
import { AccountFrozenProvider } from "../src/providers/AccountFrozenProvider";
import { AuthProvider, useAuth } from "../src/providers/AuthProvider";
import { LegalConsentProvider } from "../src/providers/LegalConsentProvider";
import { ProfileProvider } from "../src/providers/ProfileProvider";
import { notoSansJpFontSources } from "../src/theme/fontSources";

// E2E テスト中に LogBox の自動ポップアップがタップを横取りして失敗するため抑制する
// (console.error は引き続き Metro ログに出力される)
LogBox.ignoreAllLogs();

// 字形 (Noto Sans JP) の読み込みが終わるまで、スプラッシュを出したままにする (#588)
SplashScreen.preventAutoHideAsync();

// 画面の描画中に起きた例外を受ける、ルートの境界 (#1207)。
// expo-router は、この export がある layout の中で起きた描画の例外を受けて、画面の代わりにこれを出す。
// 無いとアプリ全体がクラッシュする (白い画面)。グループ専用の境界を持たない画面 (設定から開く血液検査・
// 栄養目標・アカウント・AI の同意など、app 直下の画面) の例外は、ここで受ける。
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
        // 起動・ログインした利用者が変わるたびに、登録と claim (同じトークンのほかの利用者の行を外す) を通す (#1599)。
        // 「登録済み」の印で省かない (ほかの利用者の claim で行が消えていても、ここで登録し直す)。
        // 権限の拒否などで登録できなければ、次の起動でまた試す
        await ensurePushTokenRegistered();
      } catch {
        // silent — 失敗は registerAndSaveExpoPushToken() が端末のコンソールとサーバーログ (app_logs) に出す (#1413)。user can retry via settings toggle
      }
    })();
  }, [user?.id]);

  return null;
}

export default function RootLayout() {
  // Noto Sans JP の Regular / Medium / Bold を実行時に読み込む (#588)。ネイティブに埋め込まないので OTA の更新で届く
  const [fontsLoaded, fontError] = useFonts(notoSansJpFontSources);
  // 読み込みが終わった (失敗を含む)。失敗したときは、システムの字形のまま進める (スプラッシュで止めない)
  const fontsSettled = fontsLoaded || fontError !== null;

  // 必須の環境変数 (EXPO_PUBLIC_SUPABASE_* と EXPO_PUBLIC_API_BASE_URL。#1182 / #1434) がそろっているか
  const requiredEnv = resolveRequiredMobileEnv();
  const missingEnvMessage = requiredEnv.ok ? null : new MobileConfigError(requiredEnv.missing).message;

  useEffect(() => {
    if (!missingEnvMessage) return;
    // 足りない変数名を端末のログに残す (リリースビルドの設定エラーの画面には名前を出さないため)。
    // Supabase の 2 つは lib/supabase.ts も読み込み時に残すが、EXPO_PUBLIC_API_BASE_URL はここでしか残らない
    console.error(
      `${missingEnvMessage} - このビルドには必須の環境変数が入っていません。EAS の環境変数に登録して、ビルドし直してください`,
    );
  }, [missingEnvMessage]);

  useEffect(() => {
    if (!fontError) return;
    // 字形が無くても画面は使えるので、端末のログに残すだけにする
    console.warn(`[mobile] Noto Sans JP の読み込みに失敗したため、システムの字形で表示します: ${fontError.message}`);
  }, [fontError]);

  useEffect(() => {
    if (fontsSettled) {
      SplashScreen.hideAsync();
    }
  }, [fontsSettled]);

  // 読み込み中はスプラッシュを出したまま、何も描かない
  if (!fontsSettled) return null;

  // 必須の環境変数が入っていないビルドは、Provider を立ち上げずに設定エラーの画面を出す (#1182)。
  // Supabase を使う Provider が動くと、存在しない接続先に向かって失敗し続け、原因が分からないため。
  // EXPO_PUBLIC_API_BASE_URL が無いと、API を呼ぶ画面 (getApiBaseUrl()) が例外で落ちるので、これもゲートに入れる (#1434)
  if (!requiredEnv.ok) {
    return (
      <FontsReadyProvider ready={fontsLoaded}>
        <ConfigErrorScreen missing={requiredEnv.missing} />
      </FontsReadyProvider>
    );
  }

  return (
    <FontsReadyProvider ready={fontsLoaded}>
      <SafeAreaProvider>
        <AuthProvider>
          {/* #1861: 凍結の状態。規約の同意のゲートが「凍結中は畳まない」ために読むので、LegalConsentProvider の外側に置く */}
          <AccountFrozenProvider>
            <LegalConsentProvider>
              <ProfileProvider>
                <PushTokenRegistrar />
                {/* フォアグラウンドの通知の表示と、通知のタップでの遷移 (#1049 F7-11)。外されたら解除する */}
                <NotificationRouter />
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="index" />
                  <Stack.Screen name="(public)" />
                  <Stack.Screen name="(auth)" />
                  <Stack.Screen name="(tabs)" />
                  {/* #1442: 同意画面。iOS のスワイプで閉じさせない (ほかの取り除く操作は画面の usePreventRemove が止める) */}
                  <Stack.Screen name="legal-consent" options={{ gestureEnabled: false }} />
                  {/* #1861: 凍結中の画面 (Web の /frozen の WebView)。iOS のスワイプで閉じさせない (ほかの操作で外れても AccountFrozenGate が畳み直す) */}
                  <Stack.Screen name="frozen" options={{ gestureEnabled: false }} />
                </Stack>
                {/* #1861: 凍結中は、Stack を凍結の画面 1 つに畳む。描くものは無い。同意のゲートより先に置く (凍結が先。凍結中は同意のゲートが畳まない) */}
                <AccountFrozenGate />
                {/* #1442: 同意が要る間は、Stack を同意画面 (Web の /legal-consent の WebView) 1 つに畳む。描くものは無い。
                    Stack の後ろに置く (同じ描画の effect では Stack の navigator が先にそろう) */}
                <LegalConsentGate />
              </ProfileProvider>
            </LegalConsentProvider>
          </AccountFrozenProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </FontsReadyProvider>
  );
}
