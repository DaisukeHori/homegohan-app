/**
 * ログアウトの共通処理 (#1038 F7-10)。
 *
 * 順番が大事なので、各画面でバラバラに書かず、ここにまとめる。
 *   1. この端末の Expo Push Token を user_push_tokens から消す
 *      - RLS で本人の行しか消せない。サインアウトするとできなくなるので、必ず「前」に行う
 *      - 消さないと、共有端末で次にログインした別のユーザーの端末にも、前のユーザー宛ての通知が届き得る
 *        (UNIQUE(user_id, expo_push_token) なので、同じ端末のトークンが複数ユーザーの行に併存できてしまう)
 *   2. ユーザーごとのローカルデータを消す (CLAUDE.md: サインアウトの前に行う)
 *      - AsyncStorage の利用者別のキー (user-storage.ts)
 *      - WebView の利用者別の localStorage (#1037)。次に WebView を開いたとき、Web のページが読み込まれる前に消させる
 *        (webViewUserStorageCleanup.ts。ネイティブのログアウトは Web の画面の掃除を通らないため)
 *      - 掃除は userScopedLocalData.ts の clearUserScopedLocalData にまとめてあり、起動時に失効が分かったときの
 *        端末側だけのサインアウト (AuthProvider) も同じものを通る (#1599)。AuthProvider は、起動時に未ログインと決まったときと
 *        SIGNED_OUT でも同じものを通す (#1615)。ここでのサインアウトのあとに届く SIGNED_OUT で、掃除がもう一度走る (害は無い)。
 *        Web の session-expired では、getUser() が端末のセッションを消すので、SIGNED_OUT の掃除が 1 より前に走ることがある。
 *        SIGNED_OUT の掃除は push token の値 (1 で読む) を残すので、1 は控えた値で行を消せる (AuthProvider.tsx の先頭の表)
 *   3. サインアウト (保管庫のセッションを消す)
 *
 * 1 の前に、ストアの購入 (RevenueCat) の利用者を外す (resetPurchasesOnSignOut。billing/03 §8.10)。次にログインした別の利用者に
 * 購入を引き継がないため。失敗しても投げない (次の identify が logIn で切り替える)。退会のあとの signOutAfterAccountDeletion も同じ。
 *
 * 1 の削除が失敗した・0 件だったときは、2 の掃除が値 (push_token_value_v1:<利用者>) を消す前に、その行を release の宛先として控える
 * (#1706。pushTokenRelease.ts の recordPushTokenRelease。通信はしない)。セッションが既に失効している経路 (退会の API が 401 を返したときの
 * ログアウトなど) では、RLS の削除が 0 件・失敗になりうる。控えないと、あとに届く SIGNED_OUT の release (releasePushTokenAfterSignedOut) は
 * 2 で消えた値を読めず、行が残る。控えた宛先は、その SIGNED_OUT の release か、起動時に未ログインと決まったときのやり直し
 * (flushPendingPushTokenReleases) が、端末の秘密の値で消す。削除できたとき・何もしなかったとき (skipped) は控えない。
 *
 * アカウント削除では使わない。auth.users の削除で user_push_tokens が ON DELETE CASCADE で消える。
 *
 * push token の削除に失敗してもログアウトは止めない (unregisterExpoPushToken は例外を投げない。万一投げても、失敗として扱って続ける)。
 *
 * 設定画面のように、セッションが生きているまま呼ぶ場合は userId だけでよい (削除は現在のセッションで認可される)。
 * Web (WebView) からの sign-out / session-expired を処理する場合 (webViewAuthMessages.ts) は、Web 側のログアウトが
 * 全端末のセッションをサーバーで失効させ、処理の途中で getUser() が端末のセッションを消すことがある。
 * 呼び出し側が処理の最初に控えた userId と accessToken を渡す。accessToken があれば、削除はそのトークンで認可される。
 */

import { resetPurchasesOnSignOut } from "./purchases";
import { type UnregisterPushTokenResult, unregisterExpoPushToken } from "./pushNotifications";
import { recordPushTokenRelease } from "./pushTokenRelease";
import { secureSessionStorage } from "./secureSessionStorage";
import { SUPABASE_AUTH_STORAGE_KEY, supabase } from "./supabase";
import { clearUserScopedLocalData } from "./userScopedLocalData";

