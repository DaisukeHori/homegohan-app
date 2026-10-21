import { isCalendarDate, todayLocal } from './date-utils';
import { LEGAL_DOCUMENT_TYPES, getOutdatedLegalDocuments, type AcceptedLegalVersions } from './legal-versions';

/**
 * 未成年の年齢確認と保護者の同意 (#1173) の定数・年齢の計算・同意ゲートの述語・文面。Web (Next) とモバイル (Expo) の両方が使う。
 * 年齢の規則: 誕生日の当日に 1 つ増える (DB の public.age_years_jst と同じ)。
 * 年齢計算ニ関スル法律 (誕生日の前日に満了) より 1 日だけ「まだ若い」側に倒れるので、同意を要する側 (安全側) に倒れる。
 * 今日は JST の暦日で決める。年齢の関数は呼ぶ側が date-utils の todayLocal() を渡す (「今」を読まない)。
 * 同意ゲートの述語 (getLegalConsentGaps / isLegalConsentComplete) だけは、today を省くと todayLocal() を使う。
 */

/** 18 歳未満は保護者の同意が要る (要件 03 §17.10・日本)。自分では登録できない */
export const ADULT_AGE_YEARS = 18;
/**
 * 13 歳未満は米国 COPPA の区分 (要件 03 §17.10)。本人のアカウントは作らない (DB の accept_legal_documents と昇格 2 本が
 * 同じ境の `< 13` で断る)。Push の送信側 (`src/lib/push/outbox.ts` の `decideEligibility`) は年齢を見ない (13 歳未満の本人のアカウントが無いので、除外は足していない。設計 cross/14 §8 の 9)
 */
export const COPPA_AGE_YEARS = 13;
/** 生年月日は過去 120 年以内 (要件 01 行 1720) */
export const BIRTH_DATE_MAX_AGE_YEARS = 120;
/** 電子署名 (氏名) の最大文字数。parental_consents.signed_name の CHECK と同じ */
export const SIGNED_NAME_MAX_LENGTH = 100;
/** 生年月日の形 (YYYY-MM-DD)。Zod の入口の検査に使う。暦として正しいか (2月30日など) は date-utils の isCalendarDate が見る */
export const BIRTH_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 同意文書の版の形。DB の parental_consents.consent_version の CHECK と、LEGAL_VERSION_PATTERN と同じ */
export const PARENTAL_CONSENT_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,20}$/;

export interface ParentalConsentDocumentInfo {
  /** 版。parental_consents.consent_version に入る。内容が変わる改定は版を上げる */
  version: string;
  /** 施行日 (日本時間) YYYY-MM-DD。画面に出すだけ */
  effectiveDate: string;
}
/**
 * ⚠ 文面は弁護士の確認を経て決める (§8)。
 * v2026.2 (#1901 cross/20 Q-27): 同意書の文から実装に無い約束 (保護者が代わりに記録する・AI の解析と献立の提案に子どもの記録を使う・
 * お問い合わせからの削除の依頼) を消し、登録できる情報 (名前・生年月日・性別) だけを書いたので版を上げた。
 * v2026.1 で記録した同意は失効しない (parental_consent_active は版を見ない。cross/14 S15)。新しい子どもの追加は v2026.2 で記録する。
 * 施行日は公開 (デプロイ) の日。利用規約・プライバシーポリシーの施行日 (legal-versions.ts の LEGAL_DOCUMENTS) と同じ
 * 2026-10-19 に公開した (#1918。cross/20 §9.4 の 3)。
 */
export const PARENTAL_CONSENT_DOCUMENT: Readonly<ParentalConsentDocumentInfo> = {
  version: 'v2026.2',
  effectiveDate: '2026-10-19',
};
/** 同意文書の全文を公開するパス (未ログインで読める。同意ゲートの対象外 /legal 以下) */
export const PARENTAL_CONSENT_DOCUMENT_PATH = '/legal/parental-consent';

/**
 * 満年齢 (誕生日の当日に増える)。どちらかが暦日として読めなければ (isCalendarDate が false) null。未来の生年月日は負の値。
 * today は JST の今日 (todayLocal()) を渡す。
 */
export function calculateAgeYears(birthDate: string, today: string): number | null {
  if (!isCalendarDate(birthDate) || !isCalendarDate(today)) return null;
  const [birthYear, birthMonth, birthDay] = birthDate.split('-').map(Number);
  const [year, month, day] = today.split('-').map(Number);
  let age = year - birthYear;
  if (month < birthMonth || (month === birthMonth && day < birthDay)) age -= 1;
  return age;
}

export type BirthDateProblem = 'format' | 'future' | 'too_old';

/** 生年月日として受け付けられるか。null なら受け付ける。DB の検査 (未来・120 年超) と同じ境 */
export function validateBirthDate(birthDate: string, today: string): BirthDateProblem | null {
  const age = calculateAgeYears(birthDate, today);
  if (age === null) return 'format';
  if (age < 0) return 'future';
  if (age > BIRTH_DATE_MAX_AGE_YEARS) return 'too_old';
  return null;
}

