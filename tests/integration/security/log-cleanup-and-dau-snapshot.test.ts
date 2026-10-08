/**
 * #1125 / #1157 古いログの定期削除 (cleanup-old-app-logs) と、日次のアクティブ利用者の集計 (snapshot-daily-active-users) の回帰テスト
 *
 * migration 20261008140000_schedule_log_cleanup_and_dau_snapshot.sql が、次を行う。
 *   - pg_cron のジョブ cleanup-old-app-logs (毎日 03:15 JST = 18:15 UTC) が public.cleanup_old_logs() (app_logs の 30 日より古い行を削除) を呼ぶ
 *   - public.snapshot_daily_active_users(p_date) が、JST の日付 p_date の DAU / WAU / MAU を daily_active_users に upsert する。
 *     pg_cron のジョブ snapshot-daily-active-users (毎日 01:30 JST = 16:30 UTC) が前日 (JST) の分を呼ぶ。
 *     活動の元データは auth.sessions.created_at / auth.sessions.updated_at / auth.users.last_sign_in_at。
 *   - 2 つの関数の EXECUTE は service_role だけ (cleanup_old_logs は本番では PUBLIC / anon / authenticated にも付いていた)
 *
 * 確かめること:
 *   A. 関数の属性と権限: SECURITY DEFINER・search_path 空・LANGUAGE sql (列名の誤りが migration の適用時に分かる)。EXECUTE は service_role だけ
 *   B. cron.job に 2 つのジョブが、決めた名前・時刻 (UTC)・command で 1 つずつ登録されている (= reset のあとの状態)
 *   C. 集計の境界 (JST): 0:00 ちょうどはその日に含み、翌日の 0:00 ちょうどは含まない。WAU は 7 日間、MAU は 30 日間。
 *      3 つの元データのどれでも数える・重複は 1 人と数える・削除済みの利用者は数えない。再実行は上書き (1 行のまま)。
 *      境界は、利用者を 1 人ずつ外して件数の差を見る方法で、どの境界で間違えたかが分かるようにしている。
 *   D. 財務ダッシュボードの MAU カード (finance / admin ロール) が読む形のクエリで、集計した行が読める。ロールの無い人には見えない
 *   E. cleanup_old_logs: 30 日より古い行だけを消す。service_role 以外は 42501 で、何も消えない
 *   F. ジョブの command をそのまま (所有者 postgres として) 流しても動く。DAU のジョブは「実行時刻の JST の日付 - 1」を数える
 *   G. migration を何度流しても同じ結果になる。同じ処理を呼ぶ既存のジョブ (名前付き・名前なし・同じ名前の別の command) は置き換わり、
 *      似た名前の別の関数を呼ぶジョブと無関係なジョブは残る
 *   H. cron.job が存在しない環境 (pg_cron が無い DB) では、ジョブの登録を飛ばして成功する
 *   I. migration は、関数を作った直後に 1 回だけ試し実行する (日付は 2000-01-01。書いた行は取り消して、何も残さない)。
 *      関数が無い列を参照しているとき (作る時点でエラー) も、作れるが動かないとき (実行時のエラー) も、適用時に migration が止まり、
 *      関数もジョブも元のまま残る (cron の最初の実行まで気付かない、ということが無い)
 *   J. rollback (supabase/rollbacks/*.down.sql): 2 つのジョブと集計の関数が消え、cleanup_old_logs の権限が本番の元の状態に戻る。
 *      集計した行 (daily_active_users) は消えない。何度流しても同じで、そのあとにもう一度 migration を流すと元の状態に戻る
 *
 * 集計のテストは、本物の利用者が入り込まない昔の日付 (2021-03-15 JST) を使い、auth.sessions に時刻を決めた行を直接入れる。
 * 最初に何も入れない状態で集計して基準の件数を取り、期待値は「基準 + このテストが入れた利用者の分」で比べる。
 * このテストが作った行 (利用者・セッション・集計の行・ログ・テスト用のジョブ) は、終わりに必ず消す。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。本番には接続しない。
 * migration を流すのは、本番 (supabase db push) と同じ postgres ロールで行う (SET LOCAL ROLE postgres)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/log-cleanup-and-dau-snapshot.test.ts
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
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

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION = '20261008140000';
const NAME = 'schedule_log_cleanup_and_dau_snapshot';
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`), 'utf8');
const ROLLBACK_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/rollbacks/${VERSION}_${NAME}.down.sql`), 'utf8');

const SNAPSHOT_FN = 'public.snapshot_daily_active_users(date)';
const CLEANUP_FN = 'public.cleanup_old_logs()';

/** migration が登録するジョブ。時刻は UTC (pg_cron は cron.timezone = GMT で解釈する) */
const CLEANUP_JOB = {
  name: 'cleanup-old-app-logs',
  schedule: '15 18 * * *',
  command: 'SELECT public.cleanup_old_logs();',
};
const DAU_JOB = {
  name: 'snapshot-daily-active-users',
  schedule: '30 16 * * *',
  command: "SELECT public.snapshot_daily_active_users((now() AT TIME ZONE 'Asia/Tokyo')::date - 1);",
};

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

/**
 * migration を流した直後は、PostgREST が関数を見つけられない (PGRST202) ことがある (スキーマキャッシュの更新待ち)。
 * その場合だけ、少し待ってやり直す。関数が本当に無いときは、数秒後に同じエラーで返る。
 */
async function withSchemaCacheRetry<T extends { error: PostgrestError | null }>(call: () => PromiseLike<T>): Promise<T> {
  let last = await call();
  for (let attempt = 0; attempt < 6 && last.error?.code === 'PGRST202'; attempt += 1) {
    await sleep(500);
    last = await call();
  }
  return last;
}

interface SnapshotRow {
  snapshot_date: string;
  dau: number;
  wau: number;
  mau: number;
}

/** service_role で snapshot_daily_active_users を呼ぶ (1 行を返す) */
async function snapshot(date: string): Promise<SnapshotRow> {
  const { data, error } = await withSchemaCacheRetry(() => sr.rpc('snapshot_daily_active_users', { p_date: date }));
  if (error) throw new Error(`snapshot_daily_active_users(${date}): ${error.code} ${error.message}`);
  const rows = data as SnapshotRow[];
  expect(rows, `snapshot_daily_active_users(${date}) は 1 行を返す`).toHaveLength(1);
  return rows[0];
}

const RUN = randomBytes(4).toString('hex');
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];

