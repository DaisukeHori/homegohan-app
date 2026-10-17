/**
 * #1560 (項目 8) cron の共有シークレットのずれの自動検知の DB 側 (段 B) の結合テスト
 *
 * 設計 docs/design/operator/12-cron-secret-drift-monitor.md §5・§11.3。migration 20261018030000_cron_secret_drift_monitor.sql は次を作る:
 *   - 表 public.cron_secret_probes: 送った確認の記録 (id / requested_at / send_state / request_id)。どのロールにも表の権限が無い
 *   - public.send_cron_secret_probe(): 24 時間より古い記録を消し、Vault の app_cron_secret を Bearer に付けて Edge Function
 *     cron-secret-probe を pg_net で 1 回呼ぶ。(probe_id, send_state, request_id) を返す
 *   - public.cron_secret_probe_results(p_lookback_minutes, p_limit): 記録に net._http_response を要求 ID で突き合わせた、判定に要る項目だけ
 *   - public.cron_secret_probe_body_json(p_content): 応答の本文を JSON として読む補助 (誰にも EXECUTE を付けない)
 *
 * 確認すること (ローカル Supabase の DB で):
 *   A-1. 表は anon / authenticated / service_role から直接読み書きできない (42501)。send / results は service_role だけ、body_json は誰も呼べない
 *   B-1〜B-4. send: Vault の状態ごとの send_state・pg_net の待ち行列に積まれる要求の中身・古い記録の掃除・復号できない秘密
 *   C-1〜C-3. results: 見る範囲と新しい順・引数の範囲・応答 (net._http_response) の突き合わせ・本文の読み方
 *   F-1. rollback で関数 3 本と表が消え (ops_alert_state の行は残り)、もう一度 migration を流すと戻る
 *
 * 本番には接続しない。send の呼び先は本番の URL に固定されている (差し替えられない) ので、send を呼ぶ B は 1 つのトランザクションの中で呼び、
 * 結果を取り出して最後に例外でロールバックする (pg_net の待ち行列 net.http_request_queue への行はコミットされないので、何も送られない。
 * テスト用に作った Vault の値・記録の行・偽の応答もロールバックで消える)。
 *
 * SQL は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。複数の文を 1 回の要求で流すと 1 つのトランザクションになる。
 * migration と同じ postgres ロールで流す (SET LOCAL ROLE postgres)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/cron-secret-drift-monitor.test.ts
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations');
const ROLLBACKS_DIR = path.join(REPO_ROOT, 'supabase/rollbacks');
const MIGRATION_SUFFIX = '_cron_secret_drift_monitor.sql';

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(MIGRATION_SUFFIX));
if (migrationFiles.length !== 1) {
  throw new Error(`supabase/migrations に *${MIGRATION_SUFFIX} がちょうど 1 つ要ります (${migrationFiles.length} 個)。`);
}
const MIGRATION_FILE = migrationFiles[0];
const MIGRATION_SQL = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
const ROLLBACK_SQL = fs.readFileSync(path.join(ROLLBACKS_DIR, MIGRATION_FILE.replace(/\.sql$/, '.down.sql')), 'utf8');

const TABLE = 'public.cron_secret_probes';
const SEND_SIGNATURE = 'public.send_cron_secret_probe()';
const RESULTS_SIGNATURE = 'public.cron_secret_probe_results(integer,integer)';
const BODY_JSON_SIGNATURE = 'public.cron_secret_probe_body_json(text)';
const VAULT_SECRET_NAME = 'app_cron_secret';
const VAULT_TEST_DESCRIPTION = 'i1560 integration test (rolled back)';

/** 呼び先 (設計 §5.2 の c_url)。本番のプロジェクトの Edge Function に固定されている */
const EDGE_FUNCTION_URL = 'https://flmeolcfutuwwbjmzyoz.supabase.co/functions/v1/cron-secret-probe';
/** pg_net が応答を待つ上限 (ミリ秒)。migration の c_timeout_ms と同じ (設計 §5.2) */
const EXPECTED_TIMEOUT_MS = 15000;
/** 偽の応答に使う pg_net の要求 ID (本物の要求 ID は小さい連番なので重ならない) */
const FAKE_REQUEST_ID_BASE = 9_100_000_000;
/** 本文の項目を返す長さの上限 (migration の c_body_field_max_length) */
const BODY_FIELD_MAX_LENGTH = 64;
/** ロールバックさせる例外の目印 (この後ろに結果の JSON を付ける) */
const RESULT_MARK = 'I1560_RESULT:';
/** results に渡す、見る範囲の既定 (アプリの CRON_SECRET_PROBE_LOOKBACK_MINUTES と同じ値) と行数 */
const LOOKBACK_MINUTES = 60;
const RESULT_LIMIT = 8;
/** 範囲の外の引数 (設計 §5.2: 分は 15〜360、行数は 1〜50) */
const INVALID_LOOKBACKS = [14, 361];
const INVALID_LIMITS = [0, 51];

