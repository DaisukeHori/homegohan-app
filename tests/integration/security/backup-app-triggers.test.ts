/**
 * #1765 DB バックアップの復元が、auth・storage の表のアプリのトリガーを作り直せること (ローカルの Supabase の実 DB)。
 * 設計 docs/design/cross/17-backup-automation.md §3.3 の「dump を流しても戻らないもの」・§4.8 の 5 と 7。
 * schema の dump は auth・storage のスキーマを除くので、#1757 (20261016243000) が auth.sessions / auth.users に付けた 4 本は
 * dump を流しても戻らない。scripts/baseline/build_restore_fixups.py が fixups.sql で作り直し、scripts/lib/backup-db.mjs の
 * appTriggerChecks が取得の時点と復元した DB を比べる。
 *
 * 確かめること:
 *   - snapshot_catalog.sql と同じ照会 (search_path は psql の postgres の既定 "$user", public, extensions) の定義を、
 *     isAppTrigger が「関数のスキーマが auth・storage の外か」と同じに見分ける (pg_get_triggerdef の本物の書き方で見分け方の前提を確かめる)。
 *     #1757 の 4 本はアプリのトリガー
 *   - build_app_trigger_sql の SQL は、同じ名前のトリガーがある DB では何もしない (auth の 4 本。postgres は auth の表のトリガーを
 *     DROP できないので、作り直しは public の試しの表で確かめる)・消えたトリガーを同じ定義で作り直す・2 回流しても 1 本のまま
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/backup-app-triggers.test.ts
 * 本番には接続しない。python3 を子プロセスで起こす (補いの SQL を作る本物の関数を呼ぶため)。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { AUTH_STORAGE_TRIGGERS_CSV, INTERNAL_TRIGGER_FUNCTION_SCHEMAS, TRIGGER_CSV_COLUMNS, isAppTrigger } from '../../../scripts/lib/backup-db.mjs';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}

const ROOT = path.resolve(__dirname, '../../..');
/** ローカルスタックの Kong -> postgres-meta が最初の 1 回だけ 502 を返すことがある。DB の結果ではないので数回やり直す */
const GATEWAY_RETRIES = 3;
const RETRY_WAIT_MS = 150;
/** 取得 (psql の postgres) の search_path。pg_get_triggerdef はこれで見えない関数だけをスキーマつきで書く */
const CAPTURE_SEARCH_PATH = '"$user", public, extensions';
/** #1757 (20261016243000_auth_history_sessions.sql) が auth の表に付けたトリガー */
const AUTH_APP_TRIGGER_KEYS = [
  'auth.sessions.on_auth_session_created',
  'auth.sessions.on_auth_session_deleted',
  'auth.sessions.on_auth_session_refreshed',
  'auth.users.on_auth_user_password_changed',
];
const RUN_MARK = `${Date.now()}`;
const PROBE_TABLE = `it_backup_trigger_probe_${RUN_MARK}`;
const PROBE_FUNCTION = `it_backup_trigger_probe_fn_${RUN_MARK}`;
const PROBE_TRIGGER = 'it_backup_trigger_probe_trg';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sqlLiteral = (text: string) => `'${text.replace(/'/g, "''")}'`;

/** postgres-meta で SQL を流す (1 回の問い合わせの文は 1 つの暗黙の取引。最後の文の行が返る)。失敗は本文つきで投げる */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: { apikey: serviceKey as string, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.status === 502 && attempt < GATEWAY_RETRIES) {
      await sleep(RETRY_WAIT_MS * (attempt + 1));
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
    return body as T[];
  }
}

type TriggerRow = { schema: string; table_name: string; trigger_name: string; definition: string; function_schema: string };

/** snapshot_catalog.sql の catalog_auth_storage_triggers.csv と同じ照会 (search_path を取得と同じにして・関数のスキーマを足して) */
async function triggersOn(schemas: string[]): Promise<TriggerRow[]> {
  return pgQuery<TriggerRow>(
    `SELECT pg_catalog.set_config('search_path', ${sqlLiteral(CAPTURE_SEARCH_PATH)}, true); ` +
      'SELECT n.nspname AS schema, c.relname AS table_name, t.tgname AS trigger_name, pg_get_triggerdef(t.oid) AS definition, ' +
      'fn.nspname AS function_schema FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace fn ON fn.oid = p.pronamespace ' +
      `WHERE NOT t.tgisinternal AND n.nspname IN (${schemas.map(sqlLiteral).join(', ')}) ORDER BY 1, 2, 3;`,
  );
}

const tempDirs: string[] = [];

