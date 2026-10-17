// @vitest-environment node
/**
 * #1845: OGP / Twitter Card の画像とホーム画面のアイコンを PNG で返す
 *
 * 以前は src/app/layout.tsx が /og-image.png (openGraph.images・twitter.images) と /apple-touch-icon.png を、
 * public/manifest.json が /icon-192.png・/icon-512.png を指していたが、public/ には SVG しか無く、本番ではどれも 404 だった
 * (SNS でリンクを共有しても画像が出ない)。いまは next/og の ImageResponse で PNG を作る (src/lib/brand-image.tsx)。
 *
 * ここでは route を直接呼んで、次を確かめる:
 *   1. opengraph-image / twitter-image が 200・Content-Type image/png・1200×630 の PNG を返す。
 *      フォントを取れないとき (ネットワークの無いビルド) も PNG を返す (共有したときに 404 にしない)。
 *      フォントを取れたときは、画像に載る文字だけを Noto Sans JP の太さごとに取りに行く。
 *   2. apple-touch-icon.png / icon-192.png / icon-512.png が 200・image/png・指定の大きさの PNG を返す。
 *      大きさは layout の icons.apple の sizes・manifest.json の icons の sizes と同じ。
 *   3. layout の metadata が /og-image.png を指さず、画像は file convention に任せている。
 *      file convention の export (alt・size・contentType) と、layout の title・色が食い違っていない。
 *   4. 画像に載る文字にドメインが入っていない (#1573 の方針: 静的な画像にドメインを書かない)。
 *
 * 画像の見た目を目で確かめたいときは、OG_IMAGE_PREVIEW_DIR にディレクトリを指定して流すと、本物のフォントで描いた PNG を書き出す。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLE_TOUCH_ICON_SIZE,
  BRAND_COLORS,
  MANIFEST_ICON_SIZES,
  OG_IMAGE_ALT,
  OG_IMAGE_SIZE,
  OG_TEXT_BY_WEIGHT,
  renderOgImage,
} from '@/lib/brand-image';
import { OG_FONT_FAMILY } from '@/lib/og-font';
import { DEFAULT_SITE_URL, SITE_NAME, SITE_TAGLINE } from '@/lib/site-config';
import { applyHeavyUnitTestTimeout } from './helpers/heavy-unit-test-timeout';

// テストの中で route を丸ごと読み込み、next/og (wasm) で PNG を描く。負荷の高い機械で既定の 5 秒を超えないよう延ばす (#1605 と同じ型)
applyHeavyUnitTestTimeout();

// next/font/google は Next.js のビルド時にだけ使える (テストで呼ぶと失敗する) ので、フォント変数だけ返す偽物にする
vi.mock('next/font/google', () => ({
  Noto_Sans_JP: () => ({ variable: 'font-sans-test' }),
  Noto_Serif_JP: () => ({ variable: 'font-serif-test' }),
}));
vi.mock('@vercel/speed-insights/next', () => ({ SpeedInsights: () => null }));

// ImageResponse は本物のまま描かせ、渡された options (大きさ・フォント) だけを控える
const { imageResponseOptions } = vi.hoisted(() => ({ imageResponseOptions: [] as Array<Record<string, unknown>> }));
vi.mock('next/og', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/og')>();
  class RecordingImageResponse extends actual.ImageResponse {
    constructor(...args: ConstructorParameters<typeof actual.ImageResponse>) {
      super(...args);
      imageResponseOptions.push({ ...(args[1] ?? {}) });
    }
  }
  return { ...actual, ImageResponse: RecordingImageResponse };
});

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');

/** PNG の先頭 8 バイト (シグネチャ) */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** IHDR の幅・高さが入っている位置 (シグネチャ 8 + 長さ 4 + 種類 4 = 16 バイト目から 4 バイトずつ) */
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;

/** ソースからコメントを除いた本文 (説明のコメントに出てくる語を、コードとして数えないため) */
function codeWithoutComments(relativePath: string): string {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  return ts.createPrinter({ removeComments: true }).printFile(sourceFile);
}

type PngInfo = { status: number; contentType: string | null; width: number; height: number; bytes: Buffer };

