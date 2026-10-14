/**
 * #1040 / #1306: ハンズオンツアー (Step1 写真 / Step2 献立) が読むテーブルの、状態を持つ Supabase フェイク。
 *
 * 通常のモック (tests/helpers/fake-supabase.ts) は「呼び出し順に決め打ちの結果を返す」だけなので、
 * 存在しない列を select / filter していることを検出できない。実際、ツアーのページは
 * user_profiles.allergies / dislikes / target_kcal_per_day (どれも存在しない) を select しており、
 * PostgREST は 42703 を返していたのに error を見ていなかったため、ニックネームを含む
 * パーソナライズが全員分「空」のままだった。
 *
 * このフェイクは本番スキーマ (supabase/baseline/prod_schema.sql の CREATE TABLE) の列を読み込み、
 * 存在しない列を select / filter すると PostgREST と同じ形のエラー ({ code: '42703', message, details, hint })
 * を返す。select した列だけを返すので、select していない列に頼ったコードも検出できる。
 *
 * 検証できないもの: RLS、型の厳密なチェック。それらはローカル Supabase を使う結合テスト
 * (tests/integration/rls/handson-tour-profile-read.test.ts) で確認する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { parseSelectItem, splitTopLevel } from './select-columns';

export interface PgError {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

export function pgError(code: string, message: string, details: string | null = null): PgError {
  return { code, message, details, hint: null };
}

type Row = Record<string, unknown>;
type TableName = 'user_profiles' | 'nutrition_targets';
type Result = { data: unknown; error: PgError | null };

export interface RecordedQuery {
  table: string;
  /** `.select()` に渡した文字列 (`.select()` が無ければ '*') */
  select: string;
  filters: Array<[string, unknown]>;
}

const BASELINE_PATH = path.resolve(__dirname, '../../supabase/baseline/prod_schema.sql');

/** prod_schema.sql の `CREATE TABLE "public"."<table>" (...)` から列名を取り出す */
export function readBaselineColumns(table: string): Set<string> {
  const sql = fs.readFileSync(BASELINE_PATH, 'utf8');
  const head = `CREATE TABLE IF NOT EXISTS "public"."${table}" (`;
  const start = sql.indexOf(head);
  if (start < 0) throw new Error(`prod_schema.sql に ${table} の CREATE TABLE が見つかりません`);
  const end = sql.indexOf('\n);', start);
  const columns = new Set<string>();
  for (const line of sql.slice(start + head.length, end).split('\n')) {
    // 列定義の行は `    "col" type ...`。CONSTRAINT 行は先頭が引用符でないので一致しない
    const match = /^\s+"([A-Za-z_][A-Za-z0-9_]*)"\s/.exec(line);
    if (match) columns.add(match[1]);
  }
  if (!columns.has('id') && !columns.has('user_id')) {
    throw new Error(`prod_schema.sql から ${table} の列を取り出せませんでした (書式が変わった?)`);
  }
  return columns;
}

export interface FakeTourDbOptions {
  userId?: string;
  /** user_profiles の行 (列は一部でよい)。null なら行なし */
  profile?: Row | null;
  /** nutrition_targets の行 (user_id は自動で入る)。null / 省略なら行なし */
  nutritionTarget?: Row | null;
}

export interface FakeTourDb {
  userId: string;
  /** supabase クライアントの代わりに渡す */
  supabase: {
    from: ReturnType<typeof vi.fn>;
    auth: { getUser: ReturnType<typeof vi.fn> };
  };
  /** 実行された問い合わせの記録 (実行順) */
  queries: RecordedQuery[];
  /** 存在しない列を select / filter した問い合わせ (本来は空) */
  schemaViolations: string[];
  /** 指定テーブルへの次の count 回の問い合わせを、実行せずに指定のエラーで失敗させる */
  failNext(table: TableName, error: PgError, count?: number): void;
  /** 指定テーブルへの次の問い合わせで、PostgREST ではなく例外を投げる (ネットワーク断などの再現) */
  throwNext(table: TableName, thrown: unknown): void;
}

export const DEFAULT_TEST_USER_ID = '11111111-1111-4111-8111-111111111111';

