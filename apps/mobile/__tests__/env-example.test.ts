/**
 * env-example.test.ts
 * apps/mobile/env.example の網羅性のテスト (#1049 F7-19)
 *
 * アプリのソースが読む EXPO_PUBLIC_* が env.example に載っていないと、新しく環境を作る人 (EAS の設定を含む) が
 * その変数の存在に気付けない。以前は EXPO_PUBLIC_WEB_URL / EXPO_PUBLIC_POSTHOG_KEY / EXPO_PUBLIC_POSTHOG_HOST が
 * 載っていなかった。ソースに新しい EXPO_PUBLIC_* を足したら、env.example にも足すこと。
 *
 * 数え方:
 *   - ソースが読む変数: コメントを除いたコードの `process.env.EXPO_PUBLIC_*` だけ。説明文の中に例として書いた名前
 *     (siteConfig.ts の冒頭の `process.env.EXPO_PUBLIC_XXX` など) は、読んでいる変数ではないので数えない。
 *   - env.example に載っている変数: `NAME=` の行。未設定なら既定値が使われる変数は `# NAME=既定値` とコメントで載せるので、
 *     その行も数える (tests/site-config-guard.test.ts の判定と同じ `^#?\s*NAME=`)。
 *     `NAME` を文章の中で触れているだけの行 (`=` が続かないもの) は数えない。
 */

import fs from 'fs';
import path from 'path';

const MOBILE_ROOT = path.resolve(__dirname, '..');

/** コメントを除く (説明文の中の名前を、読んでいる変数と取り違えないため。tests/mobile-date-basis-contract.test.ts と同じ方法) */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** コード (コメントを除いたもの) から `process.env.EXPO_PUBLIC_*` (ドット / 文字列リテラルの添字) を集める */
function referencedVarsIn(source: string): Set<string> {
  const found = new Set<string>();
  const pattern = /process\.env(?:\.|\[['"])(EXPO_PUBLIC_[A-Z0-9_]+)/g;
  for (const match of withoutComments(source).matchAll(pattern)) found.add(match[1]);
  return found;
}

/** env.example に `NAME=` (または `# NAME=`) の形で書かれている変数名 */
function documentedVarsIn(example: string): Set<string> {
  return new Set(
    example
      .split('\n')
      .map((line) => /^\s*#?\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*=/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
}

/** app/ と src/ 配下のソースが読む EXPO_PUBLIC_* */
function collectReferencedVars(): Set<string> {
  const found = new Set<string>();

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        for (const name of referencedVarsIn(fs.readFileSync(full, 'utf8'))) found.add(name);
      }
    }
  };

  walk(path.join(MOBILE_ROOT, 'app'));
  walk(path.join(MOBILE_ROOT, 'src'));
  return found;
}

describe('env.example の網羅性', () => {
  it('アプリのソースが読む EXPO_PUBLIC_* は全部 env.example に載っている', () => {
    const referenced = collectReferencedVars();
    // 取りこぼし防止: 少なくとも既知の変数は拾えている
    expect(referenced.has('EXPO_PUBLIC_API_BASE_URL')).toBe(true);
    expect(referenced.has('EXPO_PUBLIC_WEB_URL')).toBe(true);
    expect(referenced.has('EXPO_PUBLIC_POSTHOG_KEY')).toBe(true);
    expect(referenced.has('EXPO_PUBLIC_POSTHOG_HOST')).toBe(true);
    expect(referenced.has('EXPO_PUBLIC_SUPPORT_EMAIL')).toBe(true);

    const documented = documentedVarsIn(fs.readFileSync(path.join(MOBILE_ROOT, 'env.example'), 'utf8'));
    const missing = [...referenced].filter((name) => !documented.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('説明文の中に例として書いた名前 (EXPO_PUBLIC_XXX) は、ソースが読む変数に数えていない', () => {
    // src/lib/siteConfig.ts の冒頭のコメントに `process.env.EXPO_PUBLIC_XXX` と例が書いてある
    expect(collectReferencedVars().has('EXPO_PUBLIC_XXX')).toBe(false);
  });
});

describe('数え方 (referencedVarsIn / documentedVarsIn)', () => {
  it('コードの process.env.EXPO_PUBLIC_* を拾い、コメントの中のものは拾わない', () => {
    const source = [
      '// process.env.EXPO_PUBLIC_IN_LINE_COMMENT は説明',
      '/* process.env.EXPO_PUBLIC_IN_BLOCK_COMMENT */',
      '/**',
      ' * process.env.EXPO_PUBLIC_IN_DOC_COMMENT',
      ' */',
      'const a = process.env.EXPO_PUBLIC_REAL_DOT;',
      "const b = process.env['EXPO_PUBLIC_REAL_INDEX'];",
      'const c = process.env.EXPO_PUBLIC_WITH_URL ?? "https://example.test"; // process.env.EXPO_PUBLIC_TRAILING',
    ].join('\n');

    expect([...referencedVarsIn(source)].sort()).toEqual([
      'EXPO_PUBLIC_REAL_DOT',
      'EXPO_PUBLIC_REAL_INDEX',
      'EXPO_PUBLIC_WITH_URL',
    ]);
  });

  it('`NAME=` の行と、コメントにした `# NAME=既定値` の行を、載っているものとして数える', () => {
    const example = [
      '# 説明',
      'EXPO_PUBLIC_A=1',
      'EXPO_PUBLIC_B=',
      '# EXPO_PUBLIC_C=default',
      '  EXPO_PUBLIC_D = spaced',
    ].join('\n');

    expect([...documentedVarsIn(example)].sort()).toEqual([
      'EXPO_PUBLIC_A',
      'EXPO_PUBLIC_B',
      'EXPO_PUBLIC_C',
      'EXPO_PUBLIC_D',
    ]);
  });

  it('変数名に文章の中で触れているだけの行 (= が続かないもの) は、載っているものとして数えない', () => {
    const example = [
      '# EXPO_PUBLIC_API_BASE_URL (API の呼び出し先) とは別の設定値。',
      '# 未設定なら EXPO_PUBLIC_WEB_URL を使う。',
      '# 例: EXPO_PUBLIC_EXAMPLE=1',
    ].join('\n');

    expect([...documentedVarsIn(example)]).toEqual([]);
  });
});
