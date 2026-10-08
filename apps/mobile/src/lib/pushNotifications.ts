import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { supabase } from "./supabase";

/**
 * アプリアイコンのバッジ数を更新する (0 でバッジを消す)。
 * 失敗してもアプリの動作には影響しないので、例外は投げない。
 */
export async function setNotificationBadge(count: number): Promise<void> {
  try {
    await Notifications.setBadgeCountAsync(count);
  } catch {
    // バッジ更新の失敗は無視する
  }
}

/**
 * アプリを開いている間 (フォアグラウンド) に届いた通知の扱いを設定する。アプリ起動時に 1 回だけ呼ぶ。
 *
 * これを設定しないと、フォアグラウンドで届いた通知は OS のバナーも出ず、気付けなかった (#1049 F7-11)。
 * バナー・通知センターへの表示・通知音を出し、ペイロードに badge (サーバーが数えた未読数) があれば
 * アイコンのバッジも合わせる (docs/design/mobile/03-push-notification.md §3.5)。
 */
export function setupNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const badge = notification.request.content.badge;
      if (typeof badge === "number") {
        await setNotificationBadge(badge);
      }
      return {
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      };
    },
  });
}

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



