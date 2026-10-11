import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { getApi } from "./api";
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

/** サーバーログ (app_logs) にも残す、push token の登録・削除の異常 (#1413) */
export type PushIssueEvent =
  | "push_token_registration_failed"
  | "push_token_unregister_failed"
  | "push_token_unregister_no_rows";

/** サーバーログに送る値。どれも決まった値 (列挙・コード・数・真偽) だけにする。トークンの値やエラーの本文は入れない */
type PushIssueServerFields = Record<string, string | number | boolean>;

/**
 * サーバーログ (POST /api/log) への送信を待つ上限 (ミリ秒)。
 * ログアウトの直前の削除の失敗は、サインアウトでセッションが消える前に送り終えたいので、この時間だけ待ってから先へ進む。
 * 削除そのものの上限 (UNREGISTER_TIMEOUT_MS = 3 秒) と合わせても、ログアウトが止まるのは最長 5 秒。
 * 送れなかった記録は諦める (ログの欠けより、ログアウトが長く止まるほうが利用者に響く)。
 */
export const PUSH_ISSUE_LOG_TIMEOUT_MS = 2000;

/** サーバーログに送る level。どれも利用者の操作は止めていない (握りつぶしている) 異常なので warn */
const PUSH_ISSUE_LOG_LEVEL = "warn";

/**
 * エラーの名前・コードとして送ってよい形 (英数字と . _ : - だけ、短いもの)。
 * PostgrestError の code (SQLSTATE '42501' や 'PGRST301') や、Expo の CodedError の code ('ERR_...')、
 * エラーの class 名 ('PostgrestError') はこの形に収まる。収まらない値 (文が入った値など) は送らない。
 */
const ERROR_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** この形に収まらない名前・コードの代わりに送る値 */
const UNKNOWN_ERROR_IDENTIFIER = "unknown";

/** エラーの名前・コードを、送ってよい形に絞る (形が違えば unknown) */
function errorIdentifierOf(value: unknown): string {
  return typeof value === "string" && ERROR_IDENTIFIER_PATTERN.test(value) ? value : UNKNOWN_ERROR_IDENTIFIER;
}

/** HTTP の状態の数字 (整数) なら返す。それ以外は undefined (送らない) */
function httpStatusOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * 登録・削除の異常を、端末のコンソールに出す (トークンやユーザー ID は載せない。例外は投げない)。
 *
 * 呼び出し元は失敗を握りつぶす (起動時の自動登録、ログアウト) ので、開発中に気づけるようにするためのもの。
 * PostHog などの外部の計測サービスには送らない (#1166)。サーバーログ (app_logs) へは sendPushIssueToServer() が送る。
 */
function reportPushIssue(event: string, details: Record<string, string | number | boolean>): void {
  try {
    console.warn(`[pushNotifications] ${event}`, details);
  } catch {
    // ignore
  }
}

/**
 * 登録・削除の異常を、サーバーログ (POST /api/log → app_logs) に残す (#1413)。
 * エラー境界の記録 (error-report.ts) と同じ経路。サーバー側 (sanitizeLogEntry) も秘密情報をマスクするが、
 * ここでも送る値を決まった値 (イベント名・OS・エラーの種類・件数など) に絞り、トークンの値やエラーの本文は送らない。
 *
 * - 例外を投げない (reject もしない)。送れなくても (オフライン・未ログイン・環境変数なし・サーバーのエラー) 何もしない。
 *   送信の失敗を、ここからまた記録することはない (自分自身を呼び直さない)
 * - PUSH_ISSUE_LOG_TIMEOUT_MS で待つのをやめる。待つかどうかは呼び出し側が決める (登録は待たない。削除は待つ)
 * - accessToken を渡すと、それで認可する (Authorization を明示すると、共通の HTTP クライアントは上書きしない)。
 *   ログアウトの途中で端末のセッションが先に消える場合 (Web からの sign-out) に、控えたトークンで送るため
 */
function sendPushIssueToServer(
  event: PushIssueEvent,
  fields: PushIssueServerFields,
  options: { accessToken?: string | null } = {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const send = Promise.resolve()
      .then(() =>
        getApi().post(
          "/api/log",
          {
            level: PUSH_ISSUE_LOG_LEVEL,
            message: `push token issue: ${event}`,
            metadata: { app: "mobile", event, ...fields },
          },
          {
            ...(options.accessToken ? { headers: { Authorization: `Bearer ${options.accessToken}` } } : {}),
            timeoutMs: PUSH_ISSUE_LOG_TIMEOUT_MS,
            // 記録のために同じ送信を繰り返さない (サインアウトを待たせない)
            retry: false,
          },
        ),
      )
      .then(
        () => undefined,
        () => undefined,
      );
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PUSH_ISSUE_LOG_TIMEOUT_MS);
    });
    return Promise.race([send, limit])
      .catch(() => undefined)
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  } catch {
    if (timer) clearTimeout(timer);
    return Promise.resolve();
  }
}

