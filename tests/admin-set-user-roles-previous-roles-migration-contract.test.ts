/**
 * #1917: admin_set_user_roles が変える前の roles (previous_roles) を返す migration
 * (supabase/migrations/20261023110000_admin_set_user_roles_previous_roles.sql) を、ファイルの読み取りで確かめる (DB には接続しない)。
 * 監査 admin.user.role_change の previous_roles を、同時の変更があってもこの UPDATE の直前の値にする。
 *
 *   1. migration を version 順に見たとき、admin_set_user_roles の最新の定義は本冊 (後の migration が戻り値から previous_roles を
 *      落として作り直したら、ここで赤くなる)
 *   2. 本冊の定義は、直前の定義 (20261017130000_operator_mfa_db_gate.sql) から次の 3 か所だけを変えたもの:
 *      宣言に v_previous_roles を足す・存在の確認 (NOT EXISTS) を対象の行の FOR NO KEY UPDATE の読み取り + NOT FOUND に置き換える・
 *      戻り値に v_previous_roles を足す。役割の判定・MFA の判定・自分の id の判定とその順は変えない
 *   3. ロックは FOR NO KEY UPDATE (FOR UPDATE ではない。外部キーの確認の FOR KEY SHARE と待ち合わない。CLAUDE.md のロック順の節)。
 *      ロックは判定の後・UPDATE の前
 *   4. 戻り値の型が変わるので DROP FUNCTION してから作り、権限を本番 (supabase/baseline/prod_function_acl.sql:22-24) と同じに付け直す
 *      (PUBLIC / anon には付けない)
 *   5. 戻し口は、直前の定義の逐語に戻し、同じ権限を付け直す
 *   6. 型の生成物 2 ファイルの admin_set_user_roles の Returns に previous_roles がある
 *   7. 同じ型の機械検査: admin_set_user_roles を呼ぶアプリのコードは、利用者のロールの変更の route の 1 か所だけ
 *      (戻り値を読まない呼び出しが増えたら、監査の previous_roles がまた先に読んだ値になりうるので、ここで止めて見直す)
 * 実際の挙動 (ロックで並び、先の変更の後の値を返す) は tests/integration/security/admin-set-user-roles-previous-roles.test.ts。
 * route が戻り値の previous_roles を監査に残すことは tests/admin-user-role-previous-roles-route.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261023110000_admin_set_user_roles_previous_roles';
const MIGRATION_FILE = `${MIGRATION}.sql`;
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
/** 本冊の直前の admin_set_user_roles の定義を持つ migration */
const PREVIOUS_DEFINITION_FILE = '20261017130000_operator_mfa_db_gate.sql';
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;
const ROUTE_FILE = 'src/app/api/admin/users/[id]/role/route.ts';
/** アプリのコードの置き場所 (Web・モバイル・Edge Function・共有のライブラリ) */
const APP_CODE_DIRS = ['src', 'apps/mobile', 'supabase/functions', 'packages'] as const;
const APP_CODE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs)$/;
const SKIPPED_DIRS = new Set(['node_modules', '.next', '__tests__', 'dist', 'build']);

const FUNCTION_NAME = 'admin_set_user_roles';
const CREATE_HEAD = `CREATE OR REPLACE FUNCTION "public"."${FUNCTION_NAME}"(`;
const DROP_STATEMENT = `DROP FUNCTION IF EXISTS public.${FUNCTION_NAME}(uuid, text[]);`;
const REVOKE_STATEMENT = `REVOKE ALL ON FUNCTION public.${FUNCTION_NAME}(uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;`;
const GRANT_STATEMENT = `GRANT EXECUTE ON FUNCTION public.${FUNCTION_NAME}(uuid, text[]) TO authenticated, service_role;`;

