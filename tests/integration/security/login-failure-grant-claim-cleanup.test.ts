/**
 * #1492 ログイン失敗の記録 (auth_login_failures) と数え済みの印の使用済みの記録 (ai_usage_grant_claims) の掃除の回帰テスト
 *
 * migration 20261011070000_schedule_login_failure_and_grant_claim_cleanup.sql が、次を行う。
 *   - public.cleanup_stale_auth_login_failures(): coalesce(last_failed_at, updated_at) が 8 日より古い行を消す
 *     (8 日 = アプリの上限 LOGIN_FAILURE_RESET_MINUTES_MAX (7 日) + 余裕 1 日)
 *   - public.cleanup_expired_ai_usage_grant_claims(): 利用者を問わず、claimed_at が 1 日より古い行を消す
 *     (1 日 = claim_ai_usage_grant の c_claim_retention)
 *   - pg_cron のジョブ cleanup-stale-login-failures-and-grant-claims (毎日 03:45 JST = 18:45 UTC) が 2 つの関数を呼ぶ
 *
 * 確かめること:
 *   A. 関数の属性と権限: SECURITY INVOKER・search_path 空・LANGUAGE sql。EXECUTE は service_role と所有者 postgres だけ。
 *      anon / authenticated が RPC で呼ぶと 42501 で、何も消えない
 *   B. ログイン失敗の記録: 保持期間の内の行は残り、外の行だけ消える。last_failed_at が無い行は updated_at で判定する。
 *      回数を数えている途中の行 (アプリの上限の内) は消えず、掃除のあとも回数の判定は同じ
 *   C. 数え済みの印の記録: 利用者を問わず、1 日より古い行だけが消える (claim しなくなった利用者の行も消える)
 *   D. cron.job にジョブが 1 つだけ、決めた名前・時刻 (UTC)・command で登録されている (二重登録しない)
 *   E. ジョブの command をそのまま (所有者 postgres として) 流しても動く
 *   F. migration を何度流しても同じ結果になる。同じ処理を呼ぶ既存のジョブは置き換わり、似た名前の別の関数を呼ぶジョブと無関係なジョブは残る
 *   G. cron.job が存在しない環境 (pg_cron が無い DB) では、ジョブの登録を飛ばして成功する
 *   H. rollback: ジョブと 2 つの関数が消える。何度流しても同じで、そのあとにもう一度 migration を流すと元の状態に戻る
 *
 * このテストが作った行 (ログイン失敗の記録・印の記録・利用者・テスト用のジョブ) は、終わりに必ず消す。
 * 掃除の関数は、このテストの行のほかに、ローカル / CI の DB にある保持期間を過ぎた行も消す (本番のジョブと同じ動き)。
 *
 * 既知の偶然: migration が登録する本物のジョブも、ローカル / CI のスタックで毎日 18:45 UTC (03:45 JST) に動く。
 * B / C の準備と確認がちょうどその 1 分間に重なると、準備した古い行が先に消され、関数が返す件数の確認が偶然落ちうる
 * (窓はごく短い。落ちたら再実行する)。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。本番には接続しない。
 * migration を流すのは、本番 (supabase db push) と同じ postgres ロールで行う (SET LOCAL ROLE postgres)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/login-failure-grant-claim-cleanup.test.ts
 */

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { LOGIN_FAILURE_RESET_MINUTES_MAX } from '../../../src/lib/auth/login-failures';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION = '20261011070000';
const NAME = 'schedule_login_failure_and_grant_claim_cleanup';
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`), 'utf8');
const ROLLBACK_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/rollbacks/${VERSION}_${NAME}.down.sql`), 'utf8');

const LOGIN_FN_NAME = 'cleanup_stale_auth_login_failures';
const CLAIM_FN_NAME = 'cleanup_expired_ai_usage_grant_claims';
const LOGIN_FN = `public.${LOGIN_FN_NAME}()`;
const CLAIM_FN = `public.${CLAIM_FN_NAME}()`;

/** migration が登録するジョブ。時刻は UTC (pg_cron は cron.timezone = GMT で解釈する) */
const JOB = {
  name: 'cleanup-stale-login-failures-and-grant-claims',
  schedule: '45 18 * * *',
  command: 'SELECT public.cleanup_stale_auth_login_failures(), public.cleanup_expired_ai_usage_grant_claims();',
};

const MINUTES_PER_DAY = 24 * 60;
/**
 * migration の stale_after (8 日) を分にしたもの = アプリの上限 (7 日) + 余裕 1 日。
 * migration の値とこの式が一致することは tests/login-failure-grant-claim-cleanup-contract.test.ts が突き合わせる
 */
