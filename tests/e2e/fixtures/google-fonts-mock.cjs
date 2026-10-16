/**
 * e2e-local の `next build` で、next/font/google に Google Fonts へフォントを取りに行かせないためのモック (#1330・#1745)。
 *
 * next/font/google はビルド時に Google Fonts から CSS とフォントファイル (Noto Sans JP / Noto Serif JP) を取得する。
 * GitHub Actions のマシンからだと、拡張子の無いフォント URL が返ることがあり、ビルドが失敗していた (#1330)。
 * e2e のテストはフォントの見た目に依存しないので、e2e のビルドでは Google Fonts へ取りに行かない。
 *
 * next/font は、環境変数 NEXT_FONT_GOOGLE_MOCKED_RESPONSES にこのファイルの絶対パスを渡すと、Google Fonts へ取得する代わりに
 * このファイルが返すオブジェクトの `[CSS の URL]` を CSS として使う (Next.js 自身のテスト用の仕組み)。
 * Next 16 の既定のバンドラー Turbopack (#1745) では、この仕組みは次のように動く
 * (next.js の crates/next-core/src/next_font/google/mod.rs の get_mock_stylesheet と NextFontGoogleFontFileReplacer):
 *   1. このファイルを、このファイルのあるディレクトリだけを根にした仮の場所で Turbopack が束ねて Node で評価し、
 *      返ったオブジェクトを JSON にして受け取る。そのため
 *      - require で他のモジュール (next/package.json など node_modules の中のもの) を読めない (解決できずビルドが落ちる)
 *      - Proxy のような「読まれたキーに答える」形は JSON にすると空になる。CSS の URL を、そのままの文字列のキーとして並べる
 *      - 並べていない URL を要求されると「url not found」でビルドが落ちる
 *   2. CSS の中の `src: url(...)` の行が指すフォントファイルは、モックの有無に関わらず、その URL へ HTTP で取りに行く
 *      (ファイルのパスを書いても読まない)。そのため `src: url(...)` を書かず、端末に入っている書体を名前で指す
 *      `src: local(...)` だけを書く。フォントファイルは 1 つも作られず、どこへも取りに行かない。
 *      端末にその書体が無ければ、Next が足す代替フォント (font-family の 2 番目) で表示される。
 * webpack のビルド (next build --webpack) の next/font も同じ形を受け付ける (`src: url(...)` の行が無ければ取りに行かない)。
 *
 * next/font は @font-face が 1 つも無い CSS を受け付けない (webpack の postcss-next-font.js:
 * "Font loaders must return one or more @font-face's") ため、要求された太さごとに @font-face を返す。
 *
 * 並べるフォントは src/app/layout.tsx が next/font/google で読むものと同じにする。layout.tsx でフォント・太さ・display を
 * 変えたら FONT_REQUESTS も同じに直す (tests/e2e-google-fonts-mock.test.ts が、layout.tsx の指定から Next.js が作る URL が
 * ここに全部あることを確かめる)。
 *
 * 使うのは e2e のビルド (.github/workflows/e2e-local.yml と scripts/local-ci.sh の e2e 段) だけ。本番 (Vercel) のビルドには関係しない。
 */

const GOOGLE_FONTS_CSS_URL = 'https://fonts.googleapis.com/css2';

/**
 * src/app/layout.tsx が next/font/google で読むフォント (Google Fonts の書体名・太さ・display)。
 * 太さは Google Fonts の URL と同じ並び (数の小さい順)
 */
const FONT_REQUESTS = [
  { family: 'Noto Sans JP', weights: ['400', '500', '700'], display: 'swap' },
  { family: 'Noto Serif JP', weights: ['400', '700'], display: 'swap' },
];

/** next/font が作る Google Fonts の CSS の URL (next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js と同じ形) */
function cssUrlOf({ family, weights, display }) {
  return `${GOOGLE_FONTS_CSS_URL}?family=${family.replace(/ /g, '+')}:wght@${weights.join(';')}&display=${display}`;
}

/** 太さごとの @font-face。フォントファイルを指さず、端末の書体を名前で指す (上の 2.) */
function mockCssOf({ family, weights, display }) {
  const fontFaces = weights.map(
    (weight) => `/* latin */
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: ${weight};
  font-display: ${display};
  src: local('${family}');
}`,
  );
  return `/* #1330・#1745: e2e のビルド用のモック (フォントファイルを取りに行かない) */\n${fontFaces.join('\n')}\n`;
}

module.exports = Object.fromEntries(FONT_REQUESTS.map((request) => [cssUrlOf(request), mockCssOf(request)]));
