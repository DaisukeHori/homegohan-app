import "react-native-url-polyfill/auto";

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { MobileConfigError, resolveSupabaseEnv } from "./env";

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

function createSupabaseClient(): SupabaseClient {
  const env = resolveSupabaseEnv();

  if (!env.ok) {
    const error = new MobileConfigError(env.missing);
    // 開発中 (npx expo start・development ビルド) は、起動時に止めて、すぐ気づけるようにする
    if (__DEV__) throw error;
    // リリースビルド (preview・production) はクラッシュさせない。足りない変数名を端末のログに残し、
    // app/_layout.tsx が「アプリの設定が不足しています」の画面を出す。このクライアントは何もできない
    console.error(
      `${error.message} - このビルドには Supabase の接続先が入っていません。EAS の環境変数に登録して、ビルドし直してください`,
    );
    return createUnconfiguredClient(error);
  }

  return createClient(env.url, env.anonKey, {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
}

export const supabase = createSupabaseClient();
