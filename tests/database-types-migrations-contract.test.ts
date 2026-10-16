/**
 * #1495 DB の型の生成物 (database.types.ts) が migration に追随していることの突き合わせ (DB を使わない静的な検査)。
 *
 * 背景: migration で足したテーブル・RPC が src/types/database.types.ts と packages/shared/src/database.types.ts に入っておらず、
 * 新しい RPC の引数名や列名を間違えても tsc で気づけなかった (#1451 より後の AI 利用枠・運用アラート・退会・ログイン失敗など)。
 *
 * ここで確かめること:
 *   - supabase/migrations の CREATE TABLE / CREATE FUNCTION (public スキーマ) の名前が、両方の型ファイルに出てくる
 *     (Tables と Functions の節の見出しで突き合わせる)
 *   - 逆向きに、型ファイルのテーブル・関数は、どれも migration が作って消していないもの (消したのに型に残っていない)
 *   - 両方の型ファイルが同じ中身 (packages/shared の写しがずれていない)
 *
 * 型に出ないものの扱い (除外):
 *   - DROP したもの: migration を番号順に見て、最後が DROP なら「無いはず」に数える
 *     (#1542 の 20261017010000_drop_auth_login_lock_objects.sql がロックの関数 4 本を消した。下の番兵が拾えていることを確かめる)
 *   - トリガー関数 (RETURNS trigger): PostgREST の RPC として呼べないので supabase gen types が出さない。規則で除外し、
 *     実際に型に出ていないことも確かめる (出ていたら規則の前提が崩れている)
 *   - それ以外で型に出ないもの: EXCLUDED_FUNCTIONS / EXCLUDED_TABLES に理由を付けて書く
 *   - ロールバック (supabase/rollbacks/) は migration として当たらないので読まない
 *
 * 型の作り直し方: ローカルの Supabase をベースライン方式で組み立て (bash scripts/supabase-local.sh start → reset。本番には接続しない。
 * 本番スキーマのスナップショット supabase/baseline/ を当て、そのあとにベースラインより新しい migration だけを当てる。scripts/supabase-local.sh の冒頭)、
 * npx supabase@2.62.10 gen types typescript --local --schema public --workdir .supabase-local の出力で
 * (枠 n (LOCAL_CI_SLOT=n) で組み立てたときの作業ディレクトリは .supabase-local-s<n>)
 * src/types/database.types.ts を置き換え、同じ内容を packages/shared/src/database.types.ts に写す。
 * --local は __InternalSupabase (PostgREST の版) を出さないので、既存の値を残す (下の PostgREST の版の検査)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase/migrations');
const TYPE_FILES = ['src/types/database.types.ts', 'packages/shared/src/database.types.ts'] as const;

/**
 * 規則 (DROP・トリガー関数) では外せないが、型に出ないテーブル。名前 → 理由。
 * 型に出ているのに残っていたら、除外が古いので消す (下の検査が赤になる)
 */
const EXCLUDED_TABLES: ReadonlyMap<string, string> = new Map();

/**
 * 規則 (DROP・トリガー関数) では外せないが、型に出ない関数。名前 → 理由。
 * 型に出ているのに残っていたら、除外が古いので消す (下の検査が赤になる)
 */
const EXCLUDED_FUNCTIONS: ReadonlyMap<string, string> = new Map();

/**
 * 突き合わせの番兵: #1495 で型に入っていなかったテーブル・関数 (Issue の確証で 0 件だったもの)。
 * migration の読み取りが壊れて何も拾わなくなったときに、検査が素通りしないようにする
 */
const SENTINEL_TABLES = ['ai_usage_counters', 'ops_alert_state', 'auth_login_failures'] as const;
const SENTINEL_FUNCTIONS = [
  'consume_ai_usage',
  'prepare_account_deletion',
  'auth_login_count_failure',
  'snapshot_daily_active_users',
  'claim_ops_alert',
] as const;
/** DROP の規則の番兵: 作ったあとで DROP FUNCTION IF EXISTS で消した関数 (#1542) */
const SENTINEL_DROPPED_FUNCTIONS = [
  'auth_login_lock_status',
  'auth_login_record_failure',
  'auth_login_apply_lock',
  'auth_login_account_user_id',
] as const;
/** トリガー関数の規則の番兵 (migration が RETURNS trigger で作っている関数) */
const SENTINEL_TRIGGER_FUNCTIONS = ['update_updated_at_column', 'validate_meals_meal_type'] as const;

