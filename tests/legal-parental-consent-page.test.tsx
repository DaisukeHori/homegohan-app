/**
 * 保護者の同意書の公開ページ /legal/parental-consent (#1173 / 設計書 docs/design/cross/14-parental-consent.md §6.5.6 の 11・T-LP1)
 * PARENTAL_CONSENT_DOCUMENT_COPY の全段落と、版・施行日を出す。同意ゲートの対象外であることは tests/legal-consent-gate.test.ts (T-LP2)。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PARENTAL_CONSENT_DOCUMENT,
  PARENTAL_CONSENT_DOCUMENT_COPY,
  formatLegalEffectiveDate,
} from '@homegohan/shared';
import { getSupportEmail } from '@/lib/site-config';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { default: ParentalConsentDocumentPage, metadata } = await import('@/app/legal/parental-consent/page');

describe('/legal/parental-consent (T-LP1)', () => {
  it('同意書の題・全段落・版・施行日・問い合わせ先・プライバシーポリシーへのリンクを出す', () => {
    const html = renderToStaticMarkup(<ParentalConsentDocumentPage />);
    expect(html).toContain(PARENTAL_CONSENT_DOCUMENT_COPY.title);
    expect(PARENTAL_CONSENT_DOCUMENT_COPY.paragraphs.length).toBeGreaterThan(0);
    for (const paragraph of PARENTAL_CONSENT_DOCUMENT_COPY.paragraphs) {
      expect(html).toContain(paragraph);
    }
    expect(html).toContain(PARENTAL_CONSENT_DOCUMENT.version);
    expect(html).toContain(formatLegalEffectiveDate(PARENTAL_CONSENT_DOCUMENT.effectiveDate));
    expect(html).toContain(getSupportEmail());
    expect(html).toContain('href="/privacy"');
  });

  it('metadata.title は 保護者の同意書', () => {
    // #1867: 公開ページの title はサービス名まで付けた absolute で渡す (親の /legal の layout の title が文字列だと、
    // ルートの layout の title.template が配下に効かないため。src/lib/seo/public-pages.ts)
    expect(metadata.title).toEqual({ absolute: '保護者の同意書 | ほめゴハン' });
  });
});
