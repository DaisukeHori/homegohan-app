/**
 * #1174 規約・プライバシーポリシーの再同意ゲートの判定 (lib/legal-consent.ts)
 *
 * 判定は「同意済みの版 × パス × 強制のフラグ (LEGAL_CONSENT_ENFORCE)」で決まる。
 *   - 現行の版に同意済み                     -> none (何もしない)
 *   - 未同意 / 古い版 かつ ゲートの対象外のパス -> none
 *   - 未同意 / 古い版 かつ 対象のパス          -> 強制 on なら redirect (同意画面へ)、それ以外は banner (お知らせだけ)
 *
 * 版の値そのものは検査しない (オーナーが書き換える)。LEGAL_DOCUMENTS から取った「現行の版」と、
 * それとは別の値の「古い版」の組み合わせで確かめる。
 * middleware 全体を通した確認は lib/supabase/__tests__/middleware.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { LEGAL_DOCUMENTS } from '@homegohan/shared';
import {
  LEGAL_CONSENT_PATH,
  buildLegalConsentNext,
  buildLegalConsentPath,
  isLegalConsentEnforced,
  isLegalConsentExemptPath,
  resolveLegalConsent,
  resolveLegalConsentNext,
} from '@/lib/legal-consent';

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
const OLD = 'v0-old';

const ACCEPTED = {
  current: { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY },
  none: { terms_version_accepted: null, privacy_version_accepted: null },
  noRow: null,
  columnsMissing: {},
  termsOld: { terms_version_accepted: OLD, privacy_version_accepted: CURRENT_PRIVACY },
  privacyOld: { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: OLD },
  bothOld: { terms_version_accepted: OLD, privacy_version_accepted: OLD },
  onlyTerms: { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: null },
} as const;

/** ゲートの対象外 (同意していなくても、差し戻さない) */
const EXEMPT_PATHS = [
  '/terms',
  '/terms/',
  '/privacy',
  '/privacy/',
  '/legal',
  '/legal/',
  '/legal-consent',
  '/legal-consent/',
  '/auth/callback',
  '/auth/native-bridge',
  '/auth/verify',
  '/auth/reset-password',
  '/api/legal/accept',
  '/api/account/export',
  '/contact',
  '/contact/',
  '/frozen',
  '/handson-tour',
  '/handson-tour/photo',
  '/_next/static/chunks/main.js',
  '/icon.svg',
  '/handson-tour/sample-meal.webp',
  '/robots.txt',
  '/manifest.json',
];

/** ゲートの対象 (同意していなければ、止める / お知らせを出す) */
const GATED_PATHS = [
  '/',
  '/home',
  '/menus/weekly',
  '/meals/new',
  '/profile',
  '/settings',
  '/health/settings',
  '/onboarding/welcome',
  '/onboarding/questions',
  '/onboarding/complete',
  '/invite/abcdef123456',
  '/family/promotions/aaaa',
  '/org/dashboard',
  '/admin',
  '/super-admin',
  '/pricing',
  '/login',
  '/signup',
];

/** 前方一致の取りこぼし防止: 対象外のパスに似ているだけのパスは、対象のまま */
const LOOK_ALIKE_PATHS = [
  '/termsx',
  '/privacyx',
  '/legalx',
  '/legal-consentx',
  '/legal-consent-x',
  '/contactx',
  '/contact-us',
  '/frozenx',
  '/authx',
  '/apix',
  '/api-docs',
  '/handson-tourx',
  '/_nextx',
];

