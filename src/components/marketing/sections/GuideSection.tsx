// 使い方ガイド (docs/design/marketing/01-landing-site.md §4.18・§5.4・§8.3 の GuideSection)。Server Component。
// eyebrow・h2・lead・章の一覧 (ol。5 つ。アイコン・名前・手順の数)・要点 3 つ・画面 2 枚 (帯の箱の中の ul。端末と札)・画面の注記・CTA (この DOM の順)。
// 画面の帯の箱は role="region"・aria-label = screenStripLabel(guide.eyebrow) (使い方ガイドの画面)・tabIndex={0} を、どの幅でも持つ (§5.4)。
// 768 px 未満は帯の箱が横にスクロールし、768 px 以上は 2 枚の段違い。1024 px 以上は 2 列 (文字と画面)。
// 章の名前と手順の数は guide-content.ts の GUIDES と同じ (U-29)。アイコンも guide-content.ts と同じ対応 (§5.5)。
import { Camera, Check, ChefHat, Scale, Smartphone, Trophy, type LucideIcon } from 'lucide-react';
import Image from 'next/image';
import type { CSSProperties } from 'react';
import { LANDING_COPY, LANDING_IMAGE_SIZES, screenStripLabel } from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';
import { Reveal } from '../primitives/Reveal';

/** ガイドの章のアイコン (guide.chapters の順。src/app/guide/guide-content.ts の GUIDES[].Icon と同じ) */
const GUIDE_CHAPTER_ICONS: readonly LucideIcon[] = [Smartphone, Camera, ChefHat, Scale, Trophy];
/**
 * 章の手順の数に添える単位。landing-copy.ts の guide.chapters は数 (stepCount) だけを持つので、ここに置く
 * (設計 §4.18 の「(3 手順)」の書き方)
 */
const STEP_COUNT_UNIT = '手順';

export function GuideSection() {
  const guide = LANDING_COPY.guide;
  return (
    <section id="guide" aria-labelledby="guide-title" tabIndex={-1} className="lp-section lp-guide">
      <div className="lp-container lp-split">
        <div className="lp-split-copy">
          <Reveal index={0} className="lp-section-head">
            <p className="lp-eyebrow">{guide.eyebrow}</p>
            <h2 id="guide-title">{guide.title}</h2>
            <p className="lp-lead">{guide.lead}</p>
          </Reveal>
          <Reveal index={0} className="lp-guide-chapters-reveal">
            <ol className="lp-guide-chapters">
              {guide.chapters.map((chapter, index) => {
                const Icon = GUIDE_CHAPTER_ICONS[index] ?? Check;
                return (
                  <li key={chapter.title} className="lp-guide-chapter" style={{ '--lp-i': index } as CSSProperties}>
                    <span className="lp-icon" aria-hidden="true">
                      <Icon />
                    </span>
                    <span className="lp-guide-chapter-name">{chapter.title}</span>
                    <span className="lp-guide-chapter-steps">
                      {chapter.stepCount} {STEP_COUNT_UNIT}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Reveal>
          <ul className="lp-points">
            {guide.points.map((point, index) => (
              <Reveal key={point.title} as="li" index={index} className="lp-point">
                <span className="lp-point-icon" aria-hidden="true">
                  <Check strokeWidth={2.5} />
                </span>
                <div className="lp-point-text">
                  <h3>{point.title}</h3>
                  <p>{point.body}</p>
                </div>
              </Reveal>
            ))}
          </ul>
        </div>
        <div className="lp-split-media">
          <Reveal index={0} className="lp-shots-reveal">
            <div className="lp-strip" role="region" aria-label={screenStripLabel(guide.eyebrow)} tabIndex={0}>
              <ul className={`lp-shots lp-shots--${guide.screens.length}`}>
                {guide.screens.map((screen) => (
                  <li key={screen.image.src} className="lp-shot">
                    <PhoneFrame className="lp-shot-phone">
                      <Image
                        src={screen.image.src}
                        alt={screen.image.alt}
                        width={GUIDE_SCREEN_WIDTH_PX}
                        height={GUIDE_SCREEN_HEIGHT_PX}
                        sizes={LANDING_IMAGE_SIZES.chapter}
                      />
                    </PhoneFrame>
                    <p className="lp-shot-label">{screen.label}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <p className="lp-caption">{guide.screensCaption}</p>
        </div>
        <Reveal index={0} className="lp-split-cta">
          <CtaLink href={guide.cta.href} variant="secondary">
            {guide.cta.label}
          </CtaLink>
        </Reveal>
      </div>
    </section>
  );
}