async function readPng(response: Response): Promise<PngInfo> {
  const bytes = Buffer.from(await response.arrayBuffer());
  expect([...bytes.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    width: bytes.readUInt32BE(PNG_WIDTH_OFFSET),
    height: bytes.readUInt32BE(PNG_HEIGHT_OFFSET),
    bytes,
  };
}

/** next/og が同梱する英数字のフォント (Geist)。「Google Fonts から取れたフォント」の代わりに返す (satori が読める本物の TTF) */
function bundledTtf(): ArrayBuffer {
  const nextDir = path.dirname(require.resolve('next/package.json'));
  const data = fs.readFileSync(path.join(nextDir, 'dist/compiled/@vercel/og/Geist-Regular.ttf'));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

const FONT_FILE_URL = 'https://fonts.gstatic.com/s/notosansjp/test.ttf';

/** Google Fonts の CSS とフォント本体を返す偽の fetch。それ以外 (next/og 自身の取得) は 404 */
function fakeGoogleFontsFetch() {
  const ttf = bundledTtf();
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@')) {
      return new Response(`@font-face { font-family: 'Noto Sans JP'; src: url(${FONT_FILE_URL}) format('truetype'); }`, {
        status: 200,
      });
    }
    if (url === FONT_FILE_URL) return new Response(ttf.slice(0), { status: 200 });
    return new Response('not found', { status: 404 });
  });
}

describe('#1845 OGP / Twitter Card の画像 (opengraph-image / twitter-image)', () => {
  beforeEach(() => {
    // next/og は描けない文字のフォントを global の fetch で自分でも取りに行き、失敗すると console.error を出す (描画は続く)。
    // テストから本物のネットワークへ出ないよう、既定では global の fetch を失敗させる (差し替えるテストはその中で上書きする)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('テストではネットワークに出ない');
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it(
    'フォントを取れないとき (ネットワークの無いビルド) も、opengraph-image は 200・image/png・1200×630 の PNG を返す',
    async () => {
      const offline = vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
      vi.stubGlobal('fetch', offline);
      const { default: OpenGraphImage } = await import('@/app/opengraph-image');
      const png = await readPng(await OpenGraphImage());
      expect(png.status).toBe(200);
      expect(png.contentType).toBe('image/png');
      expect({ width: png.width, height: png.height }).toEqual({ width: 1200, height: 630 });
      // 自前の取得は試みている (Noto Sans JP の CSS)
      expect(offline.mock.calls.some(([url]) => String(url).startsWith('https://fonts.googleapis.com/css2?'))).toBe(true);
    },
  );

  it(
    'twitter-image も同じ大きさの PNG を返す',
    async () => {
      vi.stubGlobal('fetch', fakeGoogleFontsFetch());
      const { default: TwitterImage } = await import('@/app/twitter-image');
      const png = await readPng(await TwitterImage());
      expect(png.status).toBe(200);
      expect(png.contentType).toBe('image/png');
      expect({ width: png.width, height: png.height }).toEqual({ width: 1200, height: 630 });
    },
  );

  it(
    'フォントは、画像に載る文字だけを太さ (700 = サービス名・400 = 説明と機能の札) ごとに取りに行く',
    async () => {
      const fakeFetch = fakeGoogleFontsFetch();
      const png = await readPng(await renderOgImage(fakeFetch));
      expect(png.contentType).toBe('image/png');

      const cssUrls = fakeFetch.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.startsWith('https://fonts.googleapis.com/css2?'));
      const requested = cssUrls.map((url) => {
        const parsed = new URL(url);
        return { family: parsed.searchParams.get('family'), text: parsed.searchParams.get('text') };
      });
      expect(requested).toEqual(
        expect.arrayContaining([
          { family: 'Noto Sans JP:wght@700', text: SITE_NAME },
          { family: 'Noto Sans JP:wght@400', text: OG_TEXT_BY_WEIGHT[400] },
        ]),
      );
      // フォント本体も取りに行っている (CSS が指す fonts.gstatic.com の URL)
      expect(fakeFetch.mock.calls.filter(([url]) => String(url) === FONT_FILE_URL)).toHaveLength(2);
    },
  );

  it(
    '取れたフォントは太さごとに描画へ渡し、1 つも取れなければ fonts を渡さない (next/og の既定のフォントを外さない)',
    async () => {
      imageResponseOptions.length = 0;
      await readPng(await renderOgImage(fakeGoogleFontsFetch()));
      const withFont = imageResponseOptions.at(-1) as { fonts?: Array<{ name: string; weight: number; style: string; data: ArrayBuffer }> };
      expect(withFont.fonts?.map(({ name, weight, style }) => ({ name, weight, style }))).toEqual(
        expect.arrayContaining([
          { name: OG_FONT_FAMILY, weight: 700, style: 'normal' },
          { name: OG_FONT_FAMILY, weight: 400, style: 'normal' },
        ]),
      );
      expect(withFont.fonts).toHaveLength(2);
      expect(withFont.fonts?.every(({ data }) => data.byteLength > 0)).toBe(true);
      expect(withFont).toMatchObject({ width: 1200, height: 630 });

      await readPng(
        await renderOgImage(
          vi.fn(async () => {
            throw new TypeError('fetch failed');
          }),
        ),
      );
      const withoutFont = imageResponseOptions.at(-1) as Record<string, unknown>;
      expect('fonts' in withoutFont).toBe(false);
      expect(withoutFont).toMatchObject({ width: 1200, height: 630 });
    },
  );

  it(
    '片方の太さだけ取れたときは、取れた分だけ渡す',
    async () => {
      imageResponseOptions.length = 0;
      const base = fakeGoogleFontsFetch();
      const boldFails = vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('wght@700') ? new Response('error', { status: 500 }) : base(input),
      );
      await readPng(await renderOgImage(boldFails));
      const options = imageResponseOptions.at(-1) as { fonts?: Array<{ weight: number }> };
      expect(options.fonts?.map(({ weight }) => weight)).toEqual([400]);
    },
  );

  it('file convention の export は alt・1200×630・image/png で、静的に作る', async () => {
    for (const imageModule of [await import('@/app/opengraph-image'), await import('@/app/twitter-image')]) {
      expect(imageModule.alt).toBe(`${SITE_NAME} - ${SITE_TAGLINE}`);
      expect(imageModule.size).toEqual({ width: 1200, height: 630 });
      expect(imageModule.contentType).toBe('image/png');
      expect(imageModule.dynamic).toBe('force-static');
    }
    expect(OG_IMAGE_SIZE).toEqual({ width: 1200, height: 630 });
    expect(OG_IMAGE_ALT).toBe(`${SITE_NAME} - ${SITE_TAGLINE}`);
  });
});

