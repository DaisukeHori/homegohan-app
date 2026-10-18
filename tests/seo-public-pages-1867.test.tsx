// @vitest-environment node
/**
 * #1867: 本サイトとして公開する前の、検索まわりの穴埋め
 *
 * 以前は:
 *   1. ルートの layout の `alternates.canonical: '/'` と `openGraph.url` が全ページに引き継がれ、どのページも canonical が「/」だった。
 *   2. /sitemap.xml が無かった (src/app/robots.ts は指していた)。作っても、未ログインは proxy が /login へ回す。
 *   3. 公開ページに、ページごとの title・description・canonical が無かった。
 *   4. 構造化データ (JSON-LD の Organization・WebSite) が無かった。
 *
 * ここで固定すること:
 *   - 公開ページ (src/lib/seo/public-pages.ts の PUBLIC_PAGE_PATHS) ごとに、canonical と og:url が自分のパスを指す。
 *     URL はルートの layout の metadataBase (NEXT_PUBLIC_APP_URL) から作られ、ドメインを直接書かない。
 *   - ルートの layout は canonical と og:url を持たない (引き継がせない)。
 *   - 公開ページのメタ情報を持つファイル (page か、'use client' の page なら同じフォルダの layout) が、自分のパスで
 *     publicPageMetadata を呼んでいる。公開ページの配下に page を足したら、PUBLIC_PAGE_PATHS への登録を求める。
 *   - sitemap が公開ページを全部含み、ログインが要るページとアプリの入口を含まない。/sitemap.xml と /robots.txt は
 *     proxy の matcher の外 (未ログインでも /login へ回されず 200)。robots の Sitemap の URL は NEXT_PUBLIC_APP_URL から作る。
 *   - トップに JSON-LD (Organization と WebSite) が出て、事業者名・サービス名・URL が business-info / site-config から来る。
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '@/proxy';
import {
  APP_ICON_512_PATH,
  OG_IMAGE_ALT,
  OG_IMAGE_CONTENT_TYPE,
  OG_IMAGE_PATH,
  OG_IMAGE_SIZE,
  TWITTER_IMAGE_PATH,
} from '@/lib/brand-asset-paths';
import { BUSINESS_NAME } from '@/lib/business-info';
import {
  APP_ENTRY_PUBLIC_PATHS,
  PUBLIC_PAGE_PATHS,
  PUBLIC_PAGE_SEO,
  SITE_DEFAULT_TITLE,
  SITE_DESCRIPTION,
  publicPageFullTitle,
  publicPageMetadata,
  type PublicPagePath,
} from '@/lib/seo/public-pages';
import { SCHEMA_ORG_CONTEXT, buildSiteJsonLd, serializeJsonLd } from '@/lib/seo/json-ld';
import { DEFAULT_SITE_URL, SITE_NAME } from '@/lib/site-config';
import { SiteStructuredData } from '@/components/seo/SiteStructuredData';

vi.mock('next/font/google', () => ({
  Noto_Sans_JP: () => ({ variable: 'font-sans-test' }),
  Noto_Serif_JP: () => ({ variable: 'font-serif-test' }),
}));
vi.mock('@vercel/speed-insights/next', () => ({ SpeedInsights: () => null }));

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'src/app');
const MIDDLEWARE_FILE = 'lib/supabase/middleware.ts';

/** テストで使う、例示用のサイトの URL (実在しないドメイン。tests/site-config-guard.test.ts の方針) */
const EXAMPLE_SITE_URL = 'https://example.test';

/** ログインが要るページの例 (sitemap に入ってはいけない。どれも middleware の publicPaths の外) */
const AUTH_REQUIRED_PATH_EXAMPLES = ['/home', '/meals/new', '/menus/weekly', '/settings', '/profile', '/health', '/handson-tour'];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** matcher を正規表現にして判定する (tests/health-middleware-exemption.test.ts と同じ方法) */
function runsMiddleware(pathname: string): boolean {
  const [matcher] = config.matcher;
  return new RegExp(`^${matcher}$`).test(pathname);
}

