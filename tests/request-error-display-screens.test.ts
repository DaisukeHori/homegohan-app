/**
 * 生成のリクエストの行の失敗の文を、画面が読む側の絞り込みに通してから出す (#1576。#1478 の続き)
 *
 * #1478 で、Realtime や直接の select で行を受けるフック (useV4MenuGeneration) には、既知の文だけをそのまま出し、
 * それ以外は汎用の文にする絞り込みを入れた。しかし次の画面は、行の error_message / result.error をそのまま出していた。
 *   - Web: 週の献立の画面 (src/app/(main)/menus/weekly/page.tsx) の weekly_menu_requests の Realtime 2 か所と
 *     shopping_list_requests の Realtime 1 か所 (と、状態の確認の API の本文を受ける箇所)
 *   - アプリ: 週の献立の画面 (apps/mobile/app/menus/weekly/index.tsx)・買い物リストの画面 (apps/mobile/app/shopping-list/index.tsx)。
 *     この 2 つは、通常の操作で届かないネイティブの画面として消した (#1598。献立のタブは WebView で Web の画面を出す)。
 *     アプリで行を受けるのは、生成のフック (apps/mobile/src/hooks/useV4MenuGeneration.ts) だけになった
 * 書く側は定型の文を書くが、#1478 より前に書かれた行には生の文が残っており、進まなくなった行の印 'stale_request_timeout' は
 * 英語のまま出ていた。
 *
 * 絞り込みの中身 (どの文を通すか) は tests/stored-failure-messages.test.ts が確かめる。ここでは画面のソースを読み、
 * 行・応答の本文の失敗の文に既定の文を添える式 (`x.error_message || '...'` など) が、どれも絞り込みの関数を通していることを見る
 * (書き戻しの見張り。よくある書き方の見張りで、網羅はしない)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/**
 * 行・応答の本文の失敗の文に既定の文を添える式 (失敗の文をそのまま画面に出す書き方)。
 * 行・本文のプロパティ (`x.error_message`・`x.errorMessage`・`x.result?.error`) と、分割代入で受けた `error_message`・
 * `errorMessageSnake` を見る。絞り込みを通したあとの値を受ける関数の引数 (`finishRegenerate` の `errorMessage` など) は見ない
 */
const FALLBACK_OF_STORED_ERROR =
  /(?:\.(?:error_message|errorMessage)|\berror_message|\berrorMessageSnake|\.result\?\.error)\s*(?:\|\||\?\?)/;
/** 読む側の絞り込みの関数 (Web: weeklyMenuRequestErrorMessageForDisplay / shoppingListRequestErrorMessageForDisplay、
 * アプリ: menuRequestErrorMessageForDisplay) */
const DISPLAY_FILTER = /(?:weeklyMenuRequest|menuRequest|shoppingListRequest)ErrorMessageForDisplay\(/;

const SCREENS: Array<{ file: string; filters: Array<{ name: string; minCalls: number }> }> = [
  {
    file: 'src/app/(main)/menus/weekly/page.tsx',
    filters: [
      // weekly_menu_requests: 状態の確認の受け口 (入り直し 2・ポーリング 1・再生成 1・改善 1)・Realtime 2・フックの進捗 2
      { name: 'weeklyMenuRequestErrorMessageForDisplay', minCalls: 9 },
      // shopping_list_requests: ポーリング 1・Realtime 1
      { name: 'shoppingListRequestErrorMessageForDisplay', minCalls: 2 },
    ],
  },
  {
    file: 'apps/mobile/src/hooks/useV4MenuGeneration.ts',
    // Realtime 1・状態の確認 1
    filters: [{ name: 'menuRequestErrorMessageForDisplay', minCalls: 2 }],
  },
];

describe.each(SCREENS)('$file', ({ file, filters }) => {
  const source = read(file);

  it('失敗の文に既定の文を添える式は、どれも読む側の絞り込みの関数を通している', () => {
    const offending = source
      .split('\n')
      .map((line, index) => ({ line, lineNo: index + 1 }))
      .filter(({ line }) => FALLBACK_OF_STORED_ERROR.test(line) && !DISPLAY_FILTER.test(line));
    expect(offending).toEqual([]);
  });

  it.each(filters)('$name を少なくとも $minCalls か所で呼ぶ', ({ name, minCalls }) => {
    const calls = source.split(`${name}(`).length - 1;
    expect(calls).toBeGreaterThanOrEqual(minCalls);
  });
});

describe('週の献立の画面 (Web) の Realtime の受け口 (#1576)', () => {
  const source = read('src/app/(main)/menus/weekly/page.tsx');

  it('weekly_menu_requests の Realtime の行の error_message は、絞り込みを通してから失敗の表示に渡す', () => {
    expect(source).toContain('weeklyMenuRequestErrorMessageForDisplay(newData.error_message)');
    expect(source).not.toMatch(/newData\.error_message\s*(?:\|\||\?\?)/);
  });

  it('shopping_list_requests の Realtime の行の result.error は、絞り込みを通してから失敗の表示に渡す', () => {
    expect(source).toContain('shoppingListRequestErrorMessageForDisplay(newData.result?.error)');
    expect(source).not.toMatch(/newData\.result\?\.error\s*(?:\|\||\?\?)/);
  });
});
