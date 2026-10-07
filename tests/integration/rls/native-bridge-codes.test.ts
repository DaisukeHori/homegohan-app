/**
 * #1036 モバイル WebView 認証ブリッジ: ワンタイムコード表 (public.native_bridge_codes) と
 * 発行 / 消費 RPC の権限・原子性の回帰テスト
 *
 * 背景: モバイルアプリは WebView を認証済みにするため、アクセストークンとリフレッシュトークンを
 * URL クエリ (GET /auth/native-bridge?access_token=...&refresh_token=...) で渡していた。
 * URL はアクセスログに残るため、有効なトークンがログに漏れる。
 * 修正後は URL にワンタイムコードだけを載せ、サーバ側 (service_role) でコードをトークンに交換する。
 * この表は「コードの sha256 -> トークン」を 60 秒だけ保持するため、クライアントからは何も見えてはならない。
 *
 * 期待する挙動:
 *   - anon / authenticated: 表の SELECT / INSERT / UPDATE / DELETE も、2 つの RPC も 42501 (permission denied)
 *   - service_role: 発行すると sha256 だけが保存され (コード本体の列は無い)、消費すると 1 行返って行が消える
 *   - 同じコードの同時消費は 1 つだけ成功する (DELETE ... RETURNING の原子性)
 *   - 期限切れのコードは行を返さず、行も残さない (トークンを DB に残さない)
 *   - 1 ユーザーあたりの未消費コードは 20 件まで。発行のたびに期限切れ行を掃除する
 *   - ttl が範囲外 (1〜120 秒以外) は 22023。表の CHECK 制約が壊れた値を拒否する
 *   - ユーザーを消すとコードも消える (ON DELETE CASCADE)
 *
 * PostgREST を supabase-js で直接叩いて検証する (アプリ層のガードを経由しない経路が攻撃面のため)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/native-bridge-codes.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ---------------------------------------------------------------
// クライアントファクトリ (is-inactive-user-rpc.test.ts と同型)
// ---------------------------------------------------------------
function anonClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function serviceRoleClient(): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function authedClient(accessToken: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const srAdmin = serviceRoleClient();

// ---------------------------------------------------------------
// テストユーザー (使い捨て。ローカル専用のパスワード)
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls';
const createdUserIds: string[] = [];

async function createTestUser(label: string): Promise<TestUser> {
  const email = `rls-1036-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const userId = data.user.id;
  createdUserIds.push(userId);

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signIn = await anonClient().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`Failed to sign in ${email}: ${signIn.error?.message}`);
  }
  return { userId, email, jwt: signIn.data.session.access_token };
}

let userA: TestUser;
let userB: TestUser;

/** 64 桁 16 進のコードハッシュ (テーブルの CHECK を満たす) */
function newCodeHash(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex');
}

/** 発行 RPC を service_role で呼ぶ。トークン値はテスト用のダミー */
async function issue(userId: string, codeHash: string, ttl?: number | null) {
  return srAdmin.rpc('issue_native_bridge_code', {
    p_code_hash: codeHash,
    p_user_id: userId,
    p_access_token: `at-${codeHash.slice(0, 8)}`,
    p_refresh_token: `rt-${codeHash.slice(0, 8)}`,
    ...(ttl === undefined ? {} : { p_ttl_seconds: ttl }),
  });
}

async function consume(codeHash: string) {
  return srAdmin.rpc('consume_native_bridge_code', { p_code_hash: codeHash });
}

async function rowsByHash(codeHash: string) {
  const { data, error } = await srAdmin.from('native_bridge_codes').select('code_hash').eq('code_hash', codeHash);
  if (error) throw new Error(`select native_bridge_codes: ${error.message}`);
  return data ?? [];
}

