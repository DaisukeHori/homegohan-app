/**
 * legal-consent-api のユニットテスト (#1442 / 設計書 docs/design/cross/13a-legal-consent-api-server.md §6.14 A)
 *
 * /api の同意ゲートの判定 (resolveLegalConsentApiDecision)・403 の本文・GET /api/legal/status の応答 (resolveLegalConsentStatus)
 * と、その形の手書きの検査 (isLegalConsentStatus) を確かめる。
 * 版の値そのものは LEGAL_DOCUMENTS から読む (改定のたびにテストを直さない)。
 */
import { describe, expect, it } from 'vitest';
import {
  LEGAL_CONSENT_EXEMPT_API_PATHS,
  LEGAL_CONSENT_REQUIRED_CODE,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  isLegalConsentRequiredBody,
  isLegalConsentStatus,
  legalConsentRequiredBody,
  resolveLegalConsentApiDecision,
  resolveLegalConsentStatus,
} from './legal-consent-api';
import { LEGAL_DOCUMENTS, type AcceptedLegalVersions } from './legal-versions';
import { getLegalConsentGaps, type LegalConsentProfile } from './parental-consent';

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
/** いま有効な版と必ず違う値 (旧版の代わり) */
const OLD_VERSION = 'v0-old';

/** 成人の placeholder。#1173 で生年月日が無いと同意ゲートを通れないため */
const ADULT_BIRTH_DATE = '1990-01-01';

const ACCEPTED_CURRENT: LegalConsentProfile = {
  terms_version_accepted: CURRENT_TERMS,
  privacy_version_accepted: CURRENT_PRIVACY,
  birth_date: ADULT_BIRTH_DATE,
};

/** #1173 のテストで固定する JST の今日 (today の引数で渡す) */
const FIXED_TODAY = '2026-10-16';
/** FIXED_TODAY に 17 歳 (明日 18 歳になる) */
const BIRTH_DATE_17 = '2008-10-17';

/** 未同意の形 (行なし / NULL / 片方だけ / 旧版) */
const NOT_ACCEPTED_CASES: ReadonlyArray<[string, AcceptedLegalVersions | null | undefined]> = [
  ['行なし (null)', null],
  ['行なし (undefined)', undefined],
  ['両方 NULL', { terms_version_accepted: null, privacy_version_accepted: null }],
  ['利用規約だけ同意', { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: null }],
  ['プライバシーポリシーだけ同意', { terms_version_accepted: null, privacy_version_accepted: CURRENT_PRIVACY }],
  ['利用規約が旧版', { terms_version_accepted: OLD_VERSION, privacy_version_accepted: CURRENT_PRIVACY }],
  ['プライバシーポリシーが旧版', { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: OLD_VERSION }],
  ['両方旧版', { terms_version_accepted: OLD_VERSION, privacy_version_accepted: OLD_VERSION }],
];

/** 許可リストの代表 (完全一致と prefix の下) */
const EXEMPT_SAMPLES = [
  '/api/legal/accept',
  '/api/legal/status',
  '/api/auth',
  '/api/auth/login',
  '/api/auth/native-bridge/code',
  '/api/account/delete',
  '/api/account/export',
  '/api/billing/subscription',
  '/api/billing/subscription/cancel',
  '/api/billing/portal',
  '/api/webhooks/stripe',
  '/api/push-tokens/claim',
  '/api/contact',
  '/api/log',
  '/api/feature-flags',
  '/api/health',
  '/api/cron/process-menu-queue',
  '/api/webhooks/resend',
  '/api/e2e/reset-onboarding',
];

/** 許可リストに似ているだけのパス・許可リストの外 */
const NOT_EXEMPT_SAMPLES = [
  '/api/logx',
  '/api/authx',
  '/api/cronx',
  '/api/webhooksx',
  '/api/e2ex',
  '/api/legal/acceptx',
  '/api/legal/status/x',
  '/api/account/delete-xxx',
  '/api/account/export/x',
  // 有料プラン: 凍結中も通す 3 本だけ。購入・解約の取り消し・似た名前は止める
  '/api/billing/checkout',
  '/api/billing/checkout/preview',
  '/api/billing/checkout/sync',
  '/api/billing/subscription/resume',
  '/api/billing/subscription/',
  '/api/billing/portal/x',
  '/api/contact/x',
  '/api/health/records',
  '/api/meals',
  '/api/admin/users',
  '/api/onboarding/status',
  '/api/export/meals',
  // 通知のトークン: 完全一致の claim だけを通す。release (セッション無しで route が自分で認可する) と似た名前は止める
  '/api/push-tokens/release',
  '/api/push-tokens/claimx',
  '/api/push-tokens/claim/x',
  '/api/push-tokens',
];

