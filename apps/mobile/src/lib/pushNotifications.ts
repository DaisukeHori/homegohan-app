import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { captureEvent } from "./posthog";
import { supabase } from "./supabase";

/**
 * この端末の Expo Push Token を DB に登録した後、値をローカルに控えるキーの接頭辞。
 * ログアウト時に「この端末の行だけ」を user_push_tokens から消すために使う (#1038 F7-10)。
 * 実際のキーは `${接頭辞}:${userId}`。ログアウトで clearUserScopedAsyncStorage() が消す
 * (src/lib/user-storage.ts の USER_ID_KEY_PREFIXES に載せている)。
 */
export const PUSH_TOKEN_VALUE_KEY_PREFIX = "push_token_value_v1";

/**
 * push token を DB に登録済みであることの印。実際のキーは `${接頭辞}:${userId}` (ログアウトで消える)。
 *
 * v1 は使わない。#1038 より前のビルドは、権限を拒否されて登録できなかった (null が返った) ときも v1 の印を付けていたため、
 * 通知を拒否した端末には v1 の印が残っている。v1 をそのまま見ると、後から OS の設定で許可しても二度と登録されない。
 * v2 は「トークンを実際に保存できたときだけ」付けるので、v1 は読まず (ログアウトでは消す: user-storage.ts)、
 * 更新後の初回起動で 1 度だけ登録を確かめ直す (登録済みの端末では upsert が何も変えないだけ)。
 */
export const PUSH_TOKEN_REGISTERED_KEY_PREFIX = "push_token_registered_v2";

/** プレースホルダーを無効値として扱う (eas init 前の app.json などに入っていた値) */
const PLACEHOLDER = "PLEASE_SET_VIA_EAS_INIT";

/** EAS の project ID は UUID。形式が違う値 (展開されなかった "$VAR" など) は使わない */
const EAS_PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EasProjectIdSource = "env" | "easConfig" | "expoConfig" | "extra" | "none";

export type ResolvedEasProjectId = {
  /** getExpoPushTokenAsync に渡す project ID。有効な値が 1 つも無ければ undefined */
  projectId: string | undefined;
  /** 採用した値の出どころ */
  source: EasProjectIdSource;
  /**
   * 候補はあったが形式が不正で捨てた出どころ (値そのものは含めない)。
   * 例: eas.json の "$EXPO_PUBLIC_EAS_PROJECT_ID" が展開されずに文字列のまま入った場合は "env"。
   */
  rejected: EasProjectIdSource[];
};

export function isValidEasProjectId(value: unknown): value is string {
  return typeof value === "string" && value !== PLACEHOLDER && EAS_PROJECT_ID_PATTERN.test(value);
}

/**
 * EAS の project ID を決める。優先順位:
 *   1. 環境変数 EXPO_PUBLIC_EAS_PROJECT_ID (EAS Secrets 等で注入)
 *   2. EAS ランタイム (Constants.easConfig)
 *   3. app.json の extra.eas.projectId
 *   4. app.json の extra.projectId
 * 各候補は UUID 形式を確認し、不正な値は読み飛ばして次の候補へ進む。
 * (以前は先頭の「真っ当に見える値」を無検証で採用していたため、eas.json の "$VAR" が展開されずに
 *  リテラルのまま入ると、app.json に正しい値があるのに使われず push token の登録が失敗した #1038 F7-09)
 */
export function resolveEasProjectId(): ResolvedEasProjectId {
  const constants = Constants as unknown as {
    easConfig?: { projectId?: unknown };
    expoConfig?: { extra?: { eas?: { projectId?: unknown }; projectId?: unknown } };
  };
  const candidates: Array<{ source: Exclude<EasProjectIdSource, "none">; value: unknown }> = [
    { source: "env", value: process.env.EXPO_PUBLIC_EAS_PROJECT_ID },
    { source: "easConfig", value: constants.easConfig?.projectId },
    { source: "expoConfig", value: constants.expoConfig?.extra?.eas?.projectId },
    { source: "extra", value: constants.expoConfig?.extra?.projectId },
  ];

  const rejected: EasProjectIdSource[] = [];
  for (const { source, value } of candidates) {
    if (value === undefined || value === null || value === "") continue;
    if (isValidEasProjectId(value)) return { projectId: value, source, rejected };
    rejected.push(source);
  }
  return { projectId: undefined, source: "none", rejected };
}

