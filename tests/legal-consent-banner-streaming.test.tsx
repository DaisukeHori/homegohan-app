// @vitest-environment node
/**
 * #1774 同意のお願いの帯 (legal-consent-banner) が 1 ページに 2 つ描かれ、e2e:playwright-notice が間欠的に落ちた
 *
 * 原因: 以前の LegalConsentBanner は、Suspense 境界の中に「お知らせの領域ごと」置き、fallback にも同じ領域を描いていた。
 * サーバーのストリーミングでこの境界が後送りになると (中身の読み込みを待つとき・React が大きめの境界を後から送るとき)、
 * HTML には fallback の領域と、まだ隠れている中身 (<div hidden id="S:n">) の領域の 2 つが入る。
 * 中身と fallback を入れ替えるのはインラインのスクリプト ($RC) で、React 19.2 は入れ替えを少しまとめて待つため、
 * その間は DOM に帯が 2 つある (Playwright の getByTestId は隠れた要素も数えるので strict mode で落ちる)。
 *
 * 直し方: 領域 (data-testid="legal-consent-banner") は境界の外に 1 つだけ置き、境界で包むのはリンクだけにする。
 * ここでは、ブラウザが入れ替えのスクリプトを動かす前の HTML (= 流れてきた HTML 全部) を数えて、帯が 1 つであることを固定する。
 */
import type { ReactNode } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mocks = vi.hoisted(() => ({
  pathname: '/home',
  searchParams: new URLSearchParams('from=e2e'),
  /** 解決するまで useSearchParams が読み込み中 (Suspense) になる Promise。null なら読み込み中にしない */
  pendingSearchParams: null as Promise<void> | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => {
    if (mocks.pendingSearchParams) throw mocks.pendingSearchParams;
    return mocks.searchParams;
  },
}));

const { LegalConsentBanner } = await import('@/components/legal/LegalConsentBanner');

const BANNER_TESTID_ATTR = 'data-testid="legal-consent-banner"';
const PATH_ONLY_HREF = 'href="/legal-consent?next=%2Fhome"';
const WITH_QUERY_HREF = 'href="/legal-consent?next=%2Fhome%3Ffrom%3De2e"';
/** React のストリーミングが後送りにした中身の入れ物 (入れ替えのスクリプトが動くまで隠れている) */
const OUTLINED_SEGMENT_PATTERN = /<div hidden id="S:\d+">/;
/**
 * 境界を後送りにするかを決める 1 回の送り出しの大きさ (バイト)。0 にすると、大きめの境界 (React の閾値 500 バイト超) は
 * 必ず後送りになる (本番では既定の 12800 バイトを、それまでに送った量と合わせて超えたときに後送りになる)
 */
const FORCE_OUTLINE_PROGRESSIVE_CHUNK_SIZE = 0;

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

async function readAll(stream: ReadableStream<Uint8Array>, onFirstChunk?: () => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    if (first) {
      first = false;
      onFirstChunk?.();
    }
  }
  return html + decoder.decode();
}

beforeEach(() => {
  mocks.pathname = '/home';
  mocks.searchParams = new URLSearchParams('from=e2e');
  mocks.pendingSearchParams = null;
});

describe('LegalConsentBanner: ストリーミングで境界が後送りになっても、帯は 1 つ (#1774)', () => {
  it('★クエリの読み込みを待つ間に shell が送られ、リンクが後から届くとき: 流れてきた HTML 全体で帯は 1 つ', async () => {
    let resolvePending: () => void = () => {};
    mocks.pendingSearchParams = new Promise<void>((resolve) => {
      resolvePending = () => {
        mocks.pendingSearchParams = null;
        resolve();
      };
    });

    const stream = await renderToReadableStream(<LegalConsentBanner />);
    // shell (fallback のリンク) を受け取ってから、クエリを読めるようにする → 中身は後送りで届く
    const html = await readAll(stream, () => resolvePending());

    // 番兵: 本当に後送りになっている (fallback のリンクと、隠れた中身のリンクが両方 HTML にある)
    expect(html).toMatch(OUTLINED_SEGMENT_PATTERN);
    expect(countOccurrences(html, PATH_ONLY_HREF)).toBe(1);
    expect(countOccurrences(html, WITH_QUERY_HREF)).toBe(1);

    // 帯 (領域) は 1 つだけ。入れ替えのスクリプトが動く前でも 2 つにならない
    expect(countOccurrences(html, BANNER_TESTID_ATTR)).toBe(1);
  });

  it('★読み込みを待たなくても、React が境界を後送りにする条件 (送り出しの大きさの上限) のとき: 帯は 1 つ', async () => {
    const stream = await renderToReadableStream(<LegalConsentBanner />, {
      progressiveChunkSize: FORCE_OUTLINE_PROGRESSIVE_CHUNK_SIZE,
    });
    const html = await readAll(stream);

    expect(countOccurrences(html, BANNER_TESTID_ATTR)).toBe(1);
    // リンクは最終的にクエリつきの戻り先を持つ
    expect(html).toContain(WITH_QUERY_HREF);
  });

  it('帯の領域は、後送りの入れ物 (隠れた中身) の外にある: 入れ替えの前から見えている', async () => {
    let resolvePending: () => void = () => {};
    mocks.pendingSearchParams = new Promise<void>((resolve) => {
      resolvePending = () => {
        mocks.pendingSearchParams = null;
        resolve();
      };
    });

    const stream = await renderToReadableStream(<LegalConsentBanner />);
    const html = await readAll(stream, () => resolvePending());

    const segmentStart = html.search(OUTLINED_SEGMENT_PATTERN);
    expect(segmentStart).toBeGreaterThan(-1);
    const bannerAt = html.indexOf(BANNER_TESTID_ATTR);
    expect(bannerAt).toBeGreaterThan(-1);
    expect(bannerAt).toBeLessThan(segmentStart);
  });
});
