// 章: 栄養の見える化 (docs/design/marketing/01-landing-site.md §4.9・§8.3 の NutritionChapter)。Server Component。
// ChapterSection の children にスコアの輪 (ScoreRing。M-11) を置く。輪の値は撮影の見本 GUIDE_MEAL_ANALYSIS.overallScore と同じ (U-28)。
import { CHAPTER_IDS, CHAPTER_TONE, LANDING_COPY, RING_MAX } from '../landing-copy';
import { ScoreRing } from '../primitives/ScoreRing';
import { ChapterSection } from './ChapterSection';

/** 章の番号 (CHAPTER_IDS の順で 1 から) */
const CHAPTER_NUMBER = CHAPTER_IDS.indexOf('nutrition') + 1;

export function NutritionChapter() {
  const chapter = LANDING_COPY.chapters.nutrition;
  return (
    <ChapterSection chapter={chapter} number={CHAPTER_NUMBER} tone={CHAPTER_TONE.nutrition}>
      <div className="lp-ring-card">
        <ScoreRing value={chapter.ring.value} max={RING_MAX} label={chapter.ring.label} note={chapter.ring.note} />
      </div>
    </ChapterSection>
  );
}
