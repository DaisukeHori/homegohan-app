/**
 * #1917 利用者のロールの変更 (admin_set_user_roles) が、変える前の roles (previous_roles) を返し、
 * 同時の変更があってもそれがこの呼び出しの UPDATE の直前の値であること (実 DB)。
 *
 * 修正前は route が関数の外でロックを取らずに roles を読み、それを監査の previous_roles に残していた。super_admin 2 人が
 * ほぼ同時に同じ利用者のロールを変えると、後の変更の監査に、先の変更より前の値が残った。
 * 修正後 (supabase/migrations/20261023110000_admin_set_user_roles_previous_roles.sql) は、関数が対象の行を
 * FOR NO KEY UPDATE でロックしてから roles を読み、戻り値の previous_roles で返す。
 *
 *   PR-1 戻り値は 1 行で、id・新しい roles・変える前の roles。DB の行は新しい roles になる
 *   PR-2 先の変更をコミット前のまま開いておくと、後の変更 (PostgREST + 本人の JWT) は行のロックで待ち、
 *        先の変更がコミットした後の roles を previous_roles で返す (ロックを取らずに読むと、コミット前の古い値になる)
 *   PR-3 対象の roles が NULL なら previous_roles は NULL
 *   PR-4 判定は今までどおり: super_admin でない呼び出し元は FORBIDDEN・自分は CANNOT_MODIFY_OWN_ROLES・
 *        無い利用者は USER_NOT_FOUND。どれも行を変えない
 *   PR-5 EXECUTE は authenticated と service_role だけ (anon・PUBLIC に無い。DROP して作り直したので付け直したこと)
 *
 * 競合の再現は family-lock-order-race.test.ts と同じ (タイミングに頼らない): postgres-meta (/pg/query) で
 * 本人になりすまして先に関数を呼び、そのあと pg_sleep でトランザクションを開いたままにする接続を作り、
 * pg_sleep に入ったのを pg_stat_activity で確かめてから、後の変更を本物の経路 (PostgREST + 本人の JWT) で呼ぶ。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/admin-set-user-roles-previous-roles.test.ts
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const RPC = 'admin_set_user_roles';
/** 準備と後片付けの時間の上限 (利用者 5 人の作成・削除) */
const SETUP_TIMEOUT_MS = 120_000;
/** 競合のテストの時間の上限 (先の接続を HOLD_SECONDS 開いておき、後の変更がその間待つ) */
const RACE_TIMEOUT_MS = 60_000;
/** 先の変更をコミット前のまま開いておく秒数 (後の変更がこの間ロックで待つことを見る) */
const HOLD_SECONDS = 3;
/** 先の接続が pg_sleep に入るのを待つ上限 */
const HOLDER_START_DEADLINE_MS = 20_000;
/** pg_sleep に入ったかを見る間隔 */
const HOLDER_POLL_MS = 50;
/**
 * 後の変更が、先の接続のコミット (pg_sleep の終わり) より前に返っていないことを見るときの余裕。
 * 後の変更の応答の時刻は先の接続の応答の時刻と HTTP の往復の分だけずれるので、その分を差し引く
 */
const COMMIT_ORDER_SLACK_MS = 500;
/** ローカルスタックの Kong → PostgREST の接続が切られていたときの 502 のやり直しの回数 (family-lock-order-race.test.ts と同じ) */
const GATEWAY_RETRIES = 3;
/** 502 のやり直しの待ちの単位 */
const GATEWAY_RETRY_BASE_MS = 150;
/** これより遅く返った 502 は、pg_sleep で待たせた後の応答なのでやり直さない */
const GATEWAY_FAST_FAILURE_MS = 1_500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 502 || attempt >= GATEWAY_RETRIES) return res;
    await sleep(GATEWAY_RETRY_BASE_MS * (attempt + 1));
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

/** ローカルスタックの postgres-meta で SQL を実行する。複数の文は 1 つのトランザクションで実行され、最後の文の行が返る */
async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 502 && attempt < GATEWAY_RETRIES && Date.now() - startedAt < GATEWAY_FAST_FAILURE_MS) {
      await sleep(GATEWAY_RETRY_BASE_MS * (attempt + 1));
      continue;
    }
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  }
}