type PgResult =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; status: number; message: string };

/** ローカルスタックの postgres-meta で SQL を流す。失敗は例外にせず、エラー文を返す */
async function pgQueryRaw(query: string): Promise<PgResult> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
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

/**
 * DO ブロックの中身 (plpgsql) を postgres ロールで流し、RAISE EXCEPTION RESULT_MARK で返された JSON を取り出す。
 * 例外でトランザクションごとロールバックされる (Vault・記録・偽の応答・pg_net の待ち行列の行が残らない)。
 * ロールバックのための例外以外で失敗したら、そのエラーを返す
 */
async function runInRolledBackTransaction<T>(plpgsql: string, declare = ''): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const result = await pgQueryRaw(`
    SET LOCAL ROLE postgres;
    DO $test$
    DECLARE
      ${declare}
    BEGIN
      ${plpgsql}
    END
    $test$;
  `);
  if (result.ok) return { ok: false, message: 'ロールバックのための例外で終わらなかった' };
  const at = result.message.indexOf(RESULT_MARK);
  if (at < 0) return { ok: false, message: result.message };
  return { ok: true, value: JSON.parse(result.message.slice(at + RESULT_MARK.length)) as T };
}

function mustBeOk<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Vault にテスト用の秘密を作る SQL (app_cron_secret の既存の行は先に消す。ロールバックで元に戻る) */
function createVaultSecretSql(secret: string): string {
  return `
    DELETE FROM vault.secrets WHERE name = ${lit(VAULT_SECRET_NAME)};
    PERFORM vault.create_secret(${lit(secret)}, ${lit(VAULT_SECRET_NAME)}, ${lit(VAULT_TEST_DESCRIPTION)});
  `;
}

async function queuedRequestCount(): Promise<number> {
  const rows = await asPostgres(`SELECT count(*)::int AS n FROM net.http_request_queue;`);
  return Number(rows[0].n);
}

let canInsertFakeResponse = false;

beforeAll(async () => {
  const rows = await pgQuery(
    `SELECT to_regclass(${lit(TABLE)})::text AS probes, to_regprocedure(${lit(SEND_SIGNATURE)})::text AS send_fn,
            to_regprocedure(${lit(RESULTS_SIGNATURE)})::text AS results_fn, to_regprocedure(${lit(BODY_JSON_SIGNATURE)})::text AS body_fn,
            to_regclass('net.http_request_queue')::text AS queue, to_regclass('net._http_response')::text AS response,
            to_regclass('vault.secrets')::text AS vault;`,
  );
  if (!rows[0]?.probes || !rows[0]?.send_fn || !rows[0]?.results_fn || !rows[0]?.body_fn) {
    throw new Error(`${TABLE} / 関数 3 本がありません。${MIGRATION_FILE} がローカル DB に適用されていません。`);
  }
  if (!rows[0]?.queue || !rows[0]?.response || !rows[0]?.vault) {
    throw new Error('net.http_request_queue / net._http_response / vault.secrets がありません。ローカル DB に pg_net / Vault が入っていません。');
  }
  // 設計 §16 の 1: postgres ロールが net._http_response に INSERT できるか (できなければ C-2 は本文の突き合わせを飛ばす)
  const privilege = await pgQuery(`SELECT has_table_privilege('postgres', 'net._http_response', 'INSERT') AS can_insert;`);
  canInsertFakeResponse = privilege[0]?.can_insert === true;
}, 30_000);

