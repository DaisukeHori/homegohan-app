// 仕組み (docs/design/marketing/01-landing-site.md §4.4・§8.3 の StorySection・M-6・M-12)。Server Component。
// 見出しの塊と、1024 px 以上で 2 列 (左 7: 手順の ol・右 5: 固定した端末 StoryScroller)。手順の li は id="how-step-<n>" (n = 1〜4) を持ち、
// 中は上から: 手順の中の画面 (1024 px 以上で JS が動いたときは隠す)・番号 (aria-hidden)・h3・本文。
// ol の下に流れの図 (FlowDiagram。Reveal で包み、その is-in が線の描かれ方のきっかけ) と画面の注記。
// 固定した端末の 4 枚は手順の画面と同じファイル (story.steps[].image)・同じ alt。
import Image from 'next/image';
import { LANDING_COPY, LANDING_IMAGE_SIZES } from '../landing-copy';
import { FlowDiagram } from '../primitives/FlowDiagram';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from '../primitives/PhoneFrame';
import { Reveal } from '../primitives/Reveal';
import { StoryScroller } from '../primitives/StoryScroller';

/** 手順の li の id の頭 (how-step-1〜4。StoryScroller が交差を見る。U-30・E-21) */
const STEP_ID_PREFIX = 'how-step-';
/** 手順の番号は 1 から */
const FIRST_STEP_NUMBER = 1;
/** 手順の番号の桁 (01〜04) */
const STEP_NUMBER_DIGITS = 2;

/** 手順の li の id (index は 0 から) */
function storyStepId(index: number): string {
  return `${STEP_ID_PREFIX}${index + FIRST_STEP_NUMBER}`;
}

export function StorySection() {
  const story = LANDING_COPY.story;
  const stepIds = story.steps.map((_, index) => storyStepId(index));
  const screens = story.steps.map((step) => ({ src: step.image.src, alt: step.image.alt }));
  return (
    <section id="how" aria-labelledby="how-title" tabIndex={-1} className="lp-section lp-story">
      <div className="lp-container">
        <Reveal index={0} className="lp-section-head">
          <p className="lp-eyebrow">{story.eyebrow}</p>
          <h2 id="how-title">{story.title}</h2>
          <p className="lp-lead">{story.lead}</p>
        </Reveal>
        <div className="lp-story-grid">
          <ol className="lp-story-steps">
            {story.steps.map((step, index) => (
              <li key={stepIds[index]} id={stepIds[index]} className="lp-story-step">
                <div className="lp-story-step-media">
                  <PhoneFrame>
                    <Image
                      src={step.image.src}
                      alt={step.image.alt}
                      width={GUIDE_SCREEN_WIDTH_PX}
                      height={GUIDE_SCREEN_HEIGHT_PX}
                      sizes={LANDING_IMAGE_SIZES.story}
                    />
                  </PhoneFrame>
                </div>
                <Reveal index={index} className="lp-story-step-text">
                  <span className="lp-step-num" aria-hidden="true">
                    {String(index + FIRST_STEP_NUMBER).padStart(STEP_NUMBER_DIGITS, '0')}
                  </span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </Reveal>
              </li>
            ))}
          </ol>
          <div className="lp-story-aside">
            <StoryScroller steps={screens} stepIds={stepIds} />
          </div>
        </div>
        <Reveal index={0} className="lp-flow-reveal">
          <FlowDiagram nodes={story.flow.nodes} note={story.flow.note} />
        </Reveal>
        <p className="lp-caption">{story.screensCaption}</p>
      </div>
    </section>
  );
}
