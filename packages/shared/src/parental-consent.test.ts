/**
 * parental-consent のユニットテスト (#1173。設計書 docs/design/cross/14-parental-consent.md §6.13 の A: T-SH1〜T-SH10)
 *
 * 年齢の計算・生年月日の検査・未成年の述語・同意ゲートの述語 (getLegalConsentGaps / isLegalConsentComplete)・文面の定数。
 * 「今日」は引数で渡す (T-SH4 と同意ゲートの述語の既定値だけが todayLocal() = JST の今日を読む)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayLocal } from './date-utils';
import { LEGAL_DOCUMENTS, getOutdatedLegalDocuments, hasAcceptedCurrentLegalDocuments } from './legal-versions';
import {
  ADULT_AGE_YEARS,
  BIRTH_DATE_MAX_AGE_YEARS,
  COPPA_AGE_YEARS,
  LEGAL_CONSENT_BIRTH_DATE_COPY,
  LEGAL_CONSENT_GAP_VALUES,
  PARENTAL_CONSENT_COPY,
  PARENTAL_CONSENT_DOCUMENT,
  PARENTAL_CONSENT_DOCUMENT_COPY,
  PARENTAL_CONSENT_VERSION_PATTERN,
  SIGNUP_MINOR_NOTICE,
  calculateAgeYears,
  getLegalConsentGaps,
  isLegalConsentComplete,
  isUnderCoppaAge,
  requiresParentalConsent,
  validateBirthDate,
  type LegalConsentProfile,
} from './parental-consent';

/** テストの「今日」(JST の暦日)。年齢の関数は今日を引数で受け取る */
const TODAY = '2026-10-16';
/** いま有効な版に両方同意した行 (同意ゲートの述語の入力) */
const CURRENT_VERSIONS = {
  terms_version_accepted: LEGAL_DOCUMENTS.terms_of_service.version,
  privacy_version_accepted: LEGAL_DOCUMENTS.privacy_policy.version,
} as const;
/** 成人の生年月日 (TODAY で 36 歳) */
const ADULT_BIRTH_DATE = '1990-01-01';

/** YYYY-MM-DD の年だけを years 戻した文字列 (月日はそのまま) */
const yearsBefore = (date: string, years: number): string => {
  const [year, rest] = [Number(date.slice(0, 4)), date.slice(4)];
  return `${String(year - years).padStart(4, '0')}${rest}`;
};

describe('calculateAgeYears / validateBirthDate', () => {
  // T-SH1
  it('calculateAgeYears: 誕生日の当日に 1 つ増える (前日は増えない)。閏日 (2/29) 生まれは平年は 3/1 に増える', () => {
    expect(calculateAgeYears('2008-05-10', '2026-05-09')).toBe(ADULT_AGE_YEARS - 1);
    expect(calculateAgeYears('2008-05-10', '2026-05-10')).toBe(ADULT_AGE_YEARS);
    expect(calculateAgeYears('2008-02-29', '2026-02-28')).toBe(ADULT_AGE_YEARS - 1);
    expect(calculateAgeYears('2008-02-29', '2026-03-01')).toBe(ADULT_AGE_YEARS);
    // 閏年の 2/29 には当日として増える
    expect(calculateAgeYears('2012-02-29', '2028-02-29')).toBe(16);
    expect(calculateAgeYears('2012-02-29', '2028-02-28')).toBe(15);
    // 読めない値は null
    expect(calculateAgeYears('2008/05/10', TODAY)).toBeNull();
    expect(calculateAgeYears('2008-05-10', 'today')).toBeNull();
  });

  // T-SH2
  it('validateBirthDate: 形式外 / 存在しない日 (2月30日) は format、明日は future、121 年前は too_old、120 年前の同日と今日は null', () => {
    expect(validateBirthDate('2000/01/01', TODAY)).toBe('format');
    expect(validateBirthDate('abc', TODAY)).toBe('format');
    expect(validateBirthDate('2001-02-30', TODAY)).toBe('format');
    expect(validateBirthDate('2026-10-17', TODAY)).toBe('future');
    expect(validateBirthDate(yearsBefore(TODAY, BIRTH_DATE_MAX_AGE_YEARS + 1), TODAY)).toBe('too_old');
    expect(validateBirthDate(yearsBefore(TODAY, BIRTH_DATE_MAX_AGE_YEARS), TODAY)).toBeNull();
    expect(validateBirthDate(TODAY, TODAY)).toBeNull();
  });
});

