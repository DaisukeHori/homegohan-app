# 04. Email Templates — Resend Invite Mails

ブランド名は **「ほめゴハン」** で統一。 from = `ほめゴハン <noreply@homegohan.app>`。

---

## 1. テンプレート定義 (Zod 型)

```ts
// src/lib/emails/membership/templates.ts
import { z } from 'zod';

export const InviteEmailVarsSchema = z.object({
  display_name: z.string().nullable(),       // 受領者の名前 (新規ユーザは null = email を使う)
  email_address: z.string().email(),         // 受領者の email
  inviter_name: z.string(),                  // 招待者の名前
  scope_name: z.string(),                    // organization/family の名前
  invite_url: z.string().url(),              // /invite/{token} の絶対 URL
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),  // 'YYYY-MM-DD'
  custom_message: z.string().nullable(),     // 招待者からのメッセージ (任意)
});
export type InviteEmailVars = z.infer<typeof InviteEmailVarsSchema>;

export const EmailEnvelopeSchema = z.object({
  to: z.string().email(),
  from: z.string().default('ほめゴハン <noreply@homegohan.app>'),
  subject: z.string().min(1).max(100),
  text: z.string().min(1),                   // プレーンテキスト本文
  html: z.string().optional(),               // 第 1 段階は省略 (text のみ)
  reply_to: z.string().email().optional(),
});
export type EmailEnvelope = z.infer<typeof EmailEnvelopeSchema>;
```

---

## 2. テンプレート A: 組織招待 (既存ユーザ向け)

```ts
// src/lib/emails/membership/org-invite-existing.ts
import type { InviteEmailVars, EmailEnvelope } from './templates';

export function renderOrgInviteExistingEmail(vars: InviteEmailVars): EmailEnvelope {
  const greeting = vars.display_name ?? vars.email_address;
  const customSection = vars.custom_message
    ? `\n${vars.inviter_name} 様からのメッセージ:\n「${vars.custom_message}」\n`
    : '';

  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `[ほめゴハン] ${vars.scope_name} からメンバー招待が届きました`,
    text: `${greeting} 様

${vars.scope_name} の ${vars.inviter_name} 様から、ほめゴハンの組織メンバーとして招待が届きました。
${customSection}
▼ 招待を承諾する
${vars.invite_url}

このリンクは ${vars.expires_at} まで有効です。
期限切れの場合は、招待者に再送を依頼してください。

