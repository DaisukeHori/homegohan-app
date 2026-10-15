/**
 * #1365 段 1: 食事写真・冷蔵庫写真の署名 (src/lib/photo-storage-signing.ts) を、ローカル Supabase の実物の Storage と DB で確かめる
 *
 *   S-1: 本人の写真 (本人のフォルダ・旧パス meals/<本人>/・本人の献立の generated/) には署名し、その URL で画像を取れる
 *   S-2: 他人の写真 (他人のフォルダ・他人の献立の generated/) には署名しない
 *   S-3: 無いファイルは null
 *   S-4: バケットを非公開にしても (段 2)、署名付き URL では表示でき、公開 URL では表示できない。
 *        このテストの中だけで fridge-images を非公開にし、終わったら公開に戻す (結合テストはファイルもテストも 1 本ずつ流れる)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/photo-signed-urls.test.ts
 */
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { signOwnedPhotoUrls } from '../../../src/lib/photo-storage-signing';

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
const BUCKET = 'fridge-images';
/** 署名付き URL の有効期限 (秒)。テストの間だけ使えればよい */
const TEST_TTL_SECONDS = 120;
/** HTTP の 200 */
const HTTP_OK = 200;

const TS = Date.now();
const createdUserIds: string[] = [];
const uploadedPaths: string[] = [];
const dailyMealIds: string[] = [];

function tinyPng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

async function createUser(label: string): Promise<string> {
  const { data, error } = await srAdmin.auth.admin.createUser({
    email: `sec-photo-sign-${label}-${TS}@homegohan.test`,
    password: 'TestPass!2026-sec',
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function put(path: string): Promise<string> {
  const { error } = await srAdmin.storage.from(BUCKET).upload(path, tinyPng(), { contentType: 'image/png' });
  if (error) throw new Error(`upload: ${error.message}`);
  uploadedPaths.push(path);
  return srAdmin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function plannedMealOf(userId: string): Promise<string> {
  const dailyId = randomUUID();
  const plannedId = randomUUID();
  const daily = await srAdmin.from('user_daily_meals').insert({ id: dailyId, user_id: userId, day_date: '2026-10-15' });
  if (daily.error) throw new Error(`user_daily_meals: ${daily.error.message}`);
  dailyMealIds.push(dailyId);
  const planned = await srAdmin
    .from('planned_meals')
    .insert({ id: plannedId, daily_meal_id: dailyId, meal_type: 'dinner', dish_name: 'photo-sign test' });
  if (planned.error) throw new Error(`planned_meals: ${planned.error.message}`);
  return plannedId;
}

let me: string;
let other: string;
const urls: Record<string, string> = {};

beforeAll(async () => {
  [me, other] = await Promise.all([createUser('me'), createUser('other')]);
  const [myMeal, othersMeal] = await Promise.all([plannedMealOf(me), plannedMealOf(other)]);
  urls.own = await put(`${me}/fridge/own-${TS}.png`);
  urls.legacy = await put(`meals/${me}/legacy-${TS}.png`);
  urls.ownGenerated = await put(`generated/${myMeal}/job-${TS}.png`);
  urls.others = await put(`${other}/fridge/others-${TS}.png`);
  urls.othersGenerated = await put(`generated/${othersMeal}/job-${TS}.png`);
  urls.missing = srAdmin.storage.from(BUCKET).getPublicUrl(`${me}/fridge/missing-${TS}.png`).data.publicUrl;
});

afterAll(async () => {
  // S-4 が途中で落ちても、公開に戻しておく (ほかの結合テストは公開バケットを前提にしている)
  await srAdmin.storage.updateBucket(BUCKET, { public: true });
  if (uploadedPaths.length > 0) await srAdmin.storage.from(BUCKET).remove(uploadedPaths);
  if (dailyMealIds.length > 0) {
    await srAdmin.from('planned_meals').delete().in('daily_meal_id', dailyMealIds);
    await srAdmin.from('user_daily_meals').delete().in('id', dailyMealIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
});

describe('signOwnedPhotoUrls (実物の Storage)', () => {
  it('S-1: 本人の写真に署名し、その URL で画像を取れる', async () => {
    const targets = [urls.own, urls.legacy, urls.ownGenerated];
    const { signedUrls } = await signOwnedPhotoUrls(srAdmin, me, targets, TEST_TTL_SECONDS);
    for (const target of targets) {
      const signed = signedUrls[target];
      expect(signed).toEqual(expect.stringContaining('/storage/v1/object/sign/'));
      const res = await fetch(signed!);
      expect(res.status).toBe(HTTP_OK);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(tinyPng());
    }
  });

  it('S-2: 他人の写真には署名しない', async () => {
    const result = await signOwnedPhotoUrls(srAdmin, me, [urls.others, urls.othersGenerated], TEST_TTL_SECONDS);
    expect(result.signedUrls).toEqual({ [urls.others]: null, [urls.othersGenerated]: null });
    expect(result.notOwned).toBe(2);
    // 持ち主本人なら署名できる (他人の写真がそもそも署名できないのではないことを確かめる)
    const asOwner = await signOwnedPhotoUrls(srAdmin, other, [urls.others, urls.othersGenerated], TEST_TTL_SECONDS);
    expect(Object.values(asOwner.signedUrls).every((value) => typeof value === 'string')).toBe(true);
  });

  it('S-3: 無いファイルは null', async () => {
    const result = await signOwnedPhotoUrls(srAdmin, me, [urls.missing], TEST_TTL_SECONDS);
    expect(result.signedUrls[urls.missing]).toBeNull();
    expect(result.signFailures).toBe(1);
  });

  it('S-4: バケットを非公開にしても署名付き URL では表示でき、公開 URL では表示できない', async () => {
    const { error } = await srAdmin.storage.updateBucket(BUCKET, { public: false });
    expect(error).toBeNull();
    try {
      const { signedUrls } = await signOwnedPhotoUrls(srAdmin, me, [urls.own], TEST_TTL_SECONDS);
      expect((await fetch(signedUrls[urls.own]!)).status).toBe(HTTP_OK);
      expect((await fetch(urls.own)).status).not.toBe(HTTP_OK);
    } finally {
      await srAdmin.storage.updateBucket(BUCKET, { public: true });
    }
    expect((await fetch(urls.own)).status).toBe(HTTP_OK);
  });
});
