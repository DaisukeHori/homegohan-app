/**
 * #1584 adminFetch (src/lib/admin/fetch.ts) の宛先 (ベース URL) の優先順
 *
 * 運営画面のサーバーコンポーネントは adminFetch で自分自身の内部 API を呼ぶ。
 * 以前は NEXTAUTH_URL も VERCEL_URL も無いと固定の http://localhost:3000 に向かっていたため、
 * Next を 3000 以外のポートで動かすと (local-ci の枠 1 以上など)、別のサーバーに繋がるか、一覧が空になっていた。
 * いまは NEXTAUTH_URL > VERCEL_URL > http://localhost:<PORT> > http://localhost:3000 の順で決める
 * (NEXTAUTH_URL / VERCEL_URL の優先順は変えない = 本番 (Vercel) の挙動は変わらない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ getAll: () => [] }),
}));

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}'));

const { adminFetch, DEFAULT_SERVER_PORT } = await import('@/lib/admin/fetch');

const PATH = '/api/admin/users';

async function requestedUrl(): Promise<string> {
  fetchMock.mockClear();
  await adminFetch(PATH);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return String(fetchMock.mock.calls[0][0]);
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  // 実行環境 (CI・開発機) の値に左右されないよう、4 つとも未設定から始める
  vi.stubEnv('NEXTAUTH_URL', undefined);
  vi.stubEnv('VERCEL_URL', undefined);
  vi.stubEnv('PORT', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('adminFetch の宛先の優先順 (#1584)', () => {
  it('NEXTAUTH_URL があれば、VERCEL_URL・PORT があってもそれを使う', async () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://app.example.com');
    vi.stubEnv('VERCEL_URL', 'preview.example.vercel.app');
    vi.stubEnv('PORT', '3101');

    expect(await requestedUrl()).toBe(`https://app.example.com${PATH}`);
  });

  it('NEXTAUTH_URL が無く VERCEL_URL があれば、PORT があっても https://<VERCEL_URL> を使う', async () => {
    vi.stubEnv('VERCEL_URL', 'preview.example.vercel.app');
    vi.stubEnv('PORT', '3101');

    expect(await requestedUrl()).toBe(`https://preview.example.vercel.app${PATH}`);
  });

  it('NEXTAUTH_URL も VERCEL_URL も無ければ、このサーバー自身のポート (PORT) の localhost を使う', async () => {
    vi.stubEnv('PORT', '3101');

    expect(await requestedUrl()).toBe(`http://localhost:3101${PATH}`);
  });

  it('PORT も無ければ (未設定・空・空白だけ)、Next.js の既定の 3000 の localhost を使う', async () => {
    expect(DEFAULT_SERVER_PORT).toBe(3000);
    expect(await requestedUrl()).toBe(`http://localhost:3000${PATH}`);

    vi.stubEnv('PORT', '');
    expect(await requestedUrl()).toBe(`http://localhost:3000${PATH}`);

    vi.stubEnv('PORT', '   ');
    expect(await requestedUrl()).toBe(`http://localhost:3000${PATH}`);
  });
});
