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
 * v2026.1 は #1901 (docs/design/cross/20-terms-privacy-text.md) で作り込んだ文面の版。
 *   弁護士の確認で文面を変えるときは、内容が変わるなら次の版 (v2026.2 など) に上げる (cross/20 §9.3)。
 *   改定前の版 (v2025.1) の文面は docs/legal/archive/v2025.1/ に控えてある。
 * v2026.2 は #1917 (docs/design/family/11-self-dissolve.md §18) で、退会の条件 (譲渡するか解散するまで) を改めた版。
 *   改定前の版 (v2026.1) の文面は docs/legal/archive/v2026.1/ に控えてある。
 * v2026.3 は billing/03 (#1912) で有料プランの条文を足した版。改定前の版 (v2026.2) の文面は docs/legal/archive/v2026.2/ に控えてある。
 * v2026.4 は mobile/08 (Sign in with Apple) で委託先に Apple (ログイン) を足した版。改定前の版 (v2026.3) の文面は docs/legal/archive/v2026.3/ に控えてある。
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

/**
 * #1901 (cross/20): 本文を作り込んだ改定。内容が変わる (利用目的・第三者提供・AI の扱い・責任の範囲・未成年 ほか) ので
 * 両文書の版を v2025.1 → v2026.1 に上げる。上げるとサインイン中の全員に再同意が求められる (ファイル先頭のコメントのとおり)。
 * 施行日は公開 (デプロイ) の日で、2026-10-19 に公開した (#1918。cross/20 §9.4 の 3)。
 * 施行日は YYYY-MM-DD の形の実在する日付にする (形を外すと /api/legal/status が 500 を返し、同意画面とテストが壊れる)。
 *
 * #1917 (docs/design/family/11-self-dissolve.md §18): 代表者・オーナーが解散してから退会できるようになり、利用規約第11条 4 項・第12条 4 項・第17条 2 項と
 * プライバシーポリシー第13条 9 項の退会の条件が変わるので、両文書を v2026.2 に上げる。
 * v2026.2 の施行日は公開 (デプロイ) の日の 2026-10-21 (cross/20 §9.4 の 3・family/11 §18.4)。
 *
 * billing/03 (#1912。docs/design/billing/03-paid-plans-and-iap.md §11): 有料プランの条文 (料金・自動更新・解約・返金・無料体験・
 * アプリ内課金・家族プラン、決済の事業者 (Stripe) と RevenueCat への提供と外部送信、保存期間) を利用規約第10条・第11条 1 項・
 * 第16条 2 項・第17条・第24条とプライバシーポリシー第3条・第4条・第7条・第10条・第12条に足すので、両文書を v2026.3 に上げる。
 * v2026.3 の施行日は公開 (デプロイ) の日 (cross/20 §9.4 の 3・billing/03 §11.6)。
 *
 * mobile/08 (#1139。docs/design/mobile/08-sign-in-with-apple.md §11.8): Apple アカウントでのログインを始めるにあたり、プライバシーポリシーの
 * 委託先 (第7条)・取得する情報 (第3条のアカウントの行)・外部送信 (第10条) に Apple (ログイン) を足すので、両文書を v2026.4 に上げる。
 * 利用規約の本文は変わらないが、両文書の版は同じ値で動かす (既存の改定と同じ)。
 * v2026.4 の施行日は、予告に書いた施行日 (その日に公開 (デプロイ) する。§11.8 (i))。
 */
export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocumentType, LegalDocumentInfo>> = {
  terms_of_service: { version: 'v2026.4', effectiveDate: '2026-11-01' }, // 仮置き: マージ直前に公開日へ置き換える
  privacy_policy: { version: 'v2026.4', effectiveDate: '2026-11-01' }, // 仮置き: マージ直前に公開日へ置き換える
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
