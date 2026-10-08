/**
 * e2e-local の `next build` で、next/font/google に Google Fonts へフォントを取りに行かせないためのモック (#1330)。
 *
 * next/font/google はビルド時に Google Fonts から CSS とフォントファイル (Noto Sans JP / Noto Serif JP で約 600 個) を取得する。
 * GitHub Actions のマシンからだと、拡張子の無いフォント URL が返ることがあり、Next.js 14 の読み込み処理
 * (`/\.(woff|woff2|eot|ttf|otf)$/.exec(url)[1]`) が null を読んで
 * `TypeError: Cannot read properties of null (reading '1')` でビルドが失敗する。テストの中身と関係なく CI が赤になる。
 *
 * next/font は、環境変数 NEXT_FONT_GOOGLE_MOCKED_RESPONSES にこのファイルの絶対パスを渡すと、
 * Google Fonts へ取得する代わりに `require(このファイル)[CSS の URL]` を CSS として使う
 * (next/dist/compiled/@next/font/dist/google/fetch-css-from-google-fonts.js。Next.js 自身のテスト用の仕組み)。
 * CSS の中のフォントファイルの URL が `/` で始まる (= ファイルの絶対パス) ときは、取得せずにそのファイルを読む
 * (同じく fetch-font-file.js)。
 *
 * next/font は @font-face が 1 つも無い CSS を受け付けない (postcss-next-font.js:
 * "Font loaders must return one or more @font-face's") ため、要求された太さごとに @font-face を返し、
 * フォントファイルには Next.js に同梱されている小さな実フォント (Noto Sans のラテン文字だけ) を使う。
 * 日本語の文字は端末の代替フォントで表示される。e2e のテストはフォントの見た目に依存しない。
 *
 * 使うのは .github/workflows/e2e-local.yml のビルドだけ。本番 (Vercel) のビルドには関係しない。
 * tests/e2e-google-fonts-mock.test.ts が、この仕組みが今の Next.js で効くことを確かめる。
 */

const fs = require('node:fs');
const path = require('node:path');

const GOOGLE_FONTS_CSS_URL = 'https://fonts.googleapis.com/';

/** モックの @font-face が指す実フォント (Next.js に同梱。ラテン文字だけの Noto Sans) */
function localFontFile() {
  const nextDir = path.dirname(require.resolve('next/package.json'));
  const file = path.join(nextDir, 'dist/compiled/@vercel/og/noto-sans-v27-latin-regular.ttf');
  if (!fs.existsSync(file)) {
    throw new Error(`#1330: モックが使うフォントファイルが見つからない (Next.js の更新で場所が変わった可能性): ${file}`);
  }
  return file;
}

/**
 * Google Fonts の css2 の URL (例: ?family=Noto+Sans+JP:wght@400;500;700&display=swap) から、
 * フォント名と、太さ・斜体の組を取り出す
 */
function parseFontRequest(url) {
  const params = new URL(url).searchParams;
  const [family, axes = ''] = (params.get('family') ?? '').split(':');
  const display = params.get('display') ?? 'swap';
  const [axisNames = '', values = ''] = axes.split('@');
  const names = axisNames ? axisNames.split(',') : [];
  const variants = values
    ? values.split(';').map((tuple) => {
        const parts = tuple.split(',');
        const valueOf = (axis) => parts[names.indexOf(axis)];
        return {
          style: valueOf('ital') === '1' ? 'italic' : 'normal',
          weight: (valueOf('wght') ?? '400').replace('..', ' '),
        };
      })
    : [{ style: 'normal', weight: '400' }];
  return { family, display, variants };
}

function mockCss(url) {
  const { family, display, variants } = parseFontRequest(url);
  const file = localFontFile();
  const fontFaces = variants.map(
    ({ style, weight }) => `/* latin */
@font-face {
  font-family: '${family}';
  font-style: ${style};
  font-weight: ${weight};
  font-display: ${display};
  src: url(${file}) format('truetype');
}`,
  );
  return `/* #1330: e2e-local のビルド用のモック (${url}) */\n${fontFaces.join('\n')}\n`;
}

module.exports = new Proxy(
  {},
  {
    get(_target, url) {
      // Google Fonts の CSS の URL 以外 (Symbol やその他のキー) は「モックが無い」として扱う
      if (typeof url !== 'string' || !url.startsWith(GOOGLE_FONTS_CSS_URL)) return undefined;
      return mockCss(url);
    },
  },
);