describe('isLegalConsentRequiredBody (T-SH1)', () => {
  it('isLegalConsentRequiredBody: 平たい { code } と入れ子 { error: { code } } の両方を見分け、ほかのコード・文字列・null は見分けない', () => {
    expect(isLegalConsentRequiredBody({ error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE })).toBe(true);
    expect(isLegalConsentRequiredBody({ code: LEGAL_CONSENT_REQUIRED_CODE })).toBe(true);
    expect(isLegalConsentRequiredBody({ error: { code: LEGAL_CONSENT_REQUIRED_CODE, message: 'x' } })).toBe(true);

    expect(isLegalConsentRequiredBody({ error: 'x', code: 'AI_CONSENT_REQUIRED' })).toBe(false);
    expect(isLegalConsentRequiredBody({ error: { code: 'AUTH_ACCOUNT_FROZEN', message: 'x' } })).toBe(false);
    expect(isLegalConsentRequiredBody({ error: LEGAL_CONSENT_REQUIRED_CODE })).toBe(false);
    expect(isLegalConsentRequiredBody(LEGAL_CONSENT_REQUIRED_CODE)).toBe(false);
    expect(isLegalConsentRequiredBody(null)).toBe(false);
    expect(isLegalConsentRequiredBody(undefined)).toBe(false);
    expect(isLegalConsentRequiredBody({})).toBe(false);
  });
});

describe('resolveLegalConsentApiDecision (T-SH2〜T-SH4)', () => {
  it('resolveLegalConsentApiDecision: enforce が false なら、未同意でも許可リスト外でも allow', () => {
    for (const pathname of [...EXEMPT_SAMPLES, ...NOT_EXEMPT_SAMPLES]) {
      for (const [, accepted] of NOT_ACCEPTED_CASES) {
        expect(resolveLegalConsentApiDecision({ pathname, accepted, enforce: false }), pathname).toBe('allow');
      }
    }
  });

  it('resolveLegalConsentApiDecision: 許可リストの path (完全一致と prefix) は未同意でも allow、似た名前 (/api/logx /api/authx /api/cronx) は deny', () => {
    for (const pathname of EXEMPT_SAMPLES) {
      expect(resolveLegalConsentApiDecision({ pathname, accepted: null, enforce: true }), pathname).toBe('allow');
    }
    for (const pathname of NOT_EXEMPT_SAMPLES) {
      expect(resolveLegalConsentApiDecision({ pathname, accepted: null, enforce: true }), pathname).toBe('deny');
    }
    // 許可リストの各行そのものも allow
    for (const entry of LEGAL_CONSENT_EXEMPT_API_PATHS) {
      expect(resolveLegalConsentApiDecision({ pathname: entry.path, accepted: null, enforce: true }), entry.path).toBe('allow');
    }
  });

  it.each(NOT_ACCEPTED_CASES)(
    'resolveLegalConsentApiDecision: 未同意 (行なし / NULL / 片方だけ / 旧版) は deny、現行の版に両方同意していれば allow — %s',
    (_name, accepted) => {
      expect(resolveLegalConsentApiDecision({ pathname: '/api/meals', accepted, enforce: true })).toBe('deny');
      expect(resolveLegalConsentApiDecision({ pathname: '/api/meals', accepted: ACCEPTED_CURRENT, enforce: true })).toBe('allow');
    },
  );
});

