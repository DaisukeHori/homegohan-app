/**
 * #1600 migration *_org_challenge_aggregate_snapshot.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (9 人では集計を返さない・10 人で返す・やめた直後に集計も順位表も動かない・終了したチャレンジを開催中に戻しても
 * 控えが動かない・直接の INSERT が拒まれる) は
 * tests/integration/rls/org-challenge-progress.test.ts / tests/integration/security/org-challenges-api.test.ts /
 * tests/integration/rls/challenge-participants-org-scope.test.ts が確かめる。
 * ここでは、後の migration の上書きや番号の付け直しで崩れやすい所を、ファイルの文面だけで確かめる。
 *   1. 関数 update_org_challenge_progress / get_org_challenge_aggregates / get_org_challenge_ranking / refresh_org_challenge_aggregates を
 *      最後に定義した migration が本 migration で、get_org_challenge_aggregates は控え (organization_challenge_aggregates) から、
 *      get_org_challenge_ranking は順位表の控え (organization_challenge_ranking_entries) から読み、参加者の行を直接数えない・並べない
 *   2. update_org_challenge_progress の定義は、20261014100100 の定義に「控えの数え直し」と返す jsonb の aggregates を足しただけ。
 *      数え直しは、進み具合・順位の書き込みのあと・終了にする前
 *   3. 控えを書き直すのは、開催中で集計に含める最後の日が進んだチャレンジ (控えが無いものを含む。開始前も) と、控えの無い終了・中止の
 *      チャレンジだけ。下書きは作らない
 *   4. 権限: 4 本とも service_role だけ。控えの 2 つの表は RLS を有効にし、ポリシーを作らず、anon / authenticated の権限を外す
 *   5. 参加の INSERT ポリシーの最後の定義が、API (POST /api/org/challenges/[id]/join) と同じ条件を見る
 *   6. ロールバックは、20261014100100 の 3 本の定義と #1238 の INSERT ポリシー (本番 baseline) にそのまま戻し、控えと関数を消す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_CHALLENGE_MIN_PARTICIPANTS, ORG_CHALLENGE_TYPES } from '@/lib/org-challenges';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const STEM_SUFFIX = '_org_challenge_aggregate_snapshot';
/** #1132 の migration (本 migration が作り直す 2 本の、1 つ前の定義。ロールバックの戻す先) */
const PREVIOUS_STEM_SUFFIX = '_org_challenge_progress';
/** 要件書 (docs/requirements/02-organization-management.md §6.4) の匿名化集計の最低人数 */
const REQUIRED_MIN_PARTICIPANTS = 10;
/** 本 migration が service_role だけに EXECUTE を渡す関数 (引数の型まで含めた完全形)。先頭は本 migration で新しく作るもの */
const SERVICE_ROLE_FUNCTIONS = [
  'public.refresh_org_challenge_aggregates(timestamptz)',
  'public.update_org_challenge_progress(timestamptz)',
  'public.get_org_challenge_aggregates(uuid)',
  'public.get_org_challenge_ranking(uuid, uuid, integer, boolean)',
];
/** 本 migration が作り直し、ロールバックが 20261014100100 の定義に戻す関数 */
const REPLACED_FUNCTIONS = ['update_org_challenge_progress', 'get_org_challenge_aggregates', 'get_org_challenge_ranking'];
/** 本 migration が作る控えの表 (service_role だけが読み書きする) */
const SNAPSHOT_TABLES = ['organization_challenge_aggregates', 'organization_challenge_ranking_entries'];

const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

const migrationFiles = fs
  .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
  .filter((name) => MIGRATION_FILE.test(name))
  .sort();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** SQL のコメント (-- から行末、/* ... *\/) を取り除く。コメントの中の語を拾わないように */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

function onlyFileWithSuffix(dir: string, suffix: string, ext: string): string {
  const found = fs.readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith(`${suffix}${ext}`));
  expect(found, `${dir} に *${suffix}${ext} がちょうど 1 つある`).toHaveLength(1);
  return found[0];
}

