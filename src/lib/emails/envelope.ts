// src/lib/emails/envelope.ts
// メール 1 通分の形 (宛先・送信元・件名・本文)。送信 (send.ts) と文面の組み立て (account/*, dsr/*, membership/*, ops/*, support/*) の両方が使う。
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
  // 件名・本文に秘密 (招待・本人確認・本人同意のトークンを含むリンクなど、受け取った人だけが使えるもの) を含む文面は true を入れる (#1708)。
  // sendEmail はこれを見て送信待ちの行に redact_after_send を立てる。送れたとき (sent) と、届けられずに dead になったときに
  // 宛先・件名・本文が伏せられ、生のトークンが email_outbox に 7 日 (sent)・30 日 (dead) 残らない (cross/15 §3.1 の「生のトークンは保存しない」)。
  // 宣言は文面を作る render*Email 関数が入れる (呼び出し元ごとの付け忘れを構造で防ぐ。
  // 宣言の漏れは src/__tests__/lib/emails/secret-templates.test.ts の走査が赤くする)。false は書かない (秘密が無い文面は省く)。Resend には送らない
  contains_secret: z.literal(true).optional(),
});
export type EmailEnvelope = z.infer<typeof EmailEnvelopeSchema>;
