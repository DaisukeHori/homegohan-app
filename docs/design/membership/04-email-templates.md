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

宛先は旧名義人と新名義人の 2 人で、それぞれの立場の本文を送る
(`renderOrgTransferCompletedEmail` / `renderFamilyTransferCompletedEmail`、#1110)。
承諾した本人 (新名義人) のアドレスは認証済みセッションの値を使い、旧名義人 (提案者) のアドレスは
`auth.users` から `resolveAuthEmails` (`src/lib/membership/resolve-auth-emails.ts`) で引く。
旧名義人は承諾 RPC の戻り値には含まれない (戻り値は更新後の行で、`owner_id` / `representative_id` は新名義人) ため、
承諾する前に `ownership_transfer_proposals.from_user_id` を読んで控える。
送信に失敗しても承諾の結果は変えず (200)、構造化ログに残す。

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

実装は `renderMemberRemovedEmail` (`src/lib/emails/membership/member-removed.ts`、#1160)。
個人情報を載せない方針で、宛名 (`{display_name} 様`) は書かず、載せるのは家族グループ名 / 組織名と何が起きたかだけ。
件名の括弧は他の通知メールと同じ `【ほめゴハン】`。

- 宛先は除名された本人だけ (除名を実行した人・ほかのメンバーには送らない)。アドレスは `auth.users` から
  `resolveAuthEmails` (`src/lib/membership/resolve-auth-emails.ts`) で引く。
  アカウントを持たない子供メンバー (`family_members.user_id` が NULL) と、自分で自分を外した場合は送らない。
- 家族の除名 RPC (`remove_family_member`) は行の `status` を確かめず、すでに脱退・除名済みの行にも成功する。
  同じ行の除名を繰り返して同じ人にメールを送り付けられないよう、除名の前に `active` だった行にだけ送る。
- 家族グループ名 / 組織名と、外される人 (家族は除名する行の `user_id`、組織は URL の `user_id`) は、除名 RPC を呼ぶ前に読む。
- 送る処理は `src/lib/membership/exit-notification.ts`。送信に失敗しても除名の結果は変えず (200)、構造化ログに残す。
  ログにメールアドレスは残さない。

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

実装は `renderMemberLeftEmail` (`src/lib/emails/membership/member-left.ts`、#1160)。
個人情報を載せない方針で、脱退した人の名前 (`{member_name}`) と宛名 (`{representative_name} 様`) は書かず、
載せるのは家族グループ名 / 組織名と、メンバーが脱退したこと、メンバー管理画面の URL (`/family/members` / `/org/members`) だけ。

- 宛先は家族グループの代表者 (`family_groups.representative_id`) / 組織のオーナー (`organizations.owner_id`) だけ。
  脱退した本人には送らない。オーナーが未設定の組織では送らない。アドレスは `resolveAuthEmails` で引く。
- 脱退すると、本人はその家族グループ / 組織を RLS で読めなくなる (`leave_org` の戻り値の `organization_id` も NULL)。
  家族グループ名 / 組織名と代表者 / オーナーは、脱退 RPC を呼ぶ前に読む。
- 送信に失敗しても脱退の結果は変えず (200)、構造化ログに残す。ログにメールアドレスは残さない。

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

// 脱退の通知メール (§6.2) に載せる、メンバー管理画面 (#1160)
export function buildFamilyMembersUrl(): string {
  return `${getInviteBaseUrl()}/family/members`;
}

export function buildOrgMembersUrl(): string {
  return `${getInviteBaseUrl()}/org/members`;
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

既存 `homegohan` 表記から「ほめゴハン」に書き換える対象 (本タスクで処理済):
- `src/app/api/contact/route.ts` の from / 件名
- `src/app/api/admin/support/tickets/[id]/messages/route.ts` の件名
- (将来) Supabase Auth カスタムテンプレート (signup confirm / magic link / reset)
- アプリ内 UI 文言 (header logo の alt, footer copyright, error message 内のサービス名等)

このタスクは **本設計の scope 外**として別 PR で対応 (Task #159 として後で create)。
