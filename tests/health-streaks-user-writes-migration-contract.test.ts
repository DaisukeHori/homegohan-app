// @vitest-environment node
/**
 * #1917: 利用者 (authenticated) が health_streaks に書ける種類を daily_record だけにした migration
 * (supabase/migrations/20261024110000_health_streaks_user_writes_daily_record_only.sql) を、ファイルの読み取りで確かめる (DB には接続しない)。
 * 修正前は INSERT / UPDATE のポリシーが auth.uid() = user_id だけで、利用者が自分の meal_record / breakfast の行に任意の
 * current_streak を入れ、比較ランキングの指標 record_streak / breakfast_streak (calculate-segment-stats) を操作できた。
 *
 *   1. migration を version 順にすべて流したときの health_streaks のポリシーは 4 本 (SELECT・INSERT・UPDATE・DELETE) で、
 *      書き込み (INSERT・UPDATE・ALL) のポリシーは、どれも streak_type = 'daily_record' に絞られている
 *      (INSERT は WITH CHECK、UPDATE は USING と WITH CHECK の両方)。後の migration が絞りを外したら、ここで赤くなる
 *   2. 本冊の migration は、INSERT・UPDATE のポリシーを作り直すだけ (権限・ほかのポリシー・行には触れない)
 *   3. 唯一の書き手 (src/lib/health-streaks.ts) が書く種類 STREAK_TYPE は、ポリシーが許す種類と同じ
 *   4. 戻し口が実在し、ポリシーはベースラインの行と逐語で同じに作り直し、流すと本冊の直前の状態に戻る (権限には触れない)
 * 実際の挙動は tests/integration/rls/health-streaks-user-writes.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { STREAK_TYPE } from '../src/lib/health-streaks';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261024110000_health_streaks_user_writes_daily_record_only';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** 本番のベースライン (health_streaks のポリシーを最初に作ったファイル) */
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';

const TABLE = 'health_streaks';
/** 利用者が書ける唯一の種類 */
const USER_WRITABLE_STREAK_TYPE = 'daily_record';
const INSERT_POLICY = 'Users can insert own health streaks';
const UPDATE_POLICY = 'Users can update own health streaks';
/** 本冊が触れないポリシー (読む・自分の行を消す) */
const UNTOUCHED_POLICIES: ReadonlyArray<readonly [string, string]> = [
  ['Users can view own health streaks', 'SELECT'],
  ['Users can delete own health streaks', 'DELETE'],
];
/** 書き込みを許すポリシーのコマンド */
const WRITE_COMMANDS = new Set(['INSERT', 'UPDATE', 'ALL']);

