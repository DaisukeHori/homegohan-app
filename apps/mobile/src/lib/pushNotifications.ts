import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  PUSH_TOKEN_CLAIM_API_PATH as SHARED_PUSH_TOKEN_CLAIM_API_PATH,
  type PushTokenClaimRequestBody,
  type PushTokenClaimResponseBody,
} from "@homegohan/shared";

import { getApi } from "./api";
import { httpStatusOfApiError } from "./api-error";
import {
  type PushIssueEvent,
  type PushIssueServerFields,
  type PushRegistrationStage,
  type PushValueSource,
  buildPushIssueLogBody,
  errorIdentifierOf,
  registrationFailureServerFields,
  unregisterErrorServerFields,
  unregisterNoRowsServerFields,
  unregisterUnfinishedServerFields,
} from "./push-issue-log";
import { readPushInstallSecret, savePushInstallSecret } from "./pushInstallSecret";
import {
  PUSH_TOKEN_VALUE_KEY_PREFIX,
  forgetPendingPushTokenReleases,
  waitForPushTokenReleases,
} from "./pushTokenRelease";
import { supabase } from "./supabase";

/**
 * この端末の Expo Push Token を DB に登録した後、値をローカルに控えるキーの接頭辞。
 * ログアウト時に「この端末の行だけ」を user_push_tokens から消すために使う (#1038 F7-10)。
 * 実際のキーは `${接頭辞}:${userId}`。ログアウトで clearUserScopedAsyncStorage() が消す
 * (src/lib/user-storage.ts の USER_ID_KEY_PREFIXES に載せている)。
 * 定義は pushTokenRelease.ts (AuthProvider から読むモジュールに、通知の部品を持ち込まないため。#1636)
 */
export { PUSH_TOKEN_VALUE_KEY_PREFIX };

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

/**
 * サーバーログ (POST /api/log) への送信を待つ上限 (ミリ秒)。
 * ログアウトの直前の削除の失敗は、サインアウトでセッションが消える前に送り終えたいので、この時間だけ待ってから先へ進む
 * (記録が残るのは端末からのサインアウトのとき。Web から始まったサインアウト・session-expired では、待ってもサーバー側の
 * セッションがふつうは先に失効していて残らない。理由は unregisterExpoPushToken の説明)。
 * 削除そのものの上限 (UNREGISTER_TIMEOUT_MS = 3 秒) と合わせても、ログアウトが止まるのは最長 5 秒。
 * 送れなかった記録は諦める (ログの欠けより、ログアウトが長く止まるほうが利用者に響く)。
 */
export const PUSH_ISSUE_LOG_TIMEOUT_MS = 2000;

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
 * 本文は push-issue-log.ts の buildPushIssueLogBody() で組み立てる (送ってよいキーはそこで決めてある。
 * キー名に token などの語を入れると sanitizeLogEntry が値を "***" にしてしまうため)。
 *
 * - 例外を投げない (reject もしない)。送れなくても (オフライン・未ログイン・環境変数なし・サーバーのエラー) 何もしない。
 *   送信の失敗を、ここからまた記録することはない (自分自身を呼び直さない)
 * - PUSH_ISSUE_LOG_TIMEOUT_MS で待つのをやめる。待つかどうかは呼び出し側が決める (登録は待たない。削除は待つ)
 * - accessToken を渡すと、Authorization に明示する (明示すると、共通の HTTP クライアントは端末のセッションのトークンで上書きしない)。
 *   明示しても、それで記録が残るわけではない。accessToken を渡されるのは Web から始まったサインアウト・session-expired
 *   (webViewAuthMessages.ts) だけで、そのときはサーバー側のセッションがふつうは先に失効している (Web の signOut() が全端末のセッションを失効させる)。
 *   /api/log はサーバーで getUser() (GoTrue の GET /user。JWT の session_id のセッションが残っているかまで確かめる) を呼ぶので、
 *   失効したセッションの JWT では 401 になり、app_logs には残らない。削除の DELETE が同じ JWT で通るのは、PostgREST が
 *   JWT の署名と期限しか見ないからで、/api/log はそうではない (tests/integration/security/push-issue-log-after-session-revoked.test.ts が
 *   本物のサーバーで確かめる)。明示は、削除と同じ本人の JWT で送るために残している (害は無い)
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
          buildPushIssueLogBody(event, fields),
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

