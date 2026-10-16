import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import { renderCronFailureEmail, type CronFailureEmailVars } from '@/lib/emails/ops/cron-failure';
import { DEFAULT_EMAIL_FROM } from '@/lib/site-config';

// #1125 (B) 定期処理の失敗の運用メールの文面。設計: docs/design/operator/11-ops-batches-non-billing.md §6.3。
// 載せるのは件数・名前 (pg_cron のジョブ名 / Vercel Cron の route 名)・運用ログ画面へのリンクだけ。

const LOGS_URL = 'https://app.example.test/super-admin/logs';

const baseVars: CronFailureEmailVars = {
  to_email: 'ops@example.test',
  total: 3,
  lookback_days: 7,
  cooldown_minutes: 60,
  failures: [
    { name: 'pg_cron/cleanup-old-app-logs', count: 2 },
    { name: 'vercel_cron/cron/email-outbox', count: 1 },
  ],
  other_count: 0,
  logs_url: LOGS_URL,
  // 2026-10-09 10:15 JST
  detected_at: new Date('2026-10-09T01:15:00Z'),
};

const lines = (text: string) => text.split('\n');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderCronFailureEmail (#1125 の B)', () => {
  it('E-1: 宛先・template ops_cron_failure・件名が決まった形で、EmailEnvelopeSchema を通る', () => {
    vi.stubEnv('EMAIL_FROM', '');
    const envelope = renderCronFailureEmail(baseVars);

    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.template).toBe('ops_cron_failure');
    expect(envelope.to).toBe('ops@example.test');
    expect(envelope.subject).toBe('【ほめゴハン運用】定期処理が失敗しています (3 件)');
    // 件数は桁区切り
    expect(renderCronFailureEmail({ ...baseVars, total: 1234 }).subject).toBe('【ほめゴハン運用】定期処理が失敗しています (1,234 件)');
    // 秘密 (トークン入りのリンク) を含まない文面なので、送信待ちで伏せる宣言を付けない
    expect(envelope).not.toHaveProperty('contains_secret');
  });

  it('E-2: 本文に件数・名前 (多い順・番号付き)・見る範囲・運用ログ画面のリンク (単独の行)・確認した時刻 (日本時間) が載る', () => {
    const text = renderCronFailureEmail(baseVars).text;

    expect(text).toContain('失敗した実行が 3 件あります。');
    expect(text).toContain('直近 7 日のうち、まだ知らせていないものだけを数えています (同じ失敗を 2 回は数えません)。');
    expect(lines(text)).toContain(' 1. pg_cron/cleanup-old-app-logs … 2 件');
    expect(lines(text)).toContain(' 2. vercel_cron/cron/email-outbox … 1 件');
    expect(text.indexOf('cleanup-old-app-logs')).toBeLessThan(text.indexOf('cron/email-outbox'));
    expect(lines(text)).toContain(LOGS_URL);
    expect(text).toContain('確認した時刻: 2026/10/09 10:15 (日本時間)');
    expect(text).toContain('同じ通知は 60 分以内には送り直しません');
    // 10 件目までは 2 桁にそろえる
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `pg_cron/job_${i + 1}`, count: 10 - i }));
    expect(lines(renderCronFailureEmail({ ...baseVars, failures: ten, total: 55 }).text)).toContain('10. pg_cron/job_10 … 1 件');
  });

  it('E-3: 名前に UUID・メールアドレスが含まれても本文に載らない', () => {
    const envelope = renderCronFailureEmail({
      ...baseVars,
      failures: [
        { name: 'vercel_cron/GET /api/cron/x taro@example.com', count: 1 },
        { name: 'pg_cron/job 123e4567-e89b-12d3-a456-426614174000', count: 1 },
      ],
      total: 2,
    });

    expect(envelope.text).not.toContain('taro@example.com');
    expect(envelope.text).not.toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(envelope.text).toContain('[id]');
    expect(envelope.text).toContain('このメールに、処理の中身・エラーの本文・利用者の情報は含めていません。');
  });

  it('E-4: other_count が 0 なら「ほかの処理」の行を出さない。1 以上なら桁区切りで出す', () => {
    expect(renderCronFailureEmail(baseVars).text).not.toContain('ほかの処理');
    expect(lines(renderCronFailureEmail({ ...baseVars, other_count: 1500, total: 1503 }).text)).toContain('    ほかの処理: 合計 1,500 件');
  });

  it('E-5: 署名を付けない・送信元は EMAIL_FROM (未設定なら既定の送信元)', () => {
    vi.stubEnv('EMAIL_FROM', '');
    const envelope = renderCronFailureEmail(baseVars);
    expect(envelope.from).toBe(DEFAULT_EMAIL_FROM);
    expect(envelope.text).not.toContain('ほめゴハン運営');
    expect(envelope.text.trimEnd().endsWith('利用者の情報は含めていません。')).toBe(true);

    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');
    expect(renderCronFailureEmail(baseVars).from).toBe('ほめゴハン <noreply@mail.example.test>');
  });
});
