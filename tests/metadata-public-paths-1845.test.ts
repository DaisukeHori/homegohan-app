// @vitest-environment node
/**
 * #1845: ページのメタ情報・manifest が指す画像などのパスが、すべて実在して未ログインでも開けることの見張り
 *
 * 以前は src/app/layout.tsx の openGraph.images・twitter.images が /og-image.png を、icons.apple が /apple-touch-icon.png を、
 * public/manifest.json の icons が /icon-192.png・/icon-512.png を、通知のアイコン (src/lib/local-notification.ts) が
 * /icon-192x192.png を指していたが、どれも存在せず本番で 404 だった (public/ には SVG しか無かった)。
 * 同じ型の取りこぼし (存在しないファイルを指すメタ情報) を、ここで止める。
 *
 * 「実在する」とは、次のどれかに当たること:
 *   - public/<パス> のファイル
 *   - src/app/<パス> のファイル (Next の file convention。例: src/app/favicon.ico → /favicon.ico)
 *   - src/app/<パス>/route.ts(x) の route (例: src/app/icon-192.png/route.ts → /icon-192.png)
 * あわせて、そのパスが src/proxy.ts の matcher の外 (未ログインの訪問者・クローラーを /login へ送らない) であることも確かめる。
 * file convention の画像 (opengraph-image など) の URL も、matcher の外であることを確かめる。
 *
 * #1853 で広げたもの: 画面のコード (src/ の .ts / .tsx / .js / .jsx。テストを除く) が指す、ルートからの静的な画像のパスも同じく確かめる。
 * 以前は src/app/handson-tour/page.tsx の <Image src="/icon.png"> が public/ に無いファイルを指していて、本番で 404 だった。
 * TypeScript の構文木で読むので、コメントの中は見ない。拾うのは次の 2 つ:
 *   - <Image src="/...">・<img src="/...">・<source src="/..."> (next/image を別の名前で読み込んでいても拾う) の、値の入らない src
 *   - 画像の拡張子 (.png など) で終わる、ルートからのパスの文字列 (src={step.image} のように、データの配列に置いた画像のパス)
 * `/guide/${name}.png` のように値の入るパスは拾わない。実在しない既知のパスは、理由つきで KNOWN_MISSING_IMAGE_PATHS に載せる。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { config } from '@/proxy';
import { APP_ICON_192_PATH } from '@/lib/brand-asset-paths';
import { DEFAULT_NOTIFICATION_ICON } from '@/lib/local-notification';

vi.mock('next/font/google', () => ({
  Noto_Sans_JP: () => ({ variable: 'font-sans-test' }),
  Noto_Serif_JP: () => ({ variable: 'font-serif-test' }),
}));
vi.mock('@vercel/speed-insights/next', () => ({ SpeedInsights: () => null }));

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const APP_DIR = path.join(ROOT, 'src/app');
const ROUTE_FILES = ['route.ts', 'route.tsx'];

/** matcher を正規表現にして判定する (tests/health-middleware-exemption.test.ts と同じ方法) */
function runsMiddleware(pathname: string): boolean {
  const [matcher] = config.matcher;
  return new RegExp(`^${matcher}$`).test(pathname);
}

/** URL のパス (先頭が /・クエリ無し) が、public のファイル・app のファイル・app の route のどれかで返るか */
function resolvesToAsset(urlPath: string): boolean {
  const relative = urlPath.replace(/^\//, '');
  if (relative === '' || relative.includes('..')) return false;
  const publicFile = path.join(PUBLIC_DIR, relative);
  if (fs.existsSync(publicFile) && fs.statSync(publicFile).isFile()) return true;
  const appFile = path.join(APP_DIR, relative);
  if (fs.existsSync(appFile) && fs.statSync(appFile).isFile()) return true;
  return ROUTE_FILES.some((file) => fs.existsSync(path.join(APP_DIR, relative, file)));
}

type UrlLike = string | URL | { url: string | URL };

/** metadata の icons / images の値 (文字列・URL・{ url }・その配列) から、パスの一覧を取り出す */
function collectUrls(value: UrlLike | UrlLike[] | undefined | null): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectUrls(item));
  if (typeof value === 'string') return [value];
  if (value instanceof URL) return [value.pathname];
  return collectUrls(value.url);
}

