/**
 * #1234 shopping_list_requests (買い物リスト再生成ジョブ) の UPDATE ポリシーの回帰テスト
 *
 * 本番には "Service role can update shopping list requests" という UPDATE ポリシーがあり、
 * 名前に反して TO service_role が無く (roles = public)、USING (true)・WITH CHECK 無し (= USING と同じ true) だった。
 * permissive ポリシーは OR で合成されるため、所有者に限定する "Users can manage own shopping list requests"
 * (USING (auth.uid() = user_id)) と併存していても、UPDATE の条件は true に縮退する。
 *
 * 2026-10-07 にローカル (本番スキーマのベースライン) で確かめた実際の影響:
 *   - 他人の行の書き換え (issue の手順の PATCH ?id=eq.<他人の id>) は、PostgREST 経由では起きなかった (S-1〜S-4 は修正前も通る)。
 *     WHERE 句で列を読む UPDATE には SELECT ポリシーも適用され、他人の行は更新の対象にならないため。
 *     WHERE 句の無い一括 UPDATE は、PostgREST の接続 (authenticator ロール) に読み込まれる safeupdate が拒否する。
 *     S-1〜S-4 は、この性質が今後も崩れないことの確認として残す。
 *   - 自分の行の user_id を他人に書き換える (他人のアカウントにジョブ行を付け替える) ことはできた (S-5 が修正前に失敗する)。
 *     上のポリシーの WITH CHECK (true) が OR で効くため。
 *
 * 修正 (20261007094400_shopping_list_requests_owner_only_update.sql) はこのポリシーを削除する。
 * service role (Edge Function regenerate-shopping-list-v2) は RLS の対象外なので、進捗の更新は変わらない (S-8)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/shopping-list-requests-owner-update.test.ts
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
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-slr';
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `rls-slr-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: pErr } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `slr-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (pErr) throw new Error(`user_profiles ${label}: ${pErr.message}`);
  const { data: session, error: sErr } = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !session.session) throw new Error(`signIn ${label}: ${sErr?.message}`);
  return { id: data.user.id, email, jwt: session.session.access_token };
}

const INITIAL_PROGRESS = { phase: 'starting', message: '開始中...', percentage: 0 };

/** service role でユーザーのジョブ行を作る (Next.js の /api/shopping-list/regenerate が作るのと同じ形) */
async function createRequest(userId: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('shopping_list_requests')
    .insert({
      user_id: userId,
      status: 'processing',
      start_date: '2026-10-05',
      end_date: '2026-10-11',
      progress: INITIAL_PROGRESS,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`shopping_list_requests: ${error?.message}`);
  return data.id as string;
}

async function createShoppingList(userId: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('shopping_lists')
    .insert({ user_id: userId, start_date: '2026-10-05', end_date: '2026-10-11', status: 'active', title: 'rls-slr' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`shopping_lists: ${error?.message}`);
  return data.id as string;
}

async function readRequest(id: string) {
  const { data, error } = await srAdmin
    .from('shopping_list_requests')
    .select('id, user_id, status, progress, result, shopping_list_id')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`read ${id}: ${error?.message}`);
  return data;
}

let owner: TestUser;
let attacker: TestUser;
let attackerListId: string;

beforeAll(async () => {
  owner = await createUser('owner');
  attacker = await createUser('attacker');
  attackerListId = await createShoppingList(attacker.id);
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin.from('shopping_list_requests').delete().eq('user_id', id);
    await srAdmin.from('shopping_lists').delete().eq('user_id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
});

describe('shopping_list_requests: 他人のジョブ行は更新できない (#1234)', () => {
  it('S-1: 他のユーザーは、他人のジョブ行の status / progress / result を書き換えられない', async () => {
    const requestId = await createRequest(owner.id);
    const { data, error } = await asUser(attacker.jwt)
      .from('shopping_list_requests')
      .update({
        status: 'failed',
        progress: { phase: 'failed', message: '改ざん', percentage: 0 },
        result: { error: 'tampered' },
      })
      .eq('id', requestId)
      .select('id');
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const row = await readRequest(requestId);
    expect(row.status).toBe('processing');
    expect(row.progress).toEqual(INITIAL_PROGRESS);
    expect(row.result).toBeNull();
  });

  it('S-2: 他のユーザーは、他人のジョブ行の shopping_list_id を自分の買い物リストに付け替えられない', async () => {
    const requestId = await createRequest(owner.id);
    const { data } = await asUser(attacker.jwt)
      .from('shopping_list_requests')
      .update({ status: 'completed', shopping_list_id: attackerListId })
      .eq('id', requestId)
      .select('id');
    expect(data).toEqual([]);

    const row = await readRequest(requestId);
    expect(row.status).toBe('processing');
    expect(row.shopping_list_id).toBeNull();
  });

  it('S-3: 他のユーザーは、他人のジョブ行の user_id を自分に書き換えて乗っ取れない', async () => {
    const requestId = await createRequest(owner.id);
    const { data } = await asUser(attacker.jwt)
      .from('shopping_list_requests')
      .update({ user_id: attacker.id })
      .eq('id', requestId)
      .select('id');
    expect(data ?? []).toEqual([]);

    const row = await readRequest(requestId);
    expect(row.user_id).toBe(owner.id);
  });

  it('S-4: 未ログイン (anon キーだけ) では、ジョブ行を書き換えられない', async () => {
    const requestId = await createRequest(owner.id);
    const { data } = await anon()
      .from('shopping_list_requests')
      .update({ status: 'failed', result: { error: 'tampered-by-anon' } })
      .eq('id', requestId)
      .select('id');
    expect(data ?? []).toEqual([]);

    const row = await readRequest(requestId);
    expect(row.status).toBe('processing');
    expect(row.result).toBeNull();
  });

  it('S-5: 本人は自分のジョブ行を、ほかのユーザーのアカウントに付け替えられない', async () => {
    const requestId = await createRequest(owner.id);
    // .select() (RETURNING) を付けると、更新後の行が SELECT ポリシーで見えないことでエラーになり、
    // UPDATE の WITH CHECK を検証できない。そのため付けない。
    const { error } = await asUser(owner.jwt)
      .from('shopping_list_requests')
      .update({ user_id: attacker.id })
      .eq('id', requestId);
    // 修正前は "Service role can update …" の WITH CHECK (true) が OR で効き、付け替えが通っていた。
    // 修正後は "Users can manage own shopping list requests" の USING (auth.uid() = user_id) が WITH CHECK を兼ね、RLS 違反になる
    expect(error?.code).toBe('42501');

    const row = await readRequest(requestId);
    expect(row.user_id).toBe(owner.id);
  });
});

describe('shopping_list_requests: 本人と service role の操作は今までどおり (#1234)', () => {
  it('S-6: 本人は自分のジョブ行を更新できる', async () => {
    const requestId = await createRequest(owner.id);
    const { data, error } = await asUser(owner.jwt)
      .from('shopping_list_requests')
      .update({ status: 'failed', result: { error: 'cancelled-by-owner' } })
      .eq('id', requestId)
      .select('id, status');
    expect(error).toBeNull();
    expect(data).toEqual([{ id: requestId, status: 'failed' }]);
  });

  it('S-7: 本人は自分のジョブ行を作成・参照でき、他人のジョブ行は参照できない', async () => {
    const { data: created, error: insErr } = await asUser(owner.jwt)
      .from('shopping_list_requests')
      .insert({ user_id: owner.id, status: 'processing', start_date: '2026-10-05', end_date: '2026-10-11' })
      .select('id')
      .single();
    expect(insErr).toBeNull();
    expect(created?.id).toBeTruthy();

    const { data: own } = await asUser(owner.jwt).from('shopping_list_requests').select('id').eq('id', created!.id);
    expect(own).toEqual([{ id: created!.id }]);

    const { data: others } = await asUser(attacker.jwt).from('shopping_list_requests').select('id').eq('id', created!.id);
    expect(others).toEqual([]);
  });

  it('S-8: service role (Edge Function) は進捗と完了を書き込める', async () => {
    const requestId = await createRequest(owner.id);
    const ownerListId = await createShoppingList(owner.id);
    const { error: pErr } = await srAdmin
      .from('shopping_list_requests')
      .update({ progress: { phase: 'normalizing', message: 'AIが材料を整理中...', percentage: 30 } })
      .eq('id', requestId)
      .eq('user_id', owner.id);
    expect(pErr).toBeNull();
    const { data, error } = await srAdmin
      .from('shopping_list_requests')
      .update({
        status: 'completed',
        shopping_list_id: ownerListId,
        progress: { phase: 'completed', message: '完了！', percentage: 100 },
      })
      .eq('id', requestId)
      .eq('user_id', owner.id)
      .select('id, status, shopping_list_id');
    expect(error).toBeNull();
    expect(data).toEqual([{ id: requestId, status: 'completed', shopping_list_id: ownerListId }]);
  });
});