/** 18 歳未満 = 保護者の同意が要る (子供の追加) / 自分では登録できない (本人) */
export function requiresParentalConsent(birthDate: string, today: string): boolean {
  const age = calculateAgeYears(birthDate, today);
  return age !== null && age >= 0 && age < ADULT_AGE_YEARS;
}

/** 13 歳未満 (COPPA)。子供の同意の記録の区分。Push の送信側はこの述語を使わない (年齢を見ない。設計 cross/14 §8 の 9) */
export function isUnderCoppaAge(birthDate: string, today: string): boolean {
  const age = calculateAgeYears(birthDate, today);
  return age !== null && age >= 0 && age < COPPA_AGE_YEARS;
}

/**
 * 同意画面で埋めるもの (§6.5.2): いま有効な版に同意していない文書・生年月日の未入力・
 * 18 歳未満の本人の「保護者の同意とのつながり」が無いこと ('guardian_consent'。同意画面では埋められず、退会の道だけを出す)
 */
export const LEGAL_CONSENT_GAP_VALUES = [...LEGAL_DOCUMENT_TYPES, 'birth_date', 'guardian_consent'] as const;
/** LEGAL_CONSENT_GAP_VALUES の 1 つ (= 文書の種類 2 つ + 'birth_date' + 'guardian_consent')。GET /api/legal/status の gaps の Zod と、アプリの応答の形の検査が同じ一覧を使う */
export type LegalConsentGap = (typeof LEGAL_CONSENT_GAP_VALUES)[number];

/** user_profiles の行のうち、同意ゲートが見るもの。行が無い (新規登録したばかり) ときは null */
export interface LegalConsentProfile extends AcceptedLegalVersions {
  birth_date?: string | null;
  /**
   * DB の列ではない。18 歳未満の本人について、呼ぶ側が rpc('legal_minor_has_guardian_path') の答えを入れる
   * (lib/legal-consent-minor.ts の withMinorGuardianStatus)。true 以外 (未設定を含む) は「つながりが無い」として扱う。
   * 18 歳以上・生年月日の無い人では見ない
   */
  minor_guardian_ok?: boolean | null;
}

/** 同意画面で埋めるものの一覧。空なら何も要らない (順は 文書 → 生年月日 → 保護者の同意とのつながり) */
export function getLegalConsentGaps(
  profile: LegalConsentProfile | null | undefined,
  today: string = todayLocal(),
): LegalConsentGap[] {
  const gaps: LegalConsentGap[] = [...getOutdatedLegalDocuments(profile)];
  const birthDate = profile?.birth_date;
  if (!birthDate) {
    gaps.push('birth_date');
  } else if (requiresParentalConsent(birthDate, today) && profile?.minor_guardian_ok !== true) {
    gaps.push('guardian_consent');
  }
  return gaps;
}

/** 同意ゲートを通れるか = いま有効な版に両方同意し、生年月日が入っていて、18 歳未満なら保護者の同意とのつながりがある */
export function isLegalConsentComplete(
  profile: LegalConsentProfile | null | undefined,
  today: string = todayLocal(),
): boolean {
  return getLegalConsentGaps(profile, today).length === 0;
}

/** サインアップ画面 (Web / モバイル) の注記。「みなす」の文は書かない (#1174 の方針) */
export const SIGNUP_MINOR_NOTICE =
  '18歳未満の方はご自身では登録できません。13歳以上の方は、保護者の方が家族に追加し、保護者の同意のうえで、ご本人のアカウントとつなぐことができます。';

/** 同意画面 (Web の /legal-consent。アプリも WebView で同じ画面を開く。13b) の生年月日の欄と、未成年の案内の文 */
export const LEGAL_CONSENT_BIRTH_DATE_COPY = {
  label: '生年月日',
  /** 版は同意済みで、生年月日だけが無い人 (S3: isReconsent ∧ outdated が空) の導入文。それ以外の導入文は LEGAL_CONSENT_COPY.introFirst / introReconsent のまま */
  introBirthDateOnly: 'ご利用には生年月日の登録が必要です。内容をご確認のうえ、同意をお願いします。',
  hint: '年齢の確認のために必要です。一度登録すると変更できません（誤りはお問い合わせからご連絡ください）。',
  invalid: '生年月日を正しく入力してください（未来の日付、120年より前の日付は登録できません）。',
  minorRefusedHeading: '18歳未満の方はご自身では登録できません',
  minorRefusedBody:
    '入力された生年月日では18歳未満のため、ご自身では登録できません。13歳以上の方は、保護者の方がほめゴハンの家族にあなたを追加し、保護者の同意をしたあと、保護者から届く「アカウントをつなぐ」案内のメールから登録してください。13歳未満の方のアカウントは作れません。生年月日を間違えた場合は「生年月日を直す」を押してください。',
  fixButton: '生年月日を直す',
  withdrawButton: '登録をやめる（アカウントを削除する）',
  withdrawnHeading: '登録をやめました',
  withdrawnBody: 'アカウントと、ここまでに入力した情報を削除しました。13歳以上の方は、保護者の方の家族に追加されたあと、案内のメールから登録できます。',
  /** 18 歳未満の本人で、保護者の同意とのつながりが切れたとき (gaps の 'guardian_consent') の案内。ボタンは withdrawButton だけ */
  guardianMissingHeading: '保護者の同意とのつながりがありません',
  guardianMissingBody:
    '18歳未満の方は、保護者の方の家族に入っている間（または保護者から届いた「アカウントをつなぐ」案内が有効な間）だけ、ほめゴハンを使えます。家族から外れた、または案内が無効になった（断った・保護者が取り消した・期限が切れた）ため、いまは使えません。保護者の方に家族へ追加し直してもらい、届いた案内のメールから承諾してください。18歳になると、そのまま使えるようになります。',
} as const;