/** 行を catalog_auth_storage_triggers.csv の形で書き、build_restore_fixups.py の build_app_trigger_sql の出力を返す */
function appTriggerSql(rows: TriggerRow[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-app-triggers-'));
  tempDirs.push(dir);
  const quote = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  const lines = [TRIGGER_CSV_COLUMNS.join(','), ...rows.map((r) => [r.schema, r.table_name, r.trigger_name, r.definition].map(quote).join(','))];
  fs.writeFileSync(path.join(dir, AUTH_STORAGE_TRIGGERS_CSV), `${lines.join('\n')}\n`);
  const program =
    'import pathlib, sys\n' +
    "sys.path.insert(0, 'scripts/baseline')\n" +
    'from build_restore_fixups import build_app_trigger_sql\n' +
    'sys.stdout.write(build_app_trigger_sql(pathlib.Path(sys.argv[1])))\n';
  const r = spawnSync('python3', ['-c', program, dir], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build_app_trigger_sql: ${r.status} ${r.stderr}`);
  return r.stdout;
}

/** 補いの SQL を流す (set_config(…, false) が postgres-meta の接続に残らないよう、同じ問い合わせの最後で search_path を戻す) */
async function runFixupSql(sql: string) {
  await pgQuery(`${sql}\nRESET search_path;`);
}

afterAll(async () => {
  await pgQuery(`DROP TABLE IF EXISTS public.${PROBE_TABLE}; DROP FUNCTION IF EXISTS public.${PROBE_FUNCTION}();`);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('DB バックアップの復元: auth・storage の表のアプリのトリガー (#1765・#1757)', () => {
  it('isAppTrigger は本物の pg_get_triggerdef の定義を「関数のスキーマが auth・storage の外か」と同じに見分け、#1757 の 4 本はアプリ', async () => {
    const rows = await triggersOn(['auth', 'storage']);
    expect(rows.length).toBeGreaterThan(AUTH_APP_TRIGGER_KEYS.length);
    for (const row of rows) {
      const expected = !INTERNAL_TRIGGER_FUNCTION_SCHEMAS.includes(row.function_schema);
      expect(isAppTrigger(row.definition), `${row.schema}.${row.table_name}.${row.trigger_name}: ${row.definition}`).toBe(expected);
    }
    const app = rows.filter((r) => isAppTrigger(r.definition)).map((r) => `${r.schema}.${r.table_name}.${r.trigger_name}`);
    for (const key of AUTH_APP_TRIGGER_KEYS) expect(app).toContain(key);
  });

  it('auth の 4 本がある DB では補いの SQL は何もしない (同じ名前があれば作らない)・定義はそのまま', async () => {
    const before = (await triggersOn(['auth'])).filter((r) => isAppTrigger(r.definition));
    const sql = appTriggerSql(before);
    expect(sql.match(/^DO \$restore_trigger\$/gm)).toHaveLength(before.length);
    await runFixupSql(sql);
    const after = (await triggersOn(['auth'])).filter((r) => isAppTrigger(r.definition));
    expect(after).toEqual(before);
  });

  it('消えたトリガーを取得の時点の定義で作り直し、もう一度流しても 1 本のまま (public の試しの表)', async () => {
    await pgQuery(
      `CREATE TABLE public.${PROBE_TABLE} (id integer, note text); ` +
        `CREATE FUNCTION public.${PROBE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $probe$ BEGIN RETURN NEW; END $probe$; ` +
        `CREATE TRIGGER ${PROBE_TRIGGER} AFTER INSERT OR UPDATE OF note ON public.${PROBE_TABLE} FOR EACH ROW ` +
        `WHEN (NEW.note IS DISTINCT FROM 'x,y') EXECUTE FUNCTION public.${PROBE_FUNCTION}();`,
    );
    const captured = (await triggersOn(['public'])).filter((r) => r.table_name === PROBE_TABLE);
    expect(captured).toHaveLength(1);
    expect(isAppTrigger(captured[0].definition)).toBe(true);
    const sql = appTriggerSql(captured);
    await pgQuery(`DROP TRIGGER ${PROBE_TRIGGER} ON public.${PROBE_TABLE};`);
    expect((await triggersOn(['public'])).filter((r) => r.table_name === PROBE_TABLE)).toHaveLength(0);
    await runFixupSql(sql);
    expect((await triggersOn(['public'])).filter((r) => r.table_name === PROBE_TABLE)).toEqual(captured);
    await runFixupSql(sql);
    expect((await triggersOn(['public'])).filter((r) => r.table_name === PROBE_TABLE)).toEqual(captured);
  });
});