/**
 * 登録の直後に呼ぶ、同じトークンのほかの利用者の行を外す API (#1599。src/app/api/push-tokens/claim/route.ts)。
 * 同じトークンは、最後に登録した 1 人にだけ紐づく。外すのは同じ端末の前の利用者の行だけ (端末の秘密の値で確かめる。#1636)。
 * 値の置き場は packages/shared/src/push-token-claim.ts
 */
export const PUSH_TOKEN_CLAIM_API_PATH = SHARED_PUSH_TOKEN_CLAIM_API_PATH;

/**
 * claim の本文を決める (#1636。packages/shared/src/push-token-claim.ts の PushTokenClaimRequestBody)。
 *   - 端末の秘密の値がある: それを送る (同じ端末の前の利用者の行と、ハッシュの無い古い行が外れる)
 *   - 無い: サーバーに作ってもらう (issue_install_secret。応答の値を保管庫に置く)
 *   - 保管庫を読めない: どちらも送らない (ハッシュの無い古い行だけが外れる。値を作り直すと、この端末の前の利用者の行を
 *     外せなくなるので、作り直さない。次の起動でやり直す)
 */
function claimBodyOf(
  token: string,
  secret: Awaited<ReturnType<typeof readPushInstallSecret>>,
): PushTokenClaimRequestBody {
  if (secret.status === "found") return { expo_push_token: token, install_secret: secret.secret };
  if (secret.status === "missing") return { expo_push_token: token, issue_install_secret: true };
  return { expo_push_token: token };
}

