'use client';

// ヘッダー (docs/design/marketing/01-landing-site.md §8.3 の SiteHeader・M-1)。上に固定 (position: sticky は marketing.css)。
// 状態は scrolled だけ。scroll は passive + requestAnimationFrame で間引き、アンマウントで外す。
// 「無料で始める」は幅で隠さない (登録の導線をどこまでスクロールしても画面の上に置く: §3.2)。
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { HEADER_SCROLLED_PX, LANDING_COPY, LANDING_SITE_NAME } from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';

/** ヘッダーとフッターのマーク (public/icon.svg) の一辺 (px) */
const BRAND_MARK_PX = 32;

export function SiteHeader() {
  const { nav, login, cta } = LANDING_COPY.header;
  const [scrolled, setScrolled] = useState(false);

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
              <li key={item.href}>
                <a href={item.href}>{item.label}</a>
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
    </header>
  );
}
