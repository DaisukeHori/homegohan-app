/**
 * cron の共有シークレットのずれ (fail)・入れ替えの途中 (warn) を、運用のメールアドレス (OPS_ALERT_EMAIL) へ知らせる文面 (#1560)。
 * 判定と送信は GET /api/cron/app-log-alerts (src/app/api/cron/app-log-alerts/route.ts の checkCronSecretDrift / notifyCronSecret)。ここは文面を作るだけ。
 * 載せるのは所見の題と対処 (定数の表の文)・運用ログ画面へのリンク・確認した時刻だけ。秘密の値もダイジェストも、所見には無い (載せようがない)。
 * 利用者向けではないので署名は付けない。
 */
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { getEmailFrom } from '@/lib/site-config';
import { SUPER_ADMIN_ONLY_NOTE } from '@/lib/admin/operator-role-labels';

/** 種類: drift = ずれ (pg_cron からの呼び出しが止まる) / rotation = 入れ替えの途中・残り (いまは通る) */
export type CronSecretAlertKind = 'drift' | 'rotation';

/** 文面に載せる所見 (src/lib/ops-alerts/cron-secret-drift.ts の CronSecretFinding と同じ形。ここでは構造で受ける) */
export interface CronSecretEmailFinding {
  readonly id: string;
  readonly level: 'fail' | 'warn' | 'info';
  readonly title: string;
  readonly action: string;
}

export interface CronSecretDriftEmailVars {
  /** 宛先 (環境変数 OPS_ALERT_EMAIL) */
  to_email: string;
  kind: CronSecretAlertKind;
  /** 載せる所見 (route が選んだもの。1 件以上) */
  findings: ReadonlyArray<CronSecretEmailFinding>;
  /** 同じ通知を送り直さない時間 (分) */
  cooldown_minutes: number;
  /** 運用ログ画面 (/super-admin/logs) の絶対 URL */
  logs_url: string;
  /** 確認した時刻 (日本時間で表示する) */
  detected_at: Date;
}

const JST_MINUTE_FORMAT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** 一覧の番号の幅 (所見は多くても十数件なので 2 桁にそろえる) */
const LIST_NUMBER_WIDTH = 2;

/** level の表示 */
const LEVEL_LABEL: Readonly<Record<CronSecretEmailFinding['level'], string>> = { fail: 'FAIL', warn: 'WARN', info: 'INFO' };

/** 1,234 のように桁区切りにする (実行環境のロケールに左右されないよう ja-JP を指定) */
function formatCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

/**
 * subject: drift「【ほめゴハン運用】cron の共有シークレットの確認が失敗しました (N 件)」/ rotation「【ほめゴハン運用】cron の共有シークレットの入れ替えが途中です (N 件)」
 */
export function renderCronSecretDriftEmail(vars: CronSecretDriftEmailVars): EmailEnvelope {
  const count = formatCount(vars.findings.length);
  const isDrift = vars.kind === 'drift';
  const findingLines = vars.findings.flatMap((f, index) => [
    `${String(index + 1).padStart(LIST_NUMBER_WIDTH, ' ')}. [${LEVEL_LABEL[f.level]}] ${f.title}`,
    `    対処: ${f.action}`,
  ]);
  return {
    template: 'ops_cron_secret_drift',
    to: vars.to_email,
    from: getEmailFrom(),
    subject: isDrift
      ? `【ほめゴハン運用】cron の共有シークレットの確認が失敗しました (${count} 件)`
      : `【ほめゴハン運用】cron の共有シークレットの入れ替えが途中です (${count} 件)`,
    text: [
      'ほめゴハンの運用アラートです。',
      '',
      isDrift
        ? 'cron の共有シークレット (Edge Function secrets の CRON_SECRET と Vault の app_cron_secret) の自動の確認が失敗しました。pg_cron からの Edge Function の呼び出し (比較ランキングの集計・料理画像のジョブ・隠したコンテンツの削除・カタログ取り込み) が止まっているか、確かめられない状態です。'
        : 'cron の共有シークレットの入れ替えが途中の状態、または旧い値が残っている状態です。いまの呼び出しは通っていますが、片づけてください。',
      '',
      '▼ 所見',
      ...findingLines,
      '',
      '▼ 確認のしかた',
      '手元で node scripts/check-cron-secret-drift.mjs --project-ref <ref> を流すと、3 か所の状態を値を出さずに確かめられます (手順は ENV_SETUP.md「値のずれの確かめ方」)。',
      '自動の確認の仕組みと所見の読み方は docs/design/operator/12-cron-secret-drift-monitor.md。',
      `運用ログの画面 (${SUPER_ADMIN_ONLY_NOTE}):`,
      vars.logs_url,
      '',
      `確認した時刻: ${JST_MINUTE_FORMAT.format(vars.detected_at)} (日本時間)`,
      '',
      `このメールは自動で送られています。直らないままなら ${formatCount(vars.cooldown_minutes)} 分ごとにもう一度お知らせします。`,
      'このメールに、シークレットの値・ダイジェスト・利用者の情報は含めていません。',
      '',
    ].join('\n'),
  };
}
