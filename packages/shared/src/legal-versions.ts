/**
 * 利用規約・プライバシーポリシーの「いま有効な版」と施行日 (#1174)
 *
 * 規約を改定するときは、この 2 つの定数 (version / effectiveDate) を書き換える。それだけで次が起きる。
 *   - 公開ページ /terms・/privacy の「版・施行日」の表示が変わる
 *   - 利用者のプロフィール (user_profiles.terms_version_accepted / privacy_version_accepted) に記録された版と
 *     食い違うので、サインイン中の全員に再同意が求められる
 *     (lib/supabase/middleware.ts の同意ゲート。環境変数 LEGAL_CONSENT_ENFORCE=on のときは同意画面 /legal-consent へ回し、
 *      それ以外の間は、LEGAL_CONSENT_NOTICE=on のときだけ画面上部に控えめなお知らせを出す。既定ではどちらも off で何も出さない)
 *
 * 版を変えずに文面だけを直すと、すでに同意した人には再同意を求めない。誤字の修正など「内容が変わらない」直しはそれでよい。
 * 内容が変わる改定 (利用目的・第三者提供・AI の扱いなど) は、必ず版を上げること。
 *
 * 施行日 (effectiveDate) は、画面に出すだけの値。再同意を求め始める時点は決めない。再同意は、版を書き換えたコードを
 * 公開した (デプロイした) 時点から始まる。施行日の前から求めたくないときは、施行日に合わせてデプロイすること。
 *
 * ⚠ 版・施行日・同意文言は弁護士の確認を経て決める (オーナー判断。T30)。
 *   いまの値は「現在公開している文面 (最終更新日 2025年1月1日)」を指す仮置きで、文面を改定するときに新しい値へ置き換える。
 *
 * version の形式:
 *   DB の terms_acceptances.document_version は varchar(20)。同意を記録する DB 関数 accept_legal_documents も同じ形式
 *   (英数字・ピリオド・ハイフン・アンダースコアの 1〜20 文字) だけを受け付ける。この形式から外れた版を置くと、
 *   同意を記録できずにゲートから抜けられなくなるため、packages/shared/src/legal-versions.test.ts が形式を検査する。
 * effectiveDate の形式:
 *   施行日 (日本時間) の YYYY-MM-DD。画面には「2025年1月1日」の形で出す。
 */

/** 同意を求める文書の種類。terms_acceptances.document_type の値と同じ */
export const LEGAL_DOCUMENT_TYPES = ['terms_of_service', 'privacy_policy'] as const;
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export interface LegalDocumentInfo {
  /** 版。user_profiles の *_version_accepted と terms_acceptances.document_version に入る文字列 */
  version: string;
  /** 施行日 (日本時間) YYYY-MM-DD */
  effectiveDate: string;
}

export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocumentType, LegalDocumentInfo>> = {
  terms_of_service: { version: 'v2025.1', effectiveDate: '2025-01-01' },
  privacy_policy: { version: 'v2025.1', effectiveDate: '2025-01-01' },
};

/** 画面に出す文書名 */
export const LEGAL_DOCUMENT_LABELS: Readonly<Record<LegalDocumentType, string>> = {
  terms_of_service: '利用規約',
  privacy_policy: 'プライバシーポリシー',
};

/** 各文書を公開しているパス (未ログインでも読める) */
export const LEGAL_DOCUMENT_PATHS: Readonly<Record<LegalDocumentType, string>> = {
  terms_of_service: '/terms',
  privacy_policy: '/privacy',
};

/** 版の最大文字数。terms_acceptances.document_version (varchar(20)) に合わせる */
export const LEGAL_VERSION_MAX_LENGTH = 20;

/**
 * 版として受け付ける形式。DB 関数 accept_legal_documents (20261008200700) の検査と同じ正規表現にしてある。
 * 変えるときは DB 関数と、この形式を前提にしているテストを一緒に直すこと。
 */
export const LEGAL_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,20}$/;

export function isValidLegalVersion(value: unknown): value is string {
  return typeof value === 'string' && LEGAL_VERSION_PATTERN.test(value);
}

/**
 * 利用者のプロフィールに記録された、同意済みの版。
 * user_profiles の列名のまま受け取れるようにして、プロフィールの行をそのまま渡せるようにしてある。
 * 行が無い (新規登録したばかりでまだ記録も作られていない) ときや、列がまだ無い環境では undefined。
 */
export interface AcceptedLegalVersions {
  terms_version_accepted?: string | null;
  privacy_version_accepted?: string | null;
}

/** 利用規約・プライバシーポリシーの両方について、いま有効な版に同意済みか */
export function hasAcceptedCurrentLegalDocuments(accepted: AcceptedLegalVersions | null | undefined): boolean {
  return getOutdatedLegalDocuments(accepted).length === 0;
}

/** いま有効な版に同意していない文書 (未同意・古い版に同意) の一覧 */
export function getOutdatedLegalDocuments(accepted: AcceptedLegalVersions | null | undefined): LegalDocumentType[] {
  const outdated: LegalDocumentType[] = [];
  if (accepted?.terms_version_accepted !== LEGAL_DOCUMENTS.terms_of_service.version) {
    outdated.push('terms_of_service');
  }
  if (accepted?.privacy_version_accepted !== LEGAL_DOCUMENTS.privacy_policy.version) {
    outdated.push('privacy_policy');
  }
  return outdated;
}

/** '2025-01-01' → '2025年1月1日'。日付として読めない値はそのまま返す (画面に出すだけなので落とさない) */
export function formatLegalEffectiveDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}
