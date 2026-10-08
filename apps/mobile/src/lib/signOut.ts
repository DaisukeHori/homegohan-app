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
 */

import { unregisterExpoPushToken } from "./pushNotifications";
import { supabase } from "./supabase";
import { clearUserScopedAsyncStorage } from "./user-storage";

export async function signOutWithCleanup(userId: string | null | undefined): Promise<{ error: unknown | null }> {
  await unregisterExpoPushToken(userId);

  try {
    await clearUserScopedAsyncStorage(userId ?? null);
  } catch {
    // ローカルデータの掃除に失敗しても、サインアウトは続ける
  }

  const result = await supabase.auth.signOut();
  return { error: result?.error ?? null };
}
