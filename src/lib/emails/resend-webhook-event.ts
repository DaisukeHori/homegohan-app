/**
 * Resend の Webhook のイベントを読み、宛先停止リスト (email_blacklist) に入れるかを決める。純粋なモジュール。#1184
 *
 * 振り分け (POST /api/webhooks/resend が使う):
 *   - email.bounced で bounce.type が Permanent (ハードバウンス。宛先が存在しない・受け取りを拒否された) → 'bounce' で入れる
 *   - email.bounced のそれ以外 (Temporary など。受信箱がいっぱい・一時的な不調のソフトバウンス) → 記録しない
 *   - email.complained (受け取った人が迷惑メールとして報告した) → 'complaint' で入れる
 *   - それ以外の種類 (email.sent / delivered / opened など) → 何もしない (受け取ったことだけ 200 で返す)
 * 形の正本は Resend のドキュメント (https://resend.com/docs/webhooks/emails/bounced) と、SDK の型 (resend の EmailBouncedEvent)。
 */
import { z } from 'zod';
import type { EmailBlacklistReason } from '@/lib/emails/suppression';

/** ハードバウンスを表す bounce.type の値 (Resend のドキュメントの例: Permanent / Temporary)。大文字小文字は区別しない */
const HARD_BOUNCE_TYPE = 'permanent';

/**
 * Resend の Webhook の本文のうち、ここで使う項目だけのスキーマ。ほかの項目は捨てる (zod の既定)。
 * data の中身は種類ごとに違う (メール以外の contact.* / domain.* もある) ので、ここでは緩く受け、振り分けのときに確かめる。
 */
export const ResendWebhookEventSchema = z.object({
  type: z.string().min(1),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().optional(),
      to: z.union([z.array(z.string()), z.string()]).optional(),
      bounce: z
        .object({
          type: z.string().optional(),
          subType: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type ResendWebhookEvent = z.infer<typeof ResendWebhookEventSchema>;

/** 振り分けの結果 */
export type ResendEventAction =
  | { action: 'blacklist'; reason: EmailBlacklistReason; addresses: string[] }
  | { action: 'ignore'; why: 'soft_bounce' | 'no_recipient' | 'unhandled_type' };

/** data.to (配列か文字列) を、空でない宛先の配列にする */
function recipientsOf(event: ResendWebhookEvent): string[] {
  const to = event.data?.to;
  const list = Array.isArray(to) ? to : typeof to === 'string' ? [to] : [];
  return list.map((address) => address.trim()).filter((address) => address !== '');
}

/**
 * イベントを振り分ける。
 * 宛先は data.to の全部。このアプリの sendEmail は 1 通に宛先 1 つで送るので、ふつうは 1 つだけ。
 */
export function classifyResendEvent(event: ResendWebhookEvent): ResendEventAction {
  let reason: EmailBlacklistReason;
  if (event.type === 'email.bounced') {
    if ((event.data?.bounce?.type ?? '').trim().toLowerCase() !== HARD_BOUNCE_TYPE) {
      return { action: 'ignore', why: 'soft_bounce' };
    }
    reason = 'bounce';
  } else if (event.type === 'email.complained') {
    reason = 'complaint';
  } else {
    return { action: 'ignore', why: 'unhandled_type' };
  }

  const addresses = recipientsOf(event);
  if (addresses.length === 0) return { action: 'ignore', why: 'no_recipient' };
  return { action: 'blacklist', reason, addresses };
}
