/**
 * #1917: migration 20261022180000_org_tables_rpc_only_writes.sql (と、そのロールバック) の contract テスト (DB は使わない)
 *
 * 本物の DB での振る舞い (owner / admin の直接の書き込みが 42501・RPC の経路と席数の上限は今までどおり・owner の招待は断る) は
 * tests/integration/rls/org-tables-rpc-only-writes.test.ts が確かめる。ここでは、文面だけで崩れやすい所を確かめる。
 *   1. migration: org_license_pools / organization_invites の書き込みのポリシーを消し、書き込みの権限を外す。
 *      FOR ALL の "Org admins can manage invites" は SELECT と DELETE の 2 本に、20261017130000 と同じ式で分ける
 *   2. create_org_invite の最新の定義: SECURITY DEFINER・search_path = public。本文は 20261017160000 の定義に
 *      'owner' の判定 (INSUFFICIENT_PERMISSION) を認可の直後に足しただけ (エラーとその順番・ロックは変えない)
 *   3. 同じ型の機械検査: 2 つの表に書く関数の最新の定義は、どれも SECURITY DEFINER (か、利用者が実行できない関数)。
 *      この migration より後の migration が、2 つの表の書き込みの権限やポリシーを利用者へ戻していない
 *   4. ロールバック: ベースラインと 20261017130000 のポリシーの文・書き込みの権限・create_org_invite の前の定義を、そのまま戻す
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION_STEM = '20261022180000_org_tables_rpc_only_writes';
const MIGRATION_FILE = `${MIGRATION_STEM}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION_STEM}.down.sql`);
const BASELINE_FILE = '20251126124224_create_meal_planner_tables.sql';
/** "Org admins can manage invites" に TO authenticated と運営の MFA の判定を足した migration */
const OPERATOR_MFA_FILE = '20261017130000_operator_mfa_db_gate.sql';
/** create_org_invite の 1 つ前の定義 (SECURITY INVOKER) */
const PREVIOUS_CREATE_ORG_INVITE_FILE = '20261017160000_org_invite_same_org_member.sql';
const TABLES = ['org_license_pools', 'organization_invites'] as const;

/**
 * 2 つの表に書くが SECURITY INVOKER のままでよい関数 (利用者 (anon / authenticated) が実行できない)。キーは関数名。理由を書く
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

/** ドル引用 ($$ ... $$ / $tag$ ... $tag$) の中身を除く (関数の本文の中の文を、文として数えない) */
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

function onlyDefinitionIn(file: string, name: string): FunctionDefinition {
  const defs = definitionsIn(file, readMigration(file)).filter((d) => d.name === name);
  expect(defs, `${file} の ${name} の定義`).toHaveLength(1);
  return defs[0];
}

/** 表 table に書く文 (INSERT INTO / UPDATE ... SET / DELETE FROM) が本文にあるか */
function writesTable(body: string, table: string): boolean {
  const name = `(?:"?public"?\\.)?"?${table}"?`;
  return new RegExp(`\\b(?:INSERT\\s+INTO|DELETE\\s+FROM)\\s+${name}\\b|(?<!FOR\\s)\\bUPDATE\\s+${name}\\s+SET\\b`, 'i').test(
    stripLineComments(body),
  );
}

/** ベースラインの CREATE POLICY "<name>" の文 (空白を詰めた形) */
function baselinePolicy(name: string): string {
  const found = statements(readMigration(BASELINE_FILE)).filter((s) => s.startsWith(`CREATE POLICY "${name}" `));
  expect(found, `ベースラインの ${name}`).toHaveLength(1);
  return found[0];
}

/** 20261017130000 の "Org admins can manage invites" の USING (...) (TO authenticated の後ろ) */
function operatorMfaInvitesUsing(): string {
  const prefix = 'ALTER POLICY "Org admins can manage invites" ON public.organization_invites TO authenticated ';
  const found = statements(readMigration(OPERATOR_MFA_FILE)).filter((s) => s.startsWith(prefix));
  expect(found).toHaveLength(1);
  return found[0].slice(prefix.length);
}

