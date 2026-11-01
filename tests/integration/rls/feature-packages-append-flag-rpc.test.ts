/**
 * #2189 W4: 機能パッケージのフラグキーの一覧にキーを 1 つ足す関数 append_flag_to_feature_package
 * (*_feature_packages_append_flag_rpc.sql) の実 DB での振る舞い。運営最上位が 2 人ほぼ同時にフラグを作っても、
 * パッケージの feature_flags に両方のキーが残ること。
 *
 * 確かめること (I-n はこのファイルの it の番号):
 *   - I-1: カタログ: SECURITY INVOKER・STRICT・RETURNS text・search_path は空。EXECUTE は service_role だけ
 *          (PUBLIC・anon・authenticated には無い)
 *   - I-2: service_role が足すと added で末尾に入り、updated_at が新しくなる。同じキーをもう一度足すと already_present で
 *          二重に入らず、行は変わらない。無いパッケージの鍵は not_found
 *   - I-3: anon とログインした利用者 (authenticated) は呼べない (42501)。パッケージは変わらない
 *   - I-4: 先に足した接続がコミット前のまま行を持っている間に、別のキーを足す呼び出しは行のロックを待ち、
 *          相手のコミットの後の feature_flags に足す (両方残る)。同じキーなら already_present で二重に入らない
 *          (lock-holder で、待ちに並んだのを pg_stat_activity で確かめてから放す。決まった順で再現する)
 *   - I-5: 同じパッケージへ、違うキーを同時に何本も足しても、全部が 1 回ずつ残る。同じキーを同時に何本も足すと、
 *          added は 1 本だけで残りは already_present、キーは 1 回だけ入る
 *   - I-6: 戻し口を 1 つのトランザクションで流して巻き戻す (DB には残らない): 関数が消える。巻き戻ったあとは関数が残っている
 *
 * 修正前 (migration を流す前) は全部が赤になる (関数が無い)。route を通した同時の作成は
 * tests/integration/operator/super-admin-flags.test.ts が確かめる。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/feature-packages-append-flag-rpc.test.ts
 * カタログ・コミット前の接続・戻し口の確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 * 試験用のパッケージは、この実行だけの鍵で作り (basic などの既存のパッケージには触れない)、afterAll で消す。
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import {
  FEATURE_PACKAGE_FLAG_APPEND_OUTCOME,
  FEATURE_PACKAGES_APPEND_FLAG_RPC,
} from '@/lib/super-admin/feature-package-flag-append';
import {
  APPEND_FLAG_RPC_SIGNATURE,
  FEATURE_PACKAGES_APPEND_FLAG_RPC_MIGRATION_NAME,
  FEATURE_PACKAGES_TABLE,
} from '../../helpers/feature-packages-append-flag-rpc';
import { createLockHolderKit } from '../helpers/lock-holder';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
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

async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'w4-append-flag' });

const ROOT = path.resolve(__dirname, '../../..');
const ROLLBACKS_DIR = path.join(ROOT, 'supabase', 'rollbacks');
const readRollback = (): string => {
  const file = fs.readdirSync(ROLLBACKS_DIR).find((f) => f.endsWith(`_${FEATURE_PACKAGES_APPEND_FLAG_RPC_MIGRATION_NAME}.down.sql`));
  if (!file) throw new Error(`戻し口 ${FEATURE_PACKAGES_APPEND_FLAG_RPC_MIGRATION_NAME} が無い`);
  return fs.readFileSync(path.join(ROLLBACKS_DIR, file), 'utf-8');
};
/** 巻き戻すトランザクションの結果を例外の文に載せる目印 */
const ROLLBACK_RESULT_MARKER = 'FEATURE_PACKAGES_APPEND_FLAG_RPC_ROLLBACK_RESULT:';
/** 関数の数を数える SQL (戻し口の前後で 1 → 0) */
const FUNCTION_COUNT_SQL = `(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${FEATURE_PACKAGES_APPEND_FLAG_RPC}')`;
/** PostgreSQL の権限の不足の SQLSTATE */
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';
/** I-5 で同時に足す本数 (PostgREST の接続の数より少なく、重なりが起きるだけの数) */
const CONCURRENT_APPENDS = 8;
/** 試験用のパッケージの updated_at の初期値 (足したときに今の時刻へ進むのを見分けるため、十分に過去にする) */
const SEED_UPDATED_AT = '2000-01-01T00:00:00.000Z';
/** 試験用のパッケージの並び順 (一覧の末尾に出るよう、既存のパッケージより大きくする) */
const SEED_DISPLAY_ORDER = 9999;