describe('requiresParentalConsent / isUnderCoppaAge', () => {
  // T-SH3
  it('requiresParentalConsent / isUnderCoppaAge: 17 歳 364 日は両方 true と false、18 歳の当日は false / false、12 歳は true / true、未来の日付は両方 false', () => {
    // TODAY = 2026-10-16。2008-10-17 生まれは 17 歳 364 日、2008-10-16 生まれは 18 歳の当日
    expect(requiresParentalConsent('2008-10-17', TODAY)).toBe(true);
    expect(isUnderCoppaAge('2008-10-17', TODAY)).toBe(false);
    expect(requiresParentalConsent('2008-10-16', TODAY)).toBe(false);
    expect(isUnderCoppaAge('2008-10-16', TODAY)).toBe(false);
    expect(requiresParentalConsent('2014-01-01', TODAY)).toBe(true);
    expect(isUnderCoppaAge('2014-01-01', TODAY)).toBe(true);
    expect(requiresParentalConsent('2026-10-17', TODAY)).toBe(false);
    expect(isUnderCoppaAge('2026-10-17', TODAY)).toBe(false);
    // 13 歳の誕生日の当日は COPPA の区分を出る
    expect(isUnderCoppaAge(yearsBefore(TODAY, COPPA_AGE_YEARS), TODAY)).toBe(false);
    expect(isUnderCoppaAge('2013-10-17', TODAY)).toBe(true);
    // 読めない値は false
    expect(requiresParentalConsent('2014-02-30', TODAY)).toBe(false);
  });
});

describe('calculateAgeYears(birth, todayLocal()) と JST の今日', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // T-SH4
  it('calculateAgeYears(birth, todayLocal()): UTC の 15:00 (JST の翌日 0:00) を過ぎると誕生日の当日として年齢が増える (vi.setSystemTime で固定。todayLocal は date-utils の既存の関数で、本冊は新設しない)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T14:59:59Z'));
    expect(todayLocal()).toBe('2026-05-09');
    expect(calculateAgeYears('2008-05-10', todayLocal())).toBe(ADULT_AGE_YEARS - 1);
    vi.setSystemTime(new Date('2026-05-09T15:00:00Z'));
    expect(todayLocal()).toBe('2026-05-10');
    expect(calculateAgeYears('2008-05-10', todayLocal())).toBe(ADULT_AGE_YEARS);
  });
});

