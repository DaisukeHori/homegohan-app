/**
 * #1365 段 2: 食事写真・冷蔵庫写真のバケット (meal_photos / fridge-images) が非公開であることを、ローカル Supabase の実物で確かめる
 *
 *   B-1: 2 つのバケットは public = false (health-checkups も非公開のまま)
 *   B-2: 保存された公開 URL は、未ログインでは 4xx (今のパス・旧パス meals/<user_id>/・generated/<献立>/・バケット直下のどれでも)
 *   B-3: 他人は、公開 URL でも 4xx。署名の API の決まり (signOwnedPhotoUrls) では null
 *   B-4: 本人は署名付き URL で見られる (中身も一致)。公開 URL は本人の JWT を付けても 4xx
 *   B-5: 運営の審査の署名 (持ち主を確かめない signPhotoUrlsForAuthorizedViewer) も非公開バケットで通る
 *   B-6: 本人の JWT で authenticated の経路を直接読むと、本人のフォルダは 200・旧パスは 4xx (storage.objects の SELECT ポリシーは変えていない。アプリはこの経路を使わない)
 *   B-7: meal_photos も同じ (未ログイン・他人・本人の JWT の公開 URL と、本人の JWT の authenticated の経路は 4xx。他人は署名の API の決まりで null。本人の署名付き URL は 200)
 *   B-8: 署名付き URL は有効期限を過ぎると 4xx
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/photo-buckets-private.test.ts
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { PHOTO_STORAGE_BUCKETS, type PhotoStorageBucket } from '@homegohan/shared';
import { signOwnedPhotoUrls, signPhotoUrlsForAuthorizedViewer } from '@/lib/photo-storage-signing';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);

/** HTTP の 200 */
const HTTP_OK = 200;
/** 4xx の範囲。Storage API は非公開バケットの公開の経路を 4xx で拒む (版で 400 / 404 が変わりうるので範囲で見る) */
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_CLIENT_ERROR_MAX = 499;
/** 署名付き URL の有効期限 (秒)。テストの間だけ使えればよい */
const TEST_TTL_SECONDS = 120;
/** 期限切れを見るときの有効期限 (秒) と、切れるのを待つ時間 (ms。同じ機械の Storage なので時計のずれは無い) */
const EXPIRY_PROBE_TTL_SECONDS = 1;
const EXPIRY_PROBE_WAIT_MS = 3_000;
const FRIDGE: PhotoStorageBucket = 'fridge-images';
const MEAL_PHOTOS: PhotoStorageBucket = 'meal_photos';
/** もとから非公開のバケット (本書の対象外。非公開のままであることだけ見る) */
const HEALTH_CHECKUPS_BUCKET = 'health-checkups';

const TS = Date.now();
const createdUserIds: string[] = [];
const uploaded: Array<{ bucket: PhotoStorageBucket; path: string }> = [];
const dailyMealIds: string[] = [];

interface TestUser {
  id: string;
  jwt: string;
}

