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
  "push_token_registered_v1",
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

/**
 * Supabase JS (auth-js) が AsyncStorage 上に保存するセッショントークンのキーを
 * 直接検出して削除するフェイルセーフ。
 *
 * Round-4 レビュー指摘 (#1037): `supabase.auth.signOut()` はサーバー側のトークン失効
 * API (`/auth/v1/logout`) を呼び出すが、ネットワークエラー等でこの呼び出しが失敗すると
 * auth-js の内部実装 (`GoTrueClient#_signOut`) は `_removeSession()`
 * (= AsyncStorage クリア + `SIGNED_OUT` イベント発火) をスキップしたまま
 * `{ error }` を返す。しかもこの失敗は例外を投げず戻り値の `error` に入るだけなので、
 * 呼び出し側が戻り値をチェックしないと気づけない。
 *
 * アカウント削除のように「サーバー側の状態は既に確定済みで、あとは端末側の
 * 後片付けだけ」という場面では、ネットワークの成否に関わらずローカルの
 * 認証トークンを確実に消し去る必要があるため、AsyncStorage を直接スキャンして
 * `sb-<project-ref>-auth-token` (および `-code-verifier` / `-user` サフィックス)
 * 形式のキーを削除する。
 */
export async function clearSupabaseAuthStorage(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const authKeys = allKeys.filter(
      (key) => key.startsWith("sb-") && key.includes("-auth-token"),
    );
    if (authKeys.length > 0) {
      await AsyncStorage.multiRemove(authKeys);
    }
  } catch {
    // スキャン/削除自体が失敗した場合は諦める。
    // 呼び出し側 (account.tsx) は AuthProvider の in-memory session も
    // 別途クリアするため、多少の取りこぼしがあってもホーム復帰は防げる。
  }
}