/** layout の metadata と manifest.json と通知の既定のアイコンが指す、同じサイトの中のパス (重複なし) */
async function referencedPaths(): Promise<Array<{ from: string; urlPath: string }>> {
  const { metadata } = await import('@/app/layout');
  const refs: Array<{ from: string; urlPath: string }> = [];
  const push = (from: string, urls: string[]) => {
    for (const url of urls) refs.push({ from, urlPath: url });
  };

  const icons = metadata.icons;
  if (icons && typeof icons === 'object' && !Array.isArray(icons) && !(icons instanceof URL)) {
    const iconDescriptor = icons as Record<string, UrlLike | UrlLike[] | undefined>;
    for (const key of ['icon', 'apple', 'shortcut', 'other'] as const) {
      push(`layout metadata.icons.${key}`, collectUrls(iconDescriptor[key]));
    }
  } else {
    push('layout metadata.icons', collectUrls(icons as UrlLike | UrlLike[] | undefined));
  }
  push('layout metadata.manifest', collectUrls(metadata.manifest as UrlLike | undefined));
  push('layout metadata.openGraph.images', collectUrls((metadata.openGraph?.images ?? undefined) as UrlLike | UrlLike[] | undefined));
  push('layout metadata.twitter.images', collectUrls((metadata.twitter?.images ?? undefined) as UrlLike | UrlLike[] | undefined));

  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.json'), 'utf8')) as {
    icons?: Array<{ src: string }>;
    screenshots?: Array<{ src: string }>;
  };
  push('public/manifest.json icons', (manifest.icons ?? []).map(({ src }) => src));
  push('public/manifest.json screenshots', (manifest.screenshots ?? []).map(({ src }) => src));

  push('src/lib/local-notification.ts DEFAULT_NOTIFICATION_ICON', [DEFAULT_NOTIFICATION_ICON]);
  push('src/lib/brand-asset-paths.ts APP_ICON_192_PATH', [APP_ICON_192_PATH]);

  // 絶対 URL (外部のサイト) は対象外。同じサイトの中のパスだけ (クエリは除く)
  return refs
    .filter(({ urlPath }) => urlPath.startsWith('/') && !urlPath.startsWith('//'))
    .map(({ from, urlPath }) => ({ from, urlPath: urlPath.split('?')[0] }));
}

/** file convention の画像のファイル名 (Next の metadata の画像。拡張子の無い URL で返る) */
const IMAGE_FILE_CONVENTION = /^(opengraph-image|twitter-image|icon|apple-icon)\d*\.(tsx|ts|jsx|js)$/;

/** src/app の中の file convention の画像のファイルを、相対パスで列挙する */
function findImageConventionFiles(dir: string = APP_DIR): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      found.push(...findImageConventionFiles(full));
    } else if (IMAGE_FILE_CONVENTION.test(entry.name)) {
      found.push(path.relative(APP_DIR, full));
    }
  }
  return found;
}