describe('isLegalConsentEnforced (LEGAL_CONSENT_ENFORCE)', () => {
  it.each(['on', 'ON', 'On', ' on ', 'on\n'])('%j は有効', (value) => {
    expect(isLegalConsentEnforced(value)).toBe(true);
  });

  it.each([undefined, '', ' ', 'off', 'OFF', 'true', '1', 'yes', 'enabled', 'onn', 'on1', '0'])(
    '%j は無効 (明示的に on と書いたときだけ強制する)',
    (value) => {
      expect(isLegalConsentEnforced(value)).toBe(false);
    },
  );

  it('引数を省略すると環境変数 LEGAL_CONSENT_ENFORCE を読む (未設定なら無効)', () => {
    const original = process.env.LEGAL_CONSENT_ENFORCE;
    try {
      delete process.env.LEGAL_CONSENT_ENFORCE;
      expect(isLegalConsentEnforced()).toBe(false);
      process.env.LEGAL_CONSENT_ENFORCE = 'on';
      expect(isLegalConsentEnforced()).toBe(true);
      process.env.LEGAL_CONSENT_ENFORCE = 'off';
      expect(isLegalConsentEnforced()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.LEGAL_CONSENT_ENFORCE;
      else process.env.LEGAL_CONSENT_ENFORCE = original;
    }
  });
});

describe('isLegalConsentExemptPath', () => {
  it.each(EXEMPT_PATHS)('%s はゲートの対象外', (pathname) => {
    expect(isLegalConsentExemptPath(pathname)).toBe(true);
  });

  it.each(GATED_PATHS)('%s はゲートの対象', (pathname) => {
    expect(isLegalConsentExemptPath(pathname)).toBe(false);
  });

  it.each(LOOK_ALIKE_PATHS)('%s は対象外のパスに似ているだけなので、ゲートの対象', (pathname) => {
    expect(isLegalConsentExemptPath(pathname)).toBe(false);
  });
});

describe('resolveLegalConsent: 同意済みの版 × パス × フラグ', () => {
  describe.each([true, false])('強制 (LEGAL_CONSENT_ENFORCE=on) = %s', (enforce) => {
    it.each(GATED_PATHS)('現行の版に同意済みなら、%s でも何もしない', (pathname) => {
      expect(resolveLegalConsent({ pathname, accepted: ACCEPTED.current, enforce })).toBe('none');
    });

    describe.each([
      ['未同意 (列が NULL)', ACCEPTED.none],
      ['プロフィールの行が無い', ACCEPTED.noRow],
      ['列がまだ無い / 取れていない', ACCEPTED.columnsMissing],
      ['利用規約だけ古い版', ACCEPTED.termsOld],
      ['プライバシーポリシーだけ古い版', ACCEPTED.privacyOld],
      ['両方古い版', ACCEPTED.bothOld],
      ['利用規約だけ同意 (プライバシーポリシーが未同意)', ACCEPTED.onlyTerms],
    ])('%s', (_name, accepted) => {
      it.each(EXEMPT_PATHS)('対象外の %s では何もしない', (pathname) => {
        expect(resolveLegalConsent({ pathname, accepted, enforce })).toBe('none');
      });

      it.each([...GATED_PATHS, ...LOOK_ALIKE_PATHS])(
        `対象の %s では ${enforce ? '同意画面へ回す (redirect)' : 'お知らせだけ出す (banner)'}`,
        (pathname) => {
          expect(resolveLegalConsent({ pathname, accepted, enforce })).toBe(enforce ? 'redirect' : 'banner');
        },
      );
    });
  });
});

describe('buildLegalConsentNext / buildLegalConsentPath', () => {
  it('パスだけなら、そのまま', () => {
    expect(buildLegalConsentNext('/home', '')).toBe('/home');
    expect(buildLegalConsentNext('/home', '?')).toBe('/home');
  });

  it('クエリは残す', () => {
    expect(buildLegalConsentNext('/menus/weekly', '?date=2026-10-08&mode=app')).toBe(
      '/menus/weekly?date=2026-10-08&mode=app',
    );
  });

  it('RSC の取得 (_rsc) は戻り先に残さない', () => {
    expect(buildLegalConsentNext('/home', '?_rsc=abc12')).toBe('/home');
    expect(buildLegalConsentNext('/menus/weekly', '?date=2026-10-08&_rsc=abc12')).toBe('/menus/weekly?date=2026-10-08');
  });

  it('同意画面のパス (?next=...) は、元のパスとクエリをエンコードして持つ', () => {
    expect(buildLegalConsentPath('/home', '')).toBe(`${LEGAL_CONSENT_PATH}?next=%2Fhome`);
    expect(buildLegalConsentPath('/menus/weekly', '?date=2026-10-08')).toBe(
      `${LEGAL_CONSENT_PATH}?next=${encodeURIComponent('/menus/weekly?date=2026-10-08')}`,
    );
  });
});

describe('resolveLegalConsentNext: 同意後の戻り先', () => {
  it.each([null, undefined, '', '   '])('%j は /home', (raw) => {
    expect(resolveLegalConsentNext(raw)).toBe('/home');
  });

  it('同一オリジンの相対パスは、そのまま使う (クエリつきも)', () => {
    expect(resolveLegalConsentNext('/menus/weekly')).toBe('/menus/weekly');
    expect(resolveLegalConsentNext('/menus/weekly?date=2026-10-08&mode=app')).toBe(
      '/menus/weekly?date=2026-10-08&mode=app',
    );
    expect(resolveLegalConsentNext('/invite/abcdef123456')).toBe('/invite/abcdef123456');
    expect(resolveLegalConsentNext(encodeURIComponent('/onboarding/welcome'))).toBe('/onboarding/welcome');
  });

  it.each([
    'https://evil.example/home',
    '//evil.example/home',
    '/\\evil.example',
    'javascript:alert(1)',
    '%2F%2Fevil.example',
    'home',
  ])('外部・相対でない戻り先 %s は /home (open redirect 対策)', (raw) => {
    expect(resolveLegalConsentNext(raw)).toBe('/home');
  });

  it.each(['/legal-consent', '/legal-consent?next=%2Fhome', '/legal-consent/', '/api/legal/accept', '/api/account/export'])(
    '同意画面自身・API への戻り先 %s は /home (戻っても同じ画面 / 画面ではない)',
    (raw) => {
      expect(resolveLegalConsentNext(raw)).toBe('/home');
    },
  );

  it('同意画面に似ているだけのパスは、そのまま使う', () => {
    expect(resolveLegalConsentNext('/legal-consentx')).toBe('/legal-consentx');
    expect(resolveLegalConsentNext('/apix')).toBe('/apix');
  });
});
