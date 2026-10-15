/**
 * #1190・#1189・#1198 ログイン履歴・セッション・パスワード履歴の migration (supabase/migrations/<番号>_auth_history_sessions.sql) と
 * 戻し口 (supabase/rollbacks/<番号>_auth_history_sessions.down.sql) の文面の検査 (DB 無し)。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §11・§20.3。実 DB での確認は tests/integration/security/auth-history-sessions.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PASSWORD_HISTORY_MAX_GENERATIONS } from '@/lib/auth/password/policy';
import {
  IP_NETWORK_PREFIX_V4,
  IP_NETWORK_PREFIX_V6,
  LOGIN_HISTORY_RETENTION_DAYS,
  SESSION_IDLE_EXPIRE_DAYS,
} from '@/lib/auth/sessions/constants';
import { collectMigrationCronJobs, scanCronJobNames } from './helpers/migration-cron-jobs';

const ROOT = path.resolve(__dirname, '..');
const NAME = 'auth_history_sessions';
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
/** pg_cron のジョブの「いま」の記述を持つ設計書 (§22 N-32・§23) */
const CRON_DOC_PATH = 'docs/design/operator/08-cron-batches.md';
/** DB の型の生成物 (§11.8)。packages/shared は src/types の写し */
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;

/** 設計書の、見出し startMarker から endMarker の手前まで */
function docSection(doc: string, startMarker: string, endMarker: string): string {
  const start = doc.indexOf(startMarker);
  expect(start, `設計書に「${startMarker}」が無い`).toBeGreaterThanOrEqual(0);
  const end = doc.indexOf(endMarker, start);
  expect(end, `設計書の「${startMarker}」より後に「${endMarker}」が無い`).toBeGreaterThan(start);
  return doc.slice(start, end);
}

function migrationFile(): string {
  const files = fs.readdirSync(path.join(ROOT, MIGRATIONS_DIR)).filter((f) => new RegExp(`^\\d{14}_${NAME}\\.sql$`).test(f));
  expect(files).toHaveLength(1);
  return files[0];
}

const MIGRATION_FILE = migrationFile();
const ROLLBACK_FILE = MIGRATION_FILE.replace(/\.sql$/, '.down.sql');
const rawMigration = fs.readFileSync(path.join(ROOT, MIGRATIONS_DIR, MIGRATION_FILE), 'utf8');
const rawRollback = fs.readFileSync(path.join(ROOT, ROLLBACKS_DIR, ROLLBACK_FILE), 'utf8');

/** SQL のコメント (-- から行末) を外す。説明文の中の語に当たらないようにする */
function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, '');
}
/** 空白をまとめる */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const migration = squash(stripSqlComments(rawMigration));
const rollback = squash(stripSqlComments(rawRollback));

interface FunctionDefinition {
  name: string;
  /** 引数の型の並び (空白を除き、カンマ区切り。例 "uuid,text,text,integer") */
  argTypes: string;
  header: string;
  body: string;
}

/** CREATE OR REPLACE FUNCTION public.<名前>(<引数>) <見出し> AS $$ <本体> $$; を取り出す (空白はまとめた後の文) */
function functionsOf(sql: string): FunctionDefinition[] {
  const pattern = /CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)(.*?)AS \$\$(.*?)\$\$;/g;
  return [...sql.matchAll(pattern)].map((m) => ({
    name: m[1],
    argTypes: m[2]
      .split(',')
      .map((arg) => arg.trim().split(' ').slice(1).join(' '))
      .filter((type) => type !== '')
      .join(','),
    header: m[3],
    body: m[4],
  }));
}

function functionNamed(sql: string, name: string): FunctionDefinition {
  const found = functionsOf(sql).filter((f) => f.name === name);
  expect(found, `${name} の CREATE OR REPLACE FUNCTION`).toHaveLength(1);
  return found[0];
}

/** 2 行の目印の間 (目印の行は除く) を元の文のまま切り出す */
function between(raw: string, begin: string, end: string): string {
  const start = raw.indexOf(begin);
  const stop = raw.indexOf(end);
  expect(start, `目印 ${begin}`).toBeGreaterThanOrEqual(0);
  expect(stop, `目印 ${end}`).toBeGreaterThan(start);
  return raw.slice(start + begin.length, stop);
}

/**
 * 関数の権限の文 (REVOKE ALL ON FUNCTION … FROM … / GRANT EXECUTE ON FUNCTION … TO …) を、DO の FOREACH の展開を含めて集める。
 * キーは「名前(引数の型)」(空白なし)
 */
