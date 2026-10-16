/**
 * #1561 料理画像のジョブを pg_cron で定期に拾い直す migration の回帰テスト (ローカル Supabase の実 DB)
 *
 * migration 20261015180000_meal_image_jobs_pickup_cron.sql が作るもの:
 *   - public.requeue_stale_meal_image_jobs(p_now): processing のまま、貸し出しの期限 (leased_until) から 5 分より長く過ぎたジョブを取り戻す。
 *     attempt_count を 1 足し、3 回に届いたら failed (料理が生成中で同じ料理なら image_status = failed)、届かなければ pending に戻す
 *   - public.invoke_process_meal_image_jobs(): 最後の更新から 1 分を過ぎた待ちのジョブがあれば、Vault の app_cron_secret を Bearer に付けて
 *     Edge Function process-meal-image-jobs を net.http_post で 1 回呼ぶ (本文 { limit: 5 })。無ければ何も送らない
 *   - pg_cron のジョブ requeue-stale-meal-image-jobs (5 分ごと) / process-pending-meal-image-jobs (5 分ごと。2 分ずらす)
 *
 * 確かめること:
 *   A. 取り戻し: 期限から 5 分より長く過ぎた processing は、回数が上限に届かなければ pending (貸し出しを外す・last_error)、
 *      届けば failed。期限の内の processing・待ち・終わったジョブには触れない
 *   B. 諦めたジョブの料理: 生成中で同じ料理なら failed + 理由。画像ができた料理・別の料理に変わった料理・負の位置は書かない。
 *      同じ献立の 2 つの料理が同時に諦められても、どちらも書く
 *   C. 詰まりが解ける: 処理中のまま止まっているあいだは同じ料理を積むと重複 (23505・処理中の重複) だが、
 *      pending に戻れば待ちの重複 (処理を起こす件数に数える)、failed になれば新しく積める
 *   D. 処理を起こす: 待ちのジョブが無ければ Vault を読まずに NULL (秘密が無くても失敗しない)。待ちがあり秘密が無ければ例外 (要求を積まない)。
 *      秘密があれば、本番の process-meal-image-jobs への POST を 1 つ積む (Bearer は Vault の値・本文は { limit: 5 })
 *   E. 権限と属性: 取り戻しは service_role だけ・呼び出しは誰も EXECUTE できない。どちらも SECURITY DEFINER・search_path 空・所有者 postgres
 *   F. ジョブ: 2 つが 1 つずつ、決めた時刻・command・postgres の権限で登録されている。migration を流し直しても 1 つずつ
 *   G. rollback: ジョブと関数が消える。そのあと migration を流し直すと元に戻る
 *
 * D は 1 つのトランザクションの中で関数を呼び、最後に例外でロールバックする (pg_net の待ち行列 net.http_request_queue への行は
 * コミットされないので、本番へは送らない。テスト用の Vault の値もロールバックで消える)。
 *
 * 既知の偶然: migration が登録する本物のジョブ requeue-stale-meal-image-jobs も、ローカルのスタックで 5 分ごとに動く。
 * A / B の準備のあと、テストが取り戻しを呼ぶより先にジョブが動いても、行は同じ状態になる (確認は行の状態で行い、関数の戻り値の件数は見ない)。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。本番には接続しない。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/meal-image-jobs-pickup-cron.test.ts
 */

