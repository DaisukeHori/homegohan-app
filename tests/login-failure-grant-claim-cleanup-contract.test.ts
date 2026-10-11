/**
 * #1492 ログイン失敗の記録と数え済みの印の使用済みの記録の掃除 (migration 20261011040000) のソース走査 contract テスト (DB には接続しない)
 *
 * 実際の動き (保持期間の内外の行・権限・ジョブの登録) は tests/integration/security/login-failure-grant-claim-cleanup.test.ts で確かめる。
 * ここでは、DB を立てなくても通常のテストで止められる取り決めを固定する。
 *
 *   1. migration と rollback が同じ version / 名前で対になっている
 *   2. 保持期間が、アプリ・ほかの migration の値と結び付いている
 *      - auth_login_failures の stale_after は、アプリの上限 LOGIN_FAILURE_RESET_MINUTES_MAX (src/lib/auth/login-failures.ts) より長い
 *        (同じか短いと、環境変数で上限にしたときに、数えている途中の行を消しうる)
 *      - ai_usage_grant_claims の claim_retention は、claim_ai_usage_grant (20261011030000) の c_claim_retention と同じで、
 *        印の有効期限 AI_USAGE_GRANT_MAX_AGE_SEC (supabase/functions/_shared/ai-usage-core.ts) より長い
 *   3. 2 つの関数は LANGUAGE sql・SECURITY INVOKER・search_path 空・引数なし。消す条件は保持期間だけ
 *   4. EXECUTE は service_role だけ (PUBLIC / anon / authenticated から外す)
 *   5. ジョブ 1 つの名前・時刻 (UTC)・command が決めたとおり。登録の前に同じ処理を呼ぶ既存のジョブを登録解除する。
 *      pg_cron が無い DB では登録を飛ばす。実行ログ (RAISE) に command を載せない
 *   6. 使われなくなったロック用の関数と列 (docs/operations/auth-protection.md §2.1 で「消すかは別に決める」) には触れない
 *   7. 個人データのエクスポートの対象外の理由 (src/lib/account-export-tables.ts) が、実際の消え方 (このジョブ) を書いている
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { LOGIN_FAILURE_RESET_MINUTES_MAX } from '../src/lib/auth/login-failures';
import { AI_USAGE_GRANT_MAX_AGE_SEC } from '../supabase/functions/_shared/ai-usage-core';
import { ACCOUNT_EXPORT_EXCLUDED } from '../src/lib/account-export-tables';

const ROOT = path.resolve(__dirname, '..');
const VERSION = '20261011040000';
const NAME = 'schedule_login_failure_and_grant_claim_cleanup';
const MIGRATION_PATH = path.join(ROOT, 'supabase', 'migrations', `${VERSION}_${NAME}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${VERSION}_${NAME}.down.sql`);
/** claim_ai_usage_grant の c_claim_retention を定義している migration */
const CLAIM_MIGRATION_PATH = path.join(ROOT, 'supabase', 'migrations', '20261011030000_ai_usage_unmetered_caps_and_grants.sql');

const JOB_NAME = 'cleanup-stale-login-failures-and-grant-claims';
const JOB_SCHEDULE = '45 18 * * *';
const JOB_COMMAND = 'SELECT public.cleanup_stale_auth_login_failures(), public.cleanup_expired_ai_usage_grant_claims();';
const LOGIN_FN = 'cleanup_stale_auth_login_failures';
const CLAIM_FN = 'cleanup_expired_ai_usage_grant_claims';

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_DAY = 24 * 60;
const SECONDS_PER_DAY = MINUTES_PER_DAY * SECONDS_PER_MINUTE;
/** JST は UTC + 9 時間 */
const JST_OFFSET_HOURS = 9;
const HOURS_PER_DAY = 24;

/** `--` の行コメントを取り除く (この migration の文字列リテラルには `--` を含むものが無い) */
const stripLineComments = (sql: string) => sql.replace(/--.*$/gm, '');
const migration = fs.readFileSync(MIGRATION_PATH, 'utf-8');
const code = stripLineComments(migration);

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

/** `INTERVAL 'N day(s)' AS <alias>` の N (日)。見つからなければテストを落とす */
function intervalDays(sql: string, alias: string): number {
  const m = new RegExp(`INTERVAL\\s+'(\\d+) days?'\\s+AS\\s+${alias}\\b`).exec(sql);
  expect(m, `INTERVAL '... days' AS ${alias} が見つからない`).not.toBeNull();
  return Number((m as RegExpExecArray)[1]);
}

