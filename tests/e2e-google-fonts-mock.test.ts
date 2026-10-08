// @vitest-environment node
/**
 * e2e-local のビルドで使う Google Fonts のモック (tests/e2e/fixtures/google-fonts-mock.cjs) が、
 * 今の Next.js の next/font/google で効くことを確かめる (#1330)。
 *
 * モックは next/font の内部の仕組み (環境変数 NEXT_FONT_GOOGLE_MOCKED_RESPONSES) に頼っている。
 * Next.js を上げてこの仕組みが変わったら、e2e-local のビルドが再び Google Fonts へ取りに行き、
 * 取得に失敗するとビルドが落ちる。その前にこのテストで気づけるようにする。
 *
 * next build の中では、(1) next/font/google のローダーが CSS を作り、(2) postcss-next-font が
 * その CSS を検査・変換する。どちらか片方だけ通っても、ビルドは通らない (2 で
 * "Font loaders must return one or more @font-face's" になった実例がある)。そのため両方を通す。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const MOCK_PATH = path.resolve(__dirname, 'e2e/fixtures/google-fonts-mock.cjs');

type LoaderResult = {
  css: string;
  variable?: string;
  weight?: string;
  style?: string;
  fallbackFonts?: string[];
  adjustFontFallback?: unknown;
};

type GoogleFontLoader = (args: {
  functionName: string;
  data: unknown[];
  emitFontFile: (content: Buffer, ext: string, preload: boolean, isUsingSizeAdjust?: boolean) => string;
  isDev: boolean;
  isServer: boolean;
}) => Promise<LoaderResult>;

type PostcssNextFontPlugin = (options: {
  exports: Array<{ name: string; value: string }>;
  fontFamilyHash: string;
  fallbackFonts?: string[];
  adjustFontFallback?: unknown;
  variable?: string;
  weight?: string;
  style?: string;
}) => postcss.Plugin;

const loader: GoogleFontLoader = require('next/dist/compiled/@next/font/dist/google/loader.js').default;
const postcssNextFont: PostcssNextFontPlugin =
  require('next/dist/build/webpack/loaders/next-font-loader/postcss-next-font.js').default;
const mock: Record<string, string | undefined> = require(MOCK_PATH);

/** TrueType フォントの先頭 4 バイト */
const TRUETYPE_MAGIC = Buffer.from([0x00, 0x01, 0x00, 0x00]);

describe('Google Fonts のモック (e2e-local のビルド用)', () => {
  const previous = process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES;

  beforeEach(() => {
    process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = MOCK_PATH;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES;
    else process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = previous;
  });

  // src/app/layout.tsx と同じ指定
  it.each([
    ['Noto_Sans_JP', { subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-sans' }, 'Noto Sans JP', 3],
    ['Noto_Serif_JP', { subsets: ['latin'], weight: ['400', '700'], variable: '--font-serif' }, 'Noto Serif JP', 2],
  ])(
    '%s: Google Fonts へ取りに行かず、同梱の実フォント 1 つで、next build の検査を通る CSS を作る',
    async (functionName, options, family, weightCount) => {
      const emitFontFile = vi.fn((_content: Buffer, ext: string) => `/_next/static/media/mock.${ext}`);

      const result = await loader({ functionName, data: [options], emitFontFile, isDev: false, isServer: true });

      // 同じローカルファイルを指すので、作られるフォントファイルは 1 つ。中身は実際の TrueType
      expect(emitFontFile).toHaveBeenCalledTimes(1);
      const [content, ext, preload] = emitFontFile.mock.calls[0];
      expect(ext).toBe('ttf');
      expect(content.subarray(0, 4).equals(TRUETYPE_MAGIC)).toBe(true);
      expect(preload).toBe(true);

      // 要求した太さの数だけ @font-face があり、Google への URL もローカルのパスも残らない
      expect(result.css.match(/@font-face/g)).toHaveLength(weightCount);
      expect(result.css).toContain(`font-family: '${family}'`);
      expect(result.css).toContain('url(/_next/static/media/mock.ttf)');
      expect(result.css).not.toContain('fonts.gstatic.com');
      expect(result.css).not.toContain('noto-sans-v27-latin-regular.ttf');
      expect(result.variable).toBe(options.variable);
      expect(result.adjustFontFallback).toBeTruthy();

      // next build が CSS に掛ける postcss-next-font の検査・変換を、そのまま通す
      const exportsList: Array<{ name: string; value: string }> = [];
      const processed = await postcss([
        postcssNextFont({
          exports: exportsList,
          fontFamilyHash: 'test',
          fallbackFonts: result.fallbackFonts,
          adjustFontFallback: result.adjustFontFallback,
          variable: result.variable,
          weight: result.weight,
          style: result.style,
        }),
      ]).process(result.css, { from: undefined });
      expect(processed.css).toContain(`'__${family.replace(/ /g, '_')}_test'`);
      // layout.tsx が使う CSS 変数 (--font-sans / --font-serif) も今までどおり定義される
      expect(processed.css).toContain(`${options.variable}: '__${family.replace(/ /g, '_')}_test'`);
      expect(exportsList.map((e) => e.name)).toContain('style');
    },
  );

  it('Google Fonts の CSS の URL にだけ答え、それ以外は「モックが無い」として扱う', () => {
    expect(mock['https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap']).toEqual(
      expect.stringContaining('#1330'),
    );
    expect(mock['https://example.com/other.css']).toBeUndefined();
    expect(mock[Symbol.toStringTag as unknown as string]).toBeUndefined();
  });

  it('斜体と可変の太さの指定も @font-face に反映する', () => {
    const css = mock['https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,100..900;1,700&display=optional'] ?? '';
    expect(css.match(/@font-face/g)).toHaveLength(2);
    expect(css).toContain('font-weight: 100 900;');
    expect(css).toContain('font-style: italic;');
    expect(css).toContain('font-display: optional;');
  });
});
