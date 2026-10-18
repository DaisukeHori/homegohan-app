'use client';

// 現れ方 (M-5。docs/design/marketing/01-landing-site.md §6.3・§6.5・§8.3 の Reveal)。
// サーバーの HTML では隠さない (JS が無くても見える)。マウントの後に「JS が動いた」の印 (data-js) を付け、
// 画面に入ったら「入った」の印 (is-in) を付ける。隠す規則と遷移は marketing.css の no-preference の中にだけあるので、
// 動きを減らす設定 (reduce)・JS 無し・IntersectionObserver が無い環境では、隠れない。
import { useEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { REVEAL_STAGGER_MAX, REVEAL_STAGGER_MS } from '../landing-copy';
import { useInViewOnce } from './useInViewOnce';

type RevealProps = {
  children: ReactNode;
  /** 列の中の何番目か。遅れ = min(index, REVEAL_STAGGER_MAX) × REVEAL_STAGGER_MS */
  index?: number;
  className?: string;
  as?: 'div' | 'li';
};

export function Reveal({ children, index = 0, className, as = 'div' }: RevealProps) {
  const { ref, inView } = useInViewOnce<HTMLElement>();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const delayMs = Math.min(index, REVEAL_STAGGER_MAX) * REVEAL_STAGGER_MS;
  const style = { '--lp-reveal-delay': `${delayMs}ms` } as CSSProperties;
  const classes = ['lp-reveal', inView ? 'is-in' : '', className ?? ''].filter(Boolean).join(' ');
  const jsMark = mounted ? '1' : undefined;

  if (as === 'li') {
    return (
      <li ref={ref as RefObject<HTMLLIElement | null>} className={classes} style={style} data-js={jsMark}>
        {children}
      </li>
    );
  }
  return (
    <div ref={ref as RefObject<HTMLDivElement | null>} className={classes} style={style} data-js={jsMark}>
      {children}
    </div>
  );
}