import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { enqueueMealImageJobs } from '../../../lib/meal-image-jobs';
import { countMealImageJobsToProcess, MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE, type MealImageJobSeed } from '../../../lib/meal-image';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERSION = '20261015180000';
const NAME = 'meal_image_jobs_pickup_cron';
const MIGRATION_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`), 'utf8');
const ROLLBACK_SQL = fs.readFileSync(path.join(REPO_ROOT, `supabase/rollbacks/${VERSION}_${NAME}.down.sql`), 'utf8');

const REQUEUE_SIGNATURE = 'public.requeue_stale_meal_image_jobs(timestamptz)';
const INVOKE_SIGNATURE = 'public.invoke_process_meal_image_jobs()';
const JOBS = [
  { name: 'requeue-stale-meal-image-jobs', schedule: '*/5 * * * *', command: 'SELECT public.requeue_stale_meal_image_jobs()' },
  { name: 'process-pending-meal-image-jobs', schedule: '2-59/5 * * * *', command: 'SELECT public.invoke_process_meal_image_jobs()' },
] as const;
const EDGE_FUNCTION_URL = 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/process-meal-image-jobs';

/** migration の値 (契約は tests/meal-image-jobs-pickup-cron-contract.test.ts が突き合わせる) */
const STALE_GRACE_MINUTES = 5;
const MAX_ATTEMPTS = 3;
const MIN_PENDING_AGE_MINUTES = 1;
const BATCH_LIMIT = 5;
const TIMEOUT_MS = 60000;
/**
 * 境界の前後に取る幅 (分)。準備から関数を呼ぶまでの時間 (数秒) より十分大きく、
 * 期限のすぐ内側のジョブは残り、外側のジョブは取り戻されることを確かめられる
 */
const BOUNDARY_MARGIN_MINUTES = 2;
const MS_PER_MINUTE = 60_000;
/** D で、ロールバックさせる例外の目印 (この後ろに結果の JSON を付ける) */
const RESULT_MARK = 'I1561_RESULT:';

const sr: SupabaseClient = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws as unknown as typeof WebSocket },
});

type PgResult = { ok: true; rows: Record<string, unknown>[] } | { ok: false; status: number; message: string };

/** ローカルスタックの postgres-meta で SQL を流す。失敗は例外にせず、エラー文を返す */
async function pgQueryRaw(query: string): Promise<PgResult> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body: unknown = await res.json();
  if (res.ok) return { ok: true, rows: body as Record<string, unknown>[] };
  const message = (body as { message?: unknown; error?: unknown } | null)?.message ?? (body as { error?: unknown } | null)?.error;
  return { ok: false, status: res.status, message: typeof message === 'string' ? message : JSON.stringify(body) };
}

async function pgQuery(query: string): Promise<Record<string, unknown>[]> {
  const result = await pgQueryRaw(query);
  if (!result.ok) throw new Error(`pg/query ${result.status}: ${result.message}`);
  return result.rows;
}

/** migration と同じ postgres ロールで流す (このリクエストの中だけ) */
function asPostgres(sql: string): Promise<Record<string, unknown>[]> {
  return pgQuery(`SET LOCAL ROLE postgres;\n${sql}`);
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

const TS = Date.now();
const PASSWORD = `I1561!${randomBytes(6).toString('hex')}`;
const DAY = '2026-10-15';
let userId: string;
let dailyMealId: string;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MS_PER_MINUTE).toISOString();

interface DishRow {
  name: string;
  image_status: string;
  image_subject_hash: string;
  image_source: string;
  image_url: string | null;
  image_error?: string | null;
}

const dish = (index: number, overrides: Partial<DishRow> = {}): DishRow => ({
  name: `dish-${index}`,
  image_status: 'pending',
  image_subject_hash: `i1561-${TS}-h${index}`,
  image_source: 'generated_ai',
  image_url: null,
  ...overrides,
});

async function createMeal(dishes: DishRow[]): Promise<string> {
  const { data, error } = await sr
    .from('planned_meals')
    .insert({ daily_meal_id: dailyMealId, meal_type: 'dinner', dish_name: `i1561-${TS}`, dishes })
    .select('id')
    .single();
  if (error || !data) throw new Error(`planned_meals: ${error?.message}`);
  return data.id as string;
}

interface JobSpec {
  plannedMealId: string;
  dishIndex: number;
  subjectHash: string;
  status: 'pending' | 'processing' | 'completed';
  attemptCount: number;
  leasedUntil: string | null;
  updatedAt?: string;
}

async function insertJob(spec: JobSpec): Promise<{ id: string; idempotencyKey: string }> {
  const idempotencyKey = `i1561-${TS}-${randomUUID()}`;
  const { data, error } = await sr
    .from('meal_image_jobs')
    .insert({
      planned_meal_id: spec.plannedMealId,
      user_id: userId,
      dish_index: spec.dishIndex,
      job_kind: 'dish',
      subject_hash: spec.subjectHash,
      idempotency_key: idempotencyKey,
      prompt: 'i1561 integration',
      model: 'test-model',
      status: spec.status,
      attempt_count: spec.attemptCount,
      lease_token: spec.status === 'processing' ? randomUUID() : null,
      leased_until: spec.leasedUntil,
      ...(spec.updatedAt ? { updated_at: spec.updatedAt } : {}),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`meal_image_jobs insert: ${error?.message}`);
  return { id: data.id as string, idempotencyKey };
}

interface JobRow {
  id: string;
  status: string;
  attempt_count: number;
  lease_token: string | null;
  leased_until: string | null;
  last_error: string | null;
}

async function jobOf(id: string): Promise<JobRow> {
  const { data, error } = await sr
    .from('meal_image_jobs')
    .select('id, status, attempt_count, lease_token, leased_until, last_error')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`meal_image_jobs select: ${error?.message}`);
  return data as JobRow;
}

async function dishesOf(mealId: string): Promise<DishRow[]> {
  const { data, error } = await sr.from('planned_meals').select('dishes').eq('id', mealId).single();
  if (error || !data) throw new Error(`planned_meals select: ${error?.message}`);
  return data.dishes as DishRow[];
}

async function requeue(): Promise<Record<string, number>> {
  const { data, error } = await withSchemaCacheRetry(() => sr.rpc('requeue_stale_meal_image_jobs'));
  if (error) throw new Error(`requeue_stale_meal_image_jobs: ${error.message}`);
  return data as Record<string, number>;
}

beforeAll(async () => {
  const rows = await pgQuery(
    `SELECT to_regclass('cron.job')::text AS cron_job, to_regclass('net.http_request_queue')::text AS queue,
            to_regprocedure(${lit(REQUEUE_SIGNATURE)})::text AS requeue_fn, to_regprocedure(${lit(INVOKE_SIGNATURE)})::text AS invoke_fn;`,
  );
  if (!rows[0]?.cron_job || !rows[0]?.queue) {
    throw new Error('cron.job / net.http_request_queue がありません。ローカル DB に pg_cron / pg_net が入っていません。');
  }
  if (!rows[0]?.requeue_fn || !rows[0]?.invoke_fn) {
    throw new Error(`${REQUEUE_SIGNATURE} / ${INVOKE_SIGNATURE} がありません。migration ${VERSION} がローカル DB に適用されていません。`);
  }

  const { data, error } = await sr.auth.admin.createUser({ email: `i1561-${TS}@homegohan.test`, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const { error: pErr } = await retryIdempotentSetup(sr, 'beforeAll: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: userId, nickname: 'i1561', age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (pErr) throw new Error(`user_profiles: ${pErr.message}`);
  const { data: day, error: dErr } = await sr
    .from('user_daily_meals')
    .insert({ user_id: userId, day_date: DAY, is_cheat_day: false })
    .select('id')
    .single();
  if (dErr || !day) throw new Error(`user_daily_meals: ${dErr?.message}`);
  dailyMealId = day.id as string;
}, 30_000);

afterAll(async () => {
  if (!userId) return;
  await sr.from('meal_image_jobs').delete().eq('user_id', userId);
  await sr.from('user_daily_meals').delete().eq('user_id', userId);
  await sr.auth.admin.deleteUser(userId);
});

// ---------------------------------------------------------------
// A / B. 取り戻しと、諦めたジョブの料理
// ---------------------------------------------------------------
describe('#1561 A / B. 止まった processing の取り戻し', () => {
  const STALE = STALE_GRACE_MINUTES + BOUNDARY_MARGIN_MINUTES;
  const FRESH = STALE_GRACE_MINUTES - BOUNDARY_MARGIN_MINUTES;

  it('上限に届かなければ pending に戻し (回数 +1・貸し出しを外す)、届けば failed。期限の内・待ち・終わったジョブには触れない', async () => {
    const dishes = [0, 1, 2, 3, 4].map((i) => dish(i));
    const mealId = await createMeal(dishes);
    const first = await insertJob({ plannedMealId: mealId, dishIndex: 0, subjectHash: dishes[0].image_subject_hash, status: 'processing', attemptCount: 0, leasedUntil: minutesAgo(STALE) });
    const second = await insertJob({ plannedMealId: mealId, dishIndex: 1, subjectHash: dishes[1].image_subject_hash, status: 'processing', attemptCount: MAX_ATTEMPTS - 2, leasedUntil: minutesAgo(STALE) });
    const last = await insertJob({ plannedMealId: mealId, dishIndex: 2, subjectHash: dishes[2].image_subject_hash, status: 'processing', attemptCount: MAX_ATTEMPTS - 1, leasedUntil: minutesAgo(STALE) });
    const fresh = await insertJob({ plannedMealId: mealId, dishIndex: 3, subjectHash: dishes[3].image_subject_hash, status: 'processing', attemptCount: 0, leasedUntil: minutesAgo(FRESH) });
    const waiting = await insertJob({ plannedMealId: mealId, dishIndex: 4, subjectHash: dishes[4].image_subject_hash, status: 'pending', attemptCount: 0, leasedUntil: minutesAgo(STALE) });
    const freshBefore = await jobOf(fresh.id);
    const waitingBefore = await jobOf(waiting.id);

    const result = await requeue();
    expect(Object.keys(result).sort()).toEqual(['dishes_marked_failed', 'failed', 'requeued']);

    expect(await jobOf(first.id)).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      lease_token: null,
      leased_until: null,
      last_error: `lease expired (attempt 1 of ${MAX_ATTEMPTS}): requeued`,
    });
    expect(await jobOf(second.id)).toMatchObject({ status: 'pending', attempt_count: MAX_ATTEMPTS - 1, lease_token: null });
    expect(await jobOf(last.id)).toMatchObject({
      status: 'failed',
      attempt_count: MAX_ATTEMPTS,
      lease_token: null,
      leased_until: null,
      last_error: `lease expired (attempt ${MAX_ATTEMPTS} of ${MAX_ATTEMPTS}): gave up`,
    });
    expect(await jobOf(fresh.id)).toEqual(freshBefore);
    expect(await jobOf(waiting.id)).toEqual(waitingBefore);

    // pending に戻したジョブの料理は生成中のまま。諦めたジョブの料理だけ失敗の印になる
    const after = await dishesOf(mealId);
    expect(after.map((d) => d.image_status)).toEqual(['pending', 'pending', 'failed', 'pending', 'pending']);
    expect(after[2].image_error).toBe(`lease expired (attempt ${MAX_ATTEMPTS} of ${MAX_ATTEMPTS}): gave up`);
  });

  it('諦めたジョブの料理: 画像ができた料理・別の料理に変わった料理・負の位置には書かない。同じ献立の 2 つの料理はどちらも書く', async () => {
    const dishes = [
      dish(0),
      dish(1, { image_status: 'ready', image_url: 'https://example.com/ready.png' }),
      dish(2),
      dish(3),
      dish(4),
    ];
    const mealId = await createMeal(dishes);
    const stale = { status: 'processing' as const, attemptCount: MAX_ATTEMPTS - 1, leasedUntil: minutesAgo(STALE), plannedMealId: mealId };
    await insertJob({ ...stale, dishIndex: 0, subjectHash: dishes[0].image_subject_hash });
    await insertJob({ ...stale, dishIndex: 1, subjectHash: dishes[1].image_subject_hash });
    // 料理が変わった (ジョブの subject_hash が料理のものと違う)
    await insertJob({ ...stale, dishIndex: 2, subjectHash: `i1561-${TS}-changed` });
    await insertJob({ ...stale, dishIndex: 3, subjectHash: dishes[3].image_subject_hash });
    // 負の位置 (jsonb の -> は後ろから数えるので、守りが無ければ最後の料理 (dish 4) に当たる)
    const negative = await insertJob({ ...stale, dishIndex: -1, subjectHash: dishes[4].image_subject_hash });

    await requeue();

    const after = await dishesOf(mealId);
    expect(after.map((d) => d.image_status)).toEqual(['failed', 'ready', 'pending', 'failed', 'pending']);
    expect(after[1]).toEqual(dishes[1]);
    expect(after[2]).toEqual(dishes[2]);
    expect(after[4]).toEqual(dishes[4]);
    // 料理のほかの項目は変えない
    expect(after[0]).toMatchObject({ name: 'dish-0', image_subject_hash: dishes[0].image_subject_hash, image_source: 'generated_ai', image_url: null });
    expect((await jobOf(negative.id)).status).toBe('failed');
  });

  it('service_role が呼べる (手で流す)。anon / authenticated は呼べず、何も変わらない', async () => {
    const mealId = await createMeal([dish(0)]);
    const job = await insertJob({ plannedMealId: mealId, dishIndex: 0, subjectHash: dish(0).image_subject_hash, status: 'processing', attemptCount: 0, leasedUntil: minutesAgo(STALE) });
    const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false }, realtime: { transport: ws as unknown as typeof WebSocket } });

    // EXECUTE が無いので、権限のエラー (42501) か、関数が見えない (PGRST202) になる
    const { error } = await anon.rpc('requeue_stale_meal_image_jobs');
    expect(error).not.toBeNull();
    expect((await jobOf(job.id)).status).toBe('processing');

    await requeue();
    expect((await jobOf(job.id)).status).toBe('pending');
  });
});

// ---------------------------------------------------------------
// C. 詰まりが解ける (冪等の部分索引は processing も対象)
// ---------------------------------------------------------------
describe('#1561 C. 止まったジョブがふさいでいた積み直しが通る', () => {
  const STALE = STALE_GRACE_MINUTES + BOUNDARY_MARGIN_MINUTES;

  async function seedFor(mealId: string, dishRow: DishRow, dishIndex: number): Promise<MealImageJobSeed> {
    return {
      dishIndex,
      dishName: dishRow.name,
      subjectHash: dishRow.image_subject_hash,
      prompt: 'i1561 integration',
      model: 'test-model',
      triggerSource: `integration:i1561:${mealId}`,
      referenceImageUrls: [],
    };
  }

  it('処理中のまま止まっているあいだは処理中の重複 (起こさない)。pending に戻れば待ちの重複 (起こす)', async () => {
    const dishes = [dish(0)];
    const mealId = await createMeal(dishes);
    const seed = await seedFor(mealId, dishes[0], 0);
    const first = await enqueueMealImageJobs({ supabase: sr, plannedMealId: mealId, userId, triggerSource: seed.triggerSource, jobSeeds: [seed] });
    expect(first.inserted).toBe(1);
    const { data: rows } = await sr.from('meal_image_jobs').select('id').eq('planned_meal_id', mealId);
    const jobId = (rows ?? [])[0].id as string;
    await sr
      .from('meal_image_jobs')
      .update({ status: 'processing', lease_token: randomUUID(), leased_until: minutesAgo(STALE) })
      .eq('id', jobId);

    const whileStuck = await enqueueMealImageJobs({ supabase: sr, plannedMealId: mealId, userId, triggerSource: seed.triggerSource, jobSeeds: [seed] });
    expect(whileStuck).toEqual({ inserted: 0, duplicates: 1, duplicatesProcessing: 1, failed: 0 });
    expect(countMealImageJobsToProcess(whileStuck)).toBe(0);

    await requeue();

    const afterRequeue = await enqueueMealImageJobs({ supabase: sr, plannedMealId: mealId, userId, triggerSource: seed.triggerSource, jobSeeds: [seed] });
    expect(afterRequeue).toEqual({ inserted: 0, duplicates: 1, duplicatesProcessing: 0, failed: 0 });
    expect(countMealImageJobsToProcess(afterRequeue)).toBe(1);
  });

  it('上限で failed になれば、同じ冪等キーで新しく積める (止まっているあいだは 23505)', async () => {
    const dishes = [dish(0)];
    const mealId = await createMeal(dishes);
    const stuck = await insertJob({ plannedMealId: mealId, dishIndex: 0, subjectHash: dishes[0].image_subject_hash, status: 'processing', attemptCount: MAX_ATTEMPTS - 1, leasedUntil: minutesAgo(STALE) });
    const row = {
      planned_meal_id: mealId,
      user_id: userId,
      dish_index: 0,
      job_kind: 'dish',
      subject_hash: dishes[0].image_subject_hash,
      idempotency_key: stuck.idempotencyKey,
      prompt: 'i1561 integration',
      model: 'test-model',
      status: 'pending',
    };

    const blocked = await sr.from('meal_image_jobs').insert(row);
    expect(blocked.error?.code).toBe(MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE);

    await requeue();
    expect((await jobOf(stuck.id)).status).toBe('failed');

    const retried = await sr.from('meal_image_jobs').insert(row);
    expect(retried.error).toBeNull();
  });
});

// ---------------------------------------------------------------
// D. 処理を起こす (ロールバックするので、本番へは送らない)
// ---------------------------------------------------------------
interface QueuedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeout_milliseconds: number;
}

/** DO ブロックの中で test を流し、結果の JSON を例外で返してロールバックする */
async function runRolledBack(test: string): Promise<Record<string, unknown>> {
  const result = await pgQueryRaw(`
    SET LOCAL ROLE postgres;
    DO $test$
    DECLARE
      v_result jsonb;
    BEGIN
      ${test}
      RAISE EXCEPTION '${RESULT_MARK}%', v_result;
    END
    $test$;
  `);
  expect(result.ok, 'ロールバックのための例外で終わること').toBe(false);
  if (result.ok) throw new Error('unreachable');
  const at = result.message.indexOf(RESULT_MARK);
  expect(at, `結果の目印が無い: ${result.message}`).toBeGreaterThanOrEqual(0);
  return JSON.parse(result.message.slice(at + RESULT_MARK.length)) as Record<string, unknown>;
}

/** 積む前提の待ちのジョブ (最後の更新を、積んだ直後のジョブを数えない時間より前にする) を、トランザクションの中で 1 つ作る SQL */
function oldPendingJobSql(mealId: string): string {
  const updatedAt = minutesAgo(MIN_PENDING_AGE_MINUTES + BOUNDARY_MARGIN_MINUTES);
  return `
      INSERT INTO public.meal_image_jobs (planned_meal_id, user_id, dish_index, job_kind, subject_hash, idempotency_key, prompt, model, status, updated_at)
      VALUES (${lit(mealId)}, ${lit(userId)}, 0, 'dish', ${lit(`i1561-${TS}-d`)}, ${lit(`i1561-${TS}-${randomUUID()}`)}, 'i1561', 'test-model', 'pending', ${lit(updatedAt)});`;
}

describe('#1561 D. 待ちのジョブの処理を起こす (invoke_process_meal_image_jobs)', () => {
  let mealId: string;

  beforeAll(async () => {
    mealId = await createMeal([dish(0)]);
  });

  it('待ちのジョブが無ければ、Vault を読まずに NULL を返し、要求を積まない (秘密が無くても失敗しない)', async () => {
    const out = await runRolledBack(`
      DECLARE v_before bigint; v_id bigint; v_after bigint;
      BEGIN
        -- このトランザクションの中だけ、待ちのジョブを無くす (ロールバックで戻る)
        UPDATE public.meal_image_jobs SET status = 'cancelled' WHERE status = 'pending';
        DELETE FROM vault.secrets WHERE name = 'app_cron_secret';
        SELECT count(*) INTO v_before FROM net.http_request_queue;
        v_id := ${INVOKE_SIGNATURE};
        SELECT count(*) INTO v_after FROM net.http_request_queue;
        v_result := jsonb_build_object('id', v_id, 'before', v_before, 'after', v_after);
      END;
    `);
    expect(out).toEqual({ id: null, before: out.before, after: out.before });
  });

  it('積んだ直後 (1 分以内) の待ちのジョブだけなら、何も送らない', async () => {
    const out = await runRolledBack(`
      DECLARE v_id bigint;
      BEGIN
        UPDATE public.meal_image_jobs SET status = 'cancelled' WHERE status = 'pending';
        INSERT INTO public.meal_image_jobs (planned_meal_id, user_id, dish_index, job_kind, subject_hash, idempotency_key, prompt, model, status)
        VALUES (${lit(mealId)}, ${lit(userId)}, 0, 'dish', ${lit(`i1561-${TS}-fresh`)}, ${lit(`i1561-${TS}-${randomUUID()}`)}, 'i1561', 'test-model', 'pending');
        v_id := ${INVOKE_SIGNATURE};
        v_result := jsonb_build_object('id', v_id);
      END;
    `);
    expect(out).toEqual({ id: null });
  });

  it('待ちのジョブがあり Vault に app_cron_secret が無ければ、例外で失敗し要求を積まない', async () => {
    const result = await pgQueryRaw(`
      SET LOCAL ROLE postgres;
      ${oldPendingJobSql(mealId)}
      DELETE FROM vault.secrets WHERE name = 'app_cron_secret';
      SELECT ${INVOKE_SIGNATURE};
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('app_cron_secret not found in Vault');
  });

  it('秘密があれば、本番の process-meal-image-jobs への POST を 1 つ積む。Bearer は Vault の値・本文は { limit: 5 }', async () => {
    const secret = `i1561-test-${randomBytes(8).toString('hex')}`;
    const out = await runRolledBack(`
      DECLARE v_id bigint; v_request jsonb;
      BEGIN
        ${oldPendingJobSql(mealId)}
        DELETE FROM vault.secrets WHERE name = 'app_cron_secret';
        PERFORM vault.create_secret(${lit(secret)}, 'app_cron_secret', 'i1561 integration test (rolled back)');
        v_id := ${INVOKE_SIGNATURE};
        SELECT jsonb_build_object(
                 'method', q.method,
                 'url', q.url,
                 'headers', q.headers,
                 'body', convert_from(q.body, 'UTF8')::jsonb,
                 'timeout_milliseconds', q.timeout_milliseconds)
          INTO v_request
          FROM net.http_request_queue q
         WHERE q.id = v_id;
        v_result := jsonb_build_object('id', v_id, 'request', v_request);
      END;
    `);
    expect(out.id).not.toBeNull();
    const request = out.request as QueuedRequest;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(EDGE_FUNCTION_URL);
    expect(request.headers).toMatchObject({ Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' });
    expect(request.body).toEqual({ limit: BATCH_LIMIT });
    expect(request.timeout_milliseconds).toBe(TIMEOUT_MS);

    const leftovers = await asPostgres(`SELECT count(*)::int AS n FROM vault.secrets WHERE description LIKE 'i1561 integration test%';`);
    expect(Number(leftovers[0].n)).toBe(0);
  });
});

