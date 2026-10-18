// 機能の一覧 (docs/design/marketing/01-landing-site.md §4.6・§5.4・§8.3 の FeaturesSection・M-9・M-16)。Server Component。
// 10 枚のカード (features.cards の順)。各カードは next/link の Link (href は各章の id。#photo ほか) で全体が押せる (ページの中のリンク: §2.2)。
// 1024 px 以上は 12 列 (大 = 6 列ぶん ×2・中 = 4 列ぶん ×6・小 = 6 列ぶん ×2)・768〜1023 px は 2 列・768 px 未満は 1 列。
// 画像のあるカードは、端末の枠に入れた実際の画面がカードの下の端から覗く (箱の上から 1.5rem 下げて中央。下の端で切れる)。
// 画像の無いカードはアイコン。アイコンは aria-hidden。カードは 1 枚ずつ Reveal で包む (§6.5)。
import {
  ArrowUpRight,
  Camera,
  ChefHat,
  MessageCircle,
  MessageCircleHeart,
  Refrigerator,
  Scale,
  ShoppingCart,
  TrendingUp,
  Trophy,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { LANDING_COPY, LANDING_IMAGE_SIZES, type FeatureCardId } from '../landing-copy';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';
import { Reveal } from '../primitives/Reveal';

/** カードごとのアイコン (§5.5) */
const FEATURE_ICONS: Record<FeatureCardId, LucideIcon> = {
  photo: Camera,
  praise: MessageCircleHeart,
  menu: ChefHat,
  shopping: ShoppingCart,
  pantry: Refrigerator,
  nutrition: TrendingUp,
  health: Scale,
  badges: Trophy,
  chat: MessageCircle,
  family: Users,
};

/** カードの見出しと本文の id (Link の aria-labelledby が指す) */
function featureTextId(id: FeatureCardId, part: 'title' | 'body'): string {
  return `feature-${id}-${part}`;
}

export function FeaturesSection() {
  const features = LANDING_COPY.features;
  return (
    <section id="features" aria-labelledby="features-title" tabIndex={-1} className="lp-section lp-features">
      <div className="lp-container">
        <Reveal index={0} className="lp-section-head">
          <h2 id="features-title">{features.title}</h2>
          <p className="lp-lead">{features.lead}</p>
        </Reveal>
        <ul className="lp-bento">
          {features.cards.map((card, index) => {
            const Icon = FEATURE_ICONS[card.id];
            return (
              <Reveal key={card.id} as="li" index={index} className={`lp-feature is-${card.size}`}>
                {/* Link (a) の中身はカードの全体 (a は親の li に合わせて div・h3・p を持てる)。
                    アクセシブルな名前は見出しと本文 (§8.3)。画面の画像の alt は名前に混ぜない (aria-labelledby で見出しと本文を指す) */}
                <Link href={card.href} className="lp-feature-link" aria-labelledby={`${featureTextId(card.id, 'title')} ${featureTextId(card.id, 'body')}`}>
                  {card.image ? (
                    <div className="lp-feature-media">
                      <PhoneFrame className="lp-feature-phone">
                        <Image
                          src={card.image.src}
                          alt={card.image.alt}
                          width={GUIDE_SCREEN_WIDTH_PX}
                          height={GUIDE_SCREEN_HEIGHT_PX}
                          sizes={LANDING_IMAGE_SIZES.feature}
                        />
                      </PhoneFrame>
                    </div>
                  ) : null}
                  <div className="lp-feature-text">
                    <div className="lp-feature-head">
                      <span className="lp-icon" aria-hidden="true">
                        <Icon />
                      </span>
                      <h3 id={featureTextId(card.id, 'title')}>{card.title}</h3>
                    </div>
                    <p id={featureTextId(card.id, 'body')} className="lp-feature-body">
                      {card.body}
                    </p>
                  </div>
                  <ArrowUpRight className="lp-feature-arrow" aria-hidden="true" />
                </Link>
              </Reveal>
            );
          })}
        </ul>
        <p className="lp-caption">{features.screensCaption}</p>
      </div>
    </section>
  );
}