function parse(relativePath: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** lib/supabase/middleware.ts の `const publicPaths = [...]` の文字列 (構文木で読む。コメントは見ない) */
function middlewarePublicPaths(): string[] {
  const source = parse(MIDDLEWARE_FILE);
  const found: string[][] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'publicPaths' &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found.push(node.initializer.elements.filter(ts.isStringLiteral).map((element) => element.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(found, `${MIDDLEWARE_FILE} に const publicPaths = [...] が 1 つだけある`).toHaveLength(1);
  return found[0];
}

/** middleware の isPublicPath と同じ判定 (ちょうど一致か、`<パス>/` で始まる) */
function isPublicForMiddleware(pathname: string, publicPaths: readonly string[]): boolean {
  return publicPaths.some((publicPath) => pathname === publicPath || pathname.startsWith(`${publicPath}/`));
}

/** ファイルの先頭の指令が 'use client' か */
function isClientModule(relativePath: string): boolean {
  const source = parse(relativePath);
  const [first] = source.statements;
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  );
}

/** `export const metadata = publicPageMetadata('<パス>')` の <パス>。無ければ null */
function publicPageMetadataArgument(relativePath: string): string | null {
  const source = parse(relativePath);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'metadata') continue;
      const init = declaration.initializer;
      if (
        init !== undefined &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === 'publicPageMetadata' &&
        init.arguments.length === 1 &&
        ts.isStringLiteralLike(init.arguments[0])
      ) {
        return init.arguments[0].text;
      }
    }
  }
  return null;
}

/** URL のパス → そのページの page.tsx (src/app からの相対。route group は無い前提のパスだけを扱う) */
function pageFileOf(pagePath: PublicPagePath): string {
  return pagePath === '/' ? 'src/app/page.tsx' : `src/app${pagePath}/page.tsx`;
}

/** メタ情報を持つファイル。'use client' の page は metadata を export できないので、同じフォルダの layout */
function metadataOwnerOf(pagePath: PublicPagePath): string {
  const pageFile = pageFileOf(pagePath);
  return isClientModule(pageFile) ? pageFile.replace(/page\.tsx$/, 'layout.tsx') : pageFile;
}

/** src/app の page.tsx を、URL のパスと一緒に列挙する (route group の (…) はパスに出さない) */
function listAppPages(dir: string = APP_DIR, segments: string[] = []): Array<{ file: string; route: string }> {
  const pages: Array<{ file: string; route: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
      pages.push(...listAppPages(full, isGroup ? segments : [...segments, entry.name]));
    } else if (entry.name === 'page.tsx' || entry.name === 'page.ts') {
      pages.push({ file: path.relative(ROOT, full), route: segments.length === 0 ? '/' : `/${segments.join('/')}` });
    }
  }
  return pages;
}