// ---------------------------------------------------------------
// E. 権限と属性
// ---------------------------------------------------------------
describe('#1561 E. 関数の権限と属性', () => {
  it.each([
    ['anon', REQUEUE_SIGNATURE, false],
    ['authenticated', REQUEUE_SIGNATURE, false],
    ['service_role', REQUEUE_SIGNATURE, true],
    ['anon', INVOKE_SIGNATURE, false],
    ['authenticated', INVOKE_SIGNATURE, false],
    ['service_role', INVOKE_SIGNATURE, false],
  ] as const)('%s が %s を EXECUTE できるか: %s', async (role, signature, expected) => {
    const rows = await pgQuery(`SELECT has_function_privilege(${lit(role)}, ${lit(signature)}, 'EXECUTE') AS can_execute;`);
    expect(rows[0].can_execute).toBe(expected);
  });

  it.each([REQUEUE_SIGNATURE, INVOKE_SIGNATURE])('%s は SECURITY DEFINER・所有者 postgres・search_path 空', async (signature) => {
    const rows = await pgQuery(`
      SELECT p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config
        FROM pg_proc AS p
       WHERE p.oid = to_regprocedure(${lit(signature)});
    `);
    expect(rows[0]).toMatchObject({ security_definer: true, owner: 'postgres' });
    expect(rows[0].config).toEqual(['search_path=""']);
  });
});

