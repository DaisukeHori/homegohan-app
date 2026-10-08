// @vitest-environment node
/**
 * e2e-local のビルドで使う Google Fonts のモック (tests/e2e/fixtures/google-fonts-mock.cjs) が、
 * 今の Next.js の next/font/google で効くことを確かめる (#1330)。
 *
 * モックは next/font の内部の仕組み (環境変数 NEXT_FONT_GOOGLE_MOCKED_RESPONSES) に頼っている。
 * Next.js を上げてこの仕組みが変わったら、e2e-local のビルドが再び Google Fonts へ取りに行き、
 * 取得に失敗するとビルドが落ちる。その前にこのテストで気づけるようにする。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const MOCK_PATH = path.resolve(__dirname, 'e2e/fixtures/google-fonts-mock.cjs');

type GoogleFontLoader = (args: {
  functionName: string;
  data: unknown[];
  emitFontFile: (content: Buffer, ext: string, preload: boolean, isUsingSizeAdjust?: boolean) => string;
  isDev: boolean;
  isServer: boolean;
}) => Promise<{ css: string; variable?: string; adjustFontFallback?: unknown }>;

const loader: GoogleFontLoader = require('next/dist/compiled/@next/font/dist/google/loader.js').default;
const mock: Record<string, string | undefined> = require(MOCK_PATH);

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
    ['Noto_Sans_JP', { subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-sans' }, '--font-sans'],
    ['Noto_Serif_JP', { subsets: ['latin'], weight: ['400', '700'], variable: '--font-serif' }, '--font-serif'],
  ])('%s: Google Fonts へ取りに行かず、フォントファイルを 1 つも作らずに CSS を返す', async (functionName, options, variable) => {
    const emitFontFile = vi.fn(() => '/_next/static/media/never.woff2');

    const result = await loader({ functionName, data: [options], emitFontFile, isDev: false, isServer: true });

    expect(emitFontFile).not.toHaveBeenCalled();
    expect(result.css).toContain('#1330');
    expect(result.css).not.toContain('@font-face');
    expect(result.css).not.toContain('url(');
    expect(result.variable).toBe(variable);
    // 代替フォントの寸法 (レイアウトのずれを抑える設定) は従来どおり付く
    expect(result.adjustFontFallback).toBeTruthy();
  });

  it('Google Fonts の CSS の URL にだけ答え、それ以外は「モックが無い」として扱う', () => {
    expect(mock['https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap']).toEqual(
      expect.stringContaining('#1330'),
    );
    expect(mock['https://example.com/other.css']).toBeUndefined();
    expect(mock[Symbol.toStringTag as unknown as string]).toBeUndefined();
  });
});
