/**
 * #1852: 使い方ガイド (/guide) の手順の画像は、読めなかったときに壊れた画像の枠を出さない
 *
 * - 開いた手順の画像を、guide-content.ts のパスと代替テキストで出す
 * - 画像の読み込みが失敗したら (ファイルが無い・通信の失敗)、枠ごと隠す (壊れた画像のアイコンを出さない)
 * - 別の手順に切り替えたら、前の手順の失敗を持ち越さずに、その手順の画像を出す
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act, type ImgHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  // next/image の最適化 (/_next/image?url=…) を通さず、渡された src・alt・onError をそのまま img に出す
  default: ({ src, alt, onError }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} onError={onError} />
  ),
}));

const { default: GuidePage } = await import('@/app/guide/page');
const { GUIDES } = await import('@/app/guide/guide-content');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function stepImages(): HTMLImageElement[] {
  return Array.from(container.querySelectorAll<HTMLImageElement>('[data-testid="guide-step-image"] img'));
}

function stepFrames(): Element[] {
  return Array.from(container.querySelectorAll('[data-testid="guide-step-image"]'));
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`ボタンが無い: ${text}`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('#1852 使い方ガイドの手順の画像', () => {
  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<GuidePage />);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('開いている手順 (はじめかたの 1 つ目) の画像を、guide-content.ts のパスと代替テキストで出す', () => {
    const [first] = GUIDES[0].steps;
    const images = stepImages();
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe(first.image);
    expect(images[0].getAttribute('alt')).toBe(first.imageAlt);
  });

  it('画像の読み込みが失敗したら、枠ごと隠す (壊れた画像を出さない)', async () => {
    expect(stepFrames()).toHaveLength(1);
    await act(async () => {
      stepImages()[0].dispatchEvent(new Event('error'));
    });
    expect(stepFrames()).toHaveLength(0);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    // 手順の説明の文は残る
    expect(container.textContent).toContain(GUIDES[0].steps[0].desc);
  });

  it('失敗のあと別の手順を開くと、その手順の画像を出す (前の失敗を持ち越さない)', async () => {
    await act(async () => {
      stepImages()[0].dispatchEvent(new Event('error'));
    });
    const second = GUIDES[0].steps[1];
    await click(buttonByText(second.title));
    const images = stepImages();
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe(second.image);
  });

  it('章を切り替えると、その章の 1 つ目の手順の画像を出す', async () => {
    const record = GUIDES.find((guide) => guide.id === 'record');
    if (!record) throw new Error('章 record が無い');
    await click(buttonByText(record.title));
    const images = stepImages();
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe(record.steps[0].image);
  });
});