describe('#1845 メタ情報・manifest が指すパスの実在', () => {
  it('見張りの対象を拾えている (空振りしていない)', async () => {
    const paths = (await referencedPaths()).map(({ urlPath }) => urlPath);
    // layout の icons (favicon・icon.svg・apple-touch-icon)・manifest・manifest の 2 つのアイコン・通知のアイコン
    expect(paths).toEqual(
      expect.arrayContaining([
        '/favicon.ico',
        '/icon.svg',
        '/apple-touch-icon.png',
        '/manifest.json',
        '/icon-192.png',
        '/icon-512.png',
      ]),
    );
  });

  it('すべて public のファイル・app のファイル・app の route のどれかで返る', async () => {
    const missing = (await referencedPaths()).filter(({ urlPath }) => !resolvesToAsset(urlPath));
    expect(missing, '存在しないファイルを指している。public/ に置くか、src/app/<パス>/route.ts で返すこと').toEqual([]);
  });

  it('すべて src/proxy.ts の matcher の外 (未ログインでも /login へ送られない)', async () => {
    const proxied = (await referencedPaths()).filter(({ urlPath }) => runsMiddleware(urlPath));
    expect(proxied, 'matcher の対象になっている。未ログインのクローラー・端末が画像の代わりにログイン画面を受け取る').toEqual([]);
  });

  it('見張りの判定そのものが働く (存在しないパスは返らない・存在するパスは返る)', () => {
    expect(resolvesToAsset('/og-image.png')).toBe(false);
    expect(resolvesToAsset('/icon-192x192.png')).toBe(false);
    expect(resolvesToAsset('/icon.svg')).toBe(true);
    expect(resolvesToAsset('/favicon.ico')).toBe(true);
    expect(resolvesToAsset('/icon-192.png')).toBe(true);
    expect(resolvesToAsset('/../package.json')).toBe(false);
    // #1853: ハンズオンツアーが以前指していたパスと、消した OGP の画像の SVG は返らない
    expect(resolvesToAsset('/icon.png')).toBe(false);
    expect(resolvesToAsset('/og-image.svg')).toBe(false);
    expect(resolvesToAsset('/handson-tour/sample-meal.webp')).toBe(true);
  });
});

