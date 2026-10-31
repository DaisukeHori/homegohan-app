// src/lib/emails/ops/backup-stale.ts
// #1129 DB バックアップが新しく取れていない (最新の backup.daily.completed が BACKUP_STALE_AFTER_HOURS より古い・記録が無い) ときに、
// 運用のメールアドレス (OPS_ALERT_EMAIL) へ送る通知。判定と送信は GET /api/cron/backup-freshness
// (src/app/api/cron/backup-freshness/route.ts)。ここは文面を作るだけ。設計は docs/design/cross/17-backup-automation.md §7.3。
//
// 載せるのは「最新の取得の日時」「しきい値」「確かめる場所 (GitHub Actions の db-backup と運営の画面)」だけ。
// 利用者の情報は載せない (送信先の Resend は米国の事業者)。秘密 (トークンを含むリンク) も載せないので contains_secret は付けない
// (運営の画面は super_admin のログインが要る固定の URL。src/__tests__/lib/emails/secret-templates.test.ts の秘密なしの表)。
// 利用者向けではない運用メールなので、署名 (emailSignature) は付けない。
import type { EmailEnvelope } from '../envelope';
import { getEmailFrom, getSiteUrl } from '@/lib/site-config';
import { SUPER_ADMIN_ONLY_NOTE } from '@/lib/admin/operator-role-labels';
import { SUPER_ADMIN_BACKUPS_PATH } from '@/lib/backups/core';

export interface BackupStaleEmailVars {
  /** 宛先 (環境変数 OPS_ALERT_EMAIL。src/lib/ops-alerts/recipient.ts) */
  to_email: string;
  /** 最新の取得 (backup.daily.completed) の created_at。記録が無ければ null */
  latest_completed_at: string | null;
  /** 「古い」とみなす経過時間 (時間)。BACKUP_STALE_AFTER_HOURS */
  stale_after_hours: number;
}

const JST_MINUTE_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 記録が無い (null)・日時として読めないときの表記 */
const NO_RECORD_LABEL = '記録なし';

/** 最新の取得の日時を日本時間で書く。null・読めない値は「記録なし」 */
function formatLatestCompletedAt(latestCompletedAt: string | null): string {
  if (latestCompletedAt === null) return NO_RECORD_LABEL;
  const at = Date.parse(latestCompletedAt);
  if (Number.isNaN(at)) return NO_RECORD_LABEL;
  return `${JST_MINUTE_FORMAT.format(new Date(at))} (日本時間)`;
}

/**
 * subject: 「【ほめゴハン運用】DB バックアップが 30 時間以上取れていません」
 */
export function renderBackupStaleEmail(vars: BackupStaleEmailVars): EmailEnvelope {
  const backupsPageUrl = `${getSiteUrl()}${SUPER_ADMIN_BACKUPS_PATH}`;

  return {
    template: 'ops_backup_stale',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: `【ほめゴハン運用】DB バックアップが ${vars.stale_after_hours} 時間以上取れていません`,
    text: `ほめゴハンの運用アラートです。

本番 DB のバックアップ (日次の取得) が、${vars.stale_after_hours} 時間以上新しく取れていません。
最新の取得: ${formatLatestCompletedAt(vars.latest_completed_at)}
最新の取得から ${vars.stale_after_hours} 時間を超えると、この通知を送る設定です。

▼ 確かめる場所
1. GitHub の Actions の画面の db-backup のワークフロー
   (止まっていない・失敗していないか。push の無い期間が続くと、GitHub が定期実行を止めることがあります)
2. 運営のバックアップ・DR の画面 (${SUPER_ADMIN_ONLY_NOTE})
   ${backupsPageUrl}

このメールは自動で送られています。
この確認は 1 日 1 回です。古いままなら翌日の確認でもう一度お知らせします。
このメールに、利用者の情報は含めていません。
`,
  };
}
