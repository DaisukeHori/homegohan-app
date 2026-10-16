// src/lib/ops-alerts/recipient.ts
// #1157 / #1129 運用メール (OPS_ALERT_EMAIL) の宛先の読み口。app-log-alerts と backup-freshness の 2 つの cron が共有する。
// src/lib/env.ts の OPS_ALERT_EMAIL の readOnlyBy はこのファイル (tests/env-source-scan.test.ts が、ほかのファイルで値を読んでいないことを見る)。
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';

export type OpsAlertRecipient =
  /** 未設定: 何もしない (info ログを 1 行残すのは呼び出し側) */
  | { status: 'disabled' }
  /** メールアドレス 1 つの形ではない: 送らない (warn ログは呼び出し側) */
  | { status: 'invalid_config' }
  | { status: 'ok'; email: string };

/** 値そのものは返す以外に出さない (ログに書かない) */
export function resolveOpsAlertRecipient(): OpsAlertRecipient {
  const configured = process.env.OPS_ALERT_EMAIL?.trim();
  if (!configured) return { status: 'disabled' };
  const parsed = EmailEnvelopeSchema.shape.to.safeParse(configured);
  if (!parsed.success) return { status: 'invalid_config' };
  return { status: 'ok', email: parsed.data };
}