/** アイコンの route (import のパスは静的に書く。変数の import は別名 @/ の解決を通らないことがあるため) */
const ICON_ROUTES = [
  { name: 'apple-touch-icon.png', load: () => import('@/app/apple-touch-icon.png/route'), size: APPLE_TOUCH_ICON_SIZE, expected: 180 },
  { name: 'icon-192.png', load: () => import('@/app/icon-192.png/route'), size: MANIFEST_ICON_SIZES.small, expected: 192 },
  { name: 'icon-512.png', load: () => import('@/app/icon-512.png/route'), size: MANIFEST_ICON_SIZES.large, expected: 512 },
];

describe('#1845 ホーム画面のアイコン (apple-touch-icon.png / icon-192.png / icon-512.png)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf8')) as {
    icons: Array<{ src: string; sizes: string; type: string }>;
  };

  it.each(ICON_ROUTES)(
    '$name は 200・image/png・$expected×$expected の PNG を返し、静的に作る',
    async ({ load, size, expected }) => {
      expect(size).toBe(expected);
      const routeModule = await load();
      expect(routeModule.dynamic).toBe('force-static');
      const png = await readPng(routeModule.GET());
      expect(png.status).toBe(200);
      expect(png.contentType).toBe('image/png');
      expect({ width: png.width, height: png.height }).toEqual({ width: expected, height: expected });
    },
  );

  it('manifest.json の icons は、route が返す PNG の URL・大きさ・種類と一致する', () => {
    expect(manifest.icons.map(({ src, sizes, type }) => ({ src, sizes, type }))).toEqual([
      { src: '/icon-192.png', sizes: `${MANIFEST_ICON_SIZES.small}x${MANIFEST_ICON_SIZES.small}`, type: 'image/png' },
      { src: '/icon-512.png', sizes: `${MANIFEST_ICON_SIZES.large}x${MANIFEST_ICON_SIZES.large}`, type: 'image/png' },
    ]);
  });
});

