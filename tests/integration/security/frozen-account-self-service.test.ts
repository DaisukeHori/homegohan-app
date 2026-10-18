/**
 * #1445 凍結 (BAN) 中の利用者も、退会とデータの書き出しをできる (実際の HTTP。Bearer JWT。Next の dev サーバが要る)
 *
 * middleware (lib/supabase/middleware.ts) は凍結中の利用者の /api 呼び出しを 403 AUTH_ACCOUNT_FROZEN で止める (#1030)。
 * 退会 (POST /api/account/delete) と書き出し (GET /api/account/export) だけは止めない (src/lib/auth/frozen.ts の
 * FROZEN_ALLOWED_API_PATHS)。本物の認証・本物の DB を通して、次を確かめる:
 *   A. 凍結中 (無期限) の利用者でも、ほかの API (個人情報の請求 /api/account/data-requests を含む。#1702) は今までどおり 403 AUTH_ACCOUNT_FROZEN
 *   B. 凍結中の利用者が書き出しを呼ぶと 200 で、本人のデータの JSON が返る
 *   C. 凍結中の利用者が退会を呼ぶと 200 { success: true } で、アカウントが消える (prepare_account_deletion などの後始末も通る)
 *   D. 一時 BAN の継続中 (unban_at が未来) の利用者も退会できる
 *   E. 凍結中の利用者も、お問い合わせを送れる (POST /api/contact は 200 で、本人の user_id の行が残る)。同じパスの GET (履歴) は 403 のまま
 *      (#1871。middleware の凍結の分岐の isFrozenContactSubmitRequest。C の退会より前に流す)
 *
 * 実行 (ローカル Supabase と Next の dev サーバが必要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev   # 別のターミナルで
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/frozen-account-self-service.test.ts
 *   (dev サーバが 3000 番以外のときは INTEGRATION_BASE_URL=http://localhost:<port> を付ける)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ユーザーを消すテストなので、本番や共有環境へ誤って向けない (ローカルのスタックだけを対象にする)
const supabaseHost = new URL(url).hostname;
if (supabaseHost !== 'localhost' && supabaseHost !== '127.0.0.1') {
  throw new Error(`NEXT_PUBLIC_SUPABASE_URL はローカルの Supabase を指してください (現在のホスト: ${supabaseHost})`);
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);
const RUN = randomBytes(4).toString('hex');
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
/** 一時 BAN の解除予定を「今から 1 日後」にするための長さ */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FROZEN_AT = '2026-10-01T00:00:00Z';

interface TestUser {
  id: string;
  jwt: string;
}

const createdUserIds: string[] = [];

/** 利用者を作ってサインインし (凍結の前にトークンを得る)、そのあとで運営と同じく service role で凍結する */
async function createFrozenUser(label: string, unbanAt: string | null): Promise<TestUser> {
  const email = `i1445-${label}-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createFrozenUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname: `i1445-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  const { error: freezeError } = await srAdmin
    .from('user_profiles')
    .update({ frozen_at: FROZEN_AT, frozen_reason: 'i1445 integration test', unban_at: unbanAt })
    .eq('id', data.user.id);
  if (freezeError) throw new Error(`freeze ${label}: ${freezeError.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

async function userExists(userId: string): Promise<boolean> {
  const { data } = await srAdmin.auth.admin.getUserById(userId);
  return Boolean(data.user);
}

let permanent: TestUser;
let temporary: TestUser;

beforeAll(async () => {
  permanent = await createFrozenUser('perm', null);
  temporary = await createFrozenUser('temp', new Date(Date.now() + ONE_DAY_MS).toISOString());
}, 90_000);

afterAll(async () => {
  for (const userId of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
}, 90_000);

describe('#1445 凍結中の利用者: ほかの API は止めたまま、退会と書き出しは通す', () => {
  // #1702 個人情報の請求 (GET /api/account/data-requests) も凍結中は受け付けない (設計 cross/15 S-13・§18)。
  // middleware の 403 を、単体の it.each (middleware-frozen-allowed-api.test.ts) に加えて本物の認証・本物の middleware で固定する
  it('A: ほかの API (GET /api/pantry・GET /api/export/meals・GET /api/account/data-requests) は今までどおり 403 AUTH_ACCOUNT_FROZEN', async () => {
    for (const path of ['/api/pantry', '/api/export/meals', '/api/account/data-requests']) {
      const res = await apiCall<{ error?: { code?: string } }>('GET', path, permanent.jwt);
      expect(res.status, path).toBe(403);
      expect(res.body.error?.code, path).toBe('AUTH_ACCOUNT_FROZEN');
    }
  }, 60_000);

  it('B: 書き出し (GET /api/account/export) は 200 で、本人のデータの JSON が返る', async () => {
    const res = await apiCall<{
      user_id?: string;
      summary?: { complete?: boolean };
      data?: { user_profiles?: Array<{ id: string; frozen_at: string | null }> };
    }>('GET', '/api/account/export', permanent.jwt);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="homegohan-export-/);
    expect(res.body.user_id).toBe(permanent.id);
    expect(res.body.summary?.complete).toBe(true);
    // 本人のプロフィール (凍結の記録を含む) が出る
    expect(res.body.data?.user_profiles?.map((row) => row.id)).toEqual([permanent.id]);
    expect(res.body.data?.user_profiles?.[0]?.frozen_at).not.toBeNull();
  }, 60_000);

  it('E (#1871): お問い合わせの送信 (POST /api/contact) は 200 で、本人の user_id の行が残る。同じパスの GET (履歴) は 403 AUTH_ACCOUNT_FROZEN のまま', async () => {
    const subject = `i1871-${RUN}`;
    const res = await apiCall<{ success?: boolean; inquiryId?: string }>('POST', '/api/contact', permanent.jwt, {
      inquiryType: 'support',
      email: `i1871-${RUN}@homegohan.test`,
      subject,
      message: '凍結中のお問い合わせ (結合テスト)',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.inquiryId).toBe('string');

    const { data: inquiry, error } = await srAdmin
      .from('inquiries')
      .select('user_id, subject, status')
      .eq('id', res.body.inquiryId!)
      .single();
    expect(error).toBeNull();
    expect(inquiry).toEqual({ user_id: permanent.id, subject, status: 'pending' });

    const history = await apiCall<{ error?: { code?: string } }>('GET', '/api/contact', permanent.jwt);
    expect(history.status).toBe(403);
    expect(history.body.error?.code).toBe('AUTH_ACCOUNT_FROZEN');
  }, 60_000);

  it('C: 退会 (POST /api/account/delete) は 200 { success: true } で、アカウントが消える', async () => {
    expect(await userExists(permanent.id)).toBe(true);

    const res = await apiCall<Record<string, unknown>>('POST', '/api/account/delete', permanent.jwt, { confirm: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(await userExists(permanent.id)).toBe(false);
  }, 120_000);

  it('D: 一時 BAN の継続中 (unban_at が未来) の利用者も、退会できる', async () => {
    const blocked = await apiCall<{ error?: { code?: string } }>('GET', '/api/pantry', temporary.jwt);
    expect(blocked.status).toBe(403);

    const res = await apiCall<Record<string, unknown>>('POST', '/api/account/delete', temporary.jwt, { confirm: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await userExists(temporary.id)).toBe(false);
  }, 120_000);
});