describe('resolveLegalConsentStatus (T-SH5)', () => {
  it('resolveLegalConsentStatus: required = enforced && !accepted。current は LEGAL_DOCUMENTS の版と施行日 (effective_date)、outdated は同意していない文書だけ、accepted_versions は行の値 (行が無ければ null)', () => {
    const expectedCurrent = {
      terms_of_service: {
        version: LEGAL_DOCUMENTS.terms_of_service.version,
        effective_date: LEGAL_DOCUMENTS.terms_of_service.effectiveDate,
      },
      privacy_policy: {
        version: LEGAL_DOCUMENTS.privacy_policy.version,
        effective_date: LEGAL_DOCUMENTS.privacy_policy.effectiveDate,
      },
    };

    expect(resolveLegalConsentStatus({ accepted: null, enforced: true })).toEqual({
      enforced: true,
      accepted: false,
      required: true,
      outdated: ['terms_of_service', 'privacy_policy'],
      gaps: ['terms_of_service', 'privacy_policy', 'birth_date'],
      current: expectedCurrent,
      accepted_versions: { terms_version: null, privacy_version: null },
    });

    expect(
      resolveLegalConsentStatus({
        accepted: { terms_version_accepted: OLD_VERSION, privacy_version_accepted: CURRENT_PRIVACY },
        enforced: true,
      }),
    ).toEqual({
      enforced: true,
      accepted: false,
      required: true,
      outdated: ['terms_of_service'],
      gaps: ['terms_of_service', 'birth_date'],
      current: expectedCurrent,
      accepted_versions: { terms_version: OLD_VERSION, privacy_version: CURRENT_PRIVACY },
    });

    expect(resolveLegalConsentStatus({ accepted: ACCEPTED_CURRENT, enforced: true })).toEqual({
      enforced: true,
      accepted: true,
      required: false,
      outdated: [],
      gaps: [],
      current: expectedCurrent,
      accepted_versions: { terms_version: CURRENT_TERMS, privacy_version: CURRENT_PRIVACY },
    });

    // 強制していなければ、未同意でも required は false
    const off = resolveLegalConsentStatus({ accepted: undefined, enforced: false });
    expect(off.enforced).toBe(false);
    expect(off.accepted).toBe(false);
    expect(off.required).toBe(false);
    expect(off.accepted_versions).toEqual({ terms_version: null, privacy_version: null });

    // 4 通りの組み合わせで required = enforced && !accepted
    for (const enforced of [true, false]) {
      for (const accepted of [ACCEPTED_CURRENT, null]) {
        const status = resolveLegalConsentStatus({ accepted, enforced });
        expect(status.required).toBe(enforced && !status.accepted);
      }
    }
  });
});

describe('#1173 生年月日と保護者の同意とのつながり (T-API1・T-API2)', () => {
  it('T-API1 resolveLegalConsentApiDecision: 版が一致し birth_date が無い profile と、17 歳で minor_guardian_ok が true でない profile は deny、17 歳で minor_guardian_ok = true と 1990-01-01 は allow。enforce = false と許可リストのパスは birth_date が無くても allow', () => {
    const versions = { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY };
    const decide = (accepted: LegalConsentProfile, pathname = '/api/meals', enforce = true) =>
      resolveLegalConsentApiDecision({ pathname, accepted, enforce, today: FIXED_TODAY });

    expect(decide({ ...versions })).toBe('deny');
    expect(decide({ ...versions, birth_date: null })).toBe('deny');
    expect(decide({ ...versions, birth_date: BIRTH_DATE_17, minor_guardian_ok: false })).toBe('deny');
    expect(decide({ ...versions, birth_date: BIRTH_DATE_17, minor_guardian_ok: null })).toBe('deny');
    expect(decide({ ...versions, birth_date: BIRTH_DATE_17 })).toBe('deny');
    expect(decide({ ...versions, birth_date: BIRTH_DATE_17, minor_guardian_ok: true })).toBe('allow');
    expect(decide({ ...versions, birth_date: ADULT_BIRTH_DATE })).toBe('allow');

    // 強制していない・許可リストのパスは、生年月日が無くても止めない
    expect(decide({ ...versions, birth_date: null }, '/api/meals', false)).toBe('allow');
    for (const pathname of ['/api/legal/accept', '/api/legal/status', '/api/account/delete']) {
      expect(decide({ ...versions, birth_date: null }, pathname)).toBe('allow');
    }
  });

  it('T-API1 resolveLegalConsentApiDecision: today を渡すとその日で年齢を数える (誕生日の前日は 17 歳で deny、当日は 18 歳で allow)', () => {
    const accepted: LegalConsentProfile = { ...ACCEPTED_CURRENT, birth_date: BIRTH_DATE_17 };
    expect(resolveLegalConsentApiDecision({ pathname: '/api/meals', accepted, enforce: true, today: FIXED_TODAY })).toBe('deny');
    expect(resolveLegalConsentApiDecision({ pathname: '/api/meals', accepted, enforce: true, today: '2026-10-17' })).toBe('allow');
  });

  it('T-API2 resolveLegalConsentStatus: gaps は getLegalConsentGaps と同じ答えで、accepted は gaps が空のときだけ true、required = enforced && !accepted', () => {
    const versions = { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY };
    const noBirth = resolveLegalConsentStatus({ accepted: { ...versions, birth_date: null }, enforced: true, today: FIXED_TODAY });
    expect(noBirth).toMatchObject({ accepted: false, required: true, outdated: [], gaps: ['birth_date'] });

    const minorWithout = resolveLegalConsentStatus({
      accepted: { ...versions, birth_date: BIRTH_DATE_17, minor_guardian_ok: false },
      enforced: true,
      today: FIXED_TODAY,
    });
    expect(minorWithout).toMatchObject({ accepted: false, required: true, outdated: [], gaps: ['guardian_consent'] });

    const minorWith = resolveLegalConsentStatus({
      accepted: { ...versions, birth_date: BIRTH_DATE_17, minor_guardian_ok: true },
      enforced: true,
      today: FIXED_TODAY,
    });
    expect(minorWith).toMatchObject({ accepted: true, required: false, gaps: [] });

    const adult = resolveLegalConsentStatus({ accepted: ACCEPTED_CURRENT, enforced: true, today: FIXED_TODAY });
    expect(adult).toMatchObject({ accepted: true, required: false, gaps: [] });

    const profiles: Array<LegalConsentProfile | null> = [
      null,
      { ...versions, birth_date: null },
      { ...versions, birth_date: BIRTH_DATE_17, minor_guardian_ok: false },
      { terms_version_accepted: OLD_VERSION, privacy_version_accepted: CURRENT_PRIVACY, birth_date: ADULT_BIRTH_DATE },
      ACCEPTED_CURRENT,
    ];
    for (const accepted of profiles) {
      for (const enforced of [true, false]) {
        const status = resolveLegalConsentStatus({ accepted, enforced, today: FIXED_TODAY });
        expect(status.gaps).toEqual(getLegalConsentGaps(accepted, FIXED_TODAY));
        expect(status.accepted).toBe(status.gaps.length === 0);
        expect(status.required).toBe(enforced && !status.accepted);
      }
    }
  });

  it('T-API2 isLegalConsentStatus: resolveLegalConsentStatus の結果を通し、gaps の欠け・配列でない・知らない値 (birthday) を通さない', () => {
    const valid = resolveLegalConsentStatus({
      accepted: { terms_version_accepted: CURRENT_TERMS, privacy_version_accepted: CURRENT_PRIVACY, birth_date: null },
      enforced: true,
      today: FIXED_TODAY,
    });
    expect(isLegalConsentStatus(valid)).toBe(true);
    expect(isLegalConsentStatus({ ...valid, gaps: ['guardian_consent'] })).toBe(true);
    const withoutGaps = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'gaps'));
    for (const body of [withoutGaps, { ...valid, gaps: 'birth_date' }, { ...valid, gaps: ['birthday'] }, { ...valid, gaps: [1] }]) {
      expect(isLegalConsentStatus(body), JSON.stringify(body)).toBe(false);
    }
  });
});