function functionPrivileges(sql: string): Map<string, { revokedFrom: Set<string>; grantedTo: Set<string> }> {
  const statements: string[] = [];
  const loopPattern = /FOREACH fn IN ARRAY ARRAY\[([^\]]*)\] LOOP (.*?) END LOOP;/g;
  for (const loop of sql.matchAll(loopPattern)) {
    const names = [...loop[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const templates = [...loop[2].matchAll(/EXECUTE format\('([^']*)', fn\)/g)].map((m) => m[1]);
    for (const fn of names) {
      for (const template of templates) {
        statements.push(template.replace('%I()', `${fn}()`).replace('%s', fn));
      }
    }
  }
  const outside = sql.replace(loopPattern, '');
  for (const m of outside.matchAll(/(REVOKE ALL ON FUNCTION [^;]*|GRANT EXECUTE ON FUNCTION [^;]*);/g)) statements.push(m[1]);

  const result = new Map<string, { revokedFrom: Set<string>; grantedTo: Set<string> }>();
  const keyOf = (signature: string) => signature.replace(/^public\./, '').replace(/\s+/g, '');
  const rolesOf = (list: string) => new Set(list.split(',').map((r) => r.trim()));
  for (const statement of statements) {
    const revoke = statement.match(/^REVOKE ALL ON FUNCTION (.+\)) FROM (.+)$/);
    const grant = statement.match(/^GRANT EXECUTE ON FUNCTION (.+\)) TO (.+)$/);
    const match = revoke ?? grant;
    if (!match) continue;
    const key = keyOf(match[1]);
    const entry = result.get(key) ?? { revokedFrom: new Set<string>(), grantedTo: new Set<string>() };
    for (const role of rolesOf(match[2])) (revoke ? entry.revokedFrom : entry.grantedTo).add(role);
    result.set(key, entry);
  }
  return result;
}

const AUTH_TRIGGER_FUNCTIONS = ['auth_session_created', 'auth_session_refreshed', 'auth_session_deleted', 'password_history_record'] as const;
const ALL_ROLES = ['PUBLIC', 'anon', 'authenticated', 'service_role'];