const MIGRATION_NAME = onlyFileWithSuffix(MIGRATIONS_DIR, STEM_SUFFIX, '.sql');
const PREVIOUS_NAME = onlyFileWithSuffix(MIGRATIONS_DIR, PREVIOUS_STEM_SUFFIX, '.sql');
const ROLLBACK_NAME = onlyFileWithSuffix(ROLLBACKS_DIR, STEM_SUFFIX, '.down.sql');
const MIGRATION = stripSqlComments(read(`${MIGRATIONS_DIR}/${MIGRATION_NAME}`));
const PREVIOUS = stripSqlComments(read(`${MIGRATIONS_DIR}/${PREVIOUS_NAME}`));
const ROLLBACK = stripSqlComments(read(`${ROLLBACKS_DIR}/${ROLLBACK_NAME}`));
const BASELINE = read('supabase/baseline/prod_schema.sql');
const JOIN_ROUTE = read('src/app/api/org/challenges/[id]/join/route.ts');

/** CREATE OR REPLACE FUNCTION public.<name>( ... $$ 本体 $$; の全体 (定義の文) */
function definition(sql: string, name: string): string {
  const m = sql.match(new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${name}\([\s\S]*?\$\$[\s\S]*?\$\$;`));
  if (!m) throw new Error(`関数 ${name} の定義が見つからない`);
  return m[0];
}

/** 定義の本体 ($$ と $$ の間) */
function bodyOf(sql: string, name: string): string {
  return definition(sql, name).match(/\$\$([\s\S]*?)\$\$/)![1];
}

/** 関数を最後に定義した migration のファイル名 */
function lastDefiner(name: string): string {
  const pattern = new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${name}\(`);
  const found = migrationFiles.filter((f) => pattern.test(stripSqlComments(read(`${MIGRATIONS_DIR}/${f}`))));
  if (found.length === 0) throw new Error(`関数 ${name} を定義する migration が無い`);
  return found[found.length - 1];
}

/** 参加の INSERT ポリシー「Users can join challenges」を最後に作った migration の、その CREATE POLICY 文 */
function lastJoinPolicy(): string {
  const statements = migrationFiles
    .map((f) => stripSqlComments(read(`${MIGRATIONS_DIR}/${f}`)).match(/CREATE POLICY "Users can join challenges"[\s\S]*?\);\s*(?:\n|$)/))
    .filter((m): m is RegExpMatchArray => m !== null);
  if (statements.length === 0) throw new Error('「Users can join challenges」を作る migration が無い');
  return statements[statements.length - 1][0];
}

