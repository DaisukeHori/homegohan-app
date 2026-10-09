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

/**
 * ユーザー ID を含まないフラットなキー (将来追加時はここに列挙)。
 */
const STATIC_USER_SCOPED_KEYS: readonly string[] = [];

/**
 * ユーザー ID をサフィックスに持つキーのプレフィックス一覧。
 * 実際のキーは `${prefix}:${userId}` の形式で保存される。
 */
const USER_ID_KEY_PREFIXES: readonly string[] = [
  // push token を DB に登録済みとする印。値は pushNotifications.ts の PUSH_TOKEN_REGISTERED_KEY_PREFIX と同じ
  // (循環 import を避けて文字列で持つ。テストで一致を確認)
  "push_token_registered_v2",
  // 旧ビルドが付けた印。今は読まないが、旧ビルドから更新した端末に残っているので、ログアウトでは消す
  "push_token_registered_v1",
  // この端末の Expo Push Token の値 (ログアウト時に user_push_tokens の該当行だけを消すために控える)。
  // 値は pushNotifications.ts の PUSH_TOKEN_VALUE_KEY_PREFIX と同じ (同上)
  "push_token_value_v1",
];

/**
 * ログアウト・アカウント削除時にユーザースコープの AsyncStorage キーを削除する。
 *
 * @param userId - 現在サインインしているユーザーの UUID。
 *                 `null` を渡した場合は静的キーのみ削除し、プレフィックス付きキーは
 *                 getAllKeys() でスキャンして一致するものを削除する (フォールバック)。
 */
export async function clearUserScopedAsyncStorage(userId: string | null): Promise<void> {
  const keysToRemove: string[] = [...STATIC_USER_SCOPED_KEYS];

  if (userId) {
    for (const prefix of USER_ID_KEY_PREFIXES) {
      keysToRemove.push(`${prefix}:${userId}`);
    }
  } else {
    // userId が不明な場合は全キーをスキャンしてプレフィックス一致で削除
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      for (const key of allKeys) {
        if (USER_ID_KEY_PREFIXES.some((prefix) => key.startsWith(`${prefix}:`))) {
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
