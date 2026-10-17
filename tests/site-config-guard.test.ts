/**
 * #1194 送信元・問い合わせ先・サイトの URL を「1 か所」に保つためのソース走査 contract テスト
 *
 * 以前は、送信元 (noreply@homegohan.app)・問い合わせ先 (support@homegohan.app / support@homegohan.jp)・サイトの URL
 * (https://homegohan.app) が、メールの文面 14 本・お問い合わせ API・招待画面・ページのメタ情報・モバイルの設定画面などに
 * 直接書かれていた。しかも .app / .jp / .com の 3 つのドメインに食い違い、どのドメインも実在しない (または別のサービスを指す) ため、
 * ドメインを切り替えるたびに、取りこぼしが出た (モバイルの利用規約・プライバシーポリシーのリンクは、開いても何も表示されなかった)。
 *
 * いまは値を src/lib/site-config.ts (Web) と apps/mobile/src/lib/siteConfig.ts (モバイル) の既定値 1 か所ずつにまとめ、
 * homegohan.com への切り替えは環境変数だけで行う (docs/operations/email-domain.md)。
 *
 * このテストは src/ と apps/mobile/ の全ファイルを読み、次のドメイン表記が直接書かれていないことを確かめる:
 *   '@homegohan.app'  '@homegohan.jp'  'https://homegohan.app'  'https://homegohan.jp'
 * 許すのは、既定値の定数そのものと、既定値を固定するテストだけ (ALLOWED_FILES)。
 * さらに、製品のソース (テストを除く .ts / .tsx / .js などを、コメントを除いてから読む) には、homegohan.com を含めた
 * 3 つのドメインのどれも書かれていないことを確かめる (PRODUCT_ALLOWED_FILES の既定値の定数を除く)。
 * 本番のドメインは homegohan.com に決まっているが、DNS と Resend の検証が済むまでは環境変数で切り替えない。
 * 切り替えをコードの変更なしで済ませるため、製品のコードがドメインを知っているのは既定値の定数だけにしておく。
 * #1573 で見張りを src/ と apps/mobile/ の外へ広げた (OGP の画像・Edge Function・開発用の道具・設定例の文書):
 *   - Edge Function (supabase/functions) の製品のソースも、コメントを除いて 3 つのドメインを書かない
 *   - public/・scripts/・supabase/functions/ とリポジトリ直下の文書 (.env.example・ENV_SETUP.md など) には、
 *     存在しない homegohan.app / homegohan.jp を、サブドメイン付きやドメイン名だけの形でも書かない
 *   - 上の文書と、src/・apps/mobile/ の文書 (README・env.example など) には、サイトの URL を https://homegohan.com で書かない
 *     (homegohan.com はサイトを移すまで別のサービスを指している。切り替えの値は docs/operations/email-domain.md に書く)
 * 落ちたときは、ドメインを書かずに getSiteUrl() / getEmailFrom() / getSupportEmail() (Web) か
 * getSupportEmail() / getTermsUrl() / getPrivacyUrl() (モバイル) を呼ぶ。テストの期待値には、定数 (DEFAULT_*) か
 * example.test のような例示用のドメインを使う。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL_FROM, DEFAULT_SITE_URL, DEFAULT_SUPPORT_EMAIL } from '@/lib/site-config';
import { DEFAULT_SUPPORT_EMAIL as MOBILE_DEFAULT_SUPPORT_EMAIL } from '../apps/mobile/src/lib/siteConfig';
import { DEFAULT_WEB_URL as MOBILE_DEFAULT_WEB_URL } from '../apps/mobile/src/lib/webBaseUrl';

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'apps/mobile'];
/** 読まないフォルダ (依存・ビルド成果物・ネイティブのプロジェクト) */
const SKIP_DIRS = new Set(['node_modules', '.expo', '.next', 'ios', 'android', 'dist', 'build', 'coverage', '.git']);
/** 読むファイル (テキスト)。画像などのバイナリは読まない */
const TEXT_FILE = /(?:\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|ya?ml|html|css|txt|svg)|env\.example)$/i;

