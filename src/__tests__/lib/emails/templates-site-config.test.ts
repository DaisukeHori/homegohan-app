import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema, type EmailEnvelope } from '@/lib/emails/envelope';
import { renderAccountDeletedEmail } from '@/lib/emails/account/account-deleted';
import type { InviteEmailVars } from '@/lib/emails/membership/templates';
import { renderFamilyInviteEmail } from '@/lib/emails/membership/family-invite';
import { renderFamilyInviteExistingEmail } from '@/lib/emails/membership/family-invite-existing';
import { renderFamilyInviteNewEmail } from '@/lib/emails/membership/family-invite-new';
import { renderFamilyPromoteEmail } from '@/lib/emails/membership/family-promote';
import { renderFamilyTransferCompletedEmail } from '@/lib/emails/membership/family-transfer-completed';
import { renderFamilyTransferProposedEmail } from '@/lib/emails/membership/family-transfer-proposed';
import { renderMemberLeftEmail } from '@/lib/emails/membership/member-left';
import { renderMemberRemovedEmail } from '@/lib/emails/membership/member-removed';
import { renderForceDissolveEmail } from '@/lib/emails/membership/operator-force-dissolve';
import { renderForceTransferEmail } from '@/lib/emails/membership/operator-force-transfer';
import { renderOrgInviteExistingEmail } from '@/lib/emails/membership/org-invite-existing';
import { renderOrgInviteNewEmail } from '@/lib/emails/membership/org-invite-new';
import { renderOrgTransferCompletedEmail } from '@/lib/emails/membership/org-transfer-completed';
import { renderOrgTransferProposedEmail } from '@/lib/emails/membership/org-transfer-proposed';
import { renderTicketReplyEmail } from '@/lib/emails/support/ticket-reply';
import { DEFAULT_EMAIL_FROM, DEFAULT_SITE_URL, DEFAULT_SUPPORT_EMAIL } from '@/lib/site-config';

// #1194 メールの文面 (membership/*, support/*) は、送信元・問い合わせ先・サイトの URL を直接書かず、
// src/lib/site-config.ts の設定 (EMAIL_FROM / NEXT_PUBLIC_SUPPORT_EMAIL / NEXT_PUBLIC_APP_URL) に従う。
// homegohan.com への切り替えを環境変数だけで行えることを、全テンプレートで確かめる。

const inviteVars: InviteEmailVars = {
  display_name: '山田太郎',
  email_address: 'taro@example.com',
  inviter_name: '山田花子',
  scope_name: '山田家',
  invite_url: 'https://app.example.test/invite/abc123',
  expires_at: '2026-05-24',
  custom_message: null,
};

const forceTransferBase = {
  recipient_email: 'owner@example.com',
  recipient_name: null,
  scope: 'family' as const,
  scope_name: '山田家',
  old_owner_email: 'old@example.com',
  new_owner_email: 'new@example.com',
  reason: '本人の依頼',
};

interface TemplateCase {
  /** src/lib/emails からの相対パス (拡張子なし) */
  file: string;
  name: string;
  render: () => EmailEnvelope;
  /** 本文に問い合わせ先 (support@…) を書くテンプレートか */
  mentionsSupport: boolean;
}