describe('cross/16 migration: トリガー関数', () => {
  it("トリガー関数 5 本のうち auth の表の 4 本は SECURITY DEFINER、user_profiles_fill_login_stats は SECURITY INVOKER で、5 本とも search_path = ''・EXCEPTION WHEN OTHERS を持つ", () => {
    for (const name of AUTH_TRIGGER_FUNCTIONS) {
      const fn = functionNamed(migration, name);
      expect(fn.header, name).toContain('RETURNS trigger');
      expect(fn.header, name).toContain('SECURITY DEFINER');
      expect(fn.header, name).toContain("SET search_path = ''");
      expect(fn.body, name).toContain('EXCEPTION WHEN OTHERS THEN');
      expect(fn.body, name).toContain('RETURN NULL;');
    }
    const fill = functionNamed(migration, 'user_profiles_fill_login_stats');
    expect(fill.header).toContain('RETURNS trigger');
    expect(fill.header).toContain('SECURITY INVOKER');
    expect(fill.header).not.toContain('SECURITY DEFINER');
    expect(fill.header).toContain("SET search_path = ''");
    expect(fill.body).toContain('EXCEPTION WHEN OTHERS THEN');
    // 値を明示して作る行は変えない (last_login_at が NULL のときだけ埋める)
    expect(fill.body).toContain('IF NEW.last_login_at IS NOT NULL THEN RETURN NEW; END IF;');
  });

  it('SQL の /24・/48・30 days・90 days・c_max_generations 10 が constants.ts / policy.ts の値と一致する', () => {
    const created = functionNamed(migration, 'auth_session_created').header + functionNamed(migration, 'auth_session_created').body;
    const v4 = rawMigration.match(/c_prefix_v4 CONSTANT integer := (\d+);/);
    const v6 = rawMigration.match(/c_prefix_v6 CONSTANT integer := (\d+);/);
    expect(Number(v4?.[1])).toBe(IP_NETWORK_PREFIX_V4);
    expect(Number(v6?.[1])).toBe(IP_NETWORK_PREFIX_V6);
    expect(created).toContain('set_masklen(NEW.ip, c_prefix_v4)');
    expect(created).toContain('set_masklen(NEW.ip, c_prefix_v6)');
    // 既存の行の写し (§11.2) も同じ幅
    const backfill = squash(stripSqlComments(between(rawMigration, '-- [cross16-backfill:begin]', '-- [cross16-backfill:end]')));
    expect(backfill).toContain(`set_masklen(s.ip, ${IP_NETWORK_PREFIX_V4})`);
    expect(backfill).toContain(`set_masklen(s.ip, ${IP_NETWORK_PREFIX_V6})`);

    expect(functionNamed(migration, 'expire_idle_auth_sessions').body).toContain(`c_idle CONSTANT interval := INTERVAL '${SESSION_IDLE_EXPIRE_DAYS} days'`);
    expect(functionNamed(migration, 'cleanup_ended_user_sessions_metadata').body).toContain(
      `INTERVAL '${LOGIN_HISTORY_RETENTION_DAYS} days' AS retention`,
    );
    for (const name of ['password_history_record', 'auth_password_check']) {
      expect(functionNamed(migration, name).body, name).toMatch(
        new RegExp(`c_max_generations CONSTANT integer := ${PASSWORD_HISTORY_MAX_GENERATIONS};`),
      );
    }
  });

  it('auth.sessions に 3 本・auth.users に 1 本・user_profiles に 1 本 (BEFORE INSERT) のトリガーを CREATE する', () => {
    const triggers = [...migration.matchAll(/CREATE TRIGGER (\w+) (AFTER|BEFORE) (.+?) ON (\w+\.\w+) FOR EACH ROW (?:WHEN \((.+?)\) )?EXECUTE FUNCTION public\.(\w+)\(\);/g)].map(
      (m) => ({ name: m[1], timing: m[2], event: m[3], table: m[4], when: m[5] ?? null, fn: m[6] }),
    );
    expect(triggers).toEqual([
      { name: 'on_auth_session_created', timing: 'AFTER', event: 'INSERT', table: 'auth.sessions', when: null, fn: 'auth_session_created' },
      {
        name: 'on_auth_session_refreshed',
        timing: 'AFTER',
        event: 'UPDATE OF refreshed_at',
        table: 'auth.sessions',
        when: 'OLD.refreshed_at IS DISTINCT FROM NEW.refreshed_at',
        fn: 'auth_session_refreshed',
      },
      { name: 'on_auth_session_deleted', timing: 'AFTER', event: 'DELETE', table: 'auth.sessions', when: null, fn: 'auth_session_deleted' },
      {
        name: 'on_auth_user_password_changed',
        timing: 'AFTER',
        event: 'INSERT OR UPDATE OF encrypted_password',
        table: 'auth.users',
        when: null,
        fn: 'password_history_record',
      },
      {
        name: 'trg_user_profiles_fill_login_stats',
        timing: 'BEFORE',
        event: 'INSERT',
        table: 'public.user_profiles',
        when: null,
        fn: 'user_profiles_fill_login_stats',
      },
    ]);
  });

  it('migration は auth.sessions / auth.users に DROP TRIGGER を書かず、その 4 本の CREATE TRIGGER は、[cross16-auth-triggers:begin] / [cross16-auth-triggers:end] の目印の間で、それぞれ pg_trigger に同じ名前が無いときだけ (IF NOT EXISTS の中で) 行う', () => {
    expect(migration).not.toMatch(/DROP TRIGGER[^;]* ON auth\./);
    expect(migration).not.toMatch(/DISABLE TRIGGER/);
    const block = squash(stripSqlComments(between(rawMigration, '-- [cross16-auth-triggers:begin]', '-- [cross16-auth-triggers:end]')));
    const guarded = [
      ...block.matchAll(
        /IF NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_trigger t WHERE t\.tgrelid = '(auth\.\w+)'::regclass AND t\.tgname = '(\w+)'\) THEN CREATE TRIGGER (\w+) [^;]* ON (auth\.\w+) [^;]*; END IF;/g,
      ),
    ].map((m) => ({ guardTable: m[1], guardName: m[2], name: m[3], table: m[4] }));
    expect(guarded).toEqual([
      { guardTable: 'auth.sessions', guardName: 'on_auth_session_created', name: 'on_auth_session_created', table: 'auth.sessions' },
      { guardTable: 'auth.sessions', guardName: 'on_auth_session_refreshed', name: 'on_auth_session_refreshed', table: 'auth.sessions' },
      { guardTable: 'auth.sessions', guardName: 'on_auth_session_deleted', name: 'on_auth_session_deleted', table: 'auth.sessions' },
      { guardTable: 'auth.users', guardName: 'on_auth_user_password_changed', name: 'on_auth_user_password_changed', table: 'auth.users' },
    ]);
    // 目印の外に auth の表の CREATE TRIGGER は無い
    const outside = squash(stripSqlComments(rawMigration.replace(between(rawMigration, '-- [cross16-auth-triggers:begin]', '-- [cross16-auth-triggers:end]'), '')));
    expect(outside).not.toMatch(/CREATE TRIGGER \w+ [^;]* ON auth\./);
    // user_profiles の表の所有者は postgres なので、こちらは作り直せる
    expect(migration).toContain('DROP TRIGGER IF EXISTS trg_user_profiles_fill_login_stats ON public.user_profiles;');
  });
});