function findMarkedText(body: unknown): string | null {
  if (typeof body === 'string') return body.includes(ROLLBACK_RESULT_MARKER) ? body : null;
  if (body && typeof body === 'object') {
    for (const value of Object.values(body as Record<string, unknown>)) {
      const found = findMarkedText(value);
      if (found) return found;
    }
  }
  return null;
}

/** 戻し口を流し、その直後の関数の数を例外の文に載せて、トランザクションごと巻き戻す */
async function functionCountAfterRolledBack(sql: string): Promise<number> {
  const report = `
DO $report$
BEGIN
  RAISE EXCEPTION '${ROLLBACK_RESULT_MARKER}%;', ${FUNCTION_COUNT_SQL}::text;
END
$report$;`;
  const res = await pgRequest(`${sql}\n${report}`);
  expect(res.ok, '結果の例外が返らなかった (トランザクションが巻き戻っていない恐れ)').toBe(false);
  const text = findMarkedText(res.body);
  if (text === null) throw new Error(`戻し口が例外で止まった: ${JSON.stringify(res.body)}`);
  const rest = text.slice(text.indexOf(ROLLBACK_RESULT_MARKER) + ROLLBACK_RESULT_MARKER.length);
  return Number(rest.slice(0, rest.indexOf(';')));
}

async function currentFunctionCount(): Promise<number> {
  const [row] = await pgQuery<{ count: string | number }>(`SELECT ${FUNCTION_COUNT_SQL} AS count;`);
  return Number(row.count);
}

// ---------------------------------------------------------------
// 試験用のパッケージとユーザー
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const LONG = 120_000;
/** この実行で使うパッケージの鍵 (他の実行の行と混ざらないように実行の印を付ける) */
const PACKAGE_KEY = (label: string) => `w4_${label}_${TS}`;
/** この実行で使うフラグのキー */
const FLAG_KEY = (label: string) => `w4_flag_${label}_${TS}`;
const createdPackageKeys: string[] = [];
let createdUserId: string | null = null;
let userJwt = '';

/** service_role で試験用のパッケージを 1 件作る */
async function seedPackage(label: string, featureFlags: string[] = []): Promise<string> {
  const packageKey = PACKAGE_KEY(label);
  const { error } = await srAdmin.from(FEATURE_PACKAGES_TABLE).insert({
    package_key: packageKey,
    display_name: `W4 試験 ${label} ${TS}`,
    feature_flags: featureFlags,
    display_order: SEED_DISPLAY_ORDER,
    updated_at: SEED_UPDATED_AT,
  });
  if (error) throw new Error(`seed feature_packages ${label}: ${error.message}`);
  createdPackageKeys.push(packageKey);
  return packageKey;
}

/** service_role でパッケージの feature_flags と updated_at を読む */
async function packageOf(packageKey: string): Promise<{ feature_flags: string[]; updated_at: string }> {
  const { data, error } = await srAdmin
    .from(FEATURE_PACKAGES_TABLE)
    .select('feature_flags, updated_at')
    .eq('package_key', packageKey)
    .single();
  if (error || !data) throw new Error(`select feature_packages: ${error?.message}`);
  return data as { feature_flags: string[]; updated_at: string };
}

/**
 * service_role で関数を呼ぶ。PostgREST のビルダーは then だけを持つ (catch が無い) ので、async で本物の Promise にして返す
 * (lock-holder の runBehindHolder が呼び出しの結果に catch を付ける)
 */
