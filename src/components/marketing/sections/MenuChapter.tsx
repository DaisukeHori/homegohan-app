// 章: AI 献立と買い物 (docs/design/marketing/01-landing-site.md §4.8・§8.3)。Server Component。
// 週の献立・条件・献立の修正・買い物リスト・食材の管理を 1 つの流れで見せる。画面 5 枚の帯と、menu-result.png と同じ画面から切り出した拡大 (zoom-menu)。
import { CHAPTER_IDS, CHAPTER_TONE, LANDING_COPY } from '../landing-copy';
import { ChapterSection } from './ChapterSection';

/** 章の番号 (CHAPTER_IDS の順で 1 から) */
const CHAPTER_NUMBER = CHAPTER_IDS.indexOf('menu') + 1;

export function MenuChapter() {
  return <ChapterSection chapter={LANDING_COPY.chapters.menu} number={CHAPTER_NUMBER} tone={CHAPTER_TONE.menu} />;
}