/** 本人の行に絞る式 (ベースライン) と、種類も絞る式 (本冊) */
const OWN_ROW_EXPR = '(auth.uid() = user_id)';
const OWN_DAILY_RECORD_EXPR = `(auth.uid() = user_id) AND (streak_type = '${USER_WRITABLE_STREAK_TYPE}')`;

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** 式の比較用: 識別子の引用符・括弧・空白を落とす (書き方の違いでなく、条件の違いだけを見る) */
const normalizeExpr = (expr: string | null): string | null => (expr === null ? null : expr.replace(/["()\s]/g, ''));

const migrationFileNames = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const readMigration = (file: string): string => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
const migrations = migrationFileNames.map((file) => ({ file, raw: readMigration(file), sql: stripLineComments(readMigration(file)) }));

const TABLE_REF = String.raw`(?:"?public"?\.)?"?${TABLE}"?`;

interface Policy {
  command: string;
  roles: string;
  using: string | null;
  check: string | null;
  /** 作った文 (コメントを除いた原文) */
  statement: string;
}

/** CREATE POLICY の本体 (ON <表> の後ろ) を分解する */
function parsePolicyBody(body: string): Omit<Policy, 'statement'> {
  const flat = body.replace(/\s+/g, ' ').trim();
  const m = /^(?:AS \w+ )?(?:FOR (\w+) )?(?:TO (.+?) )?(?:USING (.*?))?(?: ?WITH CHECK (.*))?$/i.exec(flat);
  if (!m) throw new Error(`ポリシーの本体を読めない: ${body}`);
  return {
    command: (m[1] ?? 'ALL').toUpperCase(),
    roles: (m[2] ?? 'public').replace(/"/g, '').toLowerCase(),
    using: m[3] ?? null,
    check: m[4] ?? null,
  };
}

/** SQL の中の health_streaks のポリシーの文を、書かれた順に state へ流す */
function applySql(state: Map<string, Policy>, sql: string): Map<string, Policy> {
  const events: Array<{ at: number; apply: () => void }> = [];
  const createPolicy = new RegExp(String.raw`CREATE\s+POLICY\s+"([^"]+)"\s+ON\s+${TABLE_REF}\s+([^;]*);`, 'gi');
  for (const m of sql.matchAll(createPolicy)) {
    const parsed = parsePolicyBody(m[2]);
    events.push({ at: m.index ?? 0, apply: () => state.set(m[1], { ...parsed, statement: m[0] }) });
  }
  const dropPolicy = new RegExp(String.raw`DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\s+ON\s+${TABLE_REF}(?=[\s;])`, 'gi');
  for (const m of sql.matchAll(dropPolicy)) {
    events.push({ at: m.index ?? 0, apply: () => state.delete(m[1]) });
  }
  for (const event of events.sort((a, b) => a.at - b.at)) event.apply();
  return state;
}

function stateAfter(files: ReadonlyArray<{ sql: string }>, extra: readonly string[] = []): Map<string, Policy> {
  const state = new Map<string, Policy>();
  for (const { sql } of files) applySql(state, sql);
  for (const sql of extra) applySql(state, sql);
  return state;
}

const migrationIndex = migrations.findIndex(({ file }) => file === MIGRATION_FILE);
const baselineIndex = migrations.findIndex(({ file }) => file === BASELINE_FILE);
const migrationSql = migrationIndex >= 0 ? migrations[migrationIndex].sql : '';
const rollbackRaw = fs.existsSync(ROLLBACK_PATH) ? fs.readFileSync(ROLLBACK_PATH, 'utf-8') : '';
const rollbackSql = stripLineComments(rollbackRaw);

const finalState = stateAfter(migrations);
const beforeState = stateAfter(migrations.slice(0, Math.max(migrationIndex, 0)));

describe('#1917 health_streaks: 利用者が書ける種類は daily_record だけ (migration の契約)', () => {
  it('本冊の migration とベースラインが実在する (番兵: ベースラインから 4 本のポリシーを読めている)', () => {
    expect(migrationIndex).toBeGreaterThan(0);
    expect(baselineIndex).toBeGreaterThanOrEqual(0);
    const baselineOnly = stateAfter([migrations[baselineIndex]]);
    expect(new Map([...baselineOnly].map(([name, p]) => [name, p.command]))).toEqual(
      new Map([
        ['Users can delete own health streaks', 'DELETE'],
        [INSERT_POLICY, 'INSERT'],
        [UPDATE_POLICY, 'UPDATE'],
        ['Users can view own health streaks', 'SELECT'],
      ]),
    );
    // 本冊の直前は、ベースラインのまま (streak_type を絞っていない) = 本冊が直す欠陥の前提
    expect(normalizeExpr(beforeState.get(INSERT_POLICY)?.check ?? null)).toBe(normalizeExpr(OWN_ROW_EXPR));
    expect(normalizeExpr(beforeState.get(UPDATE_POLICY)?.using ?? null)).toBe(normalizeExpr(OWN_ROW_EXPR));
  });

  it('1: 全 migration の後、ポリシーは 4 本で、INSERT・UPDATE は本人の daily_record の行だけに絞られている', () => {
    expect(new Map([...finalState].map(([name, p]) => [name, p.command]))).toEqual(
      new Map([
        ['Users can delete own health streaks', 'DELETE'],
        [INSERT_POLICY, 'INSERT'],
        [UPDATE_POLICY, 'UPDATE'],
        ['Users can view own health streaks', 'SELECT'],
      ]),
    );
    const insert = finalState.get(INSERT_POLICY);
    expect(insert?.roles).toBe('authenticated');
    expect(insert?.using).toBeNull();
    expect(normalizeExpr(insert?.check ?? null)).toBe(normalizeExpr(OWN_DAILY_RECORD_EXPR));

    const update = finalState.get(UPDATE_POLICY);
    expect(update?.roles).toBe('authenticated');
    expect(normalizeExpr(update?.using ?? null)).toBe(normalizeExpr(OWN_DAILY_RECORD_EXPR));
    expect(normalizeExpr(update?.check ?? null)).toBe(normalizeExpr(OWN_DAILY_RECORD_EXPR));
  });

  it('1: 書き込みを許すポリシー (INSERT・UPDATE・ALL) は、どれも daily_record に絞られている (種類を絞らない書き込みのポリシーを足し直していない)', () => {
    const writePolicies = [...finalState].filter(([, p]) => WRITE_COMMANDS.has(p.command));
    expect(writePolicies.map(([name]) => name).sort()).toEqual([INSERT_POLICY, UPDATE_POLICY]);
    const typeGuard = normalizeExpr(`streak_type = '${USER_WRITABLE_STREAK_TYPE}'`) ?? '';
    for (const [name, p] of writePolicies) {
      // INSERT は WITH CHECK、UPDATE・ALL は USING と WITH CHECK の両方で種類を絞る
      if (p.command !== 'INSERT') expect(normalizeExpr(p.using) ?? '', `${name} の USING`).toContain(typeGuard);
      expect(normalizeExpr(p.check) ?? '', `${name} の WITH CHECK`).toContain(typeGuard);
    }
  });

  it('1: どの migration も health_streaks のポリシーを ALTER POLICY で変えず、RLS を切らない (上の追跡が見落とす書き方)', () => {
    for (const { file, sql } of migrations) {
      expect(sql, file).not.toMatch(new RegExp(String.raw`ALTER\s+POLICY\s+"[^"]+"\s+ON\s+${TABLE_REF}(?=[\s;])`, 'i'));
      expect(sql, file).not.toMatch(new RegExp(String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?${TABLE_REF}\s+(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY`, 'i'));
    }
  });

  it('2: 本冊は INSERT・UPDATE のポリシーを作り直すだけ (権限・ほかのポリシー・行には触れない)', () => {
    const statements = migrationSql
      .split(';')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 0);
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '10s'",
      `DROP POLICY IF EXISTS "${INSERT_POLICY}" ON public.${TABLE}`,
      `CREATE POLICY "${INSERT_POLICY}" ON public.${TABLE} FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id) AND (streak_type = '${USER_WRITABLE_STREAK_TYPE}'))`,
      `DROP POLICY IF EXISTS "${UPDATE_POLICY}" ON public.${TABLE}`,
      `CREATE POLICY "${UPDATE_POLICY}" ON public.${TABLE} FOR UPDATE TO authenticated USING ((auth.uid() = user_id) AND (streak_type = '${USER_WRITABLE_STREAK_TYPE}')) WITH CHECK ((auth.uid() = user_id) AND (streak_type = '${USER_WRITABLE_STREAK_TYPE}'))`,
    ]);
    for (const [name, command] of UNTOUCHED_POLICIES) {
      expect(finalState.get(name)?.statement).toBe(beforeState.get(name)?.statement);
      expect(finalState.get(name)?.command).toBe(command);
    }
  });

  it('3: 唯一の書き手 (src/lib/health-streaks.ts) が書く種類は、ポリシーが利用者に許す種類と同じ', () => {
    expect(STREAK_TYPE).toBe(USER_WRITABLE_STREAK_TYPE);
  });

  it('4: 戻し口は、ポリシーをベースラインの行と逐語で同じに作り直し、流すと本冊の直前の状態に戻る (権限には触れない)', () => {
    expect(rollbackRaw).not.toBe('');
    expect(rollbackRaw.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    const baselineRaw = migrations[baselineIndex].raw;
    for (const name of [INSERT_POLICY, UPDATE_POLICY]) {
      const created = new RegExp(String.raw`^CREATE POLICY "${name}" ON [^\n]*;$`, 'm').exec(rollbackSql)?.[0];
      expect(created, `${name} を作り直す行`).toBeDefined();
      expect(baselineRaw.split('\n')).toContain(created);
    }
    expect(rollbackSql).not.toMatch(/\b(GRANT|REVOKE)\b/i);
    const rolledBack = stateAfter(migrations, [rollbackSql]);
    expect(new Map([...rolledBack].map(([name, p]) => [name, p.statement]))).toEqual(
      new Map([...beforeState].map(([name, p]) => [name, p.statement])),
    );
  });
});
