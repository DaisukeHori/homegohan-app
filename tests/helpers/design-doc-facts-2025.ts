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

/** billing/03 の冊の頭の表の「土台」の行の sha (`| 土台 | origin/main `<sha>` …`) */
export const readBillingFoundationSha: FactValueReader = (text) => capturesOf(text, [/^\| 土台 \| origin\/main `([0-9a-f]{7,40})`/g]);

/** 栄養士のコメントの model の行 (billing/03 §2.4 の原価の表: OpenAI `gpt-5.2` (`…/nutrition/feedback/route.ts:<行>`)) */
export const readNutritionFeedbackModelLine: FactValueReader = (text) =>
  capturesOf(text, [/OpenAI `gpt-5\.2` \(`src\/app\/api\/ai\/nutrition\/feedback\/route\.ts:(\d+)`\)/g]);

/** 献立の振り返りの褒めコメントの指示の行 (marketing/01 §4.1: `…/nutrition/feedback/route.ts:<行>` の指示) */
export const readPraiseCommentPromptLine: FactValueReader = (text) =>
  capturesOf(text, [/`src\/app\/api\/ai\/nutrition\/feedback\/route\.ts:(\d+)` の指示/g]);

const MARKETING_01 = 'docs/design/marketing/01-landing-site.md';
const CROSS_16 = 'docs/design/cross/16-auth-history-sessions.md';
const CROSS_13B = 'docs/design/cross/13b-legal-consent-mobile.md';
const BILLING_03 = 'docs/design/billing/03-paid-plans-and-iap.md';

/** 冊が名指す基準の sha と、その sha の時点の行番号の組 */
export type BasisPinnedFact = {
  readonly name: string;
  readonly doc: string;
  /** 冊の基準の sha を読む */
  readonly readBasis: FactValueReader;
  /** 下の値を確かめた基準の sha (冊がこの sha を名指す間は、値はこの sha の時点の行) */
  readonly basis: string;
  readonly read: FactValueReader;
  /** 基準の sha の時点の値 (`git show <basis>:<file>` の行で確かめた) */
  readonly valueAtBasis: string;
};

/**
 * 冊が基準の sha を名指したまま、行番号だけを今の main の行に書き換えると、基準の宣言と値が食い違う (docs-1026b の設計書の直しの R1 は
 * marketing/01 §4.1 の根拠の行と billing/03 §2.4 の行を今の main の行にした)。冊の基準を取り直すときは、値と一緒にここも直す。
 */
export const BASIS_PINNED_FACTS_2025: readonly BasisPinnedFact[] = [
  // ab201cc6 の src/app/(main)/menus/weekly/page.tsx:4323 = `const analyzePhotoWithAI = async () => {`
  { name: '献立表の analyzePhotoWithAI の行', doc: MARKETING_01, readBasis: readMarketingBasisSha, basis: 'ab201cc6', read: readAnalyzePhotoWithAiLine, valueAtBasis: '4323' },
  // ab201cc6 の同じファイルの :5649 = `aria-label="買い物リストを開く"`
  { name: '献立表の「買い物リストを開く」の行', doc: MARKETING_01, readBasis: readMarketingBasisSha, basis: 'ab201cc6', read: readOpenShoppingListLine, valueAtBasis: '5649' },
  // ab201cc6 の同じファイルの :3398 = `const res = await aiFetch(`/api/shopping-list/regenerate`, {`
  { name: '献立表が /api/shopping-list/regenerate を呼ぶ行', doc: MARKETING_01, readBasis: readMarketingBasisSha, basis: 'ab201cc6', read: readShoppingListRegenerateCallLine, valueAtBasis: '3398' },
  // ab201cc6 の src/app/api/ai/nutrition/feedback/route.ts:94 = `"praiseComment": "褒めコメント（80-120文字）。良い点を見つけて褒める。…"`
  { name: '褒めコメントの指示の行', doc: MARKETING_01, readBasis: readMarketingBasisSha, basis: 'ab201cc6', read: readPraiseCommentPromptLine, valueAtBasis: '94' },
  // 4b1e1abe の src/app/api/ai/nutrition/feedback/route.ts:112 = `model: 'gpt-5.2',`
  { name: '栄養士のコメントの model の行', doc: BILLING_03, readBasis: readBillingFoundationSha, basis: '4b1e1abe', read: readNutritionFeedbackModelLine, valueAtBasis: '112' },
];

export const DESIGN_DOC_FACTS_2025: readonly DesignDocFact[] = [
  { name: 'file:line の基準の sha', doc: MARKETING_01, read: readMarketingBasisSha, minMentions: 2 },
  { name: '献立表の analyzePhotoWithAI の行', doc: MARKETING_01, read: readAnalyzePhotoWithAiLine, minMentions: 2 },
  { name: '献立表の「買い物リストを開く」の行', doc: MARKETING_01, read: readOpenShoppingListLine, minMentions: 2 },
  { name: '献立表が /api/shopping-list/regenerate を呼ぶ行', doc: MARKETING_01, read: readShoppingListRegenerateCallLine, minMentions: 2 },
  { name: 'support の利用者詳細の「n回」の行', doc: CROSS_16, read: readSupportUserLoginCountLine, minMentions: 2 },
  { name: 'support の一覧の「最終ログイン」の行', doc: CROSS_16, read: readSupportUserListLastLoginLine, minMentions: 3 },
  { name: 'モバイルの getApiErrorMessage の範囲', doc: CROSS_13B, read: readMobileGetApiErrorMessageRange, minMentions: 3 },
];
