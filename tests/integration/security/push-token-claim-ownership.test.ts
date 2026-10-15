/**
 * #1636 通知のトークンの claim の所有の証明と、セッション無しの release (結合テスト: ローカルの Supabase と next dev)
 *
 * POST /api/push-tokens/claim (#1599) は、同じトークンのほかの利用者の行を外す。以前は、トークンの値を知っているだけの他人が
 * 自分の行として登録して claim すると、持ち主の行を消せた。いまは端末の秘密の値 (端末ごとに 1 つ。サーバーはハッシュだけを持つ)
 * が合う行 (= 同じ端末の前の利用者) と、ハッシュの無い古い行だけを外す。
 * POST /api/push-tokens/release は、セッションが無いときに、利用者 ID・トークン・秘密の値が合う行だけを消す。
 *
 * 本物の DB (migration 20261015120000 の列と CHECK)・RLS・middleware・route で確かめること:
 *   O-1: 秘密の値の発行 — 端末に値が無ければ claim が値を作って 1 度だけ返し、本人の行にはハッシュだけが入る
 *   O-2: 他人の値で claim できない — 同じトークンを登録した他人は、自分の秘密の値・値なし・作り直しのどれでも持ち主の行を外せない
 *   O-3: 同じ端末の前の利用者の行は引き取れる — 同じ秘密の値の claim で前の利用者の行が外れ、他人の行は残る
 *   O-4: release — セッション無しで、秘密の値が合う本人の行だけが消える。他人の秘密の値では消えない
 *   O-5: 古い版のアプリの claim (秘密の値なし) は 200 のまま (ハッシュの無い古い行だけを外す)
 *   O-6: 凍結中でも claim は通り、ほかの API は 403 のまま
 *   O-7: 列の CHECK — 本人が RLS で形の違う値を書こうとしても DB が断る
 * メンテナンス中でも claim が通ること (と release・ほかの API が 503 のこと) は、メンテナンスを切り替える
 * tests/integration/security/feature-flags-runtime.test.ts が確かめる。
 *
 * 実行 (ローカル Supabase + ローカルの Next dev サーバが必要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/push-token-claim-ownership.test.ts
 */

import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';

import { isPushInstallSecret, PUSH_TOKEN_CLAIM_API_PATH, PUSH_TOKEN_RELEASE_API_PATH } from '../../../packages/shared/src/push-token-claim';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { supabaseAdmin } from '../helpers/supabase';
import { cleanupTestUser, createTestUserWithRoles, testEmail, type TestUser } from '../helpers/users';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// ユーザーと行を作るテストなので、本番や共有環境へ誤って向けない (ローカルのスタックだけを対象にする)
const supabaseHost = new URL(url).hostname;
if (supabaseHost !== 'localhost' && supabaseHost !== '127.0.0.1') {
  throw new Error(`NEXT_PUBLIC_SUPABASE_URL はローカルの Supabase を指してください (現在のホスト: ${supabaseHost})`);
}

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
/** PostgreSQL の CHECK 制約違反 */
const PG_CHECK_VIOLATION = '23514';

const TS = Date.now();
/** 共有の端末のトークン (ダミー。Expo に問い合わせない) */
const SHARED_DEVICE_TOKEN = `ExponentPushToken[it-1636-shared-${TS}]`;

type ClaimBody = { released?: number; install_secret?: string; error?: { code?: string } };

let ownerA: TestUser;
let nextUserB: TestUser;
let attackerC: TestUser;