const STALE_AFTER_MINUTES = LOGIN_FAILURE_RESET_MINUTES_MAX + MINUTES_PER_DAY;
/** migration の claim_retention (1 日) を分にしたもの */
const CLAIM_RETENTION_MINUTES = MINUTES_PER_DAY;
/**
 * 境界の前後に取る幅 (分)。準備から掃除の関数を呼ぶまでの時間 (数秒〜数十秒) より十分大きく、
 * 境界のすぐ内側の行は残り、すぐ外側の行は消えることを確かめられる
 */
const BOUNDARY_MARGIN_MINUTES = 5;

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const sr = client(serviceKey);
const anon = client(anonKey);

/** ローカルスタックの postgres-meta で SQL を流す (テストの準備・確認・migration の実行にだけ使う) */
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

/** 本番の migration と同じ postgres ロールで流す (このリクエストの中だけ) */
function asPostgres<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return pgQuery<T>(`SET LOCAL ROLE postgres;\n${sql}`);
}

/** SQL の文字列リテラルにする (テストが決めた固定の文字列だけを渡す) */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** PostgREST のスキーマキャッシュの更新待ち: 500ms × 20 回 = 最大 10 秒 */
const SCHEMA_CACHE_RETRIES = 20;
const SCHEMA_CACHE_WAIT_MS = 500;

/** migration / rollback を流した直後は、PostgREST が関数を見つけられない (PGRST202) ことがある。その場合だけ待ってやり直す */
async function withSchemaCacheRetry<T extends { error: PostgrestError | null }>(call: () => PromiseLike<T>): Promise<T> {
  let last = await call();
  for (let attempt = 0; attempt < SCHEMA_CACHE_RETRIES && last.error?.code === 'PGRST202'; attempt += 1) {
    await sleep(SCHEMA_CACHE_WAIT_MS);
    last = await call();
  }
  return last;
}

/** service_role で掃除の関数を呼び、消した行数を返す */
async function runCleanup(fnName: string): Promise<number> {
  const { data, error } = await withSchemaCacheRetry(() => sr.rpc(fnName));
  if (error) throw new Error(`${fnName}: ${error.code} ${error.message}`);
  expect(typeof data, `${fnName} は消した行数 (integer) を返す`).toBe('number');
  return data as number;
}

const RUN = randomBytes(4).toString('hex');
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];

async function createAuthUser(label: string, signIn: boolean): Promise<{ id: string; jwt: string }> {
  const email = `i1492-${label}-${RUN}@homegohan.test`;
  const { data, error } = await sr.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (!signIn) return { id: data.user.id, jwt: '' };
  // サインインは使い捨てのクライアントで行う (sr でサインインすると service_role でなくなる)
  const result = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (result.error || !result.data.session) throw new Error(`signIn ${label}: ${result.error?.message}`);
  return { id: data.user.id, jwt: result.data.session.access_token };
}

// ---------------------------------------------------------------
// ログイン失敗の記録の準備
// ---------------------------------------------------------------
interface LoginRow {
  label: string;
  /** 最後の失敗から何分前か。null は last_failed_at を入れない (ロックがあったころの関数で作られた行の形) */
  lastFailedAgo: number | null;
  /** updated_at を何分前にするか */
  updatedAgo: number;
  failureCount: number;
  /** 掃除のあとも残るべきか */
  kept: boolean;
}

const LOGIN_ROWS: LoginRow[] = [
  { label: 'recent', lastFailedAgo: 1, updatedAgo: 1, failureCount: 1, kept: true },
  { label: 'one-day', lastFailedAgo: MINUTES_PER_DAY, updatedAgo: MINUTES_PER_DAY, failureCount: 2, kept: true },
  {
    // アプリの上限 (7 日) の内側。環境変数を上限にしたときは、まだ数えている途中の行
    label: 'counting-at-app-max',
    lastFailedAgo: LOGIN_FAILURE_RESET_MINUTES_MAX - BOUNDARY_MARGIN_MINUTES,
    updatedAgo: LOGIN_FAILURE_RESET_MINUTES_MAX - BOUNDARY_MARGIN_MINUTES,
    failureCount: 4,
    kept: true,
  },
  {
    // アプリの上限は過ぎたが、保持期間 (8 日) の内側
    label: 'past-app-max-inside-retention',
    lastFailedAgo: STALE_AFTER_MINUTES - BOUNDARY_MARGIN_MINUTES,
    updatedAgo: STALE_AFTER_MINUTES - BOUNDARY_MARGIN_MINUTES,
    failureCount: 3,
    kept: true,
  },
  {
    label: 'just-past-retention',
    lastFailedAgo: STALE_AFTER_MINUTES + BOUNDARY_MARGIN_MINUTES,
    updatedAgo: STALE_AFTER_MINUTES + BOUNDARY_MARGIN_MINUTES,
    failureCount: 3,
    kept: false,
  },
  { label: 'thirty-days', lastFailedAgo: 30 * MINUTES_PER_DAY, updatedAgo: 30 * MINUTES_PER_DAY, failureCount: 9, kept: false },
  {
    // last_failed_at を優先する: updated_at が新しくても、最後の失敗が保持期間より古ければ消す
    label: 'stale-failure-fresh-update',
    lastFailedAgo: STALE_AFTER_MINUTES + BOUNDARY_MARGIN_MINUTES,
    updatedAgo: 1,
    failureCount: 1,
    kept: false,
  },
  { label: 'no-failure-time-fresh', lastFailedAgo: null, updatedAgo: 1, failureCount: 0, kept: true },
  {
    label: 'no-failure-time-stale',
    lastFailedAgo: null,
    updatedAgo: STALE_AFTER_MINUTES + BOUNDARY_MARGIN_MINUTES,
    failureCount: 0,
    kept: false,
  },
];

