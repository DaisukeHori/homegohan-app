/**
 * #1917 の続き (D73): 退会の途中の人を運営がオーナーにして組織を作ると、退会の最後の deleteUser が organizations_owner_id_fkey
 * (RESTRICT) で失敗する欠陥の修正 (supabase/migrations/20261023130000_account_deletion_owner_guard.sql) を、ファイルどうしの
 * 突き合わせで確かめる (DB には接続しない)。後の migration が同じ関数を作り直して判定を落とさないよう、関数は「最新の定義」で見る。
 *
 *   1. 表 account_deletion_guards: auth.users を指す (ON DELETE CASCADE)。RLS が有効で、ポリシーも利用者・service_role の表の権限も無い
 *   2. begin_account_deletion_guard: SECURITY DEFINER・search_path ''。advisory lock を取ってから、auth.users に居る人だけに印を付ける
 *      (あれば日時を今にする)。EXECUTE は service_role だけ
 *   3. トリガー trg_organizations_owner_not_deleting (関数 organizations_owner_not_deleting()): BEFORE INSERT だけ (UPDATE には付けない)。同じキーの advisory lock を取ってから、
 *      新しい印があれば OWNER_ACCOUNT_DELETING (P0001)。印が効く長さは、退会の route の maxDuration と Vercel の関数の上限より長い
 *   4. 退会の本体は findBlocker より先に印を付け、運営の作成 API はトリガーの止めを 409 OWNER_ACCOUNT_DELETING にする (同じコード)
 *   5. 戻し口が実在し、足したものをすべて外す
 * 実際の挙動 (印と作成の直列化・古い印・権限) は tests/integration/security/account-deletion-owner-guard.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isRaisedExceptionWithCode } from '@/lib/errors/db-raised-code';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261023130000_account_deletion_owner_guard';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
const ACCOUNT_DELETION = 'src/lib/account-deletion.ts';
const ADMIN_ORG_ROUTE = 'src/app/api/admin/organizations/route.ts';
const ACCOUNT_DELETE_ROUTE = 'src/app/api/account/delete/route.ts';

const TABLE = 'account_deletion_guards';
const GUARD_FN = 'begin_account_deletion_guard';
const TRIGGER_FN = 'organizations_owner_not_deleting';
const TRIGGER = 'trg_organizations_owner_not_deleting';
const RAISE_CODE = 'OWNER_ACCOUNT_DELETING';
const ADVISORY_KEY_PREFIX = "'account_deletion_guard:'";
/** Vercel の関数の実行時間の上限 (秒)。印が効く長さは、これより長くなければならない (移行の見出しの根拠) */
const VERCEL_MAX_FUNCTION_DURATION_SECONDS = 800;
const SECONDS_PER_MINUTE = 60;

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf-8');

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** TS の行コメント・ブロックコメントを取り除く (コメントの中の語に反応しないため。ここで読むファイルは文字列の中に // を書いていない行だけを見る) */
const stripTsComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** 空白をまとめる (字下げ・改行の違いを無視して比べるため) */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const migrationSql = squash(stripLineComments(fs.readFileSync(MIGRATION_PATH, 'utf-8')));

interface FunctionDefinition {
  file: string;
  header: string;
  body: string;
}

function definitionsIn(file: string, sql: string, name: string): FunctionDefinition[] {
  const found: FunctionDefinition[] = [];
  const pattern = new RegExp(`CREATE OR REPLACE FUNCTION\\s+(?:"?public"?\\.)?"?${name}"?\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    const rest = sql.slice(match.index);
    const opener = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
    if (!opener) continue;
    const bodyStart = opener.index + opener[0].length;
    const bodyEnd = rest.indexOf(opener[1], bodyStart);
    if (bodyEnd < 0) continue;
    found.push({ file, header: rest.slice(0, opener.index), body: rest.slice(bodyStart, bodyEnd) });
  }
  return found;
}

function latestOf(name: string): FunctionDefinition {
  const all = migrations.flatMap(({ file, sql }) => definitionsIn(file, sql, name));
  expect(all.length, `${name} の定義が migration に見つからない`).toBeGreaterThan(0);
  return all[all.length - 1];
}

/** 本文の中で、パターンが最初に現れる位置 (無ければ失敗) */
function indexIn(body: string, pattern: RegExp, label: string): number {
  const match = pattern.exec(body);
  expect(match, `${label} が見つからない`).not.toBeNull();
  return match!.index;
}

describe(`${MIGRATION}: 表 ${TABLE} (退会の印)`, () => {
  it('auth.users を指し ON DELETE CASCADE (退会が済むと印も消える)。主キーは user_id で、started_at は NOT NULL', () => {
    expect(migrationSql).toMatch(
      new RegExp(
        String.raw`CREATE TABLE IF NOT EXISTS public\.${TABLE} \( user_id uuid PRIMARY KEY REFERENCES auth\.users\(id\) ON DELETE CASCADE, started_at timestamptz NOT NULL DEFAULT pg_catalog\.now\(\) \);`,
      ),
    );
  });

  it('RLS が有効で、ポリシーが無く、PUBLIC・anon・authenticated・service_role の表の権限を外す (どの migration も GRANT しない)', () => {
    expect(migrationSql).toContain(`ALTER TABLE public.${TABLE} ENABLE ROW LEVEL SECURITY;`);
    expect(migrationSql).toContain(`REVOKE ALL ON TABLE public.${TABLE} FROM PUBLIC, anon, authenticated, service_role;`);
    for (const { file, sql } of migrations) {
      const code = stripLineComments(sql);
      expect(code, `${file} が ${TABLE} にポリシーを作っていない`).not.toMatch(new RegExp(String.raw`CREATE\s+POLICY[^;]*\bON\s+(?:public\.)?${TABLE}\b`, 'i'));
      expect(code, `${file} が ${TABLE} の権限を付けていない`).not.toMatch(new RegExp(String.raw`GRANT[^;]*\bON\s+(?:TABLE\s+)?(?:public\.)?${TABLE}\b`, 'i'));
    }
  });
});

describe(`${MIGRATION}: ${GUARD_FN} (退会の印を付ける)`, () => {
  const definition = latestOf(GUARD_FN);
  const body = squash(stripLineComments(definition.body));

  it(`最新の定義はこの migration で、SECURITY DEFINER・SET search_path = ''`, () => {
    expect(definition.file).toBe(`${MIGRATION}.sql`);
    expect(squash(definition.header)).toMatch(/RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''$/);
  });

  it('p_user_id が NULL なら 22023。advisory lock (退会の印のキー) を取ってから印を書く', () => {
    const nullCheck = indexIn(body, /IF p_user_id IS NULL THEN RAISE EXCEPTION '[^']+' USING ERRCODE = '22023'; END IF;/, 'NULL の検査');
    const lock = indexIn(
      body,
      new RegExp(String.raw`PERFORM pg_catalog\.pg_advisory_xact_lock\( pg_catalog\.hashtextextended\(${ADVISORY_KEY_PREFIX} \|\| p_user_id::pg_catalog\.text, 0\)\);`),
      'advisory lock',
    );
    const write = indexIn(body, new RegExp(String.raw`INSERT INTO public\.${TABLE}`), '印の INSERT');
    expect(nullCheck).toBeLessThan(lock);
    expect(lock).toBeLessThan(write);
  });

  it('auth.users に居る人だけに印を付け (すでに消えた人のやり直しを外部キーで失敗させない)、あれば日時を今にする', () => {
    expect(body).toContain(
      `INSERT INTO public.${TABLE} (user_id, started_at) SELECT u.id, pg_catalog.now() FROM auth.users AS u WHERE u.id = p_user_id ON CONFLICT (user_id) DO UPDATE SET started_at = EXCLUDED.started_at;`,
    );
  });

  it('EXECUTE は service_role だけ (PUBLIC・anon・authenticated から外す)', () => {
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION public.${GUARD_FN}(uuid) FROM PUBLIC, anon, authenticated, service_role;`);
    expect(migrationSql).toContain(`GRANT EXECUTE ON FUNCTION public.${GUARD_FN}(uuid) TO service_role;`);
    const grants = [...migrationSql.matchAll(new RegExp(String.raw`GRANT EXECUTE ON FUNCTION public\.${GUARD_FN}\(uuid\) TO ([^;]+);`, 'g'))];
    expect(grants.map((m) => m[1])).toEqual(['service_role']);
  });
});

