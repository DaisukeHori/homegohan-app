import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import { renderPgCronStalledEmail, type PgCronStalledEmailVars } from '@/lib/emails/ops/pg-cron-stalled';

// #1125 (B) pg_cron の停止の運用メールの文面。設計: docs/design/operator/11-ops-batches-non-billing.md §6.3。
// 載せるのは最新の実行の時刻・有効なジョブの数・しきい値だけ。利用者の情報は載せない。

const LOGS_URL = 'https://app.example.test/super-admin/logs';

const baseVars: PgCronStalledEmailVars = {
  to_email: 'ops@example.test',
  minutes_since_last_run: 90,
  // 2026-10-09 08:45 JST
  last_run_at: new Date('2026-10-08T23:45:00Z'),
  active_jobs: 17,
  stall_minutes: 60,
  cooldown_minutes: 60,
  logs_url: LOGS_URL,
  // 2026-10-09 10:15 JST
  detected_at: new Date('2026-10-09T01:15:00Z'),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderPgCronStalledEmail (#1125 の B)', () => {
  it('E-1: template ops_pg_cron_stalled・件名にしきい値の分数。EmailEnvelopeSchema を通る', () => {
    const envelope = renderPgCronStalledEmail(baseVars);

    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.template).toBe('ops_pg_cron_stalled');
    expect(envelope.to).toBe('ops@example.test');
    expect(envelope.subject).toBe('【ほめゴハン運用】pg_cron のジョブが 60 分以上動いていません');
    expect(renderPgCronStalledEmail({ ...baseVars, stall_minutes: 1440 }).subject).toBe(
      '【ほめゴハン運用】pg_cron のジョブが 1,440 分以上動いていません',
    );
  });

  it('E-2: 本文に最新の実行の時刻 (日本時間)・有効なジョブ数・確認の SQL・リンク。履歴が無ければ「記録なし」', () => {
    const text = renderPgCronStalledEmail(baseVars).text;

    expect(text).toContain('有効なジョブが 17 本あるのに、最新の実行から 90 分、1 つも動いていません (しきい値 60 分)。');
    expect(text).toContain('最新の実行: 2026/10/09 08:45 (日本時間)');
    expect(text).toContain('SELECT jobname, schedule, active FROM cron.job ORDER BY jobid;');
    expect(text).toContain('SELECT jobid, status, start_time, end_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;');
    expect(text.split('\n')).toContain(LOGS_URL);
    expect(text).toContain('確認した時刻: 2026/10/09 10:15 (日本時間)');
    expect(text).toContain('止まったままなら 60 分ごとにもう一度お知らせします。');
    expect(text).toContain('このメールに、利用者の情報は含めていません。');

    const noHistory = renderPgCronStalledEmail({ ...baseVars, last_run_at: null, minutes_since_last_run: 0 }).text;
    expect(noHistory).toContain('最新の実行: 記録なし');
    expect(noHistory).not.toContain('最新の実行: 記録なし (日本時間)');
  });

  it('E-3: 件名は 100 字以内 (しきい値の上限 1440 分でも)', () => {
    for (const stallMinutes of [10, 60, 1440]) {
      expect(renderPgCronStalledEmail({ ...baseVars, stall_minutes: stallMinutes }).subject.length).toBeLessThanOrEqual(100);
    }
  });
});
