// src/lib/membership/share-settings-state.ts
// 家族への共有の設定の更新 (PATCH /api/family/members/me/share) の通信そのものが失敗した (fetch が reject した) あとに、
// サーバーの今の値を読み直す (#2073 S2)。
//
// 応答が届かないので、更新できたかどうかは応答からは分からない。サーバーが更新を済ませてから応答が切れたこともあり、
// 以前は確かめずに画面の値を元に戻していた。例えば健康の記録の共有はサーバーで有効なのに、画面は無効と見せていた
// (プライバシーの設定なので、利用者が誤った思い込みを持つ)。
// 更新の API は、本人の active な family_members の行 (1 人 1 行まで。部分 UNIQUE uniq_family_members_user) の share_* を書く。
// その行を読み直し、読めた値を画面に出す。
//
// このファイルはブラウザからも読むので、サーバー専用のもの (service_role のクライアント・next/headers) を import しない。
import type { createClient } from '@/lib/supabase/client';

/** 画面で使う Supabase のクライアント (ブラウザの createClient の戻り値) */
type BrowserSupabaseClient = ReturnType<typeof createClient>;

/** 家族への共有の設定 (family_members の share_* の列) */
export interface FamilyShareSettings {
  share_meals: boolean;
  share_health: boolean;
  share_menu: boolean;
}

/** 読み直しの結果。ok: false は確かめられなかった (問い合わせの失敗・例外・ログインが切れている・行が無い) */
export type FamilyShareSettingsRead = { ok: true; settings: FamilyShareSettings } | { ok: false };

/** 共有の設定を確かめられなかったときに、失敗の文に添える文 (脱退・除名の MEMBERSHIP_STATE_UNCONFIRMED_NOTE と同じ扱い) */
export const SHARE_SETTINGS_UNCONFIRMED_NOTE = '設定を確かめられませんでした。画面を開き直して確かめてください';

/**
 * 共有の設定の更新の通信が失敗したあとに、自分の active な family_members の行の share_* を読み直す。
 * 例外は投げない
 */
export async function readOwnShareSettingsAfterNetworkFailure(
  supabase: BrowserSupabaseClient,
): Promise<FamilyShareSettingsRead> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false };

    const { data: row, error } = await supabase
      .from('family_members')
      .select('share_meals, share_health, share_menu')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle();
    if (error || !row) return { ok: false };
    return {
      ok: true,
      settings: { share_meals: row.share_meals, share_health: row.share_health, share_menu: row.share_menu },
    };
  } catch (readFailure) {
    console.error('[membership] failed to confirm share settings after network failure:', readFailure);
    return { ok: false };
  }
}

/** 失敗の文に、確かめられなかった旨を添える */
export function withShareSettingsUnconfirmedNote(message: string): string {
  return `${message} (${SHARE_SETTINGS_UNCONFIRMED_NOTE})`;
}
