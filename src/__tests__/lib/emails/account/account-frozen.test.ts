/**
 * src/lib/emails/account/account-frozen.ts の単体テスト (#2026。設計 docs/design/cross/24-freeze-notify-mail.md §7.2・§12)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import {
  ACCOUNT_FROZEN_EMAIL_SUBJECT,
  ACCOUNT_FROZEN_EMAIL_TEMPLATE,
  CONTACT_PAGE_PATH,
  FROZEN_PAGE_PATH,
  renderAccountFrozenEmail,
  type AccountFrozenEmailVars,
} from '@/lib/emails/account/account-frozen';
import { getSiteUrl, getSupportEmail } from '@/lib/site-config';

const SITE_URL = 'https://homegohan.example.test';
const SUPPORT_EMAIL = 'help@example.test';
const TO_EMAIL = 'taro@example.com';

/** 一時 BAN 7 日 (2026-10-25T01:00Z = 日本時間 10:00 に凍結、11/1 10:00 に解除の予定) */
const temporaryVars: AccountFrozenEmailVars = {
  to_email: TO_EMAIL,
  frozen_at: new Date('2026-10-25T01:00:00.000Z'),
  unban_at: new Date('2026-11-01T01:00:00.000Z'),
  operator_message: null,
};

const permanentVars: AccountFrozenEmailVars = { ...temporaryVars, unban_at: null };

