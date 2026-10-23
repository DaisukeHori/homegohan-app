/**
 * #1917 の続き: 退会の途中の人が家族の代表者になると、退会の最後の deleteUser が family_groups.representative_id の外部キー
 * (RESTRICT) で失敗する欠陥の修正 (supabase/migrations/20261023150000_account_deletion_family_representative_guard.sql) を、
 * ファイルどうしの突き合わせで確かめる (DB には接続しない)。後の migration が同じ関数を作り直して判定を落とさないよう、関数は「最新の定義」で見る。
 *
 *   1. トリガー関数 family_groups_representative_not_deleting: SECURITY DEFINER・search_path ''。誰にも EXECUTE を付けない
 *   2. トリガー trg_representative_not_deleting: BEFORE INSERT OR UPDATE OF representative_id ON family_groups。ほかの migration は作らない。
 *      名前は特権列のガード trg_guard_family_groups_privileged より後ろに並ぶ (同じ時点のトリガーは名前の順に動くので、ログインユーザーの
 *      直接の UPDATE は先に 42501 で止まり、ほかの人が退会の途中かを探れない)
 *   3. 本文の順: NULL (解散) と値を変えない UPDATE は何もしない → 退会の印と同じキーの advisory lock → 新しい印があれば
 *      REPRESENTATIVE_ACCOUNT_DELETING (P0001)。印が効く長さは組織の作成のトリガー (20261023130000) と同じ値
 *   4. representative_id を人に書く関数は 3 つ (家族の作成・譲渡の承諾・運営の強制譲渡) だけで、ほかの関数は NULL しか書かない
 *      (どの経路もこのトリガーを通る。新しい経路が増えたらここで気づく)
 *   5. route がこのコードを 409 の日本語の固定の文にする (家族の作成・譲渡の承諾・運営の強制譲渡)
 *   6. 戻し口が実在し、足したものを外す
 * 実際の挙動 (3 つの経路の止め・古い印・直列化・解散) は tests/integration/security/account-deletion-family-rep-guard.test.ts (実 DB) が確かめる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ErrorStatusMap, MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const MIGRATION = '20261023150000_account_deletion_family_representative_guard';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, `${MIGRATION}.sql`);
const ROLLBACK_PATH = path.join(ROOT, 'supabase', 'rollbacks', `${MIGRATION}.down.sql`);
const GROUPS_ROUTE = 'src/app/api/family/groups/route.ts';
const ACCEPT_ROUTE = 'src/app/api/family/representative-transfer/[id]/accept/route.ts';
const OPERATOR_ROUTE = 'src/app/api/operator/membership/family/[id]/transfer/route.ts';

const TRIGGER_FN = 'family_groups_representative_not_deleting';
const TRIGGER = 'trg_representative_not_deleting';
/** family_groups の BEFORE UPDATE の特権列のガード (20251126124224。ログインユーザーの representative_id の直接の変更を 42501 で止める) */
const PRIVILEGED_GUARD_TRIGGER = 'trg_guard_family_groups_privileged';
/** 組織の作成のトリガー関数 (20261023130000)。印が効く長さをそろえる相手 */
const ORG_TRIGGER_FN = 'organizations_owner_not_deleting';
const RAISE_CODE = 'REPRESENTATIVE_ACCOUNT_DELETING';
const ADVISORY_KEY_PREFIX = "'account_deletion_guard:'";
const HTTP_CONFLICT = 409;
/** representative_id を人に書く関数 (この 3 つだけ。解散の関数は NULL を書く) */
const REPRESENTATIVE_WRITERS = [
  'create_family_group',
  'accept_family_representative_transfer',
  'operator_force_representative_transfer',
] as const;

const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf-8');

const migrations = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8') }));

/** SQL の行コメント (-- ...) を取り除く (コメントの中の語に反応しないため) */
const stripLineComments = (sql: string): string => sql.replace(/--.*$/gm, '');
/** TS の行コメント・ブロックコメントを取り除く (ここで読むファイルは文字列の中に // を書いていない行だけを見る) */
const stripTsComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** 空白をまとめる (字下げ・改行の違いを無視して比べるため) */
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

const migrationSql = squash(stripLineComments(fs.readFileSync(MIGRATION_PATH, 'utf-8')));

interface FunctionDefinition {
  file: string;
  name: string;
  header: string;
  body: string;
}

