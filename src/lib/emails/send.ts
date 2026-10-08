import { Resend } from 'resend';
import { EmailEnvelopeSchema, type EmailEnvelope } from './envelope';

// メールの形 (スキーマ) は envelope.ts に 1 つだけある (#1194)。
// 既存の import 先 (`@/lib/emails/send`) をそのまま使えるように、ここからも再エクスポートする。
export { EmailEnvelopeSchema, type EmailEnvelope };

let resendInstance: Resend | null = null;
function getResend(): Resend {
  if (!resendInstance) {
    resendInstance = new Resend(process.env.RESEND_API_KEY ?? 're_dev_placeholder');
  }
  return resendInstance;
}

export async function sendEmail(envelope: EmailEnvelope) {
  const v = EmailEnvelopeSchema.parse(envelope);
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY 未設定、送信スキップ', { to: v.to, subject: v.subject });
    return { id: 'dev-no-send', skipped: true };
  }
  const result = await getResend().emails.send({
    from: v.from,
    to: v.to,
    subject: v.subject,
    text: v.text,
    html: v.html,
    replyTo: v.reply_to,
  });
  if (result.error) {
    throw new Error(`EMAIL_SEND_FAILED: ${result.error.message}`);
  }
  return result.data;
}
