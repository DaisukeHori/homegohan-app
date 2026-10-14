/**
 * #1465 AI のキュー (weekly_menu_requests / meal_image_jobs) は、利用者 (authenticated) から書けない
 *
 * 2 つの表に積んだ行は、service role の処理 (Vercel Cron の process-menu-queue / Edge Function process-meal-image-jobs) が
 * AI へ送る。利用者が直接積めると、AI の利用回数の記録 (#1177) と上限 (T40 #1149) をすり抜けられる。
 * 20261011010000_ai_queue_service_role_writes.sql が、書き込みのポリシーを消し、anon / authenticated の
 * INSERT / UPDATE / DELETE / TRUNCATE の権限を外した。
 *
 * 確認すること:
 *   Q-1〜Q-3 (表ごと): authenticated は自分の行でも INSERT / UPDATE / DELETE できない (42501。行は変わらない)
 *   Q-4 (表ごと): authenticated は自分の行を SELECT で読める。他人の行は読めない (進み具合の表示と Realtime が使う)
 *   Q-5 (表ごと): anon も書けない
 *   Q-6 (表ごと): service_role (route の getAiQueueWriter・cron・Edge Function) は INSERT / UPDATE / DELETE できる
 *   Q-7: カタログ: 書き込みの権限とポリシーが残っていない。SELECT の本人ポリシーは残っている
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/ai-queue-writes.test.ts
 *
 * カタログの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で行う。本番には接続しない。
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ローカルスタックの Kong -> PostgREST の接続は、しばらく使っていないと切られていることがあり、
 * 使い回した最初の 1 回が 502 になる。データベースの結果ではないので、数回だけやり直す (ai-usage-rpc.test.ts と同じ)。
 */
const GATEWAY_RETRIES = 3;
/** 502 のやり直しの待ち (やり直すたびにこの時間ずつ延ばす) */
const GATEWAY_RETRY_STEP_MS = 150;
const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 502 || attempt >= GATEWAY_RETRIES) return res;
    await sleep(GATEWAY_RETRY_STEP_MS * (attempt + 1));
  }
};

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: {
      fetch: fetchRetryingGateway502,
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

/** ローカルスタックの postgres-meta で SQL を実行する */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetchRetryingGateway502(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

// ---------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = 'TestPass!2026-aiq';
const DAY = '2026-10-11';
/** PostgreSQL の「権限が無い」(insufficient_privilege) */
const INSUFFICIENT_PRIVILEGE = '42501';

interface TestUser {
  id: string;
  jwt: string;
}

const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `rls-1465-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: pErr } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `aiq-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (pErr) throw new Error(`user_profiles ${label}: ${pErr.message}`);
  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const { data: session, error: sErr } = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr || !session.session) throw new Error(`signIn ${label}: ${sErr?.message}`);
  return { id: data.user.id, jwt: session.session.access_token };
}

/** 献立の生成のリクエストの行 (route の v5/generate が積むのと同じ形の最小) */
function menuRequestRow(userId: string, marker: string) {
  return {
    user_id: userId,
    start_date: DAY,
    mode: 'v5',
    status: 'queued',
    prompt: marker,
    generated_data: { userId, marker },
  };
}

/** 料理の画像のジョブの行 (lib/meal-image-jobs.ts の enqueueMealImageJobs が積むのと同じ形の最小) */
function imageJobRow(userId: string, plannedMealId: string, marker: string) {
  return {
    planned_meal_id: plannedMealId,
    user_id: userId,
    dish_index: 0,
    job_kind: 'dish',
    subject_hash: `hash-${marker}`,
    idempotency_key: `aiq-${TS}-${marker}`,
    prompt: `prompt ${marker}`,
    model: 'test-model',
    status: 'pending',
  };
}

async function createPlannedMeal(userId: string): Promise<string> {
  const { data: day, error: dErr } = await srAdmin
    .from('user_daily_meals')
    .insert({ user_id: userId, day_date: DAY, is_cheat_day: false })
    .select('id')
    .single();
  if (dErr || !day) throw new Error(`user_daily_meals: ${dErr?.message}`);
  const { data: meal, error: mErr } = await srAdmin
    .from('planned_meals')
    .insert({ daily_meal_id: day.id, meal_type: 'dinner', dish_name: `aiq-${TS}` })
    .select('id')
    .single();
  if (mErr || !meal) throw new Error(`planned_meals: ${mErr?.message}`);
  return meal.id as string;
}

