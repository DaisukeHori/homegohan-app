'use client';

// デモ (docs/design/marketing/01-landing-site.md §4.5・§8.3 の DemoSection・M-7・§13.3 のデモの表と数字の増え方の表)。島。
// framer-motion はこのファイルだけが読む (LazyMotion + m + AnimatePresence。出入りだけ)。
// AI は呼ばない。スコアは demoScore、記録コメントは demoPraiseComment が、見本の推定の値と料理の名前から作る (アプリと同じ式・同じ定型の文)。
// 写真のボタンは分析中も disabled にしない (aria-disabled だけ)。disabled にすると Chromium と WebKit がフォーカスを body に戻し、
// リングと読み上げの位置が消えるため。押したときの処理の先頭と demoReducer が、分析中の再選択を無視する。
// 結果のスコアの数字は、動きを減らす設定でなければ countUpValue で 0 から COUNT_UP_MS かけて増やして止める (rAF)。
// 増えている間の数字は aria-hidden の span に描き、読み上げは role="status" の箱の中の、最後の値を持つ (視覚的に隠した) span だけにする。
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, m } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import { countUpValue } from '../count-up';
import { DEMO_INITIAL_STATE, demoReducer, selectedSampleId, type DemoSampleKey } from '../demo-state';
import {
  COUNT_UP_MS,
  DEMO_ANALYZING_MS,
  DEMO_ANALYZING_MS_REDUCED,
  DEMO_MOTION_DURATION_S,
  DEMO_MOTION_EASE,
  DEMO_NUTRITION_KEYS,
  DEMO_RESULT_OFFSET_PX,
  LANDING_COPY,
  LANDING_IMAGE_SIZES,
  demoPraiseComment,
  demoScore,
} from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { Reveal } from '../primitives/Reveal';
import { useReducedMotion } from '../primitives/useReducedMotion';

/** 見本の写真の一辺 (px)。public/marketing/photos/*.webp は 800×800 (docs/design/marketing/01-landing-site.md §7.2) */
const DEMO_PHOTO_PX = 800;
/** framer-motion が受ける緩急 (landing-copy.ts の DEMO_MOTION_EASE は readonly なので、可変の組に写す) */
const MOTION_EASE: [number, number, number, number] = [DEMO_MOTION_EASE[0], DEMO_MOTION_EASE[1], DEMO_MOTION_EASE[2], DEMO_MOTION_EASE[3]];
/** 数字が増え始める前の値 (§13.3: result に入ったら 0 から) */
const COUNT_UP_START = 0;

/**
 * 結果のスコアの見える数字 (§13.3 の数字の増え方の表の DemoSection の行)。
 * 結果が無い間は null (描かない)。result に入ったら、動きを減らす設定なら最初から target、そうでなければ 0 から rAF で増やして target で止める。
 * 別の写真を押す (結果が無くなる)・アンマウントで rAF を止め、次に result に入ったらまた 0 から
 */
function useCountUpScore(target: number | null, reduced: boolean): number | null {
  /** counting の間の数字 (結果が無い間は null に戻す) */
  const [counted, setCounted] = useState<number | null>(null);
  useEffect(() => {
    if (target === null) {
      setCounted(null);
      return;
    }
    if (reduced) return;
    let frame = 0;
    const start = window.performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      setCounted(countUpValue(target, elapsed, COUNT_UP_MS));
      if (elapsed < COUNT_UP_MS) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, reduced]);
  if (target === null) return null;
  if (reduced) return target;
  return counted ?? COUNT_UP_START;
}

