// @vitest-environment node
/**
 * #1561 料理画像のジョブを pg_cron で定期に拾い直す migration の契約 (DB を使わない静的な検査)
 *
 * migration 20261015180000_meal_image_jobs_pickup_cron.sql が作るもの:
 *   - public.requeue_stale_meal_image_jobs(p_now): processing のまま、貸し出しの期限から c_stale_grace より長く過ぎたジョブを取り戻す
 *     (attempt_count + 1。c_max_attempts に届いたら failed、届かなければ pending)
 *   - public.invoke_process_meal_image_jobs(): 待ちのジョブがあれば、Vault の app_cron_secret で process-meal-image-jobs を 1 回呼ぶ
 *   - pg_cron のジョブ requeue-stale-meal-image-jobs / process-pending-meal-image-jobs (どちらも 5 分ごと。呼び出しは 2 分ずらす)
 *
 * ここで確かめること (実 DB での動きは tests/integration/security/meal-image-jobs-pickup-cron.test.ts):
 *   1. rollback が対になっている (ジョブの登録解除・2 つの関数の削除だけ。行には触れない)
 *   2. version は作ったときの main の最大より上で、ほかの migration と重ならない
 *   3. 取り戻しの猶予: Edge Function の貸し出し (index.ts の JOB_LEASE_MS) + 猶予が、Edge Function の実行時間の上限より長い
 *      (生きているワーカーのジョブを取り戻さない)
 *   4. 呼び出し: 呼び先は本番の process-meal-image-jobs に固定・Vault の app_cron_secret を Bearer に付ける・無ければ例外。
 *      1 回の件数は関数の既定の件数と同じで、関数の上限以下
 *   5. 権限: 呼び出しの関数は誰にも EXECUTE を付けない (所有者 postgres = pg_cron だけ)。取り戻しの関数は service_role にだけ付ける
 *   6. ジョブ: 5 分ごと・呼び出しは取り戻しより後にずらし、そのずれは「積んだ直後のジョブを数えない時間」より長い。
 *      pg_cron が無い DB では登録を飛ばす (cron.job を読む前に確かめる)
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const VERSION = '20261015180000';
const NAME = 'meal_image_jobs_pickup_cron';
const MIGRATION_PATH = path.join(ROOT, 'supabase', 'migrations', `${VERSION}_${NAME}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${VERSION}_${NAME}.down.sql`);
const WORKER_PATH = path.join(ROOT, 'supabase', 'functions', 'process-meal-image-jobs', 'index.ts');
/** この migration を作ったときの origin/main の migration の最大 */
const MAIN_MAX_VERSION_AT_CREATION = '20261015110000';

const REQUEUE_FN = 'requeue_stale_meal_image_jobs';
const INVOKE_FN = 'invoke_process_meal_image_jobs';
const REQUEUE_JOB = 'requeue-stale-meal-image-jobs';
const PICKUP_JOB = 'process-pending-meal-image-jobs';
const EDGE_FUNCTION_URL = 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/process-meal-image-jobs';

/**
 * Edge Function の実行時間の上限 (秒。有料プランの wall clock)。invoke_calculate_segment_stats の c_timeout_ms (400000) の説明と同じ値。
 * ワーカーがジョブを取ってから持ち続けられるのは、長くてもこの時間まで
 */
const EDGE_WALL_CLOCK_LIMIT_SECONDS = 400;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MINUTES_PER_HOUR = 60;

/** `--` の行コメントを取り除く (この migration の文字列リテラルには `--` を含むものが無い) */
const stripLineComments = (sql: string) => sql.replace(/--.*$/gm, '');
const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');
const code = stripLineComments(migration);
const worker = fs.readFileSync(WORKER_PATH, 'utf-8');

/** CREATE OR REPLACE FUNCTION public.<name> の属性 (AS $$ の手前まで) と本体 */
function fnParts(name: string): { header: string; body: string } {
  const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} の CREATE OR REPLACE FUNCTION が見つからない`).toBeGreaterThanOrEqual(0);
  const rest = code.slice(start);
  const opener = /\bAS\s+\$\$/.exec(rest);
  expect(opener, 'AS $$ が見つからない').not.toBeNull();
  const openerMatch = opener as RegExpExecArray;
  const bodyStart = openerMatch.index + openerMatch[0].length;
  const bodyEnd = rest.indexOf('$$', bodyStart);
  expect(bodyEnd, '本体の終わりの $$ が見つからない').toBeGreaterThan(bodyStart);
  return { header: rest.slice(0, openerMatch.index), body: rest.slice(bodyStart, bodyEnd) };
}

/** 本体の `<name> CONSTANT <type> := <value>;` の value (前後の空白を除く) */
function constantOf(body: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s+CONSTANT\\s+[a-z ]+?\\s*:=\\s*([^;]+);`).exec(body);
  expect(m, `${name} の CONSTANT が見つからない`).not.toBeNull();
  return (m as RegExpExecArray)[1].trim();
}

