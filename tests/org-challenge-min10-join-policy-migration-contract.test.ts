/**
 * #1600: migration *_org_challenge_min10_join_policy.sql (と、そのロールバック) のソース走査 contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (9 人では集計を返さず 10 人で返す・別の部署向け / 下書き / 終わったチャレンジへの直接の INSERT が
 * RLS で拒まれる・正当な INSERT は通る) は、tests/integration/rls/org-challenge-progress.test.ts (H)・
 * tests/integration/rls/challenge-participants-org-scope.test.ts (#1600 INSERT)・tests/integration/security/org-challenges-api.test.ts (D)
 * が確かめる。ここでは、番号の付け直しや写し間違いで崩れやすい所を、ファイルの文面だけで確かめる。
 *   1. get_org_challenge_aggregates を本 migration の 1 つ前に定義したのは #1132 の migration で、本 migration の次に定義するのは
 *      #1688 の *_org_challenge_diff_privacy.sql (集計を控えの表から返す形に作り直した) で、それ以外に無い
 *   2. 本 migration の定義は、1 つ前の定義の写しで、変えたのは最小人数 (5 → 10) だけ。権限 (service_role だけ) も流し直す
 *   3. 参加の INSERT ポリシー「Users can join challenges」を最後に作るのが本 migration で、元の条件 (本人・自分の組織・進捗 0・順位なし) と、
 *      API と同じ条件 (開催中・使える種類・終了日 (JST)・部署の限定) を持つ
 *   4. ロールバックは、関数を 1 つ前の定義 (最小人数 5) に、ポリシーを本番スキーマのベースライン (#1238) の定義に、そのまま戻す
 *   5. 冒頭のコメントのファイル名・ロールバックの参照が実際のファイル名と一致する。差分の攻撃を既知の限界として #1688 に送ったことを書く
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORG_CHALLENGE_TYPES } from '@/lib/org-challenges';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = 'supabase/migrations';
const ROLLBACKS_DIR = 'supabase/rollbacks';
const BASELINE = 'supabase/baseline/prod_schema.sql';
const STEM_SUFFIX = '_org_challenge_min10_join_policy';
/** 本 migration の 1 つ前に get_org_challenge_aggregates を定義した migration の名前の末尾 (#1132)。ロールバックの戻す先 */
const PREVIOUS_STEM_SUFFIX = '_org_challenge_progress';
/** 本 migration の次に get_org_challenge_aggregates を定義した migration の名前の末尾 (#1688。集計を控えの表から返す) */
const NEXT_STEM_SUFFIX = '_org_challenge_diff_privacy';
const FUNCTION_NAME = 'get_org_challenge_aggregates';
const POLICY_NAME = 'Users can join challenges';
/** #1600 の前の最小人数 (#1132) と、#1600 の最小人数 (要件書 §6.4 の匿名化集計の最低人数) */
const PREVIOUS_MIN_PARTICIPANTS = 5;
const MIN_PARTICIPANTS = 10;