/** 直前の定義から本冊で変えた 3 か所 (左が直前・右が本冊) */
const CHANGED_PARTS: ReadonlyArray<readonly [string, string]> = [
  [
    'RETURNS TABLE("id" "uuid", "roles" "text"[])',
    'RETURNS TABLE("id" "uuid", "roles" "text"[], "previous_roles" "text"[])',
  ],
  [
    '  v_new_roles TEXT[];\nBEGIN',
    '  v_new_roles TEXT[];\n  v_previous_roles TEXT[];\nBEGIN',
  ],
  [
    [
      '  IF NOT EXISTS (SELECT 1 FROM user_profiles up WHERE up.id = p_user_id) THEN',
      "    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';",
      '  END IF;',
    ].join('\n'),
    [
      '  -- #1917: 対象の行をロックしてから変える前の roles を読む (同時の変更はここで並び、後の呼び出しは先の変更の後の値を読む)',
      '  SELECT up.roles INTO v_previous_roles FROM user_profiles up WHERE up.id = p_user_id FOR NO KEY UPDATE;',
      '  IF NOT FOUND THEN',
      "    RAISE EXCEPTION 'USER_NOT_FOUND' USING ERRCODE = 'P0001';",
      '  END IF;',
    ].join('\n'),
  ],
  ['  RETURN QUERY SELECT p_user_id, v_new_roles;', '  RETURN QUERY SELECT p_user_id, v_new_roles, v_previous_roles;'],
];

/** 本冊の定義の中で、この順に出てくる目印 (判定 3 つ → ロック → 存在の判定 → UPDATE → 戻り値) */
const ORDERED_MARKERS = [
  "RAISE EXCEPTION 'FORBIDDEN'",
  'IF NOT public.operator_mfa_satisfied() THEN',
  "RAISE EXCEPTION 'CANNOT_MODIFY_OWN_ROLES'",
  'WHERE up.id = p_user_id FOR NO KEY UPDATE;',
  "RAISE EXCEPTION 'USER_NOT_FOUND'",
  'UPDATE user_profiles up SET roles = v_new_roles WHERE up.id = p_user_id;',
  'RETURN QUERY SELECT p_user_id, v_new_roles, v_previous_roles;',
] as const;

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** SQL の行コメント (-- から行末) を取り除く */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** admin_set_user_roles の CREATE から本文の終わり (END $$;) まで。ちょうど 1 つあること */
function definitionIn(sql: string, label: string): string {
  const start = sql.indexOf(CREATE_HEAD);
  expect(start, `${label} に ${FUNCTION_NAME} の定義が無い`).toBeGreaterThanOrEqual(0);
  expect(sql.indexOf(CREATE_HEAD, start + 1), `${label} に ${FUNCTION_NAME} の定義が 2 つある`).toBe(-1);
  const end = sql.indexOf('END $$;', start);
  expect(end, `${label} の ${FUNCTION_NAME} の本文の終わりが無い`).toBeGreaterThan(start);
  return sql.slice(start, end + 'END $$;'.length);
}

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{14}_.*\.sql$/.test(file))
    .sort();
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (APP_CODE_EXTENSIONS.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) out.push(full);
  }
}

const migrationSql = read(path.join(MIGRATIONS_DIR, MIGRATION_FILE));
const previousSql = read(path.join(MIGRATIONS_DIR, PREVIOUS_DEFINITION_FILE));
const newDefinition = definitionIn(migrationSql, MIGRATION_FILE);
const previousDefinition = definitionIn(previousSql, PREVIOUS_DEFINITION_FILE);

