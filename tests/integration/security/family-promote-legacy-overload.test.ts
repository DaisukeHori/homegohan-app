/**
 * #1232 (部分修正) 旧オーバーロード promote_child_to_user(p_member_id uuid, p_user_id uuid) の削除の回帰テスト
 *
 * 本番には旧版が SECURITY DEFINER のまま残り (docs/operations/rls-drift-20261006.md の P-1)、
 * 生の user_id を渡すだけで本人の同意なしに任意の既存ユーザーを家族へ編入でき、anon にも実行権限があった。
 * アプリが使うのは (p_member_id, p_email) 版だけのため、旧版は削除する。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/family-promote-legacy-overload.test.ts
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

const TS = Date.now();
const createdUserIds: string[] = [];

async function createUser(label: string): Promise<{ id: string; jwt: string }> {
  const email = `sec-promote-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-sec';
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `sec-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  const signIn = await anon().auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

let attacker: { id: string; jwt: string };
let victim: { id: string; jwt: string };
let familyId = '';
let childMemberId = '';

beforeAll(async () => {
  attacker = await createUser('attacker');
  victim = await createUser('victim');

  // 攻撃者は無料で家族を作り、子供のプレースホルダーを追加できる (#1232 手順 1〜2)
  const { data: group, error: groupError } = await asUser(attacker.jwt).rpc('create_family_group', {
    p_name: `#1232 attacker family ${TS}`,
    p_plan_key: 'free',
  });
  if (groupError || !group) throw new Error(`create_family_group: ${groupError?.message}`);
  familyId = (group as { id: string }).id;

  const { data: child, error: childError } = await asUser(attacker.jwt).rpc('add_family_child', {
    p_family_id: familyId,
    p_display_name: 'placeholder child',
    p_child_profile: {},
  });
  if (childError || !child) throw new Error(`add_family_child: ${childError?.message}`);
  childMemberId = (child as { id: string }).id;
}, 60_000);

afterAll(async () => {
  if (familyId) await srAdmin.from('family_groups').delete().eq('id', familyId);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 30_000);

describe('#1232 旧オーバーロード promote_child_to_user(uuid, uuid)', () => {
  it('攻撃者は被害者の user_id を渡しても家族へ強制編入できない (旧版が存在しない)', async () => {
    const { error } = await asUser(attacker.jwt).rpc('promote_child_to_user', {
      p_member_id: childMemberId,
      p_user_id: victim.id,
    });
    expect(error).not.toBeNull();
    // 旧版が存在しないため PostgREST が関数を解決できない
    expect(error!.code).toBe('PGRST202');

    const { data: victimProfile } = await srAdmin.from('user_profiles').select('family_id').eq('id', victim.id).single();
    expect(victimProfile?.family_id ?? null).toBeNull();
    const { data: child } = await srAdmin.from('family_members').select('user_id, role').eq('id', childMemberId).single();
    expect(child?.user_id ?? null).toBeNull();
    expect(child?.role).toBe('child');
  });

  it('anon も旧版を実行できない', async () => {
    const { error } = await anon().rpc('promote_child_to_user', {
      p_member_id: childMemberId,
      p_user_id: victim.id,
    });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('PGRST202');
  });

  it('アプリが使う (p_member_id, p_email) 版は残っている', async () => {
    const { error } = await asUser(attacker.jwt).rpc('promote_child_to_user', {
      p_member_id: childMemberId,
      p_email: `no-such-user-${TS}@homegohan.test`,
    });
    // 関数本体まで到達し、存在しないメールとして拒否される (= 関数は解決できている)
    expect(error).not.toBeNull();
    expect(error!.message).toContain('USER_NOT_FOUND');
  });
});
