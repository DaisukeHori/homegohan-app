/**
 * #1708 件名・本文に秘密 (トークンを含むリンク) を入れるメールの文面の見本。
 * 秘密を含む文面 (封筒の contains_secret が true) を 1 つずつ、本物の render*Email と本物のリンクの組み立てで作る。
 * 使う側:
 *   - src/__tests__/lib/emails/secret-templates.test.ts (宣言の走査・見本が秘密を本文に入れていること)
 *   - src/__tests__/lib/emails/send.test.ts (sendEmail が redact_after_send を立てること)
 *   - tests/integration/rls/email-outbox-secret-templates.test.ts (実 DB で、送れた・dead のあとに伏せられること)
 * 秘密を含む文面を足したら、ここにも 1 行足す (secret-templates.test.ts が、見本の無い秘密の文面を赤くする)。
 */
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { renderDsrVerificationEmail } from '@/lib/emails/dsr/verification';
import { renderFamilyInviteEmail } from '@/lib/emails/membership/family-invite';
import { renderFamilyInviteNewEmail } from '@/lib/emails/membership/family-invite-new';
import { renderFamilyInviteExistingEmail } from '@/lib/emails/membership/family-invite-existing';
import { renderOrgInviteNewEmail } from '@/lib/emails/membership/org-invite-new';
import { renderOrgInviteExistingEmail } from '@/lib/emails/membership/org-invite-existing';
import { renderFamilyPromoteEmail } from '@/lib/emails/membership/family-promote';
import type { InviteEmailVars } from '@/lib/emails/membership/templates';
import { buildFamilyInviteUrl, buildFamilyPromotionUrl, buildOrgInviteUrl } from '@/lib/membership/urls';
import { buildDsrVerifyUrl } from '@/lib/data-subject-requests/core';

/** 見本の本文に入れるトークン (本物の書式にしない。本文・件名・宛先に残っていないかをこの文字列で探す) */
export const SECRET_SAMPLE_TOKEN = 'tok1708SecretSampleNotARealToken0123456789';
/** 見本の DSR の請求の id と、本人確認のリンクの基点 */
const SAMPLE_DSR_REQUEST_ID = '00000000-0000-4000-8000-000000001708';
const SAMPLE_SITE_URL = 'https://homegohan.example';
/** 見本の期限 (InviteEmailVars は 'YYYY-MM-DD'、family_promote は ISO の時刻) */
const SAMPLE_EXPIRES_DAY = '2026-10-23';
const SAMPLE_EXPIRES_AT = '2026-10-23T00:00:00.000Z';

export interface SecretEmailSample {
  /** 文面の名前 (render*Email が封筒の template に入れる値) */
  readonly template: string;
  /** 宛先を受け取って、トークン入りの封筒を作る */
  readonly render: (to: string) => EmailEnvelope;
}

function inviteVars(to: string, inviteUrl: string): InviteEmailVars {
  return {
    display_name: null,
    email_address: to,
    inviter_name: '招待した人',
    scope_name: '見本のグループ',
    invite_url: inviteUrl,
    expires_at: SAMPLE_EXPIRES_DAY,
    custom_message: null,
  };
}

export const SECRET_EMAIL_SAMPLES: readonly SecretEmailSample[] = [
  {
    template: 'dsr_verification',
    render: (to) =>
      renderDsrVerificationEmail({
        to_email: to,
        request_type: 'disclosure',
        request_id: SAMPLE_DSR_REQUEST_ID,
        verify_url: buildDsrVerifyUrl(SAMPLE_SITE_URL, SAMPLE_DSR_REQUEST_ID, SECRET_SAMPLE_TOKEN),
      }),
  },
  { template: 'family_invite', render: (to) => renderFamilyInviteEmail(inviteVars(to, buildFamilyInviteUrl(SECRET_SAMPLE_TOKEN))) },
  { template: 'family_invite_new', render: (to) => renderFamilyInviteNewEmail(inviteVars(to, buildFamilyInviteUrl(SECRET_SAMPLE_TOKEN))) },
  {
    template: 'family_invite_existing',
    render: (to) => renderFamilyInviteExistingEmail(inviteVars(to, buildFamilyInviteUrl(SECRET_SAMPLE_TOKEN))),
  },
  { template: 'org_invite_new', render: (to) => renderOrgInviteNewEmail(inviteVars(to, buildOrgInviteUrl(SECRET_SAMPLE_TOKEN))) },
  { template: 'org_invite_existing', render: (to) => renderOrgInviteExistingEmail(inviteVars(to, buildOrgInviteUrl(SECRET_SAMPLE_TOKEN))) },
  {
    template: 'family_promote',
    render: (to) =>
      renderFamilyPromoteEmail({
        email_address: to,
        family_name: '見本の家族',
        member_display_name: '見本の子供',
        requester_name: '依頼した人',
        accept_url: buildFamilyPromotionUrl(SECRET_SAMPLE_TOKEN),
        expires_at: SAMPLE_EXPIRES_AT,
      }),
  },
];
