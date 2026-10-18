// リンクにボタンの見た目を当てる (docs/design/marketing/01-landing-site.md §8.3 の CtaLink)。
// next/link の a 1 つ。中に button を置かない (a の中に button は無効な入れ子)。
// 文字と下地は §5.1 の組: primary = 白 on --lp-ink / secondary = --lp-ink on --lp-surface + 縁 / on-dark = --lp-dark on --lp-accent-soft。
import Link from 'next/link';
import type { ReactNode } from 'react';

type CtaLinkProps = {
  href: string;
  variant: 'primary' | 'secondary' | 'on-dark';
  size?: 'regular' | 'compact';
  className?: string;
  children: ReactNode;
};

export function CtaLink({ href, variant, size = 'regular', className, children }: CtaLinkProps) {
  const classes = ['lp-cta', `lp-cta--${variant}`, size === 'compact' ? 'lp-cta--compact' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <Link href={href} className={classes}>
      {children}
    </Link>
  );
}