// ---------------------------------------------------------------
// A. 権限
// ---------------------------------------------------------------
describe('#1560 A. 表と関数の権限', () => {
  it.each(['anon', 'authenticated', 'service_role'])(
    'A-1: %s は表を直接読み書きできない (42501)',
    async (role) => {
      for (const statement of [
        `SELECT count(*) FROM ${TABLE}`,
        `INSERT INTO ${TABLE} (send_state) VALUES ('sent')`,
        `UPDATE ${TABLE} SET send_state = 'sent'`,
        `DELETE FROM ${TABLE}`,
      ]) {
        const result = await pgQueryRaw(`SET LOCAL ROLE ${role};\n${statement};`);
        expect(result.ok, `${role}: ${statement}`).toBe(false);
        if (result.ok) continue;
        expect(result.message, `${role}: ${statement}`).toContain('permission denied');
      }
      const privileges = await pgQuery(
        `SELECT p AS privilege, has_table_privilege(${lit(role)}, ${lit(TABLE)}, p) AS granted
           FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p;`,
      );
      expect(privileges.filter((row) => row.granted === true)).toEqual([]);
    },
  );

  it('A-1: send / results は service_role だけが EXECUTE でき、body_json は service_role でも 42501 (send はカタログで確かめ、呼ばない)', async () => {
    const rows = await pgQuery(`
      SELECT r AS role,
             has_function_privilege(r, ${lit(SEND_SIGNATURE)}, 'EXECUTE') AS send_execute,
             has_function_privilege(r, ${lit(RESULTS_SIGNATURE)}, 'EXECUTE') AS results_execute,
             has_function_privilege(r, ${lit(BODY_JSON_SIGNATURE)}, 'EXECUTE') AS body_json_execute
        FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r
       ORDER BY r;
    `);
    expect(rows).toEqual([
      { role: 'anon', send_execute: false, results_execute: false, body_json_execute: false },
      { role: 'authenticated', send_execute: false, results_execute: false, body_json_execute: false },
      { role: 'service_role', send_execute: true, results_execute: true, body_json_execute: false },
    ]);

    // PUBLIC にも付いていない (anon / authenticated はこの検査で PUBLIC の分も受け取る)
    const publicGrants = await pgQuery(`
      SELECT p.proname
        FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('send_cron_secret_probe', 'cron_secret_probe_results', 'cron_secret_probe_body_json')
         AND a.grantee = 0
       ORDER BY p.proname;
    `);
    expect(publicGrants).toEqual([]);

    // service_role が実際に results を呼べる (空でも 12 列の表が返る)。body_json は 42501
    const called = await pgQuery(`SET LOCAL ROLE service_role;\nSELECT count(*)::int AS n FROM public.cron_secret_probe_results(${LOOKBACK_MINUTES}, ${RESULT_LIMIT});`);
    expect(Number(called[0].n)).toBeGreaterThanOrEqual(0);
    const denied = await pgQueryRaw(`SET LOCAL ROLE service_role;\nSELECT public.cron_secret_probe_body_json('{}');`);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.message).toContain('permission denied');
  });

  it('A-1: 関数 2 本は SECURITY DEFINER・所有者 postgres・search_path が空。body_json は SECURITY DEFINER でなく IMMUTABLE', async () => {
    const rows = await pgQuery(`
      SELECT p.proname, p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config, p.provolatile AS volatility
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('send_cron_secret_probe', 'cron_secret_probe_results', 'cron_secret_probe_body_json')
       ORDER BY p.proname;
    `);
    expect(rows).toEqual([
      { proname: 'cron_secret_probe_body_json', security_definer: false, owner: 'postgres', config: ['search_path=""'], volatility: 'i' },
      { proname: 'cron_secret_probe_results', security_definer: true, owner: 'postgres', config: ['search_path=""'], volatility: 's' },
      { proname: 'send_cron_secret_probe', security_definer: true, owner: 'postgres', config: ['search_path=""'], volatility: 'v' },
    ]);
  });
});

// ---------------------------------------------------------------
// B. send_cron_secret_probe
// ---------------------------------------------------------------
interface SendResult {
  probe_id: number;
  send_state: string;
  request_id: number | null;
}

interface QueuedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeout_milliseconds: number;
}