export function createFakeTourDb(options: FakeTourDbOptions = {}): FakeTourDb {
  const userId = options.userId ?? DEFAULT_TEST_USER_ID;
  const columns: Record<TableName, Set<string>> = {
    user_profiles: readBaselineColumns('user_profiles'),
    nutrition_targets: readBaselineColumns('nutrition_targets'),
  };

  const assertKnownColumns = (table: TableName, row: Row) => {
    for (const key of Object.keys(row)) {
      if (!columns[table].has(key)) {
        throw new Error(`fake-tour-profile-db: ${table} に列 ${key} は無い (テストの入力が実スキーマと合っていない)`);
      }
    }
  };

  const rows: Record<TableName, Row[]> = { user_profiles: [], nutrition_targets: [] };
  if (options.profile !== null) {
    const profile: Row = {
      id: userId,
      nickname: 'テストユーザー',
      age_group: '30s',
      gender: 'other',
      cooking_experience: 'beginner',
      ...options.profile,
    };
    assertKnownColumns('user_profiles', profile);
    rows.user_profiles.push(profile);
  }
  if (options.nutritionTarget) {
    const target: Row = { id: 'target-1', user_id: userId, ...options.nutritionTarget };
    assertKnownColumns('nutrition_targets', target);
    rows.nutrition_targets.push(target);
  }

  const queries: RecordedQuery[] = [];
  const schemaViolations: string[] = [];
  const failures: Array<{ table: TableName; error: PgError }> = [];
  const throwers: Array<{ table: TableName; thrown: unknown }> = [];

  const isTable = (name: string): name is TableName => name === 'user_profiles' || name === 'nutrition_targets';

  function execute(table: TableName, select: string | null, filters: Array<[string, unknown]>, mode: 'single' | 'maybeSingle'): Result {
    queries.push({ table, select: select ?? '*', filters: [...filters] });

    const thrownAt = throwers.findIndex((t) => t.table === table);
    if (thrownAt >= 0) {
      const [{ thrown }] = throwers.splice(thrownAt, 1);
      throw thrown;
    }
    const failureAt = failures.findIndex((f) => f.table === table);
    if (failureAt >= 0) {
      const [{ error }] = failures.splice(failureAt, 1);
      return { data: null, error };
    }

    const known = columns[table];
    const selected: string[] = [];
    for (const item of splitTopLevel(select ?? '*')) {
      const parsed = parseSelectItem(item);
      if (!parsed) continue; // `*` など
      if (parsed.kind === 'relation') {
        throw new Error(`fake-tour-profile-db: 埋め込みリレーション ${parsed.name} は未対応`);
      }
      if (!known.has(parsed.name)) {
        const message = `column ${table}.${parsed.name} does not exist`;
        schemaViolations.push(message);
        return { data: null, error: pgError('42703', message) };
      }
      selected.push(parsed.name);
    }
    for (const [column] of filters) {
      if (!known.has(column)) {
        const message = `column ${table}.${column} does not exist`;
        schemaViolations.push(message);
        return { data: null, error: pgError('42703', message) };
      }
    }

    const matched = rows[table].filter((row) => filters.every(([column, value]) => row[column] === value));
    if (matched.length > 1 || (matched.length === 0 && mode === 'single')) {
      return {
        data: null,
        error: pgError('PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${matched.length} rows`),
      };
    }
    if (matched.length === 0) return { data: null, error: null };

    const row = matched[0];
    const names = selected.length > 0 ? selected : [...known];
    return { data: Object.fromEntries(names.map((name) => [name, row[name] ?? null])), error: null };
  }

  const from = vi.fn((table: string) => {
    if (!isTable(table)) throw new Error(`fake-tour-profile-db: テーブル ${table} は未対応`);
    let select: string | null = null;
    const filters: Array<[string, unknown]> = [];
    const builder = {
      select: vi.fn((columnsText?: string) => {
        select = columnsText ?? '*';
        return builder;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      }),
      single: vi.fn(async () => execute(table, select, filters, 'single')),
      maybeSingle: vi.fn(async () => execute(table, select, filters, 'maybeSingle')),
    };
    return builder;
  });

  return {
    userId,
    supabase: {
      from,
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: userId } }, error: null })) },
    },
    queries,
    schemaViolations,
    failNext(table, error, count = 1) {
      for (let i = 0; i < count; i += 1) failures.push({ table, error });
    },
    throwNext(table, thrown) {
      throwers.push({ table, thrown });
    },
  };
}
