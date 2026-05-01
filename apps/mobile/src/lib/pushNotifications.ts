import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { supabase } from "./supabase";

export async function registerAndSaveExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) {
    // Expo Goでも動くが、物理端末推奨
    return null;
  }

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Unauthorized");

  const perm = await Notifications.getPermissionsAsync();
  let finalStatus = perm.status;
  if (finalStatus !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    finalStatus = req.status;
  }
  if (finalStatus !== "granted") return null;

  // Android: チャンネル作成
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  // プレースホルダーを無効値として扱う
  const PLACEHOLDER = "PLEASE_SET_VIA_EAS_INIT";

  const rawProjectId =
    // 1. 環境変数（EAS Secrets / eas.json env で注入）
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
    // 2. EAS ランタイム（本番ビルドで自動設定）
    (Constants as any).easConfig?.projectId ||
    // 3. app.json extra.eas.projectId（開発時フォールバック）
    (Constants as any).expoConfig?.extra?.eas?.projectId ||
    (Constants as any).expoConfig?.extra?.projectId;

  const projectId =
    rawProjectId && rawProjectId !== PLACEHOLDER ? rawProjectId : undefined;

  const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : {})).data;

  // DB保存（RLSで本人のみ）
  const { error } = await supabase.from("user_push_tokens").upsert(
    {
      user_id: auth.user.id,
      expo_push_token: token,
      platform: Platform.OS,
    },
    { onConflict: "user_id,expo_push_token" }
  );
  if (error) throw error;

  return token;
}



