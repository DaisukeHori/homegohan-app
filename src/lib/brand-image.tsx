/**
 * サービスの画像 (OGP / Twitter Card の画像・ホーム画面のアイコン) を PNG で作る (#1845)。
 *
 * 以前は src/app/layout.tsx が /og-image.png・/apple-touch-icon.png を、public/manifest.json が /icon-192.png・/icon-512.png を
 * 指していたが、public/ には SVG (OGP の画像・apple-touch-icon.svg・icon-192.svg・icon-512.svg) しか無く、本番ではどれも 404 だった。
 * OGP / Twitter Card の画像と、ホーム画面に追加したときのアイコンには SVG を使えない。
 * そこで、SVG と同じ見た目を next/og の ImageResponse で描き、PNG で返す。
 * OGP の画像の SVG は、どこからも参照されなくなったので #1853 で public/ から消した。OGP の画像の見た目の正本は、このファイルの OgCard。
 *
 * - OGP / Twitter Card の画像: src/app/opengraph-image.tsx・twitter-image.tsx (Next の file convention。1200×630)
 * - iOS のホーム画面のアイコン: src/app/apple-touch-icon.png/route.ts (180×180。public/apple-touch-icon.svg の見た目)
 * - PWA のアイコン: src/app/icon-192.png/route.ts・icon-512.png/route.ts (public/manifest.json が指す。public/icon-512.svg の見た目)
 *
 * どの route も静的に作る (dynamic = 'force-static')。ビルドのときに 1 回描き、以後は同じ PNG を返す。
 * 画像にドメインの文字は入れない (サイトの URL は環境変数で変わるので、静的な画像に書くと古いまま残る。#1573 の方針)。
 */
import { ImageResponse } from 'next/og';
import { STATUS_COLOR_TOKENS } from '@homegohan/shared';
import { SITE_NAME, SITE_TAGLINE } from '@/lib/site-config';
import { OG_IMAGE_ALT, OG_IMAGE_SIZE } from '@/lib/brand-asset-paths';
import { loadOgFont, OG_FONT_FAMILY, type OgFontWeight } from '@/lib/og-font';

/**
 * ブランドの色。public/icon.svg と同じ値 (#1853 で消した OGP の画像の SVG とも同じ値だった)。
 * accent は public/manifest.json の theme_color と layout の viewport.themeColor、background は manifest の background_color と同じ
 * (tests/og-image-1845.test.tsx が突き合わせる)。成功の緑は状態色のトークン (STATUS_COLOR_TOKENS.success) から取る。
 */
export const BRAND_COLORS = {
  accent: '#E07A5F',
  accentGradientEnd: '#FF9B7A',
  background: '#FAF9F7',
  backgroundGradientEnd: '#FDF0ED',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  white: '#FFFFFF',
  sparkle: '#FFD700',
  green: STATUS_COLOR_TOKENS.success,
  blue: '#5B8BC7',
} as const;

// OGP の画像の大きさ・代替テキストは、ページのメタ情報からも読むので src/lib/brand-asset-paths.ts に置く (#1867)。
// 画像の route (opengraph-image.tsx など) とテストは、従来どおりこのファイルから読める
export { OG_IMAGE_ALT, OG_IMAGE_SIZE };

/** OGP の画像に並べる機能の札 (#1853 で消した OGP の画像の SVG と同じ 3 つ。絵文字は外部から画像を取りに行くので使わない) */
export const OG_FEATURES = [
  { label: '写真で記録', color: BRAND_COLORS.accent },
  { label: '献立提案', color: BRAND_COLORS.green },
  { label: '健康管理', color: BRAND_COLORS.blue },
] as const;

/** iOS のホーム画面のアイコンの大きさ (Apple の推奨の 180×180。layout の icons.apple の sizes と同じ) */
export const APPLE_TOUCH_ICON_SIZE = 180;

/** PWA のアイコンの大きさ (public/manifest.json の icons の sizes。Chrome がインストールに求める 192 と 512) */
export const MANIFEST_ICON_SIZES = { small: 192, large: 512 } as const;

/**
 * OGP の画像の中の配置 (px)。#1853 で消した OGP の画像の SVG の座標に合わせた値。
 * 左上と右下の飾りの円・左のロゴ・右の文字の列 (サービス名・説明・機能の札)。
 */
