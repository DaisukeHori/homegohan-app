import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import { renderEmailDeadLetterEmail, type EmailDeadLetterEmailVars } from '@/lib/emails/ops/email-dead-letter';
import { DEFAULT_EMAIL_FROM } from '@/lib/site-config';

// #1193 届けられなかったメール (email_outbox の dead) の運用メールの文面。設計: docs/design/operator/10-logs-and-mail-retry.md §8.2・§12。
// 載せるのは件数・文面の名前 (template)・送信待ちの画面へのリンクだけで、宛先・件名・本文・ユーザー ID は載せない。

const OUTBOX_URL = 'https://app.example.test/super-admin/email-outbox';

const baseVars: EmailDeadLetterEmailVars = {
  to_email: 'ops@example.test',
  total: 3,
  cooldown_minutes: 60,
  templates: [
    { name: 'family_invite', count: 2 },
    { name: 'support_ticket_reply', count: 1 },
  ],
  other_count: 0,
  outbox_url: OUTBOX_URL,
  // 2026-10-09 10:15 JST
  detected_at: new Date('2026-10-09T01:15:00Z'),
};

const lines = (text: string) => text.split('\n');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderEmailDeadLetterEmail (#1193)', () => {
  it('EmailEnvelopeSchema で valid な封筒を返し、template は ops_email_dead_letter・to は渡した宛先・from は getEmailFrom', () => {
    vi.stubEnv('EMAIL_FROM', '');
    const envelope = renderEmailDeadLetterEmail(baseVars);

    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.template).toBe('ops_email_dead_letter');
    expect(envelope.to).toBe('ops@example.test');
    expect(envelope.from).toBe(DEFAULT_EMAIL_FROM);

    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');
    expect(renderEmailDeadLetterEmail(baseVars).from).toBe('ほめゴハン <noreply@mail.example.test>');
  });

  it('件名は「【ほめゴハン運用】届けられなかったメールがあります (N 件)」で、件数は桁区切り (1,234)', () => {
    expect(renderEmailDeadLetterEmail(baseVars).subject).toBe('【ほめゴハン運用】届けられなかったメールがあります (3 件)');
    expect(renderEmailDeadLetterEmail({ ...baseVars, total: 1234 }).subject).toBe(
      '【ほめゴハン運用】届けられなかったメールがあります (1,234 件)',
    );
  });

  it('本文に template ごとの件数 (多い順・番号付き)・送信待ちの画面の URL (単独の行)・確認した時刻 (JST)・抑止の分数・「まだ知らせていないものだけを数えている」の一文', () => {
    const text = renderEmailDeadLetterEmail(baseVars).text;

    expect(lines(text)).toContain(' 1. family_invite … 2 件');
    expect(lines(text)).toContain(' 2. support_ticket_reply … 1 件');
    expect(text.indexOf('family_invite')).toBeLessThan(text.indexOf('support_ticket_reply'));
    expect(lines(text)).toContain(OUTBOX_URL);
    expect(text).toContain('確認した時刻: 2026/10/09 10:15 (日本時間)');
    expect(text).toContain('同じ通知は 60 分以内には送り直しません');
    expect(text).toContain('まだ知らせていないものだけを数えています (同じメールを 2 回は数えません)');
    expect(text).toContain('宛先停止リスト・退会で送らなかったものと、運用メール自身は数えていません。');
    expect(text).toContain('が 3 件あります。');
    // 10 件目までは 2 桁にそろえる
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `template_${i + 1}`, count: 10 - i }));
    expect(lines(renderEmailDeadLetterEmail({ ...baseVars, templates: ten, total: 55 }).text)).toContain('10. template_10 … 1 件');
  });

  it('ほかの文面の合計は other_count > 0 のときだけ出す (桁区切り)', () => {
    expect(renderEmailDeadLetterEmail(baseVars).text).not.toContain('ほかの文面');
    expect(lines(renderEmailDeadLetterEmail({ ...baseVars, other_count: 1500, total: 1503 }).text)).toContain(
      '    ほかの文面: 合計 1,500 件',
    );
  });

  it('宛先・件名・本文・ユーザー ID を載せない (渡した template の名前に入ったメールアドレス・UUID はマスクされる)', () => {
    const envelope = renderEmailDeadLetterEmail({
      ...baseVars,
      templates: [
        { name: 'invite to taro@example.com', count: 1 },
        { name: 'user 123e4567-e89b-12d3-a456-426614174000', count: 1 },
      ],
      total: 2,
    });

    expect(envelope.text).not.toContain('taro@example.com');
    expect(envelope.text).not.toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(envelope.text).toContain('[id]');
    expect(envelope.text).toContain('このメールに、宛先・件名・本文・利用者の情報は含めていません。');
  });
});