/** 行ごとのメールアドレス (アカウントは作らない。存在しないメールアドレスでの失敗の記録と同じ形) */
const loginEmail = (label: string) => `i1492-login-${label}-${RUN}@example.invalid`;
const ALL_LOGIN_EMAILS = LOGIN_ROWS.map((r) => loginEmail(r.label));

async function seedLoginRows(rows: readonly LoginRow[]): Promise<void> {
  const values = rows
    .map((r) => {
      const lastFailed = r.lastFailedAgo === null ? 'NULL' : `now() - make_interval(mins => ${r.lastFailedAgo})`;
      return `(public.auth_login_email_hash(${lit(loginEmail(r.label))}), ${r.failureCount}, ${lastFailed}, now() - make_interval(mins => ${r.updatedAgo}), now() - make_interval(mins => ${r.updatedAgo}))`;
    })
    .join(',\n');
  await asPostgres(`
    INSERT INTO public.auth_login_failures (email_hash, failure_count, last_failed_at, created_at, updated_at)
    VALUES ${values}
    ON CONFLICT (email_hash) DO UPDATE
      SET failure_count = EXCLUDED.failure_count,
          last_failed_at = EXCLUDED.last_failed_at,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at;
  `);
}

/** このテストのメールアドレスのうち、行が残っているもののラベル */
async function remainingLoginLabels(rows: readonly LoginRow[] = LOGIN_ROWS): Promise<string[]> {
  const hashes = await asPostgres<{ label: string; present: boolean }>(`
    SELECT x.label,
           EXISTS (SELECT 1 FROM public.auth_login_failures AS f WHERE f.email_hash = public.auth_login_email_hash(x.email)) AS present
      FROM (VALUES ${rows.map((r) => `(${lit(r.label)}, ${lit(loginEmail(r.label))})`).join(', ')}) AS x(label, email);
  `);
  return hashes
    .filter((h) => h.present)
    .map((h) => h.label)
    .sort();
}

async function deleteLoginRows(): Promise<void> {
  await asPostgres(`
    DELETE FROM public.auth_login_failures
     WHERE email_hash IN (SELECT public.auth_login_email_hash(e) FROM unnest(ARRAY[${ALL_LOGIN_EMAILS.map(lit).join(', ')}]::text[]) AS e);
  `);
}

/** アプリの上限の内側で、まだ数えている途中の行 */
const COUNTING_ROW: LoginRow = (() => {
  const row = LOGIN_ROWS.find((r) => r.label === 'counting-at-app-max');
  if (!row) throw new Error('LOGIN_ROWS に counting-at-app-max の行が無い');
  return row;
})();

const KEPT_LOGIN_LABELS = LOGIN_ROWS.filter((r) => r.kept).map((r) => r.label).sort();
const ALL_LOGIN_LABELS = LOGIN_ROWS.map((r) => r.label).sort();

// ---------------------------------------------------------------
// 数え済みの印の記録の準備
// ---------------------------------------------------------------
interface ClaimRow {
  label: string;
  /** 'active' = これからも claim する利用者 / 'gone' = もう claim しない利用者 */
  owner: 'active' | 'gone';
  claimedAgo: number;
  kept: boolean;
}

/** 印の有効期限 (10 分) の内側 */
const INSIDE_GRANT_MAX_AGE_MINUTES = 5;

