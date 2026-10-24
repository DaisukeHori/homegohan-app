/**
 * tests/no-literal-private-key.test.ts
 *
 * リポジトリのソース・テスト・文書 (docs も含む) に、gitleaks の private-key ルールが秘密鍵として拾う形
 * (PEM の BEGIN … PRIVATE KEY----- から 64 文字以上あとの KEY----- まで) が無いことと、.gitleaksignore の書き方の決まりを確かめる。
 *
 * 背景 (#1139 Sign in with Apple 段 A1): テストのダミーの秘密鍵 (本文は ABCDEF) を PEM のヘッダ付きでそのまま書いたところ、
 * 1 行目と 30 行ほど下の 2 つ目のダミーの間を gitleaks が 1 つの鍵として拾い、PR を止める検査
 * (.github/workflows/security.yml の gitleaks ジョブ・scripts/local-ci.sh の secrets 段) が赤になった。
 * gitleaks は PR で増えたコミットしか見ないので、ふだんの vitest で先に気づけるよう、同じ形をここで探す。
 * テストで PEM が要るときは、ヘッダの文字列を分けて組み立てる (例: ['-----BEGIN', 'PRIVATE KEY-----'].join(' '))
 * か、generateKeyPairSync で作る。
 * 文書で PEM のヘッダや末尾の語を名指すときは、ダッシュ 5 つを付けずに書く (例: 「PRIVATE KEY を含む PEM のヘッダ」)。
 * 同じファイルの前のほうにヘッダが 1 つあるだけで、そこから後ろの最初の「KEY + ダッシュ 5 つ」までが 1 つの鍵として拾われる
 * (#1917: docs/design/mobile/08-sign-in-with-apple.md は §11.2 の注にヘッダがあり、§17 の表のセルに末尾の語をダッシュ付きで
 * 書いた案では、その間の 10 万字あまりが 1 つの鍵として拾われた)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

/**
 * gitleaks (8.30.1。security.yml と local-ci.sh が固定する版) の既定のルール private-key と同じ形。
 * (?i)-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----
 */
const GITLEAKS_PRIVATE_KEY_RULE =
  /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S-]{64,}?KEY(?: BLOCK)?-----/i;

/** ルールの「BEGIN の行のあと 64 文字以上」を確実に超える、2 つのダミーの間の文字数 (検出の器の確かめ用) */
const GAP_LONGER_THAN_RULE_MIN = 80;

/** 探すディレクトリ (リポジトリのソース・テスト・スクリプト・migration・モバイル) */
const SCAN_DIRS = ['src', 'tests', 'packages', 'apps', 'scripts', 'supabase', 'docs'] as const;
/** 探すリポジトリ直下のファイル (環境変数の見本) */
const SCAN_ROOT_FILES = ['.env.example'] as const;
/** 中に入らないディレクトリ (依存・生成物) */
const SKIP_DIR_NAMES = new Set(['node_modules', '.next', '.expo', 'dist', 'build', 'Pods', 'coverage', '.turbo']);
/** 読むファイルの拡張子 (文字のファイルだけ。画像などは読まない) */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sql', '.sh', '.md', '.toml', '.yml', '.yaml', '.txt',
]);

function collectTextFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR_NAMES.has(entry.name)) collectTextFiles(full, out);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

