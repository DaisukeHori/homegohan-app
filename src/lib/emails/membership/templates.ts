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

// メールの形 (EmailEnvelopeSchema) は send.ts と重複して持っていたため、envelope.ts の 1 つにまとめた (#1194)。
// 既存の import 先 (`./templates`) をそのまま使えるように、ここからも再エクスポートする。
export { EmailEnvelopeSchema, type EmailEnvelope } from '../envelope';