async function rowsByUser(userId: string) {
  const { data, error } = await srAdmin
    .from('native_bridge_codes')
    .select('code_hash, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`select native_bridge_codes by user: ${error.message}`);
  return data ?? [];
}

beforeAll(async () => {
  userA = await createTestUser('a');
  userB = await createTestUser('b');
}, 60_000);

afterAll(async () => {
  // 表の行を先に消す (ユーザー削除の CASCADE でも消えるが、確認のため明示する)
  for (const id of createdUserIds) {
    await srAdmin.from('native_bridge_codes').delete().eq('user_id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

// ================================================================
// anon / authenticated: 表も RPC も触れない
// ================================================================
describe('#1036 native_bridge_codes: anon は何も触れない', () => {
  it('S-1: anon は表の SELECT / INSERT / UPDATE / DELETE がすべて 42501', async () => {
    const client = anonClient();
    const hash = newCodeHash();

    const sel = await client.from('native_bridge_codes').select('code_hash').limit(1);
    expect(sel.error?.code).toBe('42501');

    const ins = await client.from('native_bridge_codes').insert({
      code_hash: hash,
      user_id: userA.userId,
      access_token: 'forged-at',
      refresh_token: 'forged-rt',
    });
    expect(ins.error?.code).toBe('42501');

    const upd = await client.from('native_bridge_codes').update({ access_token: 'x' }).eq('code_hash', hash);
    expect(upd.error?.code).toBe('42501');

    const del = await client.from('native_bridge_codes').delete().eq('code_hash', hash);
    expect(del.error?.code).toBe('42501');

    // 偽造した行が入っていないこと
    expect(await rowsByHash(hash)).toEqual([]);
  });

  it('S-2: anon は発行 / 消費 RPC を呼べない (42501)', async () => {
    const client = anonClient();
    const hash = newCodeHash();

    const issued = await client.rpc('issue_native_bridge_code', {
      p_code_hash: hash,
      p_user_id: userA.userId,
      p_access_token: 'forged-at',
      p_refresh_token: 'forged-rt',
    });
    expect(issued.error?.code).toBe('42501');
    expect(await rowsByHash(hash)).toEqual([]);

    const consumed = await client.rpc('consume_native_bridge_code', { p_code_hash: hash });
    expect(consumed.error?.code).toBe('42501');
  });
});

describe('#1036 native_bridge_codes: authenticated (ログイン済みの一般ユーザー) も何も触れない', () => {
  it('S-3: authenticated は表の SELECT / INSERT / UPDATE / DELETE がすべて 42501 (自分の user_id でも)', async () => {
    const client = authedClient(userA.jwt);
    const hash = newCodeHash();

    // 正規の経路で A の行を 1 件作っておく (読めないこと / 消せないことを確かめるため)
    const seeded = await issue(userA.userId, hash);
    expect(seeded.error).toBeNull();

    const sel = await client.from('native_bridge_codes').select('code_hash').eq('user_id', userA.userId);
    expect(sel.error?.code).toBe('42501');

    const ins = await client.from('native_bridge_codes').insert({
      code_hash: newCodeHash(),
      user_id: userA.userId,
      access_token: 'forged-at',
      refresh_token: 'forged-rt',
    });
    expect(ins.error?.code).toBe('42501');

    const upd = await client.from('native_bridge_codes').update({ user_id: userB.userId }).eq('code_hash', hash);
    expect(upd.error?.code).toBe('42501');

    const del = await client.from('native_bridge_codes').delete().eq('code_hash', hash);
    expect(del.error?.code).toBe('42501');

    // 行は無傷で、user_id も書き換わっていない
    const rows = await srAdmin.from('native_bridge_codes').select('user_id').eq('code_hash', hash);
    expect(rows.data).toEqual([{ user_id: userA.userId }]);

    await srAdmin.from('native_bridge_codes').delete().eq('code_hash', hash);
  });

  it('S-4: authenticated は発行 / 消費 RPC を呼べない (42501)。他人のコードを消費できない', async () => {
    const client = authedClient(userA.jwt);
    const victimHash = newCodeHash();
    const seeded = await issue(userB.userId, victimHash);
    expect(seeded.error).toBeNull();

    const consumed = await client.rpc('consume_native_bridge_code', { p_code_hash: victimHash });
    expect(consumed.error?.code).toBe('42501');
    // 被害者のコードは消費されていない
    expect(await rowsByHash(victimHash)).toHaveLength(1);

    const issued = await client.rpc('issue_native_bridge_code', {
      p_code_hash: newCodeHash(),
      p_user_id: userB.userId,
      p_access_token: 'forged-at',
      p_refresh_token: 'forged-rt',
    });
    expect(issued.error?.code).toBe('42501');

    await srAdmin.from('native_bridge_codes').delete().eq('code_hash', victimHash);
  });
});

// ================================================================
// service_role: 正規の経路
// ================================================================
describe('#1036 native_bridge_codes: service_role の発行と消費', () => {
  it('S-5: 発行するとハッシュだけが保存され、消費すると 1 行返って行が消える。2 回目は 0 行', async () => {
    const hash = newCodeHash();
    const issued = await issue(userA.userId, hash);
    expect(issued.error).toBeNull();
    // 戻り値は期限 (timestamptz)。既定 60 秒なので、およそ 60 秒後
    const expiresAt = new Date(issued.data as string).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now() + 30_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 65_000);

    // 保存された行はハッシュだけを持つ (コード本体の列は無い)
    const stored = await srAdmin.from('native_bridge_codes').select('*').eq('code_hash', hash).single();
    expect(stored.error).toBeNull();
    expect(Object.keys(stored.data ?? {}).sort()).toEqual(
      ['access_token', 'code_hash', 'created_at', 'expires_at', 'refresh_token', 'user_id'].sort(),
    );

    const first = await consume(hash);
    expect(first.error).toBeNull();
    expect(first.data).toEqual([
      { user_id: userA.userId, access_token: `at-${hash.slice(0, 8)}`, refresh_token: `rt-${hash.slice(0, 8)}` },
    ]);
    expect(await rowsByHash(hash)).toEqual([]);

    const second = await consume(hash);
    expect(second.error).toBeNull();
    expect(second.data).toEqual([]);
  });

  it('S-6: 存在しないコードの消費は 0 行 (エラーにならない)', async () => {
    const res = await consume(newCodeHash());
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });

  it('S-7: 同じコードを同時に消費しても、行を受け取れるのは 1 つだけ (原子的な 1 回限り)', async () => {
    const hash = newCodeHash();
    expect((await issue(userA.userId, hash)).error).toBeNull();

    const results = await Promise.all(Array.from({ length: 8 }, () => consume(hash)));
    for (const r of results) expect(r.error).toBeNull();

    const winners = results.filter((r) => Array.isArray(r.data) && r.data.length === 1);
    const losers = results.filter((r) => Array.isArray(r.data) && r.data.length === 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(results.length - 1);
    expect(await rowsByHash(hash)).toEqual([]);
  });

  it('S-8: 期限切れのコードは行を返さず、行も残さない (トークンを DB に残さない)', async () => {
    const hash = newCodeHash();
    const now = Date.now();
    const inserted = await srAdmin.from('native_bridge_codes').insert({
      code_hash: hash,
      user_id: userA.userId,
      access_token: 'expired-at',
      refresh_token: 'expired-rt',
      // 表の CHECK (expires_at > created_at) を満たしたまま、すでに期限が切れている行
      created_at: new Date(now - 120_000).toISOString(),
      expires_at: new Date(now - 60_000).toISOString(),
    });
    expect(inserted.error).toBeNull();

    const res = await consume(hash);
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
    expect(await rowsByHash(hash)).toEqual([]);
  });

  it('S-9: 1 ユーザーの未消費コードは 20 件まで。古いものから捨てられる', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 25; i++) {
      const hash = newCodeHash();
      hashes.push(hash);
      const res = await issue(userA.userId, hash);
      expect(res.error).toBeNull();
    }

    const rows = await rowsByUser(userA.userId);
    expect(rows).toHaveLength(20);

    const kept = new Set(rows.map((r) => r.code_hash));
    // 新しい 20 件 (6 件目〜25 件目) が残り、古い 5 件は消えている
    for (const hash of hashes.slice(5)) expect(kept.has(hash)).toBe(true);
    for (const hash of hashes.slice(0, 5)) expect(kept.has(hash)).toBe(false);

    // 別ユーザーの行には影響しない
    const bHash = newCodeHash();
    expect((await issue(userB.userId, bHash)).error).toBeNull();
    expect(await rowsByUser(userA.userId)).toHaveLength(20);
    expect(await rowsByHash(bHash)).toHaveLength(1);

    await srAdmin.from('native_bridge_codes').delete().eq('user_id', userA.userId);
    await srAdmin.from('native_bridge_codes').delete().eq('user_id', userB.userId);
  });

  it('S-10: 発行のたびに、ほかのユーザーの期限切れ行も掃除される', async () => {
    const staleHash = newCodeHash();
    const now = Date.now();
    const inserted = await srAdmin.from('native_bridge_codes').insert({
      code_hash: staleHash,
      user_id: userB.userId,
      access_token: 'stale-at',
      refresh_token: 'stale-rt',
      created_at: new Date(now - 180_000).toISOString(),
      expires_at: new Date(now - 120_000).toISOString(),
    });
    expect(inserted.error).toBeNull();
    expect(await rowsByHash(staleHash)).toHaveLength(1);

    const freshHash = newCodeHash();
    expect((await issue(userA.userId, freshHash)).error).toBeNull();

    expect(await rowsByHash(staleHash)).toEqual([]);
    // 期限内の行は消さない
    expect(await rowsByHash(freshHash)).toHaveLength(1);

    await srAdmin.from('native_bridge_codes').delete().eq('code_hash', freshHash);
  });
});

// ================================================================
// 入力の検証
// ================================================================
describe('#1036 native_bridge_codes: 壊れた値は拒否される', () => {
  it.each([
    ['0 秒', 0],
    ['121 秒', 121],
    ['負数', -5],
    ['NULL', null],
  ])('S-11: ttl が範囲外 (%s) は 22023 で、行は作られない', async (_label, ttl) => {
    const hash = newCodeHash();
    const res = await issue(userA.userId, hash, ttl as number | null);
    expect(res.error?.code).toBe('22023');
    expect(await rowsByHash(hash)).toEqual([]);
  });

  it('S-12: ttl の上限 (120 秒) と下限 (1 秒) は受け付ける', async () => {
    const hashMax = newCodeHash();
    const hashMin = newCodeHash();
    expect((await issue(userA.userId, hashMax, 120)).error).toBeNull();
    expect((await issue(userA.userId, hashMin, 1)).error).toBeNull();
    await srAdmin.from('native_bridge_codes').delete().in('code_hash', [hashMax, hashMin]);
  });

  it('S-13: 表の CHECK: code_hash の形式違反と ttl の逸脱は 23514', async () => {
    const now = Date.now();
    const base = { user_id: userA.userId, access_token: 'at', refresh_token: 'rt' };

    // 平文のコードや大文字・短い値を code_hash に入れられない
    for (const bad of ['plain-code', 'ABCDEF'.repeat(11).slice(0, 64), 'a'.repeat(63), 'a'.repeat(65)]) {
      const res = await srAdmin.from('native_bridge_codes').insert({ ...base, code_hash: bad });
      expect(res.error?.code).toBe('23514');
    }

    // expires_at <= created_at
    const reversed = await srAdmin.from('native_bridge_codes').insert({
      ...base,
      code_hash: newCodeHash(),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now - 1000).toISOString(),
    });
    expect(reversed.error?.code).toBe('23514');

    // 有効期間が 5 分を超える
    const tooLong = await srAdmin.from('native_bridge_codes').insert({
      ...base,
      code_hash: newCodeHash(),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 6 * 60_000).toISOString(),
    });
    expect(tooLong.error?.code).toBe('23514');
  });

  it('S-14: 存在しない user_id は外部キー違反 (23503)', async () => {
    const res = await issue('00000000-0000-4000-8000-000000001036', newCodeHash());
    expect(res.error?.code).toBe('23503');
  });
});

// ================================================================
// ユーザー削除
// ================================================================
describe('#1036 native_bridge_codes: ユーザー削除でコードも消える', () => {
  it('S-15: auth.users を削除すると、そのユーザーのコードも消える (ON DELETE CASCADE)', async () => {
    const throwaway = await createTestUser('throwaway');
    const hash = newCodeHash();
    expect((await issue(throwaway.userId, hash)).error).toBeNull();
    expect(await rowsByHash(hash)).toHaveLength(1);

    const del = await srAdmin.auth.admin.deleteUser(throwaway.userId);
    expect(del.error).toBeNull();
    expect(await rowsByHash(hash)).toEqual([]);
  });
});
