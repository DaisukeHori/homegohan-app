/**
 * #1917 整合ゲートの候補 2 件: migration 20261022190000_db_privilege_hardening.sql (と、そのロールバック) の contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (owner / admin の直接の UPDATE が 42501・service_role と解散の RPC は通る・全表で anon / authenticated に
 * TRUNCATE が無い・既定の権限にも無い) は tests/integration/security/db-privilege-hardening.test.ts が確かめる。
 * ここでは、文面だけで崩れやすい所を確かめる。
 *   1. migration の関数の外の文は、ロックの待ちの上限・TRUNCATE を外す DO ブロック・既定の権限の REVOKE だけ (GRANT は無い)
 *   2. guard_organizations_privileged の最新の定義: 5 列 (owner_id・status・subscription_status・subscription_expires_at・
 *      dissolved_at) を守り、既存のエラーの形 (CANNOT_MODIFY_PRIVILEGED_COLUMN / 42501)・current_user の見分け方・
 *      SECURITY INVOKER・search_path の指定なしのまま
 *   3. 同じ型の機械検査: 守る 3 列 (subscription_status・subscription_expires_at・dissolved_at) を書く関数の最新の定義は、
 *      どれも SECURITY DEFINER か、利用者が実行できない関数。この migration より後の migration が、anon / authenticated / PUBLIC へ
 *      表の TRUNCATE (ALL を含む) を付け直していない (既定の権限も)
 *   4. ロールバック: ガードをベースラインの定義に逐語で戻し、既定の権限と表の TRUNCATE を付け直す。
 *      付け直す表の選び方 (REFERENCES と TRIGGER を持つ・個別に TRUNCATE を外した表を除く) の前提が、migration の履歴で成り立つ
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION_STEM = '20261022190000_db_privilege_hardening';
const MIGRATION_FILE = `${MIGRATION_STEM}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION_STEM}.down.sql`);
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';
/** ベースラインの guard_organizations_privileged の定義の行 (1 始まり・両端を含む) */
const GUARD_BASE_LINES = { from: 1826, to: 1837 } as const;
const GUARD_FUNCTION = 'guard_organizations_privileged';
/** この migration で守る列に足した 3 列 */
const ADDED_COLUMNS = ['subscription_status', 'subscription_expires_at', 'dissolved_at'] as const;
/** この migration の後に守る列の全部 (ベースラインの 2 列 + 足した 3 列) */
const GUARDED_COLUMNS = ['owner_id', 'status', ...ADDED_COLUMNS] as const;
/** TRUNCATE を外す対象の relkind (表・パーティションの親・ビュー・マテリアライズドビュー・外部表) */
const RELKINDS = ['r', 'p', 'v', 'm', 'f'] as const;
/** ロールバックが TRUNCATE を付け直さない表 (この migration より前に TRUNCATE だけを個別に外した表) */
const ROLLBACK_EXCLUDED_TABLES = [
  'weekly_menu_requests',
  'meal_image_jobs',
  'family_invites',
  'org_license_pools',
  'organization_invites',
] as const;

/**
 * 守る 3 列を書くが SECURITY INVOKER のままでよい関数 (利用者 (anon / authenticated) が実行できない)。キーは関数名。理由を書く
 */
const INVOKER_WRITERS_NOT_EXECUTABLE_BY_USERS: Readonly<Record<string, string>> = {
  org_dissolve_apply:
    'EXECUTE は service_role だけ (20261019120000_self_dissolve.sql)。dissolve_org_by_owner / operator_force_dissolve_org (SECURITY DEFINER) の中から所有者の権限で呼ばれる',
};

const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const readMigration = (file: string): string => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

/** SQL の行コメント (-- から行末) を除く */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');

/** ドル引用 ($$ ... $$ / $tag$ ... $tag$) の中身を除く (関数・DO ブロックの本文の中の文を、文として数えない) */
function stripDollarQuoted(sql: string): string {
  return sql.replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, '$$$$');
}