const CLAIM_ROWS: ClaimRow[] = [
  { label: 'now', owner: 'active', claimedAgo: 0, kept: true },
  { label: 'inside-grant-max-age', owner: 'active', claimedAgo: INSIDE_GRANT_MAX_AGE_MINUTES, kept: true },
  { label: 'just-inside-retention', owner: 'active', claimedAgo: CLAIM_RETENTION_MINUTES - BOUNDARY_MARGIN_MINUTES, kept: true },
  { label: 'just-past-retention', owner: 'active', claimedAgo: CLAIM_RETENTION_MINUTES + BOUNDARY_MARGIN_MINUTES, kept: false },
  { label: 'three-days', owner: 'active', claimedAgo: 3 * MINUTES_PER_DAY, kept: false },
  // claim しなくなった利用者の行 (#1492 の前は、同じ利用者が次に claim するまで消えなかった)
  { label: 'gone-user-old', owner: 'gone', claimedAgo: 2 * MINUTES_PER_DAY, kept: false },
  { label: 'gone-user-fresh', owner: 'gone', claimedAgo: 1, kept: true },
];

const claimIds: Record<string, string> = {};
let activeUserId = '';
let goneUserId = '';
let authedJwt = '';

async function seedClaimRows(rows: readonly ClaimRow[]): Promise<void> {
  const values = rows
    .map((r) => {
      claimIds[r.label] = randomUUID();
      const owner = r.owner === 'active' ? activeUserId : goneUserId;
      return `(${lit(claimIds[r.label])}::uuid, ${lit(owner)}::uuid, now() - make_interval(mins => ${r.claimedAgo}))`;
    })
    .join(',\n');
  await asPostgres(`INSERT INTO public.ai_usage_grant_claims (grant_id, user_id, claimed_at) VALUES ${values};`);
}

async function remainingClaimLabels(rows: readonly ClaimRow[] = CLAIM_ROWS): Promise<string[]> {
  const ids = rows.map((r) => claimIds[r.label]).filter(Boolean);
  if (ids.length === 0) return [];
  const present = await asPostgres<{ grant_id: string }>(
    `SELECT grant_id::text AS grant_id FROM public.ai_usage_grant_claims WHERE grant_id IN (${ids.map((id) => `${lit(id)}::uuid`).join(', ')});`,
  );
  const presentIds = new Set(present.map((p) => p.grant_id));
  return rows
    .filter((r) => presentIds.has(claimIds[r.label]))
    .map((r) => r.label)
    .sort();
}

const KEPT_CLAIM_LABELS = CLAIM_ROWS.filter((r) => r.kept).map((r) => r.label).sort();
const ALL_CLAIM_LABELS = CLAIM_ROWS.map((r) => r.label).sort();

// ---------------------------------------------------------------
// cron.job の準備と後片付け
// ---------------------------------------------------------------
interface JobRow {
  jobid: number | string;
  jobname: string | null;
  schedule: string;
  command: string;
  active: boolean;
  username: string;
}

/** 1 月 1 日にしか動かない予定 (テスト中に pg_cron が実行することはない) */
const NEVER_SOON = '0 0 1 1 *';
const JOB_MARK = `I1492-TEST-${RUN}`;
const TEST_JOB_PREFIX = 'i1492-test-';

async function scheduleTestJob(name: string | null, command: string, schedule = NEVER_SOON): Promise<number> {
  const call = name
    ? `cron.schedule(${lit(name)}, ${lit(schedule)}, ${lit(command)})`
    : `cron.schedule(${lit(schedule)}, ${lit(command)})`;
  const rows = await asPostgres(`SELECT ${call} AS jobid;`);
  return Number(rows[0].jobid);
}

/** このテストが作ったジョブ (名前か command の印で判別) をすべて消す。前回の異常終了の残りも片付ける */
async function removeTestJobs(): Promise<void> {
  await asPostgres(`
    SELECT cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname LIKE ${lit(`${TEST_JOB_PREFIX}%`)} OR command LIKE '%I1492-TEST-%';
  `);
}

async function testJobIds(): Promise<number[]> {
  const rows = await asPostgres(`
    SELECT jobid FROM cron.job
    WHERE jobname LIKE ${lit(`${TEST_JOB_PREFIX}%`)} OR command LIKE '%I1492-TEST-%'
    ORDER BY jobid;
  `);
  return rows.map((r) => Number(r.jobid));
}

async function jobsByName(name: string): Promise<JobRow[]> {
  return asPostgres<JobRow>(`
    SELECT jobid, jobname, schedule, command, active, username FROM cron.job
    WHERE jobname = ${lit(name)}
    ORDER BY jobid;
  `);
}