/**
 * 直接書いてはいけない表記。
 * - '@homegohan.app' / '@homegohan.jp': メールアドレス (送信元・問い合わせ先)
 * - 'https://homegohan.app' / 'https://homegohan.jp': サイトの URL (www. 付きと http:// も含む)
 * 'com.homegohan.app' (アプリの識別子) や 'https://homegohan-app.vercel.app' (実際の URL) は対象外。
 */
const FORBIDDEN = /@homegohan\.(?:app|jp)\b|https?:\/\/(?:www\.)?homegohan\.(?:app|jp)\b/i;

/** 既定値の定数そのものと、既定値を固定するテスト。ここだけは直接書いてよい */
const ALLOWED_FILES: Record<string, string> = {
  'src/lib/site-config.ts': 'Web の既定値 (DEFAULT_EMAIL_FROM / DEFAULT_SUPPORT_EMAIL)',
  'apps/mobile/src/lib/siteConfig.ts': 'モバイルの既定値 (DEFAULT_SUPPORT_EMAIL)',
  'src/__tests__/lib/site-config.test.ts': '既定値が「いま動いている値」のままであることを固定するテスト',
};

/** 本文からの禁止表記の位置 (1 始まりの行番号と、その行) */
function findForbidden(content: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  content.split('\n').forEach((text, index) => {
    if (FORBIDDEN.test(text)) hits.push({ line: index + 1, text: text.trim().slice(0, 120) });
  });
  return hits;
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...collectFiles(full));
    } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

