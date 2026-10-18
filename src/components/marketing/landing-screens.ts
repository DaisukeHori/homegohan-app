// src/components/marketing/landing-screens.ts
// 紹介ページ (/) のために新しく撮る実際の画面 6 枚と、章 photo・menu の拡大に使う画像 2 枚 (public/marketing/screens/*.png) の
// 名前・alt・パス (拡大の画像は大きさと切り出す元も) の正本 (docs/design/marketing/01-landing-site.md §5.4・§7.1)。
// 撮影の台本 (scripts/guide-screenshots/shoot.pw.ts・optimize.ts) と tests/landing-page-1867.test.ts (U-4・U-36) が読む。
// landing-copy.ts はこの一覧のパスと alt を文字列で持つ (U-4 が両方の一致を見る)。拡大の画像の大きさは ScreenZoom が landingZoomBySrc で引く。
// 新しい画面の大きさはガイドの画像と同じ 540×1080。拡大の画像の大きさは LANDING_ZOOMS の width・height。
export const LANDING_SCREENS_DIR = '/marketing/screens';

export const LANDING_SCREEN_NAMES = ['home', 'pantry', 'shopping', 'family', 'chat', 'consent'] as const;
export type LandingScreenName = (typeof LANDING_SCREEN_NAMES)[number];

export interface LandingScreen {
  name: LandingScreenName;
  /** 画像の代替テキスト (何の画面か) */
  alt: string;
  /** public/ からのパス */
  src: `${typeof LANDING_SCREENS_DIR}/${LandingScreenName}.png`;
}

function screen(name: LandingScreenName, alt: string): LandingScreen {
  return { name, alt, src: `${LANDING_SCREENS_DIR}/${name}.png` };
}

export const LANDING_SCREENS: readonly LandingScreen[] = [
  screen('home', 'ホームの画面'),
  screen('pantry', '食材管理の画面'),
  screen('shopping', '献立から作った買い物リスト'),
  screen('family', '家族の画面'),
  screen('chat', 'AI 相談のシート'),
  screen('consent', 'AI 機能の同意の画面'),
];

/** 名前で引く (無ければ例外。定数なので実行時に起きない) */
export function landingScreen(name: LandingScreenName): LandingScreen {
  const found = LANDING_SCREENS.find((item) => item.name === name);
  if (!found) throw new Error(`landing screen not found: ${name}`);
  return found;
}

/** 撮影の台本が撮る名前の一覧 (public/marketing/screens/ に置く順) */
export function landingScreenNames(): LandingScreenName[] {
  return LANDING_SCREENS.map((item) => item.name);
}

/** 拡大の画像の名前 (章 photo・menu の拡大。§5.4) */
export const LANDING_ZOOM_NAMES = ['zoom-photo', 'zoom-menu'] as const;
export type LandingZoomName = (typeof LANDING_ZOOM_NAMES)[number];

/**
 * 拡大の画像の横の画素。箱の幅の上限は 24rem (384 px) で、2 倍の画素の画面で粗く見えない幅 (約 768) に近い。
 * 撮影の画面 (390 × 780 を 2 倍の画素で撮る) の中で切り出す部分は横約 740 px なので、広げずに縮める大きさにした (§5.4)
 */
export const ZOOM_IMAGE_WIDTH_PX = 720;
/** 章 photo の拡大の画像の縦の画素 (横 3 : 縦 2。スコアの箱と記録コメントの箱に余白を足した部分の比 (約 511 : 331) に合わせた。§5.4) */
export const ZOOM_PHOTO_HEIGHT_PX = 480;
/** 章 menu の拡大の画像の縦の画素 (横 6 : 縦 5。今日の朝食の 1 食の箱に余白を足した部分の比 (約 523 : 436) に合わせた。§5.4) */
export const ZOOM_MENU_HEIGHT_PX = 600;

/** 拡大の画像を切り出す元の画面 (public/guide/ の画像の名前。同じ撮影の回の同じ画面の状態から切り出す) */
export type LandingZoomSource = 'comment' | 'menu-result';

export interface LandingZoom {
  name: LandingZoomName;
  /** 画像の代替テキスト (何の部分の拡大か) */
  alt: string;
  /** public/ からのパス */
  src: `${typeof LANDING_SCREENS_DIR}/${LandingZoomName}.png`;
  /** 画像の画素 (optimize.ts がこの大きさにする。拡大の箱の縦横比) */
  width: number;
  height: number;
  /** 切り出す元の画面 */
  source: LandingZoomSource;
}

function zoomImage(name: LandingZoomName, alt: string, height: number, source: LandingZoomSource): LandingZoom {
  return { name, alt, src: `${LANDING_SCREENS_DIR}/${name}.png`, width: ZOOM_IMAGE_WIDTH_PX, height, source };
}

export const LANDING_ZOOMS: readonly LandingZoom[] = [
  zoomImage('zoom-photo', '解析結果のスコアと記録コメントを拡大した部分', ZOOM_PHOTO_HEIGHT_PX, 'comment'),
  zoomImage('zoom-menu', '献立表の朝食の 1 食を拡大した部分', ZOOM_MENU_HEIGHT_PX, 'menu-result'),
];

/** パスで引く (無ければ例外。LANDING_COPY の拡大の画像のパスは LANDING_ZOOMS にある: U-4) */
export function landingZoomBySrc(src: string): LandingZoom {
  const found = LANDING_ZOOMS.find((item) => item.src === src);
  if (!found) throw new Error(`landing zoom not found: ${src}`);
  return found;
}

/** 撮影の台本が切り出す名前の一覧 (public/marketing/screens/ に置く順) */
export function landingZoomNames(): LandingZoomName[] {
  return LANDING_ZOOMS.map((item) => item.name);
}