describe('cross/16 migration: 列・RPC・権限', () => {
  it("user_sessions_metadata.alert_status の列の既定は 'done' で (ADD COLUMN … DEFAULT 'done' §11.1)、auth_session_created の INSERT は alert_status に 'pending' を明示する", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS alert_status text NOT NULL DEFAULT 'done'");
    const body = functionNamed(migration, 'auth_session_created').body;
    expect(body).toMatch(/INSERT INTO public\.user_sessions_metadata \([^)]*alert_status\) VALUES \(.*'auth', 'pending'\) ON CONFLICT \(session_id\) DO NOTHING;/);
    // 既存の行の写しは通知しない (done)
    const backfill = squash(stripSqlComments(between(rawMigration, '-- [cross16-backfill:begin]', '-- [cross16-backfill:end]')));
    expect(backfill).toContain("'auth', 'done' FROM auth.sessions s");
    // pending を書くのは auth_session_created だけ (release_login_alert の戻しは CASE の中)
    const pendingWriters = functionsOf(migration).filter((f) => f.body.includes("'pending')")).map((f) => f.name);
    expect(pendingWriters).toEqual(['auth_session_created']);
  });

  it('RPC 4 本と保守 3 本の REVOKE / GRANT が決めたとおり (claim_login_alerts・release_login_alert は SECURITY INVOKER で service_role だけ)', () => {
    const privileges = functionPrivileges(migration);
    const expected: Record<string, { grantedTo: string[]; security: 'DEFINER' | 'INVOKER' }> = {
      'auth_session_revoke(uuid)': { grantedTo: ['authenticated'], security: 'DEFINER' },
      'auth_password_check(uuid,text,text,integer)': { grantedTo: ['service_role'], security: 'DEFINER' },
      'claim_login_alerts(integer,integer,integer,integer)': { grantedTo: ['service_role'], security: 'INVOKER' },
      'release_login_alert(text,integer)': { grantedTo: ['service_role'], security: 'INVOKER' },
      'expire_idle_auth_sessions()': { grantedTo: ['service_role'], security: 'DEFINER' },
      'reconcile_user_sessions_metadata()': { grantedTo: ['service_role'], security: 'DEFINER' },
      'cleanup_ended_user_sessions_metadata()': { grantedTo: ['service_role'], security: 'INVOKER' },
      'auth_session_created()': { grantedTo: ['supabase_auth_admin'], security: 'DEFINER' },
      'auth_session_refreshed()': { grantedTo: ['supabase_auth_admin'], security: 'DEFINER' },
      'auth_session_deleted()': { grantedTo: ['supabase_auth_admin'], security: 'DEFINER' },
      'password_history_record()': { grantedTo: ['supabase_auth_admin'], security: 'DEFINER' },
      'user_profiles_fill_login_stats()': { grantedTo: [], security: 'INVOKER' },
    };
    expect([...privileges.keys()].sort()).toEqual(Object.keys(expected).sort());
    for (const [signature, want] of Object.entries(expected)) {
      const got = privileges.get(signature)!;
      expect([...got.revokedFrom].sort(), `${signature} の REVOKE`).toEqual([...ALL_ROLES].sort());
      expect([...got.grantedTo].sort(), `${signature} の GRANT`).toEqual(want.grantedTo);
      const fn = functionsOf(migration).find((f) => `${f.name}(${f.argTypes})` === signature);
      expect(fn, `${signature} の定義`).toBeDefined();
      expect(fn!.header, `${signature} の SECURITY`).toContain(`SECURITY ${want.security}`);
    }
  });

  it('claim_login_alerts は 4 つの引数 (p_max_age_hours を含む) を持ち、作成から p_max_age_hours を過ぎた行を FOR UPDATE SKIP LOCKED で選んで done にする文と、作成から p_max_age_hours 以内の候補を FOR UPDATE SKIP LOCKED で選んで processing にする文を持つ', () => {
    const claim = functionNamed(migration, 'claim_login_alerts');
    expect(claim.argTypes).toBe('integer,integer,integer,integer');
    expect(rawMigration).toMatch(/claim_login_alerts\(\s*p_batch_size integer, p_min_age_seconds integer, p_reclaim_minutes integer, p_max_age_hours integer\)/);
    expect(claim.header).toContain('RETURNS SETOF public.user_sessions_metadata');
    const body = claim.body;
    // 1 つ目の文: 期限切れ → done
    expect(body).toMatch(
      /WITH stale AS \( SELECT m\.session_id FROM public\.user_sessions_metadata m WHERE m\.created_at < pg_catalog\.now\(\) - pg_catalog\.make_interval\(hours => p_max_age_hours\) .*? FOR UPDATE SKIP LOCKED \) UPDATE public\.user_sessions_metadata m SET alert_status = 'done', alert_claimed_at = NULL FROM stale/,
    );
    // 2 つ目の文: 期限の内側の候補 → processing
    expect(body).toMatch(
      /WITH picked AS \( SELECT m\.session_id FROM public\.user_sessions_metadata m WHERE m\.created_at <= pg_catalog\.now\(\) - pg_catalog\.make_interval\(secs => p_min_age_seconds\) AND m\.created_at >= pg_catalog\.now\(\) - pg_catalog\.make_interval\(hours => p_max_age_hours\) .*? ORDER BY m\.created_at LIMIT p_batch_size FOR UPDATE SKIP LOCKED \) UPDATE public\.user_sessions_metadata m SET alert_status = 'processing', alert_claimed_at = pg_catalog\.now\(\) FROM picked/,
    );
    expect(body.indexOf('WITH stale AS')).toBeLessThan(body.indexOf('WITH picked AS'));
    // 取り直し (processing のまま alert_claimed_at が古い行) は両方の文で同じ条件
    expect(body.match(/alert_claimed_at < pg_catalog\.now\(\) - pg_catalog\.make_interval\(mins => p_reclaim_minutes\)/g)).toHaveLength(2);
  });

  it('既存の行の写し (§11.2) は [cross16-backfill:begin] / [cross16-backfill:end] の目印の間にあり、user_sessions_metadata の写しは ON CONFLICT (session_id) DO NOTHING、password_history の写しは NOT EXISTS と ON CONFLICT (user_id, changed_at) DO NOTHING を持つ', () => {
    const backfill = squash(stripSqlComments(between(rawMigration, '-- [cross16-backfill:begin]', '-- [cross16-backfill:end]')));
    const inserts = backfill.split(';').map((s) => s.trim()).filter((s) => s.startsWith('INSERT INTO'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatch(/^INSERT INTO public\.user_sessions_metadata .* FROM auth\.sessions s ON CONFLICT \(session_id\) DO NOTHING$/);
    expect(inserts[1]).toMatch(/^INSERT INTO public\.password_history .* FROM auth\.users u WHERE .*NOT EXISTS \(SELECT 1 FROM public\.password_history h WHERE h\.user_id = u\.id\) ON CONFLICT \(user_id, changed_at\) DO NOTHING$/);
    // 写しの INSERT は目印の間の 2 本だけ
    const outside = squash(stripSqlComments(rawMigration.replace(between(rawMigration, '-- [cross16-backfill:begin]', '-- [cross16-backfill:end]'), '')));
    expect(outside).not.toMatch(/INSERT INTO public\.\w+ \([^)]*\) SELECT/);
  });

  it('pg_cron のジョブの名前と時刻', () => {
    expect(migration).toMatch(
      /PERFORM cron\.schedule\( 'cleanup-auth-sessions-and-login-history', '55 18 \* \* \*', 'SELECT public\.expire_idle_auth_sessions\(\), public\.reconcile_user_sessions_metadata\(\), public\.cleanup_ended_user_sessions_metadata\(\);' \);/,
    );
    // 同じ名前・同じ処理のジョブは先に外す
    expect(migration).toContain("WHERE jobname = 'cleanup-auth-sessions-and-login-history' OR command ~* '[[:<:]]expire_idle_auth_sessions[[:>:]]'");
    expect(migration.match(/cron\.schedule\(/g)).toHaveLength(1);
  });

  it('pg_cron のジョブは、08-cron-batches の「いま」の記述を数える見張りが名前で解け (未解決 0 件)、ほかの migration に同じ名前のジョブが無い (§22 N-32: 08 の §3.0・§3.1 の注記の数が origin/main の実数 + 1 になる)', () => {
    const jobName = 'cleanup-auth-sessions-and-login-history';
    // 08 の §3.0・§3.1 の注記と突き合わせる見張り (tests/log-cleanup-dau-snapshot-contract.test.ts) と同じ数え方で、この migration の 1 本を数える
    expect(scanCronJobNames(rawMigration, MIGRATION_FILE)).toEqual({ names: [jobName], unresolved: [] });
    const migrationsDir = path.join(ROOT, MIGRATIONS_DIR);
    const others = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql') && file !== MIGRATION_FILE)
      .filter((file) =>
        scanCronJobNames(fs.readFileSync(path.join(migrationsDir, file), 'utf8'), file).names.includes(jobName),
      );
    expect(others, '同じ名前のジョブを登録しているほかの migration').toEqual([]);
  });

  it('08-cron-batches の pg_cron の本数の宣言 (§3.0・§3.1 の注記) は、08 がこのジョブを挙げていれば全 migration の実数、まだ挙げていなければ (設計書の追随の前) このジョブを除いた実数と同じ (§22 N-32「PR の時点の origin/main の実数 + 1」。古い main に合わせた本数で追随すると赤)', () => {
    const jobName = 'cleanup-auth-sessions-and-login-history';
    const { names, unresolved } = collectMigrationCronJobs(path.join(ROOT, MIGRATIONS_DIR));
    expect(unresolved, 'ジョブの名前を解けない cron.schedule の呼び出し').toEqual([]);
    expect(names, 'migration の cron.schedule の数えにこのジョブが入っていること').toContain(jobName);
    const doc = fs.readFileSync(path.join(ROOT, CRON_DOC_PATH), 'utf8');
    // tests/log-cleanup-dau-snapshot-contract.test.ts と同じ節の切り方と、同じ本数の宣言の読み方
    const section30 = docSection(doc, '### 3.0 実装状況', '#### 3.0.1');
    const section31Note = docSection(doc, '### 3.1 pg_cron ジョブ', '### 3.2 Vercel Cron ジョブ')
      .split('\n')
      .filter((line) => line.startsWith('> '))
      .join('\n');
    const declared30 = /migration が pg_cron に登録しているジョブは (\d+) つ/.exec(section30);
    const declared31 = /migration が pg_cron に登録しているのは[^\n]*?の (\d+) つ/.exec(section31Note);
    expect(declared30, '08 の §3.0 に pg_cron のジョブの数の記述が無い').not.toBeNull();
    expect(declared31, '08 の §3.1 の注記に pg_cron のジョブの数の記述が無い').not.toBeNull();
    const listed30 = section30.includes(`\`${jobName}\``);
    const listed31 = section31Note.includes(`\`${jobName}\``);
    expect(listed31, '08 の §3.0 と §3.1 の注記の片方だけがこのジョブを挙げている (追随が半分)').toBe(listed30);
    // 挙げていれば全数、まだ挙げていなければこのジョブを除いた数 (追随で +1 すれば全数になる)
    const expected = listed30 ? names.length : names.length - 1;
    expect(Number(declared30?.[1]), '08 の §3.0 の pg_cron のジョブの数').toBe(expected);
    expect(Number(declared31?.[1]), '08 の §3.1 の注記の pg_cron のジョブの数').toBe(expected);
  });
});

