/**
 * src/lib/emails/account/login-new-device.ts の単体テスト (#1190。設計 docs/design/cross/16-auth-history-sessions.md §18・§20.1)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailEnvelopeSchema } from '@/lib/emails/envelope';
import {
  ACCOUNT_SETTINGS_PATH,
  SESSIONS_SETTINGS_PATH,
  renderLoginNewDeviceEmail,
  type LoginNewDeviceEmailVars,
} from '@/lib/emails/account/login-new-device';
import { getSiteUrl } from '@/lib/site-config';

const SITE_URL = 'https://homegohan.example.test';

const vars: LoginNewDeviceEmailVars = {
  to_email: 'taro@example.com',
  logged_in_at: new Date('2026-10-15T01:00:00.000Z'),
  device_label: 'Windows の Chrome',
  ip_address: '203.0.113.10',
  country_code: 'JP',
};

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', SITE_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('renderLoginNewDeviceEmail (§18)', () => {
  it('template は login_new_device、宛先は to_email、件名は §18 の文', () => {
    const envelope = renderLoginNewDeviceEmail(vars);
    expect(envelope.template).toBe('login_new_device');
    expect(envelope.to).toBe('taro@example.com');
    expect(envelope.subject).toBe('【ほめゴハン】新しい端末からのログインがありました');
  });

  it('ログインの日時を日本時間で出す', () => {
    const { text } = renderLoginNewDeviceEmail(vars);
    // 2026-10-15T01:00Z は日本時間の 10:00
    expect(text).toContain('2026年10月15日 10:00 (日本時間)');
  });

  it('IP と国があれば 2 行を出し、null の方の行は出さない (両方 null なら端末の行の後に場所の行が無い)', () => {
    const both = renderLoginNewDeviceEmail(vars).text;
    expect(both).toContain('端末: Windows の Chrome\nIP アドレス: 203.0.113.10\n国: JP\n');

    const ipOnly = renderLoginNewDeviceEmail({ ...vars, country_code: null }).text;
    expect(ipOnly).toContain('IP アドレス: 203.0.113.10');
    expect(ipOnly).not.toContain('国:');

    const countryOnly = renderLoginNewDeviceEmail({ ...vars, ip_address: null }).text;
    expect(countryOnly).not.toContain('IP アドレス');
    expect(countryOnly).toContain('端末: Windows の Chrome\n国: JP\n');

    const neither = renderLoginNewDeviceEmail({ ...vars, ip_address: null, country_code: null }).text;
    expect(neither).not.toContain('IP アドレス');
    expect(neither).not.toContain('国:');
    expect(neither).toContain('端末: Windows の Chrome\n\n');
  });

  it('パスワードの変更のリンクは getSiteUrl() + /settings/account、端末の一覧のリンクは getSiteUrl() + /settings/security/sessions', () => {
    const { text } = renderLoginNewDeviceEmail(vars);
    expect(ACCOUNT_SETTINGS_PATH).toBe('/settings/account');
    expect(SESSIONS_SETTINGS_PATH).toBe('/settings/security/sessions');
    expect(text).toContain(`1. パスワードを変更する: ${getSiteUrl()}/settings/account`);
    expect(text).toContain(`2. 見覚えの無い端末をログアウトさせる: ${getSiteUrl()}/settings/security/sessions`);
    expect(getSiteUrl()).toBe(SITE_URL);
  });

  it('本文に入る利用者の値は vars の端末の文言・IP・国だけ (生の user_agent・session_id・メールアドレスを本文に書かない)', () => {
    const { text, subject } = renderLoginNewDeviceEmail(vars);
    expect(text).not.toContain('taro@example.com');
    expect(subject).not.toContain('taro@example.com');
    expect(text).not.toMatch(/Mozilla|session_id|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it('EmailEnvelopeSchema を通る', () => {
    expect(EmailEnvelopeSchema.safeParse(renderLoginNewDeviceEmail(vars)).success).toBe(true);
    expect(EmailEnvelopeSchema.safeParse(renderLoginNewDeviceEmail({ ...vars, ip_address: null, country_code: null })).success).toBe(true);
  });

  it('contains_secret を持たない (封筒に無く、EmailEnvelopeSchema.parse の後も undefined。秘密なし §18)', () => {
    const envelope = renderLoginNewDeviceEmail(vars);
    expect('contains_secret' in envelope).toBe(false);
    expect(EmailEnvelopeSchema.parse(envelope).contains_secret).toBeUndefined();
  });

  it('本文のリンクは getSiteUrl() + 固定のパス 2 つだけで、トークン・一時的な値を含まない', () => {
    const { text } = renderLoginNewDeviceEmail(vars);
    const links = text.match(/https?:\/\/\S+/g) ?? [];
    // 署名の行 (サイトの URL) を含めて、リンクはサイトの URL から始まり、クエリ・フラグメントを持たない
    expect(links).toEqual([`${SITE_URL}/settings/account`, `${SITE_URL}/settings/security/sessions`, SITE_URL]);
    for (const link of links) expect(link).not.toMatch(/[?#]/);
  });
});
