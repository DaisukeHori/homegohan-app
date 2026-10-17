/**
 * アプリのアイコンの URL (#1853)。画面・通知が同じ PNG を指すよう、パスはここで 1 回だけ決める。
 *
 * /icon-192.png は src/app/icon-192.png/route.ts が返す 192×192 の PNG (#1845。public/ には置いていない)。
 * public/manifest.json の icons も同じ URL を指す (JSON なのでこの定数は使えない。実在は tests/metadata-public-paths-1845.test.ts が検査する)。
 *
 * このファイルは next/og などサーバー専用のものを読み込まない (クライアントコンポーネントからも読み込むため)。
 * 同じ理由で、ページのメタ情報 (src/lib/seo/public-pages.ts) が指す OGP / Twitter Card の画像の URL・大きさ・代替テキストもここに置く
 * (#1867。src/lib/brand-image.tsx は next/og を読み込むので、メタ情報から読み込むと各ページのサーバーの束に描画の道具が入る)。
 */
import { SITE_NAME, SITE_TAGLINE } from '@/lib/site-config';

/** アプリのアイコン (192×192 の PNG)。ハンズオンツアーの最初の画面 (src/app/handson-tour/page.tsx) と通知の既定のアイコンが使う */
export const APP_ICON_192_PATH = '/icon-192.png';

/** アプリのアイコン (512×512 の PNG)。src/app/icon-512.png/route.ts が返す。トップの JSON-LD の Organization の logo が指す (#1867) */
export const APP_ICON_512_PATH = '/icon-512.png';

/**
 * OGP の画像の URL (#1867)。src/app/opengraph-image.tsx (Next の file convention) の URL。
 * Next はルートの layout の og:image にだけ file convention の画像を自動で入れ、子の layout / page が openGraph を書くと
 * 画像が消える (子の openGraph で丸ごと置き換わる)。ページごとの openGraph (src/lib/seo/public-pages.ts) はこの URL を明示する。
 * 未ログインでも開けるよう、src/proxy.ts の matcher で外している (tests/seo-public-pages-1867.test.ts が検査する)。
 */
export const OG_IMAGE_PATH = '/opengraph-image';

/** Twitter Card (X) の画像の URL (#1867)。src/app/twitter-image.tsx の URL。使い方は OG_IMAGE_PATH と同じ */
export const TWITTER_IMAGE_PATH = '/twitter-image';

/** OGP の画像の大きさ。Facebook / X / LINE の大きい画像のカードの推奨 (1.91:1) */
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;

/** OGP / Twitter Card の画像の代替テキスト (layout の以前の alt と同じ文字) */
export const OG_IMAGE_ALT = `${SITE_NAME} - ${SITE_TAGLINE}`;

/** OGP / Twitter Card の画像の形式 (src/app/opengraph-image.tsx・twitter-image.tsx の contentType と同じ) */
export const OG_IMAGE_CONTENT_TYPE = 'image/png';
