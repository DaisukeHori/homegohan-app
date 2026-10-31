/**
 * 運営の画面の文が「英字だけ」(日本語を 1 文字も含まない) かどうかの判定 (テスト用)。
 *
 * 2 文字以上で、英字で始まり、英字・数字・閉じ括弧・コロンで終わり、間は英字・数字・空白・記号 (. / & ( ) - _ :) だけの文。
 * - 括弧つきの英字の文 (以前の NPS の画面の h2「NPS (Net Promoter Score)」) も英字だけ (#2150 Q3b-1)
 * - DB の列名そのままの文 (以前のバックアップの画面の表の列「action_type」、プランの画面の「plan_key」) も英字だけ。
 *   以前の判定は下線 (_) を許しておらず、この形を見逃していた (#2157 R2)
 * - 数字やコロンを含む英字の文 (「Step 1:」など) も英字だけ (#2157 R2)
 *
 * tests/operator-sidebar-subtitle-2139.test.tsx (サイドバーと見出し) と tests/operator-column-labels-2157.test.ts (表の列名・欄名) が使う
 */
const ENGLISH_ONLY_TEXT = /^[A-Za-z][A-Za-z0-9\s./&()_:-]*[A-Za-z0-9):]$/;

export function isEnglishOnlyText(text: string): boolean {
  return ENGLISH_ONLY_TEXT.test(text.trim());
}
