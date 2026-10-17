/**
 * OGP / Twitter Card の画像 (next/og の ImageResponse) に使う日本語のフォントを Google Fonts から取る (#1845)。
 *
 * next/og が同梱するフォント (Geist) は英数字だけで、日本語の文字を描けない。next/og は描けない文字のフォントを
 * Google Fonts から自動で取りに行くが、取る太さは 400 だけなので、サービス名 (見出し) を太字にできない。
 * そこで、画像に載せる文字だけを含む Noto Sans JP を、太さごとに取る (`text=` で文字を絞ると数 KB で済む)。
 *
 * 取れなかったとき (ネットワークの無いビルド・Google の障害・時間切れ・想定と違う応答) は null を返す。
 * 呼び出し側 (src/lib/brand-image.tsx) は、そのときフォントを渡さずに描く (next/og の自動の取得に任せる)。
 * それも失敗すると日本語の文字が欠けた画像になるが、画像そのものは PNG で返る (共有したときに 404 にはならない)。
 *
 * 画像の route は静的に作る (dynamic = 'force-static') ので、この取得はビルドのときに 1 回だけ走る。
 */

/** Google Fonts のフォント名 (CSS の family と、satori に渡す name の両方に使う) */
export const OG_FONT_FAMILY = 'Noto Sans JP';

/** 画像で使う太さ。本文は 400、サービス名 (見出し) は 700 */
export type OgFontWeight = 400 | 700;

/** Google Fonts の CSS の API (v2) */
const GOOGLE_FONTS_CSS_ENDPOINT = 'https://fonts.googleapis.com/css2';

/**
 * フォントの本体を置いている Google のホスト。CSS が指す URL がここ以外なら使わない
 * (想定外の場所から取ったバイト列を、画像の描画に渡さない)
 */
const GOOGLE_FONTS_FILE_ORIGIN = 'https://fonts.gstatic.com/';

/**
 * 1 回の取得 (CSS・フォントの本体のそれぞれ) を待つ上限 (ミリ秒)。
 * ビルドのときに 1 回だけ取る。応答の無いネットワークでビルドを長く止めないよう、数秒で諦めて null にする。
 */
export const OG_FONT_FETCH_TIMEOUT_MS = 5_000;

/**
 * TrueType を返させるための User-Agent。Google Fonts は新しいブラウザには WOFF2 を返すが、
 * next/og (satori) は WOFF2 を読めない。next/og 自身が日本語のフォントを取るときと同じ値。
 */
const TRUETYPE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1';

/** CSS の @font-face の中の、TrueType / OpenType のフォントの URL */
const FONT_SRC_PATTERN = /src:\s*url\(([^)]+)\)\s*format\('(?:opentype|truetype)'\)/;

/** Google Fonts の CSS の URL (family と太さ、載せる文字) */
export function buildOgFontCssUrl(text: string, weight: OgFontWeight): string {
  const family = `${OG_FONT_FAMILY.replace(/ /g, '+')}:wght@${weight}`;
  return `${GOOGLE_FONTS_CSS_ENDPOINT}?family=${family}&text=${encodeURIComponent(text)}`;
}

/**
 * `text` に含まれる文字だけを持つ Noto Sans JP (太さ `weight`) のフォントのバイト列。取れなければ null。
 * `fetchImpl` はテストで差し替えるための引数 (省略すると global の fetch)。
 */
export async function loadOgFont(
  text: string,
  weight: OgFontWeight,
  fetchImpl: typeof fetch = fetch,
): Promise<ArrayBuffer | null> {
  if (text.trim() === '') return null;
  try {
    const cssResponse = await fetchImpl(buildOgFontCssUrl(text, weight), {
      headers: { 'User-Agent': TRUETYPE_USER_AGENT },
      signal: AbortSignal.timeout(OG_FONT_FETCH_TIMEOUT_MS),
    });
    if (!cssResponse.ok) return null;
    const css = await cssResponse.text();
    const fontUrl = css.match(FONT_SRC_PATTERN)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (!fontUrl || !fontUrl.startsWith(GOOGLE_FONTS_FILE_ORIGIN)) return null;
    const fontResponse = await fetchImpl(fontUrl, { signal: AbortSignal.timeout(OG_FONT_FETCH_TIMEOUT_MS) });
    if (!fontResponse.ok) return null;
    const data = await fontResponse.arrayBuffer();
    return data.byteLength > 0 ? data : null;
  } catch {
    // ネットワークの失敗・時間切れ。画像はフォント無しで描く (上の説明)
    return null;
  }
}
