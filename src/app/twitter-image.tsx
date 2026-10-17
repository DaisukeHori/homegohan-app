/**
 * Twitter Card (X) の画像 (#1845)。OGP の画像 (src/app/opengraph-image.tsx) と同じ PNG。
 * Next の file convention で <meta name="twitter:image"> がこの画像を指す (URL は /twitter-image?<内容のハッシュ>)。
 * 未ログインでも開けるよう、src/proxy.ts の matcher で /twitter-image を外している。
 */
import { OG_IMAGE_ALT, OG_IMAGE_SIZE, renderOgImage } from '@/lib/brand-image';

// ビルドのときに 1 回だけ描く (opengraph-image と同じ)
export const dynamic = 'force-static';

export const alt = OG_IMAGE_ALT;
export const size = OG_IMAGE_SIZE;
export const contentType = 'image/png';

export default function TwitterImage() {
  return renderOgImage();
}
