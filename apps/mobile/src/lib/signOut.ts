/**
 * ログアウトの共通処理 (#1038 F7-10)。
 *
 * 順番が大事なので、各画面でバラバラに書かず、ここにまとめる。
 *   1. この端末の Expo Push Token を user_push_tokens から消す
 *      - RLS で本人の行しか消せない。サインアウトするとできなくなるので、必ず「前」に行う
 *      - 消さないと、共有端末で次にログインした別のユーザーの端末にも、前のユーザー宛ての通知が届き得る
 *        (UNIQUE(user_id, expo_push_token) なので、同じ端末のトークンが複数ユーザーの行に併存できてしまう)
 *   2. ユーザーごとのローカルデータ (AsyncStorage) を消す (CLAUDE.md: サインアウトの前に行う)
 *   3. サインアウト (保管庫のセッションを消す)
 *
 * アカウント削除では使わない。auth.users の削除で user_push_tokens が ON DELETE CASCADE で消える。
 *
 * push token の削除に失敗してもログアウトは止めない (unregisterExpoPushToken は例外を投げない)。
 *
 * 設定画面・マイページのように、セッションが生きているまま呼ぶ場合は userId だけでよい (削除は現在のセッションで認可される)。
 * Web (WebView) からの sign-out / session-expired を処理する場合 (webViewAuthMessages.ts) は、Web 側のログアウトが
 * 全端末のセッションをサーバーで失効させ、処理の途中で getUser() が端末のセッションを消すことがある。
 * 呼び出し側が処理の最初に控えた userId と accessToken を渡す。accessToken があれば、削除はそのトークンで認可される。
 */

import { unregisterExpoPushToken } from "./pushNotifications";
import { supabase } from "./supabase";
import { clearUserScopedAsyncStorage } from "./user-storage";

export type SignOutOptions = {
  /** push token の削除を認可する、本人のアクセストークン。セッションが先に失効する場合に、呼び出し側が控えた値を渡す */
  accessToken?: string | null;
};

export async function signOutWithCleanup(
  userId: string | null | undefined,
  options: SignOutOptions = {},
): Promise<{ error: unknown | null }> {
  await unregisterExpoPushToken(userId, { accessToken: options.accessToken });

  try {
    await clearUserScopedAsyncStorage(userId ?? null);
  } catch {
    // ローカルデータの掃除に失敗しても、サインアウトは続ける
  }

  const result = await supabase.auth.signOut();
  return { error: result?.error ?? null };
}
