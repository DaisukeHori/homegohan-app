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

const CURRENT_TERMS = LEGAL_DOCUMENTS.terms_of_service.version;
const CURRENT_PRIVACY = LEGAL_DOCUMENTS.privacy_policy.version;
/** いま有効な版と必ず違う値 (旧版の代わり) */
const OLD_VERSION = 'v0-old';

const ACCEPTED_CURRENT: AcceptedLegalVersions = {
  terms_version_accepted: CURRENT_TERMS,
  privacy_version_accepted: CURRENT_PRIVACY,
};

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
      current: expectedCurrent,
      accepted_versions: { terms_version: OLD_VERSION, privacy_version: CURRENT_PRIVACY },
    });

    expect(resolveLegalConsentStatus({ accepted: ACCEPTED_CURRENT, enforced: true })).toEqual({
      enforced: true,
      accepted: true,
      required: false,
      outdated: [],
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