const migration = statements(readMigration(MIGRATION_FILE));
const rollbackSql = fs.readFileSync(ROLLBACK_PATH, 'utf8');
const rollback = statements(rollbackSql);

describe('#1917 20261022180000 の migration (表のポリシーと権限)', () => {
  it('関数の外の文は、ロックの待ちの上限・ポリシーの DROP / CREATE・REVOKE だけ (GRANT は無い)', () => {
    const using = operatorMfaInvitesUsing();
    expect(migration.filter((s) => !s.startsWith('CREATE OR REPLACE FUNCTION '))).toEqual([
      "SET LOCAL lock_timeout = '10s'",
      'DROP POLICY IF EXISTS org_license_pools_update_admin ON public.org_license_pools',
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.org_license_pools FROM anon, authenticated',
      'DROP POLICY IF EXISTS org_invites_insert_admin ON public.organization_invites',
      'DROP POLICY IF EXISTS org_invites_update_admin ON public.organization_invites',
      'DROP POLICY IF EXISTS "Org admins can manage invites" ON public.organization_invites',
      'DROP POLICY IF EXISTS "Org admins can view invites" ON public.organization_invites',
      `CREATE POLICY "Org admins can view invites" ON public.organization_invites FOR SELECT TO authenticated ${using}`,
      'DROP POLICY IF EXISTS "Org admins can delete invites" ON public.organization_invites',
      `CREATE POLICY "Org admins can delete invites" ON public.organization_invites FOR DELETE TO authenticated ${using}`,
      'REVOKE INSERT, UPDATE, TRUNCATE ON TABLE public.organization_invites FROM anon, authenticated',
      'REVOKE DELETE ON TABLE public.organization_invites FROM anon',
    ]);
  });

  it('分けた 2 本の式は、運営の項に MFA の判定 (operator_mfa_satisfied) を持つ (20261017130000 の式のまま)', () => {
    expect(operatorMfaInvitesUsing()).toMatch(/\(SELECT public\.operator_mfa_satisfied\(\)\)/);
  });
});