const TEMPLATES: TemplateCase[] = [
  {
    file: 'account/account-deleted',
    name: 'account-deleted',
    render: () => renderAccountDeletedEmail({ to_email: 'taro@example.com', deleted_at: new Date('2026-10-09T15:05:00.000Z') }),
    mentionsSupport: true,
  },
  { file: 'membership/family-invite', name: 'family-invite', render: () => renderFamilyInviteEmail(inviteVars), mentionsSupport: true },
  { file: 'membership/family-invite-existing', name: 'family-invite-existing', render: () => renderFamilyInviteExistingEmail(inviteVars), mentionsSupport: true },
  { file: 'membership/family-invite-new', name: 'family-invite-new', render: () => renderFamilyInviteNewEmail(inviteVars), mentionsSupport: true },
  {
    file: 'membership/family-promote',
    name: 'family-promote',
    render: () =>
      renderFamilyPromoteEmail({
        email_address: 'taro@example.com',
        family_name: '山田家',
        member_display_name: 'たろう',
        requester_name: '山田花子',
        accept_url: 'https://app.example.test/family/promotions/abc',
        expires_at: '2026-10-21T02:00:00.000Z',
      }),
    mentionsSupport: true,
  },
  {
    file: 'membership/family-transfer-completed',
    name: 'family-transfer-completed',
    render: () =>
      renderFamilyTransferCompletedEmail({
        to_email: 'hanako@example.com',
        new_representative_name: '山田花子',
        family_name: '山田家',
        is_old_representative: false,
      }),
    mentionsSupport: true,
  },
  {
    file: 'membership/family-transfer-proposed',
    name: 'family-transfer-proposed',
    render: () =>
      renderFamilyTransferProposedEmail({
        to_email: 'hanako@example.com',
        from_name: '山田太郎',
        family_name: '山田家',
        accept_url: 'https://app.example.test/family/transfer-accept/abc',
      }),
    mentionsSupport: true,
  },
  {
    file: 'membership/member-left',
    name: 'member-left',
    render: () =>
      renderMemberLeftEmail({
        to_email: 'hanako@example.com',
        scope: 'family',
        scope_name: '山田家',
        members_url: 'https://app.example.test/family/members',
      }),
    mentionsSupport: true,
  },
  {
    file: 'membership/member-removed',
    name: 'member-removed',
    render: () => renderMemberRemovedEmail({ to_email: 'taro@example.com', scope: 'family', scope_name: '山田家' }),
    mentionsSupport: true,
  },
  {
    file: 'membership/operator-force-dissolve',
    name: 'operator-force-dissolve',
    render: () =>
      renderForceDissolveEmail({
        recipient_email: 'owner@example.com',
        scope: 'organization',
        scope_name: '株式会社ほめゴハン',
        reason: '規約違反',
      }),
    mentionsSupport: true,
  },
  {
    file: 'membership/operator-force-transfer',
    name: 'operator-force-transfer (旧オーナー宛)',
    render: () => renderForceTransferEmail({ ...forceTransferBase, recipient_role: 'old_owner' }),
    mentionsSupport: true,
  },
  {
    file: 'membership/operator-force-transfer',
    name: 'operator-force-transfer (新オーナー宛)',
    render: () => renderForceTransferEmail({ ...forceTransferBase, recipient_role: 'new_owner' }),
    mentionsSupport: true,
  },
  {
    file: 'membership/operator-force-transfer',
    name: 'operator-force-transfer (メンバー宛)',
    render: () => renderForceTransferEmail({ ...forceTransferBase, recipient_role: 'member' }),
    mentionsSupport: true,
  },
  { file: 'membership/org-invite-existing', name: 'org-invite-existing', render: () => renderOrgInviteExistingEmail(inviteVars), mentionsSupport: true },
  { file: 'membership/org-invite-new', name: 'org-invite-new', render: () => renderOrgInviteNewEmail(inviteVars), mentionsSupport: true },
  {
    file: 'membership/org-transfer-completed',
    name: 'org-transfer-completed',
    render: () =>
      renderOrgTransferCompletedEmail({
        to_email: 'owner@example.com',
        to_name: null,
        old_owner_name: '山田太郎',
        new_owner_name: '山田花子',
        org_name: '株式会社ほめゴハン',
        recipient: 'new_owner',
      }),
    mentionsSupport: false,
  },
  {
    file: 'membership/org-transfer-proposed',
    name: 'org-transfer-proposed',
    render: () =>
      renderOrgTransferProposedEmail({
        to_email: 'hanako@example.com',
        to_name: null,
        from_name: '山田太郎',
        org_name: '株式会社ほめゴハン',
        accept_url: 'https://app.example.test/org/transfer-accept/abc',
        expires_at: '2026-10-21',
        reason: null,
      }),
    mentionsSupport: true,
  },
  {
    file: 'support/ticket-reply',
    name: 'ticket-reply',
    render: () =>
      renderTicketReplyEmail({
        to_email: 'taro@example.com',
        ticket_id: 'a1b2c3d4-0000-4000-8000-000000000001',
        ticket_subject: 'ログインできません',
        reply_body: 'パスワードの再設定をお試しください。',
        contact_url: 'https://app.example.test/contact',
      }),
    mentionsSupport: false,
  },
];