const hitsByFile = new Map<string, Array<{ line: number; text: string }>>();
let scannedFileCount = 0;
for (const scanRoot of SCAN_ROOTS) {
  for (const file of collectFiles(path.join(ROOT, scanRoot))) {
    scannedFileCount += 1;
    const hits = findForbidden(fs.readFileSync(file, 'utf8'));
    if (hits.length > 0) hitsByFile.set(path.relative(ROOT, file).split(path.sep).join('/'), hits);
  }
}

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('送信元・問い合わせ先・サイトの URL は 1 か所 (#1194): リポジトリのソース', () => {
  it('走査が機能している: 既定値の定数 (許可したファイル) の中の表記を検出する', () => {
    // 走査が壊れて何も見つけられなくなったときに、下の contract が空振りで通ってしまわないようにする
    expect(scannedFileCount).toBeGreaterThan(300);
    for (const file of Object.keys(ALLOWED_FILES)) {
      expect(hitsByFile.has(file), `${file} から禁止表記を検出できない (走査が壊れている、または既定値の書き方が変わった)`).toBe(true);
    }
  });

  it('@homegohan.app / @homegohan.jp / https://homegohan.app を直接書かない (既定値の定数と、それを固定するテストを除く)', () => {
    const offenders = [...hitsByFile.entries()]
      .filter(([file]) => !(file in ALLOWED_FILES))
      .flatMap(([file, hits]) => hits.map((hit) => `${file}:${hit.line}  ${hit.text}`));

    expect(
      offenders,
      '送信元・問い合わせ先・サイトの URL を直接書かず、Web は src/lib/site-config.ts の getEmailFrom() / getSupportEmail() / getSiteUrl()、' +
        'モバイルは apps/mobile/src/lib/siteConfig.ts の getSupportEmail() / getTermsUrl() / getPrivacyUrl() を使うこと。' +
        'テストの期待値には DEFAULT_* の定数か example.test のような例示用のドメインを使う:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});

/**
 * 製品のソース (テストを除く) で、コメントを除いたあとに書かれていてはいけないドメイン。
 * 上の FORBIDDEN より広く、本番のドメインの homegohan.com も含める (切り替えは DNS と Resend の検証のあとに環境変数で行うので、製品のコードには書かない)。
 * 'com.homegohan.app' (アプリの識別子) は対象外。'homegohan-app.vercel.app' はドメインが違うので当たらない。
 */
const PRODUCT_FORBIDDEN = /(?<!\bcom\.)\bhomegohan\.(?:app|jp|com)\b/i;

/** 製品のソースのうち、ドメインを直接書いてよいファイル (既定値の定数そのもの) */
const PRODUCT_ALLOWED_FILES: Record<string, string> = {
  'src/lib/site-config.ts': 'Web の既定値の定数 (DEFAULT_EMAIL_FROM / DEFAULT_SUPPORT_EMAIL)',
  'apps/mobile/src/lib/siteConfig.ts': 'モバイルの既定値の定数 (DEFAULT_SUPPORT_EMAIL)',
};

/** 製品のソースとして読むファイル */
const PRODUCT_SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
/** テストのファイルとフォルダ (製品のソースではない) */
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TEST_DIRS = new Set(['__tests__', '__mocks__']);

function scriptKindOf(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * コメントだけを空白に置き換えた本文を返す (改行は残すので、行番号は元のまま)。
 * 文字列の中の '//' (URL) や JSX の文字はコメントと見なさないよう、TypeScript の構文木でトークンごとに、
 * その前後にあるコメントの位置を求める。
 * - 前 (leading): 改行のあとに置いたコメント (行の頭のコメント・JSDoc)
 * - 後ろ (trailing): トークンと同じ行の後ろに置いたコメント (`foo(); // 説明`・JSX の `{` の直後のコメント)。
 *   TypeScript の leading は、直前のトークンと同じ行にあるコメントを返さないので、こちらも拾う。
 * JSX の文字の範囲に入るもの (`<p>// …</p>` の '// …') は、直前のトークンの後ろを読むとコメントの形に見えるが、
 * 画面に出る文字なので除く。
 */
function stripComments(fileName: string, source: string): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const ranges: ts.CommentRange[] = [];
  /** JSX の文字の範囲 [pos, end) */
  const jsxTextSpans: Array<readonly [number, number]> = [];
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      // JSX の文字はトリビア (コメント) を持たない。'// …' と書かれた文字をコメントと見なさない
      if (node.kind === ts.SyntaxKind.JsxText) {
        jsxTextSpans.push([node.pos, node.end]);
      } else {
        ranges.push(...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []));
        ranges.push(...(ts.getTrailingCommentRanges(source, node.getEnd()) ?? []));
      }
      return;
    }
    children.forEach(visit);
  };
  visit(sf);
  const inJsxText = (pos: number): boolean => jsxTextSpans.some(([start, end]) => pos >= start && pos < end);
  const chars = source.split('');
  for (const { pos, end } of ranges.filter((range) => !inJsxText(range.pos))) {
    for (let i = pos; i < end; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/** コメントを除いた本文から、製品のソースに書いてはいけないドメインの位置 (1 始まりの行番号と、その行) */
function findProductForbidden(fileName: string, source: string): Array<{ line: number; text: string }> {
  // 元の本文に 1 つも無ければ、コメントを除いても無い (構文木を作らずに済ませる)
  if (!PRODUCT_FORBIDDEN.test(source)) return [];
  const hits: Array<{ line: number; text: string }> = [];
  stripComments(fileName, source)
    .split('\n')
    .forEach((text, index) => {
      if (PRODUCT_FORBIDDEN.test(text)) hits.push({ line: index + 1, text: text.trim().slice(0, 120) });
    });
  return hits;
}

function collectProductFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !TEST_DIRS.has(entry.name)) files.push(...collectProductFiles(full));
    } else if (entry.isFile() && PRODUCT_SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 製品のソースとして読むフォルダ。Web と モバイルに加えて、Edge Function (Deno) も製品のコード (#1573。
 * 以前は CORS の既定値に、DNS に存在しない旧ドメインが残っていた)
 */
const PRODUCT_SCAN_ROOTS = [...SCAN_ROOTS, 'supabase/functions'];

const productHitsByFile = new Map<string, Array<{ line: number; text: string }>>();
let productFileCount = 0;
const productFiles = new Set<string>();
for (const scanRoot of PRODUCT_SCAN_ROOTS) {
  for (const file of collectProductFiles(path.join(ROOT, scanRoot))) {
    productFileCount += 1;
    productFiles.add(path.relative(ROOT, file).split(path.sep).join('/'));
    const hits = findProductForbidden(file, fs.readFileSync(file, 'utf8'));
    if (hits.length > 0) productHitsByFile.set(path.relative(ROOT, file).split(path.sep).join('/'), hits);
  }
}

describe('製品のソースは、コメントを除くと既定値の定数のほかにドメインを持たない (#1194)', () => {
  it('走査が機能している: 既定値の定数のファイルから、定数の行だけを検出する (コメントの中の例は数えない)', () => {
    expect(productFileCount).toBeGreaterThan(300);
    expect(productHitsByFile.get('src/lib/site-config.ts')?.map((hit) => hit.text)).toEqual([
      "export const DEFAULT_EMAIL_FROM = 'ほめゴハン <noreply@homegohan.app>';",
      "export const DEFAULT_SUPPORT_EMAIL = 'support@homegohan.app';",
    ]);
    expect(productHitsByFile.get('apps/mobile/src/lib/siteConfig.ts')?.map((hit) => hit.text)).toEqual([
      "export const DEFAULT_SUPPORT_EMAIL = 'support@homegohan.app';",
    ]);
  });

  it('走査が機能している: Edge Function の CORS の既定値 (supabase/functions/_shared/cors.ts) も製品のソースとして読む (#1573)', () => {
    expect(productFiles.has('supabase/functions/_shared/cors.ts')).toBe(true);
    expect(productFiles.has('supabase/functions/generate-hint/index.ts')).toBe(true);
  });

  it('homegohan.app / homegohan.jp / homegohan.com を、既定値の定数のほかに書かない', () => {
    const offenders = [...productHitsByFile.entries()]
      .filter(([file]) => !(file in PRODUCT_ALLOWED_FILES))
      .flatMap(([file, hits]) => hits.map((hit) => `${file}:${hit.line}  ${hit.text}`));

    expect(
      offenders,
      '製品のコードにドメインを直接書かず、Web は src/lib/site-config.ts の getEmailFrom() / getSupportEmail() / getSiteUrl()、' +
        'モバイルは apps/mobile/src/lib/siteConfig.ts の getSupportEmail() / getTermsUrl() / getPrivacyUrl() を使うこと:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('設定画面の「お問い合わせ」は getSupportEmail() から宛先を作る (以前は support@homegohan.jp と直接書いていた)', () => {
    const settings = stripComments('page.tsx', read('src/app/(main)/settings/page.tsx'));
    expect(settings).toMatch(/import\s*\{[^}]*\bgetSupportEmail\b[^}]*\}\s*from\s*["']@\/lib\/site-config["']/);
    expect(settings).toContain('href={`mailto:${getSupportEmail()}`}');
    expect(settings).not.toMatch(/mailto:[^`$]/);
  });
});

/**
 * #1573: src/ と apps/mobile/ の外に残っていたドメインの直書きを見張る。
 * どれも環境変数を読めない (画像の中の文字・設定例・説明) か、site-config を読めない (Edge Function・開発用の道具) ので、
 * ドメインを切り替えても古いまま残る。以前ここに、OGP の画像の文字 homegohan.app・CORS の既定値と、その説明の
 * https://homegohan.app・smoke の例の staging.homegohan.app・カタログの調査の User-Agent が残っていた。
 */
const EXTRA_SCAN_ROOTS = ['public', 'scripts', 'supabase/functions'];
/** リポジトリ直下の、設定例と説明の文書 */
const EXTRA_SCAN_FILES = ['.env.example', 'ENV_SETUP.md', 'README.md', 'SECURITY.md'];
/** EXTRA_SCAN_ROOTS で読むファイル (テキスト)。シェル・Python・SQL の道具も読む */
const EXTRA_TEXT_FILE = /(?:\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|ya?ml|html|css|txt|svg|sh|py|sql|toml|webmanifest)|env\.example)$/i;

/**
 * 存在しない旧ドメイン (DNS に無い)。メールアドレス・URL に限らず、サブドメイン付き (staging.…) やドメイン名だけ (画像の文字) も当てる。
 * 'com.homegohan.app' (アプリの識別子) と 'homegohan-app.vercel.app' (実際の URL) は当たらない。
 */
const STALE_DOMAIN = /(?<!\bcom\.)\bhomegohan\.(?:app|jp)\b/i;

/**
 * サイトの URL を homegohan.com で書いたもの。homegohan.com は、サイトを移すまで別のサービスを指しているので、
 * 設定例 (EXPO_PUBLIC_API_BASE_URL など) や説明に書くと、そのとおりに設定した人のアプリが別のサービスに繋がる。
 * メールアドレス (support@homegohan.com・noreply@mail.homegohan.com) とドメイン名だけの言及は対象外。
 */
const SITE_URL_ON_COM = /https?:\/\/(?:www\.)?homegohan\.com\b/i;

/**
 * SITE_URL_ON_COM を書いてよい行 (切り替えるときの値だと読めるもの)。ファイルごとに、その行が満たす形。
 * ENV_SETUP.md の表は「例」の列が切り替えるときの値で、同じ行の既定値の列に、いま動いている URL を書いている。
 */
const SITE_URL_ON_COM_ALLOWED_LINES: Record<string, RegExp> = {
  'ENV_SETUP.md': /^\| `NEXT_PUBLIC_APP_URL` \| `https:\/\/homegohan\.com` \|.*`https:\/\/homegohan-app\.vercel\.app`/,
};

/** src/ と apps/mobile/ の、製品のソースでない設定例と説明の文書 (README・env.example など) */
const DOC_FILE = /(?:\.(?:md|mdx|txt|ya?ml)|env\.example)$/i;

function collectExtraFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...collectExtraFiles(full));
    } else if (entry.isFile() && EXTRA_TEXT_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function collectDocFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !TEST_DIRS.has(entry.name)) files.push(...collectDocFiles(full));
    } else if (entry.isFile() && DOC_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** 本文から、正規表現に当たる行 (1 始まりの行番号と、その行) */
function findLines(content: string, pattern: RegExp): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  content.split('\n').forEach((text, index) => {
    if (pattern.test(text)) hits.push({ line: index + 1, text: text.trim().slice(0, 160) });
  });
  return hits;
}

const toRelative = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

/** 旧ドメインを見張るファイル (相対パス) */
const extraFiles = [
  ...EXTRA_SCAN_ROOTS.flatMap((root) => collectExtraFiles(path.join(ROOT, root)).map(toRelative)),
  ...EXTRA_SCAN_FILES.filter((file) => fs.existsSync(path.join(ROOT, file))),
];
/** homegohan.com のサイトの URL を見張るファイル (相対パス)。上に、src/ と apps/mobile/ の文書を足す */
const siteUrlFiles = [...extraFiles, ...SCAN_ROOTS.flatMap((root) => collectDocFiles(path.join(ROOT, root)).map(toRelative))];

const staleHits = extraFiles.flatMap((file) => findLines(read(file), STALE_DOMAIN).map((hit) => ({ file, ...hit })));
const siteUrlHits = siteUrlFiles.flatMap((file) => findLines(read(file), SITE_URL_ON_COM).map((hit) => ({ file, ...hit })));

/** #1573 で直したファイル。見張りの中にあることを確かめる */
const FIXED_IN_1573 = [
  'public/og-image.svg',
  'supabase/functions/_shared/cors.ts',
  'supabase/functions/README.md',
  'scripts/smoke.mjs',
  'scripts/lib/smoke.mjs',
  'scripts/catalog/audit-source-structure.mjs',
  '.env.example',
  'ENV_SETUP.md',
  'apps/mobile/env.example',
  'apps/mobile/README.md',
];

describe('src/ と apps/mobile/ の外のドメインの直書き (#1573)', () => {
  it('走査が機能している: #1573 で直したファイルがすべて見張りの中にあり、書いてよい行を検出できる', () => {
    expect(extraFiles.length).toBeGreaterThan(100);
    for (const file of FIXED_IN_1573) {
      expect(extraFiles.includes(file) || siteUrlFiles.includes(file), `${file} が見張りの外にある`).toBe(true);
    }
    expect(siteUrlFiles).toEqual(expect.arrayContaining(['apps/mobile/env.example', 'apps/mobile/README.md']));
    // 書いてよい行 (ENV_SETUP.md の切り替えの例) を検出できる = homegohan.com の走査が空振りしていない
    expect(siteUrlHits.filter((hit) => hit.file === 'ENV_SETUP.md')).toHaveLength(1);
  });

  it('public/・scripts/・supabase/functions/ とリポジトリ直下の文書に、存在しない homegohan.app / homegohan.jp を書かない', () => {
    const offenders = staleHits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`);
    expect(
      offenders,
      'homegohan.app / homegohan.jp は DNS に存在しない。サイトの URL はいま動いている URL (src/lib/site-config.ts の DEFAULT_SITE_URL) か、' +
        '環境変数 (NEXT_PUBLIC_APP_URL など) から読む。例には example.test のような例示用のドメインを使う:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('設定例と説明に、サイトの URL を https://homegohan.com で書かない (切り替えの手順の文書を除く)', () => {
    const offenders = siteUrlHits
      .filter((hit) => !(SITE_URL_ON_COM_ALLOWED_LINES[hit.file]?.test(hit.text) ?? false))
      .map((hit) => `${hit.file}:${hit.line}  ${hit.text}`);
    expect(
      offenders,
      'homegohan.com は、サイトを移すまで別のサービスを指している。設定例はいま動いている URL (https://homegohan-app.vercel.app) にし、' +
        '切り替えるときの値は docs/operations/email-domain.md に書く:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('判定: 旧ドメインはサブドメイン付き・ドメイン名だけでも当て、アプリの識別子と実際の URL は当てない', () => {
    for (const text of [
      '<text x="1100" y="590">homegohan.app</text>',
      'npm run test:smoke -- --base-url=https://staging.homegohan.app',
      '"User-Agent": "Mozilla/5.0 (compatible; X/1.0; +https://homegohan.app)"',
      'ALLOWED_ORIGINS=https://homegohan.app,https://homegohan-app.vercel.app',
      'mailto:support@homegohan.jp',
    ]) {
      expect(findLines(text, STALE_DOMAIN), text).toHaveLength(1);
    }
    for (const text of [
      'bundleIdentifier: "com.homegohan.app"',
      'https://homegohan-app.vercel.app',
      'support@homegohan.com',
      'https://staging.example.test',
    ]) {
      expect(findLines(text, STALE_DOMAIN), text).toEqual([]);
    }
  });

  it('判定: homegohan.com のサイトの URL を当て、メールアドレスは当てない', () => {
    for (const text of [
      'EXPO_PUBLIC_API_BASE_URL=https://homegohan.com',
      'export EXPO_PUBLIC_API_BASE_URL="https://homegohan.com"',
      '`https://homegohan.com/api/*` が失敗する',
      'http://www.homegohan.com',
    ]) {
      expect(findLines(text, SITE_URL_ON_COM), text).toHaveLength(1);
    }
    for (const text of [
      'NEXT_PUBLIC_SUPPORT_EMAIL=support@homegohan.com',
      'EMAIL_FROM="ほめゴハン <noreply@mail.homegohan.com>"',
      '`homegohan.com` へ切り替えるときは',
      'https://homegohan-app.vercel.app',
    ]) {
      expect(findLines(text, SITE_URL_ON_COM), text).toEqual([]);
    }
  });

  it('書いてよい行は、ENV_SETUP.md の表の NEXT_PUBLIC_APP_URL の行 (切り替えの例と、いまの既定値を並べた行) だけ', () => {
    const allowed = SITE_URL_ON_COM_ALLOWED_LINES['ENV_SETUP.md'];
    expect(
      allowed.test(
        '| `NEXT_PUBLIC_APP_URL` | `https://homegohan.com` | サイトの URL | `https://homegohan-app.vercel.app`（いま動いているサイト） |',
      ),
    ).toBe(true);
    expect(allowed.test('- `EXPO_PUBLIC_API_BASE_URL` - Next.js API（BFF）の基点（例: `https://homegohan.com`）')).toBe(false);
    expect(allowed.test('| `NEXT_PUBLIC_APP_URL` | `https://homegohan.com` | サイトの URL | (既定値の記載なし) |')).toBe(false);
  });
});

describe('site-config.ts の冒頭の表の既定値は、定数と同じ', () => {
  it('表の「DEFAULT_* = 値」が、書き出している定数の値と一致する', () => {
    const header = read('src/lib/site-config.ts').split('*/')[0];
    const rows = [...header.matchAll(/\|\s*(DEFAULT_[A-Z_]+) = ([^|]+?)\s*\|/g)].map(([, name, value]) => [name, value]);
    expect(rows).toEqual([
      ['DEFAULT_SITE_URL', DEFAULT_SITE_URL],
      ['DEFAULT_EMAIL_FROM', DEFAULT_EMAIL_FROM],
      ['DEFAULT_SUPPORT_EMAIL', DEFAULT_SUPPORT_EMAIL],
    ]);
  });
});

describe('既定値は Web とモバイルで同じ', () => {
  it('問い合わせ先の既定値が同じ', () => {
    expect(MOBILE_DEFAULT_SUPPORT_EMAIL).toBe(DEFAULT_SUPPORT_EMAIL);
  });

  it('モバイルが WebView で開く Web の既定の URL が、Web のサイトの URL の既定値と同じ (古いアプリのビルドが読み込む URL)', () => {
    expect(MOBILE_DEFAULT_WEB_URL).toBe(DEFAULT_SITE_URL);
  });

  it('送信元の既定値は、問い合わせ先の既定値と同じドメイン (片方だけ切り替わって食い違うのを防ぐ)', () => {
    const fromDomain = /<[^@]+@([^>]+)>/.exec(DEFAULT_EMAIL_FROM)?.[1];
    expect(fromDomain).toBeDefined();
    expect(DEFAULT_SUPPORT_EMAIL.endsWith(`@${fromDomain}`)).toBe(true);
  });
});

describe('設定の説明が、コードの環境変数名と合っている', () => {
  it('.env.example に Web の 3 つの環境変数が載っている', () => {
    const example = read('.env.example');
    for (const name of ['NEXT_PUBLIC_APP_URL', 'EMAIL_FROM', 'NEXT_PUBLIC_SUPPORT_EMAIL']) {
      expect(example, `.env.example に ${name} の説明が無い`).toMatch(new RegExp(`^#?\\s*${name}=`, 'm'));
    }
  });

  it('apps/mobile/env.example にモバイルの環境変数が載っている', () => {
    const example = read('apps/mobile/env.example');
    expect(example).toMatch(/^#?\s*EXPO_PUBLIC_SUPPORT_EMAIL=/m);
  });

  it('運用手順 (docs/operations/email-domain.md) に、切り替えで設定する環境変数がすべて載っている', () => {
    const doc = read('docs/operations/email-domain.md');
    for (const name of [
      'NEXT_PUBLIC_APP_URL',
      'EMAIL_FROM',
      'NEXT_PUBLIC_SUPPORT_EMAIL',
      'NEXT_PUBLIC_INVITE_BASE_URL',
      'SUPPORT_REPLY_TO',
      'EXPO_PUBLIC_SUPPORT_EMAIL',
      'EXPO_PUBLIC_WEB_URL',
      'EXPO_PUBLIC_API_BASE_URL',
      'ALLOWED_ORIGINS',
    ]) {
      expect(doc, `docs/operations/email-domain.md に ${name} の説明が無い`).toContain(name);
    }
  });
});

describe('禁止表記の判定ロジック', () => {
  it('メールアドレスとサイトの URL (.app / .jp) を検出する', () => {
    for (const text of [
      "from: 'ほめゴハン <noreply@homegohan.app>'",
      'href="mailto:support@homegohan.jp"',
      'Linking.openURL("https://homegohan.app/terms")',
      'https://www.homegohan.app/',
      'http://homegohan.jp',
      'SUPPORT@HOMEGOHAN.APP',
    ]) {
      expect(findForbidden(text), text).toHaveLength(1);
    }
  });

  it('許すもの: homegohan.com・実際の URL (vercel.app)・アプリの識別子 (com.homegohan.app)・例示用のドメイン', () => {
    for (const text of [
      'support@homegohan.com',
      'https://homegohan.com',
      'https://homegohan-app.vercel.app',
      'appId: com.homegohan.app',
      'bundleIdentifier: "com.homegohan.app"',
      'https://evil.homegohan.app',
      'support@example.test',
    ]) {
      expect(findForbidden(text), text).toEqual([]);
    }
  });

  it('行番号を返す', () => {
    expect(findForbidden('a\nb\nmailto:support@homegohan.jp\nd')).toEqual([
      { line: 3, text: 'mailto:support@homegohan.jp' },
    ]);
  });
});

describe('製品のソースの判定ロジック (コメントを除いてから読む)', () => {
  it('3 つのドメインを、文字列・テンプレート文字列・JSX の属性と文字の中で検出する (homegohan.com も含む)', () => {
    for (const [fileName, source] of [
      ['a.ts', "const from = 'ほめゴハン <noreply@homegohan.app>';"],
      ['a.ts', 'const url = `https://homegohan.com/${path}`;'],
      ['a.tsx', 'const A = () => <a href="mailto:support@homegohan.jp">問い合わせ</a>;'],
      ['a.tsx', 'const A = () => <p>// support@homegohan.com まで</p>;'],
      ['a.tsx', 'const A = () => <p>/* support@homegohan.com */</p>;'],
      ['a.tsx', 'const A = () => <a href="/contact">// support@homegohan.jp</a>;'],
      ['a.js', "const u = 'https://mail.homegohan.com'; // 説明"],
      ['a.ts', "const u = 'SUPPORT@HOMEGOHAN.COM';"],
    ] as const) {
      expect(findProductForbidden(fileName, source), source).toHaveLength(1);
    }
  });

  it('コメントの中は数えない (行コメント・ブロックコメント・JSX の中のコメント)', () => {
    for (const [fileName, source] of [
      ['a.ts', '// 例: support@homegohan.com\nconst a = 1;'],
      ['a.ts', '/**\n * NEXT_PUBLIC_APP_URL=https://homegohan.com\n */\nexport const a = 1;'],
      ['a.ts', "const a = getSupportEmail(); /* 以前は support@homegohan.jp */"],
      ['a.ts', 'const a = getSupportEmail(); // 以前は support@homegohan.jp\nconst b = 2;'],
      ['a.ts', 'call(/* 以前は support@homegohan.jp */ getSupportEmail());'],
      ['a.tsx', 'const A = () => (\n  <div>\n    {/* 以前は mailto:support@homegohan.jp */}\n  </div>\n);'],
      ['a.tsx', 'const A = () => <div>{/* 以前は support@homegohan.jp */}</div>;'],
    ] as const) {
      expect(findProductForbidden(fileName, source), source).toEqual([]);
    }
  });

  it('許すもの: アプリの識別子 (com.homegohan.app)・実際の URL (homegohan-app.vercel.app)・例示用のドメイン', () => {
    for (const source of [
      "const bundleIdentifier = 'com.homegohan.app';",
      "const url = 'https://homegohan-app.vercel.app';",
      "const support = 'support@example.test';",
    ]) {
      expect(findProductForbidden('a.ts', source), source).toEqual([]);
    }
  });

  it('コメントを除いても行番号は元のまま', () => {
    expect(findProductForbidden('a.ts', '/* 1\n2 */\n// 3\nconst a = "x@homegohan.app";')).toEqual([
      { line: 4, text: 'const a = "x@homegohan.app";' },
    ]);
  });
});