describe('#1492 migration と rollback のファイル', () => {
  it('rollback が同じ version / 名前で対になっていて、ジョブの登録解除と 2 つの関数の削除を行う', () => {
    expect(fs.existsSync(ROLLBACK_PATH), `supabase/rollbacks/${VERSION}_${NAME}.down.sql が無い`).toBe(true);
    const rollback = stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8'));
    expect(rollback).toContain(`jobname = '${JOB_NAME}'`);
    expect(rollback).toMatch(/cron\.unschedule\(/);
    expect(rollback).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${LOGIN_FN}\\(\\);`));
    expect(rollback).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${CLAIM_FN}\\(\\);`));
    // 表と行には触れない
    expect(rollback).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(rollback).not.toMatch(/\bTRUNCATE\b/i);
    expect(rollback).not.toMatch(/\bDROP\s+TABLE\b/i);
  });
});

describe('#1492 保持期間の突き合わせ', () => {
  it('auth_login_failures の保持期間は、アプリの上限 LOGIN_FAILURE_RESET_MINUTES_MAX より長い (同じか長い、より強い条件)', () => {
    const days = intervalDays(fnParts(LOGIN_FN).body, 'stale_after');
    expect(LOGIN_FAILURE_RESET_MINUTES_MAX, 'アプリの上限の読み込みが空振りしていないこと').toBeGreaterThan(0);
    expect(days * MINUTES_PER_DAY).toBeGreaterThan(LOGIN_FAILURE_RESET_MINUTES_MAX);
    // 決めた値 (上限 7 日 + 余裕 1 日)。値を変えるときは、migration の冒頭の根拠と一緒に変える
    expect(days).toBe(LOGIN_FAILURE_RESET_MINUTES_MAX / MINUTES_PER_DAY + 1);
  });

  it('ai_usage_grant_claims の保持期間は、claim_ai_usage_grant の c_claim_retention と同じで、印の有効期限より長い', () => {
    const days = intervalDays(fnParts(CLAIM_FN).body, 'claim_retention');
    const claimMigration = stripLineComments(fs.readFileSync(CLAIM_MIGRATION_PATH, 'utf-8'));
    const m = /c_claim_retention\s+CONSTANT\s+INTERVAL\s*:=\s*INTERVAL\s+'(\d+) days?'/.exec(claimMigration);
    expect(m, '20261011030000 の c_claim_retention が見つからない').not.toBeNull();
    expect(days).toBe(Number((m as RegExpExecArray)[1]));
    expect(days * SECONDS_PER_DAY).toBeGreaterThan(AI_USAGE_GRANT_MAX_AGE_SEC);
  });
});

describe('#1492 掃除の関数の書き方', () => {
  for (const name of [LOGIN_FN, CLAIM_FN]) {
    it(`${name}: 引数なし・integer を返す・LANGUAGE sql・SECURITY INVOKER・SET search_path = ''`, () => {
      const { header, body } = fnParts(name);
      expect(header).toMatch(new RegExp(`public\\.${name}\\(\\)\\s+RETURNS integer`));
      expect(header).toMatch(/\bLANGUAGE\s+sql\b/);
      expect(header).toMatch(/\bSECURITY\s+INVOKER\b/);
      expect(header).not.toMatch(/\bSECURITY\s+DEFINER\b/);
      expect(header).toMatch(/SET\s+search_path\s*=\s*''/);
      expect(body).not.toMatch(/\bEXECUTE\b/i);
      expect(body).toMatch(/pg_catalog\.now\(\)/);
    });
  }

  it('ログイン失敗の記録は、coalesce(last_failed_at, updated_at) が保持期間より古い行だけを消す', () => {
    const { body } = fnParts(LOGIN_FN);
    expect(body).toMatch(/DELETE FROM public\.auth_login_failures AS f/);
    expect(body).toMatch(/WHERE coalesce\(f\.last_failed_at, f\.updated_at\) < pg_catalog\.now\(\) - p\.stale_after/);
  });

  it('数え済みの印の記録は、利用者を問わず、claimed_at が保持期間より古い行だけを消す', () => {
    const { body } = fnParts(CLAIM_FN);
    expect(body).toMatch(/DELETE FROM public\.ai_usage_grant_claims AS g/);
    expect(body).toMatch(/WHERE g\.claimed_at < pg_catalog\.now\(\) - p\.claim_retention/);
    expect(body, '利用者で絞らない').not.toMatch(/user_id/);
  });

  it('migration が消す表は 2 つだけ。ほかの表の行は変えない', () => {
    const deletes = [...code.matchAll(/\bDELETE\s+FROM\s+([A-Za-z_.]+)/gi)].map((m) => m[1]).sort();
    expect(deletes).toEqual(['public.ai_usage_grant_claims', 'public.auth_login_failures']);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/(^|;)\s*UPDATE\s/im);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
  });
});