async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const pendingHolders: Array<Promise<unknown>> = [];

async function createUser(label: string, roles: string[] | null): Promise<TestUser> {
  const email = `sec-rolecas-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db
      .from('user_profiles')
      .upsert({ id: data.user.id, nickname: `rolecas-${label}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function rolesOf(userId: string): Promise<string[] | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('roles').eq('id', userId).single();
  if (error) throw new Error(`roles ${userId}: ${error.message}`);
  return (data as { roles: string[] | null }).roles;
}

async function setRolesDirect(userId: string, roles: string[] | null): Promise<void> {
  const { error } = await srAdmin.from('user_profiles').update({ roles }).eq('id', userId);
  if (error) throw new Error(`setRolesDirect ${userId}: ${error.message}`);
}

interface Holder {
  /** 先の変更が済み、pg_sleep に入った (= ロックを持ったままコミット前の) 状態になると解決する */
  sleeping: Promise<void>;
  /** トランザクションが終わった時刻 (ミリ秒) と成否 */
  done: Promise<{ ok: boolean; finishedAt: number; body: unknown }>;
}

/** 別の接続で actor になりすまして admin_set_user_roles を呼び、HOLD_SECONDS 秒トランザクションを開いたままにしてからコミットする */
function holdRoleChange(actor: TestUser, targetId: string, roles: readonly string[]): Holder {
  const marker = `rolecas-holder-${randomBytes(6).toString('hex')}`;
  const claims = JSON.stringify({ sub: actor.id, role: 'authenticated' });
  const rolesSql = `ARRAY[${roles.map((r) => `'${r}'`).join(', ')}]::text[]`;
  const sql = `/* ${marker} */
    SELECT set_config('request.jwt.claims', '${claims}', true);
    SET LOCAL ROLE authenticated;
    SELECT * FROM public.${RPC}('${targetId}'::uuid, ${rolesSql});
    SELECT pg_sleep(${HOLD_SECONDS});
    SELECT 'held' AS result;`;

  const state: { finished: boolean; body: unknown } = { finished: false, body: null };
  const done = pgRequest(sql).then((res) => {
    state.finished = true;
    state.body = res.body;
    return { ok: res.ok, finishedAt: Date.now(), body: res.body };
  });
  pendingHolders.push(done);

  const sleeping = (async () => {
    const deadline = Date.now() + HOLDER_START_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (state.finished) {
        throw new Error(`先に呼んだ接続が pg_sleep に入る前に終わりました: ${JSON.stringify(state.body)}`);
      }
      const rows = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      if (rows[0]?.n === 1) return;
      await sleep(HOLDER_POLL_MS);
    }
    throw new Error('先に呼んだ接続が pg_sleep に入りませんでした (遅すぎます)');
  })();

  return { sleeping, done };
}

type RpcRow = { id: string; roles: string[]; previous_roles: string[] | null };

let operatorA: TestUser;
let operatorB: TestUser;
let plainUser: TestUser;
let target: TestUser;

beforeAll(async () => {
  [operatorA, operatorB, plainUser, target] = await Promise.all([
    createUser('op-a', ['super_admin']),
    createUser('op-b', ['super_admin']),
    createUser('plain', ['user']),
    createUser('target', ['user']),
  ]);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await Promise.allSettled(pendingHolders);
  await Promise.allSettled(createdUserIds.map((id) => srAdmin.auth.admin.deleteUser(id))); // user_profiles は CASCADE
}, SETUP_TIMEOUT_MS);