/** file の中の CREATE [OR REPLACE] FUNCTION を、名前 (name が無ければすべて) ごとに取り出す */
function definitionsIn(file: string, sql: string, name?: string): FunctionDefinition[] {
  const found: FunctionDefinition[] = [];
  const namePattern = name ?? '[A-Za-z_][A-Za-z0-9_]*';
  const pattern = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:"?public"?\\.)?"?(${namePattern})"?\\s*\\(`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql))) {
    const rest = sql.slice(match.index);
    const opener = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
    if (!opener) continue;
    const bodyStart = opener.index + opener[0].length;
    const bodyEnd = rest.indexOf(opener[1], bodyStart);
    if (bodyEnd < 0) continue;
    found.push({ file, name: match[1], header: rest.slice(0, opener.index), body: rest.slice(bodyStart, bodyEnd) });
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

/** 本文の c_guard_window (印が効く長さ) の分の値 */
function guardWindowMinutes(body: string, label: string): number {
  const match = /c_guard_window CONSTANT pg_catalog\.interval := pg_catalog\.make_interval\(mins => (\d+)\);/.exec(body);
  expect(match, `${label} の印が効く長さの定数`).not.toBeNull();
  return Number(match![1]);
}

describe(`${MIGRATION}: トリガー関数 ${TRIGGER_FN}`, () => {
  const definition = latestOf(TRIGGER_FN);
  const body = squash(stripLineComments(definition.body));

  it(`最新の定義はこの migration で、RETURNS trigger・SECURITY DEFINER・SET search_path = ''。誰にも EXECUTE を付けない`, () => {
    expect(definition.file).toBe(`${MIGRATION}.sql`);
    expect(squash(definition.header)).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''$/);
    expect(migrationSql).toContain(`REVOKE ALL ON FUNCTION public.${TRIGGER_FN}() FROM PUBLIC, anon, authenticated, service_role;`);
    for (const { file, sql } of migrations) {
      expect(stripLineComments(sql), `${file} が ${TRIGGER_FN} に権限を付けていない`).not.toMatch(new RegExp(String.raw`GRANT[^;]*${TRIGGER_FN}`));
    }
  });

  it('NULL (解散) と値を変えない UPDATE は何もしない → 同じキーの advisory lock → 新しい印があれば REPRESENTATIVE_ACCOUNT_DELETING (P0001)', () => {
    const nullSkip = indexIn(body, /IF NEW\.representative_id IS NULL THEN RETURN NEW; END IF;/, 'representative_id が NULL のとき');
    const unchangedSkip = indexIn(
      body,
      /IF TG_OP = 'UPDATE' AND NEW\.representative_id IS NOT DISTINCT FROM OLD\.representative_id THEN RETURN NEW; END IF;/,
      '値を変えない UPDATE のとき',
    );
    const lock = indexIn(
      body,
      new RegExp(
        String.raw`PERFORM pg_catalog\.pg_advisory_xact_lock\( pg_catalog\.hashtextextended\(${ADVISORY_KEY_PREFIX} \|\| NEW\.representative_id::pg_catalog\.text, 0\)\);`,
      ),
      'advisory lock',
    );
    const check = indexIn(
      body,
      new RegExp(
        String.raw`IF EXISTS \( SELECT 1 FROM public\.account_deletion_guards AS g WHERE g\.user_id = NEW\.representative_id AND g\.started_at > pg_catalog\.clock_timestamp\(\) - c_guard_window \) THEN RAISE EXCEPTION '${RAISE_CODE}' USING ERRCODE = 'P0001'; END IF;`,
      ),
      '印の判定',
    );
    expect(nullSkip).toBeLessThan(unchangedSkip);
    expect(unchangedSkip).toBeLessThan(lock);
    expect(lock).toBeLessThan(check);
    expect(body.split('RAISE EXCEPTION')).toHaveLength(2);
  });

  it(`advisory lock のキーは、退会の印 (begin_account_deletion_guard) と組織の作成のトリガー (${ORG_TRIGGER_FN}) と同じ`, () => {
    for (const name of ['begin_account_deletion_guard', ORG_TRIGGER_FN]) {
      expect(squash(stripLineComments(latestOf(name).body)), `${name} のキー`).toContain(
        `pg_catalog.hashtextextended(${ADVISORY_KEY_PREFIX} ||`,
      );
    }
  });

  it(`印が効く長さは、組織の作成のトリガー (${ORG_TRIGGER_FN} の最新の定義) と同じ値`, () => {
    const orgBody = squash(stripLineComments(latestOf(ORG_TRIGGER_FN).body));
    expect(guardWindowMinutes(body, TRIGGER_FN)).toBe(guardWindowMinutes(orgBody, ORG_TRIGGER_FN));
  });
});

describe(`${MIGRATION}: トリガー ${TRIGGER}`, () => {
  it('BEFORE INSERT OR UPDATE OF representative_id ON family_groups に付け、ほかの migration は同じ名前のトリガーを作らない', () => {
    expect(migrationSql).toContain(
      `CREATE OR REPLACE TRIGGER ${TRIGGER} BEFORE INSERT OR UPDATE OF representative_id ON public.family_groups FOR EACH ROW EXECUTE FUNCTION public.${TRIGGER_FN}();`,
    );
    const triggers = migrations.flatMap(({ file, sql }) =>
      [...stripLineComments(sql).matchAll(new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?${TRIGGER}"?\s`, 'gi'))].map(() => file),
    );
    expect(triggers).toEqual([`${MIGRATION}.sql`]);
  });

  it(`名前は ${PRIVILEGED_GUARD_TRIGGER} より後ろに並ぶ (同じ時点のトリガーは名前の順。ログインユーザーの直接の変更は先に 42501 で止まる)`, () => {
    const guardDefinedBefore = migrations.some(({ file, sql }) =>
      file < `${MIGRATION}.sql` && new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?${PRIVILEGED_GUARD_TRIGGER}"?\s+BEFORE\s+UPDATE\s+ON\s+"?public"?\."?family_groups"?`).test(sql),
    );
    expect(guardDefinedBefore).toBe(true);
    // Postgres は名前のバイト列の順に並べる (ASCII の英小文字と _ だけなので、文字列の比較と同じ)
    expect(PRIVILEGED_GUARD_TRIGGER < TRIGGER).toBe(true);
  });
});

