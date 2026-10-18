// 家族で使う (docs/design/marketing/01-landing-site.md §4.14・§5.7 の共有の範囲の図・§8.3 の FamilySection)。Server Component。地は tint。
// eyebrow・h2・lead・要点 4 つ (ul)・共有の範囲の図 (3 つの札 + 切り替えの形 (aria-hidden。操作できない飾り) + 既定の文)・
// 画面 1 枚 (family.png)・画面の注記・CTA (この DOM の順)。1024 px 以上は 2 列 (文字 7 : 図と画面 5。CTA は文字の列の下に置く)。
// 図の文は読める文字 (HTML)。切り替えの形はオン (--lp-green の下地で丸が右)・オフ (--lp-line の下地で丸が左)・自分で選ぶ (半分)。
import { Check, Mail, UserRound, Users, type LucideIcon } from 'lucide-react';
import Image from 'next/image';
import { LANDING_COPY, LANDING_IMAGE_SIZES } from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';
import { Reveal } from '../primitives/Reveal';

/** 要点のアイコン (points の順。立場・招待・共有の範囲・家族の献立) */
const POINT_ICONS: readonly LucideIcon[] = [Users, Mail, UserRound, Check];

export function FamilySection() {
  const family = LANDING_COPY.family;
  return (
    <section id="family" aria-labelledby="family-title" tabIndex={-1} className="lp-section lp-band lp-family">
      <div className="lp-container lp-split">
        <div className="lp-split-copy">
          <Reveal index={0} className="lp-section-head">
            <p className="lp-eyebrow">{family.eyebrow}</p>
            <h2 id="family-title" className="lp-h2-chapter">
              {family.title}
            </h2>
            <p className="lp-lead">{family.lead}</p>
          </Reveal>
          <ul className="lp-points">
            {family.points.map((point, index) => {
              const Icon = POINT_ICONS[index] ?? Check;
              return (
                <Reveal key={point.title} as="li" index={index} className="lp-point">
                  <span className="lp-point-icon" aria-hidden="true">
                    <Icon strokeWidth={2.25} />
                  </span>
                  <div className="lp-point-text">
                    <h3>{point.title}</h3>
                    <p>{point.body}</p>
                  </div>
                </Reveal>
              );
            })}
          </ul>
        </div>
        <div className="lp-split-media">
          <Reveal index={0} className="lp-share-figure-reveal">
            <ul className="lp-share-figure">
              {family.shareFigure.map((item) => (
                <li key={item.label} className="lp-share-row">
                  <span className="lp-share-label">{item.label}</span>
                  <span className={`lp-toggle lp-toggle--${item.state}`} aria-hidden="true" />
                  <span className="lp-share-note">{item.note}</span>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal index={0} className="lp-shots lp-shots--single">
            <div className="lp-shot">
              <PhoneFrame className="lp-shot-phone">
                <Image
                  src={family.screen.image.src}
                  alt={family.screen.image.alt}
                  width={GUIDE_SCREEN_WIDTH_PX}
                  height={GUIDE_SCREEN_HEIGHT_PX}
                  sizes={LANDING_IMAGE_SIZES.chapter}
                />
              </PhoneFrame>
              <p className="lp-shot-label">{family.screen.label}</p>
            </div>
          </Reveal>
          <p className="lp-caption">{family.screensCaption}</p>
        </div>
        <Reveal index={0} className="lp-split-cta">
          <CtaLink href={family.cta.href} variant="primary">
            {family.cta.label}
          </CtaLink>
        </Reveal>
      </div>
    </section>
  );
}
