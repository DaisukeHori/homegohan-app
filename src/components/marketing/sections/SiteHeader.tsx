'use client';

// ヘッダー (docs/design/marketing/01-landing-site.md §8.3 の SiteHeader・M-1・M-4・M-14・§13.3 のヘッダーの表)。島。上に固定 (position: sticky は marketing.css)。
// - scrolled (M-1): scroll は passive + requestAnimationFrame で間引き、アンマウントで外す。マウントの直後に 1 回だけ今の位置を読む。
// - currentSection (M-14): useInViewIds で main の 18 の区切りを NAV_CURRENT_ROOT_MARGIN の帯で見て、帯にある区切りのうち最も下のものにする
//   (帯に何も無ければ直前のまま)。その区切りが属するナビの項目 (SECTION_NAV_KEY) に aria-current="location" と下線。
// - ページの中のリンク (ナビ 5 つ) は next/link の Link (戻る・進むを Next が描き直す: §2.2)。先の区切りへのフォーカスは useInPageLinkFocus。
// - 下端に読む位置の棒 (ReadingProgress。M-4)。
// - 「無料で始める」は幅で隠さない (登録の導線をどこまでスクロールしても画面の上に置く: §3.2)。
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  HEADER_SCROLLED_PX,
  LANDING_COPY,
  LANDING_SITE_NAME,
  NAV_CURRENT_ROOT_MARGIN,
  SECTION_IDS,
  SECTION_NAV_KEY,
  type SectionId,
} from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { ReadingProgress } from '../primitives/ReadingProgress';
import { useInPageLinkFocus } from '../primitives/useInPageLinkFocus';
import { useInViewIds } from '../primitives/useInViewSteps';

/** ヘッダーとフッターのマーク (public/icon.svg) の一辺 (px) */
const BRAND_MARK_PX = 32;
/** 交差している区切りが無いことを表す lastIndexOf の戻り値 */
const NOT_FOUND = -1;

export function SiteHeader() {
  const { nav, login, cta } = LANDING_COPY.header;
  const [scrolled, setScrolled] = useState(false);
  const [currentSection, setCurrentSection] = useState<SectionId | null>(null);
  const intersecting = useInViewIds(SECTION_IDS, NAV_CURRENT_ROOT_MARGIN);
  useInPageLinkFocus();

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setScrolled(window.scrollY > HEADER_SCROLLED_PX);
    };
    // マウント直後に 1 回だけ今のスクロール量を読む
    update();
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  // 帯にある区切りのうち最も下 (index が最大) のもの。無ければ直前の値のまま (§13.3 のヘッダーの強調の表)
  useEffect(() => {
    const index = intersecting.lastIndexOf(true);
    if (index !== NOT_FOUND) setCurrentSection(SECTION_IDS[index]);
  }, [intersecting]);

  const currentNavKey = currentSection === null ? null : SECTION_NAV_KEY[currentSection];

  return (
    <header className={scrolled ? 'lp-header is-scrolled' : 'lp-header'}>
      <div className="lp-container lp-header-inner">
        <Link href="/" className="lp-brand">
          <Image src="/icon.svg" alt="" width={BRAND_MARK_PX} height={BRAND_MARK_PX} className="lp-brand-mark" />
          <span>{LANDING_SITE_NAME}</span>
        </Link>
        <nav className="lp-nav" aria-label="サイトの案内">
          <ul>
            {nav.map((item) => (
              <li key={item.key}>
                <Link href={item.href} className="lp-nav-link" aria-current={currentNavKey === item.key ? 'location' : undefined}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="lp-header-right">
          <Link href={login.href} className="lp-login">
            {login.label}
          </Link>
          <CtaLink href={cta.href} variant="primary" size="compact">
            {cta.label}
          </CtaLink>
        </div>
      </div>
      <ReadingProgress />
    </header>
  );
}