describe('representative_id を人に書く関数は 3 つだけ (どれもこのトリガーを通る)', () => {
  /** 関数ごとの最新の定義 */
  const latestByName = new Map<string, FunctionDefinition>();
  for (const { file, sql } of migrations) {
    for (const definition of definitionsIn(file, sql)) latestByName.set(definition.name.toLowerCase(), definition);
  }

  it(`最新の定義で family_groups の representative_id に NULL 以外を書くのは ${REPRESENTATIVE_WRITERS.join(' / ')} だけ`, () => {
    const writers: string[] = [];
    for (const [name, definition] of latestByName) {
      const body = squash(stripLineComments(definition.body));
      const updates = [...body.matchAll(/UPDATE (?:public\.)?family_groups SET ([^;]*?)(?: WHERE |;)/gi)].map((m) => m[1]);
      const writesPerson = updates.some((set) => {
        const value = /\brepresentative_id\s*=\s*([^,\s]+)/i.exec(set)?.[1];
        return value !== undefined && value.toUpperCase() !== 'NULL';
      });
      const inserts = /INSERT INTO (?:public\.)?family_groups\s*\([^)]*\brepresentative_id\b/i.test(body);
      if (writesPerson || inserts) writers.push(name);
    }
    expect(writers.sort()).toEqual([...REPRESENTATIVE_WRITERS].sort());
  });
});

describe(`${MIGRATION}: route とエラーの表`, () => {
  it('MembershipErrorCode にコードがあり、409 で、日本語の固定の文を持つ', () => {
    expect(MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING).toBe(RAISE_CODE);
    expect(ErrorStatusMap[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING]).toBe(HTTP_CONFLICT);
    expect(MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING]).toMatch(/退会の手続き中/);
  });

  it('家族の作成の route は、このコードを MEMBERSHIP_ERROR_MESSAGES の文で返す', () => {
    const route = squash(stripTsComments(read(GROUPS_ROUTE)));
    expect(route).toContain('.includes(MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING)');
    expect(route).toContain('message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING]');
    expect(route).toContain('status: ErrorStatusMap[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING]');
  });

  it('譲渡の承諾の route は、このコードの文を表に持つ (汎用の失敗の文にしない)', () => {
    const route = squash(stripTsComments(read(ACCEPT_ROUTE)));
    expect(route).toContain(
      '[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING]: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING]',
    );
  });

  it('運営の強制譲渡の route は、P0001 + このコードの完全一致だけを 409 にする', () => {
    const route = squash(stripTsComments(read(OPERATOR_ROUTE)));
    expect(route).toContain("const PG_RAISE_EXCEPTION = 'P0001';");
    expect(route).toContain(
      'return error?.code === PG_RAISE_EXCEPTION && error.message === MembershipErrorCode.REPRESENTATIVE_ACCOUNT_DELETING;',
    );
    expect(route).toMatch(
      /if \(isRepresentativeAccountDeletingError\(rpcError\)\) \{ return NextResponse\.json\( \{ error: \{ code: MembershipErrorCode\.REPRESENTATIVE_ACCOUNT_DELETING, message: '[^']+', \}, \}, \{ status: ErrorStatusMap\[MembershipErrorCode\.REPRESENTATIVE_ACCOUNT_DELETING\] \}, \); \}/,
    );
  });
});

describe(`${MIGRATION}: 戻し口`, () => {
  it('実在し、トリガーを外してからトリガー関数を外す。退会の印 (20261023130000 のもの) は外さない', () => {
    expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    const rollback = squash(stripLineComments(fs.readFileSync(ROLLBACK_PATH, 'utf-8')));
    const dropTrigger = rollback.indexOf(`DROP TRIGGER IF EXISTS ${TRIGGER} ON public.family_groups;`);
    const dropFunction = rollback.indexOf(`DROP FUNCTION IF EXISTS public.${TRIGGER_FN}();`);
    expect(dropTrigger).toBeGreaterThanOrEqual(0);
    expect(dropFunction).toBeGreaterThan(dropTrigger);
    expect(rollback).not.toContain('account_deletion_guards');
    expect(rollback).not.toContain('begin_account_deletion_guard');
  });
});
