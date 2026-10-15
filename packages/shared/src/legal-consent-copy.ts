/**
 * 利用規約・プライバシーポリシーの同意画面の文面 (#1174 の Web の同意画面 src/app/legal-consent/LegalConsentForm.tsx と、
 * #1442 のアプリのネイティブの同意画面 apps/mobile/src/components/legal/LegalConsentScreen.tsx が同じ値を使う。文面を 2 か所に持たない)。
 * declineButton 以外の値は #1174 の Web の文面そのまま (tests/e2e/legal-consent-gate.spec.ts と tests/legal-consent-page.test.tsx がこの文で画面を探す)。
 * declineButton だけは Web で使わない (Web のボタンは declineAndSignOutButton)。
 * 文書の名前 (利用規約 / プライバシーポリシー) は legal-versions.ts の LEGAL_DOCUMENT_LABELS。
 */
export const LEGAL_CONSENT_COPY = {
  heading: '利用規約・プライバシーポリシーへの同意',
  introFirst: 'ほめゴハンをご利用いただくには、利用規約とプライバシーポリシーへの同意が必要です。内容をご確認ください。',
  introReconsent:
    '利用規約・プライバシーポリシーが改定されました。引き続きご利用いただくには、内容をご確認のうえ、同意をお願いします。',
  revisedBadge: '改定あり',
  acceptButton: '同意して続ける',
  /**
   * アプリの「同意しない」のボタンと、その後の確認の Alert の見出し (13b §6.6)。アプリはこのボタンでは
   * ログアウトせず、Alert の「ログアウト」で初めてログアウトするので、「（ログアウトする）」を付けない。
   * Web のボタンの文 (declineAndSignOutButton) はこの文で始まる (テストが /同意しない/ の部分一致で探すため。T-C2 が固定)。
   */
  declineButton: '同意しない',
  /** Web の「同意しない」のボタン (押すとすぐログアウトする)。#1174 の LegalConsentForm.tsx:234 の文そのまま。全角の括弧 */
  declineAndSignOutButton: '同意しない（ログアウトする）',
  /** 同意を送ったら版が変わっていた (409) ときの案内 (POST /api/legal/accept の 409 の本文と同じ文) */
  versionMismatch: '利用規約・プライバシーポリシーが更新されました。画面を読み込み直して、内容をご確認ください。',
  /** 同意しない人への案内 (Web は「同意しない」の後の画面、アプリは確認の Alert に出す) */
  declineUnavailable: '利用規約・プライバシーポリシーに同意いただけない場合、ほめゴハンはご利用いただけません。',
  /** 同意の記録に失敗したとき (409 以外) */
  acceptFailed: '同意の記録に失敗しました。時間をおいて、もう一度お試しください。',
} as const;

/** チェックボックスの文。documentLabel は LEGAL_DOCUMENT_LABELS の値 */
export function legalConsentAgreeLabel(documentLabel: string): string {
  return `${documentLabel}の内容を確認し、同意します`;
}

/** 全文へのリンクの文 */
export function legalConsentReadFullTextLabel(documentLabel: string): string {
  return `${documentLabel}の全文を読む`;
}

/** 版と施行日の 1 行。effectiveDateLabel は formatLegalEffectiveDate の結果 */
export function legalConsentVersionLine(version: string, effectiveDateLabel: string): string {
  return `版: ${version} ／ 施行日: ${effectiveDateLabel}`;
}