export type SignOutOptions = {
  /** push token の削除を認可する、本人のアクセストークン。セッションが先に失効する場合に、呼び出し側が控えた値を渡す */
  accessToken?: string | null;
};

/** サインアウトが失敗したとき、画面の状態からもセッションを消すための関数 (AuthProvider の clearSession) */
export type ForgetSessionOptions = {
  clearSession: () => void;
};

/**
 * push token の削除の結果のうち、行が残っているかもしれないもの (#1706)。
 *   - failed: エラー・タイムアウト・途中の例外。行が消えたかどうか分からない
 *   - no_rows: 削除は通ったが 0 件。RLS に弾かれた (セッションが失効している) か、行が既に無い
 * deleted (消した) と skipped (利用者や値が分からず何もしなかった。控える値も無い) は含めない
 */
const UNREGISTER_RESULTS_NEEDING_RELEASE: ReadonlySet<UnregisterPushTokenResult> = new Set<UnregisterPushTokenResult>([
  "failed",
  "no_rows",
]);

/**
 * この端末の push token の行を消す。消せなかった (失敗・0 件) ときは、掃除が値を消す前に release の宛先として控える (#1706。先頭の説明)。
 * 行が既に無かった (release や CASCADE が先に消した) ときも控えるが、release は合う行が無ければ 0 件で 200 を返し、控えから外れるだけ (害は無い)。
 * 例外は投げない (ログアウトを止めない)
 */
async function unregisterPushTokenOrRecordRelease(
  userId: string | null | undefined,
  accessToken: string | null | undefined,
): Promise<void> {
  let result: UnregisterPushTokenResult;
  try {
    result = await unregisterExpoPushToken(userId, { accessToken });
  } catch {
    // unregisterExpoPushToken は例外を投げないが、万一投げたら、行が消えたかどうか分からないので失敗として扱う
    result = "failed";
  }
  if (!UNREGISTER_RESULTS_NEEDING_RELEASE.has(result)) return;
  try {
    await recordPushTokenRelease(userId);
  } catch {
    // 控えは例外を投げないが、万一投げても、ログアウトは続ける
  }
}

/**
 * サインアウトし、失敗したら端末だけでセッションを忘れる。例外は投げない。
 *
 * supabase.auth.signOut() は、例外を投げずに { error } を返して終わることがある (@supabase/auth-js の _signOut)。2 つの枝がある。
 *   - access token が失効していて更新もできない (オフライン・5xx・失敗の控えの間): サーバーへのログアウトを呼ばずに { error } を返し、
 *     保管庫のセッションを消さず、SIGNED_OUT も届かない。AuthProvider はセッションを持ったままになり、"/" へ移ると
 *     入口 (app/index.tsx) がホームへ戻してしまう。この関数の端末での消去が後始末の本体
 *   - access token が有効なうち: サーバーへのログアウトが通信の失敗などで失敗しても、supabase-js が保管庫のセッションを消して
 *     SIGNED_OUT を出す (auth-js 2.117。#1768)。端末での消去は重なるが害は無い (無いキーの removeItem と null への setSession)
 * そこで、エラーが返った・例外が投げられたときは
 *   1. 保管庫のセッションを端末だけで消す (clearStoredSessionLocally)
 *   2. AuthProvider の画面の状態を消す (clearSession)
 * 戻り値の error はサインアウトの失敗 (端末のセッションと画面の状態は消してある)。
 */
async function signOutOrForgetLocally({ clearSession }: ForgetSessionOptions): Promise<{ error: unknown | null }> {
  let error: unknown | null = null;
  try {
    const result = await supabase.auth.signOut();
    error = result?.error ?? null;
  } catch (thrown) {
    error = thrown ?? new Error("supabase.auth.signOut threw a nullish value");
  }

  if (error) {
    await clearStoredSessionLocally();
    clearSession();
  }
  return { error };
}

