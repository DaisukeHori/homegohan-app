/**
 * #1634 家族への貼り付け (paste_meal_to_family と POST /api/meals/paste) の断り方
 *
 * 背景:
 *   1. route は DB の例外の文を includes('NOT_IN_FAMILY') → includes('TARGET_NOT_IN_FAMILY') の順に見ていたので、
 *      DB の 'TARGET_NOT_IN_FAMILY' (貼り付けの先が同じ家族にいない) が 403 NOT_IN_FAMILY に化けていた。
 *      いまは例外の文の語を完全一致で引き、400 USER_NOT_IN_FAMILY を返す。
 *   2. paste_meal_to_family に存在しない source_meal_id を渡すと、v_source.user_id が NULL になり「NULL <> auth.uid()」が真にならず、
 *      持ち主の確認をすり抜けていた (家族の側の行は 0 件なのに監査の行が書かれ、新しい paste_group_id が返る = API は 200)。
 *      migration 20261015110000_paste_meal_reject_missing_source.sql で、元の行が無いときも NOT_MEAL_OWNER で断るようにした
 *      (他人の行のときと同じ語にして、持ち主でない人に「その id の行が在るか」を教えない)。
 *
 * 期待する挙動:
 *   - E1: 貼り付けの先が家族にいない → DB は TARGET_NOT_IN_FAMILY、API は 400 USER_NOT_IN_FAMILY。何も書かない
 *   - E2: 呼んだ人が家族にいない → DB は NOT_IN_FAMILY、API は 403 NOT_IN_FAMILY。何も書かない
 *   - E3: 存在しない source_meal_id → DB は NOT_MEAL_OWNER、API は 403 INSUFFICIENT_PERMISSION。監査の行も家族の側の行もできない
 *   - E4: 他人の (存在する) 行 → E3 と同じ NOT_MEAL_OWNER / 403 INSUFFICIENT_PERMISSION (在るかどうかを教えない)
 *   - E5: 自分の行を家族に貼る → これまでどおり 200 で家族の側に行ができる
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next (INTEGRATION_BASE_URL。scripts/local-ci.sh の integration の段が立てる)。
 *   修正前は E1 の API (403 NOT_IN_FAMILY が返る) と E3 (200 が返り、監査の行が書かれる) が赤になる。
 * 作った行は afterAll で消す。本番には接続しない。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';
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

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdMealIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `paste-errors-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname: `paste-errors-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

let owner: TestUser; // 家族の代表者 (食事の持ち主)
let famMember: TestUser; // 同じ家族のメンバー
let outsider: TestUser; // 家族に入っていない人
let familyId = '';

/** 行を作る (service_role) */
async function insertMeal(userId: string, memo: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('meals')
    .insert({ user_id: userId, eaten_at: new Date().toISOString(), meal_type: 'dinner', memo })
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert meal: ${error?.message}`);
  createdMealIds.push(data.id as string);
  return data.id as string;
}

/** 本人の権限で RPC を呼ぶ (POST /api/meals/paste が呼ぶのと同じ) */
async function pasteRpc(user: TestUser, sourceMealId: string, targets: string[]) {
  return asUser(user.jwt).rpc('paste_meal_to_family', {
    p_source_meal_id: sourceMealId,
    p_target_user_ids: targets,
  });
}

/** POST /api/meals/paste を本人の権限で呼ぶ */
async function pasteApi(user: TestUser, sourceMealId: string, targets: string[]) {
  return apiCall<{ error?: { code: string }; data?: { paste_group_id: string; inserted_count: number } }>(
    'POST',
    '/api/meals/paste',
    user.jwt,
    { source_meal_id: sourceMealId, target_user_ids: targets },
  );
}

/** その利用者の行の id (service_role で読む) */
async function mealIdsOf(userId: string): Promise<string[]> {
  const { data, error } = await srAdmin.from('meals').select('id').eq('user_id', userId);
  if (error) throw new Error(`meals: ${error.message}`);
  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  createdMealIds.push(...ids);
  return ids.sort();
}

/** 元の行を指す、貼り付けの監査の行の数 (家族を問わない) */
async function pasteAuditCount(sourceMealId: string): Promise<number> {
  const { data, error } = await srAdmin
    .from('membership_audit')
    .select('id')
    .eq('action', 'paste_executed')
    .eq('metadata->>source_meal_id', sourceMealId);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return (data ?? []).length;
}

/** 元の行の paste_group_id (書かれていないこと = 断ったときに何も書いていないことの確認) */
async function pasteGroupOf(mealId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('meals').select('paste_group_id').eq('id', mealId).single();
  if (error || !data) throw new Error(`meal ${mealId}: ${error?.message}`);
  return (data as { paste_group_id: string | null }).paste_group_id;
}

const LONG = 120_000;

beforeAll(async () => {
  [owner, famMember, outsider] = await Promise.all([createUser('owner'), createUser('fam-member'), createUser('outsider')]);

  // 家族: 持ち主が代表者、もう 1 人は大人。どちらも active。outsider はどの家族にも入れない
  const { data: family, error: familyError } = await srAdmin
    .from('family_groups')
    .insert({ name: `#1634 paste-errors family ${TS}`, representative_id: owner.id })
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
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
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

describe('#1634 家族への貼り付けの断り方 (paste_meal_to_family / POST /api/meals/paste)', () => {
  it('E1: 貼り付けの先が家族にいない → DB は TARGET_NOT_IN_FAMILY、API は 400 USER_NOT_IN_FAMILY。何も書かない', async () => {
    const mealId = await insertMeal(owner.id, `#1634 E1 ${TS}`);
    const outsiderBefore = await mealIdsOf(outsider.id);

    const rpc = await pasteRpc(owner, mealId, [outsider.id]);
    expect(rpc.data).toBeNull();
    expect(rpc.error?.message).toBe('TARGET_NOT_IN_FAMILY');
    expect(rpc.error?.code).toBe('P0001');

    const api = await pasteApi(owner, mealId, [outsider.id]);
    expect(api.status).toBe(400);
    expect(api.body.error?.code).toBe('USER_NOT_IN_FAMILY');
    expect(api.body).not.toHaveProperty('data');

    expect(await mealIdsOf(outsider.id)).toEqual(outsiderBefore);
    expect(await pasteGroupOf(mealId)).toBeNull();
    expect(await pasteAuditCount(mealId)).toBe(0);
  });

  it('E2: 呼んだ人が家族にいない → DB は NOT_IN_FAMILY、API は 403 NOT_IN_FAMILY。何も書かない', async () => {
    const mealId = await insertMeal(outsider.id, `#1634 E2 ${TS}`);
    const ownerBefore = await mealIdsOf(owner.id);

    const rpc = await pasteRpc(outsider, mealId, [owner.id]);
    expect(rpc.data).toBeNull();
    expect(rpc.error?.message).toBe('NOT_IN_FAMILY');

    const api = await pasteApi(outsider, mealId, [owner.id]);
    expect(api.status).toBe(403);
    expect(api.body.error?.code).toBe('NOT_IN_FAMILY');

    expect(await mealIdsOf(owner.id)).toEqual(ownerBefore);
    expect(await pasteGroupOf(mealId)).toBeNull();
    expect(await pasteAuditCount(mealId)).toBe(0);
  });

  it('E3: 存在しない source_meal_id → DB は NOT_MEAL_OWNER、API は 403 INSUFFICIENT_PERMISSION。監査の行も家族の側の行もできない', async () => {
    const missingId = randomUUID();
    const { data: exists, error: existsError } = await srAdmin.from('meals').select('id').eq('id', missingId);
    expect(existsError).toBeNull();
    expect(exists).toEqual([]);
    const famBefore = await mealIdsOf(famMember.id);

    const rpc = await pasteRpc(owner, missingId, [famMember.id]);
    expect(rpc.data).toBeNull();
    expect(rpc.error?.message).toBe('NOT_MEAL_OWNER');
    expect(rpc.error?.code).toBe('P0001');

    const api = await pasteApi(owner, missingId, [famMember.id]);
    expect(api.status).toBe(403);
    expect(api.body.error?.code).toBe('INSUFFICIENT_PERMISSION');
    expect(api.body).not.toHaveProperty('data');

    expect(await mealIdsOf(famMember.id)).toEqual(famBefore);
    expect(await pasteAuditCount(missingId)).toBe(0);
  });

  it('E4: 他人の (存在する) 行 → 存在しないときと同じ NOT_MEAL_OWNER / 403 INSUFFICIENT_PERMISSION', async () => {
    const othersMealId = await insertMeal(famMember.id, `#1634 E4 ${TS}`);

    const rpc = await pasteRpc(owner, othersMealId, [famMember.id]);
    expect(rpc.error?.message).toBe('NOT_MEAL_OWNER');

    const api = await pasteApi(owner, othersMealId, [famMember.id]);
    expect(api.status).toBe(403);
    expect(api.body.error?.code).toBe('INSUFFICIENT_PERMISSION');

    expect(await pasteGroupOf(othersMealId)).toBeNull();
    expect(await pasteAuditCount(othersMealId)).toBe(0);
  });

  it('E5: 自分の行を家族に貼る → これまでどおり 200 で、家族の側に同じ paste_group_id の行が 1 行でき、監査の行が 1 行', async () => {
    const memo = `#1634 E5 ${TS}`;
    const mealId = await insertMeal(owner.id, memo);

    const api = await pasteApi(owner, mealId, [famMember.id]);
    expect(api.status).toBe(200);
    expect(api.body.data?.inserted_count).toBe(1);
    const groupId = api.body.data?.paste_group_id;
    expect(typeof groupId).toBe('string');

    const { data: copies, error } = await srAdmin
      .from('meals')
      .select('id, paste_group_id')
      .eq('user_id', famMember.id)
      .eq('memo', memo);
    expect(error).toBeNull();
    const rows = (copies ?? []) as Array<{ id: string; paste_group_id: string | null }>;
    createdMealIds.push(...rows.map((row) => row.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].paste_group_id).toBe(groupId);
    expect(await pasteGroupOf(mealId)).toBe(groupId);
    expect(await pasteAuditCount(mealId)).toBe(1);
  });
});
