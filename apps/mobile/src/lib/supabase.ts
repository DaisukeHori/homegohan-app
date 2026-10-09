import "react-native-url-polyfill/auto";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

import { MobileConfigError, resolveSupabaseEnv } from "./env";
import { secureSessionStorage } from "./secureSessionStorage";

/**
 * 必須の環境変数 (EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY) が無いビルドで使う、何もできないクライアント。
 *
 * 以前は、存在しないダミーの接続先とダミーのキーでクライアントを作っていたため、環境変数を入れ忘れた
 * ビルドでも起動してしまい、ログインなどが接続エラーで失敗し続けた (原因が分からない)。
 * いまは存在しない接続先でクライアントを作らず、何かを呼んだ瞬間に、足りない変数名を書いた MobileConfigError を投げる。
 * (Promise の解決が確かめに来る `then` や、シンボルの参照では投げない。無害な参照まで例外にすると、
 * クライアントを await したり、デバッガで見たりするだけで落ちるため)
 */
function createUnconfiguredClient(error: MobileConfigError): SupabaseClient {
  return new Proxy({} as SupabaseClient, {
    get(_target, property) {
      if (typeof property === "symbol" || property === "then") return undefined;
      throw error;
    },
  });
}

const supabaseEnv = resolveSupabaseEnv();

/**
 * セッションの保存キー。supabase-js が既定で使うキー (sb-<プロジェクト ref>-auth-token) と同じ値を明示する。
 * AuthProvider が「更新に失敗した保存済みのセッション」を直接読むために使う (#1038 F7-07)。
 * 既定と同じなので、これまでに保存されたセッションはそのまま読める。
 *
 * 接続先が無いビルド (EXPO_PUBLIC_SUPABASE_* が入っていない) では、接続先からキーを作れない。
 * 存在しないダミーの接続先の名前から作らず、どのプロジェクトも指さない固定の値にする。
 * このビルドのクライアントは何も保存しないので、このキーで読み書きすることはない (getStoredSession() は null を返す)。
 */
export const SUPABASE_AUTH_STORAGE_KEY = supabaseEnv.ok
  ? `sb-${new URL(supabaseEnv.url).hostname.split(".")[0]}-auth-token`
  : "sb-unconfigured-auth-token";

function createSupabaseClient(): SupabaseClient {
  if (!supabaseEnv.ok) {
    const error = new MobileConfigError(supabaseEnv.missing);
    // 開発中 (npx expo start・development ビルド) は、起動時に止めて、すぐ気づけるようにする
    if (__DEV__) throw error;
    // リリースビルド (preview・production) はクラッシュさせない。足りない変数名を端末のログに残し、
    // app/_layout.tsx が「アプリの設定が不足しています」の画面を出す。このクライアントは何もできない
    console.error(
      `${error.message} - このビルドには Supabase の接続先が入っていません。EAS の環境変数に登録して、ビルドし直してください`,
    );
    return createUnconfiguredClient(error);
  }

  return createClient(supabaseEnv.url, supabaseEnv.anonKey, {
    auth: {
      // セッション (refresh_token を含む) は平文の AsyncStorage ではなく、端末の安全な保管庫に置く (#1038 F7-06)
      storage: secureSessionStorage,
      storageKey: SUPABASE_AUTH_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}

export const supabase = createSupabaseClient();

/**
 * 保存済みのセッションを、検証や更新をせずにそのまま読む。
 * getSession() は access_token が期限切れだと更新を試み、通信に失敗すると session: null を返す。
 * オフライン起動でログイン状態を保つために、その場合だけ AuthProvider がこれを使う。
 */
export async function getStoredSession(): Promise<Session | null> {
  // 接続先が無いビルドは、セッションを持たない (保管庫を読みに行かない)
  if (!supabaseEnv.ok) return null;
  try {
    const raw = await secureSessionStorage.getItem(SUPABASE_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session> | null;
    if (
      parsed &&
      typeof parsed.access_token === 'string' &&
      typeof parsed.refresh_token === 'string' &&
      parsed.user &&
      typeof parsed.user.id === 'string'
    ) {
      return parsed as Session;
    }
  } catch {
    // 壊れた値は無いものとして扱う
  }
  return null;
}