describe('同意ゲートの述語', () => {
  // T-SH5
  it('getLegalConsentGaps: 行なし → 2 文書 + birth_date、版が一致して birth_date なし → [\'birth_date\']、全部揃えば []', () => {
    expect(getLegalConsentGaps(null, TODAY)).toEqual(['terms_of_service', 'privacy_policy', 'birth_date']);
    expect(getLegalConsentGaps(undefined, TODAY)).toEqual(['terms_of_service', 'privacy_policy', 'birth_date']);
    expect(getLegalConsentGaps({ ...CURRENT_VERSIONS }, TODAY)).toEqual(['birth_date']);
    expect(getLegalConsentGaps({ ...CURRENT_VERSIONS, birth_date: null }, TODAY)).toEqual(['birth_date']);
    expect(getLegalConsentGaps({ ...CURRENT_VERSIONS, birth_date: ADULT_BIRTH_DATE }, TODAY)).toEqual([]);
    // 古い版 + 生年月日あり → 文書だけ
    expect(
      getLegalConsentGaps({ terms_version_accepted: 'old', privacy_version_accepted: null, birth_date: ADULT_BIRTH_DATE }, TODAY),
    ).toEqual(['terms_of_service', 'privacy_policy']);
  });

  // T-SH6
  it('isLegalConsentComplete: gaps が空のときだけ true。hasAcceptedCurrentLegalDocuments が true でも birth_date が無ければ false', () => {
    expect(hasAcceptedCurrentLegalDocuments({ ...CURRENT_VERSIONS })).toBe(true);
    expect(isLegalConsentComplete({ ...CURRENT_VERSIONS }, TODAY)).toBe(false);
    expect(isLegalConsentComplete({ ...CURRENT_VERSIONS, birth_date: ADULT_BIRTH_DATE }, TODAY)).toBe(true);
    expect(isLegalConsentComplete(null, TODAY)).toBe(false);
    expect(isLegalConsentComplete({ terms_version_accepted: 'old', birth_date: ADULT_BIRTH_DATE }, TODAY)).toBe(false);
  });

  // T-SH7
  it('getOutdatedLegalDocuments は birth_date を見ない (既存の挙動のまま)', () => {
    const withoutBirth: LegalConsentProfile = { ...CURRENT_VERSIONS, birth_date: null };
    const birthOnly: LegalConsentProfile = { birth_date: ADULT_BIRTH_DATE };
    expect(getOutdatedLegalDocuments(withoutBirth)).toEqual([]);
    expect(getOutdatedLegalDocuments(birthOnly)).toEqual(['terms_of_service', 'privacy_policy']);
  });

  // T-SH10
  it('getLegalConsentGaps: 版が一致し 17 歳の birth_date なら、minor_guardian_ok が true のときだけ []、false・null・未設定は [\'guardian_consent\']。18 歳の当日は minor_guardian_ok を見ずに []。today を渡すとその日で数える (誕生日の前日は \'guardian_consent\'、当日は [])。isLegalConsentComplete は同じ答え', () => {
    const minorBirth = '2009-01-01'; // TODAY で 17 歳
    const minor = { ...CURRENT_VERSIONS, birth_date: minorBirth };
    expect(getLegalConsentGaps({ ...minor, minor_guardian_ok: true }, TODAY)).toEqual([]);
    expect(isLegalConsentComplete({ ...minor, minor_guardian_ok: true }, TODAY)).toBe(true);
    for (const ok of [false, null, undefined]) {
      expect(getLegalConsentGaps({ ...minor, minor_guardian_ok: ok }, TODAY), String(ok)).toEqual(['guardian_consent']);
      expect(isLegalConsentComplete({ ...minor, minor_guardian_ok: ok }, TODAY), String(ok)).toBe(false);
    }
    expect(getLegalConsentGaps(minor, TODAY)).toEqual(['guardian_consent']);

    // 18 歳の当日は minor_guardian_ok を見ない
    const adultToday = { ...CURRENT_VERSIONS, birth_date: yearsBefore(TODAY, ADULT_AGE_YEARS) };
    for (const ok of [true, false, null, undefined]) {
      expect(getLegalConsentGaps({ ...adultToday, minor_guardian_ok: ok }, TODAY), String(ok)).toEqual([]);
      expect(isLegalConsentComplete({ ...adultToday, minor_guardian_ok: ok }, TODAY), String(ok)).toBe(true);
    }

    // today を渡すとその日で数える
    const turning18 = { ...CURRENT_VERSIONS, birth_date: '2008-10-17', minor_guardian_ok: false };
    expect(getLegalConsentGaps(turning18, '2026-10-16')).toEqual(['guardian_consent']);
    expect(isLegalConsentComplete(turning18, '2026-10-16')).toBe(false);
    expect(getLegalConsentGaps(turning18, '2026-10-17')).toEqual([]);
    expect(isLegalConsentComplete(turning18, '2026-10-17')).toBe(true);
  });

  it('LEGAL_CONSENT_GAP_VALUES は文書の種類 2 つ + birth_date + guardian_consent', () => {
    expect([...LEGAL_CONSENT_GAP_VALUES]).toEqual(['terms_of_service', 'privacy_policy', 'birth_date', 'guardian_consent']);
  });
});