/** command に関数名を単語として含むジョブ (migration が探すのと同じ条件) */
async function jobsCalling(fnName: string): Promise<JobRow[]> {
  return asPostgres<JobRow>(`
    SELECT jobid, jobname, schedule, command, active, username FROM cron.job
    WHERE command ~* ${lit(`[[:<:]]${fnName}[[:>:]]`)}
    ORDER BY jobid;
  `);
}

/** 本物のジョブが 1 つだけ、決めたとおりに登録されていて、2 つの関数を呼ぶジョブはそれだけ */
async function expectRealJobOnly(): Promise<void> {
  const rows = await jobsByName(JOB.name);
  expect(rows, `${JOB.name} が cron.job に 1 つだけ登録されていること`).toHaveLength(1);
  expect(rows[0].schedule).toBe(JOB.schedule);
  expect(rows[0].command).toBe(JOB.command);
  expect(rows[0].active).toBe(true);
  expect(rows[0].username).toBe('postgres');
  expect((await jobsCalling(LOGIN_FN_NAME)).map((j) => j.jobname)).toEqual([JOB.name]);
  expect((await jobsCalling(CLAIM_FN_NAME)).map((j) => j.jobname)).toEqual([JOB.name]);
}

/** テストが本物のジョブや関数を壊したら true。終わりに migration を流し直して戻す */
let realStateDisturbed = false;

beforeAll(async () => {
  const rows = await pgQuery<{ cron_job: string | null }>(`SELECT to_regclass('cron.job')::text AS cron_job;`);
  if (!rows[0]?.cron_job) {
    throw new Error('cron.job がありません。ローカル DB に pg_cron が入っていません (ベースラインの拡張を確認してください)。');
  }
  await removeTestJobs();
  await deleteLoginRows();
  activeUserId = (await createAuthUser('active', false)).id;
  goneUserId = (await createAuthUser('gone', false)).id;
  authedJwt = (await createAuthUser('authed', true)).jwt;
  await seedLoginRows(LOGIN_ROWS);
  await seedClaimRows(CLAIM_ROWS);
}, 60_000);

afterAll(async () => {
  await deleteLoginRows();
  const ids = Object.values(claimIds);
  if (ids.length > 0) {
    await asPostgres(`DELETE FROM public.ai_usage_grant_claims WHERE grant_id IN (${ids.map((id) => `${lit(id)}::uuid`).join(', ')});`);
  }
  await removeTestJobs();
  if (realStateDisturbed) {
    // rollback / 置き換えのテストの途中で失敗したときは、migration を流し直して本物の関数とジョブに戻す
    await asPostgres(MIGRATION_SQL);
  }
  for (const id of createdUserIds) {
    const { error } = await sr.auth.admin.deleteUser(id);
    if (error) console.error(`deleteUser ${id}: ${error.message}`);
  }
  expect(await testJobIds(), 'テスト用のジョブを消し切れていない').toEqual([]);
}, 120_000);

