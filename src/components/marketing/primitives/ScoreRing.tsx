'use client';

// スコアの輪 (M-11。docs/design/marketing/01-landing-site.md §6.2・§8.2・§8.3 の ScoreRing・§13.3 の数字の増え方の表)。島。章 nutrition が置く。
// 状態: server (サーバーの HTML: 輪は SVG の属性の最後の形・数字は value) → マウント: armed (根に data-js。見える数字は、動きを減らす設定で
// なければ 0・そうなら value) → 根が画面に入る (useInViewOnce。根に data-in): 動きを減らす設定でなければ counting (countUpValue で
// 0 → value を RING_DRAW_MS かけて増やす) → final。動きを減らす設定なら final (value)。一度 final になれば変わらない。
// 輪は SVG の circle 2 本 (下地と値。pathLength = max)。値の circle の stroke-dashoffset は HTML の属性で max − value (最後の形)。
// 隠す (stroke-dashoffset: max) のは CSS の no-preference の中で、根が [data-js]:not([data-in]) の間だけ (隠すときは遷移なし)。
// 読み上げは最後の値だけ: 増えている間の数字は aria-hidden の span に描き、最後の値を持つ span (視覚的に隠す) を同時に置く。SVG は aria-hidden。
import { useEffect, useState } from 'react';
import { countUpValue } from '../count-up';
import { RING_DRAW_MS } from '../landing-copy';
import { useInViewOnce } from './useInViewOnce';
import { useReducedMotion } from './useReducedMotion';

/** 数字が増え始める前の値 (§13.3: armed の見える数字は 0) */
const COUNT_UP_START = 0;
/** SVG の座標の大きさ (viewBox の一辺)。輪の半径は線の太さの半分を引いた値 */
const RING_VIEWBOX = 120;
const RING_STROKE = 10;
const RING_CENTER = RING_VIEWBOX / 2;
const RING_RADIUS = RING_CENTER - RING_STROKE / 2;

type ScoreRingProps = {
  value: number;
  max: number;
  label: string;
  note: string;
};

export function ScoreRing({ value, max, label, note }: ScoreRingProps) {
  const reduced = useReducedMotion();
  const { ref, inView } = useInViewOnce<HTMLDivElement>();
  const [mounted, setMounted] = useState(false);
  /** counting の間の数字 (画面に入ってから増やす) */
  const [counted, setCounted] = useState(COUNT_UP_START);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 画面に入った (動きを減らす設定でない): 0 から RING_DRAW_MS かけて増やす (rAF。アンマウントで止める)
  useEffect(() => {
    if (!mounted || !inView || reduced) return;
    let frame = 0;
    const start = window.performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      setCounted(countUpValue(value, elapsed, RING_DRAW_MS));
      if (elapsed < RING_DRAW_MS) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [mounted, inView, reduced, value]);

  // 見える数字 (§13.3): server は value・armed は 0 (動きを減らす設定なら value)・counting は増えている値・final は value
  let shown = value;
  if (mounted && !reduced) shown = inView ? counted : COUNT_UP_START;

  return (
    <div ref={ref} className="lp-ring" data-js={mounted ? '1' : undefined} data-in={mounted && inView ? '1' : undefined}>
      <div className="lp-ring-dial">
        <svg className="lp-ring-svg" viewBox={`0 0 ${RING_VIEWBOX} ${RING_VIEWBOX}`} aria-hidden="true" focusable="false">
          <circle className="lp-ring-track" cx={RING_CENTER} cy={RING_CENTER} r={RING_RADIUS} pathLength={max} />
          <circle
            className="lp-ring-value"
            cx={RING_CENTER}
            cy={RING_CENTER}
            r={RING_RADIUS}
            pathLength={max}
            strokeDasharray={max}
            strokeDashoffset={max - value}
          />
        </svg>
        <p className="lp-ring-number">
          <span aria-hidden="true">{shown}</span>
          <span className="lp-sr-only">{value}</span>
        </p>
      </div>
      <p className="lp-ring-label">{label}</p>
      <p className="lp-note lp-ring-note">{note}</p>
    </div>
  );
}
