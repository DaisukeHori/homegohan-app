// 章: 写真で記録 (docs/design/marketing/01-landing-site.md §4.7・§8.3)。Server Component。
// 2 つの入口と、解析の結果 (5 つの値・記録コメント・栄養メモ) を深く見せる。画面 3 枚の帯と、comment.png と同じ画面から切り出した拡大 (zoom-photo)。
import { CHAPTER_IDS, CHAPTER_TONE, LANDING_COPY } from '../landing-copy';
import { ChapterSection } from './ChapterSection';

/** 章の番号 (CHAPTER_IDS の順で 1 から) */
const CHAPTER_NUMBER = CHAPTER_IDS.indexOf('photo') + 1;

export function PhotoChapter() {
  return <ChapterSection chapter={LANDING_COPY.chapters.photo} number={CHAPTER_NUMBER} tone={CHAPTER_TONE.photo} />;
}