/** 子供の追加画面の同意の欄と、メンバーの画面の同意カードの文 */
export const PARENTAL_CONSENT_COPY = {
  heading: '保護者の同意',
  intro: '18歳未満のお子さまを家族に追加するには、親権者または法定保護者の方の同意が必要です。',
  notRequiredNote: '18歳以上の方には保護者の同意は不要です。ご本人がアプリを使う場合は、招待をご利用ください。',
  readFullTextLabel: '保護者の同意書の全文を読む',
  guardianAttestLabel: '私はこのお子さまの親権者または法定保護者です',
  agreeLabel: '保護者の同意書の内容を確認し、同意します',
  signedNameLabel: '署名（保護者の氏名をフルネームで入力）',
  signedNamePlaceholder: '例: 山田 花子',
  recordedHeading: '保護者の同意（記録済み）',
  revokedHeading: '保護者の同意（取り消し済み）',
  withdrawNote: '同意を取り消すには、このお子さまを家族から外してください。外すと、お子さまの記録の共有と新しい記録は止まります。お子さまご本人のアカウントをつないでいる場合は、そのアカウントも18歳になるまで使えなくなります。',
  /** 昇格の依頼 (/family/members/[id]/promote) と承諾 (/family/promotions/[token]) の画面で、403 PARENTAL_CONSENT_REQUIRED のときに出す */
  promotionConsentMissing:
    '保護者の同意が記録されていないため、この操作はできません。保護者の方がお子さまを家族に追加し直して、同意を記録してください。',
  /** 同じ 2 つの画面で、403 PROMOTION_UNDER_COPPA_AGE (13 歳未満の子供の昇格) のときに出す */
  promotionUnderCoppaAge:
    '13歳未満のお子さまは、ご本人のアカウントとつなげません。13歳になると、つなぐことができます。',
} as const;

/**
 * 同意文書の本文 (弁護士の確認前)。公開ページ /legal/parental-consent と子供の追加画面の要約が使う。
 * v2026.2 (#1901 cross/20 Q-27): 実装にあることだけを書く。本人のアカウントが無い子どもの行が持つのは名前・生年月日・性別と
 * 保護者の同意の記録で、食事・健康の記録を家族の誰かが代わりに付ける経路は無い (cross/20 F-33)。子どもの情報は AI 事業者へ送らない
 * (送る情報はプライバシーポリシー第6条)。運営が代わりに削除する経路も無いので、削除の依頼の約束は書かず、
 * 保存の期間と消去の請求はプライバシーポリシー (第12条・第14条) に委ねる
 */
export const PARENTAL_CONSENT_DOCUMENT_COPY = {
  title: '保護者の同意書',
  paragraphs: [
    'ほめゴハンは、18歳未満のお子さまの情報を、保護者の方の同意に基づいて取り扱います。ご本人のアカウントが無いお子さまについて、保護者の方が家族グループに登録できるのは、お名前・生年月日・性別（任意）です。',
    '同意する方は、お子さまの親権者または法定保護者であることと、登録したお子さまの情報と保護者の同意の記録を、家族グループのメンバーが閲覧できる状態になることに同意します。',
    '13歳未満のお子さまには、プッシュ通知などお子さま本人に向けた連絡を行いません。お子さま本人のアカウントは作成せず、ほめゴハンに登録するお子さまの情報は、第1段落の情報だけです。13歳以上のお子さまは、ご本人が承諾すると、ご本人のアカウントを家族グループにつなぐことができます。',
    '同意はいつでも取り消せます。取り消すには、家族のメンバー管理画面からお子さまを家族から外してください（お子さまご本人のアカウントをつないでいる場合は、そのアカウントも18歳になるまで使えなくなります）。登録した情報の保存の期間と、消去の請求の方法は、プライバシーポリシーのとおりです。',
    '同意の記録（署名した方の氏名・日時・この文書の版・お子さまの生年月日と同意の時点の年齢・同意の操作をした端末の接続元の情報（IPアドレスとブラウザなどの種類））は、同意の証跡として保存します。お子さまを家族から外して同意を取り消したあとも、お子さまご本人のアカウントをつないでいてそのアカウントが削除されたあとも、取り消した日時とあわせて保存します。署名した方が退会したあとも記録は残ります。家族グループを削除したときは、お子さまの情報とあわせて削除します。',
  ],
} as const;
