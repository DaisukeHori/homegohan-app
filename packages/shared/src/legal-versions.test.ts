/**
 * legal-versions のユニットテスト (#1174)
 *
 * 版・施行日の値そのものは検査しない (弁護士の確認後にオーナーが決めて書き換える。そのたびにテストを直したくない)。
 * 検査するのは「どんな値を置いても、同意を記録できる形か」と、同意済みかどうかの判定。
 * 形式を外した版を置くと、同意を記録する DB 関数 accept_legal_documents に弾かれ、
 * 同意画面から先へ進めなくなるため、ここで先に落とす。
 */
import { describe, expect, it } from 'vitest';
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_LABELS,
  LEGAL_DOCUMENT_PATHS,
  LEGAL_DOCUMENT_TYPES,
  LEGAL_VERSION_MAX_LENGTH,
  LEGAL_VERSION_PATTERN,
  formatLegalEffectiveDate,
  getOutdatedLegalDocuments,
  hasAcceptedCurrentLegalDocuments,
  isValidLegalVersion,
} from './legal-versions';

describe('LEGAL_DOCUMENTS (置いた値が、同意を記録できる形であること)', () => {
  it('利用規約とプライバシーポリシーの 2 文書が定義されている', () => {
    expect([...LEGAL_DOCUMENT_TYPES]).toEqual(['terms_of_service', 'privacy_policy']);
    expect(Object.keys(LEGAL_DOCUMENTS).sort()).toEqual(['privacy_policy', 'terms_of_service']);
  });

  it.each(LEGAL_DOCUMENT_TYPES)('%s の版は DB の terms_acceptances.document_version (varchar(20)) に入る形式', (type) => {
    const { version } = LEGAL_DOCUMENTS[type];
    expect(version.length).toBeGreaterThan(0);
    expect(version.length).toBeLessThanOrEqual(LEGAL_VERSION_MAX_LENGTH);
    expect(LEGAL_VERSION_PATTERN.test(version)).toBe(true);
    expect(isValidLegalVersion(version)).toBe(true);
  });

  it.each(LEGAL_DOCUMENT_TYPES)('%s の施行日は実在する日付の YYYY-MM-DD', (type) => {
    const { effectiveDate } = LEGAL_DOCUMENTS[type];
    expect(effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const parsed = new Date(`${effectiveDate}T00:00:00Z`);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // 2025-02-30 のような存在しない日付を JS の Date は繰り上げるので、書式に戻して一致を見る
    expect(parsed.toISOString().slice(0, 10)).toBe(effectiveDate);
  });

  it.each(LEGAL_DOCUMENT_TYPES)('%s に画面の文書名と公開パスがある', (type) => {
    expect(LEGAL_DOCUMENT_LABELS[type].length).toBeGreaterThan(0);
    expect(LEGAL_DOCUMENT_PATHS[type]).toMatch(/^\/[a-z]+$/);
  });
});

describe('isValidLegalVersion / LEGAL_VERSION_PATTERN', () => {
  it.each(['v2025.1', '2025-01-01', 'v1', 'A_b-c.9', 'x'.repeat(20)])('%s は受け付ける', (value) => {
    expect(isValidLegalVersion(value)).toBe(true);
  });

  it.each([
    '',
    ' ',
    'x'.repeat(21),
    'v2025 1',
    'v2025/1',
    'v2025.1\n',
    '２０２５',
    "v1'; drop table x;--",
  ])('%j は受け付けない', (value) => {
    expect(isValidLegalVersion(value)).toBe(false);
  });

  it('文字列以外は受け付けない', () => {
    expect(isValidLegalVersion(null)).toBe(false);
    expect(isValidLegalVersion(undefined)).toBe(false);
    expect(isValidLegalVersion(20251)).toBe(false);
    expect(isValidLegalVersion({})).toBe(false);
  });
});

describe('同意済みかどうかの判定', () => {
  const currentTerms = LEGAL_DOCUMENTS.terms_of_service.version;
  const currentPrivacy = LEGAL_DOCUMENTS.privacy_policy.version;

  it('両方とも現行の版に同意済みなら、同意済み', () => {
    const accepted = { terms_version_accepted: currentTerms, privacy_version_accepted: currentPrivacy };
    expect(hasAcceptedCurrentLegalDocuments(accepted)).toBe(true);
    expect(getOutdatedLegalDocuments(accepted)).toEqual([]);
  });

  it('プロフィールの行が無い / 列がまだ無い (null・undefined) なら、両方とも未同意', () => {
    for (const accepted of [null, undefined, {}, { terms_version_accepted: null, privacy_version_accepted: null }]) {
      expect(hasAcceptedCurrentLegalDocuments(accepted)).toBe(false);
      expect(getOutdatedLegalDocuments(accepted)).toEqual(['terms_of_service', 'privacy_policy']);
    }
  });

  it('利用規約だけ古い版なら、利用規約だけが再同意の対象', () => {
    const accepted = { terms_version_accepted: `${currentTerms}-old`, privacy_version_accepted: currentPrivacy };
    expect(hasAcceptedCurrentLegalDocuments(accepted)).toBe(false);
    expect(getOutdatedLegalDocuments(accepted)).toEqual(['terms_of_service']);
  });

  it('プライバシーポリシーだけ古い版なら、プライバシーポリシーだけが再同意の対象', () => {
    const accepted = { terms_version_accepted: currentTerms, privacy_version_accepted: `${currentPrivacy}-old` };
    expect(hasAcceptedCurrentLegalDocuments(accepted)).toBe(false);
    expect(getOutdatedLegalDocuments(accepted)).toEqual(['privacy_policy']);
  });

  it('版は完全一致で比べる (前方一致・大文字小文字違いは別の版)', () => {
    expect(
      hasAcceptedCurrentLegalDocuments({
        terms_version_accepted: currentTerms.toUpperCase() === currentTerms ? currentTerms.toLowerCase() : currentTerms.toUpperCase(),
        privacy_version_accepted: currentPrivacy,
      }),
    ).toBe(false);
    expect(
      hasAcceptedCurrentLegalDocuments({
        terms_version_accepted: currentTerms.slice(0, -1),
        privacy_version_accepted: currentPrivacy,
      }),
    ).toBe(false);
  });

  it('利用規約とプライバシーポリシーの版を取り違えて記録していても、それぞれの現行の版と比べる', () => {
    // 2 文書の版が同じ値の間は区別が付かないので、別々の値のときだけ確かめる
    if (currentTerms === currentPrivacy) return;
    expect(
      hasAcceptedCurrentLegalDocuments({
        terms_version_accepted: currentPrivacy,
        privacy_version_accepted: currentTerms,
      }),
    ).toBe(false);
  });
});

describe('formatLegalEffectiveDate', () => {
  it('YYYY-MM-DD を「Y年M月D日」にする (月日の 0 埋めは付けない)', () => {
    expect(formatLegalEffectiveDate('2025-01-01')).toBe('2025年1月1日');
    expect(formatLegalEffectiveDate('2026-11-30')).toBe('2026年11月30日');
    expect(formatLegalEffectiveDate('2026-10-08')).toBe('2026年10月8日');
  });

  it('日付として読めない値は、落とさずそのまま返す', () => {
    expect(formatLegalEffectiveDate('')).toBe('');
    expect(formatLegalEffectiveDate('令和7年')).toBe('令和7年');
    expect(formatLegalEffectiveDate('2025/01/01')).toBe('2025/01/01');
  });
});
