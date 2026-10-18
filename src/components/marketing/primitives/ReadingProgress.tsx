'use client';

// 読む位置の棒 (M-4。docs/design/marketing/01-landing-site.md §6.2・§8.3 の ReadingProgress・§13.3 の読む位置の棒の表)。島。SiteHeader が下端に置く。
// 進み p = scrollY ÷ (ページの高さ − 画面の高さ) を 0〜1 に収め、棒の transform: scaleX(p) を書く (scroll は passive + rAF で間引く・resize でも)。
// 動きの宣言は持たない (位置そのもの。スクロールバーと同じ種類の表示)。毎フレームの再描画を React に頼らず、棒の style を直接書く (§10.2)。
// JS が無いときは棒は 0 のまま (CSS の既定)。読み上げの対象にしない (aria-hidden)。
import { useEffect, useRef } from 'react';

/** 進みの下限と上限 */
const PROGRESS_MIN = 0;
const PROGRESS_MAX = 1;

/** ページの進み (0〜1)。スクロールできる量が 0 以下 (短いページ) なら読み終えたとみなして 1 */
function readingProgress(): number {
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  if (scrollable <= 0) return PROGRESS_MAX;
  return Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, window.scrollY / scrollable));
}

export function ReadingProgress() {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const bar = barRef.current;
      if (bar) bar.style.transform = `scaleX(${readingProgress()})`;
    };
    // マウントの直後に今の位置を 1 回書く
    update();
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return <div ref={barRef} className="lp-progress" aria-hidden="true" />;
}