/** `interval 'N minute(s)'` の N (分) */
function intervalMinutes(value: string): number {
  const m = /^interval\s+'(\d+) minutes?'$/i.exec(value);
  expect(m, `${value} は interval 'N minutes' の形`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

/** 文字列リテラル '...' の中身 */
function textLiteral(value: string): string {
  const m = /^'([^']*)'$/.exec(value);
  expect(m, `${value} は文字列リテラル`).not.toBeNull();
  return (m as RegExpExecArray)[1];
}

/** cron の分の欄 (`*\/N` か `A-59/N`) の、最初の分と間隔 */
function minuteField(schedule: string): { first: number; step: number } {
  const [minute, ...rest] = schedule.split(' ');
  expect(rest, `${schedule} は分以外がすべて *`).toEqual(['*', '*', '*', '*']);
  const every = /^\*\/(\d+)$/.exec(minute);
  if (every) return { first: 0, step: Number(every[1]) };
  const ranged = /^(\d+)-59\/(\d+)$/.exec(minute);
  expect(ranged, `${schedule} の分は */N か A-59/N`).not.toBeNull();
  return { first: Number((ranged as RegExpExecArray)[1]), step: Number((ranged as RegExpExecArray)[2]) };
}

/** index.ts の JOB_LEASE_MS (`<分> * 60_000` の形) をミリ秒で */
function workerLeaseMs(): number {
  const m = /\bconst JOB_LEASE_MS = (\d+) \* 60_000;/.exec(worker);
  expect(m, 'process-meal-image-jobs/index.ts の JOB_LEASE_MS が `<分> * 60_000` の形で見つからない').not.toBeNull();
  return Number((m as RegExpExecArray)[1]) * SECONDS_PER_MINUTE * MS_PER_SECOND;
}

const requeue = fnParts(REQUEUE_FN);
const invoke = fnParts(INVOKE_FN);
const cronBlock = code.slice(code.lastIndexOf('DO $$'));