async function createAuthUser(label: string, roles?: string[]): Promise<{ id: string; email: string; jwt: string }> {
  const email = `t24-${label}-${RUN}@homegohan.test`;
  const { data, error } = await sr.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (roles) {
    // user_profiles の必須列は nickname / age_group / gender
    const { error: profileError } = await sr
      .from('user_profiles')
      .upsert({ id: data.user.id, nickname: `t24-${label}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' });
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
    // サインインは使い捨てのクライアントで行う (sr でサインインすると service_role でなくなる)
    const signIn = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
    if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
    return { id: data.user.id, email, jwt: signIn.data.session.access_token };
  }
  return { id: data.user.id, email, jwt: '' };
}

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
  database: string;
}

/** 1 月 1 日にしか動かない予定 (テスト中に pg_cron が実行することはない) */
const NEVER_SOON = '0 0 1 1 *';
const JOB_MARK = `T24-TEST-${RUN}`;

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
    WHERE jobname LIKE 't24-test-%' OR command LIKE '%T24-TEST-%';
  `);
}

async function testJobIds(): Promise<number[]> {
  const rows = await asPostgres(`
    SELECT jobid FROM cron.job
    WHERE jobname LIKE 't24-test-%' OR command LIKE '%T24-TEST-%'
    ORDER BY jobid;
  `);
  return rows.map((r) => Number(r.jobid));
}

async function jobsByName(name: string): Promise<JobRow[]> {
  return asPostgres<JobRow>(`
    SELECT jobid, jobname, schedule, command, active, username, database FROM cron.job
    WHERE jobname = ${lit(name)}
    ORDER BY jobid;
  `);
}

/** command に関数名を単語として含むジョブ (migration が探すのと同じ条件) */
async function jobsCalling(fnName: string): Promise<JobRow[]> {
  return asPostgres<JobRow>(`
    SELECT jobid, jobname, schedule, command, active, username, database FROM cron.job
    WHERE command ~* ${lit(`[[:<:]]${fnName}[[:>:]]`)}
    ORDER BY jobid;
  `);
}

/** daily_active_users の (plan_type = all, plan_key = 空) の行がある日付 */
async function allSnapshotDates(): Promise<string[]> {
  const { data, error } = await sr.from('daily_active_users').select('date').eq('plan_type', 'all').eq('plan_key', '');
  if (error) throw new Error(`daily_active_users の確認に失敗: ${error.message}`);
  return (data ?? []).map((row) => row.date as string);
}

/** テストが本物のジョブ (cleanup-old-app-logs) を壊したら true。終わりに migration を流し直して戻す */
let realJobDisturbed = false;

// ---------------------------------------------------------------
// 利用者・日付の準備
// ---------------------------------------------------------------
/** 集計する日 D (JST)。本物の利用者の活動が入り込まない昔の日付 */
const BASE = '2021-03-15';
const NEXT = '2021-03-16';
/** F: ジョブの command を流すときの「実行時刻」(UTC)。JST では 2021-06-11 01:30 なので、数える日は 2021-06-10 */
const RUN_AT_UTC = '2021-06-10T16:30:00Z';
const RUN_AT_TARGET_DATE = '2021-06-10';
/** 数える日を間違えたとき (UTC の日付 - 1 / JST の今日) に行ができる、隣の日。前もって空にして、終わりにも消す */
const RUN_AT_NEIGHBOR_DATES = ['2021-06-09', '2021-06-11'];
/** I: migration の適用時の試し実行が使う日付 (本物の行と重ならない昔の日付)。試し実行の行は取り消されて残らない */
const TRIAL_DATE = '2000-01-01';
const SNAPSHOT_DATES = [BASE, NEXT, TRIAL_DATE, RUN_AT_TARGET_DATE, ...RUN_AT_NEIGHBOR_DATES];

/** BASE から days 日ずらした JST の日付に、時刻 time (HH:MM:SS[.ffffff]) を付けた、SQL で解釈できる文字列 (+09 付き) */
function jst(days: number, time: string): string {
  const d = new Date(`${BASE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.toISOString().slice(0, 10)} ${time}+09`;
}

type Flags = [dau: number, wau: number, mau: number];

interface Scenario {
  label: string;
  sessions: Array<{ created: string; updated?: string }>;
  lastSignIn?: string;
  softDeleted?: boolean;
  /** D の [DAU, WAU, MAU] に数えるなら 1 */
  day: Flags;
  /** D+1 の [DAU, WAU, MAU] に数えるなら 1 */
  nextDay: Flags;
}

/*
 * D の範囲   : DAU = [D 0:00, D+1 0:00) / WAU = [D-6 0:00, D+1 0:00) / MAU = [D-29 0:00, D+1 0:00)   (すべて JST)
 * D+1 の範囲 : DAU = [D+1 0:00, D+2 0:00) / WAU = [D-5 0:00, D+2 0:00) / MAU = [D-28 0:00, D+2 0:00)
 */
const SCENARIOS: Scenario[] = [
  { label: 'D の 0:00:00 ちょうど (含む)', sessions: [{ created: jst(0, '00:00:00') }], day: [1, 1, 1], nextDay: [0, 1, 1] },
  { label: 'D の 23:59:59.999999 (含む)', sessions: [{ created: jst(0, '23:59:59.999999') }], day: [1, 1, 1], nextDay: [0, 1, 1] },
  { label: 'D+1 の 0:00:00 ちょうど (D には含まない、D+1 には含む)', sessions: [{ created: jst(1, '00:00:00') }], day: [0, 0, 0], nextDay: [1, 1, 1] },
  { label: 'D-1 の 23:59:59.999999 (DAU に含まない、WAU に含む)', sessions: [{ created: jst(-1, '23:59:59.999999') }], day: [0, 1, 1], nextDay: [0, 1, 1] },
  { label: 'D-6 の 0:00:00 ちょうど (WAU の最初の瞬間。含む)', sessions: [{ created: jst(-6, '00:00:00') }], day: [0, 1, 1], nextDay: [0, 0, 1] },
  { label: 'D-7 の 23:59:59.999999 (WAU の 1 瞬前。含まない、MAU には含む)', sessions: [{ created: jst(-7, '23:59:59.999999') }], day: [0, 0, 1], nextDay: [0, 0, 1] },
  { label: 'D-29 の 0:00:00 ちょうど (MAU の最初の瞬間。含む)', sessions: [{ created: jst(-29, '00:00:00') }], day: [0, 0, 1], nextDay: [0, 0, 0] },
  { label: 'D-30 の 23:59:59.999999 (MAU の 1 瞬前。含まない)', sessions: [{ created: jst(-30, '23:59:59.999999') }], day: [0, 0, 0], nextDay: [0, 0, 0] },
  {
    label: 'セッションの updated_at だけが D の中 (作ったのは 100 日前)',
    sessions: [{ created: jst(-100, '12:00:00'), updated: jst(0, '12:00:00') }],
    day: [1, 1, 1],
    nextDay: [0, 1, 1],
  },
  {
    // 集計は翌日 01:30 JST に行うので、D の夜に使った人が D+1 の 0:00〜01:30 にも使うと、updated_at は D+1 に上書きされる。
    // それでも、セッションを作った時刻 (created_at) が D の中なら、D には数える (created_at の元データが無いとここで落ちる)
    label: 'セッションの created_at だけが D の中 (作ったあと D+1 の 00:30 に更新された)',
    sessions: [{ created: jst(0, '10:00:00'), updated: jst(1, '00:30:00') }],
    day: [1, 1, 1],
    nextDay: [1, 1, 1],
  },
  { label: 'users.last_sign_in_at だけが D の中 (セッションなし)', sessions: [], lastSignIn: jst(0, '09:30:00'), day: [1, 1, 1], nextDay: [0, 1, 1] },
  {
    label: '3 つの元データがすべて D の中で、セッションも 2 つ (1 人と数える)',
    sessions: [
      { created: jst(0, '08:00:00'), updated: jst(0, '09:00:00') },
      { created: jst(0, '20:00:00'), updated: jst(0, '21:00:00') },
    ],
    lastSignIn: jst(0, '20:00:00'),
    day: [1, 1, 1],
    nextDay: [0, 1, 1],
  },
  {
    label: '削除済み (deleted_at あり) の利用者は、D の中に活動があっても数えない',
    sessions: [{ created: jst(0, '10:00:00') }],
    softDeleted: true,
    day: [0, 0, 0],
    nextDay: [0, 0, 0],
  },
  {
    label: '3 日にわたって活動 (D / D-3 / D-20)。どの範囲でも 1 人',
    sessions: [{ created: jst(0, '11:00:00') }, { created: jst(-3, '11:00:00') }, { created: jst(-20, '11:00:00') }],
    day: [1, 1, 1],
    nextDay: [0, 1, 1],
  },
  { label: '活動なし', sessions: [], day: [0, 0, 0], nextDay: [0, 0, 0] },
];

const sum = (list: Flags[]): Flags => [
  list.reduce((total, f) => total + f[0], 0),
  list.reduce((total, f) => total + f[1], 0),
  list.reduce((total, f) => total + f[2], 0),
];

// 表の書き間違いに気付くための確認 (手で数えた値): D は 7 / 9 / 11、D+1 は 2 / 9 / 11
const EXPECTED_TOTALS_DAY = sum(SCENARIOS.map((s) => s.day));
const EXPECTED_TOTALS_NEXT = sum(SCENARIOS.map((s) => s.nextDay));

let authed: { id: string; email: string; jwt: string };
let finance: { id: string; email: string; jwt: string };
const scenarioUserIds: string[] = [];
/** 何も入れない状態の件数 (基準) */
let baseDay: SnapshotRow;
let baseNext: SnapshotRow;
/** 表の利用者をすべて入れた状態の件数 (境界のテストは、ここから 1 人ずつ外した差を見る) */
let fullDay: SnapshotRow;
let fullNext: SnapshotRow;

async function seedScenario(userId: string, s: Scenario): Promise<void> {
  const statements: string[] = [];
  for (const session of s.sessions) {
    statements.push(
      `INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), ${lit(userId)}, ${lit(session.created)}, ${lit(session.updated ?? session.created)});`,
    );
  }
  if (s.lastSignIn) {
    statements.push(`UPDATE auth.users SET last_sign_in_at = ${lit(s.lastSignIn)} WHERE id = ${lit(userId)};`);
  }
  if (s.softDeleted) {
    statements.push(`UPDATE auth.users SET deleted_at = now() WHERE id = ${lit(userId)};`);
  }
  if (statements.length > 0) await asPostgres(statements.join('\n'));
}

async function setDeleted(userId: string, deleted: boolean): Promise<void> {
  await asPostgres(`UPDATE auth.users SET deleted_at = ${deleted ? 'now()' : 'NULL'} WHERE id = ${lit(userId)};`);
}

const LOG_MARK = `T24-CLEANUP-${RUN}`;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** app_logs に入れる行。kept = cleanup_old_logs のあとも残るべきか (消すのは created_at が 30 日より古いものだけ) */
const LOG_ROWS = [
  { label: 'now', ageMs: 0, kept: true },
  { label: '1d', ageMs: DAY, kept: true },
  { label: '29d', ageMs: 29 * DAY, kept: true },
  { label: '29d23h55m', ageMs: 29 * DAY + 23 * HOUR + 55 * MINUTE, kept: true },
  { label: '30d5m', ageMs: 30 * DAY + 5 * MINUTE, kept: false },
  { label: '31d', ageMs: 31 * DAY, kept: false },
  { label: '365d', ageMs: 365 * DAY, kept: false },
];

async function seedLogs(): Promise<void> {
  const now = Date.now();
  const { error } = await sr.from('app_logs').insert(
    LOG_ROWS.map((r) => ({
      source: LOG_MARK,
      message: r.label,
      level: 'info',
      created_at: new Date(now - r.ageMs).toISOString(),
    })),
  );
  if (error) throw new Error(`app_logs の準備に失敗: ${error.message}`);
}

async function remainingLogLabels(): Promise<string[]> {
  const { data, error } = await sr.from('app_logs').select('message').eq('source', LOG_MARK);
  if (error) throw new Error(`app_logs の確認に失敗: ${error.message}`);
  return (data ?? []).map((r) => r.message as string).sort();
}

const KEPT_LABELS = LOG_ROWS.filter((r) => r.kept).map((r) => r.label).sort();
const ALL_LABELS = LOG_ROWS.map((r) => r.label).sort();

beforeAll(async () => {
  const rows = await pgQuery<{ cron_job: string | null }>(`SELECT to_regclass('cron.job')::text AS cron_job;`);
  if (!rows[0]?.cron_job) {
    throw new Error('cron.job がありません。ローカル DB に pg_cron が入っていません (ベースラインの拡張を確認してください)。');
  }
  await removeTestJobs();
  authed = await createAuthUser('authed', []);
  finance = await createAuthUser('finance', ['finance']);
}, 60_000);

afterAll(async () => {
  // 昔の日付の集計の行・テスト用のログ・テスト用のジョブ・利用者を消す (セッションは利用者の削除で一緒に消える)
  await sr.from('daily_active_users').delete().in('date', SNAPSHOT_DATES).eq('plan_type', 'all').eq('plan_key', '');
  await sr.from('app_logs').delete().eq('source', LOG_MARK);
  await removeTestJobs();
  if (realJobDisturbed) {
    // 本物のジョブと同じ名前のジョブを置き換えるテストの途中で失敗したときは、migration を流し直して本物のジョブに戻す
    await asPostgres(MIGRATION_SQL);
  }
  if (createdUserIds.length > 0) {
    await asPostgres(`DELETE FROM auth.sessions WHERE user_id IN (${createdUserIds.map(lit).join(', ')});`);
    await sr.from('user_profiles').delete().in('id', createdUserIds);
    for (const id of createdUserIds) {
      const { error } = await sr.auth.admin.deleteUser(id);
      if (error) console.error(`deleteUser ${id}: ${error.message}`);
    }
  }
  expect(await testJobIds(), 'テスト用のジョブを消し切れていない').toEqual([]);
}, 120_000);

// ---------------------------------------------------------------
// A. 関数の属性と権限
// ---------------------------------------------------------------
describe('#1125 A. 関数の属性と権限', () => {
  it('snapshot_daily_active_users は SECURITY DEFINER・search_path 空・LANGUAGE sql・VOLATILE (所有者 postgres)', async () => {
    const rows = await pgQuery<{ lanname: string; prosecdef: boolean; provolatile: string; config: string; owner: string }>(`
      SELECT l.lanname, p.prosecdef, p.provolatile,
             coalesce(array_to_string(p.proconfig, ','), '') AS config,
             pg_get_userbyid(p.proowner)::text AS owner
        FROM pg_proc p
        JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = to_regprocedure(${lit(SNAPSHOT_FN)});
    `);
    expect(rows, 'snapshot_daily_active_users(date) が無い').toHaveLength(1);
    // LANGUAGE sql は、列名の誤りや無い列の参照を CREATE FUNCTION の時点 (= migration の適用時) で検出する。
    // plpgsql に書き換えると、最初の cron の実行 (翌日 01:30 JST) まで気付けなくなる
    expect(rows[0].lanname).toBe('sql');
    expect(rows[0].prosecdef).toBe(true);
    expect(rows[0].provolatile).toBe('v');
    expect(rows[0].config).toBe('search_path=""');
    expect(rows[0].owner).toBe('postgres');
  });

  for (const fn of [SNAPSHOT_FN, CLEANUP_FN]) {
    it(`${fn}: EXECUTE は service_role だけ (PUBLIC / anon / authenticated には無い)`, async () => {
      const exists = await pgQuery<{ ok: boolean }>(`SELECT to_regprocedure(${lit(fn)}) IS NOT NULL AS ok;`);
      expect(exists[0].ok, `${fn} が無い`).toBe(true);

      const roles = await pgQuery<{ role: string; allowed: boolean }>(`
        SELECT r AS role, has_function_privilege(r, to_regprocedure(${lit(fn)})::oid, 'EXECUTE') AS allowed
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r;
      `);
      const allowed = Object.fromEntries(roles.map((r) => [r.role, r.allowed]));
      expect(allowed).toEqual({ anon: false, authenticated: false, service_role: true });

      // anon / authenticated は PUBLIC から EXECUTE を継承する。PUBLIC への付与 (grantee = 0) が残っていないこと
      const publicGrants = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n
          FROM pg_proc p, aclexplode(p.proacl) a
         WHERE p.oid = to_regprocedure(${lit(fn)})::oid AND a.grantee = 0;
      `);
      expect(publicGrants[0].n, 'PUBLIC に EXECUTE が残っている').toBe(0);
    });
  }

  it('anon / authenticated が RPC で呼ぶと 42501 (permission denied)。service_role は呼べる', async () => {
    const asAuthed = client(anonKey, authed.jwt);

    const anonSnapshot = await withSchemaCacheRetry(() => anon.rpc('snapshot_daily_active_users', { p_date: BASE }));
    expect(anonSnapshot.error?.code).toBe('42501');
    const authedSnapshot = await withSchemaCacheRetry(() => asAuthed.rpc('snapshot_daily_active_users', { p_date: BASE }));
    expect(authedSnapshot.error?.code).toBe('42501');

    const anonCleanup = await withSchemaCacheRetry(() => anon.rpc('cleanup_old_logs'));
    expect(anonCleanup.error?.code).toBe('42501');
    const authedCleanup = await withSchemaCacheRetry(() => asAuthed.rpc('cleanup_old_logs'));
    expect(authedCleanup.error?.code).toBe('42501');

    // service_role は呼べる (snapshot は E のあとの C でも呼ぶ。ここでは権限だけを見る)
    const srSnapshot = await withSchemaCacheRetry(() => sr.rpc('snapshot_daily_active_users', { p_date: BASE }));
    expect(srSnapshot.error).toBeNull();
  });
});

// ---------------------------------------------------------------
// B. ジョブの登録 (reset のあとの状態)
// ---------------------------------------------------------------
describe('#1157 B. pg_cron に 2 つのジョブが登録されている', () => {
  for (const job of [CLEANUP_JOB, DAU_JOB]) {
    it(`${job.name}: 時刻 ${job.schedule} (UTC)・command が決めたとおりで、有効`, async () => {
      const rows = await jobsByName(job.name);
      expect(rows, `${job.name} が cron.job に 1 つだけ登録されていること`).toHaveLength(1);
      expect(rows[0].schedule).toBe(job.schedule);
      expect(rows[0].command).toBe(job.command);
      expect(rows[0].active).toBe(true);
      // 本番の migration と同じく postgres が作ったジョブ (所有者 postgres として関数を呼ぶ)
      expect(rows[0].username).toBe('postgres');
    });
  }

  it('時刻の読み替え: cleanup は 03:15 JST、snapshot は 01:30 JST (pg_cron は UTC = cron.timezone の GMT で解釈する)', async () => {
    const tz = await pgQuery<{ cron_timezone: string }>(`SELECT current_setting('cron.timezone') AS cron_timezone;`);
    expect(['GMT', 'UTC']).toContain(tz[0].cron_timezone);

    const toJst = (schedule: string) => {
      const [minute, hour] = schedule.split(' ');
      return { hour: (Number(hour) + 9) % 24, minute: Number(minute) };
    };
    expect(toJst(CLEANUP_JOB.schedule)).toEqual({ hour: 3, minute: 15 });
    expect(toJst(DAU_JOB.schedule)).toEqual({ hour: 1, minute: 30 });
  });

  it('同じ関数を呼ぶジョブは、1 つずつしか無い (二重に登録されていない)', async () => {
    const cleanup = await jobsCalling('cleanup_old_logs');
    expect(cleanup.map((j) => j.jobname)).toEqual([CLEANUP_JOB.name]);
    const dau = await jobsCalling('snapshot_daily_active_users');
    expect(dau.map((j) => j.jobname)).toEqual([DAU_JOB.name]);
  });

});

// ---------------------------------------------------------------
// C. 日次のアクティブ利用者の集計 (JST の境界)
// ---------------------------------------------------------------
describe('#1125 C. snapshot_daily_active_users: JST の境界・元データ・上書き', () => {
  beforeAll(async () => {
    // 何も入れない状態の件数 (基準)。期待値は「基準 + このテストが入れた利用者の分」で比べる
    baseDay = await snapshot(BASE);
    baseNext = await snapshot(NEXT);

    for (const [index, scenario] of SCENARIOS.entries()) {
      const user = await createAuthUser(`dau-${index}`);
      scenarioUserIds.push(user.id);
      await seedScenario(user.id, scenario);
    }

    fullDay = await snapshot(BASE);
    fullNext = await snapshot(NEXT);
  }, 120_000);

  it('表の手計算: D は DAU 7 / WAU 9 / MAU 11、D+1 は DAU 2 / WAU 9 / MAU 11 (DAU <= WAU <= MAU)', () => {
    expect(EXPECTED_TOTALS_DAY).toEqual([7, 9, 11]);
    expect(EXPECTED_TOTALS_NEXT).toEqual([2, 9, 11]);
  });

  it('D (2021-03-15 JST) の DAU / WAU / MAU: 基準 + 入れた利用者の分。返す行と表の行が一致する', async () => {
    const row = await snapshot(BASE);
    expect(row.snapshot_date).toBe(BASE);
    expect([row.dau, row.wau, row.mau]).toEqual([
      baseDay.dau + EXPECTED_TOTALS_DAY[0],
      baseDay.wau + EXPECTED_TOTALS_DAY[1],
      baseDay.mau + EXPECTED_TOTALS_DAY[2],
    ]);

    // daily_active_users には、(D, 'all', '') の 1 行だけが入っていて、返した値と同じ
    const { data, error } = await sr.from('daily_active_users').select('date, plan_type, plan_key, dau, wau, mau').eq('date', BASE);
    expect(error).toBeNull();
    expect(data).toEqual([{ date: BASE, plan_type: 'all', plan_key: '', dau: row.dau, wau: row.wau, mau: row.mau }]);
  });

  it('D+1 (2021-03-16 JST) の DAU / WAU / MAU: 窓が 1 日ずれる (D+1 の 0:00 ちょうどは D+1 に含まれ、D の最後の瞬間は含まれない)', async () => {
    const row = await snapshot(NEXT);
    expect(row.snapshot_date).toBe(NEXT);
    expect([row.dau, row.wau, row.mau]).toEqual([
      baseNext.dau + EXPECTED_TOTALS_NEXT[0],
      baseNext.wau + EXPECTED_TOTALS_NEXT[1],
      baseNext.mau + EXPECTED_TOTALS_NEXT[2],
    ]);
  });

  // 利用者を 1 人ずつ「削除済み」にして集計し直し、件数の差が表の値と一致することを確かめる。
  // 境界の間違いがあれば、どの境界かが、このテストの名前で分かる
  for (const [index, scenario] of SCENARIOS.entries()) {
    if (scenario.softDeleted) continue;
    it(`境界 ${index + 1}: ${scenario.label}`, async () => {
      const userId = scenarioUserIds[index];
      await setDeleted(userId, true);
      try {
        const withoutDay = await snapshot(BASE);
        const withoutNext = await snapshot(NEXT);
        expect([fullDay.dau - withoutDay.dau, fullDay.wau - withoutDay.wau, fullDay.mau - withoutDay.mau], 'D の [DAU, WAU, MAU] への寄与').toEqual(
          scenario.day,
        );
        expect(
          [fullNext.dau - withoutNext.dau, fullNext.wau - withoutNext.wau, fullNext.mau - withoutNext.mau],
          'D+1 の [DAU, WAU, MAU] への寄与',
        ).toEqual(scenario.nextDay);
      } finally {
        await setDeleted(userId, false);
      }
    });
  }

  it('削除済み (deleted_at あり) の利用者だけは、deleted_at を外すと数えられる (除外の理由が deleted_at であること)', async () => {
    const index = SCENARIOS.findIndex((s) => s.softDeleted);
    expect(index).toBeGreaterThanOrEqual(0);
    const userId = scenarioUserIds[index];
    const before = await snapshot(BASE);
    await setDeleted(userId, false);
    try {
      const after = await snapshot(BASE);
      expect([after.dau - before.dau, after.wau - before.wau, after.mau - before.mau]).toEqual([1, 1, 1]);
    } finally {
      await setDeleted(userId, true);
    }
  });

  it('再実行は上書き: 行は 1 つのまま、数字が新しくなり、computed_at が進む。ほかの日の行は変わらない', async () => {
    const before = await snapshot(BASE);
    const beforeRows = await sr
      .from('daily_active_users')
      .select('date, plan_type, plan_key, dau, wau, mau, computed_at')
      .in('date', [BASE, NEXT])
      .order('date');
    expect(beforeRows.error).toBeNull();
    const nextBefore = beforeRows.data?.find((r) => r.date === NEXT);

    // D の中に活動のある利用者を 1 人増やして、もう一度集計する
    const extra = await createAuthUser('dau-extra');
    await asPostgres(
      `INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (gen_random_uuid(), ${lit(extra.id)}, ${lit(jst(0, '13:00:00'))}, ${lit(jst(0, '13:00:00'))});`,
    );
    const after = await snapshot(BASE);
    expect([after.dau, after.wau, after.mau]).toEqual([before.dau + 1, before.wau + 1, before.mau + 1]);

    const rows = await sr.from('daily_active_users').select('date, plan_type, plan_key, dau, wau, mau, computed_at').in('date', [BASE, NEXT]).order('date');
    expect(rows.error).toBeNull();
    const dayRows = rows.data?.filter((r) => r.date === BASE) ?? [];
    expect(dayRows, 'D の行は 1 つのまま').toHaveLength(1);
    expect(dayRows[0]).toMatchObject({ plan_type: 'all', plan_key: '', dau: after.dau, wau: after.wau, mau: after.mau });
    const beforeDay = beforeRows.data?.find((r) => r.date === BASE);
    expect(new Date(dayRows[0].computed_at as string).getTime()).toBeGreaterThan(new Date(beforeDay?.computed_at as string).getTime());

    // D+1 の行は触っていない
    const nextAfter = rows.data?.find((r) => r.date === NEXT);
    expect(nextAfter).toEqual(nextBefore);
  });

  it('p_date が NULL なら、黙って何もせずにエラーになる (日付の NOT NULL 制約。23502)', async () => {
    const { error } = await withSchemaCacheRetry(() => sr.rpc('snapshot_daily_active_users', { p_date: null }));
    expect(error?.code).toBe('23502');
  });
});

// ---------------------------------------------------------------
// D. 財務ダッシュボードの MAU カード
// ---------------------------------------------------------------
describe('#1125 D. 財務ダッシュボードの MAU カードが読む形のクエリで、集計した行が読める', () => {
  /** src/app/api/admin/finance/dashboard/route.ts の MAU 取得と同じ絞り込み (ここでは日付も指定して、他の行と区別する) */
  const mauQuery = (c: SupabaseClient) =>
    c.from('daily_active_users').select('mau').eq('plan_type', 'all').eq('plan_key', '').eq('date', BASE);

  it('finance ロールの利用者には、集計した MAU が見える。ロールの無い利用者と anon には見えない (RLS)', async () => {
    const row = await snapshot(BASE);

    const financeResult = await mauQuery(client(anonKey, finance.jwt));
    expect(financeResult.error).toBeNull();
    expect(financeResult.data).toEqual([{ mau: row.mau }]);

    const plainResult = await mauQuery(client(anonKey, authed.jwt));
    expect(plainResult.error).toBeNull();
    expect(plainResult.data).toEqual([]);

    const anonResult = await mauQuery(anon);
    expect(anonResult.data ?? []).toEqual([]);
  });

  it('ロールの無い利用者は、集計の表に書き込めない (関数を通さずに MAU を書き換えられない)', async () => {
    const asAuthed = client(anonKey, authed.jwt);
    const insert = await asAuthed
      .from('daily_active_users')
      .insert({ date: '2021-03-17', plan_type: 'all', plan_key: '', dau: 999, wau: 999, mau: 999 });
    expect(insert.error, '書き込めてはいけない').not.toBeNull();
    const check = await sr.from('daily_active_users').select('date').eq('date', '2021-03-17');
    expect(check.data ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------
// E. cleanup_old_logs: 30 日より古い行だけを消す
// ---------------------------------------------------------------
describe('#1157 E. cleanup_old_logs は created_at が 30 日より古い app_logs の行だけを消す', () => {
  it('service_role 以外が呼んでも (42501)、何も消えない', async () => {
    await seedLogs();
    expect(await remainingLogLabels(), '準備した行がすべて入っていること').toEqual(ALL_LABELS);

    const asAuthed = client(anonKey, authed.jwt);
    expect((await withSchemaCacheRetry(() => anon.rpc('cleanup_old_logs'))).error?.code).toBe('42501');
    expect((await withSchemaCacheRetry(() => asAuthed.rpc('cleanup_old_logs'))).error?.code).toBe('42501');

    expect(await remainingLogLabels(), '呼べなかったので、1 行も消えていない').toEqual(ALL_LABELS);
  });

  it('service_role が呼ぶと、30 日より古い行 (30 日と 5 分前・31 日前・365 日前) だけが消え、30 日未満の行は残る', async () => {
    expect(await remainingLogLabels()).toEqual(ALL_LABELS);

    const { error } = await withSchemaCacheRetry(() => sr.rpc('cleanup_old_logs'));
    expect(error).toBeNull();

    expect(await remainingLogLabels()).toEqual(KEPT_LABELS);
    // もう一度呼んでも同じ (残った行は消えない)
    const again = await withSchemaCacheRetry(() => sr.rpc('cleanup_old_logs'));
    expect(again.error).toBeNull();
    expect(await remainingLogLabels()).toEqual(KEPT_LABELS);
  });
});

// ---------------------------------------------------------------
// F. ジョブの command をそのまま流す
// ---------------------------------------------------------------
describe('#1157 F. cron.job に登録された command を、所有者 postgres としてそのまま流しても動く', () => {
  it('cleanup-old-app-logs の command: 30 日より古い行だけが消える', async () => {
    // E で消えたあとに、同じ行を入れ直す
    await sr.from('app_logs').delete().eq('source', LOG_MARK);
    await seedLogs();
    expect(await remainingLogLabels()).toEqual(ALL_LABELS);

    const [job] = await jobsByName(CLEANUP_JOB.name);
    expect(job, `${CLEANUP_JOB.name} が cron.job に無い`).toBeDefined();
    await asPostgres(job.command);

    expect(await remainingLogLabels()).toEqual(KEPT_LABELS);
  });

  it('snapshot-daily-active-users の command: 実行時刻の JST の日付 - 1 の行を書く (UTC の日付ではない)', async () => {
    const [job] = await jobsByName(DAU_JOB.name);
    expect(job, `${DAU_JOB.name} が cron.job に無い`).toBeDefined();
    expect(job.command.match(/now\(\)/g)).toHaveLength(1);

    // 実行時刻を 2021-06-10 16:30 UTC (= 2021-06-11 01:30 JST) に固定して流す。
    // 数えるのは、終わったばかりの JST の 6/10。UTC の日付 - 1 (= 6/9) や JST の今日 (= 6/11) ではない
    const command = job.command.replace('now()', `${lit(RUN_AT_UTC)}::timestamptz`);
    expect(command).not.toBe(job.command);
    // 前の実行の残りがあると、数える日を間違えたのか残りなのか区別できないので、前もって空にする
    await sr.from('daily_active_users').delete().in('date', SNAPSHOT_DATES.filter((d) => d !== BASE && d !== NEXT));
    await asPostgres(command);

    const rows = await sr.from('daily_active_users').select('date, plan_type, plan_key').in('date', [...RUN_AT_NEIGHBOR_DATES, RUN_AT_TARGET_DATE]).order('date');
    expect(rows.error).toBeNull();
    expect(rows.data).toEqual([{ date: RUN_AT_TARGET_DATE, plan_type: 'all', plan_key: '' }]);
  });

  it('command そのもの (now() のまま) も、エラーにならずに流せて、前日 (JST) の行ができる', async () => {
    const [job] = await jobsByName(DAU_JOB.name);
    expect(job, `${DAU_JOB.name} が cron.job に無い`).toBeDefined();
    const today = await asPostgres<{ yesterday: string }>(`SELECT ((now() AT TIME ZONE 'Asia/Tokyo')::date - 1)::text AS yesterday;`);
    const yesterday = today[0].yesterday;
    const datesBefore = await allSnapshotDates();

    try {
      await asPostgres(job.command);

      const rows = await sr.from('daily_active_users').select('date, plan_type, plan_key').eq('date', yesterday).eq('plan_type', 'all').eq('plan_key', '');
      expect(rows.data).toEqual([{ date: yesterday, plan_type: 'all', plan_key: '' }]);
    } finally {
      // このテストが作った行だけを消す。すでにあった行 (本物のジョブが書いた行) は消さない。
      // command が数える日を間違えたときの、間違った日の行も残さない
      const created = (await allSnapshotDates()).filter((date) => !datesBefore.includes(date));
      if (created.length > 0) {
        await sr.from('daily_active_users').delete().in('date', created).eq('plan_type', 'all').eq('plan_key', '');
      }
    }
  });
});

// ---------------------------------------------------------------
// G. 何度流しても同じ結果になる・既存のジョブの置き換え
// ---------------------------------------------------------------
describe('#1157 G. migration は何度流しても同じ結果になり、同じ処理を呼ぶ既存のジョブを置き換える', () => {
  const seeded: Record<string, number> = {};

  async function realJobsAreRight(): Promise<void> {
    for (const job of [CLEANUP_JOB, DAU_JOB]) {
      const rows = await jobsByName(job.name);
      expect(rows, `${job.name} が 1 つだけ登録されていること`).toHaveLength(1);
      expect(rows[0].schedule).toBe(job.schedule);
      expect(rows[0].command).toBe(job.command);
      expect(rows[0].active).toBe(true);
    }
    expect((await jobsCalling('cleanup_old_logs')).map((j) => j.jobname)).toEqual([CLEANUP_JOB.name]);
    expect((await jobsCalling('snapshot_daily_active_users')).map((j) => j.jobname)).toEqual([DAU_JOB.name]);
  }

  it('流す前の準備: 手作業で作られたような既存のジョブ (名前付き・名前なし・同じ名前の別の command) と、残るべきジョブを登録する', async () => {
    // 消えるべきもの
    seeded.oldCleanupNamed = await scheduleTestJob(`t24-test-${RUN}-old-cleanup`, `SELECT 1 /* ${JOB_MARK} cleanup_old_logs */`);
    seeded.oldCleanupUnnamed = await scheduleTestJob(null, `SELECT 1 /* ${JOB_MARK} public.cleanup_old_logs() */`);
    seeded.oldDau = await scheduleTestJob(`t24-test-${RUN}-old-dau`, `SELECT 1 /* ${JOB_MARK} snapshot_daily_active_users */`);
    // 同じ名前で、別の時刻・別の command のジョブ (pg_cron は同じ名前なら上書きする = 本物のジョブが壊れた状態)
    realJobDisturbed = true;
    seeded.sameName = await scheduleTestJob(CLEANUP_JOB.name, `SELECT 1 /* ${JOB_MARK} wrong command under the real name */`, '0 0 2 1 *');
    // 残るべきもの
    seeded.lookalikeCleanup = await scheduleTestJob(`t24-test-${RUN}-lookalike-cleanup`, `SELECT 1 /* ${JOB_MARK} cleanup_old_logs_v2 */`);
    seeded.lookalikeDau = await scheduleTestJob(`t24-test-${RUN}-lookalike-dau`, `SELECT 1 /* ${JOB_MARK} snapshot_daily_active_users_v2 */`);
    seeded.unrelated = await scheduleTestJob(`t24-test-${RUN}-unrelated`, `SELECT 1 /* ${JOB_MARK} unrelated */`);

    const sameName = await jobsByName(CLEANUP_JOB.name);
    expect(sameName.map((j) => j.command)).toEqual([`SELECT 1 /* ${JOB_MARK} wrong command under the real name */`]);
  });

  it('migration を流すと、置き換えるべきジョブが消え、本物の 2 つだけが決めたとおりに登録される。似た名前・無関係なジョブは残る', async () => {
    await asPostgres(MIGRATION_SQL);
    realJobDisturbed = false;

    await realJobsAreRight();
    const remaining = await testJobIds();
    expect(remaining, '残るのは似た名前の 2 つと無関係な 1 つだけ').toEqual(
      [seeded.lookalikeCleanup, seeded.lookalikeDau, seeded.unrelated].sort((a, b) => a - b),
    );
  });

  it('もう一度・もう一度流しても、同じ結果になる (ジョブが増えない)', async () => {
    await asPostgres(MIGRATION_SQL);
    await asPostgres(MIGRATION_SQL);

    await realJobsAreRight();
    expect(await testJobIds()).toEqual([seeded.lookalikeCleanup, seeded.lookalikeDau, seeded.unrelated].sort((a, b) => a - b));
  });

  it('流し直したあとも、関数の権限は service_role だけのまま。関数は呼べる', async () => {
    for (const fn of [SNAPSHOT_FN, CLEANUP_FN]) {
      const roles = await pgQuery<{ role: string; allowed: boolean }>(`
        SELECT r AS role, has_function_privilege(r, to_regprocedure(${lit(fn)})::oid, 'EXECUTE') AS allowed
          FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r;
      `);
      expect(Object.fromEntries(roles.map((r) => [r.role, r.allowed])), fn).toEqual({ anon: false, authenticated: false, service_role: true });
    }
    const row = await snapshot(BASE);
    expect(row.snapshot_date).toBe(BASE);
  });
});

// ---------------------------------------------------------------
// H. pg_cron が無い環境
// ---------------------------------------------------------------
describe('#1157 H. cron.job が存在しない環境では、ジョブの登録を飛ばして成功する', () => {
  it('cron. の名前を存在しない名前に差し替えたコピーを流しても失敗しない (ガードより前に cron の名前を評価しない)', async () => {
    // cron.job の持ち主 (supabase_admin) でないと、本物の cron.job は別名にできない。
    // そのため、本物の pg_cron には触れず、migration の cron.job / cron.unschedule / cron.schedule を
    // 存在しない public.t24_absent_job / _unschedule / _schedule に差し替えたコピーで確かめる。
    const absent = MIGRATION_SQL.replace(/\bcron\./g, 'public.t24_absent_');
    expect(absent).not.toMatch(/\bcron\./);
    expect(absent).toContain("to_regclass('public.t24_absent_job')");
    expect(absent).toContain('public.t24_absent_schedule(');

    // 対照: 存在を確かめずに読めば、同じ流し方でエラーになる (差し替えた名前が本当に存在しないことの確認)
    await expect(asPostgres('DO $t24$ BEGIN PERFORM 1 FROM public.t24_absent_job; END $t24$;')).rejects.toThrow(/t24_absent_job/);

    // 差し替えたコピーは成功する (関数・権限・コメントは流れ、ジョブの登録だけを飛ばす)
    await asPostgres(absent);
  });

  it('流したあとも、本物のジョブは 2 つとも決めたとおりに残っている', async () => {
    for (const job of [CLEANUP_JOB, DAU_JOB]) {
      const rows = await jobsByName(job.name);
      expect(rows).toHaveLength(1);
      expect(rows[0].schedule).toBe(job.schedule);
      expect(rows[0].command).toBe(job.command);
    }
  });
});

// ---------------------------------------------------------------
// I. 適用時の試し実行
// ---------------------------------------------------------------
describe('#1125 I. migration は関数を作った直後に試し実行し、動かないときは適用時に止まる', () => {
  async function trialDateRowCount(): Promise<number> {
    const { data, error } = await sr.from('daily_active_users').select('date').eq('date', TRIAL_DATE);
    if (error) throw new Error(`daily_active_users の確認に失敗: ${error.message}`);
    return (data ?? []).length;
  }

  /** 関数の定義 (本文・属性) の指紋と、本物のジョブの jobid。失敗した migration が何も変えていないことの確認に使う */
  async function stateFingerprint(): Promise<{ definition: string; jobIds: number[] }> {
    const definition = await asPostgres<{ definition: string }>(
      `SELECT md5(pg_get_functiondef(to_regprocedure(${lit(SNAPSHOT_FN)})::oid)) AS definition;`,
    );
    const jobs = await asPostgres<{ jobid: number | string }>(
      `SELECT jobid FROM cron.job WHERE jobname IN (${lit(CLEANUP_JOB.name)}, ${lit(DAU_JOB.name)}) ORDER BY jobid;`,
    );
    return { definition: definition[0].definition, jobIds: jobs.map((j) => Number(j.jobid)) };
  }

  it('試し実行は書いた行を取り消す: 適用の途中でも終わりでも、2000-01-01 の行は残らない', async () => {
    // 対照: 関数を直接呼ぶと、この日付の行は残る (= 試し実行は本当に書いていて、そのあと取り消している)
    await snapshot(TRIAL_DATE);
    expect(await trialDateRowCount(), '対照: 関数を直接呼ぶと行が残る').toBe(1);
    const cleared = await sr.from('daily_active_users').delete().eq('date', TRIAL_DATE);
    expect(cleared.error).toBeNull();
    expect(await trialDateRowCount()).toBe(0);

    // migration を流した、同じ要求の中の最後 (= トランザクションが終わる前) で数えても 0
    const inside = await asPostgres<{ n: number }>(
      `${MIGRATION_SQL}\nSELECT count(*)::int AS n FROM public.daily_active_users WHERE date = DATE ${lit(TRIAL_DATE)};`,
    );
    expect(inside[0].n, '適用の途中 (試し実行のあと) で、行が残っていない').toBe(0);
    expect(await trialDateRowCount(), '適用が終わったあとも、行が残っていない').toBe(0);
  });

  it('関数が無い列を参照していると、migration は適用時に止まる。関数もジョブも元のまま', async () => {
    const before = await stateFingerprint();
    const broken = MIGRATION_SQL.replace(
      'SELECT s.user_id, s.updated_at FROM auth.sessions AS s',
      'SELECT s.user_id, s.no_such_column FROM auth.sessions AS s',
    );
    expect(broken, '差し替えが効いていること').not.toBe(MIGRATION_SQL);

    await expect(asPostgres(broken)).rejects.toThrow(/no_such_column/);

    expect(await stateFingerprint(), '失敗した migration は何も変えない').toEqual(before);
    expect(await trialDateRowCount()).toBe(0);
  });

  it('作れても動かない関数 (実行時のエラー) も、試し実行で適用時に止まる。関数もジョブも元のまま', async () => {
    const before = await stateFingerprint();
    // 0 で割る式は、関数を作る時点では評価されず、実行したときに初めてエラーになる
    const broken = MIGRATION_SQL.replace(
      /\(count\(DISTINCT a\.user_id\)\)::integer\s+AS mau/,
      '(count(DISTINCT a.user_id) / 0)::integer AS mau',
    );
    expect(broken, '差し替えが効いていること').not.toBe(MIGRATION_SQL);

    await expect(asPostgres(broken)).rejects.toThrow(/division by zero/);

    expect(await stateFingerprint(), '失敗した migration は何も変えない').toEqual(before);
    expect(await trialDateRowCount()).toBe(0);
  });

  it('止まった migration のあとも、元の関数は動く。もう一度、正しい migration を流せる', async () => {
    const row = await snapshot(BASE);
    expect(row.snapshot_date).toBe(BASE);
    await asPostgres(MIGRATION_SQL);
    expect((await jobsByName(CLEANUP_JOB.name)).map((j) => j.command)).toEqual([CLEANUP_JOB.command]);
    expect((await jobsByName(DAU_JOB.name)).map((j) => j.command)).toEqual([DAU_JOB.command]);
  });
});

// ---------------------------------------------------------------
// J. rollback (最後に流す。途中で失敗したら afterAll が migration を流し直す)
// ---------------------------------------------------------------
describe('#1125 / #1157 J. rollback は、ジョブと集計の関数を消し、cleanup_old_logs の権限を本番の元の状態に戻す', () => {
  async function cleanupAcl(): Promise<{ anon: boolean; authenticated: boolean; service_role: boolean; public: boolean }> {
    const rows = await pgQuery<{ role: string; allowed: boolean }>(`
      SELECT r AS role, has_function_privilege(r, to_regprocedure(${lit(CLEANUP_FN)})::oid, 'EXECUTE') AS allowed
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r;
    `);
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.allowed]));
    // anon / authenticated は PUBLIC から継承する。PUBLIC への付与 (grantee = 0) そのものが戻っていること
    const publicGrants = await pgQuery<{ n: number }>(`
      SELECT count(*)::int AS n
        FROM pg_proc p, aclexplode(p.proacl) a
       WHERE p.oid = to_regprocedure(${lit(CLEANUP_FN)})::oid AND a.grantee = 0;
    `);
    return {
      anon: byRole.anon,
      authenticated: byRole.authenticated,
      service_role: byRole.service_role,
      public: publicGrants[0].n > 0,
    };
  }

  /** cleanup_old_logs() のコメント。本番の元の関数には無い (null) */
  async function cleanupComment(): Promise<string | null> {
    const rows = await pgQuery<{ comment: string | null }>(
      `SELECT obj_description(to_regprocedure(${lit(CLEANUP_FN)})::oid, 'pg_proc') AS comment;`,
    );
    return rows[0].comment;
  }

  it('rollback を流すと、2 つのジョブと集計の関数が消え、cleanup_old_logs の権限とコメントが本番の元の状態 (PUBLIC / anon / authenticated / service_role に EXECUTE・コメント無し) に戻る', async () => {
    expect(await cleanupComment(), '流す前: migration が付けたコメントがある').toContain('#1157');

    // 集計した行を 1 つ作っておく (rollback は集計した行を消さない)
    await snapshot(BASE);
    const rowBefore = await sr.from('daily_active_users').select('date').eq('date', BASE);
    expect(rowBefore.data).toHaveLength(1);

    realJobDisturbed = true;
    await asPostgres(ROLLBACK_SQL);

    const fn = await pgQuery<{ ok: boolean }>(`SELECT to_regprocedure(${lit(SNAPSHOT_FN)}) IS NULL AS ok;`);
    expect(fn[0].ok, '集計の関数が消えている').toBe(true);
    expect(await jobsByName(CLEANUP_JOB.name), 'cleanup-old-app-logs が登録解除されている').toEqual([]);
    expect(await jobsByName(DAU_JOB.name), 'snapshot-daily-active-users が登録解除されている').toEqual([]);
    expect(await jobsCalling('cleanup_old_logs')).toEqual([]);
    expect(await jobsCalling('snapshot_daily_active_users')).toEqual([]);
    // 本番の元の権限 (supabase/baseline/prod_function_acl.sql): PUBLIC / anon / authenticated / service_role のすべてに EXECUTE
    expect(await cleanupAcl()).toEqual({ anon: true, authenticated: true, service_role: true, public: true });
    expect(await cleanupComment(), 'migration が付けたコメントが外れている (本番の元の関数にはコメントが無い)').toBeNull();

    const rowAfter = await sr.from('daily_active_users').select('date').eq('date', BASE);
    expect(rowAfter.data, '集計した行は rollback では消えない').toHaveLength(1);
  });

  it('rollback は何度流しても同じ結果になる (集計の関数が無くても、ジョブが無くても失敗しない)', async () => {
    await asPostgres(ROLLBACK_SQL);
    await asPostgres(ROLLBACK_SQL);
    expect(await jobsByName(CLEANUP_JOB.name)).toEqual([]);
    expect(await jobsByName(DAU_JOB.name)).toEqual([]);
    expect(await cleanupAcl()).toEqual({ anon: true, authenticated: true, service_role: true, public: true });
  });

  it('rollback のあとにもう一度 migration を流すと、元の状態 (ジョブ 2 つ・service_role だけの権限) に戻る', async () => {
    await asPostgres(MIGRATION_SQL);
    realJobDisturbed = false;

    for (const job of [CLEANUP_JOB, DAU_JOB]) {
      const rows = await jobsByName(job.name);
      expect(rows, `${job.name} が 1 つだけ登録されていること`).toHaveLength(1);
      expect(rows[0].schedule).toBe(job.schedule);
      expect(rows[0].command).toBe(job.command);
    }
    expect(await cleanupAcl()).toEqual({ anon: false, authenticated: false, service_role: true, public: false });
    expect(await cleanupComment()).toContain('#1157');
    const row = await snapshot(BASE);
    expect(row.snapshot_date).toBe(BASE);
  });
});