心当たりのない場合はこのメールを無視してください。
不正利用のおそれがある場合は support@homegohan.app までご連絡ください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
```

---

## 3. テンプレート B: 組織招待 (新規ユーザ向け)

```ts
// src/lib/emails/membership/org-invite-new.ts
export function renderOrgInviteNewEmail(vars: InviteEmailVars): EmailEnvelope {
  const customSection = vars.custom_message
    ? `\n${vars.inviter_name} 様からのメッセージ:\n「${vars.custom_message}」\n`
    : '';

  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `[ほめゴハン] ${vars.scope_name} があなたを招待しています — アカウントを作成して参加`,
    text: `${vars.email_address} 様

${vars.scope_name} の ${vars.inviter_name} 様からほめゴハンへのご招待が届きました。

ほめゴハンは、栄養管理と健康記録をサポートするサービスです。
下記リンクからアカウントを作成して、組織メンバーとして参加できます。
${customSection}
▼ アカウントを作成して招待を承諾する
${vars.invite_url}

このリンクは ${vars.expires_at} まで有効です。

心当たりのない場合はこのメールを無視してください。
不正利用のおそれがある場合は support@homegohan.app までご連絡ください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
```

---

## 4. テンプレート C: 家族招待 (既存/新規共通)

```ts
// src/lib/emails/membership/family-invite.ts
export function renderFamilyInviteEmail(vars: InviteEmailVars): EmailEnvelope {
  const greeting = vars.display_name ?? vars.email_address;
  const customSection = vars.custom_message
    ? `\n${vars.inviter_name} 様からのメッセージ:\n「${vars.custom_message}」\n`
    : '';

  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `[ほめゴハン] ${vars.inviter_name} 様からご家族グループへの招待`,
    text: `${greeting} 様

${vars.inviter_name} 様からほめゴハンの家族グループ「${vars.scope_name}」にあなたを招待しています。

家族グループに参加すると、献立や買い物リスト、栄養記録を共有できます。
過去の個人記録はあなただけが閲覧でき、新しい記録から家族との共有を選べます。
${customSection}
▼ 招待を承諾する
${vars.invite_url}

このリンクは ${vars.expires_at} まで有効です。

心当たりのない場合はこのメールを無視してください。
不正利用のおそれがある場合は support@homegohan.app までご連絡ください。

─────────────────
ほめゴハン
https://homegohan.app
`,
  };
}
```

---

## 5. 譲渡通知メール

### 5.1 owner/representative 譲渡提案 (proposed)
```ts
// src/lib/emails/membership/transfer-proposed.ts
export const TransferProposedVarsSchema = z.object({
  display_name: z.string().nullable(),
  email_address: z.string().email(),
  proposer_name: z.string(),
  scope_label: z.enum(['組織', '家族']),
  scope_name: z.string(),
  new_role_label: z.enum(['オーナー', '代表']),
  accept_url: z.string().url(),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function renderTransferProposedEmail(vars: z.infer<typeof TransferProposedVarsSchema>): EmailEnvelope {
  const greeting = vars.display_name ?? vars.email_address;
  return {
    to: vars.email_address,
    from: 'ほめゴハン <noreply@homegohan.app>',
    subject: `[ほめゴハン] ${vars.scope_label}「${vars.scope_name}」の${vars.new_role_label}譲渡が提案されました`,
    text: `${greeting} 様

${vars.proposer_name} 様から、${vars.scope_label}「${vars.scope_name}」の${vars.new_role_label}を引き継ぐよう提案がありました。

▼ 提案を確認して承諾する
${vars.accept_url}

このリンクは ${vars.expires_at} まで有効です。
期限を過ぎると提案は自動的に無効になります。

────────────
ほめゴハン
https://homegohan.app
`,
  };
}
```

### 5.2 譲渡完了通知 (旧 owner/representative 向け)
完了後に旧名義人に通知。テンプレート省略 (上記と同パターン)。

---

## 6. 除名/脱退通知

### 6.1 メンバが除名された通知 (除名された当人へ)
```
件名: [ほめゴハン] {scope_label}「{scope_name}」から外されました

{display_name} 様

{scope_label}「{scope_name}」のメンバーから外されました。

あなたのほめゴハンの個人アカウントは引き続き利用できます。
{scope_label} で記録した個人データはあなたのアカウントに残ります。

───────
ほめゴハン
```

### 6.2 メンバ脱退通知 (representative/owner 向け)
```
件名: [ほめゴハン] {member_name} 様が「{scope_name}」から脱退しました

{representative_name} 様

{member_name} 様が {scope_label}「{scope_name}」から自発的に脱退しました。

メンバー管理画面で確認できます:
{members_url}

───────
ほめゴハン
```

---

## 7. 運営強制操作通知

運営管理者が強制譲渡/解散を実行した際、影響を受ける全メンバに通知:
```
件名: [ほめゴハン重要なお知らせ] {scope_label}「{scope_name}」に関する運営からのご連絡

{display_name} 様

{scope_label}「{scope_name}」について、運営側で以下の対応を行いました:

【対応内容】
{operator_action_summary}

【理由】
{operator_reason}

ご不明な点がございましたら support@homegohan.app までお問い合わせください。

───────
ほめゴハン運営チーム
```

---

## 8. Resend 送信ラッパ

```ts
// src/lib/emails/send.ts
import { Resend } from 'resend';
import { EmailEnvelopeSchema, type EmailEnvelope } from './membership/templates';

const resend = new Resend(process.env.RESEND_API_KEY!);

export async function sendEmail(envelope: EmailEnvelope) {
  // Zod で送信前検証 (空件名/不正アドレス検出)
  const v = EmailEnvelopeSchema.parse(envelope);

  const result = await resend.emails.send({
    from: v.from,
    to: v.to,
    subject: v.subject,
    text: v.text,
    html: v.html,
    reply_to: v.reply_to,
  });

  if (result.error) {
    throw new Error(`EMAIL_SEND_FAILED: ${result.error.message}`);
  }
  return result.data;
}
```

---

## 9. URL ベース (環境変数)

```ts
// src/lib/membership/urls.ts
export function getInviteBaseUrl(): string {
  return process.env.NEXT_PUBLIC_INVITE_BASE_URL
    ?? 'https://homegohan-app.vercel.app';  // ステージングデフォルト
  // 本番は `homegohan.com` を取得後に env で上書き
}

export function buildOrgInviteUrl(token: string): string {
  return `${getInviteBaseUrl()}/invite/${token}`;
}

export function buildFamilyInviteUrl(token: string): string {
  return `${getInviteBaseUrl()}/invite/${token}`;  // org/family 共通 path
}

export function buildOrgTransferAcceptUrl(proposalId: string): string {
  return `${getInviteBaseUrl()}/org/transfer-accept/${proposalId}`;
}

export function buildFamilyTransferAcceptUrl(proposalId: string): string {
  return `${getInviteBaseUrl()}/family/transfer-accept/${proposalId}`;
}
```

`.env.example` に `NEXT_PUBLIC_INVITE_BASE_URL` を追加。本番デプロイ時に `https://homegohan.com` (取得後) または現状の `https://homegohan-app.vercel.app` を設定。

---

## 10. テスト

```ts
// src/__tests__/lib/emails/membership/templates.test.ts
import { renderOrgInviteExistingEmail } from '@/lib/emails/membership/org-invite-existing';
import { EmailEnvelopeSchema } from '@/lib/emails/membership/templates';

test('Template A renders valid envelope', () => {
  const envelope = renderOrgInviteExistingEmail({
    display_name: '山田太郎',
    email_address: 'taro@example.com',
    inviter_name: '田中花子',
    scope_name: 'ABC 株式会社',
    invite_url: 'https://homegohan.com/invite/abc123',
    expires_at: '2026-05-24',
    custom_message: null,
  });
  expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
  expect(envelope.subject).toContain('[ほめゴハン]');
  expect(envelope.subject).toContain('ABC 株式会社');
  expect(envelope.text).toContain('山田太郎 様');
  expect(envelope.text).toContain('田中花子 様');
  expect(envelope.text).toContain('https://homegohan.com/invite/abc123');
});

// 同様に B / C / 譲渡通知のテストを書く
```

---

## 11. 既存メールの一斉「ほめゴハン」化 (別 PR)

既存 `homegohan` 表記を「ほめゴハン」に書き換える対象:
- `src/app/api/contact/route.ts` の from / 件名
- `src/app/api/admin/support/tickets/[id]/messages/route.ts` の件名
- (将来) Supabase Auth カスタムテンプレート (signup confirm / magic link / reset)
- アプリ内 UI 文言 (header logo の alt, footer copyright, error message 内のサービス名等)

このタスクは **本設計の scope 外**として別 PR で対応 (Task #159 として後で create)。