describe('ソースに PEM の秘密鍵の形をそのまま書かない (gitleaks の private-key)', () => {
  it('探す形は、ヘッダ付きの PEM を秘密鍵として拾う (検出の器が空でない)', () => {
    const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const end = ['-----END', 'PRIVATE KEY-----'].join(' ');
    // #1139 で拾われた形: 本文が短くても、64 文字以上あとに次の KEY----- があれば 1 つの鍵として拾う
    const twoShortDummies = `const A = '${begin}\\nABCDEF\\n${end}';\n${'x'.repeat(GAP_LONGER_THAN_RULE_MIN)}\nconst B = '${begin}\\nABCDEF\\n${end}';`;
    expect(GITLEAKS_PRIVATE_KEY_RULE.test(twoShortDummies)).toBe(true);
    // ヘッダを分けて組み立てる書き方は拾わない
    const split = "const BEGIN = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');\n".repeat(3);
    expect(GITLEAKS_PRIVATE_KEY_RULE.test(split)).toBe(false);
  });

  it('文書の前のほうに PEM のヘッダが 1 つあると、後ろで末尾の語にダッシュ 5 つを続けて名指すだけで拾う (#1917 mobile/08 §17 の行)', () => {
    const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const trailerWithDashes = ['PRIVATE KEY', '-----'].join('');
    // mobile/08 §11.2 の注の形 (ヘッダを 1 つ書くだけで、END の行は無い)
    const jsdocWithHeader = `  /** PEM (${begin} …)。環境変数には改行を \\n と書いて入れる (ここで戻す) */`;
    const rowsBetween = 'x'.repeat(GAP_LONGER_THAN_RULE_MIN);
    // ヘッダの注だけなら、後ろに「KEY + ダッシュ 5 つ」が無いので鍵にならない
    expect(GITLEAKS_PRIVATE_KEY_RULE.test(`${jsdocWithHeader}\n${rowsBetween}`)).toBe(false);
    // §17 の表のセルに末尾の語をダッシュ付きで書くと、注のヘッダからそのセルまでが 1 つの鍵として拾われる
    const cellWithDashes = `| gitleaks の番兵 | \`${trailerWithDashes}\` | 秘密鍵の形 | ヘッダの文字列を分けて組み立てる | A1 |`;
    expect(GITLEAKS_PRIVATE_KEY_RULE.test(`${jsdocWithHeader}\n${rowsBetween}\n${cellWithDashes}`)).toBe(true);
    // 直した形 (ダッシュを付けずに名指す) は拾わない
    const cellWithoutDashes =
      '| gitleaks の番兵 | `PRIVATE KEY` | 秘密鍵の形 | 本書は §11.2 の注に PEM のヘッダを書いているので、それより後ろで `KEY` にダッシュ 5 つを続けて書かない | A1 |';
    expect(GITLEAKS_PRIVATE_KEY_RULE.test(`${jsdocWithHeader}\n${rowsBetween}\n${cellWithoutDashes}`)).toBe(false);
  });

  it('src・tests・packages・apps・scripts・supabase・docs と .env.example に、拾われる形が無い', () => {
    const files: string[] = [];
    for (const dir of SCAN_DIRS) collectTextFiles(path.join(ROOT, dir), files);
    for (const name of SCAN_ROOT_FILES) {
      const full = path.join(ROOT, name);
      if (fs.existsSync(full)) files.push(full);
    }
    // 探す対象が空なら検査になっていない (ディレクトリの読み違い)
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(path.join(ROOT, 'src/__tests__/lib/auth/apple/config.test.ts'));

    const hits = files
      .filter((file) => GITLEAKS_PRIVATE_KEY_RULE.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(hits).toEqual([]);
  });
});

describe('.gitleaksignore の書き方', () => {
  /** gitleaks の指紋 (コミットの完全な SHA:ファイル:ルール:行) */
  const FINGERPRINT_WITH_COMMIT = /^[0-9a-f]{40}:[^:\s]+:[a-z0-9-]+:[1-9][0-9]*$/;

  const lines = fs
    .readFileSync(path.join(ROOT, '.gitleaksignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  it('除外はすべて、コミットの SHA 付きの指紋 1 件ずつ (ファイルごと・全コミットの除外を書かない)', () => {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(FINGERPRINT_WITH_COMMIT);
    }
  });

  it('#1139 段 A1 のダミーの PEM の 1 件 (コミット 5f0cdb94 の config.test.ts:30) を除外している', () => {
    expect(lines).toContain(
      '5f0cdb9479996d8bdb8b719d78f3e7f6255c9d9f:src/__tests__/lib/auth/apple/config.test.ts:private-key:30',
    );
  });
});
