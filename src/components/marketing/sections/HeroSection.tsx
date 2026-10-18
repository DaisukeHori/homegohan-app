// ヒーロー (docs/design/marketing/01-landing-site.md §4.3・§5.4 の扇の形・§8.3 の HeroSection・M-2・M-3)。Server Component。
// 文字の列 (eyebrow・h1・一文・CTA 2 つ・安心の 3 点・スクロールの手がかり) と、実際の画面 5 枚の扇。
// 扇は動かない構成で、立ち上がりは読み込みのとき 1 回だけ (文字は M-2、画面の塊は M-3)。
// HTML の順 (読み上げの順) は hero.screens の順 = 左の後ろ (camera) → 右の後ろ (analyze) → 前の中央 (comment) → 遠くの左 (menu-result) → 遠くの右 (badge-collection)。
// 重なりの前後は置き方のクラスが z-index で持つ (前 5・左右 4・遠く 3)。前の 1 枚 (comment.png) だけ preload (LCP の候補)。
// 640 px 未満は遠くの 2 枚を display: none (3 枚の扇)。画面は画像だけでフォーカスしない。
import { Check, ChevronDown } from 'lucide-react';
import Image from 'next/image';
import type { CSSProperties } from 'react';
import { LANDING_COPY, LANDING_IMAGE_SIZES } from '../landing-copy';
import { CtaLink } from '../primitives/CtaLink';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';

/** 扇の 5 枚の置き方 (hero.screens の順)。sizes は置き場所ごとの表示の幅 (§5.4 の表) */
const FAN_PLACEMENTS = [
  { className: 'lp-fan-phone--back-left', sizes: LANDING_IMAGE_SIZES.heroBack },
  { className: 'lp-fan-phone--back-right', sizes: LANDING_IMAGE_SIZES.heroBack },
  { className: 'lp-fan-phone--front', sizes: LANDING_IMAGE_SIZES.heroFront },
  { className: 'lp-fan-phone--far-left', sizes: LANDING_IMAGE_SIZES.heroFar },
  { className: 'lp-fan-phone--far-right', sizes: LANDING_IMAGE_SIZES.heroFar },
] as const;
/** 前の中央の 1 枚の位置 (hero.screens の添字)。この 1 枚だけ preload する */
const FRONT_SCREEN_INDEX = 2;
/**
 * 文字の列の立ち上がりの順番 (M-2: eyebrow → h1 → 一文 → CTA → 安心 → 手がかり。n 番目 (0〜5) を n × --lp-hero-step 遅らせる)
 */
const RISE_ORDER = { eyebrow: 0, title: 1, lead: 2, ctas: 3, assurances: 4, cue: 5 } as const;
/** 画面の塊の立ち上がりの順番 (M-3。h1 と同じ 1 × --lp-hero-step だけ遅らせる) */
const MEDIA_RISE_ORDER = RISE_ORDER.title;

/** ヒーローの文字の立ち上がりの順番 (M-2。n 番目 × --lp-hero-step だけ遅らせる) */
function riseStyle(order: number): CSSProperties {
  return { '--lp-i': order } as CSSProperties;
}

export function HeroSection() {
  const hero = LANDING_COPY.hero;
  return (
    <section id="hero" aria-labelledby="hero-title" tabIndex={-1} className="lp-hero">
      <div className="lp-container lp-hero-grid">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow lp-hero-eyebrow lp-hero-rise" style={riseStyle(RISE_ORDER.eyebrow)}>
            {hero.eyebrow}
          </p>
          <h1 id="hero-title" className="lp-hero-rise" style={riseStyle(RISE_ORDER.title)}>
            {hero.headlineLines[0]}
            <br />
            <span className="lp-headline-accent">{hero.headlineLines[1]}</span>
          </h1>
          <p className="lp-lead lp-hero-lead lp-hero-rise" style={riseStyle(RISE_ORDER.lead)}>
            {hero.lead}
          </p>
          <div className="lp-hero-ctas lp-hero-rise" style={riseStyle(RISE_ORDER.ctas)}>
            <CtaLink href={hero.primaryCta.href} variant="primary">
              {hero.primaryCta.label}
            </CtaLink>
            <CtaLink href={hero.secondaryCta.href} variant="secondary">
              {hero.secondaryCta.label}
            </CtaLink>
          </div>
          <ul className="lp-assurances lp-hero-rise" style={riseStyle(RISE_ORDER.assurances)}>
            {hero.assurances.map((text) => (
              <li key={text}>
                <Check className="lp-check" strokeWidth={2.5} aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>
          <p className="lp-scroll-cue lp-hero-rise" style={riseStyle(RISE_ORDER.cue)}>
            {hero.scrollCue}
            <ChevronDown className="lp-scroll-cue-icon" aria-hidden="true" />
          </p>
        </div>
        {/* 画面の塊 (M-3)。立ち上がりはこの外側の箱に付け、中の端末の位置と傾きは動かさない。
            位置だけ動かし不透明度は動かさない (前の 1 枚は LCP の候補で、不透明度 0 で最初に描くと Chromium は LCP に数えない) */}
        <div className="lp-hero-media lp-hero-media-rise" style={riseStyle(MEDIA_RISE_ORDER)}>
          <div className="lp-fan">
            {hero.screens.map((screen, index) => {
              const placement = FAN_PLACEMENTS[index];
              const isFront = index === FRONT_SCREEN_INDEX;
              return (
                <PhoneFrame key={screen.src} className={`lp-fan-phone ${placement.className}`}>
                  <Image
                    src={screen.src}
                    alt={screen.alt}
                    width={GUIDE_SCREEN_WIDTH_PX}
                    height={GUIDE_SCREEN_HEIGHT_PX}
                    sizes={placement.sizes}
                    preload={isFront}
                  />
                </PhoneFrame>
              );
            })}
          </div>
          <p className="lp-caption">{hero.screensCaption}</p>
        </div>
      </div>
    </section>
  );
}