/** 本番の PostgREST の版。--local の生成では出ないので、作り直したときに消さない (createClient の型の推論が変わる) */
const POSTGREST_VERSION_DECLARATION = /__InternalSupabase: \{\s*PostgrestVersion: "[0-9.]+"\s*\}/;

type Kind = 'table' | 'function';
interface Definition {
  /** 番号順で最後に触れた migration で作ったか (create) 消したか (drop) */
  last: 'create' | 'drop';
  file: string;
  /** 関数の最後の CREATE が RETURNS trigger か */
  returnsTrigger: boolean;
}

/** SQL のコメント (-- から行末、/* ... *\/) を取り除く。コメントの中の語を拾わないように */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

const IDENT = String.raw`(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))`;
const STATEMENT = new RegExp(
  String.raw`\b(CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|CREATE\s+(?:UNLOGGED\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(?:${IDENT}\s*\.\s*)?${IDENT}`,
  'gi',
);

/** 関数の CREATE の後ろ (引数の括弧の外) にある RETURNS の型が trigger か */
function returnsTriggerAfter(sql: string, from: number): boolean {
  const open = sql.indexOf('(', from);
  if (open < 0) return false;
  let depth = 0;
  let close = -1;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return false;
  return /^\s*RETURNS\s+(?:"trigger"|trigger\b)/i.test(sql.slice(close + 1));
}

/** migration を番号順に読み、public スキーマのテーブル・関数の最後の状態を返す */
function readMigrationDefinitions(): Record<Kind, Map<string, Definition>> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{14}_.*\.sql$/.test(file) && !file.endsWith('.down.sql'))
    .sort();
  const result: Record<Kind, Map<string, Definition>> = { table: new Map(), function: new Map() };
  for (const file of files) {
    const sql = stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    for (const match of sql.matchAll(STATEMENT)) {
      const keyword = match[1].toUpperCase();
      const schema = match[2] ?? match[3] ?? 'public';
      const name = match[4] ?? match[5];
      if (schema.toLowerCase() !== 'public' || !name) continue;
      const kind: Kind = keyword.includes('FUNCTION') ? 'function' : 'table';
      const isDrop = keyword.startsWith('DROP');
      result[kind].set(name, {
        last: isDrop ? 'drop' : 'create',
        file,
        returnsTrigger: kind === 'function' && !isDrop && returnsTriggerAfter(sql, (match.index ?? 0) + match[0].length),
      });
    }
  }
  return result;
}

/** 型ファイルの public スキーマの節 (start の見出しから end の見出しの手前まで) の、1 段下の見出しの名前 */
function sectionKeys(source: string, start: string, end: string): Set<string> {
  const publicStart = source.indexOf('\n  public: {');
  if (publicStart < 0) throw new Error('public スキーマの節が見つからない');
  const publicSource = source.slice(publicStart);
  const from = publicSource.indexOf(`\n    ${start}: {`);
  if (from < 0) throw new Error(`${start} の節が見つからない`);
  const to = publicSource.indexOf(`\n    ${end}: {`, from);
  if (to < 0) throw new Error(`${end} の節が見つからない`);
  return new Set([...publicSource.slice(from, to).matchAll(/^ {6}([A-Za-z_][A-Za-z0-9_]*): /gm)].map((m) => m[1]));
}

function readTypeFile(relative: string): { tables: Set<string>; functions: Set<string>; source: string } {
  const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
  return {
    source,
    tables: sectionKeys(source, 'Tables', 'Views'),
    functions: sectionKeys(source, 'Functions', 'Enums'),
  };
}

const migrations = readMigrationDefinitions();

