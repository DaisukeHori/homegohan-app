// ヒーロー (docs/design/marketing/01-landing-site.md §8.3 の HeroSection・§5.4 の扇の形)。Server Component。
// 実際の画面 3 枚を扇に重ねる (前の中央に褒められる画面、左右の後ろに撮る・見る画面)。動かない構成で、立ち上がりは読み込みのとき 1 回だけ (M-2・M-3)。
// HTML の順 (読み上げの順) は hero.screens の順 = camera → analyze → comment。前の 1 枚 (comment.png) だけ preload (LCP の候補)。
import { Check } from 'lucide-react';
import Image from 'next/image';
import type { CSSProperties } from 'react';
import { LANDING_COPY, LANDING_IMAGE_SIZES } from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';

/** 扇に重ねる 3 枚の位置のクラス (hero.screens の順) */
const SCREEN_POSITION_CLASSES = ['lp-hero-phone--left', 'lp-hero-phone--right', 'lp-hero-phone--front'] as const;
/** 前の中央の 1 枚の位置 (hero.screens の添字)。この 1 枚だけ preload する */
const FRONT_SCREEN_INDEX = 2;

/** ヒーローの文字の立ち上がりの順番 (M-2。n 番目 × --lp-hero-step だけ遅らせる) */
function riseStyle(order: number): CSSProperties {
  return { '--lp-i': order } as CSSProperties;
}

export function HeroSection() {
  const hero = LANDING_COPY.hero;
  return (
    <section id="hero" aria-labelledby="hero-title" className="lp-hero">
      <div className="lp-container lp-hero-grid">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow lp-hero-rise" style={riseStyle(0)}>
            {hero.eyebrow}
          </p>
          <h1 id="hero-title" className="lp-hero-rise" style={riseStyle(1)}>
            {hero.headlineLines[0]}
            <br />
            <span className="lp-headline-accent">{hero.headlineLines[1]}</span>
          </h1>
          <p className="lp-lead lp-hero-rise" style={riseStyle(2)}>
            {hero.lead}
          </p>
          <div className="lp-hero-ctas lp-hero-rise" style={riseStyle(3)}>
            <CtaLink href={hero.primaryCta.href} variant="primary">
              {hero.primaryCta.label}
            </CtaLink>
            <CtaLink href={hero.secondaryCta.href} variant="secondary">
              {hero.secondaryCta.label}
            </CtaLink>
          </div>
          <ul className="lp-assurances lp-hero-rise" style={riseStyle(4)}>
            {hero.assurances.map((text) => (
              <li key={text}>
                <Check className="lp-check" strokeWidth={2.5} aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        {/* 画面の塊 (M-3)。立ち上がりはこの外側の箱に付け、中の端末の rotate を上書きしない。遅れは h1 と同じ (LCP の候補を文字の順の最後に回さない) */}
        <div className="lp-hero-media lp-hero-rise" style={riseStyle(1)}>
          <div className="lp-hero-stack">
            {hero.screens.map((screen, index) => {
              const isFront = index === FRONT_SCREEN_INDEX;
              return (
                <PhoneFrame key={screen.src} className={SCREEN_POSITION_CLASSES[index]}>
                  <Image
                    src={screen.src}
                    alt={screen.alt}
                    width={GUIDE_SCREEN_WIDTH_PX}
                    height={GUIDE_SCREEN_HEIGHT_PX}
                    sizes={isFront ? LANDING_IMAGE_SIZES.heroFront : LANDING_IMAGE_SIZES.heroBack}
                    preload={isFront}
                  />
                </PhoneFrame>
              );
            })}
          </div>
          <p className="lp-note lp-caption">{hero.screensCaption}</p>
        </div>
      </div>
    </section>
  );
}