describe('#1917 create_org_invite の最新の定義', () => {
  const latest = latestOf('create_org_invite');
  const body = stripLineComments(latest.body);

  it('最新の定義はこの migration で、SECURITY DEFINER・search_path = public・RETURNS organization_invites', () => {
    expect(latest.file).toBe(MIGRATION_FILE);
    expect(latest.header).toMatch(/SECURITY\s+DEFINER/i);
    expect(latest.header).not.toMatch(/SECURITY\s+INVOKER/i);
    expect(latest.header).toMatch(/SET\s+search_path\s*(?:=|TO)\s*'?public'?\s+AS/i);
    expect(latest.header).toMatch(/RETURNS\s+public\.organization_invites/i);
  });

  it("p_role が 'owner' なら INSUFFICIENT_PERMISSION。認可 (NOT_ORG_ADMIN) の後、宛先・席数・24 時間の上限・最初の書き込みより前", () => {
    const authAt = body.search(/RAISE\s+EXCEPTION\s+'NOT_ORG_ADMIN'/i);
    const ownerAt = body.search(/IF\s+p_role\s*=\s*'owner'\s+THEN\s+RAISE\s+EXCEPTION\s+'INSUFFICIENT_PERMISSION'\s+USING\s+ERRCODE\s*=\s*'P0001'/i);
    const recipientAt = body.search(/PERFORM\s+public\.assert_org_invite_recipient_not_in_org\(/i);
    const seatAt = body.search(/RAISE\s+EXCEPTION\s+'SEAT_LIMIT_EXCEEDED'/i);
    const capAt = body.search(/PERFORM\s+public\.enforce_membership_daily_cap\(\s*'org_invite'/i);
    const firstWriteAt = body.search(/\bINSERT\s+INTO\b|(?<!FOR\s)\bUPDATE\s+organization_invites\s+SET\b/i);
    expect(authAt).toBeGreaterThanOrEqual(0);
    expect(ownerAt).toBeGreaterThan(authAt);
    expect(recipientAt).toBeGreaterThan(ownerAt);
    expect(seatAt).toBeGreaterThan(recipientAt);
    expect(capAt).toBeGreaterThan(seatAt);
    expect(firstWriteAt).toBeGreaterThan(capAt);
  });

  it("本文は 20261017160000 の定義に、'owner' の判定を足しただけ (コメントと空白を除いて一致する)", () => {
    const normalize = (sql: string) => stripLineComments(sql).replace(/\s+/g, ' ').trim();
    const ownerBlock = /IF\s+p_role\s*=\s*'owner'\s+THEN\s+RAISE\s+EXCEPTION\s+'INSUFFICIENT_PERMISSION'\s+USING\s+ERRCODE\s*=\s*'P0001'\s*;\s*END\s+IF\s*;/i;
    expect(ownerBlock.test(body)).toBe(true);
    const previous = onlyDefinitionIn(PREVIOUS_CREATE_ORG_INVITE_FILE, 'create_org_invite');
    expect(normalize(body.replace(ownerBlock, ''))).toBe(normalize(previous.body));
  });

  it('ロックを足していない (組織の行・user_profiles の行を取らない。CLAUDE.md の組織のロック順の対象外のまま)', () => {
    expect(body).not.toMatch(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b/i);
  });

  it('本文に roles の語を持たない (運営ロールの判定の機械検査 operator-mfa-db-gate の見つけ方に当たらない)', () => {
    expect(latest.body).not.toMatch(/\broles\b/);
  });

  it('この migration は create_org_invite の EXECUTE の権限に触れない (CREATE OR REPLACE が引き継ぐ)', () => {
    expect(migration.filter((s) => /\b(GRANT|REVOKE)\b.*\bFUNCTION\b/i.test(s))).toEqual([]);
  });
});

describe('#1917 同じ型の機械検査', () => {
  it('2 つの表に書く関数の最新の定義は、どれも SECURITY DEFINER か、利用者が実行できない関数', () => {
    const writers: Array<{ name: string; file: string; secdef: boolean }> = [];
    for (const [name, def] of latestDefinitions) {
      if (TABLES.some((table) => writesTable(def.body, table))) {
        writers.push({ name, file: def.file, secdef: /SECURITY\s+DEFINER/i.test(def.header) });
      }
    }
    // 見つけ方が空振りしていないこと (create_org_invite と accept_org_invite は必ず当たる)
    expect(writers.map((w) => w.name)).toEqual(expect.arrayContaining(['create_org_invite', 'accept_org_invite', 'leave_org']));
    const offenders = writers
      .filter((w) => !w.secdef && !(w.name in INVOKER_WRITERS_NOT_EXECUTABLE_BY_USERS))
      .map((w) => `${w.name} (${w.file})`);
    expect(
      offenders,
      '2 つの表への利用者の書き込みの権限は外してある。SECURITY INVOKER の関数から書くと、利用者の呼び出しでは 42501 になる',
    ).toEqual([]);
  });

  it('許可一覧の SECURITY INVOKER の関数は、利用者 (anon / authenticated / PUBLIC) から EXECUTE を外し、利用者へ GRANT していない', () => {
    for (const name of Object.keys(INVOKER_WRITERS_NOT_EXECUTABLE_BY_USERS)) {
      const signature = new RegExp(`\\bON\\s+(?:FUNCTION|ROUTINE)\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\(`, 'i');
      const revokes = migrationFiles.flatMap((file) =>
        statements(readMigration(file)).filter((s) => /^REVOKE\b/i.test(s) && signature.test(s)),
      );
      // Supabase の既定の権限が新しい関数に付ける anon / authenticated と、PostgreSQL が付ける PUBLIC を外している
      expect(
        revokes.some((s) => ['PUBLIC', 'anon', 'authenticated'].every((role) => new RegExp(`\\bFROM\\b[\\s\\S]*\\b${role}\\b`, 'i').test(s))),
        `${name} の REVOKE`,
      ).toBe(true);
      const grants = migrationFiles.flatMap((file) =>
        statements(readMigration(file)).filter((s) => new RegExp(`^GRANT\\b[\\s\\S]*\\bON\\s+(?:FUNCTION|ROUTINE)\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\(`, 'i').test(s)),
      );
      expect(grants.length, `${name} の GRANT`).toBeGreaterThan(0);
      for (const grant of grants) {
        expect(grant, `${name}: 利用者に EXECUTE を付けていない`).not.toMatch(/\bTO\b[\s\S]*\b(?:anon|authenticated|PUBLIC)\b/i);
      }
    }
  });

  it('この migration より後の migration が、2 つの表の書き込みの権限・書き込みのポリシーを利用者へ戻していない', () => {
    const later = migrationFiles.filter((file) => file > MIGRATION_FILE);
    const tableAlt = TABLES.join('|');
    const offenders = later.flatMap((file) =>
      statements(readMigration(file))
        .filter(
          (s) =>
            new RegExp(`^GRANT\\b[\\s\\S]*\\b(?:ALL|INSERT|UPDATE|TRUNCATE)\\b[\\s\\S]*\\bON\\s+(?:TABLE\\s+)?(?:"?public"?\\.)?"?(?:${tableAlt})"?\\b[\\s\\S]*\\bTO\\b[\\s\\S]*\\b(?:anon|authenticated|PUBLIC)\\b`, 'i').test(s) ||
            new RegExp(`^CREATE\\s+POLICY\\b[\\s\\S]*\\bON\\s+(?:"?public"?\\.)?"?(?:${tableAlt})"?\\s+(?:AS\\s+\\w+\\s+)?(?:FOR\\s+(?:ALL|INSERT|UPDATE)\\b|TO\\b|USING\\b|WITH\\b)`, 'i').test(s),
        )
        .map((s) => `${file}: ${s.slice(0, 160)}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('#1917 ロールバック', () => {
  it('書き込みの権限を付け直し、ポリシーをベースラインと 20261017130000 の文のとおりに作り直す', () => {
    expect(rollback).toEqual(
      expect.arrayContaining([
        'GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.org_license_pools TO anon, authenticated',
        'GRANT INSERT, UPDATE, TRUNCATE ON TABLE public.organization_invites TO anon, authenticated',
        'GRANT DELETE ON TABLE public.organization_invites TO anon',
        'DROP POLICY IF EXISTS "Org admins can view invites" ON public.organization_invites',
        'DROP POLICY IF EXISTS "Org admins can delete invites" ON public.organization_invites',
        baselinePolicy('org_license_pools_update_admin'),
        baselinePolicy('org_invites_insert_admin'),
        baselinePolicy('org_invites_update_admin'),
        `CREATE POLICY "Org admins can manage invites" ON public.organization_invites TO authenticated ${operatorMfaInvitesUsing()}`,
      ]),
    );
    // 作り直す前に消す (冪等)
    for (const name of ['org_license_pools_update_admin', 'org_invites_insert_admin', 'org_invites_update_admin', 'Org admins can manage invites']) {
      const dropAt = rollback.findIndex((s) => s.startsWith('DROP POLICY IF EXISTS ') && s.includes(name));
      const createAt = rollback.findIndex((s) => s.startsWith('CREATE POLICY ') && s.includes(`"${name}"`));
      expect(dropAt, name).toBeGreaterThanOrEqual(0);
      expect(createAt, name).toBeGreaterThan(dropAt);
    }
  });

  it('create_org_invite を 20261017160000 の定義 (SECURITY INVOKER) に文字どおり戻す', () => {
    const restored = definitionsIn('rollback', rollbackSql).filter((d) => d.name === 'create_org_invite');
    expect(restored).toHaveLength(1);
    expect(restored[0].text).toBe(onlyDefinitionIn(PREVIOUS_CREATE_ORG_INVITE_FILE, 'create_org_invite').text);
    expect(restored[0].header).toMatch(/SECURITY\s+INVOKER/i);
  });
});
