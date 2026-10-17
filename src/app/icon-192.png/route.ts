/**
 * /icon-192.png (#1845)。PWA のアイコン (192×192 の PNG)。public/manifest.json の icons と、通知のアイコン
 * (src/lib/local-notification.ts)・ハンズオンツアーの最初の画面 (src/app/handson-tour/page.tsx) がこの URL を指す
 * (コードからは src/lib/brand-asset-paths.ts の APP_ICON_192_PATH で指す。#1853)。以前は public/ に PNG が無く 404 だった。
 * 見た目は public/icon-512.svg の図柄を 192 に縮小したもの (src/lib/brand-image.tsx。public/icon-192.svg とは星の十字の有無だけ違う)。
 * .png で終わるパスは src/proxy.ts の matcher の外なので、未ログインでも開ける。
 */
import { MANIFEST_ICON_SIZES, renderBrandIcon } from '@/lib/brand-image';

// ビルドのときに 1 回だけ描く
export const dynamic = 'force-static';

export function GET(): Response {
  return renderBrandIcon(MANIFEST_ICON_SIZES.small, 'circle');
}