/** 登録失敗を端末のコンソールとサーバーログに出す (トークンやユーザー ID は載せない。サーバーログにはエラーの本文も載せない) */
function reportPushRegistrationFailure(
  stage: "get_token" | "save_token",
  error: unknown,
  resolved: ResolvedEasProjectId,
  httpStatus?: number,
): void {
  const e = error as { name?: unknown; message?: unknown; code?: unknown } | null | undefined;
  reportPushIssue("push_token_registration_failed", {
    stage,
    platform: Platform.OS,
    error_name: typeof e?.name === "string" ? e.name : "unknown",
    error_message: typeof e?.message === "string" ? e.message.slice(0, 200) : "",
    project_id_source: resolved.source,
    rejected_project_id_sources: resolved.rejected.join(",") || "none",
  });

  const status = httpStatusOf(httpStatus);
  // 登録の失敗は、利用者の操作を待たせない (送り終えるのを待たない)
  void sendPushIssueToServer("push_token_registration_failed", {
    stage,
    platform: Platform.OS,
    error_name: errorIdentifierOf(e?.name),
    error_code: errorIdentifierOf(e?.code),
    ...(status === undefined ? {} : { http_status: status }),
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
  const { error, status } = await supabase.from("user_push_tokens").upsert(
    {
      user_id: auth.user.id,
      expo_push_token: token,
      platform: Platform.OS,
    },
    { onConflict: "user_id,expo_push_token" }
  );
  if (error) {
    reportPushRegistrationFailure("save_token", error, resolved, status);
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

/** 削除の結果と、端末のコンソール・サーバーログに残す異常 (あれば) */
type UnregisterOutcome = {
  result: UnregisterPushTokenResult;
  issue?: {
    event: PushIssueEvent;
    /** 端末のコンソールに出す値 */
    console: Record<string, string | number | boolean>;
    /** サーバーログに送る値 (決まった値だけ) */
    server: PushIssueServerFields;
  };
};

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
 * - 例外は投げない。失敗・タイムアウトでもログアウトは止めない
 *   (失敗・タイムアウト・途中の例外は push_token_unregister_failed として、端末のコンソールとサーバーログ (app_logs) に出す。#1413)
 * - 消えた行が 0 件のときも、エラーにならない (RLS は弾いた行を黙って除く) ので、件数を数えて端末のコンソールとサーバーログに出す
 *   (push_token_unregister_no_rows)。以前はこれを「削除できた」として扱っており、RLS で素通りしても気づけなかった
 * - サーバーログへの送信は、返る前に待つ (上限 PUSH_ISSUE_LOG_TIMEOUT_MS)。呼び出し側はこのあとサインアウトするので、
 *   セッションが消える前に送り終えるため (サインアウトのあとでは /api/log の認証を通らない)
 * - アカウント削除では呼ばなくてよい (auth.users の削除で user_push_tokens が ON DELETE CASCADE で消える)
 */
export async function unregisterExpoPushToken(
  userId: string | null | undefined,
  options: UnregisterPushTokenOptions = {},
): Promise<UnregisterPushTokenResult> {
  if (!userId) return "skipped";
  const timeoutMs = options.timeoutMs ?? UNREGISTER_TIMEOUT_MS;

  const explicitAccessToken = !!options.accessToken;

  const work = async (): Promise<UnregisterOutcome> => {
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
    if (!token) return { result: "skipped" };

    const query = supabase
      .from("user_push_tokens")
      .delete({ count: "exact" })
      .eq("user_id", userId)
      .eq("expo_push_token", token);
    const { error, count, status } = await (options.accessToken
      ? query.setHeader("Authorization", `Bearer ${options.accessToken}`)
      : query);
    if (error) {
      const errorName = typeof error.name === "string" ? error.name : "PostgrestError";
      const errorCode = typeof error.code === "string" ? error.code : "";
      const httpStatus = httpStatusOf(status);
      return {
        result: "failed",
        issue: {
          event: "push_token_unregister_failed",
          console: { platform: Platform.OS, error_name: errorName, error_code: errorCode },
          server: {
            platform: Platform.OS,
            reason: "error",
            error_name: errorIdentifierOf(errorName),
            error_code: errorIdentifierOf(errorCode),
            ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
            token_source: tokenSource,
            explicit_access_token: explicitAccessToken,
          },
        },
      };
    }
    if (count === 0) {
      return {
        result: "no_rows",
        issue: {
          event: "push_token_unregister_no_rows",
          console: { platform: Platform.OS, token_source: tokenSource, explicit_access_token: explicitAccessToken },
          server: {
            platform: Platform.OS,
            token_source: tokenSource,
            explicit_access_token: explicitAccessToken,
            deleted_count: 0,
          },
        },
      };
    }
    return { result: "deleted" };
  };

  /** 待ち時間の上限を過ぎた・途中で例外が起きたときの記録 (削除できたかどうかは分からない) */
  const unfinished = (reason: "timeout" | "exception", error?: unknown): UnregisterOutcome => {
    const errorName = errorIdentifierOf((error as { name?: unknown } | null | undefined)?.name);
    return {
      result: "failed",
      issue: {
        event: "push_token_unregister_failed",
        console: {
          platform: Platform.OS,
          reason,
          ...(reason === "exception" ? { error_name: errorName } : {}),
        },
        server: {
          platform: Platform.OS,
          reason,
          ...(reason === "exception" ? { error_name: errorName } : {}),
          explicit_access_token: explicitAccessToken,
        },
      },
    };
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<UnregisterOutcome>((resolve) => {
    timer = setTimeout(() => resolve(unfinished("timeout")), timeoutMs);
  });

  let outcome: UnregisterOutcome;
  try {
    outcome = await Promise.race([work().catch((error: unknown) => unfinished("exception", error)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (outcome.issue) {
    reportPushIssue(outcome.issue.event, outcome.issue.console);
    // サインアウトの直前に呼ばれるので、セッションが消える前にサーバーログへ送り終える (上限 PUSH_ISSUE_LOG_TIMEOUT_MS)。
    // 呼び出し側 (signOutWithCleanup) は、これを待ってからサインアウトする。控えたアクセストークンがあれば、それで認可する
    await sendPushIssueToServer(outcome.issue.event, outcome.issue.server, { accessToken: options.accessToken });
  }
  return outcome.result;
}
