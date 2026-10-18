'use client';

// 物語の固定した端末 (M-6。docs/design/marketing/01-landing-site.md §6.2・§8.2・§8.3 の StoryScroller・§13.3 の物語の表)。島。
// 手順の li (id="how-step-<n>") は StorySection が描き、ここは id を stepIds で受け取って useInViewIds(stepIds, STORY_BAND_ROOT_MARGIN) で見る。
// 帯 (画面の中央の 20 %) にある手順のうち最も下のものの画面を出す (storyActiveIndex。帯に無い間は直前のまま)。
// - マウントで根に data-js を付ける。CSS は 1024 px 以上でこの印があるときだけ固定した端末を見せ、手順の中の画面を隠す
//   (JS 無し・1024 px 未満では固定した端末は display: none で、手順ごとの画面が縦に並ぶ)。
// - 固定した端末には 4 枚を重ね、activeIndex の 1 枚だけ data-active="true"・aria-hidden="false" (ほかは "false"・"true")。
//   no-preference では 4 枚とも描き、CSS で data-active="true" の 1 枚だけ opacity 1 (ほかは 0) にして、opacity の遷移で溶け込ませる。
//   動きを減らす設定では data-active="true" の 1 枚だけを描き (ほかは display: none)、一瞬で替わる (状態は同じ。marketing.css の理由)。
// - いま見えている手順の li に data-story-current を付け、手順の番号と文を強める (飾り。JS 無しでは付かず、どの手順も同じ見え方)。
// - フォーカスする要素は持たない。
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { LANDING_IMAGE_SIZES, STORY_BAND_ROOT_MARGIN } from '../landing-copy';
import { storyActiveIndex } from '../story-state';
import { GUIDE_SCREEN_HEIGHT_PX, GUIDE_SCREEN_WIDTH_PX, PhoneFrame } from './PhoneFrame';
import { useInViewIds } from './useInViewSteps';

/** マウントの直後に見せる手順 (§13.3: マウント直後は 0) */
const FIRST_STEP_INDEX = 0;
/** いま見えている手順の li に付ける印 (飾りの強調だけに使う) */
const CURRENT_STEP_ATTRIBUTE = 'data-story-current';

type StoryScrollerProps = {
  steps: ReadonlyArray<{ src: string; alt: string }>;
  stepIds: ReadonlyArray<string>;
};

export function StoryScroller({ steps, stepIds }: StoryScrollerProps) {
  const [mounted, setMounted] = useState(false);
  const [activeIndex, setActiveIndex] = useState(FIRST_STEP_INDEX);
  const intersecting = useInViewIds(stepIds, STORY_BAND_ROOT_MARGIN);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setActiveIndex((current) => storyActiveIndex(intersecting, current));
  }, [intersecting]);

  // いま見えている手順の li に印を付ける (手順の li は Server の HTML。React が描き直さないので、印は付け外しで管理する)
  useEffect(() => {
    if (!mounted) return;
    stepIds.forEach((id, index) => document.getElementById(id)?.toggleAttribute(CURRENT_STEP_ATTRIBUTE, index === activeIndex));
  }, [mounted, activeIndex, stepIds]);

  useEffect(
    () => () => {
      stepIds.forEach((id) => document.getElementById(id)?.removeAttribute(CURRENT_STEP_ATTRIBUTE));
    },
    [stepIds],
  );

  return (
    <div className="lp-story-stage" data-js={mounted ? '1' : undefined}>
      <PhoneFrame className="lp-story-phone">
        {steps.map((step, index) => {
          const active = index === activeIndex;
          return (
            <Image
              key={step.src}
              src={step.src}
              alt={step.alt}
              width={GUIDE_SCREEN_WIDTH_PX}
              height={GUIDE_SCREEN_HEIGHT_PX}
              sizes={LANDING_IMAGE_SIZES.story}
              data-active={active ? 'true' : 'false'}
              aria-hidden={active ? 'false' : 'true'}
            />
          );
        })}
      </PhoneFrame>
    </div>
  );
}
