/**
 * #1125 (B) 定期処理の失敗の監視 (migration 20261017220000_cron_failure_monitoring.sql・設計 operator/11 §5.1・§5.2・§11.1) の
 * ソース走査 contract テスト (DB には接続しない)。段 A (migration) と、段 B のアプリの定数 (src/lib/ops-alerts/cron-failure.ts) との突き合わせ。
 *
 * 実際の動き (数え方・印の付け外し・権限・rollback) は tests/integration/security/cron-failure-monitoring.test.ts で確かめる。
 * ここでは、DB を立てなくても通常のテストで止められる「書き方の取り決め」を固定する。
 *
 *   1. migration と rollback が同じ名前で対になっていて、1・2 行目の見出しと案内が正しい
 *   2. 候補の「内部エラーの文」は src/lib/api/errors.ts の INTERNAL_ERROR_LOG_MESSAGE と同じ
 *   3. 関数 5 本はどれも SECURITY DEFINER・search_path 空・参照が完全修飾・動的 SQL なし
 *   4. EXECUTE: counts / mark / unmark / pg_cron_last_run_at は service_role だけ。candidates は誰にも付けない (完全形の REVOKE)
 *   5. 台帳は RLS 有効・全拒否ポリシー・どのロールにも表の権限を付けない
 *   6. 候補は source <> client・level = error・cron の route 名の形だけを数え、見る範囲は 7 日 (= cron-failure.ts の CRON_FAILURE_LOOKBACK_DAYS)
 *   7. 段 A は cron.schedule を呼ばず、UPDATE を含まず、DELETE は台帳への 1 か所 (unmark) だけ
 *   8. migration が登録するジョブに、1 時間以内の間隔のものがある (cron-failure.ts の PG_CRON_STALL_MINUTES = 60 の前提)
 *   9. src/app/api/cron/*\/route.ts が createLogger / internalError に渡す名前は候補の LIKE と一致する形。vercel.json の crons のどれも走査に入る
 *  10. 台帳の source の CHECK は 'pg_cron' / 'vercel_cron' の 2 つで、候補が出す source もこの 2 つだけ
 *  11. src/lib/ops-alerts/cron-failure.ts の CRON_FAILURE_SOURCES は、台帳の source の CHECK と同じ (段 B。DB の CHECK にだけ出どころを
 *      足すと、アプリの normalizeCronFailureRows がその行を例外にして 500 になるので、ずれをここで止める)
 *  12. rollback が関数 5 本と台帳の DROP を行い、pg_cron のジョブと ops_alert_state には触れない
 *
 * アプリ側の値 (CRON_FAILURE_SOURCES・CRON_FAILURE_LOOKBACK_DAYS・PG_CRON_STALL_MINUTES) はここで書き直さず、cron-failure.ts から import して突き合わせる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { collectMigrationCronJobs, splitCallArguments, stripSqlComments } from './helpers/migration-cron-jobs';
import { CRON_FAILURE_LOOKBACK_DAYS, CRON_FAILURE_SOURCES, PG_CRON_STALL_MINUTES } from '../src/lib/ops-alerts/cron-failure';

const ROOT = path.resolve(__dirname, '..');
const VERSION = '20261017220000';
const NAME = 'cron_failure_monitoring';
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `${VERSION}_${NAME}.down.sql`;
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILE);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', ROLLBACK_FILE);
const ERRORS_TS_PATH = path.join(ROOT, 'src', 'lib', 'api', 'errors.ts');
const CRON_ROUTES_DIR = path.join(ROOT, 'src', 'app', 'api', 'cron');
const VERCEL_JSON_PATH = path.join(ROOT, 'vercel.json');

/** 関数 5 本 (migration の関数名 → 引数の型。rollback の DROP と GRANT/REVOKE の突き合わせに使う) */
const FUNCTIONS = {
  cron_failure_candidates: '',
  cron_failure_counts: 'INTEGER',
  mark_cron_failures_alerted: 'TIMESTAMPTZ, INTEGER',
  unmark_cron_failures_alerted: 'TIMESTAMPTZ',
  pg_cron_last_run_at: '',
} as const;
type FunctionName = keyof typeof FUNCTIONS;
const FUNCTION_NAMES = Object.keys(FUNCTIONS) as FunctionName[];
/** EXECUTE を service_role に付ける関数 (candidates は誰にも付けない) */
const SERVICE_ROLE_FUNCTIONS = FUNCTION_NAMES.filter((name) => name !== 'cron_failure_candidates');
/** REVOKE で外すロール (完全形。Supabase の自動の GRANT と PostgreSQL の PUBLIC を両方外す) */
const REVOKED_ROLES = 'PUBLIC, anon, authenticated, service_role';
const TABLE = 'public.cron_failure_alerts';