describe('#1561 migration と rollback のファイル', () => {
  it('rollback が同じ version / 名前で対になっていて、2 つのジョブの登録解除と 2 つの関数の削除だけを行う', () => {
    expect(fs.existsSync(ROLLBACK_PATH), `supabase/rollbacks/${VERSION}_${NAME}.down.sql が無い`).toBe(true);
    const rollback = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    expect(rollback).toContain(`'${REQUEUE_JOB}'`);
    expect(rollback).toContain(`'${PICKUP_JOB}'`);
    expect(rollback).toMatch(/cron\.unschedule\(/);
    expect(rollback.indexOf("to_regclass('cron.job')"), 'pg_cron が無い DB では何もしない').toBeLessThan(rollback.indexOf('FROM cron.job'));
    expect(rollback).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${INVOKE_FN}\\(\\);`));
    expect(rollback).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${REQUEUE_FN}\\(timestamptz\\);`));
    expect(rollback).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(rollback).not.toMatch(/\bUPDATE\s+public\./i);
    expect(rollback).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('version は作ったときの main の最大より上で、ほかの migration と重ならない', () => {
    const versions = fs
      .readdirSync(path.join(ROOT, 'supabase', 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.split('_')[0]);
    expect(versions.filter((v) => v === VERSION)).toHaveLength(1);
    // 14 桁の数字どうしなら、文字列の大小は version の大小と同じ
    expect(VERSION > MAIN_MAX_VERSION_AT_CREATION).toBe(true);
  });

  it('表・列・索引は変えない (冪等の部分索引 meal_image_jobs_idempotency_pending_idx はそのまま)', () => {
    expect(code).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+(?:UNIQUE\s+)?INDEX\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(code).not.toMatch(/\bCREATE\s+TABLE\b/i);
  });
});

describe('#1561 止まった processing の取り戻し (requeue_stale_meal_image_jobs)', () => {
  it('SECURITY DEFINER・search_path 空・plpgsql。同時に 2 回走らない (advisory lock)・行は SKIP LOCKED で取る', () => {
    expect(requeue.header).toMatch(/\bSECURITY DEFINER\b/);
    expect(requeue.header).toMatch(/SET search_path = ''/);
    expect(requeue.header).toMatch(/LANGUAGE plpgsql/);
    expect(requeue.body).toMatch(/pg_advisory_xact_lock\(/);
    expect(requeue.body).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('貸し出し (Edge Function の JOB_LEASE_MS) + 猶予が、Edge Function の実行時間の上限より長い (生きているワーカーのジョブを取り戻さない)', () => {
    const graceSeconds = intervalMinutes(constantOf(requeue.body, 'c_stale_grace')) * SECONDS_PER_MINUTE;
    const leaseSeconds = workerLeaseMs() / MS_PER_SECOND;
    expect(leaseSeconds + graceSeconds).toBeGreaterThan(EDGE_WALL_CLOCK_LIMIT_SECONDS);
    // 判定は貸し出しの期限 (無ければ updated_at) から猶予を引いた時刻と比べる
    expect(requeue.body).toMatch(/COALESCE\(j\.leased_until, j\.updated_at\) < v_now - c_stale_grace/);
  });

  it('取り戻すたびに attempt_count を 1 足し、c_max_attempts (2 回以上) に届いたら failed、届かなければ pending。貸し出しは外す', () => {
    expect(Number(constantOf(requeue.body, 'c_max_attempts'))).toBeGreaterThanOrEqual(2);
    expect(requeue.body).toMatch(/j\.attempt_count \+ 1 AS next_attempt/);
    expect(requeue.body).toMatch(/CASE WHEN s\.next_attempt >= c_max_attempts THEN 'failed' ELSE 'pending' END/);
    expect(requeue.body).toMatch(/lease_token\s+= NULL/);
    expect(requeue.body).toMatch(/leased_until\s+= NULL/);
    // 取り戻すのは processing だけ (待ち・終わったジョブには触れない)
    expect(requeue.body).toMatch(/WHERE j\.status = 'processing'/);
  });

  it('諦めたジョブの料理は、まだ生成中で同じ料理 (subject_hash) のときだけ failed にする。負の位置には書かない', () => {
    expect(requeue.body).toMatch(/IF r\.dish_index >= 0 THEN/);
    expect(requeue.body).toMatch(/->> 'image_subject_hash' = r\.subject_hash/);
    expect(requeue.body).toMatch(/->> 'image_status' = 'pending'/);
    expect(requeue.body).toMatch(/jsonb_build_object\('image_status', 'failed', 'image_error', r\.last_error\)/);
  });

  it('PUBLIC / anon / authenticated から EXECUTE を外し、service_role にだけ付ける。所有者は postgres', () => {
    expect(code).toContain(`ALTER FUNCTION public.${REQUEUE_FN}(timestamptz) OWNER TO postgres;`);
    expect(code).toContain(`REVOKE ALL ON FUNCTION public.${REQUEUE_FN}(timestamptz) FROM PUBLIC, anon, authenticated;`);
    expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${REQUEUE_FN}(timestamptz) TO service_role;`);
  });
});

describe('#1561 待ちのジョブの処理を起こす (invoke_process_meal_image_jobs)', () => {
  it('呼び先は本番の process-meal-image-jobs に固定 (引数で差し替えられない)。Vault の app_cron_secret を Bearer に付け、無ければ例外', () => {
    expect(invoke.header).toMatch(/public\.invoke_process_meal_image_jobs\(\)/);
    expect(invoke.header).toMatch(/\bSECURITY DEFINER\b/);
    expect(invoke.header).toMatch(/SET search_path = ''/);
    expect(textLiteral(constantOf(invoke.body, 'c_url'))).toBe(EDGE_FUNCTION_URL);
    expect(invoke.body).toMatch(/WHERE name = 'app_cron_secret'/);
    expect(invoke.body).toMatch(/IF v_secret IS NULL THEN\s+RAISE EXCEPTION 'app_cron_secret not found in Vault/);
    expect(invoke.body).toMatch(/'Authorization', 'Bearer ' \|\| v_secret/);
    expect(invoke.body).toMatch(/url := c_url/);
  });

  it('待ちのジョブが無ければ Vault を読まずに何も送らない (判定は秘密を読むより前)', () => {
    const check = invoke.body.indexOf('IF NOT EXISTS');
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(invoke.body.indexOf('vault.decrypted_secrets'));
    expect(invoke.body).toMatch(/j\.status = 'pending'\s+AND j\.updated_at < now\(\) - c_min_pending_age/);
  });

  it('1 回の件数は、関数の既定の件数と同じで、関数の上限以下', () => {
    const batch = Number(constantOf(invoke.body, 'c_batch_limit'));
    const workerLimit = /typeof body\.limit === "number" && body\.limit > 0 \? Math\.min\((\d+), Math\.floor\(body\.limit\)\) : (\d+);/.exec(worker);
    expect(workerLimit, 'process-meal-image-jobs/index.ts の件数の決め方が見つからない').not.toBeNull();
    const [, max, fallback] = workerLimit as RegExpExecArray;
    expect(batch).toBe(Number(fallback));
    expect(batch).toBeLessThanOrEqual(Number(max));
    expect(invoke.body).toMatch(/body := jsonb_build_object\('limit', c_batch_limit\)/);
  });

  it('誰にも EXECUTE を付けない (PUBLIC / anon / authenticated / service_role から外す)。所有者は postgres', () => {
    expect(code).toContain(`ALTER FUNCTION public.${INVOKE_FN}() OWNER TO postgres;`);
    expect(code).toContain(`REVOKE ALL ON FUNCTION public.${INVOKE_FN}() FROM PUBLIC, anon, authenticated, service_role;`);
    expect(code).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${INVOKE_FN}`));
  });

  it('process-meal-image-jobs は CRON_SECRET (requireServiceRole) も受け付ける (service role key の完全一致のあと)', () => {
    const serveAt = worker.indexOf('Deno.serve(');
    const handler = worker.slice(serveAt);
    const internal = handler.indexOf('const isInternalCaller');
    const cron = handler.indexOf('await requireServiceRole(req)');
    expect(internal).toBeGreaterThanOrEqual(0);
    expect(cron).toBeGreaterThan(internal);
    expect(cron, '本文を読む前に認証する').toBeLessThan(handler.indexOf('req.json()'));
  });
});

describe('#1561 pg_cron のジョブ', () => {
  const requeueSchedule = textLiteral(constantOf(cronBlock, 'c_requeue_schedule'));
  const pickupSchedule = textLiteral(constantOf(cronBlock, 'c_pickup_schedule'));

  it('ジョブ名と command は 2 つの関数を呼ぶ。同じ名前のジョブを外してから登録する', () => {
    expect(textLiteral(constantOf(cronBlock, 'c_requeue_job'))).toBe(REQUEUE_JOB);
    expect(textLiteral(constantOf(cronBlock, 'c_pickup_job'))).toBe(PICKUP_JOB);
    expect(textLiteral(constantOf(cronBlock, 'c_requeue_command'))).toBe(`SELECT public.${REQUEUE_FN}()`);
    expect(textLiteral(constantOf(cronBlock, 'c_pickup_command'))).toBe(`SELECT public.${INVOKE_FN}()`);
    expect(cronBlock.indexOf('cron.unschedule(')).toBeLessThan(cronBlock.indexOf('cron.schedule('));
    expect(cronBlock).toMatch(/PERFORM cron\.schedule\(c_requeue_job, c_requeue_schedule, c_requeue_command\);/);
    expect(cronBlock).toMatch(/PERFORM cron\.schedule\(c_pickup_job, c_pickup_schedule, c_pickup_command\);/);
  });

  it('どちらも同じ間隔 (1 時間を割り切る) で、呼び出しは取り戻しより後にずらし、そのずれは「積んだ直後のジョブを数えない時間」より長い', () => {
    const r = minuteField(requeueSchedule);
    const p = minuteField(pickupSchedule);
    expect(r.step).toBe(p.step);
    expect(MINUTES_PER_HOUR % r.step).toBe(0);
    const offset = p.first - r.first;
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(r.step);
    // 取り戻して pending に戻したジョブ (updated_at = 取り戻した時刻) を、同じ間隔の中で拾える
    expect(offset).toBeGreaterThan(intervalMinutes(constantOf(invoke.body, 'c_min_pending_age')));
  });

  it('応答を待つ上限は、ジョブの間隔より短い (前の回と重ならない)', () => {
    const timeoutMs = Number(constantOf(invoke.body, 'c_timeout_ms'));
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThan(minuteField(pickupSchedule).step * SECONDS_PER_MINUTE * MS_PER_SECOND);
  });

  it('pg_cron が無い DB (cron.job が無い) では、ジョブの登録を飛ばす。cron.job を読む前に確かめる', () => {
    const guard = cronBlock.indexOf("to_regclass('cron.job')");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(cronBlock.indexOf('FROM cron.job'));
  });
});
