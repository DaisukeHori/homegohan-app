/**
 * /icon-512.png (#1845)。PWA のアイコン (512×512 の PNG)。public/manifest.json の icons がこの URL を指す。
 * 以前は public/ に PNG が無く 404 だった。見た目は public/icon-512.svg と同じ (src/lib/brand-image.tsx)。
 * .png で終わるパスは src/proxy.ts の matcher の外なので、未ログインでも開ける。
 */
import { MANIFEST_ICON_SIZES, renderBrandIcon } from '@/lib/brand-image';

// ビルドのときに 1 回だけ描く
export const dynamic = 'force-static';

export function GET(): Response {
  return renderBrandIcon(MANIFEST_ICON_SIZES.large, 'circle');
}
