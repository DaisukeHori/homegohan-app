/**
 * WebView の認証ブリッジまわり (#1036 / #1158) のソースに any への型の外し方が残っていないことを確かめる。
 *
 * WebViewScreen.tsx には、タブの再タップの購読 (navigation.addListener('tabPress', ...)) と
 * router.push のパスを any で外す書き方が main の時点から残っていた。
 * いまは useNavigation の型引数 (TabPressNavigation) と expo-router の Href の型で書いているので、
 * any へ外す書き方が戻ってきたらここで赤にする (型検査を止める書き方を、この案件の範囲に再び入れない)。
 *
 * 判定はコメントを除いたソースで行う (説明のコメントに語が出ても数えない)。
 */

import * as fs from 'fs';
import * as path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '../..');

// この案件で触ったモバイルの実装のソース
const TARGET_FILES = [
  'src/components/web/WebViewScreen.tsx',
  'src/lib/webViewBridge.ts',
  'src/lib/webViewAuthMessages.ts',
];

const ANY_CAST_PATTERN = /\bas\s+any\b/;

/** ブロックコメントと行コメントを除く。文字列中の // も行末まで消えるが、消える側にしか倒れないので見逃しは増えない */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('WebView の認証ブリッジのソースに any への型の外し方が無い (#1036 / #1158)', () => {
  it.each(TARGET_FILES)('%s', (relativePath) => {
    const source = fs.readFileSync(path.join(MOBILE_ROOT, relativePath), 'utf8');
    const offending = stripComments(source)
      .split('\n')
      .filter((line) => ANY_CAST_PATTERN.test(line));
    expect(offending).toEqual([]);
  });

  it('判定の正規表現は any への外し方を検出し、コメントの中の語は数えない (見張りの自己検査)', () => {
    // 検査対象の語そのものを差分に書くと、差分を grep する機械検査がこのテストを数えてしまうので組み立てる
    const cast = ['as', 'any'].join(' ');
    const withCast = `navigation.addListener('tabPress' ${cast}, () => {});`;
    expect(stripComments(withCast).split('\n').filter((l) => ANY_CAST_PATTERN.test(l))).toHaveLength(1);
    const inComment = `// 以前は 'tabPress' ${cast} と書いていた\n/* router.push(x ${cast}) */\nconst a = 1;`;
    expect(stripComments(inComment).split('\n').filter((l) => ANY_CAST_PATTERN.test(l))).toHaveLength(0);
  });

  it('タブの再タップの購読は tabPress の名前のまま型付きで書かれている', () => {
    const source = stripComments(
      fs.readFileSync(path.join(MOBILE_ROOT, 'src/components/web/WebViewScreen.tsx'), 'utf8'),
    );
    expect(source).toContain("navigation.addListener('tabPress', ");
    expect(source).toContain('useNavigation<TabPressNavigation>()');
  });
});