// ---------------------------------------------------------------
// A. 関数の属性と権限
// ---------------------------------------------------------------
describe('#1492 A. 関数の属性と権限', () => {
  for (const fn of [LOGIN_FN, CLAIM_FN]) {
    it(`${fn}: SECURITY INVOKER・search_path 空・LANGUAGE sql・VOLATILE・integer を返す (所有者 postgres)`, async () => {
      const rows = await pgQuery<{ lanname: string; prosecdef: boolean; provolatile: string; config: string; owner: string; result: string }>(`
        SELECT l.lanname, p.prosecdef, p.provolatile,
               coalesce(array_to_string(p.proconfig, ','), '') AS config,
               pg_get_userbyid(p.proowner)::text AS owner,
               pg_get_function_result(p.oid) AS result
          FROM pg_proc p
          JOIN pg_language l ON l.oid = p.prolang
         WHERE p.oid = to_regprocedure(${lit(fn)});
      `);
      expect(rows, `${fn} が無い`).toHaveLength(1);
      expect(rows[0].lanname).toBe('sql');
      expect(rows[0].prosecdef).toBe(false);
      expect(rows[0].provolatile).toBe('v');
      expect(rows[0].config).toBe('search_path=""');
      expect(rows[0].owner).toBe('postgres');
      expect(rows[0].result).toBe('integer');
    });

    it(`${fn}: EXECUTE は service_role と所有者 postgres だけ (PUBLIC / anon / authenticated には無い)`, async () => {
      const roles = await pgQuery<{ role: string; allowed: boolean }>(`
        SELECT r AS role, has_function_privilege(r, to_regprocedure(${lit(fn)})::oid, 'EXECUTE') AS allowed
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role', 'postgres']) AS r;
      `);
      expect(Object.fromEntries(roles.map((r) => [r.role, r.allowed]))).toEqual({
        anon: false,
        authenticated: false,
        service_role: true,
        postgres: true,
      });
      // anon / authenticated は PUBLIC から EXECUTE を継承する。PUBLIC への付与 (grantee = 0) が残っていないこと
      const publicGrants = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n
          FROM pg_proc p, aclexplode(p.proacl) a
         WHERE p.oid = to_regprocedure(${lit(fn)})::oid AND a.grantee = 0;
      `);
      expect(publicGrants[0].n, 'PUBLIC に EXECUTE が残っている').toBe(0);
    });
  }

  it('anon / authenticated が RPC で呼ぶと 42501 (permission denied) で、保持期間を過ぎた行も消えない', async () => {
    const asAuthed = client(anonKey, authedJwt);
    for (const fnName of [LOGIN_FN_NAME, CLAIM_FN_NAME]) {
      const byAnon = await withSchemaCacheRetry(() => anon.rpc(fnName));
      expect(byAnon.error?.code, `anon: ${fnName}`).toBe('42501');
      const byAuthed = await withSchemaCacheRetry(() => asAuthed.rpc(fnName));
      expect(byAuthed.error?.code, `authenticated: ${fnName}`).toBe('42501');
    }
    // 準備した行は、保持期間の外のものも含めて全部残っている
    expect(await remainingLoginLabels()).toEqual(ALL_LOGIN_LABELS);
    expect(await remainingClaimLabels()).toEqual(ALL_CLAIM_LABELS);
  });
});

// ---------------------------------------------------------------
// B. ログイン失敗の記録の掃除
// ---------------------------------------------------------------
describe('#1492 B. cleanup_stale_auth_login_failures は、保持期間 (8 日) を過ぎた行だけを消す', () => {
  it('掃除の前: 数えている途中の行 (アプリの上限の内) は、上限の間隔で数えた回数を持つ', async () => {
    const rows = await asPostgres<{ n: number }>(
      `SELECT public.auth_login_failure_count(${lit(loginEmail('counting-at-app-max'))}, ${LOGIN_FAILURE_RESET_MINUTES_MAX}) AS n;`,
    );
    expect(rows[0].n).toBe(COUNTING_ROW.failureCount);
  });

  it('保持期間の内の行は残り、外の行 (last_failed_at が無ければ updated_at で判定) だけが消える', async () => {
    const expectedDeleted = LOGIN_ROWS.filter((r) => !r.kept).length;
    const deleted = await runCleanup(LOGIN_FN_NAME);
    // ローカル DB にほかの古い行があれば、それも消える (本番のジョブと同じ動き)
    expect(deleted).toBeGreaterThanOrEqual(expectedDeleted);
    expect(await remainingLoginLabels()).toEqual(KEPT_LOGIN_LABELS);
  });

  it('掃除のあとも、数えている途中の行の回数の判定は変わらない', async () => {
    const rows = await asPostgres<{ n: number }>(
      `SELECT public.auth_login_failure_count(${lit(loginEmail('counting-at-app-max'))}, ${LOGIN_FAILURE_RESET_MINUTES_MAX}) AS n;`,
    );
    expect(rows[0].n).toBe(COUNTING_ROW.failureCount);
  });

  it('もう一度呼んでも、残った行は消えない (消すのは保持期間を過ぎた行だけ)', async () => {
    await runCleanup(LOGIN_FN_NAME);
    expect(await remainingLoginLabels()).toEqual(KEPT_LOGIN_LABELS);
  });
});

// ---------------------------------------------------------------
// C. 数え済みの印の記録の掃除
// ---------------------------------------------------------------
describe('#1492 C. cleanup_expired_ai_usage_grant_claims は、利用者を問わず、1 日を過ぎた行だけを消す', () => {
  it('保持期間の内の行 (印の有効期限の内を含む) は残り、外の行だけが消える。claim しなくなった利用者の古い行も消える', async () => {
    const expectedDeleted = CLAIM_ROWS.filter((r) => !r.kept).length;
    const deleted = await runCleanup(CLAIM_FN_NAME);
    expect(deleted).toBeGreaterThanOrEqual(expectedDeleted);
    expect(await remainingClaimLabels()).toEqual(KEPT_CLAIM_LABELS);
  });

  it('残った記録は、印の二度目の使用を引き続き断る (claim_ai_usage_grant が false を返す)', async () => {
    const { data, error } = await sr.rpc('claim_ai_usage_grant', {
      p_user_id: activeUserId,
      p_grant_id: claimIds['inside-grant-max-age'],
    });
    expect(error).toBeNull();
    expect(data).toBe(false);
  });
});

// ---------------------------------------------------------------
// D. ジョブの登録
// ---------------------------------------------------------------
describe('#1492 D. pg_cron にジョブが 1 つだけ登録されている', () => {
  it(`${JOB.name}: 時刻 ${JOB.schedule} (UTC)・command が決めたとおりで、有効。2 つの関数を呼ぶジョブはこれだけ (二重登録しない)`, async () => {
    await expectRealJobOnly();
  });

  it('時刻の読み替え: 03:45 JST (pg_cron は UTC = cron.timezone の GMT で解釈する)', async () => {
    const tz = await pgQuery<{ cron_timezone: string }>(`SELECT current_setting('cron.timezone') AS cron_timezone;`);
    expect(['GMT', 'UTC']).toContain(tz[0].cron_timezone);
    const [minute, hour] = JOB.schedule.split(' ').map(Number);
    const JST_OFFSET_HOURS = 9;
    const HOURS_PER_DAY = 24;
    expect({ hour: (hour + JST_OFFSET_HOURS) % HOURS_PER_DAY, minute }).toEqual({ hour: 3, minute: 45 });
  });
});

// ---------------------------------------------------------------
// E. ジョブの command をそのまま流す
// ---------------------------------------------------------------
describe('#1492 E. cron.job に登録された command を、所有者 postgres としてそのまま流しても動く', () => {
  it('古い行を足し直してから command を流すと、2 つの表の古い行が消え、内側の行は残る', async () => {
    await seedLoginRows(LOGIN_ROWS.filter((r) => !r.kept));
    await seedClaimRows(CLAIM_ROWS.filter((r) => !r.kept));
    expect(await remainingLoginLabels()).toEqual(ALL_LOGIN_LABELS);
    expect(await remainingClaimLabels()).toEqual(ALL_CLAIM_LABELS);

    const [registered] = await jobsByName(JOB.name);
    expect(registered.command).toBe(JOB.command);
    const result = await asPostgres<Record<string, number>>(registered.command);
    expect(result).toHaveLength(1);
    expect(Object.values(result[0]).every((n) => typeof n === 'number')).toBe(true);

    expect(await remainingLoginLabels()).toEqual(KEPT_LOGIN_LABELS);
    expect(await remainingClaimLabels()).toEqual(KEPT_CLAIM_LABELS);
  });
});

// ---------------------------------------------------------------
// F. 何度流しても同じ結果になる・既存のジョブの置き換え
// ---------------------------------------------------------------
describe('#1492 F. migration は何度流しても同じ結果になり、同じ処理を呼ぶ既存のジョブを置き換える', () => {
  const seeded: Record<string, number> = {};

  it('流す前の準備: 手作業で作られたような既存のジョブ (名前付き・名前なし・同じ名前の別の command) と、残るべきジョブを登録する', async () => {
    // 消えるべきもの
    seeded.oldLogin = await scheduleTestJob(`${TEST_JOB_PREFIX}${RUN}-old-login`, `SELECT 1 /* ${JOB_MARK} ${LOGIN_FN_NAME} */`);
    seeded.oldClaimUnnamed = await scheduleTestJob(null, `SELECT 1 /* ${JOB_MARK} public.${CLAIM_FN_NAME}() */`);
    // 同じ名前で、別の時刻・別の command のジョブ (pg_cron は同じ名前なら上書きする = 本物のジョブが壊れた状態)
    realStateDisturbed = true;
    await scheduleTestJob(JOB.name, `SELECT 1 /* ${JOB_MARK} wrong command under the real name */`, '0 0 2 1 *');
    // 残るべきもの
    seeded.lookalike = await scheduleTestJob(`${TEST_JOB_PREFIX}${RUN}-lookalike`, `SELECT 1 /* ${JOB_MARK} ${LOGIN_FN_NAME}_v2 */`);
    seeded.unrelated = await scheduleTestJob(`${TEST_JOB_PREFIX}${RUN}-unrelated`, `SELECT 1 /* ${JOB_MARK} unrelated */`);

    expect((await jobsByName(JOB.name)).map((j) => j.command)).toEqual([`SELECT 1 /* ${JOB_MARK} wrong command under the real name */`]);
  });

  it('migration を流すと、置き換えるべきジョブが消え、本物の 1 つだけが決めたとおりに登録される。似た名前・無関係なジョブは残る', async () => {
    await asPostgres(MIGRATION_SQL);
    realStateDisturbed = false;

    await expectRealJobOnly();
    expect(await testJobIds()).toEqual([seeded.lookalike, seeded.unrelated].sort((a, b) => a - b));
  });

  it('もう一度・もう一度流しても、同じ結果になる (ジョブが増えない)。関数の権限も同じまま', async () => {
    await asPostgres(MIGRATION_SQL);
    await asPostgres(MIGRATION_SQL);

    await expectRealJobOnly();
    expect(await testJobIds()).toEqual([seeded.lookalike, seeded.unrelated].sort((a, b) => a - b));
    for (const fn of [LOGIN_FN, CLAIM_FN]) {
      const roles = await pgQuery<{ role: string; allowed: boolean }>(`
        SELECT r AS role, has_function_privilege(r, to_regprocedure(${lit(fn)})::oid, 'EXECUTE') AS allowed
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r;
      `);
      expect(Object.fromEntries(roles.map((r) => [r.role, r.allowed])), fn).toEqual({ anon: false, authenticated: false, service_role: true });
    }
  });

  it('流し直した migration は、行を消さない (消すのはジョブが動いたときだけ)', async () => {
    await seedLoginRows(LOGIN_ROWS.filter((r) => !r.kept));
    await asPostgres(MIGRATION_SQL);
    expect(await remainingLoginLabels()).toEqual(ALL_LOGIN_LABELS);
    await runCleanup(LOGIN_FN_NAME);
    expect(await remainingLoginLabels()).toEqual(KEPT_LOGIN_LABELS);
  });
});

// ---------------------------------------------------------------
// G. pg_cron が無い環境
// ---------------------------------------------------------------
describe('#1492 G. cron.job が存在しない環境では、ジョブの登録を飛ばして成功する', () => {
  it('cron. の名前を存在しない名前に差し替えたコピーを流しても失敗しない。本物のジョブはそのまま', async () => {
    // 本物の pg_cron には触れず、cron.job / cron.unschedule / cron.schedule を存在しない名前に差し替えたコピーで確かめる
    const absent = MIGRATION_SQL.replace(/\bcron\./g, 'public.i1492_absent_');
    expect(absent).not.toMatch(/\bcron\./);
    expect(absent).toContain("to_regclass('public.i1492_absent_job')");

    // 対照: 存在を確かめずに読めば、同じ流し方でエラーになる (差し替えた名前が本当に存在しないことの確認)
    await expect(asPostgres('DO $i1492$ BEGIN PERFORM 1 FROM public.i1492_absent_job; END $i1492$;')).rejects.toThrow(/i1492_absent_job/);

    await asPostgres(absent);
    await expectRealJobOnly();
  });
});

// ---------------------------------------------------------------
// H. rollback (最後に流す。途中で失敗したら afterAll が migration を流し直す)
// ---------------------------------------------------------------
describe('#1492 H. rollback は、ジョブと 2 つの関数を消す', () => {
  async function functionsExist(): Promise<{ login: boolean; claim: boolean }> {
    const rows = await pgQuery<{ login: boolean; claim: boolean }>(
      `SELECT to_regprocedure(${lit(LOGIN_FN)}) IS NOT NULL AS login, to_regprocedure(${lit(CLAIM_FN)}) IS NOT NULL AS claim;`,
    );
    return rows[0];
  }

  it('rollback を流すと、ジョブが登録解除され、2 つの関数が消える。表の行は消えない', async () => {
    realStateDisturbed = true;
    await asPostgres(ROLLBACK_SQL);

    expect(await functionsExist()).toEqual({ login: false, claim: false });
    expect(await jobsByName(JOB.name)).toEqual([]);
    expect(await jobsCalling(LOGIN_FN_NAME)).toEqual([]);
    expect(await jobsCalling(CLAIM_FN_NAME)).toEqual([]);
    expect(await remainingLoginLabels()).toEqual(KEPT_LOGIN_LABELS);
    expect(await remainingClaimLabels()).toEqual(KEPT_CLAIM_LABELS);
  });

  it('rollback は何度流しても同じ結果になる (関数もジョブも無くても失敗しない)', async () => {
    await asPostgres(ROLLBACK_SQL);
    await asPostgres(ROLLBACK_SQL);
    expect(await functionsExist()).toEqual({ login: false, claim: false });
    expect(await jobsByName(JOB.name)).toEqual([]);
  });

  it('rollback のあとにもう一度 migration を流すと、元の状態 (ジョブ 1 つ・service_role だけの権限) に戻り、掃除が動く', async () => {
    await asPostgres(MIGRATION_SQL);
    realStateDisturbed = false;

    expect(await functionsExist()).toEqual({ login: true, claim: true });
    await expectRealJobOnly();
    await seedLoginRows(LOGIN_ROWS.filter((r) => !r.kept));
    await runCleanup(LOGIN_FN_NAME);
    expect(await remainingLoginLabels()).toEqual(KEPT_LOGIN_LABELS);
  });
});