const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');
const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf-8');
const code = stripSqlComments(migration);
const rollbackCode = stripSqlComments(rollback);

/** 台帳 cron_failure_alerts の source の CHECK が許す値 (並べ替え済み) */
function ledgerSourceCheckValues(): string[] {
  const check = /source\s+TEXT\s+NOT NULL CHECK \(source IN \(([^)]*)\)\)/.exec(code);
  expect(check, '台帳の source の CHECK が無い').not.toBeNull();
  return [...(check as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
}

/** CREATE OR REPLACE FUNCTION public.<name>( から、本体の終わりの `END $$;` (または最後の `$$;`) まで */
function functionSource(name: FunctionName): { header: string; body: string; whole: string } {
  const start = code.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} の CREATE OR REPLACE FUNCTION が見つからない`).toBeGreaterThanOrEqual(0);
  const rest = code.slice(start);
  const opener = /\bAS\s+\$\$/.exec(rest);
  expect(opener, `${name}: AS $$ が見つからない`).not.toBeNull();
  const opened = opener as RegExpExecArray;
  const bodyStart = opened.index + opened[0].length;
  const bodyEnd = rest.indexOf('$$', bodyStart);
  expect(bodyEnd, `${name}: 本体の終わりの $$ が見つからない`).toBeGreaterThan(bodyStart);
  return {
    header: rest.slice(0, opened.index),
    body: rest.slice(bodyStart, bodyEnd),
    whole: rest.slice(0, bodyEnd + 2),
  };
}

/** `WITH a AS (` / `), b AS (` の形の CTE の名前 */
function cteNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(/(?:\bWITH|,)\s+([A-Za-z_]\w*)\s+AS\s*\(/gi)) names.add(match[1].toLowerCase());
  return names;
}

describe('#1125 (B) 定期処理の失敗の監視 (段 A の migration・段 B の定数との突き合わせ) のソース走査', () => {
  it('migration と rollback が同じ名前で対になっていて、1・2 行目の見出しと案内が正しい', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const migrationLines = migration.split('\n');
    expect(migrationLines[0]).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(migrationLines[1]).toBe(`-- 戻し方: supabase/rollbacks/${ROLLBACK_FILE}`);
    expect(rollback.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    // 版の番号が重ならない (同じ版の migration が 2 つあると片方しか当たらない)
    const sameVersion = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.startsWith(`${VERSION}_`));
    expect(sameVersion).toEqual([MIGRATION_FILE]);
  });

  it('cron_failure_candidates の c_internal_error_message は src/lib/api/errors.ts の INTERNAL_ERROR_LOG_MESSAGE と同じ文', () => {
    const sqlMatch = /c_internal_error_message\s+CONSTANT\s+text\s*:=\s*'([^']+)'/.exec(code);
    const tsMatch = /const\s+INTERNAL_ERROR_LOG_MESSAGE\s*=\s*'([^']+)'/.exec(fs.readFileSync(ERRORS_TS_PATH, 'utf-8'));
    expect(sqlMatch, 'migration に c_internal_error_message の定数が無い').not.toBeNull();
    expect(tsMatch, 'errors.ts に INTERNAL_ERROR_LOG_MESSAGE が無い').not.toBeNull();
    expect((sqlMatch as RegExpExecArray)[1]).toBe((tsMatch as RegExpExecArray)[1]);
    // 候補の条件は、この定数との等号で数える (2 つの枝の両方)
    expect(code.match(/l\.message\s*=\s*c_internal_error_message/g) ?? []).toHaveLength(2);
  });

  it('cron スキーマを読む関数は SECURITY DEFINER・search_path 空・参照が完全修飾・動的 SQL なし', () => {
    for (const name of FUNCTION_NAMES) {
      const { header, body, whole } = functionSource(name);
      expect(header, `${name}: SECURITY DEFINER`).toMatch(/\bSECURITY DEFINER\b/);
      expect(header, `${name}: SET search_path = ''`).toMatch(/SET search_path = ''/);
      expect(header, `${name}: SECURITY INVOKER ではない`).not.toMatch(/SECURITY INVOKER/);
      // 動的 SQL (EXECUTE '…' / EXECUTE format(…) / PERFORM … EXECUTE) を使わない
      expect(body, `${name}: 動的 SQL なし`).not.toMatch(/\bEXECUTE\b/i);
      // 表の参照 (FROM / JOIN / INTO / UPDATE) はスキーマ付き。CTE と、FROM の直後のかっこ (副問い合わせ・関数) は除く
      const ctes = cteNames(body);
      const unqualified: string[] = [];
      for (const match of body.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_]\w*)(\.)?/gi)) {
        if (match[2]) continue; // schema.name
        if (ctes.has(match[1].toLowerCase())) continue;
        unqualified.push(match[0]);
      }
      expect(unqualified, `${name}: スキーマ無しの表の参照`).toEqual([]);
      // 関数の呼び出しも pg_catalog 付き (search_path が空なので、付けないと実行時に解けない)
      const bare = [...whole.matchAll(/(?<![.\w])(now|count|sum|max|to_regclass)\s*\(/gi)].map((match) => match[0]);
      expect(bare, `${name}: pg_catalog 無しの組み込み関数`).toEqual([]);
    }
  });

  it('EXECUTE: counts / mark / unmark / pg_cron_last_run_at は service_role だけ、candidates は誰にも付けない (完全形の REVOKE)', () => {
    for (const name of FUNCTION_NAMES) {
      const signature = `public.${name}(${FUNCTIONS[name]})`;
      expect(code, `${name}: 完全形の REVOKE`).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM ${REVOKED_ROLES};`);
    }
    const grants = [...code.matchAll(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(\S+?\([^)]*\))\s+TO\s+([^;]+);/gi)];
    const granted = grants.map((match) => `${match[1]} -> ${match[2].trim()}`).sort();
    const expected = SERVICE_ROLE_FUNCTIONS.map((name) => `public.${name}(${FUNCTIONS[name]}) -> service_role`).sort();
    expect(granted).toEqual(expected);
    // GRANT の前に REVOKE があること (REVOKE のあとで付け直す順序)
    for (const name of SERVICE_ROLE_FUNCTIONS) {
      const signature = `public.${name}(${FUNCTIONS[name]})`;
      const revokeAt = code.indexOf(`REVOKE ALL ON FUNCTION ${signature}`);
      const grantAt = code.indexOf(`GRANT EXECUTE ON FUNCTION ${signature}`);
      expect(revokeAt, `${name}: REVOKE が GRANT より前`).toBeGreaterThanOrEqual(0);
      expect(grantAt).toBeGreaterThan(revokeAt);
    }
  });

  it('台帳は RLS 有効・全拒否ポリシー・どのロールにも表の権限を付けない', () => {
    expect(code).toContain(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`);
    expect(code).toContain(`REVOKE ALL ON ${TABLE} FROM ${REVOKED_ROLES};`);
    expect(code).toMatch(
      /CREATE POLICY cron_failure_alerts_deny_client_access ON public\.cron_failure_alerts\s+FOR ALL TO anon, authenticated USING \(false\) WITH CHECK \(false\);/,
    );
    // 表の権限は付けない (GRANT … ON <表> / ON TABLE)。関数の GRANT EXECUTE ON FUNCTION だけがある
    const tableGrants = [...code.matchAll(/\bGRANT\b[^;]*?\bON\s+(?!FUNCTION\b)[^;]*;/gi)].map((match) => match[0]);
    expect(tableGrants).toEqual([]);
    // 主キーは (source, item_id)。alerted_at の索引がある
    expect(code).toMatch(/PRIMARY KEY \(source, item_id\)/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS idx_cron_failure_alerts_alerted_at ON public\.cron_failure_alerts \(alerted_at\);/);
  });

  it('候補は source <> client・level = error・cron の route 名の形だけを数え、見る範囲は 7 日', () => {
    const { body } = functionSource('cron_failure_candidates');
    expect(CRON_FAILURE_LOOKBACK_DAYS).toBe(7);
    // 文面に書く日数 (cron-failure.ts の CRON_FAILURE_LOOKBACK_DAYS) と、DB が数える範囲 (c_lookback) が同じ
    expect(body).toMatch(new RegExp(`c_lookback\\s+CONSTANT\\s+pg_catalog\\.interval\\s*:=\\s*interval '${CRON_FAILURE_LOOKBACK_DAYS} days'`));
    // Vercel Cron の分は 2 つの枝 (pg_cron がある DB / 無い DB) の両方に同じ条件で書く
    expect(body.match(/l\.level = 'error'/g) ?? []).toHaveLength(2);
    expect(body.match(/l\.source <> 'client'/g) ?? []).toHaveLength(2);
    expect(body.match(/l\.function_name LIKE 'cron\/%' OR l\.function_name LIKE '% \/api\/cron\/%'/g) ?? []).toHaveLength(2);
    expect(body.match(/l\.created_at >= pg_catalog\.now\(\) - c_lookback/g) ?? []).toHaveLength(2);
    // pg_cron の分は failed の実行だけを、見る範囲で数える
    expect(body).toMatch(/d\.status = 'failed'/);
    expect(body).toMatch(/d\.start_time >= pg_catalog\.now\(\) - c_lookback/);
    // 台帳に無いものだけ (窓で数えない)
    expect(body.match(/NOT EXISTS \(/g) ?? []).toHaveLength(2);
    // 読む列は名前と件数の材料だけ。command / return_message / ログの本文・利用者の ID を読まない
    expect(body).not.toMatch(/\b(command|return_message|error_message|error_stack|metadata|user_id|request_id)\b/);
    const counts = functionSource('cron_failure_counts').body;
    expect(counts).not.toMatch(/\b(command|return_message|error_message|error_stack|metadata|user_id)\b/);
  });

  it('段 A の migration は cron.schedule を呼ばず、UPDATE を含まず、DELETE は台帳 public.cron_failure_alerts への 1 か所 (unmark_cron_failures_alerted) だけ (既存の行を変えない・消さない。§12)', () => {
    expect(code).not.toMatch(/\bcron\.(schedule|schedule_in_database|unschedule|alter_job)\b/i);
    expect(code).not.toMatch(/\bUPDATE\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    const deletes = [...code.matchAll(/\bDELETE\s+FROM\s+(\S+)/gi)].map((match) => match[1]);
    expect(deletes).toEqual(['public.cron_failure_alerts']);
    expect(functionSource('unmark_cron_failures_alerted').body).toMatch(/DELETE FROM public\.cron_failure_alerts AS a WHERE a\.alerted_at = p_alerted_at;/);
    // 書き込み (INSERT) も台帳だけ。mark の中の 1 か所
    const inserts = [...code.matchAll(/\bINSERT\s+INTO\s+(\S+)/gi)].map((match) => match[1]);
    expect(inserts).toEqual(['public.cron_failure_alerts']);
    expect(functionSource('mark_cron_failures_alerted').body).toMatch(/INSERT INTO public\.cron_failure_alerts AS a/);
    // ALTER は台帳の RLS の有効化だけ
    const alters = [...code.matchAll(/\bALTER\s+\w+\s+(\S+)/gi)].map((match) => match[1]);
    expect(alters).toEqual(['public.cron_failure_alerts']);
    // 実行履歴 (cron.job_run_details) と cron.job は読むだけ
    expect(code).not.toMatch(/\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+cron\./i);
  });

  it('migration が登録するジョブに、1 時間以内の間隔のもの (5 分おき・毎時) がある (PG_CRON_STALL_MINUTES = 60 の前提)', () => {
    // しきい値はアプリの既定値そのもの (cron-failure.ts から import)。60 を変えたらこの前提も見直す
    expect(PG_CRON_STALL_MINUTES).toBe(60);
    const jobs = collectMigrationCronJobs(MIGRATIONS_DIR);
    expect(jobs.unresolved, 'ジョブの名前が解けない呼び出し').toEqual([]);
    expect(jobs.names.length).toBeGreaterThan(0);
    // 5 つの欄の cron 式の文字列 (分 時 日 月 曜日) を、cron.schedule を呼ぶ migration から集める
    const intervalsMinutes: { file: string; expression: string; minutes: number }[] = [];
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      const sql = stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      if (!/\bcron\.schedule(?:_in_database)?\s*\(/i.test(sql)) continue;
      for (const match of sql.matchAll(/'([0-9*/,-]+(?: [0-9*/,-]+){4})'/g)) {
        const [minuteField, hourField] = match[1].split(' ');
        const everyN = /^\*\/(\d+)$/.exec(minuteField);
        if (everyN && hourField === '*') intervalsMinutes.push({ file, expression: match[1], minutes: Number(everyN[1]) });
        else if (/^\d+$/.test(minuteField) && hourField === '*') intervalsMinutes.push({ file, expression: match[1], minutes: 60 });
        else if (minuteField === '*' && hourField === '*') intervalsMinutes.push({ file, expression: match[1], minutes: 1 });
      }
    }
    const withinStall = intervalsMinutes.filter((entry) => entry.minutes <= PG_CRON_STALL_MINUTES);
    expect(withinStall.length, `1 時間以内の間隔のジョブ (見つかった cron 式: ${JSON.stringify(intervalsMinutes)})`).toBeGreaterThanOrEqual(1);
  });

  it('src/app/api/cron/*/route.ts が createLogger / internalError に渡す名前は cron/<名前> か <METHOD> /api/cron/<名前> の形 (候補の LIKE と一致する)。vercel.json の crons の 7 本 (backup-freshness・login-alerts・iap-reconcile を含む) のどれもこの走査に入る', () => {
    const routeFiles = fs
      .readdirSync(CRON_ROUTES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(CRON_ROUTES_DIR, entry.name, 'route.ts')))
      .map((entry) => entry.name)
      .sort();
    expect(routeFiles.length).toBeGreaterThanOrEqual(5);

    // 候補の LIKE (migration の 2 つの形) を、同じ意味の判定にする: 'cron/%' と '% /api/cron/%'
    const matchesCandidateLike = (functionName: string) => functionName.startsWith('cron/') || /^.* \/api\/cron\/.*$/s.test(functionName);

    const stripTsComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const namesByRoute = new Map<string, string[]>();
    const problems: string[] = [];
    for (const dir of routeFiles) {
      const source = stripTsComments(fs.readFileSync(path.join(CRON_ROUTES_DIR, dir, 'route.ts'), 'utf-8'));
      const constants = new Map<string, string>();
      for (const match of source.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*(?::\s*string)?\s*=\s*'([^']*)'/g)) constants.set(match[1], match[2]);
      const names: string[] = [];
      for (const match of source.matchAll(/\b(?:createLogger|internalError)\(\s*(?:'([^']*)'|([A-Za-z_]\w*))/g)) {
        const name = match[1] ?? constants.get(match[2] ?? '');
        if (name === undefined) problems.push(`${dir}: 名前が文字列の直書きでも const でもない (${match[0]})`);
        else names.push(name);
      }
      namesByRoute.set(dir, names);
      for (const name of names) {
        if (!matchesCandidateLike(name)) problems.push(`${dir}: ${name} は候補の LIKE ('cron/%' / '% /api/cron/%') に当たらない`);
        // 名前は cron の route 自身のディレクトリ名を指す (別の route の名前を借りていない)
        if (!name.endsWith(`/${dir}`)) problems.push(`${dir}: ${name} は route のディレクトリ名 ${dir} で終わらない`);
      }
    }
    expect(problems).toEqual([]);

    // vercel.json の crons の path は、どれも走査の対象の route で、500 を internalError で返す (失敗が app_logs に残る) 経路を持つ
    const vercel = JSON.parse(fs.readFileSync(VERCEL_JSON_PATH, 'utf-8')) as { crons: { path: string }[] };
    const cronDirs = vercel.crons.map((cron) => /^\/api\/cron\/([^/?]+)/.exec(cron.path)?.[1]);
    expect(cronDirs.every((dir) => typeof dir === 'string')).toBe(true);
    for (const dir of cronDirs as string[]) {
      expect(routeFiles, `vercel.json の ${dir} が走査の対象に入る`).toContain(dir);
      const names = namesByRoute.get(dir) ?? [];
      expect(names.length, `${dir}: createLogger / internalError で名前を付けている`).toBeGreaterThan(0);
      const source = fs.readFileSync(path.join(CRON_ROUTES_DIR, dir, 'route.ts'), 'utf-8');
      expect(source, `${dir}: 500 は internalError で返す`).toMatch(/\binternalError\(/);
    }
    // 読み取りが壊れて空振りしないための番兵 (vercel.json の 7 本)
    for (const known of ['process-menu-queue', 'app-log-alerts', 'email-outbox', 'push-outbox', 'backup-freshness', 'login-alerts', 'iap-reconcile']) {
      expect(cronDirs).toContain(known);
    }
  });

  it("台帳の source の CHECK は 'pg_cron' / 'vercel_cron' の 2 つで、候補が出す source もこの 2 つだけ", () => {
    const allowed = ledgerSourceCheckValues();
    expect(allowed).toEqual(['pg_cron', 'vercel_cron']);
    const { body } = functionSource('cron_failure_candidates');
    const emitted = [...new Set([...body.matchAll(/'([a-z_]+_cron|pg_cron)'::text/g)].map((match) => match[1]))].sort();
    expect(emitted).toEqual(allowed);
  });

  it('src/lib/ops-alerts/cron-failure.ts の CRON_FAILURE_SOURCES は、台帳 cron_failure_alerts.source の CHECK の 2 つと同じ', () => {
    // DB の CHECK にだけ出どころを足すと、アプリの normalizeCronFailureRows がその行を例外にする (500)。
    // アプリにだけ足すと、DB に入らない出どころを想定したままになる。どちらのずれも止める。
    // 並びは問わない (集合として同じであればよい)。重複も無いこと
    const appSources = [...CRON_FAILURE_SOURCES].sort();
    expect(new Set(appSources).size).toBe(appSources.length);
    expect(appSources).toEqual(ledgerSourceCheckValues());
    // 読み取りが壊れて空のまま一致しない番兵
    expect(appSources.length).toBeGreaterThan(0);
  });

  it('rollback が関数 5 本の DROP・台帳の DROP を行い、pg_cron のジョブと ops_alert_state には触れない', () => {
    const drops = [...rollbackCode.matchAll(/DROP\s+(FUNCTION|TABLE)\s+IF EXISTS\s+([^;]+);/gi)].map(
      (match) => `${match[1].toUpperCase()} ${match[2].replace(/\s+/g, ' ').trim()}`,
    );
    const expectedFunctions = FUNCTION_NAMES.map((name) => `FUNCTION public.${name}(${FUNCTIONS[name]})`);
    expect([...drops].sort()).toEqual([...expectedFunctions, `TABLE ${TABLE}`].sort());
    // 台帳を参照する関数を先に消し、台帳を最後に消す
    expect(drops[drops.length - 1]).toBe(`TABLE ${TABLE}`);
    // 触れないもの: pg_cron のジョブ・ops_alert_state・実行履歴・app_logs。行を消す・変える文も無い
    expect(rollbackCode).not.toMatch(/\bcron\./i);
    expect(rollbackCode).not.toMatch(/ops_alert_state|job_run_details|app_logs/i);
    expect(rollbackCode).not.toMatch(/\b(DELETE|UPDATE|INSERT|TRUNCATE)\b/i);
    // migration の関数 5 本と rollback の DROP が過不足なく対応する
    expect(FUNCTION_NAMES.map((name) => code.includes(`CREATE OR REPLACE FUNCTION public.${name}(`))).toEqual([true, true, true, true, true]);
    const createdFunctions = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((match) => match[1]).sort();
    expect(createdFunctions).toEqual([...FUNCTION_NAMES].sort());
  });

  it('読み取りが壊れて素通りしない: splitCallArguments を使うヘルパーが読めている (番兵)', () => {
    // 5 つの欄の cron 式を拾う 8. のテストは、このヘルパーの読み取りに頼る。壊れて空振りしていないことを、既知の呼び出しで確かめる
    expect(splitCallArguments("'a', 'b')", 0)).toEqual(["'a'", "'b'"]);
  });
});