async function appendAsServiceRole(packageKey: string, flagKey: string) {
  return await srAdmin.rpc(FEATURE_PACKAGES_APPEND_FLAG_RPC, { p_package_key: packageKey, p_flag_key: flagKey });
}

beforeAll(async () => {
  const email = `w4-2189-user-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  createdUserId = data.user.id;
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles').upsert({ id: data.user.id, nickname: 'w4-user', age_group: '30s', gender: 'other' }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
  userJwt = signIn.data.session.access_token;
}, LONG);

afterEach(() => holders.releaseOpenHolders());

afterAll(async () => {
  await holders.settle();
  if (createdPackageKeys.length > 0) {
    await srAdmin.from(FEATURE_PACKAGES_TABLE).delete().in('package_key', createdPackageKeys);
  }
  if (createdUserId) {
    await srAdmin.from('user_profiles').delete().eq('id', createdUserId);
    await srAdmin.auth.admin.deleteUser(createdUserId);
  }
}, LONG);

describe('#2189 W4 append_flag_to_feature_package (1 文の条件つき UPDATE)', () => {
  it('I-1: カタログ: SECURITY INVOKER・STRICT・RETURNS text・search_path は空。EXECUTE は service_role だけ', async () => {
    const rows = await pgQuery<{
      sig: string;
      secdef: boolean;
      strict: boolean;
      rettype: string;
      config: string[] | null;
      public_exec: boolean;
      anon_exec: boolean;
      auth_exec: boolean;
      sr_exec: boolean;
    }>(`
      SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
             p.prosecdef AS secdef,
             p.proisstrict AS strict,
             p.prorettype::regtype::text AS rettype,
             p.proconfig AS config,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_exec,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = '${FEATURE_PACKAGES_APPEND_FLAG_RPC}'
    `);
    expect(rows).toEqual([
      {
        sig: APPEND_FLAG_RPC_SIGNATURE,
        secdef: false,
        strict: true,
        rettype: 'text',
        config: ['search_path=""'],
        public_exec: false,
        anon_exec: false,
        auth_exec: false,
        sr_exec: true,
      },
    ]);
  });

  it('I-2: 足すと added で末尾に入り updated_at が進む。同じキーは already_present で変わらない。無い鍵は not_found', async () => {
    const existing = FLAG_KEY('existing');
    const flagKey = FLAG_KEY('added');
    const packageKey = await seedPackage('own', [existing]);

    const first = await appendAsServiceRole(packageKey, flagKey);
    expect(first.error).toBeNull();
    expect(first.data).toBe(FEATURE_PACKAGE_FLAG_APPEND_OUTCOME.added);
    const afterFirst = await packageOf(packageKey);
    expect(afterFirst.feature_flags).toEqual([existing, flagKey]);
    expect(new Date(afterFirst.updated_at).getTime()).toBeGreaterThan(new Date(SEED_UPDATED_AT).getTime());

    const second = await appendAsServiceRole(packageKey, flagKey);
    expect(second.error).toBeNull();
    expect(second.data).toBe(FEATURE_PACKAGE_FLAG_APPEND_OUTCOME.alreadyPresent);
    expect(await packageOf(packageKey)).toEqual(afterFirst);

    const missing = await appendAsServiceRole(PACKAGE_KEY('missing'), flagKey);
    expect(missing.error).toBeNull();
    expect(missing.data).toBe(FEATURE_PACKAGE_FLAG_APPEND_OUTCOME.notFound);
  }, LONG);

  it('I-3: anon とログインした利用者は呼べない (42501)。パッケージは変わらない', async () => {
    const packageKey = await seedPackage('denied');
    for (const caller of [anon(), asUser(userJwt)]) {
      const { data, error } = await caller.rpc(FEATURE_PACKAGES_APPEND_FLAG_RPC, {
        p_package_key: packageKey,
        p_flag_key: FLAG_KEY('denied'),
      });
      expect(error?.code, error?.message).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
      expect(data).toBeNull();
    }
    expect((await packageOf(packageKey)).feature_flags).toEqual([]);
  }, LONG);

  it('I-4: 先に足した接続がコミット前のまま行を持つ間に足すと、行のロックを待ってから相手の後に足す (両方残る・同じキーは 1 回)', async () => {
    const firstKey = FLAG_KEY('held_first');
    const secondKey = FLAG_KEY('held_second');
    const packageKey = await seedPackage('held');

    const holdingAppend = (flagKey: string) =>
      holders.startHolder(
        '先にキーを足してコミット前のまま開いておく接続',
        `SET LOCAL ROLE service_role;
         SELECT public.${FEATURE_PACKAGES_APPEND_FLAG_RPC}('${packageKey}', '${flagKey}');`,
      );

    // 違うキー: 待った方は、相手のコミットの後の feature_flags に対して条件を確かめ直して足す
    const [held, waited] = await holders.runBehindHolder(holdingAppend(firstKey), {
      fn: FEATURE_PACKAGES_APPEND_FLAG_RPC,
      call: () => appendAsServiceRole(packageKey, secondKey),
    });
    expect(held.ok, held.message ?? '').toBe(true);
    expect(waited.error).toBeNull();
    expect(waited.data).toBe(FEATURE_PACKAGE_FLAG_APPEND_OUTCOME.added);
    expect((await packageOf(packageKey)).feature_flags).toEqual([firstKey, secondKey]);

    // 同じキー: 待った方は、相手が足した後の値で「既に入っている」になり、二重に入らない
    const sameKey = FLAG_KEY('held_same');
    const [heldSame, waitedSame] = await holders.runBehindHolder(holdingAppend(sameKey), {
      fn: FEATURE_PACKAGES_APPEND_FLAG_RPC,
      call: () => appendAsServiceRole(packageKey, sameKey),
    });
    expect(heldSame.ok, heldSame.message ?? '').toBe(true);
    expect(waitedSame.error).toBeNull();
    expect(waitedSame.data).toBe(FEATURE_PACKAGE_FLAG_APPEND_OUTCOME.alreadyPresent);
    expect((await packageOf(packageKey)).feature_flags).toEqual([firstKey, secondKey, sameKey]);
  }, LONG);

  it('I-5: 違うキーを同時に何本も足すと全部が 1 回ずつ残り、同じキーを同時に何本も足すと added は 1 本だけ', async () => {
    const packageKey = await seedPackage('concurrent');
    const flagKeys = Array.from({ length: CONCURRENT_APPENDS }, (_, i) => FLAG_KEY(`concurrent_${i}`));
    const distinct = await Promise.all(flagKeys.map((flagKey) => appendAsServiceRole(packageKey, flagKey)));
    for (const res of distinct) {
      expect(res.error).toBeNull();
      expect(res.data).toBe(FEATURE_PACKAGE_FLAG_APPEND_OUTCOME.added);
    }
    expect([...(await packageOf(packageKey)).feature_flags].sort()).toEqual([...flagKeys].sort());

    const sameKey = FLAG_KEY('concurrent_same');
    const same = await Promise.all(Array.from({ length: CONCURRENT_APPENDS }, () => appendAsServiceRole(packageKey, sameKey)));
    for (const res of same) expect(res.error).toBeNull();
    const outcomes = same.map((res) => res.data);
    expect(outcomes.filter((o) => o === FEATURE_PACKAGE_FLAG_APPEND_OUTCOME.added)).toHaveLength(1);
    expect(outcomes.filter((o) => o === FEATURE_PACKAGE_FLAG_APPEND_OUTCOME.alreadyPresent)).toHaveLength(CONCURRENT_APPENDS - 1);
    const afterSame = (await packageOf(packageKey)).feature_flags;
    expect(afterSame.filter((key) => key === sameKey)).toHaveLength(1);
    expect(afterSame).toHaveLength(CONCURRENT_APPENDS + 1);
  }, LONG);

  it('I-6: 戻し口を 1 つのトランザクションで流して巻き戻す。関数が消え、巻き戻ったあとは関数が残っている', async () => {
    expect(await functionCountAfterRolledBack(readRollback())).toBe(0);
    expect(await currentFunctionCount()).toBe(1);
  }, LONG);
});
