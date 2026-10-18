// 章: 健康の記録 (docs/design/marketing/01-landing-site.md §4.10・§8.3 の HealthChapter)。Server Component。
// ChapterSection の children に免責 (chapters.health.disclaimer) を置く。画面は weight.png の 1 枚 (帯にしない)。
// 体重の減りが写る trend.png・weight-photo.png は使わない (§7.1)。
import { Stethoscope } from 'lucide-react';
import { CHAPTER_IDS, CHAPTER_TONE, LANDING_COPY } from '../landing-copy';
import { ChapterSection } from './ChapterSection';

/** 章の番号 (CHAPTER_IDS の順で 1 から) */
const CHAPTER_NUMBER = CHAPTER_IDS.indexOf('health') + 1;

export function HealthChapter() {
  const chapter = LANDING_COPY.chapters.health;
  return (
    <ChapterSection chapter={chapter} number={CHAPTER_NUMBER} tone={CHAPTER_TONE.health}>
      <p className="lp-disclaimer">
        <Stethoscope className="lp-disclaimer-icon" aria-hidden="true" />
        {chapter.disclaimer}
      </p>
    </ChapterSection>
  );
}