describe('同意文書の版と文面', () => {
  // T-SH8
  it('PARENTAL_CONSENT_DOCUMENT.version は PARENTAL_CONSENT_VERSION_PATTERN (DB の varchar(20) の CHECK) に合い、effectiveDate は YYYY-MM-DD', () => {
    expect(PARENTAL_CONSENT_DOCUMENT.version).toMatch(PARENTAL_CONSENT_VERSION_PATTERN);
    expect(PARENTAL_CONSENT_DOCUMENT.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(validateBirthDate(PARENTAL_CONSENT_DOCUMENT.effectiveDate, PARENTAL_CONSENT_DOCUMENT.effectiveDate)).toBeNull();
  });

  // T-SH9
  it('文面の定数 (SIGNUP_MINOR_NOTICE・LEGAL_CONSENT_BIRTH_DATE_COPY・PARENTAL_CONSENT_COPY・PARENTAL_CONSENT_DOCUMENT_COPY) は空でなく、「みなされ」を含まない。本人のアカウントとつなげると案内する文 (SIGNUP_MINOR_NOTICE・minorRefusedBody・withdrawnBody) はどれも「13歳以上」を含み、同意書の第 3 段落は「本人のアカウントは作成せず」を含む (13 歳未満のアカウントを作らない動作と文面を揃える)。同意書の第 5 段落 (paragraphs[4]) は、記録する項目「氏名」「生年月日」「IPアドレス」と、「外して同意を取り消したあとも」「アカウントが削除されたあとも」「退会したあとも記録は残ります」「家族グループを削除したときは」を含み、「家族にいる間」を含まない (取り消し後・子供の行が消えたあとも行を残す保持の動作 (T-DB18〜T-DB20・T-DB38) と文面を揃える)', () => {
    const texts: string[] = [
      SIGNUP_MINOR_NOTICE,
      ...Object.values(LEGAL_CONSENT_BIRTH_DATE_COPY),
      ...Object.values(PARENTAL_CONSENT_COPY),
      PARENTAL_CONSENT_DOCUMENT_COPY.title,
      ...PARENTAL_CONSENT_DOCUMENT_COPY.paragraphs,
    ];
    for (const text of texts) {
      expect(text.trim().length, text).toBeGreaterThan(0);
      expect(text, text).not.toContain('みなされ');
    }
    for (const text of [
      SIGNUP_MINOR_NOTICE,
      LEGAL_CONSENT_BIRTH_DATE_COPY.minorRefusedBody,
      LEGAL_CONSENT_BIRTH_DATE_COPY.withdrawnBody,
    ]) {
      expect(text).toContain('13歳以上');
    }
    expect(PARENTAL_CONSENT_DOCUMENT_COPY.paragraphs[2]).toContain('本人のアカウントは作成せず');
    const retention = PARENTAL_CONSENT_DOCUMENT_COPY.paragraphs[4];
    for (const phrase of [
      '氏名',
      '生年月日',
      'IPアドレス',
      '外して同意を取り消したあとも',
      'アカウントが削除されたあとも',
      '退会したあとも記録は残ります',
      '家族グループを削除したときは',
    ]) {
      expect(retention, phrase).toContain(phrase);
    }
    expect(retention).not.toContain('家族にいる間');
  });

  it('#1901 (cross/20 Q-27): 同意書と未成年の案内の文は実装に無い約束をしない (代わりに記録する・AI の解析と献立の提案に子どもの記録を使う・お問い合わせからの削除の依頼)。同意書は登録できる情報 (お名前・生年月日・性別) を書き、版は v2026.1 から上げてある', () => {
    const texts: string[] = [
      SIGNUP_MINOR_NOTICE,
      ...Object.values(LEGAL_CONSENT_BIRTH_DATE_COPY),
      ...Object.values(PARENTAL_CONSENT_COPY),
      ...PARENTAL_CONSENT_DOCUMENT_COPY.paragraphs,
    ];
    for (const text of texts) {
      for (const phrase of ['代わりに記録', '代わりに食事', 'お子さまの記録が使われる', '食事の記録・アレルギー', 'お問い合わせからご依頼']) {
        expect(text, phrase).not.toContain(phrase);
      }
    }
    expect(PARENTAL_CONSENT_DOCUMENT_COPY.paragraphs[0]).toContain('お名前・生年月日・性別（任意）');
    // 同意書の版の上げ (v2026.1 → v2026.2)。v2026.1 で記録した同意は失効しない (parental_consent_active は版を見ない。cross/14 S15)
    expect(PARENTAL_CONSENT_DOCUMENT.version).toBe('v2026.2');
  });
});