export function DemoSection() {
  const demo = LANDING_COPY.demo;
  const reduced = useReducedMotion();
  const [state, dispatch] = useReducer(demoReducer, DEMO_INITIAL_STATE);
  const timerRef = useRef<number | null>(null);

  // アンマウントでタイマーを消す
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const analyzing = state.phase === 'analyzing';
  const selectedId = selectedSampleId(state);

  const pick = (sampleId: DemoSampleKey) => {
    // 分析中の再選択は無視する (ボタンは aria-disabled のまま押せて、フォーカスは押したボタンに残る)
    if (analyzing) return;
    dispatch({ type: 'select', sampleId, now: window.performance.now() });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    // 待ち時間は押したときに読む (描画時に固定しない)。動きを減らす設定のときは待たない
    const waitMs = reduced ? DEMO_ANALYZING_MS_REDUCED : DEMO_ANALYZING_MS;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      dispatch({ type: 'finish', sampleId });
    }, waitMs);
  };

  const panelMotion = {
    initial: reduced ? (false as const) : { opacity: 0, y: DEMO_RESULT_OFFSET_PX },
    animate: { opacity: 1, y: 0 },
    exit: reduced ? undefined : { opacity: 0 },
    transition: { duration: reduced ? 0 : DEMO_MOTION_DURATION_S, ease: MOTION_EASE },
  };

  const result = state.phase === 'result' ? demo.samples.find((sample) => sample.id === state.sampleId) : undefined;
  const score = result ? demoScore(result.nutrition) : null;
  const shownScore = useCountUpScore(score, reduced);
  const progressStyle = { '--lp-demo-ms': `${reduced ? DEMO_ANALYZING_MS_REDUCED : DEMO_ANALYZING_MS}ms` } as CSSProperties;

  return (
    <section id="demo" aria-labelledby="demo-title" tabIndex={-1} className="lp-section lp-band lp-demo">
      <div className="lp-container">
        <Reveal index={0} className="lp-section-head lp-section-head--center">
          <p className="lp-eyebrow">{demo.eyebrow}</p>
          <h2 id="demo-title">{demo.title}</h2>
          <p className="lp-lead">{demo.lead}</p>
        </Reveal>
        <div className="lp-demo-grid">
          <Reveal index={0} className="lp-card lp-demo-picker">
            <h3>{demo.pickerTitle}</h3>
            <div className="lp-picker" role="group" aria-label={demo.pickerTitle}>
              {demo.samples.map((sample) => (
                <button
                  key={sample.id}
                  type="button"
                  className="lp-photo-btn"
                  aria-pressed={selectedId === sample.id}
                  aria-disabled={analyzing}
                  onClick={() => pick(sample.id)}
                >
                  <Image
                    src={sample.photo.src}
                    alt={sample.photo.alt}
                    width={DEMO_PHOTO_PX}
                    height={DEMO_PHOTO_PX}
                    sizes={LANDING_IMAGE_SIZES.demoPhoto}
                  />
                  <span className="lp-photo-name">{sample.name}</span>
                </button>
              ))}
            </div>
            {/* サンプルの注記は選ぶ前から常に出す。結果の箱 (role=status) の外に置き、結果のたびに読み上げ直さない */}
            <p className="lp-note lp-demo-notice">{demo.sampleNotice}</p>
          </Reveal>
          <Reveal index={1} className="lp-card lp-result">
            <MotionConfig reducedMotion="user">
              <LazyMotion features={domAnimation}>
                <div role="status" aria-live="polite" className="lp-result-live">
                  <AnimatePresence mode="wait" initial={false}>
                    {state.phase === 'idle' && (
                      <m.div key="idle" className="lp-result-empty" {...panelMotion}>
                        <span className="lp-result-empty-icon" aria-hidden="true">
                          <Sparkles />
                        </span>
                        <p className="lp-note">{demo.emptyBody}</p>
                      </m.div>
                    )}
                    {state.phase === 'analyzing' && (
                      <m.div key="analyzing" className="lp-result-analyzing" {...panelMotion}>
                        <p className="lp-result-analyzing-title">
                          <span className="lp-spin" aria-hidden="true" />
                          {demo.analyzingTitle}
                        </p>
                        <p className="lp-note">{demo.analyzingBody}</p>
                        <div className="lp-demo-track" aria-hidden="true">
                          <div className="lp-demo-progress" style={progressStyle} />
                        </div>
                      </m.div>
                    )}
                    {result && score !== null && (
                      <m.div key={`result-${result.id}`} className="lp-result-body" {...panelMotion}>
                        <div className="lp-result-score">
                          <strong className="lp-result-score-number">
                            <span aria-hidden="true">{shownScore ?? score}</span>
                            <span className="lp-sr-only">{score}</span>
                          </strong>
                          <span className="lp-result-score-name">{result.name}</span>
                        </div>
                        <p className="lp-note">{demo.scoreNote}</p>
                        <h3>{demo.resultTitle}</h3>
                        <p className="lp-result-comment">{demoPraiseComment(result)}</p>
                        <h3>{demo.nutritionTitle}</h3>
                        <dl className="lp-nutri">
                          {DEMO_NUTRITION_KEYS.map((key, index) => (
                            <div key={key} style={{ '--lp-i': index } as CSSProperties}>
                              <dt>{demo.nutritionLabels[key]}</dt>
                              <dd>
                                {result.nutrition[key]}
                                <small>{demo.nutritionUnits[key]}</small>
                              </dd>
                            </div>
                          ))}
                        </dl>
                        <CtaLink href={demo.cta.href} variant="primary">
                          {demo.cta.label}
                        </CtaLink>
                      </m.div>
                    )}
                  </AnimatePresence>
                </div>
              </LazyMotion>
            </MotionConfig>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
