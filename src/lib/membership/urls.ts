import { getSiteUrl } from '@/lib/site-config';

/**
 * 招待・譲渡の承諾・メンバー管理画面のリンクの基点 (メールの本文と、招待 API のレスポンスの invite_url に載る)。
 *
 * 基点はサイトの URL (NEXT_PUBLIC_APP_URL。未設定なら既定値。src/lib/site-config.ts) に従う (#1194)。
 * NEXT_PUBLIC_INVITE_BASE_URL は以前の専用の設定で、いまは「招待系のリンクだけ別のホストにしたいとき」の
 * 上書き用として残している。設定してあると、そちらが優先される。ふだんは設定しない
 * (サイトの URL を変えたのに招待のリンクだけ古いホストのまま残る、という食い違いの元になる)。
 */
export function getInviteBaseUrl(): string {
  const override = process.env.NEXT_PUBLIC_INVITE_BASE_URL?.trim();
  return override ? override.replace(/\/+$/, '') : getSiteUrl();
}

export function buildOrgInviteUrl(token: string): string {
  return `${getInviteBaseUrl()}/invite/${token}`;
}

export function buildFamilyInviteUrl(token: string): string {
  return `${getInviteBaseUrl()}/invite/${token}`;
}

export function buildOrgTransferAcceptUrl(proposalId: string): string {
  return `${getInviteBaseUrl()}/org/transfer-accept/${proposalId}`;
}

export function buildFamilyTransferAcceptUrl(proposalId: string): string {
  return `${getInviteBaseUrl()}/family/transfer-accept/${proposalId}`;
}

/** 家族の子供メンバーへの「参加確認のお願い」(本人同意) ページ (#1232) */
export function buildFamilyPromotionUrl(token: string): string {
  return `${getInviteBaseUrl()}/family/promotions/${token}`;
}

/** 家族グループのメンバー管理画面 (脱退の通知メールに載せる) */
export function buildFamilyMembersUrl(): string {
  return `${getInviteBaseUrl()}/family/members`;
}

/** 組織のメンバー管理画面 (脱退の通知メールに載せる) */
export function buildOrgMembersUrl(): string {
  return `${getInviteBaseUrl()}/org/members`;
}