/** 登録失敗を PostHog に送る (トークンやユーザー ID は載せない。PostHog 未初期化なら何もしない) */
function reportPushRegistrationFailure(
  stage: "get_token" | "save_token",
  error: unknown,
  resolved: ResolvedEasProjectId,
): void {
  const e = error as { name?: unknown; message?: unknown } | null | undefined;
  captureEvent("push_token_registration_failed", {
    stage,
    platform: Platform.OS,
    error_name: typeof e?.name === "string" ? e.name : "unknown",
    error_message: typeof e?.message === "string" ? e.message.slice(0, 200) : "",
    project_id_source: resolved.source,
    rejected_project_id_sources: resolved.rejected.join(",") || "none",
  });
}

/**
 * 通知の権限をダイアログで尋ねてよいか。
 *
 * - 起動のたびに自動で呼ばれるとき (userInitiated = false) は、まだ一度も尋ねていない (undetermined) ときだけ。
 *   拒否された後も毎回尋ねると、Android 13 以降は、一度拒否した利用者に次の起動でもう一度ダイアログが出てしまう
 *   (iOS は 2 回目以降は何も表示されないが、尋ねる意味もない)。拒否した利用者は、OS の設定で許可すれば、次の起動で登録される
 * - 利用者が登録のボタンを押したとき (userInitiated = true) は、OS がまだ尋ねられる (canAskAgain が false でない) なら尋ねる
 */
function shouldAskForPermission(perm: { status: string; canAskAgain?: boolean }, userInitiated: boolean): boolean {
  if (perm.status === "undetermined") return true;
  return userInitiated && perm.canAskAgain !== false;
}

export type RegisterPushTokenOptions = {
  /** 利用者が設定画面の登録ボタンを押したとき true。起動時の自動登録 (ensurePushTokenRegistered) は false */
  userInitiated?: boolean;
};

