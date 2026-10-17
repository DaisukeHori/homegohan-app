/**
 * アプリのアイコンの URL (#1853)。画面・通知が同じ PNG を指すよう、パスはここで 1 回だけ決める。
 *
 * /icon-192.png は src/app/icon-192.png/route.ts が返す 192×192 の PNG (#1845。public/ には置いていない)。
 * public/manifest.json の icons も同じ URL を指す (JSON なのでこの定数は使えない。実在は tests/metadata-public-paths-1845.test.ts が検査する)。
 *
 * このファイルは next/og などサーバー専用のものを読み込まない (クライアントコンポーネントからも読み込むため)。
 */

/** アプリのアイコン (192×192 の PNG)。ハンズオンツアーの最初の画面 (src/app/handson-tour/page.tsx) と通知の既定のアイコンが使う */
export const APP_ICON_192_PATH = '/icon-192.png';