/** migration のファイル名 (version 14 桁 + `_` + 名前 + `.sql`) */
const MIGRATION_FILE = /^(\d{14})_.+\.sql$/;

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** SQL のコメント (-- から行末、/* ... *\/) を取り除く */
const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
/** 空白の並びを 1 つにそろえる (字下げ・改行の違いを無視して比べる) */
const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

const functionDefinition = new RegExp(
  String.raw`CREATE OR REPLACE FUNCTION public\.${FUNCTION_NAME}\([\s\S]*?\$\$[\s\S]*?\$\$;`,
);
const definesFunction = new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?${FUNCTION_NAME}"?\s*\(`, 'i');
const createsPolicy = new RegExp(String.raw`CREATE POLICY "${POLICY_NAME}"`);

/** 関数の定義 (CREATE OR REPLACE から $$; まで)。コメントを除き、空白をそろえる */
function functionOf(sql: string, where: string): string {
  const m = stripComments(sql).match(functionDefinition);
  if (!m) throw new Error(`${where} に ${FUNCTION_NAME} の定義が無い`);
  return squash(m[0]);
}

/** ポリシーの定義 (CREATE POLICY から ; まで)。コメントを除き、空白をそろえる */
function policyOf(sql: string, where: string): string {
  const code = stripComments(sql);
  const at = code.search(createsPolicy);
  if (at < 0) throw new Error(`${where} に ${POLICY_NAME} の定義が無い`);
  return squash(code.slice(at, code.indexOf(';', at) + 1));
}

const migrationFiles = (): string[] =>
  fs
    .readdirSync(path.join(ROOT, MIGRATIONS_DIR))
    .filter((f) => MIGRATION_FILE.test(f))
    .sort();

function stemOf(suffix: string): string {
  const found = migrationFiles().filter((f) => f.endsWith(`${suffix}.sql`));
  expect(found, `${suffix} の migration がちょうど 1 本ある`).toHaveLength(1);
  return found[0].replace(/\.sql$/, '');
}

/** 番号順で、文面 (コメントを除く) がパターンに当たる migration */
const filesMatching = (pattern: RegExp): string[] =>
  migrationFiles().filter((f) => pattern.test(stripComments(read(`${MIGRATIONS_DIR}/${f}`))));

describe('#1600 migration: get_org_challenge_aggregates の最小人数だけを 10 人にする', () => {
  it('get_org_challenge_aggregates を本 migration の次に定義するのは *_org_challenge_diff_privacy.sql (#1688) で、それ以外に無い。1 つ前は #1132 の migration', () => {
    const defining = filesMatching(definesFunction);
    expect(defining.slice(-3)).toEqual([
      `${stemOf(PREVIOUS_STEM_SUFFIX)}.sql`,
      `${stemOf(STEM_SUFFIX)}.sql`,
      `${stemOf(NEXT_STEM_SUFFIX)}.sql`,
    ]);
  });

  it('本 migration の定義は、1 つ前の定義の写しで、最小人数 (cfg.min_participants) だけを 5 → 10 にした', () => {
    const current = functionOf(read(`${MIGRATIONS_DIR}/${stemOf(STEM_SUFFIX)}.sql`), '本 migration');
    const previous = functionOf(read(`${MIGRATIONS_DIR}/${stemOf(PREVIOUS_STEM_SUFFIX)}.sql`), '#1132 の migration');
    const previousCfg = `SELECT ${PREVIOUS_MIN_PARTICIPANTS} AS min_participants`;
    const currentCfg = `SELECT ${MIN_PARTICIPANTS} AS min_participants`;
    expect(previous).toContain(previousCfg);
    expect(current).toContain(currentCfg);
    expect(current).toBe(previous.replace(previousCfg, currentCfg));
    // SECURITY INVOKER・STABLE・search_path = '' は元のまま (写しなので上の一致に含まれるが、崩れたときに分かるよう明示する)
    expect(current).toMatch(/LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS \$\$/);
  });

  it('権限を流し直す: PUBLIC / anon / authenticated / service_role から外し、service_role にだけ EXECUTE を渡す', () => {
    const sql = squash(stripComments(read(`${MIGRATIONS_DIR}/${stemOf(STEM_SUFFIX)}.sql`)));
    expect(sql).toContain(
      `REVOKE ALL ON FUNCTION public.${FUNCTION_NAME}(uuid) FROM PUBLIC, anon, authenticated, service_role;`,
    );
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${FUNCTION_NAME}(uuid) TO service_role;`);
    // ほかのロールに EXECUTE を渡さない
    expect(sql.match(/GRANT [^;]*;/g)).toEqual([`GRANT EXECUTE ON FUNCTION public.${FUNCTION_NAME}(uuid) TO service_role;`]);
  });

  it('本 migration は表を作らず、ほかの関数も作り直さない (範囲は最小人数と INSERT のポリシーだけ。差分の攻撃への守りは #1688)', () => {
    const sql = stripComments(read(`${MIGRATIONS_DIR}/${stemOf(STEM_SUFFIX)}.sql`));
    expect(sql).not.toMatch(/CREATE\s+TABLE/i);
    expect([...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1])).toEqual([FUNCTION_NAME]);
  });
});

describe('#1600 migration: 参加の INSERT ポリシーに API と同じ条件を足す', () => {
  const policy = () => policyOf(read(`${MIGRATIONS_DIR}/${stemOf(STEM_SUFFIX)}.sql`), '本 migration');

  it('「Users can join challenges」を最後に作るのは本 migration で、作る前に同じ名前のポリシーを消す (何度流しても 1 本)', () => {
    expect(filesMatching(createsPolicy).slice(-1)).toEqual([`${stemOf(STEM_SUFFIX)}.sql`]);
    const sql = squash(stripComments(read(`${MIGRATIONS_DIR}/${stemOf(STEM_SUFFIX)}.sql`)));
    const drop = `DROP POLICY IF EXISTS "${POLICY_NAME}" ON public.organization_challenge_participants;`;
    expect(sql).toContain(drop);
    expect(sql.indexOf(drop)).toBeLessThan(sql.search(createsPolicy));
  });

  it('INSERT・authenticated に限り、元の条件 (本人・自分の組織のチャレンジ・進捗 0・順位なし) をそのまま持つ', () => {
    const p = policy();
    expect(p).toMatch(/ON public\.organization_challenge_participants FOR INSERT TO authenticated WITH CHECK \(/);
    expect(p).toContain('user_id = (SELECT auth.uid())');
    expect(p).toContain('JOIN public.user_profiles AS up ON up.organization_id = oc.organization_id');
    expect(p).toContain('oc.id = organization_challenge_participants.challenge_id');
    expect(p).toContain('up.id = (SELECT auth.uid())');
    expect(p).toContain('COALESCE(current_value, 0) = 0');
    expect(p).toContain('rank IS NULL');
  });

  it('API (POST /api/org/challenges/[id]/join) と同じ条件: 開催中・使える種類・終了日 (JST) を過ぎていない・部署の限定', () => {
    const p = policy();
    expect(p).toContain("oc.status = 'active'");
    const types = p.match(/oc\.challenge_type IN \(([^)]+)\)/);
    expect(types, '種類の絞り込みが無い').not.toBeNull();
    expect([...types![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...ORG_CHALLENGE_TYPES].sort());
    expect(p).toContain("oc.end_date >= (now() AT TIME ZONE 'Asia/Tokyo')::date");
    expect(p).toContain('(oc.department_id IS NULL OR oc.department_id = up.department_id)');
  });
});

describe('#1600 ロールバック', () => {
  const rollbackPath = () => `${ROLLBACKS_DIR}/${stemOf(STEM_SUFFIX)}.down.sql`;

  it('関数を 1 つ前 (#1132) の定義 (最小人数 5) にそのまま戻し、権限も service_role だけにする', () => {
    const rollback = read(rollbackPath());
    const previous = functionOf(read(`${MIGRATIONS_DIR}/${stemOf(PREVIOUS_STEM_SUFFIX)}.sql`), '#1132 の migration');
    expect(functionOf(rollback, 'ロールバック')).toBe(previous);
    const sql = squash(stripComments(rollback));
    expect(sql).toContain(
      `REVOKE ALL ON FUNCTION public.${FUNCTION_NAME}(uuid) FROM PUBLIC, anon, authenticated, service_role;`,
    );
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${FUNCTION_NAME}(uuid) TO service_role;`);
  });

  it('INSERT のポリシーを、本番スキーマのベースライン (#1238) の定義にそのまま戻す', () => {
    const rollback = read(rollbackPath());
    expect(policyOf(rollback, 'ロールバック')).toBe(policyOf(read(BASELINE), 'ベースライン'));
    expect(squash(stripComments(rollback))).toContain(
      `DROP POLICY IF EXISTS "${POLICY_NAME}" ON public.organization_challenge_participants;`,
    );
  });
});

describe('#1600 冒頭のコメント', () => {
  it('冒頭のファイル名・ロールバックの参照が、実際のファイル名と一致する', () => {
    const stem = stemOf(STEM_SUFFIX);
    const migration = read(`${MIGRATIONS_DIR}/${stem}.sql`);
    expect(migration.split('\n')[0]).toBe(`-- migration: ${stem}.sql`);
    expect(migration).toContain(`-- ロールバック: ${ROLLBACKS_DIR}/${stem}.down.sql`);
    expect(read(`${ROLLBACKS_DIR}/${stem}.down.sql`).split('\n')[0]).toBe(`-- rollback: ${stem}.sql`);
  });

  it('差分の攻撃が残ることを、既知の限界として書き、#1688 で設計すると書く', () => {
    const migration = read(`${MIGRATIONS_DIR}/${stemOf(STEM_SUFFIX)}.sql`);
    expect(migration).toMatch(/^-- 既知の限界[^\n]*差分の攻撃[^\n]*#1688 で設計する/m);
  });
});
