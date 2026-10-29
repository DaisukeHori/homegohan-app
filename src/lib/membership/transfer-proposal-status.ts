// src/lib/membership/transfer-proposal-status.ts
// 譲渡の提案 (組織のオーナー・家族の代表者) の承諾の画面で、承諾・拒否ができない提案に出す文 (#2073 S5)。
//
// 以前、家族の承諾の画面は処理済みの提案に「既に処理されています (ステータス: accepted)」と内部の英字の値をそのまま出していた。
// 組織の承諾の画面は日本語の文を出していたので、同じ対応表を 2 つの画面で使う。
// ownership_transfer_proposals.status は pending / accepted / rejected / expired の 4 つ (CHECK ownership_transfer_proposals_status_check)。
// expired は、期限が過ぎたときのほか、同じ組織・家族へ新しい提案が送られて古い提案が置き換わったときにも入る
// (propose_* の RPC。期限の日時はまだ先のことがある)。
//
// このファイルはブラウザからも読むので、サーバー専用のものを import しない。

/** 承諾・拒否ができない提案に出す文 (状態ごと) */
export const TRANSFER_PROPOSAL_STATUS_MESSAGES = {
  accepted: 'この提案はすでに承諾済みです',
  rejected: 'この提案は拒否済みです',
  expired: 'この提案は期限切れです',
} as const;

/** 上の対応表に無い状態 (pending 以外) の文。内部の値は画面に出さない */
export const TRANSFER_PROPOSAL_PROCESSED_MESSAGE = 'この提案はすでに処理されています';

/**
 * 承諾・拒否ができない提案なら、その理由の文を返す。承諾・拒否ができる (pending で期限内) なら null。
 * isExpired は、期限の日時 (expires_at) が過ぎているか
 */
export function transferProposalStatusMessage(status: string, isExpired: boolean): string | null {
  if (status === 'accepted') return TRANSFER_PROPOSAL_STATUS_MESSAGES.accepted;
  if (status === 'rejected') return TRANSFER_PROPOSAL_STATUS_MESSAGES.rejected;
  if (status === 'expired' || isExpired) return TRANSFER_PROPOSAL_STATUS_MESSAGES.expired;
  if (status !== 'pending') return TRANSFER_PROPOSAL_PROCESSED_MESSAGE;
  return null;
}
