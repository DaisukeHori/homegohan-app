/**
 * #1178 個人情報の請求の表 public.data_subject_requests の権限と制約の回帰テスト (実 DB)
 *   (supabase/migrations/20261016220000_data_subject_requests.sql。設計 docs/design/cross/15-data-subject-requests.md §4・§15)
 *
 * 期待する挙動:
 *   - 本人は自分の行だけ SELECT できる。admin (運営ロール) は全行、user ロールは他人の行が見えない。anon は読めない (42501)
 *   - 本人の client でも admin の client でも、DSR_OWN_COLUMNS (15 列) の select は通り、
 *     select=admin_notes・select=verification_token_hash・select=* は 42501 (列の GRANT。内部メモと hash は authenticated から読めない)
 *   - authenticated の INSERT・UPDATE・DELETE は 42501 (書き込みはサーバーの service_role だけ)
 *   - service_role は INSERT・UPDATE でき、DELETE は 42501 (行は消さない)
 *   - 同じ人・同じ種類の開いている請求は 1 つだけ (23505)。withdrawn にすれば同じ種類をもう一度出せる
 *   - verified_consistency・resolved_consistency・長さの CHECK が効く (23514)
 *   - updated_at がトリガーで進む
 *   - 利用者を消すと user_id が NULL になり、行は残る (ON DELETE SET NULL)
 *
 * 後片付け: service_role にも DELETE が無いので行は消さない。ユーザーの削除で user_id = NULL になって残る (退会と同じ。
 * 部分一意索引は user_id が NULL の行を数えない)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/data-subject-requests.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { DSR_ADMIN_LIST_COLUMNS, DSR_OWN_COLUMNS } from '@/lib/data-subject-requests/core';

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

const TABLE = 'data_subject_requests';
/** PostgreSQL の権限エラー (列・表の権限が無い / RLS の WITH CHECK が無い) */
const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

interface TestUser {
  userId: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls-1178';

async function createTestUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `rls-1178-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const userId = data.user.id;
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${email}: ${signIn.error?.message}`);
  }
  const jwt = signIn.data.session.access_token;
  // 運営ロールの判定 (select_operator) は user_profiles.roles を見る。プロフィールは本人の JWT で作り、roles は service_role で付ける
  const { error: profileError } = await client(anonKey, jwt).from('user_profiles').insert({
    id: userId,
    nickname: `rls-1178-${label}`,
    age_group: '30s',
    gender: 'other',
  });
  if (profileError) throw new Error(`Failed to insert profile for ${email}: ${profileError.message}`);
  const { error: rolesError } = await srAdmin.from('user_profiles').update({ roles }).eq('id', userId);
  if (rolesError) throw new Error(`Failed to set roles for ${email}: ${rolesError.message}`);
  return { userId, jwt };
}

/** service_role で 1 行足す (status は既定の pending_verification) */
async function insertRequest(userId: string | null, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { data, error } = await srAdmin
    .from(TABLE)
    .insert({ user_id: userId, request_type: 'disclosure', details: `rls-1178-${TS}`, ...overrides })
    .select('*')
    .single();
  if (error || !data) throw new Error(`insert ${TABLE}: ${error?.message}`);
  return data;
}

let owner: TestUser;
let other: TestUser;
let operator: TestUser;
let ownerRow: Record<string, unknown>;
let otherRow: Record<string, unknown>;

beforeAll(async () => {
  owner = await createTestUser('owner', ['user']);
  other = await createTestUser('other', ['user']);
  operator = await createTestUser('operator', ['user', 'admin']);
  ownerRow = await insertRequest(owner.userId, {
    verification_token_hash: `hash-owner-${TS}`,
    admin_notes: `admin-note-owner-${TS}`,
  });
  otherRow = await insertRequest(other.userId, { request_type: 'erasure' });
}, 60_000);