describe('#1867 公開ページの一覧', () => {
  it('PUBLIC_PAGE_PATHS は重複が無く、全部に title と description があり、title と description はページごとに違う', () => {
    expect(new Set(PUBLIC_PAGE_PATHS).size).toBe(PUBLIC_PAGE_PATHS.length);
    expect(Object.keys(PUBLIC_PAGE_SEO).sort()).toEqual([...PUBLIC_PAGE_PATHS].sort());
    const titles = PUBLIC_PAGE_PATHS.map((pagePath) => publicPageFullTitle(pagePath));
    const descriptions = PUBLIC_PAGE_PATHS.map((pagePath) => PUBLIC_PAGE_SEO[pagePath].description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    for (const description of descriptions) expect(description.trim()).not.toBe('');
    // トップだけ title を持たず、サイトの既定の title をそのまま出す
    expect(PUBLIC_PAGE_SEO['/'].title).toBeNull();
    expect(publicPageFullTitle('/')).toBe(SITE_DEFAULT_TITLE);
    expect(publicPageFullTitle('/about')).toBe(`ほめゴハンについて | ${SITE_NAME}`);
  });

  it('公開ページは全部、middleware の publicPaths の下 (未ログインでも開ける) で、page.tsx が実在する', () => {
    const publicPaths = middlewarePublicPaths();
    for (const pagePath of PUBLIC_PAGE_PATHS) {
      expect(isPublicForMiddleware(pagePath, publicPaths), `${pagePath} が publicPaths の外 (未ログインは /login へ回される)`).toBe(true);
      expect(fs.existsSync(path.join(ROOT, pageFileOf(pagePath))), `${pageFileOf(pagePath)} が無い`).toBe(true);
    }
  });

  it('middleware の publicPaths は、公開ページかアプリの入口のどちらかに分けてある (publicPaths に足したら、どちらかに載せる)', () => {
    const classified = new Set<string>([...PUBLIC_PAGE_PATHS, ...APP_ENTRY_PUBLIC_PATHS]);
    const unclassified = middlewarePublicPaths().filter((publicPath) => !classified.has(publicPath));
    expect(unclassified, 'src/lib/seo/public-pages.ts の PUBLIC_PAGE_PATHS か APP_ENTRY_PUBLIC_PATHS に載せる').toEqual([]);
    // 両方に載っているものは無い
    expect(PUBLIC_PAGE_PATHS.filter((pagePath) => (APP_ENTRY_PUBLIC_PATHS as readonly string[]).includes(pagePath))).toEqual([]);
  });

  it('公開ページの配下 (トップを除く) にある page は、どれも PUBLIC_PAGE_PATHS に載っている (載せないと親の layout の canonical を引き継ぐ)', () => {
    const nestedRoots = PUBLIC_PAGE_PATHS.filter((pagePath) => pagePath !== '/');
    const nested = listAppPages().filter(({ route }) => nestedRoots.some((root) => route === root || route.startsWith(`${root}/`)));
    // 走査が空振りしていない
    expect(nested.map(({ route }) => route)).toEqual(expect.arrayContaining(['/about', '/legal', '/legal/parental-consent']));
    const unregistered = nested.filter(({ route }) => !(PUBLIC_PAGE_PATHS as readonly string[]).includes(route));
    expect(unregistered.map(({ file }) => file)).toEqual([]);
  });
});

describe('#1867 公開ページごとの canonical・og:url・title・description', () => {
  it.each(PUBLIC_PAGE_PATHS)('%s: メタ情報を持つファイルが、自分のパスで publicPageMetadata を呼んでいる', (pagePath) => {
    const owner = metadataOwnerOf(pagePath);
    expect(fs.existsSync(path.join(ROOT, owner)), `${owner} が無い`).toBe(true);
    expect(isClientModule(owner), `${owner} は 'use client' (metadata を export できない)`).toBe(false);
    expect(publicPageMetadataArgument(owner), `${owner} の export const metadata`).toBe(pagePath);
  });

  it.each(PUBLIC_PAGE_PATHS)('%s: canonical と og:url が自分のパスを指し、metadataBase (NEXT_PUBLIC_APP_URL) で絶対 URL になる', async (pagePath) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', EXAMPLE_SITE_URL);
    vi.resetModules();
    const { metadata: rootMetadata } = await import('@/app/layout');
    const metadata = publicPageMetadata(pagePath);
    expect(metadata.alternates?.canonical).toBe(pagePath);
    expect(metadata.openGraph?.url).toBe(pagePath);
    const base = rootMetadata.metadataBase;
    expect(base).toBeInstanceOf(URL);
    // Next は相対の canonical / og:url に metadataBase を前に付ける
    expect(new URL(pagePath, base ?? undefined).href).toBe(new URL(pagePath, `${EXAMPLE_SITE_URL}/`).href);
    expect(metadata.description).toBe(PUBLIC_PAGE_SEO[pagePath].description);
    expect(metadata.openGraph?.description).toBe(PUBLIC_PAGE_SEO[pagePath].description);
    expect(metadata.openGraph?.title).toBe(publicPageFullTitle(pagePath));
    expect(metadata.twitter?.title).toBe(publicPageFullTitle(pagePath));
  });

  it.each(PUBLIC_PAGE_PATHS)('%s: 子で openGraph / twitter を書くと file convention の画像が消えるので、画像の URL を明示している', (pagePath) => {
    const metadata = publicPageMetadata(pagePath);
    const expectedImage = { ...OG_IMAGE_SIZE, alt: OG_IMAGE_ALT, type: OG_IMAGE_CONTENT_TYPE };
    expect(metadata.openGraph?.images).toEqual([{ url: OG_IMAGE_PATH, ...expectedImage }]);
    expect(metadata.twitter?.images).toEqual([{ url: TWITTER_IMAGE_PATH, ...expectedImage }]);
    // ルートの layout の openGraph / twitter の値も書き直している (子は丸ごと置き換えるため)
    expect(metadata.openGraph).toMatchObject({ siteName: SITE_NAME, locale: 'ja_JP', type: 'website' });
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
  });

  it('トップは title.template を使わず、サイトの既定の title と説明を出す', () => {
    const metadata = publicPageMetadata('/');
    expect(metadata.title).toEqual({ absolute: SITE_DEFAULT_TITLE });
    expect(metadata.description).toBe(SITE_DESCRIPTION);
  });

  it.each(PUBLIC_PAGE_PATHS)(
    '%s: title は absolute でサービス名まで付けて渡す (親の layout の title が文字列だと template が配下に効かないため)',
    (pagePath) => {
      expect(publicPageMetadata(pagePath).title).toEqual({ absolute: publicPageFullTitle(pagePath) });
    },
  );

  it('サービス名の付け方は、ルートの layout の title.template と同じ', async () => {
    const { metadata: rootMetadata } = await import('@/app/layout');
    expect(rootMetadata.title).toEqual({ default: SITE_DEFAULT_TITLE, template: `%s | ${SITE_NAME}` });
    expect(publicPageFullTitle('/faq')).toBe(`%s | ${SITE_NAME}`.replace('%s', 'よくある質問'));
    expect(publicPageFullTitle('/legal/parental-consent')).toBe(`保護者の同意書 | ${SITE_NAME}`);
  });

  it('ルートの layout は canonical と og:url を持たない (全ページに「/」を引き継がせない)', async () => {
    const { metadata } = await import('@/app/layout');
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).toBeDefined();
    expect(metadata.openGraph && 'url' in metadata.openGraph).toBe(false);
  });

  it('OGP / Twitter Card の画像の URL は file convention の画像の route で、大きさ・代替テキスト・形式が画像の route と同じ', async () => {
    expect(fs.existsSync(path.join(APP_DIR, `${OG_IMAGE_PATH.slice(1)}.tsx`))).toBe(true);
    expect(fs.existsSync(path.join(APP_DIR, `${TWITTER_IMAGE_PATH.slice(1)}.tsx`))).toBe(true);
    const og = await import('@/app/opengraph-image');
    const twitter = await import('@/app/twitter-image');
    for (const imageModule of [og, twitter]) {
      expect(imageModule.size).toEqual(OG_IMAGE_SIZE);
      expect(imageModule.alt).toBe(OG_IMAGE_ALT);
      expect(imageModule.contentType).toBe(OG_IMAGE_CONTENT_TYPE);
    }
    // 未ログインのクローラーが開ける (proxy の matcher の外)
    expect(runsMiddleware(OG_IMAGE_PATH)).toBe(false);
    expect(runsMiddleware(TWITTER_IMAGE_PATH)).toBe(false);
  });
});