describe('cross/16 の戻し口 (.down.sql §11.7)', () => {
  it('.down.sql は DROP TRIGGER を user_profiles の trg_user_profiles_fill_login_stats にだけ書き、auth の表には DROP TRIGGER も DISABLE TRIGGER も書かない。トリガー関数 4 本 (auth_session_created・auth_session_refreshed・auth_session_deleted・password_history_record) は DROP せず、本体が RETURN NULL だけの CREATE OR REPLACE FUNCTION にする (§11.7)', () => {
    expect([...rollback.matchAll(/DROP TRIGGER (?:IF EXISTS )?(\w+) ON ([\w.]+);/g)].map((m) => `${m[1]} ON ${m[2]}`)).toEqual([
      'trg_user_profiles_fill_login_stats ON public.user_profiles',
    ]);
    expect(rollback).not.toMatch(/DISABLE TRIGGER/);
    expect(rollback).not.toMatch(/ON auth\./);
    for (const name of AUTH_TRIGGER_FUNCTIONS) {
      expect(rollback, name).not.toMatch(new RegExp(`DROP FUNCTION[^;]*\\b${name}\\b`));
      const stub = functionNamed(rollback, name);
      expect(stub.header, name).toContain('RETURNS trigger');
      expect(stub.header, name).toContain('SECURITY DEFINER');
      expect(stub.header, name).toContain("SET search_path = ''");
      expect(stub.body.trim(), name).toBe('BEGIN RETURN NULL; END;');
    }
  });

  it('.down.sql は、そのほかの migration の作るもの (RPC 4 本・保守 3 本・user_profiles_fill_login_stats・索引・制約・列・ジョブ) を消し、ポリシーと GRANT と user_profiles.last_login_at の COMMENT を戻す', () => {
    for (const fn of [
      'expire_idle_auth_sessions()',
      'reconcile_user_sessions_metadata()',
      'cleanup_ended_user_sessions_metadata()',
      'auth_session_revoke(uuid)',
      'auth_password_check(uuid, text, text, integer)',
      'claim_login_alerts(integer, integer, integer, integer)',
      'release_login_alert(text, integer)',
      'user_profiles_fill_login_stats()',
    ]) {
      expect(rollback, fn).toContain(`DROP FUNCTION IF EXISTS public.${fn};`);
    }
    // migration が作る関数のうち、戻し口で消さないのは auth の表のトリガー関数 4 本だけ
    const created = new Set(functionsOf(migration).map((f) => f.name));
    const dropped = new Set([...rollback.matchAll(/DROP FUNCTION IF EXISTS public\.(\w+)\(/g)].map((m) => m[1]));
    expect([...created].filter((name) => !dropped.has(name)).sort()).toEqual([...AUTH_TRIGGER_FUNCTIONS].sort());

    for (const index of ['idx_sessions_alert_queue', 'idx_sessions_ended']) {
      expect(migration).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
      expect(rollback).toContain(`DROP INDEX IF EXISTS public.${index};`);
    }
    for (const constraint of [
      'user_sessions_metadata_context_source_check',
      'user_sessions_metadata_alert_status_check',
      'user_sessions_metadata_ended_reason_check',
    ]) {
      expect(migration).toContain(`ADD CONSTRAINT ${constraint}`);
      expect(rollback).toContain(`DROP CONSTRAINT IF EXISTS ${constraint}`);
    }
    const addedColumns = [...migration.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(addedColumns).toHaveLength(12);
    const droppedColumns = [...rollback.matchAll(/DROP COLUMN IF EXISTS (\w+)/g)].map((m) => m[1]);
    expect(droppedColumns.sort()).toEqual([...addedColumns].sort());

    expect(rollback).toMatch(/SELECT jobid FROM cron\.job WHERE jobname = 'cleanup-auth-sessions-and-login-history' ORDER BY jobid LOOP PERFORM cron\.unschedule\(v_job\.jobid\);/);

    expect(migration).toContain('DROP POLICY IF EXISTS sessions_revoke_self ON public.user_sessions_metadata;');
    expect(rollback).toContain('CREATE POLICY sessions_revoke_self ON public.user_sessions_metadata FOR UPDATE USING (user_id = auth.uid());');
    expect(rollback).toContain('GRANT ALL ON TABLE public.user_sessions_metadata, public.password_history TO anon, authenticated;');
    expect(migration).toContain('COMMENT ON COLUMN public.user_profiles.last_login_at IS');
    expect(rollback).toContain(
      "COMMENT ON COLUMN public.user_profiles.last_login_at IS '最終ログイン日時 (auth.users.last_sign_in_at を Edge Function が同期)';",
    );
  });

  it('migration と戻し口の 1 行目が互いのファイル名を指し、migration の冒頭が戻し口を案内する', () => {
    expect(rawMigration.split('\n', 1)[0]).toBe(`-- migration: ${MIGRATION_FILE}`);
    expect(rawRollback.split('\n', 1)[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    expect(rawMigration).toContain(`supabase/rollbacks/${ROLLBACK_FILE}`);
  });
});

/** migration の列の SQL の型 → supabase gen types の TS の型 (§11.1 の 12 列が使う型だけ) */
const SQL_TO_TS_TYPE: Readonly<Record<string, string>> = {
  inet: 'unknown',
  'character(2)': 'string',
  text: 'string',
  boolean: 'boolean',
  timestamptz: 'string',
  integer: 'number',
};

/** §11.8: 型に出る関数 (トリガー関数 5 本は RETURNS trigger なので出ない) */
const TYPED_FUNCTIONS = [
  'auth_session_revoke',
  'auth_password_check',
  'claim_login_alerts',
  'release_login_alert',
  'expire_idle_auth_sessions',
  'reconcile_user_sessions_metadata',
  'cleanup_ended_user_sessions_metadata',
] as const;

/** text の opener (末尾が「{」) から、対応する「}」までの中身 */
function braceBlock(text: string, opener: string, label: string): string {
  const start = text.indexOf(opener);
  expect(start, `${label}: 「${opener.trim()}」が無い`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start + opener.length - 1; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') depth -= 1;
    if (depth === 0) return text.slice(start + opener.length, i);
  }
  throw new Error(`${label}: 「${opener.trim()}」の閉じかっこが無い`);
}

describe('cross/16 型の生成物 (§11.8。main の取り込みで型が衝突しても、片方に合わせて落とさない)', () => {
  /** migration の ALTER TABLE public.user_sessions_metadata の ADD COLUMN (名前・SQL の型・NOT NULL) */
  function addedColumnsOf(): { name: string; sqlType: string; notNull: boolean }[] {
    const statement = /ALTER TABLE public\.user_sessions_metadata (ADD COLUMN [^;]*);/.exec(migration);
    expect(statement, 'user_sessions_metadata の ADD COLUMN の文').not.toBeNull();
    return (statement?.[1] ?? '').split(/,\s*(?=ADD COLUMN )/).map((clause) => {
      const m = /^ADD COLUMN IF NOT EXISTS (\w+) (character\(\d+\)|\w+)(.*)$/.exec(clause.trim());
      expect(m, `ADD COLUMN の形: ${clause}`).not.toBeNull();
      return { name: m?.[1] ?? '', sqlType: m?.[2] ?? '', notNull: /\bNOT NULL\b/.test(m?.[3] ?? '') };
    });
  }

  it.each(TYPE_FILES)('%s の user_sessions_metadata の Row に、migration が足した 12 列が migration の型と NULL の可否で入っている', (file) => {
    const addedColumns = addedColumnsOf();
    expect(addedColumns).toHaveLength(12);
    const types = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const tables = braceBlock(types, '\n    Tables: {', `${file} の Tables`);
    const table = braceBlock(tables, '\n      user_sessions_metadata: {', `${file} の user_sessions_metadata`);
    const row = braceBlock(table, '\n        Row: {', `${file} の user_sessions_metadata.Row`);
    for (const column of addedColumns) {
      const tsType = SQL_TO_TS_TYPE[column.sqlType];
      expect(tsType, `${column.name} の SQL の型 ${column.sqlType} の対応`).toBeDefined();
      const expected = column.notNull ? tsType : `${tsType} | null`;
      expect(row, `${file}: user_sessions_metadata.Row.${column.name}`).toMatch(
        new RegExp(`^\\s*${column.name}: ${expected.replace(/[|]/g, '\\|')}$`, 'm'),
      );
    }
  });

  it.each(TYPE_FILES)('%s の Functions に §11.8 の関数 7 本が、migration の引数の名前で入っている', (file) => {
    const types = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const functionsSection = braceBlock(types, '\n    Functions: {', `${file} の Functions`);
    for (const name of TYPED_FUNCTIONS) {
      const signature = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(([^)]*)\\)`).exec(migration);
      expect(signature, `migration の ${name} の CREATE OR REPLACE FUNCTION`).not.toBeNull();
      const argNames = (signature?.[1] ?? '')
        .split(',')
        .map((arg) => arg.trim().split(' ')[0])
        .filter((arg) => arg !== '')
        .sort();
      const entry = braceBlock(functionsSection, `\n      ${name}: {`, `${file} の Functions.${name}`);
      const argsMatch = /Args: (never|\{([^}]*)\})/.exec(entry);
      expect(argsMatch, `${file}: Functions.${name}.Args`).not.toBeNull();
      const typedArgs =
        argsMatch?.[1] === 'never'
          ? []
          : [...(argsMatch?.[2] ?? '').matchAll(/(\w+)\??:/g)].map((m) => m[1]).sort();
      expect(typedArgs, `${file}: Functions.${name} の引数の名前`).toEqual(argNames);
    }
  });
});
