/**
 * ログアウト (signOut.ts) を通らずにセッションが終わったときに、この端末の push token の、サインアウトした利用者の行を
 * user_push_tokens から消す (#1636)。
 *
 * signOut.ts は、サインアウトの前に本人のセッション (RLS) で行を消す。ところが、自動更新で refresh_token が失効と答えた
 * SIGNED_OUT などでは signOut.ts を通らず、セッションももう無いので RLS では消せない。行が残ると、未ログインのままの
 * 共有の端末に、前の利用者宛ての通知が届き続ける (次に誰かがログインして claim するまで)。
 * そこで、セッション無しの release の API (POST /api/push-tokens/release) を、端末の秘密の値 (pushInstallSecret.ts) で認可して呼ぶ。
 * サーバーは、利用者 ID・トークン・秘密の値のハッシュの 3 つが合う行だけを消す。
 *
 * 消せなかったとき (圏外・メンテナンス中の 503・サーバーのエラー) は、消す宛先 (利用者 ID とトークンの値) を AsyncStorage に
 * 控え (PUSH_TOKEN_RELEASE_PENDING_KEY)、次の起動 (未ログインと決まったとき) と次の SIGNED_OUT でやり直す。
 * 控えは利用者別のキーではない (ログアウトの掃除で消さない): 次の利用者がログインしても、前の利用者の行を消し終えるまで残す。
 * 中身は利用者 ID とこの端末のトークンの値だけで、画面にも次の利用者にも出ない。
 * 控えは、同じトークンの claim が成功したとき (同じ端末の前の利用者の行はそれで外れる) にも消す (forgetPendingPushTokenReleases)。
 *
 * AuthProvider から呼ぶので、通知・端末の情報のモジュール (expo-notifications・expo-device) を読まない。
 * どの関数も例外を投げない (サインアウト・起動を止めない)。同時に呼ばれたら 1 つずつ順に動く (控えの読み書きが混ざらないように)。
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { PUSH_TOKEN_RELEASE_API_PATH, type PushTokenReleaseRequestBody } from "@homegohan/shared";

import { getApi } from "./api";
import { httpStatusOfApiError } from "./api-error";
import { readPushInstallSecret } from "./pushInstallSecret";

/**
 * この端末の Expo Push Token を DB に登録した後、値をローカルに控えるキーの接頭辞 (#1038 F7-10)。実際のキーは `${接頭辞}:${userId}`。
 * pushNotifications.ts が書き、ログアウト (signOut.ts) とここが読む。ログアウトで clearUserScopedAsyncStorage() が消す
 * (src/lib/user-storage.ts の USER_ID_KEY_PREFIXES に載せている。SIGNED_OUT の掃除だけは残す)
 */
export const PUSH_TOKEN_VALUE_KEY_PREFIX = "push_token_value_v1";

/** 消せなかった release の宛先の控え (AsyncStorage。JSON の配列 [{ userId, token }]) */
export const PUSH_TOKEN_RELEASE_PENDING_KEY = "push_token_release_pending_v1";

/**
 * 控えておく宛先の数の上限。同じ端末でセッションが切れた利用者の数で、ふつうは 1〜2 件。
 * 消せない状態が長く続いても控えが増え続けないよう、古いものから捨てる (捨てた行は、次にこの端末でログインした利用者の claim が外す)
 */
export const MAX_PENDING_PUSH_TOKEN_RELEASES = 10;

/**
 * release の 1 回の通信を待つ上限 (ミリ秒)。後片付けなので画面は待たないが、起動のたびに長く通信を抱えないよう短めにする。
 * 自動のやり直しはしない (消せなければ控えて、次の起動でやり直す)
 */
export const PUSH_TOKEN_RELEASE_TIMEOUT_MS = 5000;

/** 400 (本文の形が違う)。やり直しても通らないので、控えから捨てる */
const HTTP_BAD_REQUEST = 400;

type PendingRelease = { userId: string; token: string };

function isPendingRelease(value: unknown): value is PendingRelease {
  const v = value as { userId?: unknown; token?: unknown } | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.userId === "string" &&
    v.userId !== "" &&
    typeof v.token === "string" &&
    v.token !== ""
  );
}

/** 控えを読む。読めない・壊れているときは空 (やり直しの宛先を失うだけで、害は無い) */
async function readPending(): Promise<PendingRelease[]> {
  try {
    const raw = await AsyncStorage.getItem(PUSH_TOKEN_RELEASE_PENDING_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPendingRelease) : [];
  } catch {
    return [];
  }
}

/** 控えを書く (空なら消す)。上限を超えたら古いものから捨てる */
async function writePending(entries: PendingRelease[]): Promise<void> {
  try {
    if (entries.length === 0) {
      await AsyncStorage.removeItem(PUSH_TOKEN_RELEASE_PENDING_KEY);
      return;
    }
    await AsyncStorage.setItem(
      PUSH_TOKEN_RELEASE_PENDING_KEY,
      JSON.stringify(entries.slice(-MAX_PENDING_PUSH_TOKEN_RELEASES)),
    );
  } catch {
    // 控えられなくても、サインアウト・起動は止めない
  }
}

