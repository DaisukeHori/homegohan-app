import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import {
  renderAppLogErrorSpikeEmail,
  type AppLogErrorSpikeEmailVars,
} from '@/lib/emails/ops/app-log-error-spike';
import { DEFAULT_EMAIL_FROM } from '@/lib/site-config';

// #1157 エラー急増の運用メールの文面。載せるのは件数・関数名・運用ログ画面へのリンクだけで、
// ユーザー ID・メールアドレス・ログの本文は載せない (送信先の Resend は米国の事業者)。

const LOGS_URL = 'https://app.example.test/super-admin/logs';

const baseVars: AppLogErrorSpikeEmailVars = {
  to_email: 'ops@example.test',
  total: 42,
  window_minutes: 15,
  threshold: 20,
  cooldown_minutes: 60,
  functions: [
    { name: 'POST /api/meals', count: 30 },
    { name: 'cron/process-menu-queue', count: 8 },
    { name: '(関数名なし)', count: 4 },
  ],
  other_count: 0,
  logs_url: LOGS_URL,
  // 2026-10-09 10:15 JST
  detected_at: new Date('2026-10-09T01:15:00Z'),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderAppLogErrorSpikeEmail (#1157)', () => {
  it('E-1: 宛先・template・件名が決まった形で、封筒のスキーマ (EmailEnvelopeSchema) を通る', () => {
    const envelope = renderAppLogErrorSpikeEmail(baseVars);

    expect(envelope.to).toBe('ops@example.test');
    expect(envelope.template).toBe('ops_app_log_error_spike');
    expect(envelope.from).toBe(DEFAULT_EMAIL_FROM);
    expect(envelope.subject).toBe('【ほめゴハン運用】エラーが急増しています (直近 15 分で 42 件)');
    expect(() => EmailEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('E-2: 件名は 100 字以内 (EmailEnvelopeSchema の上限)。件数が大きくても収まる', () => {
    const envelope = renderAppLogErrorSpikeEmail({ ...baseVars, total: 123_456_789 });

    expect(envelope.subject.length).toBeLessThanOrEqual(100);
    expect(envelope.subject).toContain('123,456,789 件');
  });

  it('E-3: 本文に、件数・しきい値・窓・関数名 (多い順)・運用ログ画面のリンク・確認した時刻 (日本時間) が載る', () => {
    const { text } = renderAppLogErrorSpikeEmail(baseVars);

    expect(text).toContain('直近 15 分で 42 件');
    expect(text).toContain('15 分で 20 件を超えると、この通知を送る設定です。');
    expect(text).toContain(' 1. POST /api/meals … 30 件');
    expect(text).toContain(' 2. cron/process-menu-queue … 8 件');
    expect(text).toContain(' 3. (関数名なし) … 4 件');
    expect(text.indexOf('POST /api/meals')).toBeLessThan(text.indexOf('cron/process-menu-queue'));
    expect(text).toContain(LOGS_URL);
    expect(text).toContain('確認した時刻: 2026/10/09 10:15 (日本時間)');
    expect(text).toContain('同じ通知は 60 分以内には送り直しません。');
  });

  it('E-4: 載せなかった分 (other_count) があれば「ほかの関数: 合計 N 件」の行を出す。0 件なら出さない', () => {
    expect(renderAppLogErrorSpikeEmail({ ...baseVars, other_count: 0 }).text).not.toContain('ほかの関数');
    expect(renderAppLogErrorSpikeEmail({ ...baseVars, other_count: 1234 }).text).toContain('ほかの関数: 合計 1,234 件');
  });

  it('E-5: 関数名にユーザー ID・メールアドレスが含まれて渡されても、本文には載らない', () => {
    const { text, subject } = renderAppLogErrorSpikeEmail({
      ...baseVars,
      functions: [
        { name: 'GET /api/users/123e4567-e89b-12d3-a456-426614174000/notes', count: 30 },
        { name: 'notify taro.yamada@example.com', count: 12 },
      ],
    });

    for (const body of [text, subject]) {
      expect(body).not.toContain('123e4567');
      expect(body).not.toContain('taro');
      expect(body).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
    }
    expect(text).toContain('GET /api/users/[id]/notes');
  });

  it('E-6: 本文には、メールアドレス (宛先・送信元を含む) も、ログの列名 (message / error_message / error_stack / user_id) も出てこない', () => {
    const { text } = renderAppLogErrorSpikeEmail(baseVars);

    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/error_message|error_stack|user_id|request_id|metadata/);
    expect(text).not.toContain('ops@example.test');
  });

  it('E-7: 運用向けのメールなので、利用者向けの署名 (サービス名 + サイトの URL) は付けない', () => {
    const { text } = renderAppLogErrorSpikeEmail(baseVars);

    expect(text).not.toContain('─────────────────');
  });

  it('E-8: 送信元は EMAIL_FROM に従う (site-config)', () => {
    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');

    expect(renderAppLogErrorSpikeEmail(baseVars).from).toBe('ほめゴハン <noreply@mail.example.test>');
  });

  it('E-9: 件数は桁区切りで表示する (1,234 件)', () => {
    const { text } = renderAppLogErrorSpikeEmail({
      ...baseVars,
      total: 1234,
      functions: [{ name: 'a', count: 1234 }],
    });

    expect(text).toContain('直近 15 分で 1,234 件');
    expect(text).toContain('a … 1,234 件');
  });
});
