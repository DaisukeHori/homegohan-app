// src/lib/emails/envelope.ts
// メール 1 通分の形 (宛先・送信元・件名・本文)。送信 (send.ts) と文面の組み立て (membership/*, support/*) の両方が使う。
//
// 以前は send.ts と membership/templates.ts に同じスキーマが 1 つずつあり、送信元の既定値も 2 か所に書かれていた (#1194)。
// いまはここに 1 つだけ置き、両方から再エクスポートしている (既存の import 先はそのまま使える)。
// resend パッケージに依存しないので、文面の組み立てだけを読み込む側 (テンプレート) から安全に import できる。
import { z } from 'zod';
import { getEmailFrom } from '@/lib/site-config';

export const EmailEnvelopeSchema = z.object({
  to: z.string().email(),
  // 送信元。渡されなければ EMAIL_FROM (未設定なら既定値)。parse のたびに決める (src/lib/site-config.ts)
  from: z.string().default(() => getEmailFrom()),
  subject: z.string().min(1).max(100),
  text: z.string().min(1),                   // プレーンテキスト本文
  html: z.string().optional(),               // 第 1 段階は省略 (text のみ)
  reply_to: z.string().email().optional(),
  // どの文面のメールかを表す名前 (snake_case。例: org_invite_new)。失敗のログで文面を区別するために使い、Resend には送らない。
  // 文面を作る render*Email 関数が必ず入れる (形式は src/__tests__/lib/emails/template-names.test.ts が検査する)。
  // ログの印にすぎないので、ここでは長さなどを検証しない (名前の不備でメールが止まらないように)
  template: z.string().optional(),
});
export type EmailEnvelope = z.infer<typeof EmailEnvelopeSchema>;