describe(`${MIGRATION}: トリガー ${TRIGGER} (退会の途中の人をオーナーにして組織を作らない)`, () => {
  const definition = latestOf(TRIGGER_FN);
  const body = squash(stripLineComments(definition.body));

  it(`最新の定義はこの migration で、RETURNS trigger・SECURITY DEFINER・SET search_path = ''。誰にも EXECUTE を付けない`, () => {
    expect(definition.file).toBe(`${MIGRATION}.sql`);
    expect(squash(definition.header)).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''$/);
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION public.${TRIGGER_FN}() FROM PUBLIC, anon, authenticated, service_role;`);
    expect(migrationSql).not.toMatch(new RegExp(String.raw`GRANT[^;]*${TRIGGER_FN}`));
  });

  it('BEFORE INSERT ON organizations だけに付ける (UPDATE には付けない: 譲渡の関数のエラーの面を変えない)', () => {
    expect(migrationSql).toContain(
      `CREATE OR REPLACE TRIGGER ${TRIGGER} BEFORE INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.${TRIGGER_FN}();`,
    );
    const triggers = migrations.flatMap(({ file, sql }) =>
      [...stripLineComments(sql).matchAll(new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+${TRIGGER}\b`, 'gi'))].map(() => file),
    );
    expect(triggers).toEqual([`${MIGRATION}.sql`]);
  });

  it('owner_id が NULL なら何もしない → 同じキーの advisory lock → 新しい印があれば OWNER_ACCOUNT_DELETING (P0001)', () => {
    const nullSkip = indexIn(body, /IF NEW\.owner_id IS NULL THEN RETURN NEW; END IF;/, 'owner_id が NULL のとき');
    const lock = indexIn(
      body,
      new RegExp(String.raw`PERFORM pg_catalog\.pg_advisory_xact_lock\( pg_catalog\.hashtextextended\(${ADVISORY_KEY_PREFIX} \|\| NEW\.owner_id::pg_catalog\.text, 0\)\);`),
      'advisory lock',
    );
    const check = indexIn(
      body,
      new RegExp(
        String.raw`IF EXISTS \( SELECT 1 FROM public\.${TABLE} AS g WHERE g\.user_id = NEW\.owner_id AND g\.started_at > pg_catalog\.clock_timestamp\(\) - c_guard_window \) THEN RAISE EXCEPTION '${RAISE_CODE}' USING ERRCODE = 'P0001'; END IF;`,
      ),
      '印の判定',
    );
    expect(nullSkip).toBeLessThan(lock);
    expect(lock).toBeLessThan(check);
  });

  it('印が効く長さは、退会の route の maxDuration と Vercel の関数の上限より長い (実行中の退会の印を古いとみなさない)', () => {
    const windowMatch = /c_guard_window CONSTANT pg_catalog\.interval := pg_catalog\.make_interval\(mins => (\d+)\);/.exec(body);
    expect(windowMatch, '印が効く長さの定数').not.toBeNull();
    const windowSeconds = Number(windowMatch![1]) * SECONDS_PER_MINUTE;
    const maxDuration = /export const maxDuration = (\d+);/.exec(read(ACCOUNT_DELETE_ROUTE));
    expect(maxDuration, `${ACCOUNT_DELETE_ROUTE} の maxDuration`).not.toBeNull();
    expect(windowSeconds).toBeGreaterThan(Number(maxDuration![1]));
    expect(windowSeconds).toBeGreaterThan(VERCEL_MAX_FUNCTION_DURATION_SECONDS);
  });
});