/** PNG のシグネチャ 8 バイト + 空の 4 バイト (Storage は中身を検査しない) */
function tinyPng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-photo-private-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** service_role で置き、保存形 (公開 URL と同じ文字列) を返す */
async function put(bucket: PhotoStorageBucket, path: string): Promise<string> {
  const { error } = await srAdmin.storage.from(bucket).upload(path, tinyPng(), { contentType: 'image/png' });
  if (error) throw new Error(`upload ${bucket}: ${error.message}`);
  uploaded.push({ bucket, path });
  return srAdmin.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

async function plannedMealOf(userId: string): Promise<string> {
  const dailyId = randomUUID();
  const plannedId = randomUUID();
  const daily = await srAdmin.from('user_daily_meals').insert({ id: dailyId, user_id: userId, day_date: '2026-10-16' });
  if (daily.error) throw new Error(`user_daily_meals: ${daily.error.message}`);
  dailyMealIds.push(dailyId);
  const planned = await srAdmin
    .from('planned_meals')
    .insert({ id: plannedId, daily_meal_id: dailyId, meal_type: 'dinner', dish_name: 'photo-private test' });
  if (planned.error) throw new Error(`planned_meals: ${planned.error.message}`);
  return plannedId;
}

async function statusOf(target: string, headers: Record<string, string> = {}): Promise<number> {
  return (await fetch(target, { headers })).status;
}

function expectClientError(status: number): void {
  expect(status).toBeGreaterThanOrEqual(HTTP_CLIENT_ERROR_MIN);
  expect(status).toBeLessThanOrEqual(HTTP_CLIENT_ERROR_MAX);
}

/** 利用者の JWT で読む authenticated の経路 (アプリは使わない。ポリシーの記録のため) */
function authenticatedUrl(bucket: PhotoStorageBucket, path: string): string {
  return `${url}/storage/v1/object/authenticated/${bucket}/${path}`;
}

function bearer(jwt: string): Record<string, string> {
  return { Authorization: `Bearer ${jwt}`, apikey: anonKey };
}

let me: TestUser;
let other: TestUser;
let myMealId: string;
const urls: Record<string, string> = {};

beforeAll(async () => {
  [me, other] = await Promise.all([createUser('me'), createUser('other')]);
  myMealId = await plannedMealOf(me.id);
  urls.own = await put(FRIDGE, `${me.id}/fridge/own-${TS}.png`);
  urls.legacy = await put(FRIDGE, `meals/${me.id}/legacy-${TS}.png`);
  urls.legacyGenerated = await put(FRIDGE, `generated/${me.id}/legacy-generated-${TS}.png`);
  urls.ownGenerated = await put(FRIDGE, `generated/${myMealId}/job-${TS}.png`);
  urls.root = await put(FRIDGE, `root-${TS}.png`);
  urls.others = await put(FRIDGE, `${other.id}/fridge/others-${TS}.png`);
  urls.mealPhoto = await put(MEAL_PHOTOS, `${me.id}/meal-${TS}.png`);
});

afterAll(async () => {
  for (const bucket of PHOTO_STORAGE_BUCKETS) {
    const paths = uploaded.filter((object) => object.bucket === bucket).map((object) => object.path);
    if (paths.length > 0) await srAdmin.storage.from(bucket).remove(paths);
  }
  if (dailyMealIds.length > 0) {
    await srAdmin.from('planned_meals').delete().in('daily_meal_id', dailyMealIds);
    await srAdmin.from('user_daily_meals').delete().in('id', dailyMealIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
});

describe('#1365 段 2: 2 つのバケットは非公開', () => {
  it('B-1: meal_photos と fridge-images は public = false。health-checkups も非公開のまま', async () => {
    for (const bucket of [...PHOTO_STORAGE_BUCKETS, HEALTH_CHECKUPS_BUCKET]) {
      const { data, error } = await srAdmin.storage.getBucket(bucket);
      expect(error, bucket).toBeNull();
      expect(data?.public, bucket).toBe(false);
    }
  });

  it('B-2: 保存された公開 URL は、未ログインでは 4xx (今のパス・旧パス・generated/・バケット直下)', async () => {
    for (const key of ['own', 'legacy', 'legacyGenerated', 'ownGenerated', 'root', 'others']) {
      expectClientError(await statusOf(urls[key]));
    }
  });

  it('B-3: 他人は公開 URL でも 4xx で、署名の API の決まりでは null', async () => {
    expectClientError(await statusOf(urls.own, bearer(other.jwt)));
    const { signedUrls, notOwned } = await signOwnedPhotoUrls(srAdmin, other.id, [urls.own, urls.legacy, urls.ownGenerated], TEST_TTL_SECONDS);
    expect(signedUrls).toEqual({ [urls.own]: null, [urls.legacy]: null, [urls.ownGenerated]: null });
    expect(notOwned).toBe(3);
  });

  it('B-4: 本人は署名付き URL で見られる (今のパス・旧パス・generated/<user_id>/・generated/<本人の献立>/)。公開 URL は本人の JWT でも 4xx', async () => {
    const targets = [urls.own, urls.legacy, urls.legacyGenerated, urls.ownGenerated];
    const { signedUrls } = await signOwnedPhotoUrls(srAdmin, me.id, targets, TEST_TTL_SECONDS);
    for (const target of targets) {
      expectClientError(await statusOf(target, bearer(me.jwt)));
      const signed = signedUrls[target];
      expect(signed, target).toEqual(expect.stringContaining('/storage/v1/object/sign/'));
      const res = await fetch(signed!);
      expect(res.status, target).toBe(HTTP_OK);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(tinyPng());
    }
  });

  it('B-5: 運営の審査の署名 (持ち主を確かめない) も非公開バケットで通る', async () => {
    const signed = await signPhotoUrlsForAuthorizedViewer(srAdmin, [urls.others], TEST_TTL_SECONDS);
    expect(await statusOf(signed[urls.others]!)).toBe(HTTP_OK);
  });

  it('B-6: 本人の JWT の authenticated の経路は、本人のフォルダだけ 200 (旧パスは 4xx。ポリシーは変えていない)', async () => {
    expect(await statusOf(authenticatedUrl(FRIDGE, `${me.id}/fridge/own-${TS}.png`), bearer(me.jwt))).toBe(HTTP_OK);
    expectClientError(await statusOf(authenticatedUrl(FRIDGE, `meals/${me.id}/legacy-${TS}.png`), bearer(me.jwt)));
    expectClientError(await statusOf(authenticatedUrl(FRIDGE, `${me.id}/fridge/own-${TS}.png`), bearer(other.jwt)));
    expectClientError(await statusOf(authenticatedUrl(FRIDGE, `${me.id}/fridge/own-${TS}.png`)));
  });

  it('B-7: meal_photos も同じ (公開 URL は未ログイン・他人・本人のどれでも 4xx。他人は署名されず、本人の署名付き URL は 200)', async () => {
    expectClientError(await statusOf(urls.mealPhoto));
    expectClientError(await statusOf(urls.mealPhoto, bearer(other.jwt)));
    expectClientError(await statusOf(urls.mealPhoto, bearer(me.jwt)));
    // meal_photos には storage.objects の SELECT ポリシーが無い (§3.1) ので、本人の JWT の authenticated の経路も 4xx
    expectClientError(await statusOf(authenticatedUrl(MEAL_PHOTOS, `${me.id}/meal-${TS}.png`), bearer(me.jwt)));
    const fromOther = await signOwnedPhotoUrls(srAdmin, other.id, [urls.mealPhoto], TEST_TTL_SECONDS);
    expect(fromOther.signedUrls).toEqual({ [urls.mealPhoto]: null });
    expect(fromOther.notOwned).toBe(1);
    const { signedUrls } = await signOwnedPhotoUrls(srAdmin, me.id, [urls.mealPhoto], TEST_TTL_SECONDS);
    expect(await statusOf(signedUrls[urls.mealPhoto]!)).toBe(HTTP_OK);
  });

  it('B-8: 署名付き URL は有効期限を過ぎると 4xx', async () => {
    const { signedUrls } = await signOwnedPhotoUrls(srAdmin, me.id, [urls.own], EXPIRY_PROBE_TTL_SECONDS);
    const signed = signedUrls[urls.own]!;
    await new Promise((resolve) => setTimeout(resolve, EXPIRY_PROBE_WAIT_MS));
    expectClientError(await statusOf(signed));
  });
});