const OG_LAYOUT = {
  decorTopLeft: { left: -100, top: -100, size: 400 },
  decorBottomRight: { left: 850, top: 280, size: 500 },
  logo: { left: 110, top: 190, size: 220 },
  textColumn: { left: 360, top: 190 },
  titleFontSize: 80,
  taglineFontSize: 36,
  taglineMarginTop: 12,
  featuresMarginTop: 36,
  featureGap: 20,
  featureWidth: 180,
  featureHeight: 50,
  featureFontSize: 20,
} as const;

/** 飾りの円の不透明度 (#1853 で消した OGP の画像の SVG の opacity="0.1") */
const DECOR_OPACITY = 0.1;
/** 機能の札の下地の不透明度 (#1853 で消した OGP の画像の SVG の opacity="0.15") */
const FEATURE_BG_OPACITY = 0.15;
/** 16 進の 2 桁の最大値 (不透明度を #RRGGBBAA の AA に直すのに使う) */
const HEX_BYTE_MAX = 255;
/** 16 進数 */
const HEX_RADIX = 16;

/** #RRGGBB に不透明度 (0〜1) を足して #RRGGBBAA にする */
function withAlpha(hex: string, alpha: number): string {
  const byte = Math.round(alpha * HEX_BYTE_MAX)
    .toString(HEX_RADIX)
    .padStart(2, '0');
  return `${hex}${byte}`.toUpperCase();
}

/** ロゴの形。circle は public/icon-512.svg (丸)、roundedSquare は public/apple-touch-icon.svg (角の丸い四角) */
export type BrandMarkShape = 'circle' | 'roundedSquare';

/**
 * ロゴ (湯気の立つお椀と星)。public/icon-512.svg と public/apple-touch-icon.svg の図形をそのまま写した SVG。
 * 座標は viewBox (512×512 / 180×180) の中の値で、表示の大きさは size で決まる。
 */
function BrandMark({ size, shape }: { size: number; shape: BrandMarkShape }) {
  const gradient = (
    <defs>
      <linearGradient id="brandGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor={BRAND_COLORS.accent} />
        <stop offset="100%" stopColor={BRAND_COLORS.accentGradientEnd} />
      </linearGradient>
    </defs>
  );
  if (shape === 'roundedSquare') {
    return (
      <svg width={size} height={size} viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg">
        {gradient}
        <rect width="180" height="180" rx="40" fill="url(#brandGrad)" />
        <ellipse cx="90" cy="105" rx="50" ry="28" fill={BRAND_COLORS.white} />
        <path d="M40 105 Q40 135 90 135 Q140 135 140 105" fill={BRAND_COLORS.white} />
        <path d="M63 70 Q70 55 63 40" stroke={BRAND_COLORS.white} strokeWidth="5" strokeLinecap="round" fill="none" opacity="0.8" />
        <path d="M90 60 Q97 45 90 30" stroke={BRAND_COLORS.white} strokeWidth="5" strokeLinecap="round" fill="none" opacity="0.9" />
        <path d="M117 70 Q124 55 117 40" stroke={BRAND_COLORS.white} strokeWidth="5" strokeLinecap="round" fill="none" opacity="0.8" />
        <circle cx="135" cy="45" r="8" fill={BRAND_COLORS.sparkle} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      {gradient}
      <circle cx="256" cy="256" r="240" fill="url(#brandGrad)" />
      <ellipse cx="256" cy="300" rx="140" ry="80" fill={BRAND_COLORS.white} />
      <path d="M116 300 Q116 380 256 380 Q396 380 396 300" fill={BRAND_COLORS.white} />
      <path d="M180 200 Q190 170 180 140" stroke={BRAND_COLORS.white} strokeWidth="12" strokeLinecap="round" fill="none" opacity="0.8" />
      <path d="M256 180 Q266 150 256 120" stroke={BRAND_COLORS.white} strokeWidth="12" strokeLinecap="round" fill="none" opacity="0.9" />
      <path d="M332 200 Q342 170 332 140" stroke={BRAND_COLORS.white} strokeWidth="12" strokeLinecap="round" fill="none" opacity="0.8" />
      <circle cx="380" cy="140" r="20" fill={BRAND_COLORS.sparkle} />
      <path d="M380 110 L380 170 M350 140 L410 140" stroke={BRAND_COLORS.sparkle} strokeWidth="8" strokeLinecap="round" />
    </svg>
  );
}

/** 飾りの円 (塗りは accent を薄くしたもの) */
function DecorCircle({ left, top, size }: { left: number; top: number; size: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: withAlpha(BRAND_COLORS.accent, DECOR_OPACITY),
      }}
    />
  );
}

