// src/lib/membership/leave-state.ts
// 脱退の通信そのものが失敗した (fetch が reject した) あとに、脱退できていたかを自分のプロフィールで確かめる (#2064)。
//
// 応答が届かないので、脱退できたかどうかは応答からは分からない。サーバーが脱退を済ませてから応答が切れたこともあり、
// 確かめずに失敗の文を出すと、画面は家族 / 組織に入ったまま残り、もう一度押すと「脱退失敗」が出ていた
// (組織のメンバーの除名を読み直すようにした #2064 R5 と同じ型)。
// 脱退の RPC (leave_family / leave_org) は、同じトランザクションで本人の user_profiles.family_id / organization_id を NULL にする。
// その列が空なら脱退できている。
//
// このファイルはブラウザからも読むので、サーバー専用のもの (service_role のクライアント・next/headers) を import しない。
import type { createClient } from '@/lib/supabase/client';

/** 画面で使う Supabase のクライアント (ブラウザの createClient の戻り値) */
type BrowserSupabaseClient = ReturnType<typeof createClient>;

/** 脱退する所属 */
export type MembershipLeaveScope = 'family' | 'org';

/**
 * 脱退の通信が失敗したあとに確かめた状態。
 *   - left: 所属の列が空 (脱退できている)。成功のときと同じ遷移にする
 *   - still-member: 所属の列が残っている (脱退できていない)。これまでどおり失敗の文を出す
 *   - unknown: 確かめる問い合わせも失敗した。失敗の文に MEMBERSHIP_STATE_UNCONFIRMED_NOTE を添える
 */
export type MembershipStateAfterNetworkFailure = 'left' | 'still-member' | 'unknown';

/** 書き込みのあとの状態を確かめられなかったときに、失敗の文に添える文 */
export const MEMBERSHIP_STATE_UNCONFIRMED_NOTE = '状態を確かめられませんでした。画面を開き直して確かめてください';

/** 所属ごとの、本人の user_profiles の列 */
const MEMBERSHIP_COLUMN_OF_SCOPE = {
  family: 'family_id',
  org: 'organization_id',
} as const satisfies Record<MembershipLeaveScope, string>;

/**
 * 脱退の通信が失敗したあとに、自分のプロフィールを読み直して、脱退できていたかを返す。
 * 例外は投げない (問い合わせの失敗・例外・ログインが切れている は unknown)
 */
export async function readOwnMembershipAfterNetworkFailure(
  supabase: BrowserSupabaseClient,
  scope: MembershipLeaveScope,
): Promise<MembershipStateAfterNetworkFailure> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return 'unknown';

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('family_id, organization_id')
      .eq('id', user.id)
      .single();
    // 自分のプロフィールの行は必ずあるので、行が無い (PGRST116) も確かめられなかった扱いにする
    if (profileError || !profile) return 'unknown';

    const membershipId: unknown = profile[MEMBERSHIP_COLUMN_OF_SCOPE[scope]];
    return membershipId ? 'still-member' : 'left';
  } catch (readFailure) {
    console.error('[membership] failed to confirm membership after network failure:', readFailure);
    return 'unknown';
  }
}

/** 失敗の文に、状態を確かめられなかったときだけ MEMBERSHIP_STATE_UNCONFIRMED_NOTE を添える */
export function withMembershipStateNote(message: string, state: MembershipStateAfterNetworkFailure): string {
  return state === 'unknown' ? `${message} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})` : message;
}
