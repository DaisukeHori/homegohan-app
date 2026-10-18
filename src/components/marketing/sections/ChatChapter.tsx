// 章: AI に相談 (docs/design/marketing/01-landing-site.md §4.12・§8.3)。Server Component。地は濃色の面 (dark)。
// 画面の右下のシートから相談でき、頼んだ操作 (献立の作成など) を AI がその場で行うことを見せる。画面は chat.png の 1 枚 (AI の返事は写っていない)。
import { CHAPTER_IDS, CHAPTER_TONE, LANDING_COPY } from '../landing-copy';
import { ChapterSection } from './ChapterSection';

/** 章の番号 (CHAPTER_IDS の順で 1 から) */
const CHAPTER_NUMBER = CHAPTER_IDS.indexOf('chat') + 1;

export function ChatChapter() {
  return <ChapterSection chapter={LANDING_COPY.chapters.chat} number={CHAPTER_NUMBER} tone={CHAPTER_TONE.chat} />;
}