export async function registerAndSaveExpoPushToken(options: RegisterPushTokenOptions = {}): Promise<string | null> {
  if (!Device.isDevice) {
    // Expo Goでも動くが、物理端末推奨
    return null;
  }

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Unauthorized");

  const perm = await Notifications.getPermissionsAsync();
  let finalStatus = perm.status;
  if (finalStatus !== "granted" && shouldAskForPermission(perm, options.userInitiated === true)) {
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

  const resolved = resolveEasProjectId();

  let token: string;
  try {
    token = (
      await Notifications.getExpoPushTokenAsync(resolved.projectId ? { projectId: resolved.projectId } : {})
    ).data;
  } catch (error) {
    // 呼び出し元 (PushTokenRegistrar) は失敗を握りつぶすので、ここで観測できるようにする (#1038 F7-09)
    reportPushRegistrationFailure("get_token", error, resolved);
    throw error;
  }

  // DB保存（RLSで本人のみ）
  const { error } = await supabase.from("user_push_tokens").upsert(
    {
      user_id: auth.user.id,
      expo_push_token: token,
      platform: Platform.OS,
    },
    { onConflict: "user_id,expo_push_token" }
  );
  if (error) {
    reportPushRegistrationFailure("save_token", error, resolved);
    throw error;
  }

  // ログアウト時に「この端末の行だけ」を消せるよう、登録した値を控えておく (#1038 F7-10)。控えられなくても登録は成功扱い
  try {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:${auth.user.id}`, token);
  } catch {
    // ignore
  }

  return token;
}

/**
 * ログイン済みのユーザーについて、この端末の push token が未登録なら登録する (アプリ起動時に呼ぶ)。
 *
 * 「登録済み」の印は、トークンを実際に DB へ保存できたときだけ付ける (#1038 F7-09)。
 * 以前は registerAndSaveExpoPushToken() が権限の拒否などで null を返しても印を付けていたため、
 * 後から OS の設定で通知を許可しても、二度と登録されなかった。
 * 印はログアウトで消える (user-storage.ts)。例外は呼び出し側 (PushTokenRegistrar) が握りつぶす。
 */
export async function ensurePushTokenRegistered(userId: string): Promise<void> {
  const key = `${PUSH_TOKEN_REGISTERED_KEY_PREFIX}:${userId}`;
  if ((await AsyncStorage.getItem(key)) === "1") return;

  const token = await registerAndSaveExpoPushToken();
  if (token) await AsyncStorage.setItem(key, "1");
}

/** ログアウト時のトークン削除に使う待ち時間の上限 (ミリ秒)。通信が遅くてもログアウトを長く止めない */
const UNREGISTER_TIMEOUT_MS = 3000;

export type UnregisterPushTokenResult =
  /** 行を消した */
  | "deleted"
  /** DELETE は通ったが、消えた行が 0 件だった (RLS に弾かれた、または行が既に無い。どちらもエラーにならない) */
  | "no_rows"
  /** ユーザー ID や push token の値が分からないので、何もしなかった */
  | "skipped"
  /** 失敗した (エラー・タイムアウト) */
  | "failed";

export type UnregisterPushTokenOptions = {
  /** 待ち時間の上限 (ミリ秒) */
  timeoutMs?: number;
  /**
   * 削除を認可する、本人のアクセストークン (JWT)。呼び出し側が、セッションが生きているうちに控えた値。
   *
   * 渡さなければ、supabase-js が「いまのセッション」のトークンを付ける。それではログアウトの途中で足りなくなる。
   * Web からの sign-out / session-expired を処理している間に、getUser() が 403 session_not_found を受けると、
   * auth-js (2.105) は AuthSessionMissingError にして端末のセッションを消す (_removeSession)。
   * そのあとに削除の通信を出すと、セッションが無いので anon キーが付き、RLS で 0 行になる (エラーにならない)。
   * Authorization ヘッダーを明示すれば、supabase-js はそれを上書きしない (fetchWithAuth は、既にあれば付けない)。
   * PostgREST は JWT の署名と期限だけを見て、セッションが失効済みかどうかは見ないので、期限内なら本人の行を消せる。
   */
  accessToken?: string | null;
};

/**
 * この端末の Expo Push Token を user_push_tokens から消す (ログアウトの直前に呼ぶ。#1038 F7-10)。
 *
 * user_push_tokens は UNIQUE(user_id, expo_push_token) なので、同じ端末で別のユーザーがログインすると
 * 同じトークンが複数ユーザーの行に併存する。ログアウトで消さないと、共有端末で前のユーザー宛ての通知が届き得る。
 *
 * - 消すのは「この端末のトークンの、このユーザーの行」だけ。同じユーザーの他の端末の行は消さない
 *   (消すと、他の端末は登録済みフラグが立っていて再登録されず、通知が届かなくなる)
 * - RLS (本人の行のみ削除可) のため、サインアウトの「前」に呼ぶこと。
 *   セッションが先に失効してしまう場合 (Web からの sign-out / session-expired) は、控えておいたアクセストークンを options.accessToken で渡す
 * - 例外は投げない。失敗・タイムアウトでもログアウトは止めない (失敗は PostHog に送る)
 * - 消えた行が 0 件のときも、エラーにならない (RLS は弾いた行を黙って除く) ので、件数を数えて PostHog に送る
 *   (push_token_unregister_no_rows)。以前はこれを「削除できた」として扱っており、RLS で素通りしても気づけなかった
 * - アカウント削除では呼ばなくてよい (auth.users の削除で user_push_tokens が ON DELETE CASCADE で消える)
 */
export async function unregisterExpoPushToken(
  userId: string | null | undefined,
  options: UnregisterPushTokenOptions = {},
): Promise<UnregisterPushTokenResult> {
  if (!userId) return "skipped";
  const timeoutMs = options.timeoutMs ?? UNREGISTER_TIMEOUT_MS;

  const work = async (): Promise<UnregisterPushTokenResult> => {
    let token: string | null = null;
    let tokenSource: "stored" | "refetched" = "stored";
    try {
      token = await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:${userId}`);
    } catch {
      token = null;
    }

    if (!token && Device.isDevice) {
      // この変更より前のビルドで登録した端末は値を控えていない。取得し直す (通信が必要。失敗したら諦める)
      try {
        const { projectId } = resolveEasProjectId();
        token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : {})).data;
        tokenSource = "refetched";
      } catch {
        token = null;
      }
    }
    if (!token) return "skipped";

    const query = supabase
      .from("user_push_tokens")
      .delete({ count: "exact" })
      .eq("user_id", userId)
      .eq("expo_push_token", token);
    const { error, count } = await (options.accessToken
      ? query.setHeader("Authorization", `Bearer ${options.accessToken}`)
      : query);
    if (error) {
      captureEvent("push_token_unregister_failed", {
        platform: Platform.OS,
        error_name: typeof error.name === "string" ? error.name : "PostgrestError",
        error_code: typeof error.code === "string" ? error.code : "",
      });
      return "failed";
    }
    if (count === 0) {
      captureEvent("push_token_unregister_no_rows", {
        platform: Platform.OS,
        token_source: tokenSource,
        explicit_access_token: !!options.accessToken,
      });
      return "no_rows";
    }
    return "deleted";
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<UnregisterPushTokenResult>((resolve) => {
    timer = setTimeout(() => resolve("failed"), timeoutMs);
  });

  try {
    return await Promise.race([work().catch((): UnregisterPushTokenResult => "failed"), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
