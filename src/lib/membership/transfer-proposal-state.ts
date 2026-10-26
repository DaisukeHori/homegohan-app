// src/lib/membership/transfer-proposal-state.ts
// 組織のオーナー・家族の代表者の譲渡の提案の送信の通信そのものが失敗した (fetch が reject した) あとに、
// 提案を作れていたかを確かめる (#2073 S8)。
//
// 応答が届かないので、提案を作れたかどうかは応答からは分からない。サーバーが提案を作り、譲渡先へメールを送ってから
// 応答が切れたこともある。確かめずに失敗の文を出すと、もう一度送ったときに譲渡先へ提案のメールが 2 通届き、
// 1 通目のリンクは「期限切れ」になっていた (24 時間の提案の上限も 2 回分減る)。
//
// 提案の RPC (propose_org_owner_transfer / propose_family_representative_transfer) は、同じ組織・家族の pending の提案を
// expired にしてから、新しい提案を pending で作る (pending は組織・家族ごとに 1 行まで。部分 UNIQUE uniq_ownership_transfer_pending)。
// そこで、送る前に読んだ pending の提案と、通信が失敗したあとに読んだ pending の提案を比べる:
//   - 送る前と違う提案が、選んだ譲渡先へ pending であれば、作れている (sent)
//   - 送る前と同じ提案のまま (または pending が無い・別の人宛て) なら、作れていない (not-sent)
//   - どちらかの読み込みが失敗した・送る前が読めず、選んだ譲渡先への pending がある は、確かめられない (unknown)
// 送る前の読み込みが無いと、前に送った提案 (同じ譲渡先・まだ pending) を、今回作れた提案と見分けられない。
//
// このファイルはブラウザからも読むので、サーバー専用のもの (service_role のクライアント・next/headers) を import しない。
import type { createClient } from '@/lib/supabase/client';

/** 画面で使う Supabase のクライアント (ブラウザの createClient の戻り値) */
type BrowserSupabaseClient = ReturnType<typeof createClient>;

/** 譲渡の提案の範囲 (ownership_transfer_proposals.scope の値) */
export type TransferProposalScope = 'organization' | 'family';

/** pending の提案の読み込みの結果。ok: false は読み込めなかった (問い合わせの失敗・例外) */
export type PendingTransferProposalRead =
  | { ok: true; proposal: { id: string; to_user_id: string } | null }
  | { ok: false };

/**
 * 提案の送信の通信が失敗したあとに確かめた状態。
 *   - sent: 提案を作れている。成功のときと同じ表示にする (送り直しのボタンを出さない)
 *   - not-sent: 提案を作れていない。これまでどおり失敗の文を出す
 *   - unknown: 確かめられなかった。失敗の文に「状態を確かめられませんでした」を添える
 */
export type TransferProposalStateAfterNetworkFailure = 'sent' | 'not-sent' | 'unknown';

/**
 * その組織・家族の pending の譲渡の提案を読む (pending は 1 行まで)。
 * RLS (ownership_transfer_select) で、提案者 (from_user_id) は自分の提案を読める。
 * 例外は投げない (問い合わせの失敗・例外は ok: false)
 */
export async function readPendingTransferProposal(
  supabase: BrowserSupabaseClient,
  scope: TransferProposalScope,
  scopeId: string,
): Promise<PendingTransferProposalRead> {
  try {
    const { data, error } = await supabase
      .from('ownership_transfer_proposals')
      .select('id, to_user_id')
      .eq('scope', scope)
      .eq('scope_id', scopeId)
      .eq('status', 'pending')
      .maybeSingle();
    if (error) return { ok: false };
    return { ok: true, proposal: data ? { id: data.id, to_user_id: data.to_user_id } : null };
  } catch (readFailure) {
    console.error('[membership] failed to read pending transfer proposal:', readFailure);
    return { ok: false };
  }
}

/**
 * 送る前と、通信が失敗したあとの pending の提案を比べて、提案を作れていたかを返す (上の説明のとおり)
 */
export function transferProposalStateAfterNetworkFailure(
  before: PendingTransferProposalRead,
  after: PendingTransferProposalRead,
  toUserId: string,
): TransferProposalStateAfterNetworkFailure {
  if (!after.ok) return 'unknown';
  const pending = after.proposal;
  if (!pending || pending.to_user_id !== toUserId) return 'not-sent';
  if (!before.ok) return 'unknown';
  return before.proposal?.id === pending.id ? 'not-sent' : 'sent';
}