describe(`${MIGRATION}: アプリの側`, () => {
  it(`退会の本体は、${GUARD_FN} を本人の id で呼び、失敗なら止めてから findBlocker を呼ぶ (印が findBlocker より先)`, () => {
    const source = stripTsComments(read(ACCOUNT_DELETION));
    const start = source.indexOf('export async function deleteAccount(');
    expect(start).toBeGreaterThan(0);
    const body = squash(source.slice(start));
    const guard = indexIn(
      body,
      new RegExp(String.raw`const \{ error: guardError \} = await admin\.rpc\('${GUARD_FN}', \{ p_user_id: userId \}\); if \(guardError\) throw guardError;`),
      '印の呼び出し',
    );
    const firstBlocker = indexIn(body, /await findBlocker\(admin, userId\)/, 'findBlocker');
    expect(guard).toBeLessThan(firstBlocker);
    expect(body.split(`admin.rpc('${GUARD_FN}'`)).toHaveLength(2);
  });

  it('運営の作成 API は、トリガーと同じコード (P0001 + OWNER_ACCOUNT_DELETING) を 409 にする', () => {
    const route = squash(stripTsComments(read(ADMIN_ORG_ROUTE)));
    expect(route).toContain(`const OWNER_ACCOUNT_DELETING = '${RAISE_CODE}';`);
    // P0001 + コードの完全一致の判定は共通の関数 (src/lib/errors/db-raised-code.ts) で行う (#1917。route では `.message` を読まない)
    expect(route).toContain("import { isRaisedExceptionWithCode } from '@/lib/errors/db-raised-code';");
    // #2107 Y4 から、作成は DB 関数 admin_create_organization (organizations の INSERT を含む 1 つのトランザクション) を呼ぶ。
    // トリガーの止めはその呼び出しの失敗 (createError) として届く。文は英字の項目名を含まない定数 (#2107 Y5 の同じ型)
    expect(route).toMatch(
      /if \(isRaisedExceptionWithCode\(createError, OWNER_ACCOUNT_DELETING\)\) \{ return NextResponse\.json\( \{ error: \{ code: OWNER_ACCOUNT_DELETING, message: OWNER_ACCOUNT_DELETING_MESSAGE \} \}, \{ status: 409 \}, \); \}/,
    );
    expect(route).toContain("const OWNER_ACCOUNT_DELETING_MESSAGE = '指定したオーナーは退会の手続き中です';");
    expect(route).toMatch(/const \{ data: created, error: createError \} = await supabaseAdmin\.rpc\('admin_create_organization',/);
    // その関数は、トリガーと同じ P0001 + このコードの完全一致だけを拾う
    expect(isRaisedExceptionWithCode({ code: 'P0001', message: RAISE_CODE }, RAISE_CODE)).toBe(true);
    expect(isRaisedExceptionWithCode({ code: '23505', message: RAISE_CODE }, RAISE_CODE)).toBe(false);
    expect(isRaisedExceptionWithCode({ code: 'P0001', message: `ERROR: ${RAISE_CODE}` }, RAISE_CODE)).toBe(false);
  });
});

describe(`${MIGRATION}: 戻し口`, () => {
  it('実在し、トリガー・トリガー関数・印の関数・表をすべて外す', () => {
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const rollback = squash(stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8')));
    expect(rollback).toContain(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.organizations;`);
    expect(rollback).toContain(`DROP FUNCTION IF EXISTS public.${TRIGGER_FN}();`);
    expect(rollback).toContain(`DROP FUNCTION IF EXISTS public.${GUARD_FN}(uuid);`);
    expect(rollback).toContain(`DROP TABLE IF EXISTS public.${TABLE};`);
    // トリガーを外してから、それが使う関数・表を外す
    expect(rollback.indexOf('DROP TRIGGER')).toBeLessThan(rollback.indexOf(`DROP TABLE`));
  });
});
