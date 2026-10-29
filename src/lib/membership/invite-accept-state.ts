// src/lib/membership/invite-accept-state.ts
// 招待の承諾の通信が失敗したあとに、承諾できていたかを自分のプロフィールで確かめる (#2080 U1)。
//
// 応答が届かないので、承諾できたかどうかは応答からは分からない。サーバーが承諾を済ませてから応答が切れたこともあり、
// 確かめずに通信エラーの文を出すと、家族 / 組織に入っているのに画面は招待の承諾のまま残り、もう一度押すと
// 承諾の RPC が招待の status = 'accepted' を先に見て INVITE_ALREADY_USED で断り、「この招待は既に使用済みです。」と出ていた。
// 承諾の RPC (accept_family_invite / accept_org_invite) は、同じトランザクションで本人の
// user_profiles.family_id / organization_id を招待の家族 / 組織にする。その列が招待の家族 / 組織なら承諾できている。
// (家族の作成の通信が切れたときに読み直す family/setup (#2073 S2) と同じ型。入っているかだけでなく、招待の先かも見る:
//  別の家族 / 組織に入っているだけなら承諾できていない)
//
// このファイルはブラウザからも読むので、サーバー専用のもの (service_role のクライアント・next/headers) を import しない。
import type { createClient } from '@/lib/supabase/client';
import {
  MEMBERSHIP_STATE_UNCONFIRMED_NOTE,
  readOwnMembershipIdAfterNetworkFailure,
  type MembershipLeaveScope,
} from '@/lib/membership/leave-state';

/** 画面で使う Supabase のクライアント (ブラウザの createClient の戻り値) */
type BrowserSupabaseClient = ReturnType<typeof createClient>;

/**
 * 招待の承諾の通信が失敗したあと (または INVITE_ALREADY_USED で断られたあと) に確かめた状態。
 *   - joined: 招待の家族 / 組織に入っている (承諾できている)。成功のときと同じ遷移にする
 *   - not-joined: 入っていない、または別の家族 / 組織に入っている。これまでどおり失敗の文を出す
 *   - unknown: 確かめる問い合わせも失敗した。失敗の文に MEMBERSHIP_STATE_UNCONFIRMED_NOTE を添える
 */
export type InviteAcceptStateAfterFailure = 'joined' | 'not-joined' | 'unknown';

/**
 * 自分のプロフィールを読み直して、招待の家族 / 組織 (inviteScopeId = get_invite_details の scope_id) に入っているかを返す。
 * 例外は投げない (問い合わせの失敗・例外・ログインが切れている は unknown)
 */
export async function readInviteAcceptStateAfterFailure(
  supabase: BrowserSupabaseClient,
  scope: MembershipLeaveScope,
  inviteScopeId: string,
): Promise<InviteAcceptStateAfterFailure> {
  const read = await readOwnMembershipIdAfterNetworkFailure(supabase, scope);
  if (!read.confirmed) return 'unknown';
  return read.membershipId !== null && read.membershipId === inviteScopeId ? 'joined' : 'not-joined';
}

/** 失敗の文に、状態を確かめられなかったときだけ MEMBERSHIP_STATE_UNCONFIRMED_NOTE を添える */
export function withInviteAcceptStateNote(message: string, state: InviteAcceptStateAfterFailure): string {
  return state === 'unknown' ? `${message} (${MEMBERSHIP_STATE_UNCONFIRMED_NOTE})` : message;
}
