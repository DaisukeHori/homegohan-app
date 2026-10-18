// フッター (docs/design/marketing/01-landing-site.md §4.20・§8.3 の SiteFooter)。Server Component。
// リンクの名前は §4.20 のまま (tests/e2e/public-policy-pages.spec.ts が footer の中の 利用規約 / プライバシーポリシー を exact で押す)。
// 年は定数 (COPYRIGHT_YEAR)。日付の計算はしない。SNS のリンクは置かない (socialLinks は空)。
import Image from 'next/image';
import Link from 'next/link';
import { COPYRIGHT_YEAR, LANDING_COPY, LANDING_SITE_NAME } from '../landing-copy';

/** ヘッダーとフッターのマーク (public/icon.svg) の一辺 (px) */
const BRAND_MARK_PX = 32;

export function SiteFooter() {
  const footer = LANDING_COPY.footer;
  return (
    <footer className="lp-footer">
      <div className="lp-container">
        <div className="lp-footer-grid">
          <div>
            <Link href="/" className="lp-brand">
              <Image src="/icon.svg" alt="" width={BRAND_MARK_PX} height={BRAND_MARK_PX} className="lp-brand-mark" />
              <span>{LANDING_SITE_NAME}</span>
            </Link>
            <p className="lp-note lp-footer-tagline">{footer.tagline}</p>
          </div>
          {footer.columns.map((column) => (
            <div key={column.title}>
              <h3>{column.title}</h3>
              <ul>
                {column.links.map((link) => (
                  <li key={link.href + link.label}>
                    <Link href={link.href}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="lp-footer-bottom">
          © {COPYRIGHT_YEAR} {LANDING_SITE_NAME}
        </div>
      </div>
    </footer>
  );
}
