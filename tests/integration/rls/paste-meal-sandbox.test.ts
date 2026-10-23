/**
 * #1627 家族への貼り付け (paste_meal_to_family) は、ハンズオンのお試しの記録 (meals.is_sandbox = true) を元にできない
 *
 * 背景: paste_meal_to_family は元の行の eaten_at / meal_type / photo_url / memo だけを写して家族のメンバーの行を作り、
 * is_sandbox は写さない (新しい行は列の既定値の is_sandbox = false)。お試しの記録 (#1604 から add-from-photo が作る) を貼ると、
 * 家族の側では本物の記録になってしまう。migration 20261015100000_paste_meal_reject_sandbox.sql で、元の行が
 * is_sandbox = true なら RAISE EXCEPTION 'MEAL_SANDBOX' で断るようにした。
 *
 * 期待する挙動:
 *   - S1: 持ち主が自分のお試しの記録を家族に貼ると MEAL_SANDBOX で断られる。家族の側に行はできず、
 *         元の行の paste_group_id も書かれず、監査の行 (paste_executed) も残らない
 *   - S2: 持ち主でない人がお試しの記録を指定しても NOT_MEAL_OWNER のまま (お試しかどうかを教えない)
 *   - S3: お試しでない普通の行は、これまでどおり貼れる (家族の側の行は is_sandbox = false)
 *   - S4: 隠されたお試しの記録は MEAL_HIDDEN (確認の順番は 持ち主 → 隠した食事 → お試し)
 *   - S5: 関数の属性 (SECURITY DEFINER・search_path・EXECUTE の権限) は元のまま
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/paste-meal-sandbox.test.ts
 *
 * 修正前 (migration を流す前) は S1 が赤になる (お試しの記録が貼れて、家族の側に is_sandbox = false の行ができる)。
 * 作った行は afterAll で消す。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import { setFamilyGroupPlan } from '../helpers/family-plan';

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

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdMealIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `paste-sandbox-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname: `paste-sandbox-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

let owner: TestUser; // 食事の持ち主 (家族の代表者)
let famMember: TestUser; // 同じ家族のメンバー (貼り付けの先)
let familyId = '';

/** 行を作る (service_role)。お試しの記録は利用者ごとに 1 行まで (uniq_user_sandbox_meal) */
async function insertMeal(userId: string, memo: string, isSandbox: boolean): Promise<string> {
  const { data, error } = await srAdmin
    .from('meals')
    .insert({ user_id: userId, eaten_at: new Date().toISOString(), meal_type: 'dinner', memo, is_sandbox: isSandbox })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert meal: ${error?.message}`);
  createdMealIds.push(data.id as string);
  return data.id as string;
}

/** 本人の権限で貼り付ける (POST /api/meals/paste と同じ RPC) */
async function pasteAs(user: TestUser, sourceMealId: string, targets: string[]) {
  return asUser(user.jwt).rpc('paste_meal_to_family', {
    p_source_meal_id: sourceMealId,
    p_target_user_ids: targets,
  });
}

/** その利用者の、そのメモの行 (service_role で読む) */
async function rowsOf(userId: string, memo: string): Promise<Array<{ id: string; is_sandbox: boolean; paste_group_id: string | null }>> {
  const { data, error } = await srAdmin
    .from('meals')
    .select('id, is_sandbox, paste_group_id')
    .eq('user_id', userId)
    .eq('memo', memo);
  if (error) throw new Error(`rows: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; is_sandbox: boolean; paste_group_id: string | null }>;
  for (const row of rows) createdMealIds.push(row.id);
  return rows;
}

/** 元の行を指す、貼り付けの監査の行の数 */
async function pasteAuditCount(sourceMealId: string): Promise<number> {
  const { data, error } = await srAdmin
    .from('membership_audit')
    .select('id')
    .eq('scope_id', familyId)
    .eq('action', 'paste_executed')
    .eq('metadata->>source_meal_id', sourceMealId);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return (data ?? []).length;
}

const LONG = 120_000;

beforeAll(async () => {
  [owner, famMember] = await Promise.all([createUser('owner'), createUser('fam-member')]);

  // 家族: 持ち主が代表者、もう 1 人は大人。どちらも active (招待の流れは別のテストが確かめる)
  const { data: family, error: familyError } = await srAdmin
    .from('family_groups')
    .insert({ name: `#1627 paste-sandbox family ${TS}`, representative_id: owner.id })
    .select('id')
    .single();
  if (familyError || !family) throw new Error(`family_groups: ${familyError?.message}`);
  familyId = family.id as string;
  // billing/03 §6.6: free のグループにはメンバーを足せないので、メンバーを足す前に家族プランにする
  await setFamilyGroupPlan(srAdmin, [familyId]);
  const { error: memberError } = await srAdmin.from('family_members').insert([
    { family_id: familyId, user_id: owner.id, role: 'representative', status: 'active', share_meals: true },
    { family_id: familyId, user_id: famMember.id, role: 'adult', status: 'active', share_meals: true },
  ]);
  if (memberError) throw new Error(`family_members: ${memberError.message}`);
  // paste_meal_to_family は呼んだ人の user_profiles.family_id を見る
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .update({ family_id: familyId })
    .in('id', [owner.id, famMember.id]);
  if (profileError) throw new Error(`user_profiles.family_id: ${profileError.message}`);
}, LONG);