/**
 * ログアウトの共通処理 (push token の削除 → 端末データの削除 → サインアウト)。
 * 削除が失敗・0 件なら、端末データの削除の前に release の宛先を控える (#1706。先頭の説明)。
 * サインアウトの { error } はそのまま返し、失敗時の端末側の後始末はしない。
 * 利用者が設定画面で押す通常のログアウトは signOutOnDevice を使う (失敗しても端末のセッションを消す)。
 */
export async function signOutWithCleanup(
  userId: string | null | undefined,
  options: SignOutOptions = {},
): Promise<{ error: unknown | null }> {
  await resetPurchasesOnSignOut();
  await unregisterPushTokenOrRecordRelease(userId, options.accessToken);
  await clearUserScopedLocalData(userId);

  const result = await supabase.auth.signOut();
  return { error: result?.error ?? null };
}

/**
 * 利用者が設定画面で押す、通常のログアウト (#1037)。
 * アカウントの画面 (settings/account.tsx) も、退会の API が 401 (ログインが切れている) を返したときに使う
 * (アカウントは消えていないので、退会のあとの signOutAfterAccountDeletion ではない。#1562)。
 *
 * signOutWithCleanup と同じ順 (push token の削除 → 端末データの削除 → サインアウト) で後片付けし
 * (削除が失敗・0 件なら、端末データの削除の前に release の宛先を控える。#1706。退会の API が 401 を返したときは、
 * セッションが失効していて削除が 0 件・失敗になりうる)、
 * サインアウトが失敗したら (オフラインなど)、退会のあとと同じく端末だけでセッションを忘れる (signOutOrForgetLocally)。
 * 失敗のまま "/" へ移ると、入口がホームへ戻し、「ログアウトしたのに戻された」ように見えるため。
 *
 * 戻り値の error はサインアウトの失敗 (端末のセッションと画面の状態は消してある)。例外は投げない。
 */
export async function signOutOnDevice(
  userId: string | null | undefined,
  options: ForgetSessionOptions & SignOutOptions,
): Promise<{ error: unknown | null }> {
  await resetPurchasesOnSignOut();
  await unregisterPushTokenOrRecordRelease(userId, options.accessToken);
  await clearUserScopedLocalData(userId);
  return signOutOrForgetLocally(options);
}

/**
 * 退会 (アカウントの削除) が済んだあとのログアウト (#1037)。
 *
 * signOutWithCleanup と違い、push token は消さない (auth.users の削除で user_push_tokens が ON DELETE CASCADE で消える)。
 *   1. ユーザーごとのローカルデータ (AsyncStorage・WebView の localStorage) を消す (CLAUDE.md: サインアウトの前に行う)
 *   2. サインアウト
 *   3. サインアウトが失敗したら、保管庫のセッションと画面の状態を端末だけで消す (signOutOrForgetLocally)
 *
 * 退会はサーバーで済んでいるので、消えたアカウントのセッションを端末に残さないよう、3 で必ず消す。
 * 戻り値の error はサインアウトの失敗 (3 で端末のセッションと画面の状態は消してある)。例外は投げない。
 */
export async function signOutAfterAccountDeletion(
  userId: string | null | undefined,
  options: ForgetSessionOptions,
): Promise<{ error: unknown | null }> {
  await resetPurchasesOnSignOut();
  await clearUserScopedLocalData(userId);
  return signOutOrForgetLocally(options);
}

/**
 * 保管庫 (secureSessionStorage) のセッションを、サーバーに問い合わせずに消す。
 * supabase.auth.signOut() は scope: "local" でも、access token が失効していて更新もできないと、サーバーへのログアウトに届かずに { error } を返して消さないため、保管庫を直接消す。
 * PKCE の code-verifier (supabase-js が `<保存キー>-code-verifier` に置く) も一緒に消す。
 * 保管庫の削除に失敗しても、このプロセスの間は消えたものとして扱われる (secureSessionStorage の removeItem)。例外は投げない。
 */
export async function clearStoredSessionLocally(): Promise<void> {
  for (const key of [SUPABASE_AUTH_STORAGE_KEY, `${SUPABASE_AUTH_STORAGE_KEY}-code-verifier`]) {
    try {
      await secureSessionStorage.removeItem(key);
    } catch {
      // 消せなくても続ける (呼び出し側が画面の状態を消し、ログイン画面へ移る)
    }
  }
}
