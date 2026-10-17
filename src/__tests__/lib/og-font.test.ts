// @vitest-environment node
/**
 * #1845: OGP の画像のフォント (Noto Sans JP) を Google Fonts から取る src/lib/og-font.ts の検査
 *
 * 取れたときはフォントのバイト列、取れなかったとき (応答が 2xx でない・CSS に TrueType の URL が無い・
 * fonts.gstatic.com 以外を指す・ネットワークの失敗) は null を返し、例外を投げない (画像は 404 にせずに描く)。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildOgFontCssUrl, loadOgFont, OG_FONT_FETCH_TIMEOUT_MS } from '@/lib/og-font';

const FONT_URL = 'https://fonts.gstatic.com/s/notosansjp/v1/abc.ttf';
const FONT_BYTES = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x10]);

function css(src: string): string {
  return `@font-face {\n  font-family: 'Noto Sans JP';\n  font-weight: 700;\n  src: url(${src}) format('truetype');\n}\n`;
}

type Route = { status: number; body: BodyInit };

/** URL ごとの応答を返す偽の fetch。呼ばれた URL と init を控える */
function fakeFetch(routes: Record<string, Route>, cssRoute: Route) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const route = url.startsWith('https://fonts.googleapis.com/css2?') ? cssRoute : routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(route.body, { status: route.status });
  });
}

describe('buildOgFontCssUrl', () => {
  it('family に太さを付け、text は URL 用に符号化する', () => {
    const url = new URL(buildOgFontCssUrl('ほめゴハン & AI', 700));
    expect(url.origin + url.pathname).toBe('https://fonts.googleapis.com/css2');
    expect(url.searchParams.get('family')).toBe('Noto Sans JP:wght@700');
    expect(url.searchParams.get('text')).toBe('ほめゴハン & AI');
    expect(buildOgFontCssUrl('a', 400)).toContain('family=Noto+Sans+JP:wght@400');
  });
});

describe('loadOgFont', () => {
  it('CSS が指す fonts.gstatic.com の TrueType を取り、そのバイト列を返す', async () => {
    const fetchImpl = fakeFetch({ [FONT_URL]: { status: 200, body: FONT_BYTES } }, { status: 200, body: css(FONT_URL) });
    const data = await loadOgFont('ほめゴハン', 700, fetchImpl);
    expect(data).not.toBeNull();
    expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([...FONT_BYTES]);

    // 1 回目は CSS (TrueType を返させる User-Agent と時間切れの signal 付き)、2 回目はフォント本体
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [cssUrl, cssInit] = fetchImpl.mock.calls[0];
    expect(String(cssUrl)).toBe(buildOgFontCssUrl('ほめゴハン', 700));
    expect((cssInit?.headers as Record<string, string>)['User-Agent']).toMatch(/Safari\/533/);
    expect(cssInit?.signal).toBeInstanceOf(AbortSignal);
    const [fontUrl, fontInit] = fetchImpl.mock.calls[1];
    expect(String(fontUrl)).toBe(FONT_URL);
    expect(fontInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('url( ) の中の引用符を外して取る', async () => {
    const fetchImpl = fakeFetch({ [FONT_URL]: { status: 200, body: FONT_BYTES } }, { status: 200, body: css(`'${FONT_URL}'`) });
    expect(await loadOgFont('a', 400, fetchImpl)).not.toBeNull();
    expect(String(fetchImpl.mock.calls[1][0])).toBe(FONT_URL);
  });

  it('CSS の応答が 2xx でなければ null (フォント本体は取りに行かない)', async () => {
    const fetchImpl = fakeFetch({}, { status: 400, body: 'bad request' });
    expect(await loadOgFont('a', 400, fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('CSS に TrueType / OpenType の URL が無ければ null (WOFF2 だけの CSS など)', async () => {
    const woff2Only = `@font-face { src: url(${FONT_URL.replace('.ttf', '.woff2')}) format('woff2'); }`;
    const fetchImpl = fakeFetch({}, { status: 200, body: woff2Only });
    expect(await loadOgFont('a', 400, fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('CSS が fonts.gstatic.com 以外を指していれば、取りに行かずに null', async () => {
    const elsewhere = 'https://example.invalid/font.ttf';
    const fetchImpl = fakeFetch({ [elsewhere]: { status: 200, body: FONT_BYTES } }, { status: 200, body: css(elsewhere) });
    expect(await loadOgFont('a', 400, fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('フォント本体の応答が 2xx でなければ null', async () => {
    const fetchImpl = fakeFetch({ [FONT_URL]: { status: 503, body: 'unavailable' } }, { status: 200, body: css(FONT_URL) });
    expect(await loadOgFont('a', 400, fetchImpl)).toBeNull();
  });

  it('フォント本体が空なら null', async () => {
    const fetchImpl = fakeFetch({ [FONT_URL]: { status: 200, body: new Uint8Array() } }, { status: 200, body: css(FONT_URL) });
    expect(await loadOgFont('a', 400, fetchImpl)).toBeNull();
  });

  it('ネットワークの失敗・時間切れは例外にせず null', async () => {
    const failing = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await loadOgFont('a', 400, failing)).toBeNull();
  });

  it('載せる文字が空なら、取りに行かずに null', async () => {
    const fetchImpl = vi.fn();
    expect(await loadOgFont('  ', 400, fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('時間切れの上限は数秒 (ビルドを長く止めない)', () => {
    expect(OG_FONT_FETCH_TIMEOUT_MS).toBe(5_000);
  });
});
