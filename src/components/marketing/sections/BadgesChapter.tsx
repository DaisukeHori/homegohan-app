// 章: バッジと続ける仕組み (docs/design/marketing/01-landing-site.md §4.11・§8.3 の BadgesChapter・M-10)。Server Component。
// ChapterSection の children にバッジの列 (ul。4 枚。アイコンの輪 (金の輝き)・h3 (名前)・説明) を置く。
// 列を 1 つの Reveal で包み、各カードの立ち上がり (M-10) は CSS が --lp-stagger ずつずらす。
// 載せるのは付与の処理があり、名前が付与の条件と食い違わない 4 つ (photo_10・planner・比較に基づくバッジは載せない: §4.11)。
import { Flame, Footprints, GraduationCap, Trophy, type LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { CHAPTER_IDS, CHAPTER_TONE, LANDING_COPY, type BadgeCard } from '../landing-copy';
import { Reveal } from '../primitives/Reveal';
import { ChapterSection } from './ChapterSection';

/** バッジごとのアイコン (§4.11 の表) */
const BADGE_ICONS: Record<BadgeCard['code'], LucideIcon> = {
  first_bite: Footprints,
  streak_3: Flame,
  streak_7: Trophy,
  tutorial_complete: GraduationCap,
};
/** 章の番号 (CHAPTER_IDS の順で 1 から) */
const CHAPTER_NUMBER = CHAPTER_IDS.indexOf('badges') + 1;

export function BadgesChapter() {
  const chapter = LANDING_COPY.chapters.badges;
  return (
    <ChapterSection chapter={chapter} number={CHAPTER_NUMBER} tone={CHAPTER_TONE.badges}>
      <Reveal index={0} className="lp-badges-reveal">
        <ul className="lp-badges">
          {chapter.items.map((badge, index) => {
            const Icon = BADGE_ICONS[badge.code];
            return (
              <li key={badge.code} className="lp-badge-card" style={{ '--lp-i': index } as CSSProperties}>
                <span className="lp-badge-ring" aria-hidden="true">
                  <Icon />
                </span>
                <div className="lp-badge-text">
                  <h3>{badge.name}</h3>
                  <p>{badge.description}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Reveal>
    </ChapterSection>
  );
}
