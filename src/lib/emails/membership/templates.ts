// src/lib/emails/membership/templates.ts
// (設計書 04-email-templates.md §1)
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