/** コメントと関数の本文を除き、空白を 1 つに詰めて、文 (セミコロン区切り) に分ける */
function statements(sql: string): string[] {
  return stripDollarQuoted(stripLineComments(sql))
    .replace(/\s+/g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface GrantStatement {
  /** 権限の並び (大文字) */
  privileges: string[];
  /** ON の後ろ (対象) */
  target: string;
  /** TO の後ろ (受け取るロール) */
  grantees: string;
}

/** GRANT 文 (ALTER DEFAULT PRIVILEGES ... GRANT を含む) を分解する。GRANT でなければ null */
function parseGrant(statement: string): GrantStatement | null {
  const m = /^(?:ALTER\s+DEFAULT\s+PRIVILEGES\b[\s\S]*?\s)?GRANT\s+([\s\S]*?)\s+ON\s+([\s\S]*?)\s+TO\s+([\s\S]*)$/i.exec(statement);
  if (!m) return null;
  return { privileges: m[1].split(',').map((p) => p.trim().toUpperCase()), target: m[2], grantees: m[3] };
}

/** 対象が表・ビュー (ON TABLE x / ON x / ON TABLES / ON ALL TABLES IN SCHEMA) か (関数・シーケンス・スキーマ・型でない) */
const isTableTarget = (target: string): boolean =>
  !/^(?:ALL\s+)?(?:FUNCTIONS?|ROUTINES?|PROCEDURES?|SEQUENCES?|SCHEMA|TYPES?|DOMAIN|LANGUAGE|LARGE|FOREIGN|DATABASE|TABLESPACE)\b/i.test(target);

/** 受け取るロールに利用者 (anon / authenticated / PUBLIC) を含むか */
const toUsers = (grantees: string): boolean => /(?:^|[\s,"])(?:anon|authenticated|PUBLIC)(?:$|[\s,"])/i.test(grantees);

interface FunctionDefinition {
  file: string;
  /** CREATE OR REPLACE FUNCTION ... AS $$ の手前まで (属性: SECURITY DEFINER・SET search_path など) */
  header: string;
  body: string;
  /** CREATE OR REPLACE FUNCTION から本文の終わりのドル引用まで */
  text: string;
}

/** 与えた SQL の中の CREATE OR REPLACE FUNCTION を、名前ごとに出現順ですべて返す */
function definitionsIn(file: string, sql: string): Array<FunctionDefinition & { name: string }> {
  const found: Array<FunctionDefinition & { name: string }> = [];
  const pattern = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:"?public"?\.)?"?([A-Za-z0-9_]+)"?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    const rest = sql.slice(match.index);
    const opener = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
    if (!opener) continue;
    const bodyStart = opener.index + opener[0].length;
    const bodyEnd = rest.indexOf(opener[1], bodyStart);
    if (bodyEnd < 0) continue;
    found.push({
      name: match[1],
      file,
      header: rest.slice(0, opener.index),
      body: rest.slice(bodyStart, bodyEnd),
      text: rest.slice(0, bodyEnd + opener[1].length),
    });
  }
  return found;
}

/** 各関数の最新の定義 (migration を version 順に見て、最後に CREATE OR REPLACE したもの) */
const latestDefinitions = new Map<string, FunctionDefinition>();
for (const file of migrationFiles) {
  for (const def of definitionsIn(file, readMigration(file))) {
    latestDefinitions.set(def.name, def);
  }
}

function latestOf(name: string): FunctionDefinition {
  const def = latestDefinitions.get(name);
  expect(def, `${name} の定義が migration に見つからない`).toBeDefined();
  return def!;
}

/** ファイルの行 (1 始まり・両端を含む) */
function linesOf(file: string, range: { from: number; to: number }): string {
  return readMigration(file)
    .split('\n')
    .slice(range.from - 1, range.to)
    .join('\n');
}

/** 本文の IF の条件で守っている列 (NEW.<列> IS DISTINCT FROM OLD.<列>) */
function guardedColumnsOf(body: string): string[] {
  return [...stripLineComments(body).matchAll(/NEW\.(\w+)\s+IS\s+DISTINCT\s+FROM\s+OLD\.(\w+)/gi)].map((m) => {
    expect(m[1], `NEW と OLD で同じ列を比べる: ${m[0]}`).toBe(m[2]);
    return m[1];
  });
}