describe('#1917 admin_set_user_roles の previous_roles (実 DB)', () => {
  it('PR-1: 戻り値は 1 行で、id・新しい roles・変える前の roles。DB の行は新しい roles になる', async () => {
    await setRolesDirect(target.id, ['user']);

    const { data, error } = await asUser(operatorA.jwt).rpc(RPC, { p_user_id: target.id, p_roles: ['user', 'support'] });

    expect(error).toBeNull();
    expect(data as RpcRow[]).toEqual([{ id: target.id, roles: ['user', 'support'], previous_roles: ['user'] }]);
    expect(await rolesOf(target.id)).toEqual(['user', 'support']);

    // 続けて変えると、前の呼び出しの新しい roles が previous_roles になる
    const second = await asUser(operatorB.jwt).rpc(RPC, { p_user_id: target.id, p_roles: ['user', 'finance'] });
    expect(second.error).toBeNull();
    expect(second.data as RpcRow[]).toEqual([{ id: target.id, roles: ['user', 'finance'], previous_roles: ['user', 'support'] }]);
  });

  it(
    'PR-2: 先の変更がコミット前の間、後の変更は行のロックで待ち、先の変更の後の roles を previous_roles で返す',
    async () => {
      await setRolesDirect(target.id, ['user']);

      const holder = holdRoleChange(operatorA, target.id, ['user', 'admin']);
      await holder.sleeping;

      // 先の変更はまだコミットしていないので、別の接続からは元の roles が見える (ロックを取らずに読むとこの値になる)
      expect(await rolesOf(target.id)).toEqual(['user']);

      const later = asUser(operatorB.jwt)
        .rpc(RPC, { p_user_id: target.id, p_roles: ['user', 'finance'] })
        .then((res) => ({ ...res, finishedAt: Date.now() }));

      const [held, after] = await Promise.all([holder.done, later]);

      expect(held.ok, JSON.stringify(held.body)).toBe(true);
      expect(after.error).toBeNull();
      // 後の変更は先の変更のコミットを待ってから返った (ロックで並んだ)
      expect(after.finishedAt).toBeGreaterThanOrEqual(held.finishedAt - COMMIT_ORDER_SLACK_MS);
      // 後の変更の直前の値は、先の変更の後の roles (コミット前に見えていた元の ['user'] ではない)
      expect(after.data as RpcRow[]).toEqual([{ id: target.id, roles: ['user', 'finance'], previous_roles: ['user', 'admin'] }]);
      expect(await rolesOf(target.id)).toEqual(['user', 'finance']);
    },
    RACE_TIMEOUT_MS,
  );

  it('PR-3: 対象の roles が NULL なら previous_roles は NULL', async () => {
    await setRolesDirect(target.id, null);

    const { data, error } = await asUser(operatorA.jwt).rpc(RPC, { p_user_id: target.id, p_roles: ['user'] });

    expect(error).toBeNull();
    expect(data as RpcRow[]).toEqual([{ id: target.id, roles: ['user'], previous_roles: null }]);
  });

  it('PR-4: super_admin でない呼び出し元は FORBIDDEN・自分は CANNOT_MODIFY_OWN_ROLES・無い利用者は USER_NOT_FOUND。どれも行を変えない', async () => {
    await setRolesDirect(target.id, ['user']);

    const forbidden = await asUser(plainUser.jwt).rpc(RPC, { p_user_id: target.id, p_roles: ['user', 'admin'] });
    expect(forbidden.error?.message).toContain('FORBIDDEN');
    expect(await rolesOf(target.id)).toEqual(['user']);

    const self = await asUser(operatorA.jwt).rpc(RPC, { p_user_id: operatorA.id, p_roles: ['user'] });
    expect(self.error?.message).toContain('CANNOT_MODIFY_OWN_ROLES');
    expect(await rolesOf(operatorA.id)).toEqual(['super_admin']);

    const missingId = '00000000-0000-4000-8000-00000000f917';
    const missing = await asUser(operatorA.jwt).rpc(RPC, { p_user_id: missingId, p_roles: ['user'] });
    expect(missing.error?.message).toContain('USER_NOT_FOUND');
  });

  it('PR-5: EXECUTE は authenticated と service_role だけ (anon・PUBLIC に無い)', async () => {
    const rows = await pgQuery<{ grantee: string }>(`
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE n.nspname = 'public' AND p.proname = '${RPC}' AND a.privilege_type = 'EXECUTE'
      ORDER BY 1`);
    const grantees = rows.map((r) => r.grantee);
    expect(grantees).toEqual(expect.arrayContaining(['authenticated', 'service_role']));
    expect(grantees).not.toContain('anon');
    expect(grantees).not.toContain('PUBLIC');

    const anonCall = await anon().rpc(RPC, { p_user_id: target.id, p_roles: ['user', 'admin'] });
    expect(anonCall.error).not.toBeNull();
    expect(await rolesOf(target.id)).toEqual(['user']);
  });
});