describe('#1845 file convention の画像の URL は matcher の外', () => {
  it('src/app のルートに opengraph-image と twitter-image がある', () => {
    expect(findImageConventionFiles()).toEqual(expect.arrayContaining(['opengraph-image.tsx', 'twitter-image.tsx']));
  });

  it('file convention の画像はすべて src/app の直下にあり、その URL (/<名前>) は matcher の外', () => {
    for (const file of findImageConventionFiles()) {
      // 直下以外 (route group の配下など) は URL に接尾辞が付き、matcher の除外の書き方が変わる。置くときはここと matcher を見直す
      expect(path.dirname(file), `${file} は src/app の直下ではない`).toBe('.');
      const urlPath = `/${path.basename(file).replace(/\.(tsx|ts|jsx|js)$/, '')}`;
      expect(runsMiddleware(urlPath), `${urlPath} が proxy を通る`).toBe(false);
    }
  });

  it('除外はちょうどその名前だけ (前方一致で他のページを巻き込まない)', () => {
    expect(runsMiddleware('/opengraph-image')).toBe(false);
    expect(runsMiddleware('/twitter-image')).toBe(false);
    expect(runsMiddleware('/opengraph-images')).toBe(true);
    expect(runsMiddleware('/opengraph-image/x')).toBe(true);
    expect(runsMiddleware('/twitter-image-x')).toBe(true);
    expect(runsMiddleware('/home/opengraph-image')).toBe(true);
    expect(runsMiddleware('/')).toBe(true);
    expect(runsMiddleware('/login')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1853: 画面のコードが指す、ルートからの静的な画像のパス
// ─────────────────────────────────────────────────────────────────────────────

/** 画像のパスを探す範囲 (画面・部品・lib。テストは除く) */
const IMAGE_SCAN_DIR = path.join(ROOT, 'src');
const SCANNED_SOURCE = /\.[cm]?[jt]sx?$/;
const SKIPPED_SOURCE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const SKIPPED_DIRS = new Set(['node_modules', '__tests__']);
/** 画像の拡張子 (この判定の前に、構文木を作るかどうかを本文の文字で絞る) */
const IMAGE_EXTENSIONS = 'png|jpe?g|gif|webp|avif|svg|ico';
/** 画像の拡張子で終わる、ルートからのパス (// で始まる外部の URL は除く。クエリ・ハッシュは付いてよい) */
const ROOT_IMAGE_PATH = new RegExp(`^/(?!/)[^\\s?#]*\\.(?:${IMAGE_EXTENSIONS})(?:[?#]\\S*)?$`, 'i');
/** 構文木を作る前の絞り込み (画像の拡張子か src= を含むファイルだけ読む) */
const MAY_REFERENCE_IMAGE = new RegExp(`\\.(?:${IMAGE_EXTENSIONS})\\b|\\bsrc\\s*=`, 'i');
/** src を画像の URL として読む JSX の要素 (next/image を読み込んだ名前は、ファイルごとに足す) */
const IMAGE_ELEMENTS = ['img', 'source', 'Image'];
const NEXT_IMAGE_MODULES = new Set(['next/image', 'next/legacy/image']);

type ImageRef = { file: string; line: number; urlPath: string };

/** ファイルの中の、ルートからの静的な画像のパス (コメントの中は見ない) */
function scanImageSources(rel: string, text: string): ImageRef[] {
  const kind = /\.[cm]?[jt]sx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const elements = new Set(IMAGE_ELEMENTS);
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      NEXT_IMAGE_MODULES.has(statement.moduleSpecifier.text) &&
      statement.importClause?.name
    ) {
      elements.add(statement.importClause.name.text);
    }
  }
  const refs: ImageRef[] = [];
  const push = (node: ts.Node, value: string) => {
    if (!value.startsWith('/') || value.startsWith('//')) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    refs.push({ file: rel, line: line + 1, urlPath: value.split(/[?#]/)[0] });
  };
  /** 値の入らない文字列 ('/a.png'・`/a.png`) なら、その文字 */
  const staticText = (node: ts.Node | undefined): string | undefined =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'src') {
      const element = node.parent.parent;
      const tag = ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element) ? element.tagName.getText(source) : '';
      if (elements.has(tag)) {
        const init = node.initializer;
        const value = init && ts.isJsxExpression(init) ? staticText(init.expression) : staticText(init);
        if (value !== undefined) {
          push(node, value);
          return;
        }
      }
    }
    // import / export の読み込み先は画像のパスではない
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const value = staticText(node);
    if (value !== undefined && ROOT_IMAGE_PATH.test(value)) {
      push(node, value);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
}

/** 走査する範囲のファイル (リポジトリからの相対パス) */
function listScannedSources(dir: string = IMAGE_SCAN_DIR): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...listScannedSources(full));
    } else if (SCANNED_SOURCE.test(entry.name) && !SKIPPED_SOURCE.test(entry.name)) {
      files.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
  return files;
}

/** src/ の全部の、ルートからの静的な画像のパス */
function scanAllImageSources(): ImageRef[] {
  return listScannedSources().flatMap((rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return MAY_REFERENCE_IMAGE.test(text) ? scanImageSources(rel, text) : [];
  });
}

/** 使い方ガイド (src/app/guide/guide-content.ts) の手順の画像 15 枚。#1852 で public/guide/ に置いた */
const GUIDE_IMAGE_NAMES = [
  'signup',
  'profile',
  'ready',
  'camera',
  'analyze',
  'comment',
  'menu-request',
  'menu-setting',
  'menu-result',
  'weight',
  'weight-photo',
  'trend',
  'badge-get',
  'badge-collection',
  'badge-rare',
] as const;

/**
 * 実在しないが、今は止めないパスと理由。画像を置いて実在するようになったら、一覧から外す
 * (下の「既知の例外の一覧は今も実在せず、今もコードが指している」が外し忘れを赤にする)。
 */
// #1852 で使い方ガイドの画像 15 枚を public/guide/ に置いたので、いまは空 (15 枚は tests/guide-images-1852.test.ts も固定する)。
const KNOWN_MISSING_IMAGE_PATHS: ReadonlyMap<string, string> = new Map<string, string>();

const GUIDE_IMAGE_PATHS = GUIDE_IMAGE_NAMES.map((name) => `/guide/${name}.png`);

const describeRef = ({ file, line, urlPath }: ImageRef) => `${file}:${line}  ${urlPath}`;

describe('#1853 画面のコードが指す、ルートからの静的な画像のパスの実在', () => {
  const refs = scanAllImageSources();

  it('走査が空振りしていない (layout のアイコン・アプリのアイコンの定数・使い方ガイドの画像を拾う)', () => {
    const paths = refs.map(({ urlPath }) => urlPath);
    expect(paths).toEqual(
      expect.arrayContaining(['/favicon.ico', '/icon.svg', '/apple-touch-icon.png', APP_ICON_192_PATH, ...GUIDE_IMAGE_PATHS]),
    );
    expect(refs.some(({ file }) => file === 'src/lib/brand-asset-paths.ts')).toBe(true);
  });

  it('すべて public のファイル・app のファイル・app の route のどれかで返る (既知の例外を除く)', () => {
    const missing = refs.filter(({ urlPath }) => !KNOWN_MISSING_IMAGE_PATHS.has(urlPath) && !resolvesToAsset(urlPath));
    expect(
      missing.map(describeRef),
      '存在しない画像を指している (本番で 404)。public/ に置くか、src/app/<パス>/route.ts で返すか、実在するパス (例: src/lib/brand-asset-paths.ts) を指すこと',
    ).toEqual([]);
  });

  it('すべて src/proxy.ts の matcher の外 (未ログインでも画像の代わりにログイン画面が返らない)', () => {
    const proxied = refs.filter(({ urlPath }) => runsMiddleware(urlPath));
    expect(proxied.map(describeRef)).toEqual([]);
  });

  it('既知の例外の一覧は今も実在せず、今もコードが指している (画像を置いたら一覧から外す)', () => {
    const referenced = new Set(refs.map(({ urlPath }) => urlPath));
    for (const [urlPath, reason] of KNOWN_MISSING_IMAGE_PATHS) {
      expect(reason).not.toBe('');
      expect(resolvesToAsset(urlPath), `${urlPath} は実在するようになった。KNOWN_MISSING_IMAGE_PATHS から外すこと`).toBe(false);
      expect(referenced.has(urlPath), `${urlPath} はもうコードから指されていない。KNOWN_MISSING_IMAGE_PATHS から外すこと`).toBe(true);
    }
  });

  it('ハンズオンツアーの最初の画面のアイコンは、アプリのアイコンの定数 (実在する PNG) を指す', () => {
    const rel = 'src/app/handson-tour/page.tsx';
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imageSrcs: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Image') {
        for (const attr of node.attributes.properties) {
          if (ts.isJsxAttribute(attr) && attr.name.getText(source) === 'src' && attr.initializer) {
            imageSrcs.push(attr.initializer.getText(source));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(imageSrcs).toEqual(['{APP_ICON_192_PATH}']);
    expect(resolvesToAsset(APP_ICON_192_PATH)).toBe(true);
    expect(scanImageSources(rel, text).map(({ urlPath }) => urlPath)).not.toContain('/icon.png');
  });

  it('判定: 値の入らない src と画像のパスの文字列を拾い、コメント・値の入るパス・外部の URL・読み込み先は拾わない', () => {
    const fixture = [
      "import Pic from 'next/image';",
      "import logo from '/not-an-image-path.png';",
      '// <Image src="/in-comment.png" />',
      '/* const old = "/in-block-comment.png"; */',
      'const steps = [{ image: "/guide/x.png" }, { image: `/guide/${name}.png` }];',
      'const external = "https://example.test/a.png";',
      'const protocolRelative = "//cdn.example.test/a.png";',
      'const notImage = "/settings";',
      'export function A() {',
      '  return (',
      '    <div>',
      '      <Image src="/icon.png" alt="" width={96} height={96} />',
      "      <img src={'/legacy.webp'} alt=\"\" />",
      '      <Pic src={`/renamed.jpg?v=1`} alt="" />',
      '      <img src="/api/avatar" alt="" />',
      '      <Image src={dynamicSrc} alt="" />',
      '      <a href="/download">x</a>',
      '    </div>',
      '  );',
      '}',
    ].join('\n');
    const found = scanImageSources('fixture.tsx', fixture);
    expect(found.map(({ urlPath }) => urlPath).sort()).toEqual(
      ['/api/avatar', '/guide/x.png', '/icon.png', '/legacy.webp', '/renamed.jpg'].sort(),
    );
    expect(found.find(({ urlPath }) => urlPath === '/icon.png')?.line).toBe(12);
    // 以前のハンズオンツアーのパスは、実在しないとして止まる
    expect(found.filter(({ urlPath }) => !resolvesToAsset(urlPath)).map(({ urlPath }) => urlPath)).toContain('/icon.png');
  });
});
