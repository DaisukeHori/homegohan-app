// tests/helpers/design-doc-facts-2025.ts
// #2025 の続き (docs-1026b) で指し先を確かめた事実と、それを何か所かで述べる設計書の組 (tests/design-doc-fact-consistency-2025.test.ts が使う)。
// 1 冊の中で、事実ごとの値 (行番号・基準の sha) が 1 つにそろうことを確かめる (tests/helpers/design-doc-fact-consistency.ts)。
//
// marketing/01 は冊の全体 (§2.2 の「本書の事実 (file:line・…) の基準は origin/main `ab201cc6`」) と §4.1 の頭の段落
// (「根拠」の file:line は origin/main `ab201cc6` の行) が基準の sha を名指す。その冊の行番号を一部だけ今の main の行に書き換えると、
// 同じ関数を指す別の箇所が基準の行のまま残り、1 冊の中で値が分かれる (docs-1026b の設計書の直しの R1 の形:
// §4.1 の `photo-entrances` の行の analyzePhotoWithAI を `:4330` にし、同じ節の献立表の「写真から入力」の行は `:4323` のまま)。
import type { FactValueReader } from './design-doc-fact-consistency';
import type { DesignDocFact } from './design-doc-facts-1917';

/** 正規表現のすべての一致から、1 つ目の組を取り出す */
function capturesOf(text: string, patterns: readonly RegExp[]): string[] {
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]));
}

/**
 * marketing/01 の file:line の基準の sha: §2.2 の冊の全体の宣言 (`基準は origin/main `<sha>``) と、
 * §4.1 の頭の段落 (`「根拠」の file:line は origin/main `<sha>` の行`)
 */
export const readMarketingBasisSha: FactValueReader = (text) =>
  capturesOf(text, [/基準は origin\/main `([0-9a-f]{7,40})`/g, /「根拠」の file:line は origin\/main `([0-9a-f]{7,40})` の行/g]);

/** 献立表の「写真から入力」の analyzePhotoWithAI の行 (`page.tsx:<行>` (`analyzePhotoWithAI`) と `page.tsx:<行>` の `analyzePhotoWithAI`) */
export const readAnalyzePhotoWithAiLine: FactValueReader = (text) =>
  capturesOf(text, [/menus\/weekly\/page\.tsx:(\d+)` (?:\(`|の `)analyzePhotoWithAI`/g]);

/** 献立表の「買い物リストを開く」の行 (主張の表は「…」の直後、画面の表は `…` の後の括弧の中) */
export const readOpenShoppingListLine: FactValueReader = (text) =>
  capturesOf(text, [/買い物リストを開く(?:」|`) ?\(?`src\/app\/\(main\)\/menus\/weekly\/page\.tsx:(\d+)`/g]);

/** 献立表の画面が `/api/shopping-list/regenerate` を呼ぶ行 (§2.5 の上限の段落と、§4.1 の `shopping-list` の行) */
export const readShoppingListRegenerateCallLine: FactValueReader = (text) =>
  capturesOf(text, [
    /この 1 つの API を呼ぶ: `src\/app\/\(main\)\/menus\/weekly\/page\.tsx:(\d+)`/g,
    /`\/api\/shopping-list\/regenerate` を呼ぶ \(`:(\d+)`/g,
  ]);

/**
 * cross/16 の support の利用者詳細の「n回」の行。行番号の後に注の括弧 (`(origin/main `<sha>` の行)` など) があっても読む
 */
export const readSupportUserLoginCountLine: FactValueReader = (text) =>
  capturesOf(text, [/support\/users\/page\.tsx:(\d+)` (?:\([^()]*\) )?(?:の「n回」|\(詳細の「n回」\))/g]);

/** cross/16 の support の一覧の「最終ログイン」の行 (§3 の段落・§21.4 の表・§25 の Q-22) */
export const readSupportUserListLastLoginLine: FactValueReader = (text) =>
  capturesOf(text, [
    /support\/users\/page\.tsx:(\d+)` (?:\([^()]*\) )?(?:の「最終ログイン|\(一覧の「最終ログイン)/g,
    /support の一覧 \(`src\/app\/\(support\)\/support\/users\/page\.tsx:(\d+)`\)/g,
  ]);

/**
 * cross/13b のモバイルの getApiErrorMessage (本文の文を取り出す) の範囲。§0.3 の一次情報の表・§6.2 の状態比較表・§6.21 の旧版の表の 3 か所。
 * 同じ行の getJapaneseApiErrorMessage の範囲 (`api-error.ts:<範囲>` の `getJapaneseApiErrorMessage`) は拾わない
 */
export const readMobileGetApiErrorMessageRange: FactValueReader = (text) =>
  capturesOf(text, [
    /`getApiErrorMessage`[^|]*\| `apps\/mobile\/src\/lib\/api-error\.ts:(\d+-\d+)`/g,
    /本文の固定の文を出すだけ \(`api-error\.ts:(\d+-\d+)`\)/g,
    /を Alert に出す \(`api-error\.ts:(\d+-\d+)`\)/g,
    /`:(\d+-\d+)` の `getApiErrorMessage`/g,
  ]);

const MARKETING_01 = 'docs/design/marketing/01-landing-site.md';
const CROSS_16 = 'docs/design/cross/16-auth-history-sessions.md';
const CROSS_13B = 'docs/design/cross/13b-legal-consent-mobile.md';

export const DESIGN_DOC_FACTS_2025: readonly DesignDocFact[] = [
  { name: 'file:line の基準の sha', doc: MARKETING_01, read: readMarketingBasisSha, minMentions: 2 },
  { name: '献立表の analyzePhotoWithAI の行', doc: MARKETING_01, read: readAnalyzePhotoWithAiLine, minMentions: 2 },
  { name: '献立表の「買い物リストを開く」の行', doc: MARKETING_01, read: readOpenShoppingListLine, minMentions: 2 },
  { name: '献立表が /api/shopping-list/regenerate を呼ぶ行', doc: MARKETING_01, read: readShoppingListRegenerateCallLine, minMentions: 2 },
  { name: 'support の利用者詳細の「n回」の行', doc: CROSS_16, read: readSupportUserLoginCountLine, minMentions: 2 },
  { name: 'support の一覧の「最終ログイン」の行', doc: CROSS_16, read: readSupportUserListLastLoginLine, minMentions: 3 },
  { name: 'モバイルの getApiErrorMessage の範囲', doc: CROSS_13B, read: readMobileGetApiErrorMessageRange, minMentions: 3 },
];