describe(`#1917 ${MIGRATION_FILE}`, () => {
  it('1. migration を version 順に見たとき、admin_set_user_roles の最新の定義は本冊', () => {
    const definers = migrationFiles().filter((file) =>
      new RegExp(String.raw`FUNCTION\s+(?:"?public"?\.)?"?${FUNCTION_NAME}"?\s*\(`).test(
        stripLineComments(read(path.join(MIGRATIONS_DIR, file))),
      ),
    );
    expect(definers.at(-1)).toBe(MIGRATION_FILE);
    // 直前の定義が、本冊の 1 つ前に定義した migration であること (比べる相手が古くないこと)
    expect(definers.filter((file) => file !== MIGRATION_FILE).at(-1)).toBe(PREVIOUS_DEFINITION_FILE);
  });

  it('2. 本冊の定義は、直前の定義から宣言・ロックの読み取り・戻り値の 3 か所 (と戻り値の型) だけを変えたもの', () => {
    let expected = previousDefinition;
    for (const [before, after] of CHANGED_PARTS) {
      expect(expected.split(before).length - 1, `直前の定義に「${before}」が 1 回だけある`).toBe(1);
      expected = expected.replace(before, after);
    }
    expect(newDefinition).toBe(expected);
  });

  it('3. ロックは FOR NO KEY UPDATE で、判定の後・UPDATE の前 (FOR UPDATE は使わない)', () => {
    const body = stripLineComments(newDefinition);
    let cursor = -1;
    for (const marker of ORDERED_MARKERS) {
      const at = body.indexOf(marker);
      expect(at, `「${marker}」が無い`).toBeGreaterThanOrEqual(0);
      expect(at, `「${marker}」の順が違う`).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(body).not.toMatch(/\bFOR\s+UPDATE\b/i);
    expect(body.match(/\bFOR\s+NO\s+KEY\s+UPDATE\b/gi)).toHaveLength(1);
  });

  it('4. DROP FUNCTION してから作り、権限を本番と同じに付け直す (PUBLIC / anon には付けない)', () => {
    const sql = stripLineComments(migrationSql);
    const dropAt = sql.indexOf(DROP_STATEMENT);
    const createAt = sql.indexOf(CREATE_HEAD);
    const revokeAt = sql.indexOf(REVOKE_STATEMENT);
    const grantAt = sql.indexOf(GRANT_STATEMENT);
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(dropAt);
    expect(revokeAt).toBeGreaterThan(createAt);
    expect(grantAt).toBeGreaterThan(revokeAt);
    // GRANT は 1 文だけで、anon / PUBLIC に付けない
    expect(sql.match(/\bGRANT\b/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\bGRANT\b[^;]*\sTO\s[^;]*\b(?:anon|PUBLIC)\b/);
    // 本番の権限 (ベースラインの ACL) と同じ相手であること
    const acl = read(path.join(ROOT, 'supabase', 'baseline', 'prod_function_acl.sql'));
    const baselineGrantees = [...acl.matchAll(new RegExp(String.raw`GRANT EXECUTE ON ROUTINE public\."${FUNCTION_NAME}"\([^)]*\) TO "([a-z_]+)";`, 'g'))]
      .map((m) => m[1])
      .sort();
    expect(baselineGrantees).toEqual(['authenticated', 'service_role']);
  });

  it('5. 戻し口は、直前の定義の逐語に戻し、同じ権限を付け直す', () => {
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const rollback = read(ROLLBACK_PATH);
    expect(rollback.split('\n')[0]).toBe(`-- rollback: ${MIGRATION_FILE}`);
    expect(definitionIn(rollback, 'rollback')).toBe(previousDefinition);
    const sql = stripLineComments(rollback);
    expect(sql.indexOf(DROP_STATEMENT)).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf(CREATE_HEAD)).toBeGreaterThan(sql.indexOf(DROP_STATEMENT));
    expect(sql.indexOf(REVOKE_STATEMENT)).toBeGreaterThan(sql.indexOf(CREATE_HEAD));
    expect(sql.indexOf(GRANT_STATEMENT)).toBeGreaterThan(sql.indexOf(REVOKE_STATEMENT));
    expect(sql).not.toMatch(/\bGRANT\b[^;]*\sTO\s[^;]*\b(?:anon|PUBLIC)\b/);
  });

  it.each(TYPE_FILES)('6. 型の生成物 %s の admin_set_user_roles の Returns に previous_roles がある', (file) => {
    const source = read(path.join(ROOT, file));
    const match = source.match(/\n {6}admin_set_user_roles: \{\n([\s\S]*?)\n {6}\}/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('Args: { p_roles: string[]; p_user_id: string }');
    expect(match![1]).toMatch(/Returns: \{\n\s+id: string\n\s+previous_roles: string\[\]\n\s+roles: string\[\]\n\s+\}\[\]/);
  });

  it('7. admin_set_user_roles を呼ぶアプリのコードは、利用者のロールの変更の route の 1 か所だけ', () => {
    const files: string[] = [];
    for (const dir of APP_CODE_DIRS) walk(path.join(ROOT, dir), files);
    expect(files.length).toBeGreaterThan(0);
    const callers = files
      .filter((file) => !file.includes(`${path.sep}database.types.ts`))
      .filter((file) => new RegExp(String.raw`\.rpc\(\s*['"\`]${FUNCTION_NAME}['"\`]`).test(read(file)))
      .map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
    expect(callers).toEqual([ROUTE_FILE]);
  });
});