describe('isLegalConsentStatus (T-SH6)', () => {
  it('isLegalConsentStatus: resolveLegalConsentStatus の結果は通り、キーの欠け・型違い・知らない文書名は通さない', () => {
    const valid = resolveLegalConsentStatus({ accepted: null, enforced: true });
    for (const enforced of [true, false]) {
      for (const accepted of [ACCEPTED_CURRENT, null, { terms_version_accepted: OLD_VERSION }]) {
        expect(isLegalConsentStatus(resolveLegalConsentStatus({ accepted, enforced }))).toBe(true);
      }
    }

    const broken: unknown[] = [
      null,
      'status',
      {},
      { ...valid, enforced: undefined },
      { ...valid, accepted: 'false' },
      { ...valid, required: 1 },
      { ...valid, outdated: 'terms_of_service' },
      { ...valid, outdated: ['terms_of_service', 'cookie_policy'] },
      { ...valid, outdated: [1] },
      { ...valid, current: undefined },
      { ...valid, current: { terms_of_service: valid.current.terms_of_service } },
      { ...valid, current: { ...valid.current, privacy_policy: { version: '', effective_date: '2025-01-01' } } },
      { ...valid, current: { ...valid.current, privacy_policy: { version: 'v1', effective_date: 20250101 } } },
      { ...valid, accepted_versions: undefined },
      { ...valid, accepted_versions: { terms_version: 1, privacy_version: null } },
      { ...valid, accepted_versions: { terms_version: null } },
    ];
    for (const body of broken) {
      expect(isLegalConsentStatus(body), JSON.stringify(body)).toBe(false);
    }
  });
});

describe('legalConsentRequiredBody (T-SH7)', () => {
  it('legalConsentRequiredBody: キーは error と code の 2 つだけで、error に内部の語 (user_profiles / terms_version / supabase / SQL) を含まない', () => {
    const body = legalConsentRequiredBody();
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
    expect(body).toEqual({ error: LEGAL_CONSENT_REQUIRED_MESSAGE, code: LEGAL_CONSENT_REQUIRED_CODE });
    expect(isLegalConsentRequiredBody(body)).toBe(true);
    for (const word of ['user_profiles', 'terms_version', 'supabase', 'sql']) {
      expect(body.error.toLowerCase()).not.toContain(word);
    }
  });
});
