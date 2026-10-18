// 使い方 (docs/design/marketing/01-landing-site.md §8.3 の HowItWorksSection)。Server Component。
// 動かない 3 つの手順 (768 px 以上は 3 列・未満は 1 列)。各手順に実際の画面を 1 枚ずつ。固定・切り替え・スクロールで変わる見た目は持たない。
import Image from 'next/image';
import { LANDING_COPY, LANDING_IMAGE_SIZES } from '../landing-copy';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';
import { Reveal } from '../primitives/Reveal';

export function HowItWorksSection() {
  const how = LANDING_COPY.how;
  return (
    <section id="how" aria-labelledby="how-title" className="lp-section">
      <div className="lp-container">
        <Reveal index={0} className="lp-section-head">
          <h2 id="how-title">{how.title}</h2>
          <p className="lp-lead">{how.lead}</p>
        </Reveal>
        <ol className="lp-steps">
          {how.steps.map((step, index) => (
            <Reveal key={step.title} as="li" index={index}>
              <PhoneFrame>
                <Image
                  src={step.image.src}
                  alt={step.image.alt}
                  width={GUIDE_SCREEN_WIDTH_PX}
                  height={GUIDE_SCREEN_HEIGHT_PX}
                  sizes={LANDING_IMAGE_SIZES.step}
                />
              </PhoneFrame>
              <div className="lp-step-text">
                <span className="lp-step-num" aria-hidden="true">
                  {index + 1}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </div>
            </Reveal>
          ))}
        </ol>
        <p className="lp-note lp-caption">{how.screensCaption}</p>
      </div>
    </section>
  );
}
