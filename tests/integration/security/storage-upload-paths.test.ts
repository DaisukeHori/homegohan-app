/**
 * fridge-images バケットの保存パスが「本人のフォルダ (<user_id>/...)」になることの回帰テスト
 *
 * 本番だけにある storage.objects のポリシー (docs/operations/rls-drift-20261006.md の P-4〜P-6) は、
 * ログインユーザーなら他人のフォルダを含む任意のパスにアップロードでき、全員分を一覧できる。
 * 2026-10-07 のオーナー判断で、アップロードと一覧を本人のフォルダ ((storage.foldername(name))[1] = auth.uid()) に限定する。
 * その前に、利用者のセッションでアップロードするパスを <user_id>/<用途>/<ファイル名> にそろえる
 * (旧: POST /api/upload は <folder>/<user_id>/...、週の献立リクエストはバケット直下、
 *  AI 画像生成は generated/<user_id>/...、Edge Function analyze-meal-photo は meals/<user_id>/...)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/storage-upload-paths.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);

const TS = Date.now();
let userId = '';
let jwt = '';
const uploadedPaths: string[] = [];

/** JPEG の magic bytes (FF D8 FF) で始まる小さなバイト列 (/api/upload の検査を通す) */
function tinyJpeg(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

beforeAll(async () => {
  const email = `sec-storage-path-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: userId, nickname: 'storage-path', age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile: ${profileError.message}`);
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  jwt = signIn.data.session.access_token;
}, 60_000);

afterAll(async () => {
  if (uploadedPaths.length > 0) await srAdmin.storage.from('fridge-images').remove(uploadedPaths);
  if (userId) {
    await srAdmin.from('user_profiles').delete().eq('id', userId);
    await srAdmin.auth.admin.deleteUser(userId);
  }
}, 30_000);

describe('fridge-images の保存パス', () => {
  it('P-1: POST /api/upload は <user_id>/<folder>/ の下に保存し、その公開 URL を返す', async () => {
    const form = new FormData();
    form.append('file', new Blob([tinyJpeg()], { type: 'image/jpeg' }), 'meal.jpg');
    form.append('folder', 'meals');
    const res = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    expect(res.status).toBe(200);
    const { url: publicUrl } = (await res.json()) as { url: string };

    const marker = '/storage/v1/object/public/fridge-images/';
    expect(publicUrl).toContain(marker);
    const objectPath = decodeURIComponent(publicUrl.slice(publicUrl.indexOf(marker) + marker.length));
    uploadedPaths.push(objectPath);
    expect(objectPath.startsWith(`${userId}/meals/`)).toBe(true);

    // 実際にそのパスへ保存されている
    const { data: listed, error } = await srAdmin.storage.from('fridge-images').list(`${userId}/meals`);
    expect(error).toBeNull();
    expect((listed ?? []).map((o) => `${userId}/meals/${o.name}`)).toContain(objectPath);
  });
});