/** 登録失敗を端末のコンソールとサーバーログに出す (トークンやユーザー ID は載せない。サーバーログにはエラーの本文も載せない) */
function reportPushRegistrationFailure(
  stage: PushRegistrationStage,
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

  // 登録の失敗は、利用者の操作を待たせない (送り終えるのを待たない)
  void sendPushIssueToServer(
    "push_token_registration_failed",
    registrationFailureServerFields({
      stage,
      platform: Platform.OS,
      errorName: e?.name,
      errorCode: e?.code,
      httpStatus,
      projectIdSource: resolved.source,
      rejectedProjectIdSources: resolved.rejected.join(",") || "none",
    }),
  );
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

  // セッションの無いときの後片付け (pushTokenRelease.ts) がまだ動いていれば、終わってから登録する。
  // 未ログインの起動で始めた release が、すぐにログインした同じ利用者の登録し直した行を消さないようにするため (#1636)
  await waitForPushTokenReleases();

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

  // ログアウト時に「この端末の行だけ」を消せるよう、登録した値を控えておく (#1038 F7-10)。控えられなくても登録は成功扱い。
  // 下の claim より前に控える (claim が失敗しても、本人の行は登録済みなので、ログアウトで消せるようにする)
  try {
    await AsyncStorage.setItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:${auth.user.id}`, token);
  } catch {
    // ignore
  }

  // 同じトークンが別の利用者の行にも残っていれば、サーバーで外す (#1599)。
  // 共有の端末で、前の利用者のログアウトの削除がオフラインなどで失敗すると、前の利用者の行が残り、
  // この利用者がログインしたあとも前の利用者宛ての通知がこの端末に届き得る。RLS で本人の行しか触れないので、サーバーの API で外す。
  // 外すのは同じ端末の前の利用者の行だけ。端末の秘密の値 (端末ごとに 1 つ。pushInstallSecret.ts) で同じ端末かを確かめる (#1636)。
  // 失敗したら登録の失敗として投げる (起動時の自動登録 ensurePushTokenRegistered は、起動・ログインのたびに登録と claim をやり直すので、次の起動でやり直す)
  const secret = await readPushInstallSecret();
  let claimed: PushTokenClaimResponseBody | null;
  try {
    claimed = await getApi().post<PushTokenClaimResponseBody | null>(PUSH_TOKEN_CLAIM_API_PATH, claimBodyOf(token, secret));
  } catch (error) {
    reportPushRegistrationFailure("claim_token", error, resolved, httpStatusOfApiError(error));
    throw error;
  }

  // サーバーが作った端末の秘密の値を、保管庫に置く (置けなければ、次の claim でまた作ってもらう)
  if (secret.status === "missing" && typeof claimed?.install_secret === "string") {
    await savePushInstallSecret(claimed.install_secret);
  }
  // 秘密の値つきの claim で、同じ端末の前の利用者の行は外れた。同じトークンの release の控えは要らない (pushTokenRelease.ts)
  if (secret.status !== "unreadable") {
    await forgetPendingPushTokenReleases(token);
  }

  return token;
}

/**
 * ログイン済みのユーザーについて、この端末の push token を登録する (アプリの起動時と、ログインした利用者が変わったときに呼ぶ)。
 *
 * 起動・ログインのたびに、登録 (本人の行の upsert) と claim (同じトークンのほかの利用者の行を外す) を通す。どちらも何度呼んでも同じ結果になる。
 * 「登録済み」の印を見て省くことはしない (#1599)。claim は同じトークンのほかの利用者の行を消すので、印があっても行があるとは限らない。
 * 例: 共有の端末で、利用者 A のセッションが掃除を通らずに終わる (Web の signOut() による全端末の失効で、起動時の更新が失敗して
 * SIGNED_OUT になるなど) → 利用者 B がログインして claim で A の行を消す → A が再びログインする。このとき印で省くと、
 * A の行が無いまま再登録されず、A 宛ての通知がこの端末に届かなくなる。
 * 以前の印 (push_token_registered_v2 / v1) は読まず書かない (旧ビルドが残した印はログアウトで消す: user-storage.ts)。
 *
 * 権限のダイアログは、まだ一度も尋ねていない (undetermined) ときだけ出る (shouldAskForPermission)。拒否・実機でないときは何もせずに終わり、
 * 後から OS の設定で許可すれば、次の起動で登録される (#1038 F7-09)。例外は呼び出し側 (PushTokenRegistrar) が握りつぶす。
 */
export async function ensurePushTokenRegistered(): Promise<void> {
  // 登録する利用者は registerAndSaveExpoPushToken が getUser() で確かめる (いまのセッションの本人だけを登録する)
  await registerAndSaveExpoPushToken();
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
    /** 端末のコンソールに出す値 (サーバーには送らないので、キー名は以前のまま。token_source など) */
    console: Record<string, string | number | boolean>;
    /**
     * サーバーログに送る値 (決まった値だけ。push-issue-log.ts で組み立てる)。
     * キー名は sanitizeLogEntry にマスクされない名前 (token_source → push_value_source、explicit_access_token → explicit_auth_header)
     */
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
   *
   * サーバーログ (POST /api/log) への送信にも同じトークンを付けるが、/api/log はセッションの失効まで確かめるので、
   * セッションが失効していれば、そちらは 401 になって記録は残らない (下の unregisterExpoPushToken の説明を参照)。
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
 *   (消すと、他の端末では、次にアプリを起動するまで再登録されず、その間は通知が届かなくなる)
 * - RLS (本人の行のみ削除可) のため、サインアウトの「前」に呼ぶこと。
 *   セッションが先に失効してしまう場合 (Web からの sign-out / session-expired) は、控えておいたアクセストークンを options.accessToken で渡す
 * - 例外は投げない。失敗・タイムアウトでもログアウトは止めない
 *   (失敗・タイムアウト・途中の例外は push_token_unregister_failed として、端末のコンソールとサーバーログ (app_logs) に出す。#1413。
 *   サーバーログに残るのは端末からのサインアウトのときだけ。下の「ただし」を参照)
 * - 消えた行が 0 件のときも、エラーにならない (RLS は弾いた行を黙って除く) ので、件数を数えて端末のコンソールとサーバーログに出す
 *   (push_token_unregister_no_rows。サーバーログに残る範囲は上と同じ)。以前はこれを「削除できた」として扱っており、RLS で素通りしても気づけなかった
 * - サーバーログへの送信は、返る前に待つ (上限 PUSH_ISSUE_LOG_TIMEOUT_MS)。呼び出し側はこのあとサインアウトするので、
 *   セッションが消える前に送り終えるため (サインアウトのあとでは /api/log の認証を通らない)
 * - ただし、この順番で 0 件・失敗の記録を app_logs に残せるのは、端末からのサインアウト (設定・マイページ・パスワード再設定のあと。
 *   セッションが生きているまま呼ぶ) だけ。Web から始まったサインアウト・session-expired では、端末が記録を送る時点で、サーバー側の
 *   セッションがふつうは既に失効している (Web の signOut() が全端末のセッションを失効させる。session-expired は getUser() で失効を
 *   確かめてからログアウトするので必ず。Web からアカウントを削除したあとの sign-out も、ユーザーが消えているので同じ)。
 *   /api/log はサーバーの getUser() でセッションの存在まで確かめるので、控えたアクセストークン (options.accessToken) を付けて送っても
 *   401 になり、記録は残らない (端末のコンソールには出る)。端末が送るより前にサーバー側のセッションが消えているので、送る順番では防げない
 *   (sign-out は Web の signOut() の前に届くので、Web の失効より先に送れたときだけは残りうる)。
 *   この経路の記録を残すには、/api/log の認証 (サーバー側) を変える必要がある。削除そのものは、PostgREST が JWT の署名と期限しか
 *   見ないので、控えたトークンで通る
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
    let tokenSource: PushValueSource = "stored";
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
      return {
        result: "failed",
        issue: {
          event: "push_token_unregister_failed",
          console: { platform: Platform.OS, error_name: errorName, error_code: errorCode },
          server: unregisterErrorServerFields({
            platform: Platform.OS,
            errorName,
            errorCode,
            httpStatus: status,
            pushValueSource: tokenSource,
            explicitAuthHeader: explicitAccessToken,
          }),
        },
      };
    }
    if (count === 0) {
      return {
        result: "no_rows",
        issue: {
          event: "push_token_unregister_no_rows",
          console: { platform: Platform.OS, token_source: tokenSource, explicit_access_token: explicitAccessToken },
          server: unregisterNoRowsServerFields({
            platform: Platform.OS,
            pushValueSource: tokenSource,
            explicitAuthHeader: explicitAccessToken,
          }),
        },
      };
    }
    return { result: "deleted" };
  };

  /** 待ち時間の上限を過ぎた・途中で例外が起きたときの記録 (削除できたかどうかは分からない) */
  const unfinished = (reason: "timeout" | "exception", error?: unknown): UnregisterOutcome => {
    const rawErrorName = (error as { name?: unknown } | null | undefined)?.name;
    const errorName = errorIdentifierOf(rawErrorName);
    return {
      result: "failed",
      issue: {
        event: "push_token_unregister_failed",
        console: {
          platform: Platform.OS,
          reason,
          ...(reason === "exception" ? { error_name: errorName } : {}),
        },
        server: unregisterUnfinishedServerFields({
          platform: Platform.OS,
          reason,
          errorName: rawErrorName,
          explicitAuthHeader: explicitAccessToken,
        }),
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
    // 呼び出し側 (signOutWithCleanup) は、これを待ってからサインアウトする。控えたアクセストークンがあれば Authorization に明示するが、
    // それを渡されるのは Web から始まったサインアウト・session-expired で、サーバー側のセッションがふつうは先に失効しているため
    // /api/log は 401 を返し、記録は残らない (この関数の説明の「ただし」を参照)
    await sendPushIssueToServer(outcome.issue.event, outcome.issue.server, { accessToken: options.accessToken });
  }
  return outcome.result;
}
