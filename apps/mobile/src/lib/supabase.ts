import "react-native-url-polyfill/auto";

import { createClient, type Session } from "@supabase/supabase-js";

import { secureSessionStorage } from "./secureSessionStorage";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '[mobile] Supabase env vars missing — auth will fail until configured. ' +
    'Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in EAS Secrets or .env file.'
  );
}

const effectiveSupabaseUrl = supabaseUrl || 'https://placeholder.supabase.co';

/**
 * セッションの保存キー。supabase-js が既定で使うキー (sb-<プロジェクト ref>-auth-token) と同じ値を明示する。
 * AuthProvider が「更新に失敗した保存済みのセッション」を直接読むために使う (#1038 F7-07)。
 * 既定と同じなので、これまでに保存されたセッションはそのまま読める。
 */
export const SUPABASE_AUTH_STORAGE_KEY = `sb-${new URL(effectiveSupabaseUrl).hostname.split('.')[0]}-auth-token`;

export const supabase = createClient(
  effectiveSupabaseUrl,
  supabaseAnonKey || 'placeholder',
  {
    auth: {
      // セッション (refresh_token を含む) は平文の AsyncStorage ではなく、端末の安全な保管庫に置く (#1038 F7-06)
      storage: secureSessionStorage,
      storageKey: SUPABASE_AUTH_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }
);

/**
 * 保存済みのセッションを、検証や更新をせずにそのまま読む。
 * getSession() は access_token が期限切れだと更新を試み、通信に失敗すると session: null を返す。
 * オフライン起動でログイン状態を保つために、その場合だけ AuthProvider がこれを使う。
 */
export async function getStoredSession(): Promise<Session | null> {
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