let queue: Promise<void> = Promise.resolve();

/** 控えの読み書きを伴う処理を 1 つずつ順に動かす。例外は外へ出さない */
function serialized(task: () => Promise<void>): Promise<void> {
  const run = queue.then(task).catch(() => undefined);
  queue = run;
  return run;
}

/** 控えの宛先を release の API で消す。消せたもの・やり直しても通らないもの (400) を控えから外す */
async function flushLocked(): Promise<void> {
  const pending = await readPending();
  if (pending.length === 0) return;

  const secret = await readPushInstallSecret();
  if (secret.status === "unreadable") return; // 保管庫を読めない (ロックを一度も解除していない起動など): 次に回す
  if (secret.status === "missing") {
    // 端末の秘密の値が無い: この端末の行はハッシュを持たない (古い版のアプリの行) か、値を失った。どちらも release では消せない
    // (次にこの端末でログインした利用者の claim が外す)。やり直しても通らないので、控えを捨てる
    await writePending([]);
    return;
  }

  const remaining: PendingRelease[] = [];
  for (const entry of pending) {
    const body: PushTokenReleaseRequestBody = {
      expo_push_token: entry.token,
      install_secret: secret.secret,
      user_id: entry.userId,
    };
    try {
      await getApi().post(PUSH_TOKEN_RELEASE_API_PATH, body, {
        retry: false,
        timeoutMs: PUSH_TOKEN_RELEASE_TIMEOUT_MS,
      });
    } catch (error) {
      if (httpStatusOfApiError(error) !== HTTP_BAD_REQUEST) remaining.push(entry);
    }
  }
  await writePending(remaining);
}

/**
 * SIGNED_OUT (supabase-js がセッションを消したあと) に呼ぶ。サインアウトした利用者の、この端末の push token の行を消す。
 * 値は、SIGNED_OUT の掃除 (clearUserScopedLocalDataAfterSignedOut) が残した push_token_value_v1:<利用者> から読む
 * (ログアウト (signOut.ts) を通ったときは、そこで行を消して値も消してあるので、ここでは何もしない)。
 * 消せなかったら控え、前に控えた宛先もあわせてやり直す。例外は投げない
 */
export function releasePushTokenAfterSignedOut(userId: string | null | undefined): Promise<void> {
  return serialized(async () => {
    await recordLocked(userId);
    await flushLocked();
  });
}

/** この利用者の、この端末の push token の値 (push_token_value_v1:<利用者>) を、release の宛先として控える (通信はしない) */
async function recordLocked(userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  let token: string | null = null;
  try {
    token = await AsyncStorage.getItem(`${PUSH_TOKEN_VALUE_KEY_PREFIX}:${userId}`);
  } catch {
    token = null;
  }
  if (!token) return;
  const pending = await readPending();
  if (!pending.some((entry) => entry.userId === userId && entry.token === token)) {
    await writePending([...pending, { userId, token }]);
  }
}

/**
 * release の宛先を控えるだけ (通信はしない)。例外は投げない。
 * 起動時にサーバーがセッションの失効を明言したとき (AuthProvider の restoreSession) に、掃除で値が消える前に呼ぶ。
 * その経路は signOut.ts を通らず、掃除が値を消してからサインアウトするので、あとに届く SIGNED_OUT の release は値を読めない。
 * 控えた宛先は、その SIGNED_OUT の release (やり直し) が消す
 */
export function recordPushTokenRelease(userId: string | null | undefined): Promise<void> {
  return serialized(() => recordLocked(userId));
}

/** 起動時に未ログインと決まったときに呼ぶ。前に消せなかった宛先をやり直す。例外は投げない */
export function flushPendingPushTokenReleases(): Promise<void> {
  return serialized(flushLocked);
}

/**
 * 同じトークンの claim が、端末の秘密の値つきで成功したときに呼ぶ (pushNotifications.ts)。そのトークンの宛先を控えから外す
 * (claim が同じ端末の前の利用者の行を外したので、やり直す必要が無い。ログイン中に、いまの利用者の行を消しに行かないためでもある)。
 * 例外は投げない
 */
export function forgetPendingPushTokenReleases(token: string): Promise<void> {
  return serialized(async () => {
    const pending = await readPending();
    const remaining = pending.filter((entry) => entry.token !== token);
    if (remaining.length !== pending.length) await writePending(remaining);
  });
}

/**
 * いま動いている release (と、その前に積まれたもの) が終わるのを待つ。例外は投げない。
 * 登録 (pushNotifications.ts の registerAndSaveExpoPushToken) が、本人の行を upsert する前に呼ぶ。
 * 未ログインの起動で始めた release が、そのあとにすぐログインした同じ利用者の登録し直した行を消さないようにするため
 * (release はサーバーで、利用者 ID・トークン・ハッシュが合う行を消す。登録し直した行は同じ 3 つを持つ)
 */
export function waitForPushTokenReleases(): Promise<void> {
  return serialized(async () => undefined);
}
