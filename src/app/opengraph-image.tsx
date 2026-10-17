/**
 * OGP の画像 (#1845)。Next の file convention で、全ページの <meta property="og:image"> がこの画像を指す
 * (URL は /opengraph-image?<内容のハッシュ>。metadataBase (layout の getSiteUrl()) を前に付けた絶対 URL になる)。
 * 中身は src/lib/brand-image.tsx (public/og-image.svg と同じ見た目の 1200×630 の PNG)。
 *
 * 未ログインの訪問者 (SNS のクローラー) が開けるよう、src/proxy.ts の matcher で /opengraph-image を外している
 * (外さないと、未ログインは /login へ送られ、画像の代わりにログイン画面の HTML が返る)。
 */
import { OG_IMAGE_ALT, OG_IMAGE_SIZE, renderOgImage } from '@/lib/brand-image';

// ビルドのときに 1 回だけ描く (ルートの layout は force-dynamic だが、画像は毎回描き直す必要が無い)
export const dynamic = 'force-static';

export const alt = OG_IMAGE_ALT;
export const size = OG_IMAGE_SIZE;
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return renderOgImage();
}
