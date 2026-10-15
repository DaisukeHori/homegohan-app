/**
 * ユーザースコープ AsyncStorage ヘルパー。
 *
 * 認証セッションに紐づくキーはここで管理する。
 * サインアウト・アカウント削除時に clearUserScopedAsyncStorage() を呼んで
 * 別ユーザーへのデータ漏洩を防ぐ。
 *
 * Web 側の src/lib/user-storage.ts と対になる実装。
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

import { PERSISTENCE_KEYS } from "./persistence";

/**
 * ユーザー ID を含まないフラットなキー (将来追加時はここに列挙)。
 */
const STATIC_USER_SCOPED_KEYS: readonly string[] = [
  // 旧ビルドが V4 献立生成の受付時に書いた、生成中の状態 ({ requestId, timestamp, totalSlots })。
  // 読む処理が無かったので今は書かない (#1049 F7-20。src/hooks/useV4MenuGeneration.ts) が、
  // 旧ビルドから更新した端末に前のユーザーの値が残っているので、ログアウトでは消す
  "v4MenuGenerating",
  // アプリの永続化キー (persistence.ts の PERSISTENCE_KEYS。#1599)。どれも Web の利用者別の localStorage のキー
  // (packages/shared の USER_SCOPED_LOCAL_STORAGE_KEYS) と同じ中身で、ログイン中の利用者の値を持つ。
  //   - v4_range_days: V4 の献立生成の期間の設定 (src/components/menu/V4GenerateModal.tsx が書く)
  //   - singleMealGenerating: 1 食の作り直しの生成中の状態。前の利用者の食事の ID が入る (書いていた src/components/menu/RegenerateMealModal.tsx は
  //     #1598 で消した。旧ビルドが書いた値が残っているので消す)
  //   - weeklyMenuGenerating・shoppingListRegenerating: 生成中の状態 (いまのアプリは書かないが、同じ一覧のキーなので消す)
  ...Object.values(PERSISTENCE_KEYS).map(({ key }) => key),
];

/**
 * この端末の Expo Push Token の値を控えるキーの接頭辞 (ログアウト時に user_push_tokens の該当行だけを消すために控える)。
 * 値は pushNotifications.ts の PUSH_TOKEN_VALUE_KEY_PREFIX と同じ (循環 import を避けて文字列で持つ。テストで一致を確認)
 */
const PUSH_TOKEN_VALUE_KEY_PREFIX = "push_token_value_v1";

/**
 * ユーザー ID をサフィックスに持つキーのプレフィックス一覧。
 * 実際のキーは `${prefix}:${userId}` の形式で保存される。
 */
const USER_ID_KEY_PREFIXES: readonly string[] = [
  // 旧ビルドが付けた「push token を DB に登録済み」の印 (v2・v1)。今は読まず書かない
  // (#1599: 起動・ログインのたびに登録し直す。印で省くと、ほかの利用者の claim で行が消えたあとに再登録されなかった。
  //  v1 は #1038 より前のビルドが権限の拒否でも付けた印)。旧ビルドから更新した端末に残っているので、ログアウトでは消す
  "push_token_registered_v2",
  "push_token_registered_v1",
  PUSH_TOKEN_VALUE_KEY_PREFIX,
];

export type ClearUserScopedAsyncStorageOptions = {
  /**
   * この端末の push token の値 (push_token_value_v1:<利用者>) を消さずに残す (#1615)。
   * AuthProvider の SIGNED_OUT の掃除だけが使う。SIGNED_OUT は、ログアウト (signOut.ts) が値を読んで
   * user_push_tokens の行を消すより前に届くことがある (Web の session-expired で getUser() が端末のセッションを消したときなど)。
   * 先に消すと、ログアウトが値を読めず、行が消えずに残る (共有端末で前の利用者宛ての通知が届く。#1038 F7-10)。
   * 値はこの端末のトークンで、どの利用者でも同じ値になり、利用者の ID 付きのキーなので次の利用者は読まない。
   * ログアウトが行を消したあとの掃除 (signOut.ts) で消える。
   */
  keepPushTokenValue?: boolean;
};

/**
 * ログアウト・アカウント削除時にユーザースコープの AsyncStorage キーを削除する。
 *
 * @param userId - 現在サインインしているユーザーの UUID。
 *                 `null` を渡した場合は静的キーのみ削除し、プレフィックス付きキーは
 *                 getAllKeys() でスキャンして一致するものを削除する (フォールバック)。
 * @param options - keepPushTokenValue: push token の値を残す (上の型の説明)
 */
export async function clearUserScopedAsyncStorage(
  userId: string | null,
  options: ClearUserScopedAsyncStorageOptions = {},
): Promise<void> {
  const keysToRemove: string[] = [...STATIC_USER_SCOPED_KEYS];
  const prefixes = options.keepPushTokenValue
    ? USER_ID_KEY_PREFIXES.filter((prefix) => prefix !== PUSH_TOKEN_VALUE_KEY_PREFIX)
    : USER_ID_KEY_PREFIXES;

  if (userId) {
    for (const prefix of prefixes) {
      keysToRemove.push(`${prefix}:${userId}`);
    }
  } else {
    // userId が不明な場合は全キーをスキャンしてプレフィックス一致で削除
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      for (const key of allKeys) {
        if (prefixes.some((prefix) => key.startsWith(`${prefix}:`))) {
          keysToRemove.push(key);
        }
      }
    } catch {
      // スキャン失敗時は静的キーのみ削除して続行
    }
  }

  if (keysToRemove.length > 0) {
    await AsyncStorage.multiRemove(keysToRemove);
  }
}
