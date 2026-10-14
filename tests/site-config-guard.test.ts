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
 * 本番のドメインはまだ決まっていないので、製品のコードがドメインを知っているのは既定値の定数だけにしておく。
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
 * 上の FORBIDDEN より広く、本番の候補の homegohan.com も含める (本番のドメインは未定のため、製品のコードには書かない)。
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
 * その前にあるコメントの位置を求める。
 */
function stripComments(fileName: string, source: string): string {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const ranges: ts.CommentRange[] = [];
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(sf);
    if (children.length === 0) {
      // JSX の文字はトリビア (コメント) を持たない。'// …' と書かれた文字をコメントと見なさない
      if (node.kind !== ts.SyntaxKind.JsxText) {
        ranges.push(...(ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []));
      }
      return;
    }
    children.forEach(visit);
  };
  visit(sf);
  const chars = source.split('');
  for (const { pos, end } of ranges) {
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

const productHitsByFile = new Map<string, Array<{ line: number; text: string }>>();
let productFileCount = 0;
for (const scanRoot of SCAN_ROOTS) {
  for (const file of collectProductFiles(path.join(ROOT, scanRoot))) {
    productFileCount += 1;
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
      ['a.tsx', 'const A = () => (\n  <div>\n    {/* 以前は mailto:support@homegohan.jp */}\n  </div>\n);'],
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
