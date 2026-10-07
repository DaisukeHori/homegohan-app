/**
 * 本番ドリフト P-2〜P-6 (docs/operations/rls-drift-20261006.md): 画像バケットのポリシーを本人のフォルダに限定する回帰テスト
 *
 * 本番だけにある storage.objects のポリシー:
 *   - fridge-images: "Allow authenticated users to upload 17k8aio_0" (INSERT、パスの制限なし)
 *                    "Allow public to read 17k8aio_0" (SELECT、ログインユーザーなら全員分を一覧できる)
 *   - meal_photos:   "Allow authenticated uploads" (INSERT、パスの制限なし)
 *                    "Allow public viewing" (SELECT TO public、未ログインでも全件を一覧できる)
 * 2026-10-07 のオーナー判断「自分のフォルダに限定」:
 *   - fridge-images のアップロードと一覧は本人のフォルダ ((storage.foldername(name))[1] = auth.uid()) だけ
 *   - meal_photos (コードから使われていない) はアップロードと一覧を止める
 *   - どちらも公開バケットのまま (保存済みの公開 URL での表示は変わらない)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/storage-fridge-images-rls.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const createdUserIds: string[] = [];
const fridgePaths: string[] = [];
const mealPhotoPaths: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-storage-rls-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

function tinyPng(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

async function upload(
  c: SupabaseClient,
  bucket: string,
  path: string,
  upsert = false,
): Promise<{ error: { message: string } | null }> {
  const { error } = await c.storage.from(bucket).upload(path, tinyPng(), { contentType: 'image/png', upsert });
  if (!error) (bucket === 'fridge-images' ? fridgePaths : mealPhotoPaths).push(path);
  return { error: error ? { message: error.message } : null };
}

async function listNames(c: SupabaseClient, bucket: string, folder: string): Promise<string[]> {
  const { data, error } = await c.storage.from(bucket).list(folder);
  expect(error).toBeNull();
  return (data ?? []).map((o) => o.name);
}

let userA: TestUser;
let userB: TestUser;

beforeAll(async () => {
  [userA, userB] = await Promise.all([createUser('a'), createUser('b')]);
  // B の画像を 1 枚置いておく (service_role で。A から見えないことを確かめる)
  const { error } = await srAdmin.storage
    .from('fridge-images')
    .upload(`${userB.id}/fridge/b-${TS}.png`, tinyPng(), { contentType: 'image/png' });
  if (error) throw new Error(`seed: ${error.message}`);
  fridgePaths.push(`${userB.id}/fridge/b-${TS}.png`);
}, 60_000);

afterAll(async () => {
  if (fridgePaths.length > 0) await srAdmin.storage.from('fridge-images').remove(fridgePaths);
  if (mealPhotoPaths.length > 0) await srAdmin.storage.from('meal_photos').remove(mealPhotoPaths);
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

describe('fridge-images: アップロードは本人のフォルダだけ', () => {
  it('U-1: 本人のフォルダ <user_id>/fridge/ にアップロードできる', async () => {
    expect((await upload(asUser(userA.jwt), 'fridge-images', `${userA.id}/fridge/a-${TS}.png`)).error).toBeNull();
  });

  it('U-2: 本人のフォルダへの upsert (AI 画像生成の形) もできる', async () => {
    const path = `${userA.id}/generated/a-${TS}.png`;
    expect((await upload(asUser(userA.jwt), 'fridge-images', path, true)).error).toBeNull();
  });

  it('U-2b: 既存ファイルの上書きはできない (本番と同じく UPDATE ポリシーを置かない)', async () => {
    const path = `${userA.id}/generated/a-${TS}.png`;
    expect((await upload(asUser(userA.jwt), 'fridge-images', path, true)).error).not.toBeNull();
  });

  it('U-3: 他人のフォルダにはアップロードできない', async () => {
    expect((await upload(asUser(userA.jwt), 'fridge-images', `${userB.id}/fridge/by-a-${TS}.png`)).error).not.toBeNull();
  });

  it('U-4: バケット直下や旧パス (meals/<user_id>/…) にはアップロードできない', async () => {
    expect((await upload(asUser(userA.jwt), 'fridge-images', `root-${TS}.png`)).error).not.toBeNull();
    expect((await upload(asUser(userA.jwt), 'fridge-images', `meals/${userA.id}/old-${TS}.png`)).error).not.toBeNull();
  });

  it('U-5: 未ログインはアップロードできない', async () => {
    expect((await upload(anon(), 'fridge-images', `${userA.id}/fridge/anon-${TS}.png`)).error).not.toBeNull();
  });
});

describe('fridge-images: 一覧は本人のフォルダだけ。公開 URL での表示はそのまま', () => {
  it('L-1: 本人は自分のフォルダを一覧できる', async () => {
    expect(await listNames(asUser(userA.jwt), 'fridge-images', `${userA.id}/fridge`)).toContain(`a-${TS}.png`);
  });

  it('L-2: 他人のフォルダは一覧できない (0 件)', async () => {
    expect(await listNames(asUser(userA.jwt), 'fridge-images', `${userB.id}/fridge`)).toEqual([]);
  });

  it('L-3: 未ログインは一覧できない (0 件)', async () => {
    expect(await listNames(anon(), 'fridge-images', `${userB.id}/fridge`)).toEqual([]);
  });

  it('P-1: 公開 URL では誰でも表示できる (公開バケットのまま)', async () => {
    const { data } = anon().storage.from('fridge-images').getPublicUrl(`${userB.id}/fridge/b-${TS}.png`);
    const res = await fetch(data.publicUrl);
    expect(res.status).toBe(200);
  });
});

describe('meal_photos: アップロードと一覧を止める', () => {
  it('M-1: ログインユーザーでもアップロードできない', async () => {
    expect((await upload(asUser(userA.jwt), 'meal_photos', `${userA.id}/m-${TS}.png`)).error).not.toBeNull();
  });

  it('M-2: 一覧できない (0 件)', async () => {
    const { error } = await srAdmin.storage
      .from('meal_photos')
      .upload(`${userB.id}/seed-${TS}.png`, tinyPng(), { contentType: 'image/png' });
    expect(error).toBeNull();
    mealPhotoPaths.push(`${userB.id}/seed-${TS}.png`);
    expect(await listNames(anon(), 'meal_photos', userB.id)).toEqual([]);
    expect(await listNames(asUser(userA.jwt), 'meal_photos', userB.id)).toEqual([]);
  });

  it('M-3: 公開 URL では表示できる (公開バケットのまま)', async () => {
    const { data } = anon().storage.from('meal_photos').getPublicUrl(`${userB.id}/seed-${TS}.png`);
    const res = await fetch(data.publicUrl);
    expect(res.status).toBe(200);
  });
});