function expectedNames(kind: Kind, excluded: ReadonlyMap<string, string>): string[] {
  return [...migrations[kind]]
    .filter(([name, def]) => def.last === 'create' && !def.returnsTrigger && !excluded.has(name))
    .map(([name]) => name)
    .sort();
}

const expectedTables = expectedNames('table', EXCLUDED_TABLES);
const expectedFunctions = expectedNames('function', EXCLUDED_FUNCTIONS);
const triggerFunctions = [...migrations.function]
  .filter(([, def]) => def.last === 'create' && def.returnsTrigger)
  .map(([name]) => name)
  .sort();

describe('#1495 migration の読み取り (番兵)', () => {
  it('#1495 で型に無かったテーブル・関数を、migration から拾えている', () => {
    for (const name of SENTINEL_TABLES) expect(expectedTables, name).toContain(name);
    for (const name of SENTINEL_FUNCTIONS) expect(expectedFunctions, name).toContain(name);
  });

  it('トリガー関数を RETURNS trigger で見分けている', () => {
    for (const name of SENTINEL_TRIGGER_FUNCTIONS) {
      expect(triggerFunctions, name).toContain(name);
      expect(expectedFunctions, name).not.toContain(name);
    }
    // RETURNS trigger でない関数 (RETURNS jsonb) をトリガー関数と見なしていない
    expect(migrations.function.get('consume_ai_usage')?.returnsTrigger).toBe(false);
  });

  it('DROP FUNCTION IF EXISTS (引数の型つき) で消した関数を「無いはず」に数えている (#1542)', () => {
    for (const name of SENTINEL_DROPPED_FUNCTIONS) {
      expect(migrations.function.get(name), name).toMatchObject({ last: 'drop', file: '20261017010000_drop_auth_login_lock_objects.sql' });
      expect(expectedFunctions, name).not.toContain(name);
    }
  });
});

describe.each(TYPE_FILES)('#1495 %s が migration に追随している', (relative) => {
  const types = readTypeFile(relative);

  it('migration が作ったテーブル (public) が Tables にある', () => {
    expect(expectedTables.filter((name) => !types.tables.has(name))).toEqual([]);
  });

  it('migration が作った関数 (public・トリガー関数を除く) が Functions にある', () => {
    expect(expectedFunctions.filter((name) => !types.functions.has(name))).toEqual([]);
  });

  it('Tables・Functions にあるものは、どれも migration が作って消していない', () => {
    const tableIsLive = (name: string) => migrations.table.get(name)?.last === 'create';
    const functionIsLive = (name: string) => migrations.function.get(name)?.last === 'create';
    expect([...types.tables].filter((name) => !tableIsLive(name))).toEqual([]);
    expect([...types.functions].filter((name) => !functionIsLive(name))).toEqual([]);
  });

  it('消した関数 (#1542) は型に出ていない', () => {
    expect(SENTINEL_DROPPED_FUNCTIONS.filter((name) => types.functions.has(name))).toEqual([]);
  });

  it('トリガー関数は型に出ていない (除外の規則の前提)', () => {
    expect(triggerFunctions.filter((name) => types.functions.has(name))).toEqual([]);
  });

  it('除外の一覧は、どれも本当に型に出ていない (古い除外が残っていない)', () => {
    expect([...EXCLUDED_TABLES.keys()].filter((name) => types.tables.has(name))).toEqual([]);
    expect([...EXCLUDED_FUNCTIONS.keys()].filter((name) => types.functions.has(name))).toEqual([]);
  });

  it('本番の PostgREST の版 (__InternalSupabase) を残している', () => {
    expect(types.source).toMatch(POSTGREST_VERSION_DECLARATION);
  });
});

describe('#1495 型ファイルの写し', () => {
  it('packages/shared の型ファイルは src/types の型ファイルと同じ中身', () => {
    const [primary, copy] = TYPE_FILES.map((relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8'));
    expect(copy === primary, `${TYPE_FILES[1]} を ${TYPE_FILES[0]} と同じ中身にする`).toBe(true);
  });
});
