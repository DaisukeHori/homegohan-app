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
 * アカウント削除では使わない。auth.users の削除で user_push_tokens が ON DELETE CASCADE で消える。
 *
 * push token の削除に失敗してもログアウトは止めない (unregisterExpoPushToken は例外を投げない)。
 *
 * 設定画面のように、セッションが生きているまま呼ぶ場合は userId だけでよい (削除は現在のセッションで認可される)。
 * Web (WebView) からの sign-out / session-expired を処理する場合 (webViewAuthMessages.ts) は、Web 側のログアウトが
 * 全端末のセッションをサーバーで失効させ、処理の途中で getUser() が端末のセッションを消すことがある。
 * 呼び出し側が処理の最初に控えた userId と accessToken を渡す。accessToken があれば、削除はそのトークンで認可される。
 */

import { unregisterExpoPushToken } from "./pushNotifications";
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
 * サインアウトし、失敗したら端末だけでセッションを忘れる。例外は投げない。
 *
 * supabase.auth.signOut() は、サーバーへのログアウトの呼び出しが通信の失敗などで失敗すると、
 * 例外を投げずに { error } を返し、保管庫のセッションを消さないまま終わる (@supabase/auth-js の _signOut)。
 * そのとき SIGNED_OUT も届かないので、AuthProvider はセッションを持ったままになり、"/" へ移ると入口 (app/index.tsx) が
 * ホームへ戻してしまう。そこで、エラーが返った・例外が投げられたときは
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
 * サインアウトの { error } はそのまま返し、失敗時の端末側の後始末はしない。
 * 利用者が設定画面で押す通常のログアウトは signOutOnDevice を使う (失敗しても端末のセッションを消す)。
 */
export async function signOutWithCleanup(
  userId: string | null | undefined,
  options: SignOutOptions = {},
): Promise<{ error: unknown | null }> {
  await unregisterExpoPushToken(userId, { accessToken: options.accessToken });
  await clearUserScopedLocalData(userId);

  const result = await supabase.auth.signOut();
  return { error: result?.error ?? null };
}

/**
 * 利用者が設定画面で押す、通常のログアウト (#1037)。
 *
 * signOutWithCleanup と同じ順 (push token の削除 → 端末データの削除 → サインアウト) で後片付けし、
 * サインアウトが失敗したら (オフラインなど)、退会のあとと同じく端末だけでセッションを忘れる (signOutOrForgetLocally)。
 * 失敗のまま "/" へ移ると、入口がホームへ戻し、「ログアウトしたのに戻された」ように見えるため。
 *
 * 戻り値の error はサインアウトの失敗 (端末のセッションと画面の状態は消してある)。例外は投げない。
 */
export async function signOutOnDevice(
  userId: string | null | undefined,
  options: ForgetSessionOptions & SignOutOptions,
): Promise<{ error: unknown | null }> {
  try {
    await unregisterExpoPushToken(userId, { accessToken: options.accessToken });
  } catch {
    // push token の削除に失敗しても、ログアウトは続ける
  }
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
  await clearUserScopedLocalData(userId);
  return signOutOrForgetLocally(options);
}

/**
 * 保管庫 (secureSessionStorage) のセッションを、サーバーに問い合わせずに消す。
 * supabase.auth.signOut() は scope: "local" でもサーバーへのログアウトを呼び、それが失敗すると消さないため、保管庫を直接消す。
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
