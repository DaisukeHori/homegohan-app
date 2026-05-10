const DEFAULT_BASE_URL = 'https://homegohan-app.vercel.app';

export function getInviteBaseUrl(): string {
  return process.env.NEXT_PUBLIC_INVITE_BASE_URL ?? DEFAULT_BASE_URL;
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