describe('#1867 sitemap と robots', () => {
  it('sitemap は公開ページを全部、NEXT_PUBLIC_APP_URL の絶対 URL で並べる', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', EXAMPLE_SITE_URL);
    vi.resetModules();
    const { default: sitemap } = await import('@/app/sitemap');
    const urls = sitemap().map(({ url }) => url);
    expect(urls).toEqual(PUBLIC_PAGE_PATHS.map((pagePath) => `${EXAMPLE_SITE_URL}${pagePath}`));
    expect(urls).toContain(`${EXAMPLE_SITE_URL}/`);
    expect(urls).toContain(`${EXAMPLE_SITE_URL}/privacy`);
  });

  it('NEXT_PUBLIC_APP_URL が無いときは、既定のサイトの URL で並べる', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.resetModules();
    const { default: sitemap } = await import('@/app/sitemap');
    expect(sitemap()[0]?.url).toBe(`${DEFAULT_SITE_URL}/`);
  });

  it('sitemap にログインが要るページとアプリの入口が入っていない (どれも未ログインで開ける公開ページだけ)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', EXAMPLE_SITE_URL);
    vi.resetModules();
    const { default: sitemap } = await import('@/app/sitemap');
    const sitemapPaths = sitemap().map(({ url }) => new URL(url).pathname);
    const publicPaths = middlewarePublicPaths();
    for (const sitemapPath of sitemapPaths) {
      expect(isPublicForMiddleware(sitemapPath, publicPaths), `${sitemapPath} はログインが要る`).toBe(true);
    }
    for (const authRequired of AUTH_REQUIRED_PATH_EXAMPLES) {
      // 例そのものがログインの要るページであること (例の取り違えを防ぐ)
      expect(isPublicForMiddleware(authRequired, publicPaths)).toBe(false);
      expect(sitemapPaths).not.toContain(authRequired);
    }
    for (const entry of APP_ENTRY_PUBLIC_PATHS) {
      expect(sitemapPaths.some((sitemapPath) => sitemapPath === entry || sitemapPath.startsWith(`${entry}/`))).toBe(false);
    }
  });

  it('/sitemap.xml と /robots.txt は proxy の matcher の外 (未ログインでも /login へ回されず、そのまま 200 で返る)', () => {
    expect(runsMiddleware('/sitemap.xml')).toBe(false);
    expect(runsMiddleware('/robots.txt')).toBe(false);
    // ちょうど /sitemap.xml だけを外す (似た名前のパスは従来どおり proxy を通る)
    expect(runsMiddleware('/sitemap.xml/extra')).toBe(true);
    expect(runsMiddleware('/sitemaps')).toBe(true);
    // 公開ページそのものは従来どおり proxy を通る (CSP の nonce が要る文書)
    expect(runsMiddleware('/')).toBe(true);
    expect(runsMiddleware('/about')).toBe(true);
  });

  it('robots の Sitemap の URL は NEXT_PUBLIC_APP_URL から作る', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', EXAMPLE_SITE_URL);
    vi.resetModules();
    const { default: robots } = await import('@/app/robots');
    expect(robots().sitemap).toBe(`${EXAMPLE_SITE_URL}/sitemap.xml`);
  });

  it('robots の Sitemap の URL は、NEXT_PUBLIC_APP_URL が無いとき既定のサイトの URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.resetModules();
    const { default: robots } = await import('@/app/robots');
    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}/sitemap.xml`);
  });
});

describe('#1867 トップの構造化データ (JSON-LD)', () => {
  it('Organization と WebSite を持ち、事業者名・サービス名・URL は business-info / site-config から来る', () => {
    const document = buildSiteJsonLd(EXAMPLE_SITE_URL);
    expect(document['@context']).toBe(SCHEMA_ORG_CONTEXT);
    const graph = document['@graph'];
    expect(Array.isArray(graph)).toBe(true);
    expect(graph).toEqual([
      {
        '@type': 'Organization',
        '@id': `${EXAMPLE_SITE_URL}/#organization`,
        name: BUSINESS_NAME,
        url: `${EXAMPLE_SITE_URL}/`,
        logo: `${EXAMPLE_SITE_URL}${APP_ICON_512_PATH}`,
      },
      {
        '@type': 'WebSite',
        '@id': `${EXAMPLE_SITE_URL}/#website`,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        url: `${EXAMPLE_SITE_URL}/`,
        inLanguage: 'ja',
        publisher: { '@id': `${EXAMPLE_SITE_URL}/#organization` },
      },
    ]);
    // logo の画像は実在する route (src/app/icon-512.png/route.ts) で、未ログインでも開ける
    expect(fs.existsSync(path.join(APP_DIR, APP_ICON_512_PATH.slice(1), 'route.ts'))).toBe(true);
    expect(runsMiddleware(APP_ICON_512_PATH)).toBe(false);
  });

  it('serializeJsonLd は script 要素を閉じる文字を \\uXXXX にし、JSON として読むと元の値に戻る', () => {
    const tricky = { name: '</script><script>alert(1)</script> & \u2028\u2029' };
    const serialized = serializeJsonLd(tricky);
    expect(serialized).not.toContain('<');
    expect(serialized).not.toContain('>');
    expect(serialized).not.toContain('&');
    expect(serialized).not.toContain('\u2028');
    expect(serialized).not.toContain('\u2029');
    expect(JSON.parse(serialized)).toEqual(tricky);
    const site = buildSiteJsonLd(EXAMPLE_SITE_URL);
    expect(JSON.parse(serializeJsonLd(site))).toEqual(site);
  });

  it('SiteStructuredData は nonce つきの <script type="application/ld+json"> を 1 本出す', () => {
    const html = renderToStaticMarkup(createElement(SiteStructuredData, { siteUrl: EXAMPLE_SITE_URL, nonce: 'test-nonce' }));
    const match = /^<script type="application\/ld\+json" nonce="test-nonce">([\s\S]*)<\/script>$/.exec(html);
    expect(match, html).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? '')).toEqual(buildSiteJsonLd(EXAMPLE_SITE_URL));
    // nonce が無い (proxy の外) ときは属性を出さない
    const withoutNonce = renderToStaticMarkup(createElement(SiteStructuredData, { siteUrl: EXAMPLE_SITE_URL, nonce: null }));
    expect(withoutNonce).not.toContain('nonce');
  });

  it('トップ (src/app/page.tsx) は、このリクエストの nonce と NEXT_PUBLIC_APP_URL で JSON-LD を出し、画面の本体を続けて描く', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', EXAMPLE_SITE_URL);
    vi.resetModules();
    vi.doMock('next/headers', () => ({
      headers: async () => new Headers({ 'x-csp-nonce': 'request-nonce' }),
    }));
    vi.doMock('@/app/LandingPageView', () => ({ default: () => createElement('main', { id: 'landing' }) }));
    try {
      const { default: HomePage, metadata } = await import('@/app/page');
      const html = renderToStaticMarkup(await HomePage());
      expect(html).toContain('<script type="application/ld+json" nonce="request-nonce">');
      expect(html).toContain(`"name":"${BUSINESS_NAME}"`);
      expect(html).toContain(`"url":"${EXAMPLE_SITE_URL}/"`);
      expect(html).toContain('<main id="landing"></main>');
      expect(metadata.alternates?.canonical).toBe('/');
    } finally {
      vi.doUnmock('next/headers');
      vi.doUnmock('@/app/LandingPageView');
    }
  });

  it('画面の本体 (LandingPageView.tsx) はクライアントコンポーネントのまま、殻 (page.tsx) は Server Component', () => {
    expect(isClientModule('src/app/LandingPageView.tsx')).toBe(true);
    expect(isClientModule('src/app/page.tsx')).toBe(false);
  });
});