describe('#1560 B. send_cron_secret_probe (どれもロールバックするので、本番へは送らない)', () => {
  it('B-1: Vault に app_cron_secret があるとき: sent・request_id を返し、記録の行の request_id が待ち行列の行の id と同じ。宛先・ヘッダー・本文・待ち時間が設計どおり', async () => {
    const secret = `i1560-test-${randomBytes(8).toString('hex')}`;
    const value = mustBeOk(
      await runInRolledBackTransaction<{
        sent: SendResult;
        row: { id: number; send_state: string; request_id: number | null };
        queued: QueuedRequest | null;
        queued_count: number;
      }>(
        `
        ${createVaultSecretSql(secret)}
        SELECT * INTO v_sent FROM public.send_cron_secret_probe();
        SELECT to_jsonb(p) INTO v_row FROM public.cron_secret_probes AS p WHERE p.id = v_sent.probe_id;
        SELECT jsonb_build_object(
                 'method', q.method, 'url', q.url, 'headers', q.headers,
                 'body', convert_from(q.body, 'UTF8')::jsonb, 'timeout_milliseconds', q.timeout_milliseconds)
          INTO v_queued
          FROM net.http_request_queue AS q
         WHERE q.id = v_sent.request_id;
        SELECT count(*) INTO v_queued_count FROM net.http_request_queue AS q WHERE q.id = v_sent.request_id;
        RAISE EXCEPTION '${RESULT_MARK}%', jsonb_build_object(
          'sent', jsonb_build_object('probe_id', v_sent.probe_id, 'send_state', v_sent.send_state, 'request_id', v_sent.request_id),
          'row', v_row, 'queued', v_queued, 'queued_count', v_queued_count);
        `,
        `v_sent record; v_row jsonb; v_queued jsonb; v_queued_count integer;`,
      ),
    );

    expect(value.sent.send_state).toBe('sent');
    expect(value.sent.request_id).not.toBeNull();
    expect(value.row).toMatchObject({ id: value.sent.probe_id, send_state: 'sent', request_id: value.sent.request_id });
    expect(value.queued_count).toBe(1);
    expect(value.queued).not.toBeNull();
    const queued = value.queued!;
    expect(queued.method).toBe('POST');
    expect(queued.url).toBe(EDGE_FUNCTION_URL);
    expect(queued.headers).toMatchObject({ Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' });
    expect(queued.body).toEqual({ probe_id: value.sent.probe_id });
    expect(queued.timeout_milliseconds).toBe(EXPECTED_TIMEOUT_MS);

    // ロールバックされたので、テスト用の Vault の値は残っていない
    const leftovers = await asPostgres(`SELECT count(*)::int AS n FROM vault.secrets WHERE description = ${lit(VAULT_TEST_DESCRIPTION)};`);
    expect(Number(leftovers[0].n)).toBe(0);
  });

  it('B-2: Vault に無いとき: vault_missing・request_id NULL を返し、待ち行列に行を積まない。空文字の秘密なら vault_empty', async () => {
    const value = mustBeOk(
      await runInRolledBackTransaction<{ missing: SendResult; empty: SendResult; queued_delta: number; probe_rows: number }>(
        `
        SELECT count(*) INTO v_queue_before FROM net.http_request_queue;
        DELETE FROM vault.secrets WHERE name = ${lit(VAULT_SECRET_NAME)};
        SELECT * INTO v_missing FROM public.send_cron_secret_probe();
        PERFORM vault.create_secret('', ${lit(VAULT_SECRET_NAME)}, ${lit(VAULT_TEST_DESCRIPTION)});
        SELECT * INTO v_empty FROM public.send_cron_secret_probe();
        SELECT count(*) INTO v_queue_after FROM net.http_request_queue;
        SELECT count(*) INTO v_probe_rows FROM public.cron_secret_probes AS p WHERE p.id IN (v_missing.probe_id, v_empty.probe_id);
        RAISE EXCEPTION '${RESULT_MARK}%', jsonb_build_object(
          'missing', jsonb_build_object('probe_id', v_missing.probe_id, 'send_state', v_missing.send_state, 'request_id', v_missing.request_id),
          'empty', jsonb_build_object('probe_id', v_empty.probe_id, 'send_state', v_empty.send_state, 'request_id', v_empty.request_id),
          'queued_delta', v_queue_after - v_queue_before, 'probe_rows', v_probe_rows);
        `,
        `v_missing record; v_empty record; v_queue_before bigint; v_queue_after bigint; v_probe_rows integer;`,
      ),
    );

    expect(value.missing).toMatchObject({ send_state: 'vault_missing', request_id: null });
    expect(value.empty).toMatchObject({ send_state: 'vault_empty', request_id: null });
    // 送れなかった確認も記録の行になり、待ち行列には 1 行も積まない
    expect(value.probe_rows).toBe(2);
    expect(value.queued_delta).toBe(0);
  });

  it('B-3: 24 時間より古い自分の行を消し、新しい行は残す', async () => {
    const value = mustBeOk(
      await runInRolledBackTransaction<{ old_remaining: number; recent_remaining: number; new_remaining: number }>(
        `
        DELETE FROM vault.secrets WHERE name = ${lit(VAULT_SECRET_NAME)};
        INSERT INTO public.cron_secret_probes (requested_at, send_state)
          VALUES (pg_catalog.now() - interval '25 hours', 'sent') RETURNING id INTO v_old_id;
        INSERT INTO public.cron_secret_probes (requested_at, send_state)
          VALUES (pg_catalog.now() - interval '23 hours', 'sent') RETURNING id INTO v_recent_id;
        SELECT * INTO v_sent FROM public.send_cron_secret_probe();
        RAISE EXCEPTION '${RESULT_MARK}%', jsonb_build_object(
          'old_remaining', (SELECT count(*) FROM public.cron_secret_probes AS p WHERE p.id = v_old_id),
          'recent_remaining', (SELECT count(*) FROM public.cron_secret_probes AS p WHERE p.id = v_recent_id),
          'new_remaining', (SELECT count(*) FROM public.cron_secret_probes AS p WHERE p.id = v_sent.probe_id));
        `,
        `v_old_id bigint; v_recent_id bigint; v_sent record;`,
      ),
    );

    expect(value).toEqual({ old_remaining: 0, recent_remaining: 1, new_remaining: 1 });
  });

  it('B-4: 行はあるが復号できないとき: 例外にならず vault_unreadable・request_id NULL を返し、待ち行列に行を積まない。記録の行が 1 つ増える', async (context) => {
    // 前提 (設計 §16 の 5): postgres ロールが vault.secrets の secret を UPDATE できる。できなければ、この検査は飛ばす (例外の受け口は契約 CT-18 が受け持つ)
    const result = await runInRolledBackTransaction<{ sent: SendResult; queued_delta: number; probe_rows_delta: number }>(
      `
      ${createVaultSecretSql(`i1560-test-${randomBytes(8).toString('hex')}`)}
      -- 暗号文を別のバイト列 (base64) に書き換える。復号は失敗する
      UPDATE vault.secrets SET secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE name = ${lit(VAULT_SECRET_NAME)};
      SELECT count(*) INTO v_queue_before FROM net.http_request_queue;
      SELECT count(*) INTO v_probes_before FROM public.cron_secret_probes;
      SELECT * INTO v_sent FROM public.send_cron_secret_probe();
      SELECT count(*) INTO v_queue_after FROM net.http_request_queue;
      SELECT count(*) INTO v_probes_after FROM public.cron_secret_probes;
      RAISE EXCEPTION '${RESULT_MARK}%', jsonb_build_object(
        'sent', jsonb_build_object('probe_id', v_sent.probe_id, 'send_state', v_sent.send_state, 'request_id', v_sent.request_id),
        'queued_delta', v_queue_after - v_queue_before, 'probe_rows_delta', v_probes_after - v_probes_before);
      `,
      `v_sent record; v_queue_before bigint; v_queue_after bigint; v_probes_before bigint; v_probes_after bigint;`,
    );
    if (!result.ok && /permission denied|must be owner/i.test(result.message)) {
      context.skip();
      return;
    }
    const value = mustBeOk(result);

    expect(value.sent).toMatchObject({ send_state: 'vault_unreadable', request_id: null });
    expect(value.queued_delta).toBe(0);
    expect(value.probe_rows_delta).toBe(1);
  });

  it('send を呼んだあとも、ロールバックのおかげで待ち行列と Vault が元のまま (テスト自身の後始末の確認)', async () => {
    const before = await queuedRequestCount();
    mustBeOk(
      await runInRolledBackTransaction<{ n: number }>(
        `
        DELETE FROM vault.secrets WHERE name = ${lit(VAULT_SECRET_NAME)};
        PERFORM public.send_cron_secret_probe();
        RAISE EXCEPTION '${RESULT_MARK}%', jsonb_build_object('n', 1);
        `,
      ),
    );
    expect(await queuedRequestCount()).toBe(before);
    const rows = await asPostgres(`SELECT count(*)::int AS n FROM ${TABLE};`);
    expect(Number(rows[0].n)).toBe(0);
  });
});

// ---------------------------------------------------------------
// C. cron_secret_probe_results / cron_secret_probe_body_json
// ---------------------------------------------------------------
interface ResultRow {
  probe_id: number;
  requested_at: string;
  send_state: string;
  answered: boolean;
  http_status: number | null;
  timed_out: boolean | null;
  has_error: boolean | null;
  matched: string | null;
  previous_configured: boolean | null;
  alias_used: boolean | null;
  body_error: string | null;
  body_code: string | null;
}

describe('#1560 C. cron_secret_probe_results', () => {
  it('C-1: 見る範囲の行を新しい順に p_limit 行まで返し、応答の無い行は answered false・ほかの項目 NULL', async () => {
    const value = mustBeOk(
      await runInRolledBackTransaction<{ rows: ResultRow[]; limited: ResultRow[]; wide: ResultRow[]; ids: number[] }>(
        `
        INSERT INTO public.cron_secret_probes (requested_at, send_state, request_id) VALUES (pg_catalog.now() - interval '50 minutes', 'sent', ${FAKE_REQUEST_ID_BASE + 1}) RETURNING id INTO v_a;
        INSERT INTO public.cron_secret_probes (requested_at, send_state) VALUES (pg_catalog.now() - interval '30 minutes', 'vault_missing') RETURNING id INTO v_b;
        INSERT INTO public.cron_secret_probes (requested_at, send_state, request_id) VALUES (pg_catalog.now() - interval '10 minutes', 'sent', ${FAKE_REQUEST_ID_BASE + 2}) RETURNING id INTO v_c;
        -- 見る範囲 (60 分) の外
        INSERT INTO public.cron_secret_probes (requested_at, send_state) VALUES (pg_catalog.now() - interval '90 minutes', 'vault_empty') RETURNING id INTO v_old;
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.requested_at DESC, r.probe_id DESC) INTO v_rows
          FROM public.cron_secret_probe_results(${LOOKBACK_MINUTES}, ${RESULT_LIMIT}) AS r;
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.requested_at DESC, r.probe_id DESC) INTO v_limited
          FROM public.cron_secret_probe_results(${LOOKBACK_MINUTES}, 2) AS r;
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.requested_at DESC, r.probe_id DESC) INTO v_wide
          FROM public.cron_secret_probe_results(120, ${RESULT_LIMIT}) AS r;
        RAISE EXCEPTION '${RESULT_MARK}%', jsonb_build_object('rows', v_rows, 'limited', v_limited, 'wide', v_wide, 'ids', jsonb_build_array(v_a, v_b, v_c, v_old));
        `,
        `v_a bigint; v_b bigint; v_c bigint; v_old bigint; v_rows jsonb; v_limited jsonb; v_wide jsonb;`,
      ),
    );

    const [a, b, c, old] = value.ids;
    // 範囲の中の 3 行が新しい順 (c → b → a)。範囲の外の行は返さない
    expect(value.rows.map((row) => row.probe_id)).toEqual([c, b, a]);
    // 応答が無いので、どの行も answered false で、応答に由来する項目は NULL
    for (const row of value.rows) {
      expect(row.answered).toBe(false);
      expect(row).toMatchObject({
        http_status: null,
        timed_out: null,
        has_error: null,
        matched: null,
        previous_configured: null,
        alias_used: null,
        body_error: null,
        body_code: null,
      });
    }
    expect(value.rows.map((row) => row.send_state)).toEqual(['sent', 'vault_missing', 'sent']);
    // p_limit で件数を絞ると新しい方から
    expect(value.limited.map((row) => row.probe_id)).toEqual([c, b]);
    // 範囲を広げると、90 分前の行も入る
    expect(value.wide.map((row) => row.probe_id)).toEqual([c, b, a, old]);
  });

  it.each(
    [
      ...INVALID_LOOKBACKS.map((lookback) => [`p_lookback_minutes ${lookback}`, lookback, RESULT_LIMIT, 'invalid lookback'] as const),
      ...INVALID_LIMITS.map((limit) => [`p_limit ${limit}`, LOOKBACK_MINUTES, limit, 'invalid limit'] as const),
    ],
  )('C-1: %s は 22023 (引数が範囲の外)', async (_label, lookback, limit, expected) => {
    const result = await pgQueryRaw(`SET LOCAL ROLE postgres;\nSELECT * FROM public.cron_secret_probe_results(${lookback}, ${limit});`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(`cron_secret_probe_results: ${expected}`);
  });

  it('C-1: p_lookback_minutes・p_limit が NULL なら 22023', async () => {
    for (const args of ['NULL, 8', '60, NULL']) {
      const result = await pgQueryRaw(`SET LOCAL ROLE postgres;\nSELECT * FROM public.cron_secret_probe_results(${args});`);
      expect(result.ok, args).toBe(false);
      if (!result.ok) expect(result.message).toContain('cron_secret_probe_results: invalid');
    }
  });

  it('C-2: net._http_response の行を要求 ID で突き合わせる (本文の項目は設計 §5.2 のとおり。64 字で切れる。自分の要求 ID の応答だけ)', async (context) => {
    // 前提 (設計 §16 の 1): postgres ロールが net._http_response に INSERT できる。できなければ、本文の突き合わせは単体 (J-1〜J-23) と契約 CT-7 に任せる
    if (!canInsertFakeResponse) {
      context.skip();
      return;
    }
    const longMatched = 'x'.repeat(BODY_FIELD_MAX_LENGTH + 36);
    // [要求 ID の番号, 状態コード, 本文, 時間切れ, error_msg]
    const responses: Array<[number, number | null, string | null, boolean, string | null]> = [
      [1, 200, '{"ok":true,"matched":"current","previous_configured":true,"alias_used":false}', false, null],
      [2, 401, '{"error":"Unauthorized"}', false, null],
      [3, 401, '{"code":"UNAUTHORIZED_INVALID_JWT_FORMAT","message":"Invalid JWT"}', false, null],
      [4, 502, '<html>Bad Gateway</html>', false, null],
      [5, null, null, true, 'Timeout of 15000 ms reached'],
      [6, 200, `{"ok":true,"matched":"${longMatched}"}`, false, null],
      [7, 200, '{"ok":true,"matched":"previous","previous_configured":"yes","alias_used":1}', false, null],
    ];
    const insertResponses = responses
      .map(([n, status, content, timedOut, errorMsg]) => {
        const requestId = FAKE_REQUEST_ID_BASE + n;
        return `INSERT INTO net._http_response (id, status_code, content, timed_out, error_msg)
                  VALUES (${requestId}, ${status === null ? 'NULL' : status}, ${content === null ? 'NULL' : lit(content)}, ${timedOut}, ${errorMsg === null ? 'NULL' : lit(errorMsg)});
                INSERT INTO public.cron_secret_probes (requested_at, send_state, request_id)
                  VALUES (pg_catalog.now() - interval '${n} minutes', 'sent', ${requestId});`;
      })
      .join('\n');

    const value = mustBeOk(
      await runInRolledBackTransaction<{ rows: ResultRow[] }>(
        `
        ${insertResponses}
        -- 記録の無い要求 ID の応答 (他の用途の pg_net の応答) は返らない
        INSERT INTO net._http_response (id, status_code, content, timed_out)
          VALUES (${FAKE_REQUEST_ID_BASE + 99}, 200, '{"ok":true,"matched":"current"}', false);
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.requested_at DESC, r.probe_id DESC) INTO v_rows
          FROM public.cron_secret_probe_results(${LOOKBACK_MINUTES}, ${RESULT_LIMIT}) AS r;
        RAISE EXCEPTION '${RESULT_MARK}%', jsonb_build_object('rows', v_rows);
        `,
        `v_rows jsonb;`,
      ),
    );

    // 新しい順 = 要求の番号の小さい順 (1 分前, 2 分前, …)
    expect(value.rows).toHaveLength(responses.length);
    const [r1, r2, r3, r4, r5, r6, r7] = value.rows;

    expect(r1).toMatchObject({
      answered: true,
      http_status: 200,
      timed_out: false,
      has_error: false,
      matched: 'current',
      previous_configured: true,
      alias_used: false,
      body_error: null,
      body_code: null,
    });
    expect(r2).toMatchObject({ answered: true, http_status: 401, matched: null, previous_configured: null, alias_used: null, body_error: 'Unauthorized', body_code: null });
    expect(r3).toMatchObject({ answered: true, http_status: 401, matched: null, body_error: null, body_code: 'UNAUTHORIZED_INVALID_JWT_FORMAT' });
    // JSON でない本文: 状態コードだけ返り、本文由来の項目は NULL (例外にしない)
    expect(r4).toMatchObject({
      answered: true,
      http_status: 502,
      matched: null,
      previous_configured: null,
      alias_used: null,
      body_error: null,
      body_code: null,
    });
    // 時間切れ: 状態コード NULL・timed_out true・error_msg は有無だけ (本文は返さない)
    expect(r5).toMatchObject({ answered: true, http_status: null, timed_out: true, has_error: true, matched: null });
    // 本文の項目は 64 字で切れる
    expect(r6.matched).toBe(longMatched.slice(0, BODY_FIELD_MAX_LENGTH));
    expect(r6.matched).toHaveLength(BODY_FIELD_MAX_LENGTH);
    // boolean でない previous_configured / alias_used は NULL (型が違う値を読み違えない)
    expect(r7).toMatchObject({ matched: 'previous', previous_configured: null, alias_used: null });

    // 返る列は設計の 12 列だけ (error_msg・headers・本文そのものは無い)
    expect(Object.keys(r1).sort()).toEqual(
      [
        'probe_id',
        'requested_at',
        'send_state',
        'answered',
        'http_status',
        'timed_out',
        'has_error',
        'matched',
        'previous_configured',
        'alias_used',
        'body_error',
        'body_code',
      ].sort(),
    );
    expect(JSON.stringify(value.rows)).not.toContain('Timeout of 15000 ms reached');
  });
});

describe('#1560 C-3. cron_secret_probe_body_json', () => {
  it('JSON でない文字列・空文字・NULL で NULL を返し、例外にしない。JSON はそのまま JSONB で返す (postgres ロールで直接呼ぶ)', async () => {
    const rows = await asPostgres(`
      SELECT public.cron_secret_probe_body_json(NULL) AS null_input,
             public.cron_secret_probe_body_json('') AS empty,
             public.cron_secret_probe_body_json('not json') AS not_json,
             public.cron_secret_probe_body_json('<html>Bad Gateway</html>') AS html,
             public.cron_secret_probe_body_json('{"ok":true,"matched":"current"}') AS object_body,
             public.cron_secret_probe_body_json('[1,2]') AS array_body;
    `);
    expect(rows).toEqual([
      {
        null_input: null,
        empty: null,
        not_json: null,
        html: null,
        object_body: { ok: true, matched: 'current' },
        array_body: [1, 2],
      },
    ]);
  });
});

// ---------------------------------------------------------------
// F. rollback
// ---------------------------------------------------------------
describe('#1560 F. rollback と流し直し', () => {
  it('F-1: rollback で関数 3 本と表が消え (ops_alert_state の行は残る)、もう一度 rollback しても同じ。もう一度 migration を流すと戻る', async () => {
    const snapshot = (name: string) => `
      CREATE TEMP TABLE ${name} AS
        SELECT (to_regclass(${lit(TABLE)}) IS NOT NULL) AS probes_table,
               (SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('send_cron_secret_probe', 'cron_secret_probe_results', 'cron_secret_probe_body_json')) AS functions,
               (SELECT count(*)::int FROM public.ops_alert_state s WHERE s.alert_key = 'cron_secret_drift') AS alert_rows;
    `;

    const result = await pgQueryRaw(`
      SET LOCAL ROLE postgres;
      INSERT INTO public.ops_alert_state (alert_key) VALUES ('cron_secret_drift') ON CONFLICT (alert_key) DO NOTHING;
      ${ROLLBACK_SQL}
      ${snapshot('f1_after_down')}
      ${ROLLBACK_SQL}
      ${snapshot('f1_after_down_again')}
      ${MIGRATION_SQL}
      ${snapshot('f1_after_up')}
      DO $test$
      BEGIN
        RAISE EXCEPTION '${RESULT_MARK}%', jsonb_build_object(
          'down', (SELECT to_jsonb(t) FROM f1_after_down t),
          'down_again', (SELECT to_jsonb(t) FROM f1_after_down_again t),
          'up', (SELECT to_jsonb(t) FROM f1_after_up t));
      END
      $test$;
    `);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message, 'ロールバックのための例外で終わること').toContain(RESULT_MARK);
    const json = JSON.parse(result.message.slice(result.message.indexOf(RESULT_MARK) + RESULT_MARK.length)) as Record<
      'down' | 'down_again' | 'up',
      { probes_table: boolean; functions: number; alert_rows: number }
    >;

    expect(json.down).toEqual({ probes_table: false, functions: 0, alert_rows: 1 });
    expect(json.down_again).toEqual({ probes_table: false, functions: 0, alert_rows: 1 });
    expect(json.up).toEqual({ probes_table: true, functions: 3, alert_rows: 1 });

    // 全部ロールバックされたので、本来の DB は migration 適用済みのまま
    const rows = await pgQuery(`SELECT (to_regclass(${lit(TABLE)}) IS NOT NULL) AS probes_table;`);
    expect(rows[0].probes_table).toBe(true);
  }, 30_000);
});
