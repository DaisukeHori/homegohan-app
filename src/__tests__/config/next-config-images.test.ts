import { describe, expect, it } from 'vitest';
import { PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS, PHOTO_SIGNED_URL_MIN_TTL_SECONDS } from '@/lib/photo-storage-signing';

/**
 * next.config.mjs: 画像の最適化 (/_next/image) が最適化した画像を使い回す最短の時間 (#1621)
 *
 * Next 15 の既定 (images.minimumCacheTTL) は 60 秒。Next 16 で既定が 4 時間 (14400 秒) に変わった。
 * 食事写真・冷蔵庫写真は期限つきの署名付き URL を next/image に渡して出す (src/components/photo/SignedPhotoImage.tsx) ので、
 * 使い回す時間が署名の期限より長いと、期限が切れた URL を含む /_next/image の URL でも写真が返り続ける。
 * Next 16 へ上げてもこの時間を長くしないよう、Next 15 の既定の値を明示している。設定を消すと Next 16 の既定に黙って切り替わる。
 */

/** Next 15 (15.5) の images.minimumCacheTTL の既定値 (秒) */
const NEXT15_DEFAULT_IMAGE_MINIMUM_CACHE_TTL_SEC = 60;

type NextConfigWithImages = { images?: { minimumCacheTTL?: number } };

describe('next.config.mjs: 画像の最適化の使い回しの時間は Next 15 の既定のまま (#1621)', () => {
  it('images.minimumCacheTTL は 60 秒', async () => {
    const mod = await import(/* @vite-ignore */ '../../../next.config.mjs');
    const config = mod.default as NextConfigWithImages;
    expect(config.images?.minimumCacheTTL).toBe(NEXT15_DEFAULT_IMAGE_MINIMUM_CACHE_TTL_SEC);
  });

  it('写真の署名付き URL の期限 (設定できる最短・既定) より長くない', async () => {
    const mod = await import(/* @vite-ignore */ '../../../next.config.mjs');
    const ttl = (mod.default as NextConfigWithImages).images?.minimumCacheTTL;
    expect(ttl).toBeDefined();
    expect(ttl).toBeLessThanOrEqual(PHOTO_SIGNED_URL_MIN_TTL_SECONDS);
    expect(ttl).toBeLessThanOrEqual(PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS);
  });
});