/** 空白の違いを無視して比べる */
function squash(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** SQL の中の 'a', 'b', 'c' のような文字列の並び */
function quotedList(sql: string): string[] {
  return [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('1. 最後の定義が本 migration で、集計は控えから読む', () => {
  it.each([...REPLACED_FUNCTIONS, 'refresh_org_challenge_aggregates'])(
    '%s を最後に定義した migration は本 migration',
    (name) => {
      expect(lastDefiner(name)).toBe(MIGRATION_NAME);
    },
  );

  it('本 migration は #1132 の migration より後の番号', () => {
    expect(MIGRATION_NAME > PREVIOUS_NAME).toBe(true);
  });

  it('get_org_challenge_aggregates は控えの表から読み、参加者の行を直接数えない。最小人数は 10 人 (共有の定数と同じ)', () => {
    const body = bodyOf(MIGRATION, 'get_org_challenge_aggregates');
    expect(body).toMatch(/LEFT JOIN public\.organization_challenge_aggregates AS s\s+ON s\.challenge_id = c\.id/);
    expect(body).not.toMatch(/organization_challenge_participants/);
    const m = body.match(/SELECT (\d+) AS min_participants/);
    expect(m, '最小人数が見つからない').not.toBeNull();
    expect(Number(m![1])).toBe(REQUIRED_MIN_PARTICIPANTS);
    expect(ORG_CHALLENGE_MIN_PARTICIPANTS).toBe(REQUIRED_MIN_PARTICIPANTS);
    // 人数も平均も、控えの人数が最小人数以上のときだけ出す
    expect(body).toMatch(/CASE WHEN s\.participant_count >= cfg\.min_participants THEN s\.participant_count::bigint END/);
    expect(body).toMatch(/CASE WHEN s\.ranked_count >= cfg\.min_participants THEN round\(s\.average_value, 1\) END/);
  });

  it.each(['get_org_challenge_aggregates', 'get_org_challenge_ranking'])(
    '%s の引数・返す列・SECURITY INVOKER・STABLE・search_path は 20261014100100 と同じ',
    (name) => {
      const header = (sql: string) => squash(definition(sql, name).split('$$')[0]);
      expect(header(MIGRATION)).toBe(header(PREVIOUS));
      expect(header(MIGRATION)).toContain('SECURITY INVOKER');
      expect(header(MIGRATION)).toContain('STABLE');
      expect(header(MIGRATION)).toContain("SET search_path = ''");
    },
  );

  it('get_org_challenge_ranking は順位表の控えから並べ、参加者の行は「見る人がいま参加者か」の確認にだけ使う。人数の決め方 (cfg) は 20261014100100 と同じ', () => {
    const body = bodyOf(MIGRATION, 'get_org_challenge_ranking');
    const ranked = body.match(/ranked AS \(([\s\S]*?)\)\s*SELECT r\.rank/);
    expect(ranked, '順位表の CTE (ranked) が見つからない').not.toBeNull();
    expect(ranked![1]).toMatch(/FROM public\.organization_challenge_ranking_entries AS e/);
    expect(ranked![1]).not.toMatch(/organization_challenge_participants/);
    // 見られる人の確認 (EXISTS) は、20261014100100 と同じ (いまの参加者で、今も組織のメンバーである本人だけ)
    const gate = (sql: string) => squash(bodyOf(sql, 'get_org_challenge_ranking').match(/AND EXISTS \(([\s\S]*?)\)\s*ORDER BY r\.pos/)![1]);
    expect(gate(MIGRATION)).toBe(gate(PREVIOUS));
    const cfg = (sql: string) => bodyOf(sql, 'get_org_challenge_ranking').match(/SELECT \d+ AS default_limit, \d+ AS max_limit/)![0];
    expect(cfg(MIGRATION)).toBe(cfg(PREVIOUS));
  });
});

describe('2. update_org_challenge_progress は、1 つ前の定義に控えの数え直しを足しただけ', () => {
  const CALL = /\n\s*v_aggregates := public\.refresh_org_challenge_aggregates\(p_now\);\n/;
  const DECLARE = /\n\s*v_aggregates\s+integer := 0;/;
  const RESULT_KEY = /\n\s*'aggregates',\s+v_aggregates,/;

  it('数え直しの呼び出し・変数・返す jsonb のキーを除くと、20261014100100 の定義と同じ', () => {
    const current = definition(MIGRATION, 'update_org_challenge_progress');
    for (const added of [CALL, DECLARE, RESULT_KEY]) expect(current).toMatch(added);
    const stripped = current.replace(CALL, '\n').replace(DECLARE, '').replace(RESULT_KEY, '');
    expect(squash(stripped)).toBe(squash(definition(PREVIOUS, 'update_org_challenge_progress')));
  });

  it('数え直しは、進み具合・順位の書き込みのあと、終了にする (completed) 前', () => {
    const body = bodyOf(MIGRATION, 'update_org_challenge_progress');
    const written = body.indexOf('UPDATE public.organization_challenge_participants');
    const refresh = body.search(/public\.refresh_org_challenge_aggregates\(p_now\)/);
    const complete = body.indexOf("SET status = 'completed'");
    expect(written).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(written);
    expect(complete).toBeGreaterThan(refresh);
  });
});

describe('3. 控えを書き直すのは、集計に含める最後の日が進んだときだけ', () => {
  const body = bodyOf(MIGRATION, 'refresh_org_challenge_aggregates');
  /** 数え直すチャレンジを選ぶ文 (SELECT ... INTO v_targets ... ;) */
  const targets = body.match(/SELECT COALESCE\(array_agg\(c\.id\), '\{\}'::uuid\[\]\)\s+INTO v_targets([\s\S]*?);/);

  it('集計に含める最後の日は、update_org_challenge_progress と同じ決め方 (JST の今日の前日。終了日で打ち切る)', () => {
    expect(body).toMatch(/v_today\s+:= \(COALESCE\(p_now, now\(\)\) AT TIME ZONE 'Asia\/Tokyo'\)::date;/);
    expect(body).toMatch(/v_last_day := v_today - 1;/);
    expect(bodyOf(MIGRATION, 'update_org_challenge_progress')).toMatch(/v_last_day := v_today - 1;/);
    expect(body).toMatch(/LEAST\(c\.end_date, v_last_day\)\s+AS counted_through/);
  });

  it("対象は、開催中で控えが無いか最後の日が進んだもの (開始日は見ない) と、控えの無い終了・中止。下書きは入らない", () => {
    expect(targets, '数え直すチャレンジを選ぶ文が見つからない').not.toBeNull();
    const where = squash(targets![1]);
    expect(where).toContain(
      "WHERE (c.status = 'active' AND (s.challenge_id IS NULL OR LEAST(c.end_date, v_last_day) > s.counted_through)) " +
        "OR (c.status IN ('completed', 'cancelled') AND s.challenge_id IS NULL)",
    );
    expect(where).not.toMatch(/start_date/);
    expect(quotedList(where).sort()).toEqual(['active', 'cancelled', 'completed']);
  });

  it('集計と順位表の控えは、選んだチャレンジだけを書く。最後の日 (counted_through) も一緒に書く', () => {
    expect([...body.matchAll(/c\.id = ANY \(v_targets\)/g)]).toHaveLength(2);
    expect(body).toMatch(/DELETE FROM public\.organization_challenge_ranking_entries AS e\s+WHERE e\.challenge_id = ANY \(v_targets\);/);
    expect(body).toMatch(/counted_through\s+= EXCLUDED\.counted_through/);
    // 値が同じでも最後の日は進めて書く (書かずにおくと、次の機会に「進んだ」と見なされ、人の出入りだけが控えに入る)
    expect(body).not.toMatch(/IS DISTINCT FROM/);
  });

  it('数えるのは今も組織のメンバーである参加者だけ (update_org_challenge_progress と同じ絞り込み)。順位表は順位がついた人だけ', () => {
    expect([...body.matchAll(/JOIN public\.user_profiles AS up\s+ON up\.id = p\.user_id\s+AND up\.organization_id = c\.organization_id/g)]).toHaveLength(2);
    expect(body).toMatch(/WHERE c\.id = ANY \(v_targets\)\s+AND p\.rank IS NOT NULL;/);
  });

  it('update_org_challenge_progress と同じ鍵で直列にする', () => {
    const lock = "pg_advisory_xact_lock(hashtextextended('public.update_org_challenge_progress', 0))";
    expect(body).toContain(lock);
    expect(bodyOf(MIGRATION, 'update_org_challenge_progress')).toContain(lock);
  });

  it('SECURITY DEFINER・search_path が空', () => {
    const header = squash(definition(MIGRATION, 'refresh_org_challenge_aggregates').split('$$')[0]);
    expect(header).toContain('SECURITY DEFINER');
    expect(header).toContain("SET search_path = ''");
  });
});

describe('4. 権限', () => {
  it.each(SERVICE_ROLE_FUNCTIONS)('%s の EXECUTE は service_role だけ (PUBLIC / anon / authenticated から外す)', (fn) => {
    const escaped = fn.replace(/[.()]/g, (c) => `\\${c}`);
    expect(MIGRATION).toMatch(new RegExp(String.raw`REVOKE ALL ON FUNCTION ${escaped}\s+FROM PUBLIC, anon, authenticated, service_role;`));
    expect(MIGRATION).toMatch(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION ${escaped}\s+TO service_role;`));
    const grants = [...MIGRATION.matchAll(new RegExp(String.raw`GRANT [A-Z, ]+ ON FUNCTION ${escaped}\s+TO ([a-z_, ]+);`, 'g'))];
    expect(grants.map((g) => g[1].trim())).toEqual(['service_role']);
  });

  it.each(SNAPSHOT_TABLES)('控えの表 %s は RLS を有効にし、ポリシーを作らず、anon / authenticated の権限を外す', (table) => {
    expect(MIGRATION).toMatch(new RegExp(String.raw`ALTER TABLE public\.${table} ENABLE ROW LEVEL SECURITY;`));
    expect(MIGRATION).toMatch(new RegExp(String.raw`REVOKE ALL ON TABLE public\.${table} FROM PUBLIC, anon, authenticated;`));
    expect(MIGRATION).not.toMatch(new RegExp(String.raw`CREATE POLICY[^;]*ON public\.${table}\b`));
    expect(MIGRATION).not.toMatch(new RegExp(String.raw`GRANT [^;]*ON TABLE public\.${table} TO [^;]*(anon|authenticated)`));
  });

  it('順位表の控えは、アカウントを消した人の行をその場で消す (auth.users を ON DELETE CASCADE で参照する)', () => {
    const table = MIGRATION.match(/CREATE TABLE IF NOT EXISTS public\.organization_challenge_ranking_entries \(([\s\S]*?)\);/);
    expect(table).not.toBeNull();
    expect(squash(table![1])).toContain('user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(squash(table![1])).toContain('PRIMARY KEY (challenge_id, user_id)');
  });
});

describe('5. 参加の INSERT ポリシーは、API と同じ条件を見る', () => {
  const policy = squash(lastJoinPolicy());

  it('最後に作ったのは本 migration', () => {
    const lastFile = migrationFiles.filter((f) => /CREATE POLICY "Users can join challenges"/.test(stripSqlComments(read(`${MIGRATIONS_DIR}/${f}`)))).pop();
    expect(lastFile).toBe(MIGRATION_NAME);
  });

  it('元の条件 (本人・自分の組織のチャレンジ・進捗 0・順位なし) を残す', () => {
    expect(policy).toContain('FOR INSERT TO authenticated');
    expect(policy).toContain('user_id = (SELECT auth.uid())');
    expect(policy).toContain('ON up.organization_id = oc.organization_id');
    expect(policy).toContain('WHERE oc.id = organization_challenge_participants.challenge_id');
    expect(policy).toContain('AND up.id = (SELECT auth.uid())');
    expect(policy).toContain('AND COALESCE(current_value, 0) = 0');
    expect(policy).toContain('AND rank IS NULL');
  });

  it("開催中 (status = 'active') だけ。API は 409 CHALLENGE_NOT_ACTIVE", () => {
    expect(policy).toContain("AND oc.status = 'active'");
    expect(JOIN_ROUTE).toMatch(/challenge\.status !== 'active'[\s\S]{0,200}CHALLENGE_NOT_ACTIVE/);
  });

  it('種類は、食事の記録から計算できる種類 (ORG_CHALLENGE_TYPES) だけ。API は 409 CHALLENGE_TYPE_DISABLED', () => {
    const m = policy.match(/AND oc\.challenge_type IN \(([^)]+)\)/);
    expect(m, 'ポリシーに種類の絞り込みが無い').not.toBeNull();
    expect(quotedList(m![1]).sort()).toEqual([...ORG_CHALLENGE_TYPES].sort());
    expect(JOIN_ROUTE).toMatch(/!isOrgChallengeType\(challenge\.challenge_type\)[\s\S]{0,200}CHALLENGE_TYPE_DISABLED/);
  });

  it('終了日 (JST の暦日) を過ぎていない。API は 409 CHALLENGE_ENDED (todayJst と同じ決め方)', () => {
    expect(policy).toContain("AND oc.end_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date");
    expect(JOIN_ROUTE).toMatch(/challenge\.end_date < todayJst\(\)[\s\S]{0,200}CHALLENGE_ENDED/);
  });

  it('部署を限定したチャレンジは、その部署のメンバーだけ。API は 403 PERM_DEPARTMENT_MISMATCH', () => {
    expect(policy).toContain('AND (oc.department_id IS NULL OR oc.department_id = up.department_id)');
    expect(JOIN_ROUTE).toMatch(
      /challenge\.department_id && challenge\.department_id !== profile\.department_id[\s\S]{0,200}PERM_DEPARTMENT_MISMATCH/,
    );
  });
});

describe('6. ロールバック', () => {
  it.each(REPLACED_FUNCTIONS)('%s を 20261014100100 の定義にそのまま戻す', (name) => {
    expect(squash(definition(ROLLBACK, name))).toBe(squash(definition(PREVIOUS, name)));
  });

  it('戻した 3 本の EXECUTE も service_role だけ', () => {
    for (const fn of SERVICE_ROLE_FUNCTIONS.slice(1)) {
      const escaped = fn.replace(/[.()]/g, (c) => `\\${c}`);
      expect(ROLLBACK).toMatch(new RegExp(String.raw`REVOKE ALL ON FUNCTION ${escaped}\s+FROM PUBLIC, anon, authenticated, service_role;`));
      expect(ROLLBACK).toMatch(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION ${escaped}\s+TO service_role;`));
    }
  });

  it('関数を戻したあとに、数え直しの関数と控えの表を消す', () => {
    const restored = Math.max(
      ...REPLACED_FUNCTIONS.map((name) => ROLLBACK.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)),
    );
    expect(Math.min(...REPLACED_FUNCTIONS.map((name) => ROLLBACK.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)))).toBeGreaterThan(-1);
    const dropFn = ROLLBACK.indexOf('DROP FUNCTION IF EXISTS public.refresh_org_challenge_aggregates(timestamptz);');
    expect(dropFn).toBeGreaterThan(restored);
    for (const table of SNAPSHOT_TABLES) {
      expect(ROLLBACK.indexOf(`DROP TABLE IF EXISTS public.${table};`), table).toBeGreaterThan(dropFn);
    }
  });

  it('INSERT ポリシーを #1238 の定義 (本番 baseline) にそのまま戻す', () => {
    const baselinePolicy = BASELINE.match(/CREATE POLICY "Users can join challenges"[\s\S]*?\);\n/);
    const rollbackPolicy = ROLLBACK.match(/CREATE POLICY "Users can join challenges"[\s\S]*?\);\n?/);
    expect(baselinePolicy).not.toBeNull();
    expect(rollbackPolicy).not.toBeNull();
    expect(squash(rollbackPolicy![0])).toBe(squash(baselinePolicy![0]));
    expect(ROLLBACK).toMatch(/DROP POLICY IF EXISTS "Users can join challenges" ON public\.organization_challenge_participants;/);
  });

  it('migration とロールバックの冒頭のコメントが、実際のファイル名を指す', () => {
    const rawMigration = read(`${MIGRATIONS_DIR}/${MIGRATION_NAME}`);
    const rawRollback = read(`${ROLLBACKS_DIR}/${ROLLBACK_NAME}`);
    expect(rawMigration.split('\n')[0]).toBe(`-- migration: ${MIGRATION_NAME}`);
    expect(rawMigration).toContain(`supabase/rollbacks/${ROLLBACK_NAME}`);
    expect(rawRollback.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_NAME}`);
    expect(ROLLBACK_NAME).toBe(MIGRATION_NAME.replace(/\.sql$/, '.down.sql'));
  });
});