describe('#1845 layout の metadata と画像の食い違い', () => {
  it('openGraph.images / twitter.images を書かず、file convention (opengraph-image / twitter-image) に任せる', async () => {
    const { metadata } = await import('@/app/layout');
    expect(metadata.openGraph).toBeDefined();
    expect(metadata.openGraph && 'images' in metadata.openGraph).toBe(false);
    expect(metadata.twitter).toBeDefined();
    expect(metadata.twitter && 'images' in metadata.twitter).toBe(false);
    // file convention の画像は metadataBase を前に付けた絶対 URL になる (metadataBase が無いと Next が警告して localhost にする)
    expect(metadata.metadataBase).toBeInstanceOf(URL);
    const layoutCode = codeWithoutComments('src/app/layout.tsx');
    expect(layoutCode).toContain('metadataBase'); // コメントを除いた本文を読めている
    expect(layoutCode).not.toContain('/og-image.png');
  });

  it('icons.apple の大きさは apple-touch-icon.png の route が返す大きさと同じ', async () => {
    const { metadata } = await import('@/app/layout');
    const icons = metadata.icons as { apple: Array<{ url: string; sizes: string }> };
    expect(icons.apple).toEqual([
      { url: '/apple-touch-icon.png', sizes: `${APPLE_TOUCH_ICON_SIZE}x${APPLE_TOUCH_ICON_SIZE}` },
    ]);
  });

  it('ページの title・サイト名は、画像に載せるサービス名・説明と同じ文字', async () => {
    const { metadata } = await import('@/app/layout');
    expect(metadata.title).toMatchObject({ default: `${SITE_NAME} | ${SITE_TAGLINE}` });
    expect(metadata.openGraph?.siteName).toBe(SITE_NAME);
    expect(OG_TEXT_BY_WEIGHT[700]).toBe(SITE_NAME);
    expect(OG_TEXT_BY_WEIGHT[400].startsWith(SITE_TAGLINE)).toBe(true);
  });

  it('画像の色は、manifest.json の theme_color / background_color と layout の themeColor と同じ', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf8')) as {
      theme_color: string;
      background_color: string;
    };
    expect(BRAND_COLORS.accent).toBe(manifest.theme_color);
    expect(BRAND_COLORS.background).toBe(manifest.background_color);
    const { viewport } = await import('@/app/layout');
    const themeColors = (viewport.themeColor as Array<{ color: string }>).map(({ color }) => color);
    expect(new Set(themeColors)).toEqual(new Set([BRAND_COLORS.accent]));
  });
});

describe('#1845 画像にドメインを書かない (#1573 の方針)', () => {
  it('画像に載る文字に、サイトの URL のホスト名・ドメインらしい文字が入っていない', () => {
    const allText = Object.values(OG_TEXT_BY_WEIGHT).join('\n');
    expect(allText).not.toContain(new URL(DEFAULT_SITE_URL).hostname);
    expect(allText).not.toMatch(/homegohan|https?:|www\.|\.(?:app|jp|com)\b/i);
  });

  it('画像を作るファイルは、サイトの URL (getSiteUrl) を読まない', () => {
    for (const file of ['src/lib/brand-image.tsx', 'src/app/opengraph-image.tsx', 'src/app/twitter-image.tsx']) {
      expect(codeWithoutComments(file)).not.toMatch(/getSiteUrl|DEFAULT_SITE_URL|NEXT_PUBLIC_APP_URL/);
    }
  });

  it('フォントの名前は Noto Sans JP (layout の本文のフォントと同じ書体)', () => {
    expect(OG_FONT_FAMILY).toBe('Noto Sans JP');
  });
});

// 見た目の確認用 (ふだんは流れない)。OG_IMAGE_PREVIEW_DIR=<dir> を付けて流すと、本物の Google Fonts で描いた PNG を書き出す
describe.runIf(Boolean(process.env.OG_IMAGE_PREVIEW_DIR))('#1845 画像の書き出し (目で確かめる用)', () => {
  it(
    'opengraph-image と 3 つのアイコンを書き出す',
    async () => {
      const dir = String(process.env.OG_IMAGE_PREVIEW_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const { default: OpenGraphImage } = await import('@/app/opengraph-image');
      fs.writeFileSync(path.join(dir, 'opengraph-image.png'), Buffer.from(await (await OpenGraphImage()).arrayBuffer()));
      for (const { name, load } of ICON_ROUTES) {
        const routeModule = await load();
        fs.writeFileSync(path.join(dir, name), Buffer.from(await routeModule.GET().arrayBuffer()));
      }
    },
  );
});
