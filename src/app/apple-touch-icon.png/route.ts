/**
 * /apple-touch-icon.png (#1845)。iOS でホーム画面に追加したときのアイコン (180×180 の PNG)。
 * layout の metadata (icons.apple) がこの URL を指す。iOS は <link> が無くてもこの URL を取りに来る。
 * 以前は public/ に PNG が無く 404 だった。見た目は public/apple-touch-icon.svg と同じ (src/lib/brand-image.tsx)。
 * .png で終わるパスは src/proxy.ts の matcher の外なので、未ログインでも開ける。
 */
import { APPLE_TOUCH_ICON_SIZE, renderBrandIcon } from '@/lib/brand-image';

// ビルドのときに 1 回だけ描く
export const dynamic = 'force-static';

export function GET(): Response {
  return renderBrandIcon(APPLE_TOUCH_ICON_SIZE, 'roundedSquare');
}