afterAll(async () => {
  for (const u of [owner, other, operator]) {
    if (!u?.userId) continue;
    await srAdmin.from('user_profiles').delete().eq('id', u.userId);
    await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

describe('#1178 data_subject_requests: 読み取り (RLS と列の GRANT)', () => {
  it('本人は自分の行だけを読める。user ロールの他人には見えない', async () => {
    const own = await client(anonKey, owner.jwt).from(TABLE).select(DSR_OWN_COLUMNS);
    expect(own.error).toBeNull();
    expect((own.data ?? []).map((r) => r.id)).toEqual([ownerRow.id]);

    const peek = await client(anonKey, other.jwt).from(TABLE).select('id').eq('id', ownerRow.id as string);
    expect(peek.error).toBeNull();
    expect(peek.data ?? []).toEqual([]);
  });

  it('admin (運営ロール) は全行を読める (本人の画面の読み取りは user_id で絞らないと他人の行が並ぶ)', async () => {
    const all = await client(anonKey, operator.jwt)
      .from(TABLE)
      .select(DSR_ADMIN_LIST_COLUMNS)
      .in('id', [ownerRow.id as string, otherRow.id as string]);
    expect(all.error).toBeNull();
    expect((all.data ?? []).map((r) => r.id).sort()).toEqual([ownerRow.id, otherRow.id].sort());

    const narrowed = await client(anonKey, operator.jwt).from(TABLE).select('id').eq('user_id', operator.userId);
    expect(narrowed.error).toBeNull();
    expect(narrowed.data ?? []).toEqual([]);
  });

  it('anon は読めない (42501)', async () => {
    const res = await anon().from(TABLE).select('id');
    expect(res.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it.each([
    ['本人', () => owner],
    ['admin', () => operator],
  ])('%s の client: DSR_OWN_COLUMNS は通り、admin_notes・verification_token_hash・* は 42501', async (_label, who) => {
    const c = client(anonKey, who().jwt);
    const ok = await c.from(TABLE).select(DSR_OWN_COLUMNS).eq('id', ownerRow.id as string);
    expect(ok.error).toBeNull();
    expect(ok.data ?? []).toHaveLength(1);

    for (const columns of ['admin_notes', 'verification_token_hash', '*', `${DSR_OWN_COLUMNS}, admin_notes`]) {
      const denied = await c.from(TABLE).select(columns).eq('id', ownerRow.id as string);
      expect(denied.error?.code, columns).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('service_role は内部メモと hash を含む全列を読める', async () => {
    const { data, error } = await srAdmin.from(TABLE).select('admin_notes, verification_token_hash').eq('id', ownerRow.id as string).single();
    expect(error).toBeNull();
    expect(data).toEqual({ admin_notes: `admin-note-owner-${TS}`, verification_token_hash: `hash-owner-${TS}` });
  });
});

describe('#1178 data_subject_requests: 書き込みはサーバー (service_role) だけ', () => {
  it('本人・admin の INSERT は 42501 (確認済みの行を自分で作れない)', async () => {
    for (const who of [owner, operator]) {
      const res = await client(anonKey, who.jwt).from(TABLE).insert({
        user_id: who.userId,
        request_type: 'correction',
        details: 'x',
        status: 'received',
        verified_at: new Date().toISOString(),
        due_at: new Date().toISOString(),
      });
      expect(res.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('本人・admin の UPDATE・DELETE は 42501 (行は変わらない)', async () => {
    for (const who of [owner, operator]) {
      const c = client(anonKey, who.jwt);
      const upd = await c.from(TABLE).update({ status: 'withdrawn' }).eq('id', ownerRow.id as string);
      expect(upd.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
      const del = await c.from(TABLE).delete().eq('id', ownerRow.id as string);
      expect(del.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const { data } = await srAdmin.from(TABLE).select('status').eq('id', ownerRow.id as string).single();
    expect(data?.status).toBe('pending_verification');
  });

  it('service_role は UPDATE でき、DELETE は 42501', async () => {
    const row = await insertRequest(owner.userId, { request_type: 'suspension' });
    const upd = await srAdmin.from(TABLE).update({ admin_notes: 'メモ' }).eq('id', row.id as string).select('admin_notes').single();
    expect(upd.error).toBeNull();
    expect(upd.data?.admin_notes).toBe('メモ');

    const del = await srAdmin.from(TABLE).delete().eq('id', row.id as string);
    expect(del.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
    const { data } = await srAdmin.from(TABLE).select('id').eq('id', row.id as string);
    expect(data ?? []).toHaveLength(1);
  });
});

describe('#1178 data_subject_requests: 制約とトリガー', () => {
  it('同じ人・同じ種類の開いている請求は 1 つだけ (23505)。withdrawn にすれば同じ種類をもう一度出せる', async () => {
    const first = await insertRequest(other.userId, { request_type: 'correction' });
    const dup = await srAdmin.from(TABLE).insert({ user_id: other.userId, request_type: 'correction', details: 'dup' });
    expect(dup.error?.code).toBe(UNIQUE_VIOLATION);

    const withdrawn = await srAdmin
      .from(TABLE)
      .update({ status: 'withdrawn', resolved_at: new Date().toISOString(), verification_token_hash: null })
      .eq('id', first.id as string);
    expect(withdrawn.error).toBeNull();
    const again = await srAdmin.from(TABLE).insert({ user_id: other.userId, request_type: 'correction', details: 'again' });
    expect(again.error).toBeNull();
  });

  it('verified_consistency: 受付済み以降は verified_at と due_at が要る・本人確認待ちに期限は入れられない', async () => {
    const noVerified = await srAdmin
      .from(TABLE)
      .insert({ user_id: owner.userId, request_type: 'erasure', details: 'x', status: 'received' });
    expect(noVerified.error?.code).toBe(CHECK_VIOLATION);

    const pendingWithDue = await srAdmin
      .from(TABLE)
      .insert({ user_id: owner.userId, request_type: 'erasure', details: 'x', due_at: new Date().toISOString() });
    expect(pendingWithDue.error?.code).toBe(CHECK_VIOLATION);
  });

  it('resolved_consistency: 終わった請求にだけ resolved_at が入る', async () => {
    const at = new Date().toISOString();
    const fulfilledWithout = await srAdmin.from(TABLE).insert({
      user_id: null,
      request_type: 'erasure',
      details: 'x',
      status: 'fulfilled',
      verified_at: at,
      due_at: at,
    });
    expect(fulfilledWithout.error?.code).toBe(CHECK_VIOLATION);

    const pendingWithResolved = await srAdmin
      .from(TABLE)
      .insert({ user_id: null, request_type: 'erasure', details: 'x', resolved_at: at });
    expect(pendingWithResolved.error?.code).toBe(CHECK_VIOLATION);
  });

  it('種類・状態・長さの CHECK (23514)', async () => {
    const base = { user_id: null, details: 'x' };
    expect((await srAdmin.from(TABLE).insert({ ...base, request_type: 'deletion' })).error?.code).toBe(CHECK_VIOLATION);
    expect((await srAdmin.from(TABLE).insert({ ...base, request_type: 'erasure', status: 'open' })).error?.code).toBe(
      CHECK_VIOLATION,
    );
    expect((await srAdmin.from(TABLE).insert({ ...base, request_type: 'erasure', details: '' })).error?.code).toBe(
      CHECK_VIOLATION,
    );
    expect(
      (await srAdmin.from(TABLE).insert({ ...base, request_type: 'erasure', details: 'あ'.repeat(2001) })).error?.code,
    ).toBe(CHECK_VIOLATION);
    expect(
      (await srAdmin.from(TABLE).insert({ ...base, request_type: 'erasure', response_note: 'あ'.repeat(5001) })).error?.code,
    ).toBe(CHECK_VIOLATION);
    expect(
      (await srAdmin.from(TABLE).insert({ ...base, request_type: 'erasure', verification_method: 'password' })).error?.code,
    ).toBe(CHECK_VIOLATION);
  });

  it('updated_at が UPDATE のたびにトリガーで進む', async () => {
    const row = await insertRequest(null, { request_type: 'correction' });
    // 同じ時刻にならないよう、少し待ってから更新する
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { data, error } = await srAdmin
      .from(TABLE)
      .update({ admin_notes: '更新' })
      .eq('id', row.id as string)
      .select('updated_at, created_at')
      .single();
    expect(error).toBeNull();
    expect(new Date(data?.updated_at as string).getTime()).toBeGreaterThan(new Date(row.updated_at as string).getTime());
    expect(data?.created_at).toBe(row.created_at);
  });

  it('利用者を消すと user_id が NULL になり、行は残る (ON DELETE SET NULL)', async () => {
    const leaver = await createTestUser('leaver', ['user']);
    const row = await insertRequest(leaver.userId, { request_type: 'erasure' });
    await srAdmin.from('user_profiles').delete().eq('id', leaver.userId);
    const { error } = await srAdmin.auth.admin.deleteUser(leaver.userId);
    expect(error).toBeNull();

    const { data } = await srAdmin.from(TABLE).select('id, user_id, details').eq('id', row.id as string).single();
    expect(data).toEqual({ id: row.id, user_id: null, details: row.details });
  });
});
