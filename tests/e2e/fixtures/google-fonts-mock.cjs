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
 * ここでは、どの URL にも @font-face を含まない CSS を返す。フォントファイルは 1 つも作られず、
 * ページは代替フォントで表示される。e2e のテストはフォントの見た目に依存しない。
 *
 * 使うのは .github/workflows/e2e-local.yml のビルドだけ。本番 (Vercel) のビルドには関係しない。
 * tests/e2e-google-fonts-mock.test.ts が、この仕組みが今の Next.js で効くことを確かめる。
 */

const GOOGLE_FONTS_CSS_URL = 'https://fonts.googleapis.com/';

module.exports = new Proxy(
  {},
  {
    get(_target, url) {
      // Google Fonts の CSS の URL 以外 (Symbol やその他のキー) は「モックが無い」として扱う
      if (typeof url !== 'string' || !url.startsWith(GOOGLE_FONTS_CSS_URL)) return undefined;
      // 空文字は「モックが無い」と判定されるため、コメントだけの CSS を返す
      return `/* #1330: e2e-local ではフォントファイルを読み込まない (${url}) */\n`;
    },
  },
);
