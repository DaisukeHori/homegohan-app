'use client';

// 画面に入ったかを 1 回だけ知らせる hook (docs/design/marketing/01-landing-site.md §6.3・§8.3 の useInViewOnce)。
// IntersectionObserver を threshold 0 (1 px でも交差したら通知) で作り、どこまで入ったら現すかは rootMargin (REVEAL_ROOT_MARGIN) で決める。
// 要素の何割が見えたか (threshold の割合) では決めない: 割合は「画面の高さ ÷ 要素の高さ」を超えないので、画面より高い要素が隠れたままになる。
// だから引数を取らない。IntersectionObserver が無い環境では true を返す。
import { useEffect, useRef, useState, type RefObject } from 'react';
import { REVEAL_ROOT_MARGIN } from '../landing-copy';

/** 1 px でも交差したら通知する (割合にしない理由は上のコメント) */
const ANY_INTERSECTION = 0;

export function useInViewOnce<T extends Element>(): { ref: RefObject<T | null>; inView: boolean } {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: ANY_INTERSECTION, rootMargin: REVEAL_ROOT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, inView };
}