/** organizations の行に、cols のどれかを書く UPDATE があるか (UPDATE organizations SET ... ; の SET の中) */
function updatesOrganizationsColumns(body: string, cols: readonly string[]): boolean {
  const pattern = /(?<!FOR\s)\bUPDATE\s+(?:"?public"?\.)?"?organizations"?\s+SET\b([\s\S]*?)(?:;|$)/gi;
  const code = stripLineComments(body);
  for (const m of code.matchAll(pattern)) {
    const setClause = m[1];
    if (cols.some((col) => new RegExp(`(?:^|[\\s,(])"?${col}"?\\s*=`, 'i').test(setClause))) return true;
  }
  return false;
}

const migrationSql = readMigration(MIGRATION_FILE);
const migration = statements(migrationSql);
const rollbackSql = fs.readFileSync(ROLLBACK_PATH, 'utf8');
const rollback = statements(rollbackSql);

/** DO $$ ... $$ ブロックの本文 (1 つだけあること) */
function onlyDoBlockBody(sql: string): string {
  const blocks = [...stripLineComments(sql).matchAll(/\bDO\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/g)].map((m) => m[2]);
  expect(blocks).toHaveLength(1);
  return blocks[0].replace(/\s+/g, ' ');
}

describe('#1917 20261022190000 の migration', () => {
  it('関数の外の文は、ロックの待ちの上限・TRUNCATE を外す DO ブロック・既定の権限の REVOKE だけ (GRANT は無い)', () => {
    expect(migration).toEqual([
      "SET LOCAL lock_timeout = '10s'",
      `CREATE OR REPLACE FUNCTION public.${GUARD_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $$`,
      'DO $$',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated',
    ]);
  });

  it('DO ブロック: public の全 relkind (r / p / v / m / f) で、anon / authenticated が持つ表だけ TRUNCATE を外し、残れば例外で止める', () => {
    const block = onlyDoBlockBody(migrationSql);
    const relkindList = RELKINDS.map((k) => `'${k}'`).join(', ');
    // 外す対象と外したあとの確かめの 2 か所で、同じ範囲 (public・relkind・2 ロールの TRUNCATE) を見る
    expect(block.split(`c.relnamespace = 'public'::regnamespace`)).toHaveLength(3);
    expect(block.split(`c.relkind IN (${relkindList})`)).toHaveLength(3);
    expect(
      block.split(
        "(pg_catalog.has_table_privilege('anon', c.oid, 'TRUNCATE') OR pg_catalog.has_table_privilege('authenticated', c.oid, 'TRUNCATE'))",
      ),
    ).toHaveLength(3);
    expect(block).toContain("EXECUTE pg_catalog.format('REVOKE TRUNCATE ON TABLE %s FROM anon, authenticated', v_rel);");
    expect(block).toMatch(/IF v_left IS NOT NULL THEN RAISE EXCEPTION '[^']*', v_left; END IF;/);
    // TRUNCATE のほかの権限・ほかのロールには触れない
    expect(block).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE|REFERENCES|TRIGGER|MAINTAIN|ALL)\s+ON\s+TABLE\b/i);
    expect(block).not.toMatch(/\bservice_role\b|\bGRANT\b/i);
  });
});

describe('#1917 guard_organizations_privileged の最新の定義', () => {
  const latest = latestOf(GUARD_FUNCTION);

  it('5 列 (owner_id・status・subscription_status・subscription_expires_at・dissolved_at) を守る', () => {
    expect([...guardedColumnsOf(latest.body)].sort()).toEqual([...GUARDED_COLUMNS].sort());
  });

  it('守る列は organizations の実在の列 (ベースラインの CREATE TABLE にある)', () => {
    const create = /CREATE TABLE IF NOT EXISTS "public"\."organizations" \(([\s\S]*?)\n\);/.exec(readMigration(BASELINE_FILE));
    expect(create).not.toBeNull();
    for (const col of GUARDED_COLUMNS) {
      expect(create![1], col).toMatch(new RegExp(`^\\s+"${col}" `, 'm'));
    }
  });

  it('ログインユーザー (current_user が authenticated / anon) だけを、既存のエラーの形 (CANNOT_MODIFY_PRIVILEGED_COLUMN / 42501) で止める', () => {
    const compact = stripLineComments(latest.body).replace(/\s+/g, ' ');
    expect(compact).toContain("IF current_user IN ('authenticated','anon') THEN");
    expect(compact).toContain("RAISE EXCEPTION 'CANNOT_MODIFY_PRIVILEGED_COLUMN' USING ERRCODE = '42501';");
    expect(compact).toMatch(/RETURN NEW; END\s*$/);
  });

  it('RETURNS trigger・LANGUAGE plpgsql で、SECURITY DEFINER も SET search_path も持たない (ベースラインの属性のまま)', () => {
    const header = stripLineComments(latest.header);
    expect(header).toMatch(/RETURNS\s+"?trigger"?/i);
    expect(header).toMatch(/LANGUAGE\s+"?plpgsql"?/i);
    expect(header).not.toMatch(/SECURITY\s+DEFINER/i);
    expect(header).not.toMatch(/search_path/i);
  });

  it('この migration は関数を 1 回だけ置き換え、トリガー・ポリシー・organizations の権限には触れない', () => {
    expect(definitionsIn(MIGRATION_FILE, migrationSql).map((d) => d.name)).toEqual([GUARD_FUNCTION]);
    const code = stripLineComments(migrationSql);
    expect(code).not.toMatch(/\bTRIGGER\s+"?trg_guard_organizations_privileged/i);
    expect(code).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+POLICY\b/i);
    expect(code).not.toMatch(/\bON\s+(?:TABLE\s+)?(?:"?public"?\.)?"?organizations"?\b/i);
    expect(code).not.toMatch(/\b(?:GRANT|REVOKE)\b[^;]*\bFUNCTION\b/i);
  });
});