afterAll(async () => {
  if (createdMealIds.length > 0) await srAdmin.from('meals').delete().in('id', createdMealIds);
  if (createdUserIds.length > 0) {
    await srAdmin.from('meals').delete().in('user_id', createdUserIds);
    await srAdmin.from('user_profiles').update({ family_id: null }).in('id', createdUserIds);
  }
  if (familyId) {
    // family_members は CASCADE。family_groups.representative_id は ON DELETE RESTRICT なので家族を先に消す
    await srAdmin.from('membership_audit').delete().eq('scope_id', familyId);
    await srAdmin.from('family_groups').delete().eq('id', familyId);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  }
}, LONG);

describe('#1627 paste_meal_to_family とお試しの記録 (is_sandbox)', () => {
  it('S1: 持ち主が自分のお試しの記録を家族に貼ると MEAL_SANDBOX で断られ、家族の側に行ができない。元の行も監査も書かれない', async () => {
    const memo = `#1627 S1 sandbox ${TS}`;
    const mealId = await insertMeal(owner.id, memo, true);

    const { data, error } = await pasteAs(owner, mealId, [famMember.id]);

    expect(data).toBeNull();
    expect(error?.message).toContain('MEAL_SANDBOX');
    expect(error?.code).toBe('P0001');
    // 家族の側に行ができていない (is_sandbox = false の本物の記録も、お試しの記録も)
    expect(await rowsOf(famMember.id, memo)).toEqual([]);
    // 元の行はそのまま (paste_group_id を書いていない・お試しのまま)
    expect(await rowsOf(owner.id, memo)).toEqual([{ id: mealId, is_sandbox: true, paste_group_id: null }]);
    expect(await pasteAuditCount(mealId)).toBe(0);
  });

  it('S2: 持ち主でない人がお試しの記録を指定しても NOT_MEAL_OWNER のまま (お試しかどうかを教えない)', async () => {
    const { data: sandboxRows, error: readError } = await srAdmin
      .from('meals')
      .select('id')
      .eq('user_id', owner.id)
      .eq('is_sandbox', true);
    expect(readError).toBeNull();
    const [sandbox] = (sandboxRows ?? []) as Array<{ id: string }>;
    expect(sandbox, 'S1 で作ったお試しの記録').toBeDefined();

    const { error } = await pasteAs(famMember, sandbox.id, [owner.id]);

    expect(error?.message).toContain('NOT_MEAL_OWNER');
    expect(error?.message).not.toContain('MEAL_SANDBOX');
  });

  it('S3: お試しでない普通の行は、これまでどおり貼れる (家族の側の行は is_sandbox = false で、同じ paste_group_id)', async () => {
    const memo = `#1627 S3 real ${TS}`;
    const mealId = await insertMeal(owner.id, memo, false);

    const { data, error } = await pasteAs(owner, mealId, [famMember.id]);

    expect(error).toBeNull();
    expect(typeof data).toBe('string');
    const copies = await rowsOf(famMember.id, memo);
    expect(copies).toHaveLength(1);
    expect(copies[0].is_sandbox).toBe(false);
    expect(copies[0].paste_group_id).toBe(data);
    expect(await pasteAuditCount(mealId)).toBe(1);
  });

  it('S4: 隠されたお試しの記録は MEAL_HIDDEN (隠した食事の確認が先)。家族の側に行はできない', async () => {
    const memo = `#1627 S4 hidden sandbox ${TS}`;
    // お試しの記録は利用者ごとに 1 行までなので、家族のメンバーの側に作る
    const mealId = await insertMeal(famMember.id, memo, true);
    const { error: hideError } = await srAdmin
      .from('meals')
      .update({ hidden_at: new Date().toISOString(), hidden_reason: 'moderation:delete_only' })
      .eq('id', mealId);
    expect(hideError).toBeNull();

    const { error } = await pasteAs(famMember, mealId, [owner.id]);

    expect(error?.message).toContain('MEAL_HIDDEN');
    expect(error?.message).not.toContain('MEAL_SANDBOX');
    expect(await rowsOf(owner.id, memo)).toEqual([]);
  });

  it('S5: 関数の属性 (SECURITY DEFINER・search_path・EXECUTE の権限) は元のまま', async () => {
    const [fn] = await pgQuery<{ prosecdef: boolean; proconfig: string[] | null; anon: boolean; authenticated: boolean; service_role: boolean; public_exec: boolean }>(`
      SELECT p.prosecdef,
             p.proconfig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
             EXISTS (
               SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_exec
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'paste_meal_to_family'
    `);
    expect(fn).toBeDefined();
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(['search_path=public']);
    expect(fn.authenticated).toBe(true);
    expect(fn.service_role).toBe(true);
    expect(fn.anon).toBe(false);
    expect(fn.public_exec).toBe(false);
  });
});
