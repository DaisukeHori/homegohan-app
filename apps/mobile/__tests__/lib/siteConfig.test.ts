/**
 * #1194: 問い合わせ先・利用規約・プライバシーポリシーの URL (src/lib/siteConfig.ts) の単体テスト
 *
 * 以前は設定画面とプロフィール画面に、存在しないドメインの利用規約・プライバシーポリシーの URL と、
 * 別のドメインの問い合わせ先 (mailto:) が直接書かれていた。ここでは、それらが
 *   - 利用規約・プライバシーポリシーは、WebView が開く Web と同じオリジン (EXPO_PUBLIC_WEB_URL / 既定の Web) の /terms /privacy
 *   - 問い合わせ先は EXPO_PUBLIC_SUPPORT_EMAIL (未設定・不正なら既定値)
 * に従うことを確かめる。既定値そのものが Web 側と同じであることは tests/site-config-guard.test.ts が確かめる。
 */

import {
  DEFAULT_SUPPORT_EMAIL,
  getPrivacyUrl,
  getSupportEmail,
  getSupportMailtoUrl,
  getTermsUrl,
} from '../../src/lib/siteConfig';
import { DEFAULT_WEB_URL } from '../../src/lib/webBaseUrl';

const ENV_NAMES = ['EXPO_PUBLIC_SUPPORT_EMAIL', 'EXPO_PUBLIC_WEB_URL'] as const;

describe('siteConfig', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // 手元の環境変数に左右されないよう、2 つとも未設定から始める
    for (const name of ENV_NAMES) {
      originalEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  describe('getSupportEmail / getSupportMailtoUrl', () => {
    it('EXPO_PUBLIC_SUPPORT_EMAIL が未設定なら既定値', () => {
      expect(getSupportEmail()).toBe(DEFAULT_SUPPORT_EMAIL);
      expect(getSupportMailtoUrl()).toBe(`mailto:${DEFAULT_SUPPORT_EMAIL}`);
    });

    it('EXPO_PUBLIC_SUPPORT_EMAIL を設定すると、そのアドレスの mailto: リンクになる', () => {
      process.env.EXPO_PUBLIC_SUPPORT_EMAIL = 'support@example.test';
      expect(getSupportEmail()).toBe('support@example.test');
      expect(getSupportMailtoUrl()).toBe('mailto:support@example.test');
    });

    it('前後の空白は除く', () => {
      process.env.EXPO_PUBLIC_SUPPORT_EMAIL = '  support@example.test  ';
      expect(getSupportEmail()).toBe('support@example.test');
    });

    it('空文字・空白だけは、未設定と同じ扱い', () => {
      process.env.EXPO_PUBLIC_SUPPORT_EMAIL = '';
      expect(getSupportEmail()).toBe(DEFAULT_SUPPORT_EMAIL);
      process.env.EXPO_PUBLIC_SUPPORT_EMAIL = '   ';
      expect(getSupportEmail()).toBe(DEFAULT_SUPPORT_EMAIL);
    });

    it.each(['support', 'support@', 'support@localhost', 'sup port@example.test', 'ほめゴハン <support@example.test>'])(
      'メールアドレスの形でない値 (%s) は既定値に戻す (宛先なしで開くメールアプリにしない)',
      (value) => {
        process.env.EXPO_PUBLIC_SUPPORT_EMAIL = value;
        expect(getSupportEmail()).toBe(DEFAULT_SUPPORT_EMAIL);
      },
    );

    it('呼ぶたびに環境変数を読む', () => {
      process.env.EXPO_PUBLIC_SUPPORT_EMAIL = 'a@example.test';
      expect(getSupportEmail()).toBe('a@example.test');
      process.env.EXPO_PUBLIC_SUPPORT_EMAIL = 'b@example.test';
      expect(getSupportEmail()).toBe('b@example.test');
    });
  });

  describe('getTermsUrl / getPrivacyUrl', () => {
    it('EXPO_PUBLIC_WEB_URL が未設定なら、WebView が開く既定の Web (DEFAULT_WEB_URL) の /terms と /privacy', () => {
      expect(getTermsUrl()).toBe(`${DEFAULT_WEB_URL}/terms`);
      expect(getPrivacyUrl()).toBe(`${DEFAULT_WEB_URL}/privacy`);
    });

    it('EXPO_PUBLIC_WEB_URL を設定すると、WebView と同じオリジンの /terms と /privacy', () => {
      process.env.EXPO_PUBLIC_WEB_URL = 'https://homegohan.com';
      expect(getTermsUrl()).toBe('https://homegohan.com/terms');
      expect(getPrivacyUrl()).toBe('https://homegohan.com/privacy');
    });

    it('EXPO_PUBLIC_WEB_URL の末尾の / は除く (// にならない)', () => {
      process.env.EXPO_PUBLIC_WEB_URL = 'https://homegohan.com/';
      expect(getTermsUrl()).toBe('https://homegohan.com/terms');
      expect(getPrivacyUrl()).toBe('https://homegohan.com/privacy');
    });

    it('EXPO_PUBLIC_WEB_URL が空文字なら既定の Web (空のまま相対 URL にしない)', () => {
      process.env.EXPO_PUBLIC_WEB_URL = '';
      expect(getTermsUrl()).toBe(`${DEFAULT_WEB_URL}/terms`);
    });

    it('存在しないドメインを指さない: 既定の Web は実在する URL (https)', () => {
      expect(getTermsUrl()).toMatch(/^https:\/\/[^/]+\/terms$/);
      expect(getPrivacyUrl()).toMatch(/^https:\/\/[^/]+\/privacy$/);
    });
  });
});
