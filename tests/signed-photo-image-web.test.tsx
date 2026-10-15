/**
 * #1365 段 1: Web の SignedPhotoImage (src/components/photo/SignedPhotoImage.tsx) のテスト
 *   - 食事写真・冷蔵庫写真のバケットの URL は、POST /api/storage/signed-urls が署名した URL で表示する (公開 URL は出さない)
 *   - サーバーが署名しなかった・問い合わせに失敗したときは、公開 URL に戻さず fallback を出す
 *   - それ以外の URL は問い合わせずにそのまま表示する
 * このリポジトリには @testing-library/react が無いため react-dom/client + act で直接描画する。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/image', () => ({
  // next/image の最適化 (/_next/image?url=…) を通さず、渡された src をそのまま img に出す
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} data-testid="photo" />,
}));

const { SignedPhotoImage } = await import('@/components/photo/SignedPhotoImage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = 'https://proj.supabase.co/storage/v1/object';
const TTL_SECONDS = 3600;

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function photo(): HTMLImageElement | null {
  return container.querySelector('[data-testid="photo"]');
}

describe('SignedPhotoImage (Web)', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('署名付き URL を表示し、保存された公開 URL は表示しない', async () => {
    const publicUrl = `${BASE}/public/fridge-images/u1/web-a.jpg`;
    const signedUrl = `${BASE}/sign/fridge-images/u1/web-a.jpg?token=t`;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ signedUrls: { [publicUrl]: signedUrl }, expiresInSeconds: TTL_SECONDS }), { status: 200 }),
    );
    act(() => root.render(<SignedPhotoImage src={publicUrl} alt="meal" width={56} height={56} />));
    expect(photo()).toBeNull();
    await settle();
    expect(photo()?.getAttribute('src')).toBe(signedUrl);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/api/storage/signed-urls');
    expect(JSON.parse(init.body)).toEqual({ urls: [publicUrl] });
  });

  it('署名されなかった写真は fallback を出す', async () => {
    const publicUrl = `${BASE}/public/fridge-images/other/web-b.jpg`;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ signedUrls: { [publicUrl]: null }, expiresInSeconds: TTL_SECONDS }), { status: 200 }),
    );
    act(() => root.render(<SignedPhotoImage src={publicUrl} alt="meal" fill fallback={<span>no-photo</span>} />));
    await settle();
    expect(photo()).toBeNull();
    expect(container.textContent).toBe('no-photo');
  });

  it('問い合わせが失敗 (500) しても公開 URL に戻さない', async () => {
    const publicUrl = `${BASE}/public/fridge-images/u1/web-c.jpg`;
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    act(() => root.render(<SignedPhotoImage src={publicUrl} alt="meal" fill />));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(photo()).toBeNull();
  });

  it('写真のバケットの URL でなければ、問い合わせずにそのまま表示する', async () => {
    const external = 'https://images.unsplash.com/dish.jpg';
    act(() => root.render(<SignedPhotoImage src={external} alt="dish" fill />));
    await settle();
    expect(photo()?.getAttribute('src')).toBe(external);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
