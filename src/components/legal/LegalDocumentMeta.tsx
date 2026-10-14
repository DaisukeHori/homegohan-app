import { LEGAL_DOCUMENTS, formatLegalEffectiveDate, type LegalDocumentType } from '@homegohan/shared';

/**
 * 利用規約・プライバシーポリシーのページの先頭に出す「版・施行日」 (#1174)。
 *
 * 値は packages/shared の LEGAL_DOCUMENTS から取る。同意の記録 (どの版に同意したか) と、
 * 画面に出す版・施行日を同じ定数に揃えるため、ページに日付を直接書かない。
 * 規約を改定するときは、LEGAL_DOCUMENTS の version と effectiveDate を書き換える
 * (利用者に再同意を求める仕組みも、その版の食い違いで動く)。
 */
export function LegalDocumentMeta({ type }: { type: LegalDocumentType }) {
  const { version, effectiveDate } = LEGAL_DOCUMENTS[type];
  return (
    <p className="text-sm text-gray-500 mb-8" data-testid="legal-document-meta">
      版: {version} ／ 施行日: {formatLegalEffectiveDate(effectiveDate)}
    </p>
  );
}