async function seedMenuRequest(userId: string, marker: string): Promise<string> {
  const { data, error } = await srAdmin.from('weekly_menu_requests').insert(menuRequestRow(userId, marker)).select('id').single();
  if (error || !data) throw new Error(`seed weekly_menu_requests: ${error?.message}`);
  return data.id as string;
}

async function seedImageJob(userId: string, plannedMealId: string, marker: string): Promise<string> {
  const { data, error } = await srAdmin
    .from('meal_image_jobs')
    .insert(imageJobRow(userId, plannedMealId, marker))
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed meal_image_jobs: ${error?.message}`);
  return data.id as string;
}

/** service role で行を読む (無ければ null) */
async function readAsService(table: 'weekly_menu_requests' | 'meal_image_jobs', id: string) {
  const { data, error } = await srAdmin.from(table).select('id, user_id, status, prompt').eq('id', id).maybeSingle();
  if (error) throw new Error(`read ${table} ${id}: ${error.message}`);
  return data;
}

/** 書き込みが「権限が無い」で拒まれたこと (RLS で 0 行になるのではなく、権限で止まる) */
function expectDenied(res: { error: { code?: string; message: string } | null }) {
  expect(res.error, '書き込みが拒まれていない').not.toBeNull();
  expect(res.error?.code).toBe(INSUFFICIENT_PRIVILEGE);
}

let owner: TestUser;
let other: TestUser;
let ownerMealId: string;
let otherMealId: string;

beforeAll(async () => {
  owner = await createUser('owner');
  other = await createUser('other');
  ownerMealId = await createPlannedMeal(owner.id);
  otherMealId = await createPlannedMeal(other.id);
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin.from('meal_image_jobs').delete().eq('user_id', id);
    await srAdmin.from('weekly_menu_requests').delete().eq('user_id', id);
    await srAdmin.from('user_daily_meals').delete().eq('user_id', id);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
});

// ---------------------------------------------------------------
// weekly_menu_requests
// ---------------------------------------------------------------
describe('weekly_menu_requests: 利用者は書けない・読める (#1465)', () => {
  it('Q-1: authenticated は自分の行を INSERT できない (行は作られない)', async () => {
    const marker = `wmr-insert-${TS}`;
    const res = await asUser(owner.jwt).from('weekly_menu_requests').insert(menuRequestRow(owner.id, marker)).select('id');
    expectDenied(res);
    const { data } = await srAdmin.from('weekly_menu_requests').select('id').eq('user_id', owner.id).eq('prompt', marker);
    expect(data).toEqual([]);
  });

  it('Q-2: authenticated は自分の行を UPDATE できない (積み直し・status の書き換えができない)', async () => {
    const id = await seedMenuRequest(owner.id, `wmr-update-${TS}`);
    await srAdmin.from('weekly_menu_requests').update({ status: 'failed' }).eq('id', id);
    const res = await asUser(owner.jwt)
      .from('weekly_menu_requests')
      .update({ status: 'queued', prompt: 'tampered' })
      .eq('id', id)
      .select('id');
    expectDenied(res);
    expect(await readAsService('weekly_menu_requests', id)).toMatchObject({ status: 'failed', prompt: `wmr-update-${TS}` });
  });

  it('Q-3: authenticated は自分の行を DELETE できない', async () => {
    const id = await seedMenuRequest(owner.id, `wmr-delete-${TS}`);
    const res = await asUser(owner.jwt).from('weekly_menu_requests').delete().eq('id', id).select('id');
    expectDenied(res);
    expect(await readAsService('weekly_menu_requests', id)).not.toBeNull();
  });

  it('Q-4: authenticated は自分の行を読める。他人の行は読めない', async () => {
    const ownId = await seedMenuRequest(owner.id, `wmr-select-own-${TS}`);
    const otherId = await seedMenuRequest(other.id, `wmr-select-other-${TS}`);
    const own = await asUser(owner.jwt).from('weekly_menu_requests').select('id, status, progress').eq('id', ownId);
    expect(own.error).toBeNull();
    expect(own.data?.map((row) => row.id)).toEqual([ownId]);
    const others = await asUser(owner.jwt).from('weekly_menu_requests').select('id').eq('id', otherId);
    expect(others.error).toBeNull();
    expect(others.data).toEqual([]);
  });

  it('Q-5: anon は INSERT / UPDATE できない', async () => {
    const marker = `wmr-anon-${TS}`;
    expectDenied(await anon().from('weekly_menu_requests').insert(menuRequestRow(owner.id, marker)).select('id'));
    const id = await seedMenuRequest(owner.id, `wmr-anon-update-${TS}`);
    expectDenied(await anon().from('weekly_menu_requests').update({ status: 'failed' }).eq('id', id).select('id'));
    expect(await readAsService('weekly_menu_requests', id)).toMatchObject({ status: 'queued' });
  });

  it('Q-6: service_role は INSERT / UPDATE / DELETE できる (route の getAiQueueWriter・cron・Edge Function の経路)', async () => {
    const marker = `wmr-service-${TS}`;
    const inserted = await srAdmin.from('weekly_menu_requests').insert(menuRequestRow(owner.id, marker)).select('id').single();
    expect(inserted.error).toBeNull();
    const id = inserted.data!.id as string;
    const updated = await srAdmin.from('weekly_menu_requests').update({ status: 'processing' }).eq('id', id).select('id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ id }]);
    expect(await readAsService('weekly_menu_requests', id)).toMatchObject({ status: 'processing' });
    const deleted = await srAdmin.from('weekly_menu_requests').delete().eq('id', id).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id }]);
    expect(await readAsService('weekly_menu_requests', id)).toBeNull();
  });
});

// ---------------------------------------------------------------
// meal_image_jobs
// ---------------------------------------------------------------
describe('meal_image_jobs: 利用者は書けない・読める (#1465)', () => {
  it('Q-1: authenticated は自分のジョブを INSERT できない (行は作られない)', async () => {
    const marker = `mij-insert-${TS}`;
    const res = await asUser(owner.jwt).from('meal_image_jobs').insert(imageJobRow(owner.id, ownerMealId, marker)).select('id');
    expectDenied(res);
    const { data } = await srAdmin.from('meal_image_jobs').select('id').eq('idempotency_key', `aiq-${TS}-${marker}`);
    expect(data).toEqual([]);
  });

  it('Q-2: authenticated は自分のジョブを UPDATE できない (prompt の書き換え・pending への戻しができない)', async () => {
    const id = await seedImageJob(owner.id, ownerMealId, `mij-update-${TS}`);
    await srAdmin.from('meal_image_jobs').update({ status: 'failed' }).eq('id', id);
    const res = await asUser(owner.jwt)
      .from('meal_image_jobs')
      .update({ status: 'pending', prompt: 'tampered' })
      .eq('id', id)
      .select('id');
    expectDenied(res);
    expect(await readAsService('meal_image_jobs', id)).toMatchObject({ status: 'failed', prompt: `prompt mij-update-${TS}` });
  });

  it('Q-3: authenticated は自分のジョブを DELETE できない', async () => {
    const id = await seedImageJob(owner.id, ownerMealId, `mij-delete-${TS}`);
    const res = await asUser(owner.jwt).from('meal_image_jobs').delete().eq('id', id).select('id');
    expectDenied(res);
    expect(await readAsService('meal_image_jobs', id)).not.toBeNull();
  });

  it('Q-4: authenticated は自分のジョブを読める。他人のジョブは読めない', async () => {
    const ownId = await seedImageJob(owner.id, ownerMealId, `mij-select-own-${TS}`);
    const otherId = await seedImageJob(other.id, otherMealId, `mij-select-other-${TS}`);
    const own = await asUser(owner.jwt).from('meal_image_jobs').select('id, status').eq('id', ownId);
    expect(own.error).toBeNull();
    expect(own.data?.map((row) => row.id)).toEqual([ownId]);
    const others = await asUser(owner.jwt).from('meal_image_jobs').select('id').eq('id', otherId);
    expect(others.error).toBeNull();
    expect(others.data).toEqual([]);
  });

  it('Q-5: anon は INSERT / UPDATE できない', async () => {
    expectDenied(await anon().from('meal_image_jobs').insert(imageJobRow(owner.id, ownerMealId, `mij-anon-${TS}`)).select('id'));
    const id = await seedImageJob(owner.id, ownerMealId, `mij-anon-update-${TS}`);
    expectDenied(await anon().from('meal_image_jobs').update({ status: 'failed' }).eq('id', id).select('id'));
    expect(await readAsService('meal_image_jobs', id)).toMatchObject({ status: 'pending' });
  });

  it('Q-6: service_role は INSERT / UPDATE / DELETE できる (route の getAiQueueWriter・Edge Function の経路)', async () => {
    const inserted = await srAdmin
      .from('meal_image_jobs')
      .insert(imageJobRow(owner.id, ownerMealId, `mij-service-${TS}`))
      .select('id')
      .single();
    expect(inserted.error).toBeNull();
    const id = inserted.data!.id as string;
    const updated = await srAdmin.from('meal_image_jobs').update({ status: 'cancelled' }).eq('id', id).select('id');
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual([{ id }]);
    expect(await readAsService('meal_image_jobs', id)).toMatchObject({ status: 'cancelled' });
    const deleted = await srAdmin.from('meal_image_jobs').delete().eq('id', id).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id }]);
    expect(await readAsService('meal_image_jobs', id)).toBeNull();
  });
});

// ---------------------------------------------------------------
// カタログ
// ---------------------------------------------------------------
describe('AI のキュー: 権限とポリシー (カタログ) (#1465)', () => {
  const TABLES = ['weekly_menu_requests', 'meal_image_jobs'] as const;
  const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const;

  it('Q-7a: anon / authenticated に書き込みの権限が無い。authenticated の SELECT と service_role の書き込みは残る', async () => {
    const checks = TABLES.flatMap((table) =>
      ['anon', 'authenticated', 'service_role'].flatMap((role) =>
        [...WRITE_PRIVILEGES, 'SELECT'].map(
          (privilege) =>
            `SELECT '${table}' AS tbl, '${role}' AS role, '${privilege}' AS privilege, has_table_privilege('${role}', 'public.${table}', '${privilege}') AS granted`,
        ),
      ),
    );
    const rows = await pgQuery<{ tbl: string; role: string; privilege: string; granted: boolean }>(checks.join('\nUNION ALL\n'));
    const granted = (table: string, role: string, privilege: string) =>
      rows.find((row) => row.tbl === table && row.role === role && row.privilege === privilege)?.granted;
    for (const table of TABLES) {
      for (const role of ['anon', 'authenticated']) {
        for (const privilege of WRITE_PRIVILEGES) expect(granted(table, role, privilege), `${role} ${privilege} ${table}`).toBe(false);
      }
      expect(granted(table, 'authenticated', 'SELECT'), `authenticated SELECT ${table}`).toBe(true);
      for (const privilege of WRITE_PRIVILEGES) expect(granted(table, 'service_role', privilege), `service_role ${privilege} ${table}`).toBe(true);
    }
  });

  it('Q-7b: 利用者に効く書き込みのポリシーが無い。本人の SELECT のポリシーは残る', async () => {
    const rows = await pgQuery<{ tablename: string; policyname: string; cmd: string; roles: string[] | string; qual: string | null }>(`
      SELECT tablename, policyname, cmd, roles, qual
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('weekly_menu_requests', 'meal_image_jobs')
      ORDER BY tablename, policyname
    `);
    const summary = rows.map((row) => `${row.tablename}:${row.policyname}:${row.cmd}`);
    expect(summary).toEqual([
      'meal_image_jobs:meal_image_jobs_select_own:SELECT',
      'meal_image_jobs:service_role can manage meal_image_jobs:ALL',
      'weekly_menu_requests:Users can view their own requests:SELECT',
    ]);
    // 残る ALL のポリシーは、service_role のときだけ効く (利用者の書き込みを許さない)
    const serviceOnly = rows.find((row) => row.policyname === 'service_role can manage meal_image_jobs');
    expect(serviceOnly?.qual).toContain("'service_role'");
  });
});