function userClient(jwt: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** アプリの登録と同じ: 本人のクライアント (RLS) で upsert する (ハッシュの列は送らない) */
async function register(user: TestUser, token: string): Promise<void> {
  const { error } = await userClient(user.jwt)
    .from('user_push_tokens')
    .upsert({ user_id: user.userId, expo_push_token: token, platform: 'ios' }, { onConflict: 'user_id,expo_push_token' });
  expect(error, `${user.email} の登録`).toBeNull();
}

async function claim(user: TestUser, body: Record<string, unknown>) {
  return apiCall<ClaimBody>('POST', PUSH_TOKEN_CLAIM_API_PATH, user.jwt, { expo_push_token: SHARED_DEVICE_TOKEN, ...body });
}

/** 共有の端末のトークンの行 (利用者 → ハッシュ) */
async function rowsOfSharedToken(): Promise<Map<string, string | null>> {
  const { data, error } = await supabaseAdmin
    .from('user_push_tokens')
    .select('user_id, install_secret_hash')
    .eq('expo_push_token', SHARED_DEVICE_TOKEN);
  expect(error).toBeNull();
  return new Map((data ?? []).map((row) => [row.user_id as string, row.install_secret_hash as string | null]));
}

beforeAll(async () => {
  [ownerA, nextUserB, attackerC] = await Promise.all([
    createTestUserWithRoles({ email: testEmail('push1636-a', TS), roles: [] }),
    createTestUserWithRoles({ email: testEmail('push1636-b', TS), roles: [] }),
    createTestUserWithRoles({ email: testEmail('push1636-c', TS), roles: [] }),
  ]);
}, 60_000);

afterAll(async () => {
  await supabaseAdmin.from('user_push_tokens').delete().eq('expo_push_token', SHARED_DEVICE_TOKEN);
  for (const user of [ownerA, nextUserB, attackerC]) {
    if (user) await cleanupTestUser(user.userId);
  }
});

describe('通知のトークンの claim の所有の証明 (#1636・実 DB)', () => {
  let deviceSecret: string;

  it('O-1: 端末に秘密の値が無ければ、claim が値を作って 1 度だけ返し、本人の行にはハッシュだけが入る', async () => {
    await register(ownerA, SHARED_DEVICE_TOKEN);

    const res = await claim(ownerA, { issue_install_secret: true });

    expect(res.status).toBe(HTTP_OK);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(isPushInstallSecret(res.body.install_secret)).toBe(true);
    deviceSecret = res.body.install_secret as string;
    expect((await rowsOfSharedToken()).get(ownerA.userId)).toBe(sha256(deviceSecret));
  });

  it('O-2: 他人の値で claim できない (自分の秘密の値・値なし・作り直しのどれでも、持ち主の行は残る)', async () => {
    await register(attackerC, SHARED_DEVICE_TOKEN);

    const issued = await claim(attackerC, { issue_install_secret: true });
    expect(issued.status).toBe(HTTP_OK);
    expect(issued.body.released).toBe(0);
    const attackerSecret = issued.body.install_secret as string;
    expect(attackerSecret).not.toBe(deviceSecret);

    const withOwnSecret = await claim(attackerC, { install_secret: attackerSecret });
    expect(withOwnSecret.status).toBe(HTTP_OK);
    expect(withOwnSecret.body.released).toBe(0);
    const legacy = await claim(attackerC, {});
    expect(legacy.status).toBe(HTTP_OK);
    expect(legacy.body.released).toBe(0);

    const rows = await rowsOfSharedToken();
    expect(rows.get(ownerA.userId)).toBe(sha256(deviceSecret));
    expect(rows.has(attackerC.userId)).toBe(true);
  });

  it('O-3: 同じ端末の前の利用者の行は引き取れる (同じ秘密の値の claim で A の行が外れ、他人の C の行は残る)', async () => {
    await register(nextUserB, SHARED_DEVICE_TOKEN);

    const res = await claim(nextUserB, { install_secret: deviceSecret });

    expect(res.status).toBe(HTTP_OK);
    expect(res.body.released).toBe(1);
    const rows = await rowsOfSharedToken();
    expect(rows.has(ownerA.userId)).toBe(false);
    expect(rows.get(nextUserB.userId)).toBe(sha256(deviceSecret));
    expect(rows.has(attackerC.userId)).toBe(true);
  });

  it('O-4: release はセッション無しで、秘密の値が合う本人の行だけを消す (他人の秘密の値では消えない)', async () => {
    const attackerSecretRes = await claim(attackerC, { issue_install_secret: true });
    const attackerSecret = attackerSecretRes.body.install_secret as string;

    const wrong = await apiCallNoAuth<ClaimBody>('POST', PUSH_TOKEN_RELEASE_API_PATH, {
      expo_push_token: SHARED_DEVICE_TOKEN,
      install_secret: attackerSecret,
      user_id: nextUserB.userId,
    });
    expect(wrong.status).toBe(HTTP_OK);
    expect(wrong.body.released).toBe(0);
    expect((await rowsOfSharedToken()).has(nextUserB.userId)).toBe(true);

    const right = await apiCallNoAuth<ClaimBody>('POST', PUSH_TOKEN_RELEASE_API_PATH, {
      expo_push_token: SHARED_DEVICE_TOKEN,
      install_secret: deviceSecret,
      user_id: nextUserB.userId,
    });
    expect(right.status).toBe(HTTP_OK);
    expect(right.body.released).toBe(1);
    const rows = await rowsOfSharedToken();
    expect(rows.has(nextUserB.userId)).toBe(false);
    expect(rows.has(attackerC.userId)).toBe(true);
  });

  it('O-5: 古い版のアプリの claim (秘密の値なし) は 200 のままで、ハッシュの無い古い行だけを外す', async () => {
    // 古い版のアプリの行 (ハッシュなし) を A に作る
    await register(ownerA, SHARED_DEVICE_TOKEN);
    expect((await rowsOfSharedToken()).get(ownerA.userId)).toBeNull();
    await register(nextUserB, SHARED_DEVICE_TOKEN);

    const res = await claim(nextUserB, {});

    expect(res.status).toBe(HTTP_OK);
    expect(Object.keys(res.body)).toEqual(['released']);
    const rows = await rowsOfSharedToken();
    expect(rows.has(ownerA.userId)).toBe(false); // ハッシュの無い行は外れる
    expect(rows.has(attackerC.userId)).toBe(true); // ハッシュのある他人の行は外れない
  });

  it('O-6: 凍結中でも claim は通り、ほかの API は 403 のまま', async () => {
    const { error: freezeError } = await supabaseAdmin
      .from('user_profiles')
      .update({ frozen_at: new Date().toISOString(), unban_at: null })
      .eq('id', nextUserB.userId);
    expect(freezeError).toBeNull();
    try {
      await register(nextUserB, SHARED_DEVICE_TOKEN);
      const res = await claim(nextUserB, { install_secret: deviceSecret });
      expect(res.status).toBe(HTTP_OK);

      const other = await apiCall<ClaimBody>('GET', '/api/pantry', nextUserB.jwt);
      expect(other.status).toBe(HTTP_FORBIDDEN);
      expect(other.body.error?.code).toBe('AUTH_ACCOUNT_FROZEN');
    } finally {
      await supabaseAdmin.from('user_profiles').update({ frozen_at: null }).eq('id', nextUserB.userId);
    }
  });

  it('O-7: 本人が RLS で形の違うハッシュを書こうとしても、DB の CHECK が断る', async () => {
    const { error } = await userClient(attackerC.jwt)
      .from('user_push_tokens')
      .update({ install_secret_hash: 'not-a-sha256-hex' })
      .eq('user_id', attackerC.userId)
      .eq('expo_push_token', SHARED_DEVICE_TOKEN);
    expect(error?.code).toBe(PG_CHECK_VIOLATION);
  });
});
