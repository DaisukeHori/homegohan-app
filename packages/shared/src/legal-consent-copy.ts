/**
 * 利用規約・プライバシーポリシーの同意画面の文面 (#1174 の Web の同意画面 src/app/legal-consent/LegalConsentForm.tsx が使う)。
 * アプリは Web の同意画面を WebView で開く (#1442・設計書 13b) ので、この文面を直接は使わない。文面を 2 か所に持たない。
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
   * Web のボタンの文 (declineAndSignOutButton) の先頭部分 (テストが /同意しない/ の部分一致で探すため。T-C2 が固定)。
   * アプリは Web の同意画面を WebView で開く (13b) ので、アプリがこの値を直接使うことは無い。
   */
  declineButton: '同意しない',
  /** Web の「同意しない」のボタン (押すとすぐログアウトする)。#1174 の LegalConsentForm.tsx:234 の文そのまま。全角の括弧 */
  declineAndSignOutButton: '同意しない（ログアウトする）',
  /** 同意を送ったら版が変わっていた (409) ときの案内 (POST /api/legal/accept の 409 の本文と同じ文) */
  versionMismatch: '利用規約・プライバシーポリシーが更新されました。画面を読み込み直して、内容をご確認ください。',
  /** 同意しない人への案内 (Web の「同意しない」の後の画面。アプリも WebView で同じ画面を開く) */
  declineUnavailable: '利用規約・プライバシーポリシーに同意いただけない場合、ほめゴハンはご利用いただけません。',
  /** 同意の記録に失敗したとき (409 以外) */
  acceptFailed: '同意の記録に失敗しました。時間をおいて、もう一度お試しください。',
  /**
   * 同意の前でも退会と書き出しができること (#1901 cross/20 Q-23)。同意画面のフォームの下と、未成年の案内の画面に出す。
   * 退会と書き出しの API (/api/account/delete・/api/account/export) は同意の許可リスト (LEGAL_CONSENT_EXEMPT_API_PATHS) にあり、
   * 画面 (/legal-consent/account) は同意ゲートの対象外 (同意画面の下のパス)
   */
  accountEntryLead: '規約に同意しなくても、ご自身のデータの書き出しと、退会（アカウントの削除）はできます。',
  /** 同意の前の退会と書き出しの画面 (/legal-consent/account) へのリンクの文 */
  accountEntryLink: '退会・データの書き出しの画面へ',
  /** 「同意しない」の後 (ログアウトした後) の案内。もう一度ログインすれば、同意しなくても退会と書き出しの画面へ進める */
  declinedAccountGuide:
    '退会やデータの書き出しをご希望の場合は、もう一度ログインしてください。規約に同意しなくても、退会とデータの書き出しの画面から行えます。',
  /** 同じ案内のリンクの文 (ログインの画面へ。ログインの後は退会と書き出しの画面へ戻る) */
  declinedAccountLink: 'ログインして、退会・データの書き出しの画面へ',
  /** 同意の前の退会と書き出しの画面 (/legal-consent/account) の見出しと導入 */
  accountPageHeading: '退会とデータの書き出し',
  accountPageIntro:
    '利用規約・プライバシーポリシーに同意していなくても、ご自身のデータの書き出しと、退会（アカウントの削除）はできます。',
  /**
   * 同じ画面で、退会できなかった (組織のオーナー・家族の代表者。409) ときにサーバーの文に続けて出す案内。
   * 同意の前は譲渡の API (/api/family/*・/api/org/*) が同意ゲートで止まる。解散の API (/api/family/dissolve・/api/org/dissolve) は
   * 同意の許可リストにあり、この画面の 409 の分岐からその場で解散できる (#1917。docs/design/family/11-self-dissolve.md §15.4)
   */
  accountDeleteBlockedGuidance:
    '規約に同意する前は、オーナー・代表者の譲渡の操作ができません。下の「解散する」で家族グループ・組織を解散すると、退会できます。規約に同意したうえで譲渡することもできます。',
  /** 同じ画面で、退会できたあと (ログアウト済み) に出す見出しと文 */
  accountDeletedHeading: '退会しました',
  accountDeletedBody: 'アカウントと、アカウントに紐づくデータを削除し、ログアウトしました。ご利用ありがとうございました。',
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
