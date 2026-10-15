// @vitest-environment node
/**
 * #1365 段 1: 食事写真・冷蔵庫写真の署名 (src/lib/photo-storage-signing.ts) のテスト
 *   - 本人の写真 (`<本人>/…`・旧パス `meals/<本人>/…`・`generated/<本人の献立>/…`) にだけ署名する
 *   - 他人のフォルダ・他人の献立の generated/・持ち主の分からないパス・2 つのバケット以外・`%2F` で隠したパスには署名しない
 *     (署名の API に渡しもしない)
 *   - 署名の失敗は null
 *   - 有効期限の環境変数の読み方
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS,
  PHOTO_SIGNED_URL_MAX_TTL_SECONDS,
  PHOTO_SIGNED_URL_MIN_TTL_SECONDS,
  parsePhotoObjectUrl,
  photoSignedUrlTtlSeconds,
  resolvePhotoUrlForOwnerRead,
  signOwnedPhotoUrls,
  signPhotoUrlsForAuthorizedViewer,
  type PhotoSigningAdmin,
} from '../src/lib/photo-storage-signing';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OWN_MEAL = '33333333-3333-4333-8333-333333333333';
const OTHERS_MEAL = '44444444-4444-4444-8444-444444444444';
const BASE = 'https://proj.supabase.co/storage/v1/object';
const url = (bucket: string, path: string) => `${BASE}/public/${bucket}/${path}`;
const TTL = 600;

interface FakeOptions {
  ownedPlannedMealIds?: string[];
  plannedMealsError?: boolean;
  missingPaths?: string[];
  bucketError?: string;
  throwOnSign?: boolean;
}

function fakeAdmin(options: FakeOptions = {}) {
  const signCalls: Array<{ bucket: string; paths: string[]; ttl: number }> = [];
  const plannedMealQueries: Array<{ userId: unknown; ids: unknown }> = [];
  const admin = {
    from: vi.fn((table: string) => {
      if (table !== 'planned_meals') throw new Error(`unexpected table ${table}`);
      const query: { userId?: unknown } = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          if (column === 'user_daily_meals.user_id') query.userId = value;
          return builder;
        },
        in: (_column: string, ids: string[]) => {
          plannedMealQueries.push({ userId: query.userId, ids });
          if (options.plannedMealsError) return Promise.resolve({ data: null, error: { message: 'boom' } });
          const owned = query.userId === USER ? (options.ownedPlannedMealIds ?? []) : [];
          return Promise.resolve({ data: ids.filter((id) => owned.includes(id)).map((id) => ({ id })), error: null });
        },
      };
      return builder;
    }),
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (paths: string[], ttl: number) => {
          signCalls.push({ bucket, paths, ttl });
          if (options.throwOnSign) throw new Error('network');
          if (options.bucketError === bucket) return { data: null, error: { message: 'Bucket not found' } };
          return {
            data: paths.map((path) =>
              options.missingPaths?.includes(path)
                ? { path, error: 'Object not found', signedUrl: null }
                : { path, error: null, signedUrl: `${BASE}/sign/${bucket}/${path}?token=t` },
            ),
            error: null,
          };
        },
      }),
    },
  };
  return { admin: admin as unknown as PhotoSigningAdmin, signCalls, plannedMealQueries };
}

const signedOf = (bucket: string, path: string) => `${BASE}/sign/${bucket}/${path}?token=t`;

describe('photoSignedUrlTtlSeconds', () => {
  it.each([
    [undefined, PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS],
    ['', PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS],
    ['600', 600],
    [String(PHOTO_SIGNED_URL_MIN_TTL_SECONDS), PHOTO_SIGNED_URL_MIN_TTL_SECONDS],
    [String(PHOTO_SIGNED_URL_MAX_TTL_SECONDS), PHOTO_SIGNED_URL_MAX_TTL_SECONDS],
    [String(PHOTO_SIGNED_URL_MIN_TTL_SECONDS - 1), PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS],
    [String(PHOTO_SIGNED_URL_MAX_TTL_SECONDS + 1), PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS],
    ['90.5', PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS],
    ['abc', PHOTO_SIGNED_URL_DEFAULT_TTL_SECONDS],
  ])('%s → %d', (value, expected) => {
    expect(photoSignedUrlTtlSeconds(value)).toBe(expected);
  });
});

describe('parsePhotoObjectUrl', () => {
  it('2 つのバケットの URL だけを取り出す', () => {
    expect(parsePhotoObjectUrl(url('fridge-images', `${USER}/a.jpg`))).toEqual({ bucket: 'fridge-images', path: `${USER}/a.jpg` });
    expect(parsePhotoObjectUrl(url('meal_photos', `${USER}/a.jpg`))).toEqual({ bucket: 'meal_photos', path: `${USER}/a.jpg` });
    expect(parsePhotoObjectUrl(url('health-checkups', `${USER}/a.jpg`))).toBeNull();
    expect(parsePhotoObjectUrl('https://images.unsplash.com/a.jpg')).toBeNull();
  });
});

describe('signOwnedPhotoUrls', () => {
  it('本人のフォルダ・旧パス・本人の献立の generated/ に署名する', async () => {
    const { admin, signCalls } = fakeAdmin({ ownedPlannedMealIds: [OWN_MEAL] });
    const own = url('fridge-images', `${USER}/fridge/a.jpg`);
    const legacy = url('fridge-images', `meals/${USER}/b.jpg`);
    const generated = url('fridge-images', `generated/${OWN_MEAL}/job-1.png`);
    const mealPhoto = url('meal_photos', `${USER}/c.jpg`);

    const result = await signOwnedPhotoUrls(admin, USER, [own, legacy, generated, mealPhoto], TTL);

    expect(result.signedUrls).toEqual({
      [own]: signedOf('fridge-images', `${USER}/fridge/a.jpg`),
      [legacy]: signedOf('fridge-images', `meals/${USER}/b.jpg`),
      [generated]: signedOf('fridge-images', `generated/${OWN_MEAL}/job-1.png`),
      [mealPhoto]: signedOf('meal_photos', `${USER}/c.jpg`),
    });
    expect(result).toMatchObject({ signFailures: 0, notOwned: 0 });
    expect(signCalls).toEqual([
      { bucket: 'fridge-images', paths: [`${USER}/fridge/a.jpg`, `meals/${USER}/b.jpg`, `generated/${OWN_MEAL}/job-1.png`], ttl: TTL },
      { bucket: 'meal_photos', paths: [`${USER}/c.jpg`], ttl: TTL },
    ]);
  });

  it('他人の写真には署名しない (署名の API にも渡さない)', async () => {
    const { admin, signCalls, plannedMealQueries } = fakeAdmin({ ownedPlannedMealIds: [OWN_MEAL] });
    const othersFolder = url('fridge-images', `${OTHER}/fridge/a.jpg`);
    const othersFolderMentioningMe = url('fridge-images', `${OTHER}/${USER}/a.jpg`);
    const othersLegacy = url('fridge-images', `meals/${OTHER}/b.jpg`);
    const othersGenerated = url('fridge-images', `generated/${OTHERS_MEAL}/job-2.png`);
    const unknownOwner = url('fridge-images', '1700000000000.jpg');
    const hiddenTraversal = `${BASE}/public/fridge-images/meals/${USER}/..%2F${OTHER}%2Fx.png`;
    const otherBucket = url('health-checkups', `${USER}/d.jpg`);
    const external = 'https://images.unsplash.com/photo.jpg';

    const result = await signOwnedPhotoUrls(
      admin,
      USER,
      [othersFolder, othersFolderMentioningMe, othersLegacy, othersGenerated, unknownOwner, hiddenTraversal, otherBucket, external],
      TTL,
    );

    expect(Object.values(result.signedUrls)).toEqual(Array(8).fill(null));
    expect(result.notOwned).toBe(5);
    expect(signCalls).toEqual([]);
    // 他人の献立の id は、本人の献立かどうかを DB で確かめる (本人の user id で絞る)
    expect(plannedMealQueries).toEqual([{ userId: USER, ids: [OTHERS_MEAL] }]);
  });

  it('献立の読み出しに失敗したら generated/ には署名しない (fail-closed)', async () => {
    const { admin, signCalls } = fakeAdmin({ ownedPlannedMealIds: [OWN_MEAL], plannedMealsError: true });
    const generated = url('fridge-images', `generated/${OWN_MEAL}/job-1.png`);
    const result = await signOwnedPhotoUrls(admin, USER, [generated], TTL);
    expect(result.signedUrls[generated]).toBeNull();
    expect(signCalls).toEqual([]);
  });

  it('generated/ が無ければ献立を読まない', async () => {
    const { admin, plannedMealQueries } = fakeAdmin();
    await signOwnedPhotoUrls(admin, USER, [url('fridge-images', `${USER}/a.jpg`)], TTL);
    expect(plannedMealQueries).toEqual([]);
  });

  it('ファイルが無い・バケットの署名に失敗した・例外は null にして数える', async () => {
    const missing = url('fridge-images', `${USER}/missing.jpg`);
    const present = url('fridge-images', `${USER}/present.jpg`);
    const mealPhoto = url('meal_photos', `${USER}/c.jpg`);
    const { admin } = fakeAdmin({ missingPaths: [`${USER}/missing.jpg`], bucketError: 'meal_photos' });
    const result = await signOwnedPhotoUrls(admin, USER, [missing, present, mealPhoto], TTL);
    expect(result.signedUrls).toEqual({
      [missing]: null,
      [present]: signedOf('fridge-images', `${USER}/present.jpg`),
      [mealPhoto]: null,
    });
    expect(result.signFailures).toBe(2);

    const thrown = await signOwnedPhotoUrls(fakeAdmin({ throwOnSign: true }).admin, USER, [present], TTL);
    expect(thrown.signedUrls[present]).toBeNull();
    expect(thrown.signFailures).toBe(1);
  });

  it('同じファイルを指す URL が複数あっても、署名は 1 回にまとめる', async () => {
    const { admin, signCalls } = fakeAdmin();
    const a = url('fridge-images', `${USER}/a.jpg`);
    const aRendered = `https://proj.supabase.co/storage/v1/render/image/public/fridge-images/${USER}/a.jpg?width=200`;
    const result = await signOwnedPhotoUrls(admin, USER, [a, aRendered], TTL);
    expect(signCalls).toEqual([{ bucket: 'fridge-images', paths: [`${USER}/a.jpg`], ttl: TTL }]);
    expect(result.signedUrls[a]).toBe(signedOf('fridge-images', `${USER}/a.jpg`));
    expect(result.signedUrls[aRendered]).toBe(signedOf('fridge-images', `${USER}/a.jpg`));
  });
});

describe('signPhotoUrlsForAuthorizedViewer (運営の審査)', () => {
  it('持ち主を問わず 2 つのバケットの写真に署名し、それ以外は null', async () => {
    const { admin } = fakeAdmin();
    const others = url('fridge-images', `${OTHER}/a.jpg`);
    const external = 'https://images.unsplash.com/photo.jpg';
    expect(await signPhotoUrlsForAuthorizedViewer(admin, [others, external], TTL)).toEqual({
      [others]: signedOf('fridge-images', `${OTHER}/a.jpg`),
      [external]: null,
    });
  });
});

describe('resolvePhotoUrlForOwnerRead (AI に渡す前)', () => {
  it('本人の写真は署名付き URL、他人の写真は ok: false、写真のバケット以外はそのまま', async () => {
    const { admin } = fakeAdmin();
    const own = url('fridge-images', `${USER}/a.jpg`);
    const others = url('fridge-images', `${OTHER}/a.jpg`);
    await expect(resolvePhotoUrlForOwnerRead(admin, USER, own, TTL)).resolves.toEqual({
      ok: true,
      url: signedOf('fridge-images', `${USER}/a.jpg`),
    });
    await expect(resolvePhotoUrlForOwnerRead(admin, USER, others, TTL)).resolves.toEqual({ ok: false });
    await expect(resolvePhotoUrlForOwnerRead(admin, USER, 'https://example.com/a.jpg', TTL)).resolves.toEqual({
      ok: true,
      url: 'https://example.com/a.jpg',
    });
  });
});