describe('#1917 同じ型の機械検査', () => {
  it('守る 3 列を書く関数の最新の定義は、どれも SECURITY DEFINER か、利用者が実行できない関数', () => {
    const writers: Array<{ name: string; file: string; secdef: boolean }> = [];
    for (const [name, def] of latestDefinitions) {
      if (updatesOrganizationsColumns(def.body, ADDED_COLUMNS)) {
        writers.push({ name, file: def.file, secdef: /SECURITY\s+DEFINER/i.test(def.header) });
      }
    }
    // 見つけ方が空振りしていないこと (解散の後始末は dissolved_at を必ず書く)
    expect(writers.map((w) => w.name)).toEqual(expect.arrayContaining(['org_dissolve_apply']));
    const offenders = writers
      .filter((w) => !w.secdef && !(w.name in INVOKER_WRITERS_NOT_EXECUTABLE_BY_USERS))
      .map((w) => `${w.name} (${w.file})`);
    expect(
      offenders,
      'ログインユーザーの権限で動く関数から 3 列を書くと、ガードが 42501 で止める (利用者の呼び出しで壊れる)',
    ).toEqual([]);
  });

  it('許可一覧の SECURITY INVOKER の関数は、利用者 (anon / authenticated / PUBLIC) から EXECUTE を外し、利用者へ GRANT していない', () => {
    for (const name of Object.keys(INVOKER_WRITERS_NOT_EXECUTABLE_BY_USERS)) {
      const signature = new RegExp(`\\bON\\s+(?:FUNCTION|ROUTINE)\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\(`, 'i');
      const revokes = migrationFiles.flatMap((file) =>
        statements(readMigration(file)).filter((s) => /^REVOKE\b/i.test(s) && signature.test(s)),
      );
      expect(
        revokes.some((s) => ['PUBLIC', 'anon', 'authenticated'].every((role) => new RegExp(`\\bFROM\\b[\\s\\S]*\\b${role}\\b`, 'i').test(s))),
        `${name} の REVOKE`,
      ).toBe(true);
      const grants = migrationFiles.flatMap((file) =>
        statements(readMigration(file)).filter((s) => /^GRANT\b/i.test(s) && signature.test(s)),
      );
      expect(grants.length, `${name} の GRANT`).toBeGreaterThan(0);
      for (const grant of grants) {
        expect(grant, `${name}: 利用者に EXECUTE を付けていない`).not.toMatch(/\bTO\b[\s\S]*\b(?:anon|authenticated|PUBLIC)\b/i);
      }
    }
  });

  it('この migration より後の migration が、利用者 (anon / authenticated / PUBLIC) へ表の TRUNCATE (ALL を含む) を付け直していない (既定の権限も)', () => {
    const later = migrationFiles.filter((file) => file > MIGRATION_FILE);
    const offenders = later.flatMap((file) =>
      statements(readMigration(file))
        .filter((s) => {
          const grant = parseGrant(s);
          return (
            grant !== null &&
            isTableTarget(grant.target) &&
            toUsers(grant.grantees) &&
            grant.privileges.some((p) => p === 'ALL' || p === 'ALL PRIVILEGES' || p === 'TRUNCATE')
          );
        })
        .map((s) => `${file}: ${s.slice(0, 160)}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('#1917 ロールバック', () => {
  it('guard_organizations_privileged を、ベースラインの定義 (:1826-1837) に逐語で戻す', () => {
    const base = linesOf(BASELINE_FILE, GUARD_BASE_LINES);
    expect(base.split('\n')).toHaveLength(GUARD_BASE_LINES.to - GUARD_BASE_LINES.from + 1);
    expect(base).toMatch(/^CREATE OR REPLACE FUNCTION "public"\."guard_organizations_privileged"\(\)/);
    expect(base).toMatch(/END \$\$;$/);
    expect(rollbackSql).toContain(base);
    expect(definitionsIn('rollback', rollbackSql).map((d) => d.name)).toEqual([GUARD_FUNCTION]);
  });

  it('既定の権限の TRUNCATE を付け直し、表の TRUNCATE は REFERENCES と TRIGGER を持つ表 (個別に外した 5 表を除く) にだけ付け直す', () => {
    expect(rollback).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE ON TABLES TO anon, authenticated',
    );
    const block = onlyDoBlockBody(rollbackSql);
    const relkindList = RELKINDS.map((k) => `'${k}'`).join(', ');
    expect(block).toContain("FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP");
    expect(block).toContain(`c.relkind IN (${relkindList})`);
    expect(block).toContain(`c.relname <> ALL (ARRAY[${ROLLBACK_EXCLUDED_TABLES.map((t) => `'${t}'`).join(', ')}])`);
    expect(block).toContain("pg_catalog.has_table_privilege(v_role, c.oid, 'REFERENCES')");
    expect(block).toContain("pg_catalog.has_table_privilege(v_role, c.oid, 'TRIGGER')");
    expect(block).toContain("NOT pg_catalog.has_table_privilege(v_role, c.oid, 'TRUNCATE')");
    expect(block).toContain("EXECUTE pg_catalog.format('GRANT TRUNCATE ON TABLE %s TO %I', v_rel, v_role);");
  });

  it('前提 b: 除く 5 表は、この migration より前に TRUNCATE だけを個別に外した (REVOKE ALL でない) 表と一致する', () => {
    const earlier = migrationFiles.filter((file) => file < MIGRATION_FILE);
    const revoked = new Set<string>();
    for (const file of earlier) {
      for (const s of statements(readMigration(file))) {
        const m = /^REVOKE\s+([\s\S]*?)\s+ON\s+(?:TABLE\s+)?(?:"?public"?\.)?"?([A-Za-z0-9_]+)"?\s+FROM\s+([\s\S]*)$/i.exec(s);
        if (!m) continue;
        const privileges = m[1].split(',').map((p) => p.trim().toUpperCase());
        if (privileges.includes('TRUNCATE') && /\b(?:anon|authenticated)\b/i.test(m[3])) revoked.add(m[2]);
      }
    }
    expect([...revoked].sort()).toEqual([...ROLLBACK_EXCLUDED_TABLES].sort());
  });

  it('前提 a: この migration より前に、利用者へ REFERENCES / TRIGGER (ALL を含む) を付ける表の GRANT は、どれも TRUNCATE も付ける', () => {
    const earlier = migrationFiles.filter((file) => file <= MIGRATION_FILE);
    let checked = 0;
    const offenders = earlier.flatMap((file) =>
      statements(readMigration(file))
        .filter((s) => /^GRANT\b/i.test(s))
        .filter((s) => {
          const grant = parseGrant(s);
          if (grant === null || !isTableTarget(grant.target) || !toUsers(grant.grantees)) return false;
          checked += 1;
          const refsOrTrigger = grant.privileges.some((p) => p === 'REFERENCES' || p === 'TRIGGER');
          const truncate = grant.privileges.some((p) => p === 'ALL' || p === 'ALL PRIVILEGES' || p === 'TRUNCATE');
          return refsOrTrigger && !truncate;
        })
        .map((s) => `${file}: ${s.slice(0, 160)}`),
    );
    // 見つけ方が空振りしていないこと (ベースラインの表の GRANT を数える)
    expect(checked).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
