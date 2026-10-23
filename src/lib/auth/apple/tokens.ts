/**
 * 表 apple_sign_in_tokens の読み書き (docs/design/mobile/08-sign-in-with-apple.md §8・§11.3)。service_role の client だけが呼ぶ。
 * 失敗は例外のまま投げる (呼ぶ側が段階に応じて受け止める)。refresh_token は戻り値の中だけで扱い、ログに渡さない。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** 表の読み書きに使う client の形 (テストは偽物を渡す) */
export type AppleTokenStore = Pick<SupabaseClient, 'from'>;

export interface AppleRefreshTokenRow {
  readonly client_id: string;
  readonly refresh_token: string;
}

export async function storeAppleRefreshToken(
  admin: AppleTokenStore,
  input: { userId: string; clientId: string; refreshToken: string; now?: () => Date },
): Promise<void> {
  const { error } = await admin.from('apple_sign_in_tokens').upsert(
    {
      user_id: input.userId,
      client_id: input.clientId,
      refresh_token: input.refreshToken,
      updated_at: (input.now?.() ?? new Date()).toISOString(),
    },
    { onConflict: 'user_id,client_id' },
  );
  if (error) throw error;
}

export async function listAppleRefreshTokens(admin: AppleTokenStore, userId: string): Promise<AppleRefreshTokenRow[]> {
  const { data, error } = await admin
    .from('apple_sign_in_tokens')
    .select('client_id, refresh_token')
    .eq('user_id', userId);
  if (error) throw error;
  return data ?? [];
}