const EMAILS_DIR = path.resolve(__dirname, '../../../lib/emails');
const read = (file: string) => fs.readFileSync(path.join(EMAILS_DIR, `${file}.ts`), 'utf8');

const OVERRIDES = {
  EMAIL_FROM: 'ほめゴハン <noreply@mail.example.test>',
  NEXT_PUBLIC_SUPPORT_EMAIL: 'help@example.test',
  NEXT_PUBLIC_APP_URL: 'https://site.example.test',
} as const;

beforeEach(() => {
  vi.stubEnv('EMAIL_FROM', '');
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', '');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('メールの文面: 環境変数が未設定なら、従来と同じ送信元・問い合わせ先・サイトの URL', () => {
  it.each(TEMPLATES.map((t) => [t.name, t] as const))('%s', (_name, template) => {
    const envelope = template.render();

    expect(envelope.from).toBe(DEFAULT_EMAIL_FROM);
    expect(envelope.text.trimEnd().endsWith(`─────────────────\nほめゴハン\n${DEFAULT_SITE_URL}`)).toBe(true);
    if (template.mentionsSupport) expect(envelope.text).toContain(DEFAULT_SUPPORT_EMAIL);
    // 送信前の検証 (件名 100 字以内・宛先の形式など) を通る
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe('メールの文面: 環境変数を設定すると、全テンプレートが送信元・問い合わせ先・サイトの URL を切り替える', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(OVERRIDES)) vi.stubEnv(name, value);
  });

  it.each(TEMPLATES.map((t) => [t.name, t] as const))('%s', (_name, template) => {
    const envelope = template.render();

    expect(envelope.from).toBe(OVERRIDES.EMAIL_FROM);
    // 署名のサイトの URL
    expect(envelope.text.trimEnd().endsWith(`─────────────────\nほめゴハン\n${OVERRIDES.NEXT_PUBLIC_APP_URL}`)).toBe(true);
    // 問い合わせ先
    if (template.mentionsSupport) expect(envelope.text).toContain(OVERRIDES.NEXT_PUBLIC_SUPPORT_EMAIL);
    // 古い既定値が残っていない
    expect(envelope.text).not.toContain(DEFAULT_SUPPORT_EMAIL);
    expect(envelope.text).not.toContain(DEFAULT_SITE_URL);
    expect(envelope.from).not.toContain(DEFAULT_EMAIL_FROM);
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe('メールの文面: ソースにドメイン・送信元・問い合わせ先を直接書かない', () => {
  it('テンプレート一覧が、実際にあるテンプレートのファイルと一致している (足したのに検査から漏れる、を防ぐ)', () => {
    const actual = [
      ...fs
        .readdirSync(path.join(EMAILS_DIR, 'account'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `account/${f.replace(/\.ts$/, '')}`),
      ...fs
        .readdirSync(path.join(EMAILS_DIR, 'membership'))
        .filter((f) => f.endsWith('.ts') && !['templates.ts', 'scope-label.ts'].includes(f))
        .map((f) => `membership/${f.replace(/\.ts$/, '')}`),
      ...fs
        .readdirSync(path.join(EMAILS_DIR, 'support'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `support/${f.replace(/\.ts$/, '')}`),
    ].sort();
    const covered = [...new Set(TEMPLATES.map((t) => t.file))].sort();

    expect(covered).toEqual(actual);
  });

  it.each([...new Set(TEMPLATES.map((t) => t.file))])('%s: noreply@ / support@ / http(s):// のドメインを直接書かない', (file) => {
    const source = read(file);

    // コメントは除いて調べる (設計書の URL などをコメントに書くのは構わない)
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/noreply@/);
    expect(code).not.toMatch(/support@/);
    expect(code).not.toMatch(/https?:\/\/(?!\$\{)/);
    expect(code).toContain('getEmailFrom()');
    expect(code).toContain('emailSignature()');
  });
});