describe('#1492 権限', () => {
  for (const name of [LOGIN_FN, CLAIM_FN]) {
    it(`${name}(): PUBLIC / anon / authenticated から EXECUTE を外し、service_role に付ける`, () => {
      expect(code).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(\\)\\s+FROM PUBLIC, anon, authenticated;`));
      expect(code).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(\\)\\s+TO service_role;`));
      // service_role 以外のロールに付けない
      const grants = [...code.matchAll(new RegExp(`GRANT [A-Z, ]+ ON FUNCTION public\\.${name}\\(\\)\\s+TO ([a-z_, ]+);`, 'g'))].map(
        (m) => m[1],
      );
      expect(grants).toEqual(['service_role']);
    });
  }
});

describe('#1492 pg_cron のジョブ', () => {
  it(`${JOB_NAME}: 毎日 18:45 UTC (03:45 JST) に 2 つの掃除の関数を呼ぶ`, () => {
    const schedules = [...code.matchAll(/cron\.schedule\(\s*'([^']+)',\s*'([^']+)',\s*'((?:[^']|'')*)'\s*\)/g)].map((m) => ({
      name: m[1],
      schedule: m[2],
      command: m[3],
    }));
    expect(schedules).toEqual([{ name: JOB_NAME, schedule: JOB_SCHEDULE, command: JOB_COMMAND }]);
    const [minute, hour] = JOB_SCHEDULE.split(' ').map(Number);
    expect({ jstHour: (hour + JST_OFFSET_HOURS) % HOURS_PER_DAY, minute }).toEqual({ jstHour: 3, minute: 45 });
  });

  it('登録の前に、同じ処理を呼ぶ既存のジョブ (名前は問わない) と同じ名前のジョブを登録解除する', () => {
    const unschedule = code.indexOf('cron.unschedule(');
    const schedule = code.indexOf('cron.schedule(');
    expect(unschedule).toBeGreaterThan(0);
    expect(unschedule, '登録解除が登録より前').toBeLessThan(schedule);
    expect(code).toContain(`jobname = '${JOB_NAME}'`);
    expect(code).toContain(`command ~* '[[:<:]]${LOGIN_FN}[[:>:]]'`);
    expect(code).toContain(`command ~* '[[:<:]]${CLAIM_FN}[[:>:]]'`);
  });

  it('pg_cron が無い DB (cron.job が無い) では、ジョブの登録を飛ばす。cron の名前を評価する前に確かめる', () => {
    const guard = code.indexOf("to_regclass('cron.job')");
    expect(guard).toBeGreaterThan(0);
    expect(guard, 'ガードは cron.job を読むより前').toBeLessThan(code.indexOf('FROM cron.job'));
    expect(guard, 'ガードは cron.schedule より前').toBeLessThan(code.indexOf('cron.schedule('));
    expect(code).toMatch(/IF to_regclass\('cron\.job'\) IS NULL THEN[\s\S]*?RETURN;/);
  });

  it('実行ログ (RAISE) に command を載せない', () => {
    const raises = code.match(/\bRAISE\b[^;]*;/gi) ?? [];
    expect(raises.length, 'RAISE の検査が空振りしていないこと').toBeGreaterThan(0);
    for (const statement of raises) {
      expect(statement, 'RAISE に command を渡さない').not.toMatch(/\bcommand\b/i);
    }
  });
});

describe('#1492 触らないもの', () => {
  it('ロックがあったころの関数と列 (消すかは別に決める) と、既存の関数の定義には触れない', () => {
    expect(code).not.toMatch(/auth_login_lock_status|auth_login_record_failure|auth_login_apply_lock|auth_login_account_user_id/);
    expect(code).not.toMatch(/locked_until/);
    expect(code).not.toMatch(/\bDROP\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
    const created = [...code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z_.]+)\(/gi)].map((m) => m[1]).sort();
    expect(created).toEqual([`public.${CLAIM_FN}`, `public.${LOGIN_FN}`]);
  });
});

describe('#1492 個人データのエクスポートの対象外の理由', () => {
  it('ai_usage_grant_claims の理由が、実際に消すジョブを名指しする (「1 日で消す」だけの記述にしない)', () => {
    const reason = ACCOUNT_EXPORT_EXCLUDED.ai_usage_grant_claims;
    expect(reason).toBeDefined();
    expect(reason).toContain(JOB_NAME);
    expect(reason).toContain('利用者を問わず');
  });
});