const OPERATOR_MESSAGE = '投稿内容について確認が取れるまで利用を停止しています。\n詳しくはお問い合わせください。';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', SITE_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', SUPPORT_EMAIL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderAccountFrozenEmail (cross/24 §7.2)', () => {
  it('T-1 template は account_frozen (ACCOUNT_FROZEN_EMAIL_TEMPLATE と同じ値)、宛先は to_email、件名は ACCOUNT_FROZEN_EMAIL_SUBJECT', () => {
    const envelope = renderAccountFrozenEmail(temporaryVars);
    expect(envelope.template).toBe('account_frozen');
    expect(ACCOUNT_FROZEN_EMAIL_TEMPLATE).toBe('account_frozen');
    expect(envelope.template).toBe(ACCOUNT_FROZEN_EMAIL_TEMPLATE);
    expect(envelope.to).toBe(TO_EMAIL);
    expect(envelope.subject).toBe(ACCOUNT_FROZEN_EMAIL_SUBJECT);
    expect(ACCOUNT_FROZEN_EMAIL_SUBJECT).toBe('【ほめゴハン】アカウントが凍結されました');
  });

  it('T-2 凍結の日時を日本時間で出す (UTC 15:05 → 翌日 00:05)', () => {
    const { text } = renderAccountFrozenEmail({ ...permanentVars, frozen_at: new Date('2026-10-25T15:05:00.000Z') });
    expect(text.startsWith('2026年10月26日 00:05 (日本時間) に、このメールアドレスで登録されているほめゴハンのアカウントは、利用規約に基づき凍結されました。\n')).toBe(true);
    expect(text).not.toContain('2026年10月25日');
  });

  it('T-3 一時 BAN: 「一時的な凍結」と解除の予定の日時 (日本時間) と自動解除の文を出す', () => {
    const { text } = renderAccountFrozenEmail(temporaryVars);
    expect(text).toContain(
      '凍結の種類: 一時的な凍結\n解除の予定: 2026年11月1日 10:00 (日本時間)\n解除の予定の日時が過ぎると、自動的に解除されます。\n',
    );
    expect(text).not.toContain('無期限の凍結');
    expect(text).not.toContain('解除の予定はありません');
  });

  it('T-4 永久 BAN: 「無期限の凍結」「解除の予定はありません」を出し、解除の予定の行は無い', () => {
    const { text } = renderAccountFrozenEmail(permanentVars);
    expect(text).toContain('凍結の種類: 無期限の凍結\n解除の予定はありません。\n');
    expect(text).not.toContain('一時的な凍結');
    expect(text).not.toContain('解除の予定:');
    expect(text).not.toContain('自動的に解除されます');
  });

  it('T-5 運営のメッセージがあれば「▼ 運営からのメッセージ」の段にそのまま (改行を含めて) 入り、無ければ段が無い', () => {
    const withMessage = renderAccountFrozenEmail({ ...temporaryVars, operator_message: OPERATOR_MESSAGE }).text;
    expect(withMessage).toContain(`解除の予定の日時が過ぎると、自動的に解除されます。\n\n▼ 運営からのメッセージ\n${OPERATOR_MESSAGE}\n\n凍結中は、`);

    const withoutMessage = renderAccountFrozenEmail(temporaryVars).text;
    expect(withoutMessage).not.toContain('運営からのメッセージ');
    // 段が無いときは空行が 1 つだけ
    expect(withoutMessage).toContain('解除の予定の日時が過ぎると、自動的に解除されます。\n\n凍結中は、');
  });

  it('T-6 リンクは getSiteUrl() + /frozen と getSiteUrl() + /contact の 2 つだけで、問い合わせ先は getSupportEmail()', () => {
    const { text } = renderAccountFrozenEmail(temporaryVars);
    expect(getSiteUrl()).toBe(SITE_URL);
    expect(FROZEN_PAGE_PATH).toBe('/frozen');
    expect(CONTACT_PAGE_PATH).toBe('/contact');
    const links = text.match(/https?:\/\/\S+/g) ?? [];
    // 署名の行 (サイトの URL) を除くと、リンクは /frozen と /contact の 2 つだけ
    expect(links).toEqual([`${SITE_URL}/frozen`, `${SITE_URL}/contact`, SITE_URL]);
    for (const link of links) expect(link).not.toMatch(/[?#]/);
    expect(text).toContain(`ログインすると凍結中のご案内の画面が開きます: ${SITE_URL}/frozen\n`);
    expect(text).toContain(`お問い合わせ: ${SITE_URL}/contact\n`);
    expect(getSupportEmail()).toBe(SUPPORT_EMAIL);
    expect(text).toContain(`メール: ${SUPPORT_EMAIL}\n`);
  });

  it('T-7 本文に理由カテゴリ・詳細理由・ban_id・宛先のアドレスを書かない (vars に無いものは入らない)', () => {
    for (const vars of [temporaryVars, permanentVars, { ...temporaryVars, operator_message: OPERATOR_MESSAGE }]) {
      const { text, subject } = renderAccountFrozenEmail(vars);
      expect(text).not.toContain(TO_EMAIL);
      expect(subject).not.toContain(TO_EMAIL);
      // 理由カテゴリ (FreezeBodySchema の値と画面の表示)・詳細理由の見出し・ban_id (UUID) は無い
      expect(text).not.toMatch(/spam|abuse|policy_violation|スパム|不正利用|規約違反|理由カテゴリ|詳細理由|ban_id/);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  it('T-8 EmailEnvelopeSchema を通り、html を持たず、contains_secret を持たない', () => {
    for (const vars of [temporaryVars, permanentVars, { ...temporaryVars, operator_message: OPERATOR_MESSAGE }]) {
      const envelope = renderAccountFrozenEmail(vars);
      expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect('html' in envelope).toBe(false);
      expect('contains_secret' in envelope).toBe(false);
      expect(EmailEnvelopeSchema.parse(envelope).contains_secret).toBeUndefined();
    }
  });

  it('T-9 利用規約第16条の語 (「データの書き出し」「退会」「有料プランの解約」「お問い合わせ」「自動的に解除」) を本文に含む', () => {
    const { text } = renderAccountFrozenEmail(temporaryVars);
    expect(text).toContain('データの書き出し・退会・有料プランの解約・お問い合わせの送信は、凍結中も行えます。');
    expect(text).toContain('凍結に心当たりがない場合や、詳細を確認したい場合は、お問い合わせからご連絡ください。');
    for (const word of ['データの書き出し', '退会', '有料プランの解約', 'お問い合わせ', '自動的に解除']) {
      expect(text).toContain(word);
    }
  });
});