/** OGP の画像の中身 (#1853 で消した OGP の画像の SVG の見た目。ドメインの文字は入れない) */
function OgCard() {
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        width: '100%',
        height: '100%',
        backgroundImage: `linear-gradient(135deg, ${BRAND_COLORS.background}, ${BRAND_COLORS.backgroundGradientEnd})`,
        fontFamily: OG_FONT_FAMILY,
      }}
    >
      <DecorCircle {...OG_LAYOUT.decorTopLeft} />
      <DecorCircle {...OG_LAYOUT.decorBottomRight} />
      <div style={{ position: 'absolute', left: OG_LAYOUT.logo.left, top: OG_LAYOUT.logo.top, display: 'flex' }}>
        <BrandMark size={OG_LAYOUT.logo.size} shape="circle" />
      </div>
      <div
        style={{
          position: 'absolute',
          left: OG_LAYOUT.textColumn.left,
          top: OG_LAYOUT.textColumn.top,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', fontSize: OG_LAYOUT.titleFontSize, fontWeight: 700, color: BRAND_COLORS.text }}>
          {SITE_NAME}
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: OG_LAYOUT.taglineMarginTop,
            fontSize: OG_LAYOUT.taglineFontSize,
            fontWeight: 400,
            color: BRAND_COLORS.textLight,
          }}
        >
          {SITE_TAGLINE}
        </div>
        <div style={{ display: 'flex', marginTop: OG_LAYOUT.featuresMarginTop, gap: OG_LAYOUT.featureGap }}>
          {OG_FEATURES.map((feature) => (
            <div
              key={feature.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: OG_LAYOUT.featureWidth,
                height: OG_LAYOUT.featureHeight,
                borderRadius: OG_LAYOUT.featureHeight / 2,
                backgroundColor: withAlpha(feature.color, FEATURE_BG_OPACITY),
                color: feature.color,
                fontSize: OG_LAYOUT.featureFontSize,
                fontWeight: 400,
              }}
            >
              {feature.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** OGP の画像に載る文字 (太さごと)。フォントはこの文字だけを取る */
export const OG_TEXT_BY_WEIGHT: Readonly<Record<OgFontWeight, string>> = {
  700: SITE_NAME,
  400: [SITE_TAGLINE, ...OG_FEATURES.map((feature) => feature.label)].join(''),
};

type OgFont = { name: string; data: ArrayBuffer; weight: OgFontWeight; style: 'normal' };

/** 太さごとのフォントを取る。取れた分だけ返す (1 つも取れなければ空。そのときは next/og の既定のフォントで描く) */
async function loadOgFonts(fetchImpl?: typeof fetch): Promise<OgFont[]> {
  const weights = Object.keys(OG_TEXT_BY_WEIGHT).map(Number) as OgFontWeight[];
  const loaded = await Promise.all(
    weights.map(async (weight) => ({ weight, data: await loadOgFont(OG_TEXT_BY_WEIGHT[weight], weight, fetchImpl) })),
  );
  return loaded.flatMap(({ weight, data }) =>
    data ? [{ name: OG_FONT_FAMILY, data, weight, style: 'normal' as const }] : [],
  );
}

/**
 * OGP / Twitter Card の画像 (1200×630 の PNG)。
 * `fetchImpl` はテストでフォントの取得を差し替えるための引数。
 */
export async function renderOgImage(fetchImpl?: typeof fetch): Promise<ImageResponse> {
  const fonts = await loadOgFonts(fetchImpl);
  return new ImageResponse(<OgCard />, {
    ...OG_IMAGE_SIZE,
    // 1 つも取れなかったときは fonts を渡さない (渡すと next/og の既定のフォントが外れ、英数字も描けなくなる)
    ...(fonts.length > 0 ? { fonts } : {}),
  });
}

/** ホーム画面のアイコン (size×size の PNG。文字は無いのでフォントは要らない) */
export function renderBrandIcon(size: number, shape: BrandMarkShape): ImageResponse {
  return new ImageResponse(
    (
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>
        <BrandMark size={size} shape={shape} />
      </div>
    ),
    { width: size, height: size },
  );
}
