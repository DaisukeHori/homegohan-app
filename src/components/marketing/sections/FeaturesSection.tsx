// 機能の bento (docs/design/marketing/01-landing-site.md §8.3 の FeaturesSection)。Server Component。
// 1024 px 以上は 12 列 (大 = 6・中 = 3・小 = 6)・768〜1023 px は 2 列・768 px 未満は 1 列。カードは 1 枚ずつ Reveal で包む (§6.5)。
// 画像のあるカードは、端末の枠に入れた実際の画面がカードの下の端から覗く (§5.4)。画像の無いカードはアイコン (§5.5)。
import { Camera, ChefHat, Refrigerator, MessageCircleHeart, Scale, ShoppingCart, Trophy, Users, type LucideIcon } from 'lucide-react';
import Image from 'next/image';
import { LANDING_COPY, LANDING_IMAGE_SIZES, type FeatureCardId } from '../landing-copy';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';
import { Reveal } from '../primitives/Reveal';

/** カードごとのアイコン (§5.5)。描くのは画像の無いカードだけ */
const FEATURE_ICONS: Record<FeatureCardId, LucideIcon> = {
  photo: Camera,
  praise: MessageCircleHeart,
  menu: ChefHat,
  shopping: ShoppingCart,
  health: Scale,
  badges: Trophy,
  fridge: Refrigerator,
  family: Users,
};

export function FeaturesSection() {
  const features = LANDING_COPY.features;
  return (
    <section id="features" aria-labelledby="features-title" className="lp-section">
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
                {card.image ? (
                  <div className="lp-feature-media">
                    <PhoneFrame>
                      <Image
                        src={card.image.src}
                        alt={card.image.alt}
                        width={GUIDE_SCREEN_WIDTH_PX}
                        height={GUIDE_SCREEN_HEIGHT_PX}
                        sizes={LANDING_IMAGE_SIZES.feature}
                      />
                    </PhoneFrame>
                  </div>
                ) : (
                  <div className="lp-icon" aria-hidden="true">
                    <Icon />
                  </div>
                )}
                <div>
                  <h3>{card.title}</h3>
                  <p className="lp-feature-body">{card.body}</p>
                </div>
              </Reveal>
            );
          })}
        </ul>
        <p className="lp-note lp-caption">{features.screensCaption}</p>
      </div>
    </section>
  );
}
