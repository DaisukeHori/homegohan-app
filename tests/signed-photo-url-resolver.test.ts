// @vitest-environment node
/**
 * #1365 段 1: 写真の署名付き URL の問い合わせ役 (packages/shared/src/signed-photo-url.ts) のテスト
 *   - 振り分け (isPhotoStorageUrl): 食事写真・冷蔵庫写真のバケットの URL だけを問い合わせる
 *   - まとめる: 同じ時点に頼まれた URL は 1 回の問い合わせ (100 件ずつ)。同じ URL を同時に頼まれても 1 回
 *   - 覚える: 期限内は問い合わせない。期限の手前 (余白) を過ぎたら取り直す
 *   - 失敗: 問い合わせの失敗は null (表示しない) で返し、覚えない (次は問い合わせ直す)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createSignedPhotoUrlResolver,
  isPhotoStorageUrl,
  MAX_PHOTO_URLS_PER_SIGN_REQUEST,
  parseSignedPhotoUrlsResponse,
  SIGNED_PHOTO_URL_REFRESH_MARGIN_MS,
  type SignedPhotoUrlsResponse,
} from '@homegohan/shared';

const BASE = 'https://proj.supabase.co/storage/v1';
const photo = (name: string) => `${BASE}/object/public/fridge-images/u1/${name}.jpg`;
const signed = (url: string) => `${url.replace('/public/', '/sign/')}?token=t`;

const TTL_SECONDS = 3600;

function harness(fetchImpl?: (urls: string[]) => Promise<SignedPhotoUrlsResponse>) {
  let nowMs = 1_000_000;
  const pending: Array<() => void> = [];
  const fetchSigned = vi.fn(
    fetchImpl ??
      (async (urls: string[]) => ({
        signedUrls: Object.fromEntries(urls.map((url) => [url, signed(url)])),
        expiresInSeconds: TTL_SECONDS,
      })),
  );
  const resolver = createSignedPhotoUrlResolver({
    fetchSigned,
    now: () => nowMs,
    schedule: (run) => pending.push(run),
  });
  const flush = async () => {
    while (pending.length > 0) pending.shift()?.();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { resolver, fetchSigned, flush, advance: (ms: number) => (nowMs += ms), now: () => nowMs };
}

describe('isPhotoStorageUrl', () => {
  it.each([
    [`${BASE}/object/public/fridge-images/u1/a.jpg`, true],
    [`${BASE}/object/public/meal_photos/u1/a.jpg`, true],
    [`${BASE}/object/sign/fridge-images/u1/a.jpg?token=x`, true],
    [`${BASE}/render/image/public/fridge-images/u1/a.jpg?width=200`, true],
    [`${BASE}/object/public/health-checkups/u1/a.jpg`, false],
    [`${BASE}/object/public/fridge-images/`, false],
    ['https://images.unsplash.com/photo-1', false],
    ['/storage/v1/object/public/fridge-images/u1/a.jpg', false],
    ['', false],
    [null, false],
    [`${BASE}/object/public/fridge-images/${'a'.repeat(3000)}.jpg`, false],
  ])('%s → %s', (url, expected) => {
    expect(isPhotoStorageUrl(url)).toBe(expected);
  });
});

describe('parseSignedPhotoUrlsResponse', () => {
  it('形の正しい応答だけを受け付ける', () => {
    expect(parseSignedPhotoUrlsResponse({ signedUrls: { a: 'x', b: null }, expiresInSeconds: 60 })).toEqual({
      signedUrls: { a: 'x', b: null },
      expiresInSeconds: 60,
    });
    expect(parseSignedPhotoUrlsResponse(null)).toBeNull();
    expect(parseSignedPhotoUrlsResponse({ signedUrls: { a: 1 }, expiresInSeconds: 60 })).toBeNull();
    expect(parseSignedPhotoUrlsResponse({ signedUrls: [], expiresInSeconds: 60 })).toBeNull();
    expect(parseSignedPhotoUrlsResponse({ signedUrls: {}, expiresInSeconds: 0 })).toBeNull();
    expect(parseSignedPhotoUrlsResponse({ signedUrls: {} })).toBeNull();
  });
});

describe('createSignedPhotoUrlResolver', () => {
  it('写真のバケットの URL でなければ問い合わせずにそのまま返す', async () => {
    const { resolver, fetchSigned } = harness();
    await expect(resolver.resolve('https://images.unsplash.com/x')).resolves.toEqual({
      url: 'https://images.unsplash.com/x',
      refreshAt: null,
    });
    expect(fetchSigned).not.toHaveBeenCalled();
  });

  it('同じ時点に頼まれた URL は 1 回にまとめ、同じ URL は 1 つにする', async () => {
    const { resolver, fetchSigned, flush, now } = harness();
    const a = resolver.resolve(photo('a'));
    const b = resolver.resolve(photo('b'));
    const a2 = resolver.resolve(photo('a'));
    await flush();
    expect(fetchSigned).toHaveBeenCalledTimes(1);
    expect(fetchSigned).toHaveBeenCalledWith([photo('a'), photo('b')]);
    const expectedRefreshAt = now() + TTL_SECONDS * 1000 - SIGNED_PHOTO_URL_REFRESH_MARGIN_MS;
    await expect(a).resolves.toEqual({ url: signed(photo('a')), refreshAt: expectedRefreshAt });
    await expect(a2).resolves.toEqual({ url: signed(photo('a')), refreshAt: expectedRefreshAt });
    await expect(b).resolves.toEqual({ url: signed(photo('b')), refreshAt: expectedRefreshAt });
  });

  it(`${MAX_PHOTO_URLS_PER_SIGN_REQUEST} 件を超えたら分けて問い合わせる`, async () => {
    const { resolver, fetchSigned, flush } = harness();
    const count = MAX_PHOTO_URLS_PER_SIGN_REQUEST + 1;
    const all = Array.from({ length: count }, (_, i) => resolver.resolve(photo(`p${i}`)));
    await flush();
    expect(fetchSigned).toHaveBeenCalledTimes(2);
    expect(fetchSigned.mock.calls[0][0]).toHaveLength(MAX_PHOTO_URLS_PER_SIGN_REQUEST);
    expect(fetchSigned.mock.calls[1][0]).toEqual([photo(`p${count - 1}`)]);
    const results = await Promise.all(all);
    expect(results.every((r, i) => r.url === signed(photo(`p${i}`)))).toBe(true);
  });

  it('期限内は覚えた答えを使い、余白の手前を過ぎたら取り直す', async () => {
    const { resolver, fetchSigned, flush, advance } = harness();
    const first = resolver.resolve(photo('a'));
    await flush();
    await first;
    expect(resolver.peek(photo('a'))?.url).toBe(signed(photo('a')));

    advance(TTL_SECONDS * 1000 - SIGNED_PHOTO_URL_REFRESH_MARGIN_MS - 1);
    await expect(resolver.resolve(photo('a'))).resolves.toMatchObject({ url: signed(photo('a')) });
    expect(fetchSigned).toHaveBeenCalledTimes(1);

    advance(1);
    expect(resolver.peek(photo('a'))).toBeUndefined();
    const again = resolver.resolve(photo('a'));
    await flush();
    await again;
    expect(fetchSigned).toHaveBeenCalledTimes(2);
  });

  it('有効期限が余白より短くても、すぐに取り直しを繰り返さない (余白は期限の半分まで)', async () => {
    const shortTtlSeconds = 30;
    const { resolver, flush, now } = harness(async (urls) => ({
      signedUrls: Object.fromEntries(urls.map((url) => [url, signed(url)])),
      expiresInSeconds: shortTtlSeconds,
    }));
    const pending = resolver.resolve(photo('a'));
    await flush();
    const result = await pending;
    expect(result.refreshAt).toBe(now() + (shortTtlSeconds * 1000) / 2);
  });

  it('サーバーが署名しなかった URL (null) は null を返す (公開 URL に戻さない)', async () => {
    const { resolver, flush } = harness(async (urls) => ({
      signedUrls: Object.fromEntries(urls.map((url) => [url, null])),
      expiresInSeconds: TTL_SECONDS,
    }));
    const pending = resolver.resolve(photo('other'));
    await flush();
    await expect(pending).resolves.toMatchObject({ url: null });
  });

  it('応答に無い URL も null にする', async () => {
    const { resolver, flush } = harness(async () => ({ signedUrls: {}, expiresInSeconds: TTL_SECONDS }));
    const pending = resolver.resolve(photo('missing'));
    await flush();
    await expect(pending).resolves.toMatchObject({ url: null });
  });

  it('問い合わせに失敗したら null で返し、覚えない (次は問い合わせ直す)', async () => {
    let fail = true;
    const { resolver, fetchSigned, flush } = harness(async (urls) => {
      if (fail) throw new Error('network');
      return { signedUrls: Object.fromEntries(urls.map((url) => [url, signed(url)])), expiresInSeconds: TTL_SECONDS };
    });
    const first = resolver.resolve(photo('a'));
    await flush();
    await expect(first).resolves.toEqual({ url: null, refreshAt: null });
    expect(resolver.peek(photo('a'))).toBeUndefined();

    fail = false;
    const second = resolver.resolve(photo('a'));
    await flush();
    await expect(second).resolves.toMatchObject({ url: signed(photo('a')) });
    expect(fetchSigned).toHaveBeenCalledTimes(2);
  });

  it('clear で覚えた答えを捨てる', async () => {
    const { resolver, flush } = harness();
    const pending = resolver.resolve(photo('a'));
    await flush();
    await pending;
    resolver.clear();
    expect(resolver.peek(photo('a'))).toBeUndefined();
  });
});