// ---------------------------------------------------------------
// F / G. ジョブの登録・流し直し・rollback
// ---------------------------------------------------------------
interface CronRow {
  jobname: string;
  schedule: string;
  command: string;
  username: string;
  active: boolean;
}

async function registeredJobs(): Promise<CronRow[]> {
  const rows = await asPostgres(`
    SELECT jobname, schedule, command, username, active
      FROM cron.job
     WHERE jobname IN (${JOBS.map((job) => lit(job.name)).join(', ')})
     ORDER BY jobname;
  `);
  return rows as unknown as CronRow[];
}

const expectedJobs = () =>
  [...JOBS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((job) => ({ jobname: job.name, schedule: job.schedule, command: job.command, username: 'postgres', active: true }));

describe('#1561 F / G. pg_cron のジョブと rollback', () => {
  it('2 つのジョブが 1 つずつ、決めた時刻・command・postgres の権限・有効で登録されている。流し直しても 1 つずつ', async () => {
    expect(await registeredJobs()).toEqual(expectedJobs());

    await asPostgres(MIGRATION_SQL);
    await asPostgres(MIGRATION_SQL);

    expect(await registeredJobs()).toEqual(expectedJobs());
  }, 30_000);

  it('rollback でジョブと関数が消え、何度流しても同じ。そのあと migration を流すと元に戻る', async () => {
    try {
      await asPostgres(ROLLBACK_SQL);
      await asPostgres(ROLLBACK_SQL);

      expect(await registeredJobs()).toEqual([]);
      const fns = await pgQuery(
        `SELECT to_regprocedure(${lit(REQUEUE_SIGNATURE)})::text AS requeue_fn, to_regprocedure(${lit(INVOKE_SIGNATURE)})::text AS invoke_fn;`,
      );
      expect(fns[0]).toEqual({ requeue_fn: null, invoke_fn: null });
    } finally {
      await asPostgres(MIGRATION_SQL);
    }

    expect(await registeredJobs()).toEqual(expectedJobs());
    const fns = await pgQuery(
      `SELECT to_regprocedure(${lit(REQUEUE_SIGNATURE)})::text AS requeue_fn, to_regprocedure(${lit(INVOKE_SIGNATURE)})::text AS invoke_fn;`,
    );
    expect(fns[0].requeue_fn).not.toBeNull();
    expect(fns[0].invoke_fn).not.toBeNull();
  }, 30_000);
});
