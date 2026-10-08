/**
 * #1214: shopping_lists / shopping_list_items の挙動を模した、状態を持つ Supabase フェイク。
 *
 * 通常のモック (tests/helpers/fake-supabase.ts) は「呼び出し順に決め打ちの結果を返す」だけなので、
 * 次の 2 点を検出できない。
 *   1. INSERT ペイロードの列が実テーブルと合っていないこと
 *      (shopping_lists に name 列は無く、start_date / end_date は NOT NULL で既定値が無い)
 *   2. 部分ユニーク索引 idx_shopping_lists_active_unique (user_id) WHERE status = 'active' による 23505
 * このフェイクは本番スキーマ (supabase/baseline/prod_schema.sql) の列定義とこの索引を再現し、
 * PostgREST と同じ形のエラー ({ code, message, details, hint }) を返す。
 *
 * 検証できないもの: RLS、型の厳密なチェック、同時実行の「本物の」並行性。
 * それらはローカル Supabase を使う結合テスト (tests/integration/security/shopping-list-add-recipe.test.ts) で確認する。
 */
import { vi } from 'vitest';

export interface PgError {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

export type ShoppingListRow = {
  id: string;
  user_id: string;
  title: string | null;
  start_date: string;
  end_date: string;
  status: string | null;
  servings_config: unknown;
  created_at: string;
  updated_at: string;
};

export type ShoppingListItemRow = {
  id: string;
  category: string;
  item_name: string;
  quantity: string | null;
  is_checked: boolean | null;
  created_at: string;
  updated_at: string;
  source: string;
  normalized_name: string | null;
  quantity_variants: unknown;
  selected_variant_index: number | null;
  shopping_list_id: string | null;
};

type TableName = 'shopping_lists' | 'shopping_list_items';
type Operation = 'select' | 'insert';
type Row = Record<string, unknown>;
type Result = { data: unknown; error: PgError | null };

export interface RecordedCall {
  table: string;
  op: Operation;
  payload: unknown;
  filters: Array<[string, unknown]>;
}

// 本番スキーマ (supabase/baseline/prod_schema.sql) の列
const COLUMNS: Record<TableName, readonly string[]> = {
  shopping_lists: [
    'id', 'user_id', 'title', 'start_date', 'end_date', 'status', 'servings_config', 'created_at', 'updated_at',
  ],
  shopping_list_items: [
    'id', 'category', 'item_name', 'quantity', 'is_checked', 'created_at', 'updated_at', 'source',
    'normalized_name', 'quantity_variants', 'selected_variant_index', 'shopping_list_id',
  ],
};

// NOT NULL で既定値が無い列 (INSERT で必ず値が要る)
const REQUIRED: Record<TableName, readonly string[]> = {
  shopping_lists: ['user_id', 'start_date', 'end_date'],
  shopping_list_items: ['item_name'],
};

let sequence = 0;
function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export function pgError(code: string, message: string, details: string | null = null): PgError {
  return { code, message, details, hint: null };
}

function isTable(name: string): name is TableName {
  return name === 'shopping_lists' || name === 'shopping_list_items';
}

export interface FakeShoppingListsDb {
  /** supabase クライアントの代わりに渡す */
  supabase: {
    from: ReturnType<typeof vi.fn>;
    auth: { getUser: ReturnType<typeof vi.fn> };
  };
  lists: ShoppingListRow[];
  items: ShoppingListItemRow[];
  /** 実行された SELECT / INSERT の記録 (実行順) */
  calls: RecordedCall[];
  /** アクティブな買い物リストを直接作る (別リクエストが先に作った状況・既存ユーザーの再現) */
  seedActiveList(userId: string, overrides?: Partial<ShoppingListRow>): ShoppingListRow;
  /** 次に shopping_lists への INSERT が適用される直前に実行するフック (別リクエストが先にコミットした状況の再現) */
  beforeNextListInsert(hook: () => void): void;
  /** 指定テーブル・操作の次の count 回を、実行せずに指定のエラーで失敗させる */
  failNext(table: TableName, op: Operation, error: PgError, count?: number): void;
}

export function createFakeShoppingListsDb(userId = 'user-1'): FakeShoppingListsDb {
  const tables: Record<TableName, Row[]> = { shopping_lists: [], shopping_list_items: [] };
  const calls: RecordedCall[] = [];
  const injected: Array<{ table: TableName; op: Operation; error: PgError; remaining: number }> = [];
  const listInsertHooks: Array<() => void> = [];

  function takeInjected(table: TableName, op: Operation): PgError | null {
    const entry = injected.find((e) => e.table === table && e.op === op && e.remaining > 0);
    if (!entry) return null;
    entry.remaining -= 1;
    return entry.error;
  }

  function seedActiveList(ownerId: string, overrides: Partial<ShoppingListRow> = {}): ShoppingListRow {
    const now = new Date().toISOString();
    const row: ShoppingListRow = {
      id: nextId('list'),
      user_id: ownerId,
      title: '既存のリスト',
      start_date: '2026-10-01',
      end_date: '2026-10-07',
      status: 'active',
      servings_config: null,
      created_at: now,
      updated_at: now,
      ...overrides,
    };
    tables.shopping_lists.push(row as unknown as Row);
    return row;
  }

  function project(row: Row, columns: string): Row {
    if (columns === '*' || columns.trim() === '') return { ...row };
    const picked: Row = {};
    for (const column of columns.split(',').map((c) => c.trim())) picked[column] = row[column];
    return picked;
  }

  function respond(rows: Row[], mode: 'many' | 'single' | 'maybeSingle', columns: string): Result {
    const projected = rows.map((r) => project(r, columns));
    if (mode === 'many') return { data: projected, error: null };
    if (projected.length === 1) return { data: projected[0], error: null };
    if (projected.length === 0 && mode === 'maybeSingle') return { data: null, error: null };
    return {
      data: null,
      error: pgError(
        'PGRST116',
        'JSON object requested, multiple (or no) rows returned',
        `The result contains ${projected.length} rows`,
      ),
    };
  }

  function runInsert(
    table: TableName,
    payload: Row | Row[],
    mode: 'many' | 'single' | 'maybeSingle',
    columns: string | null,
  ): Result {
    const rows = Array.isArray(payload) ? payload : [payload];

    // PostgREST: 存在しない列は SQL を実行する前に PGRST204 で拒否される
    for (const row of rows) {
      for (const column of Object.keys(row)) {
        if (!COLUMNS[table].includes(column)) {
          return {
            data: null,
            error: pgError('PGRST204', `Could not find the '${column}' column of '${table}' in the schema cache`),
          };
        }
      }
    }

    // NOT NULL (既定値なし)
    for (const row of rows) {
      for (const column of REQUIRED[table]) {
        if (row[column] === undefined || row[column] === null) {
          return {
            data: null,
            error: pgError(
              '23502',
              `null value in column "${column}" of relation "${table}" violates not-null constraint`,
              'Failing row contains (...).',
            ),
          };
        }
      }
    }

    const now = new Date().toISOString();
    const created: Row[] = [];
    for (const row of rows) {
      if (table === 'shopping_lists') {
        // 部分ユニーク索引 idx_shopping_lists_active_unique (user_id) WHERE status = 'active'
        const status = row.status === undefined ? 'active' : row.status;
        if (status === 'active') {
          const conflict = [...tables.shopping_lists, ...created].some(
            (existing) => existing.user_id === row.user_id && existing.status === 'active',
          );
          if (conflict) {
            return {
              data: null,
              error: pgError(
                '23505',
                'duplicate key value violates unique constraint "idx_shopping_lists_active_unique"',
                `Key (user_id)=(${String(row.user_id)}) already exists.`,
              ),
            };
          }
        }
        created.push({
          id: nextId('list'),
          title: null,
          servings_config: null,
          created_at: now,
          updated_at: now,
          ...row,
          status,
        });
      } else {
        // 外部キー shopping_list_items_shopping_list_id_fkey (NULL は許容)
        if (
          row.shopping_list_id != null &&
          !tables.shopping_lists.some((list) => list.id === row.shopping_list_id)
        ) {
          return {
            data: null,
            error: pgError(
              '23503',
              'insert or update on table "shopping_list_items" violates foreign key constraint "shopping_list_items_shopping_list_id_fkey"',
            ),
          };
        }
        created.push({
          id: nextId('item'),
          category: 'その他',
          quantity: null,
          is_checked: false,
          created_at: now,
          updated_at: now,
          source: 'manual',
          normalized_name: null,
          quantity_variants: [],
          selected_variant_index: 0,
          shopping_list_id: null,
          ...row,
        });
      }
    }

    // 一括 INSERT は全部成功するか全部失敗するか (単一の SQL 文)
    tables[table].push(...created);
    if (columns === null) return { data: null, error: null };
    return respond(created, mode, columns);
  }

  class FakeQuery implements PromiseLike<Result> {
    private op: Operation = 'select';
    private columns: string | null = '*';
    private filters: Array<[string, unknown]> = [];
    private payload: Row | Row[] | null = null;
    private mode: 'many' | 'single' | 'maybeSingle' = 'many';

    constructor(private readonly table: TableName) {}

    select(columns = '*') {
      this.columns = columns;
      return this;
    }

    insert(payload: Row | Row[]) {
      this.op = 'insert';
      this.payload = payload;
      // insert の戻り値の列は select() を呼んだ時だけ返る (PostgREST の return=minimal 相当)
      this.columns = null;
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }

    single() {
      this.mode = 'single';
      return this;
    }

    maybeSingle() {
      this.mode = 'maybeSingle';
      return this;
    }

    // await された時点 (= リクエストが DB に届いた時点) で 1 回だけ実行する
    then<R1 = Result, R2 = never>(
      onFulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
      onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ): Promise<R1 | R2> {
      return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
    }

    private execute(): Result {
      calls.push({ table: this.table, op: this.op, payload: this.payload, filters: [...this.filters] });

      if (this.op === 'insert' && this.table === 'shopping_lists') {
        // 別リクエストが先にコミットした状況を、この INSERT が適用される直前に再現する
        listInsertHooks.shift()?.();
      }

      const failure = takeInjected(this.table, this.op);
      if (failure) return { data: null, error: failure };

      if (this.op === 'insert') {
        return runInsert(this.table, this.payload as Row | Row[], this.mode, this.columns);
      }

      const rows = tables[this.table].filter((row) => this.filters.every(([column, value]) => row[column] === value));
      return respond(rows, this.mode, this.columns ?? '*');
    }
  }

  const from = vi.fn((table: string) => {
    if (!isTable(table)) {
      throw new Error(`fake-shopping-lists-db: unexpected table "${table}"`);
    }
    return new FakeQuery(table);
  });

  return {
    supabase: {
      from,
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: userId } }, error: null })) },
    },
    lists: tables.shopping_lists as unknown as ShoppingListRow[],
    items: tables.shopping_list_items as unknown as ShoppingListItemRow[],
    calls,
    seedActiveList,
    beforeNextListInsert(hook) {
      listInsertHooks.push(hook);
    },
    failNext(table, op, error, count = 1) {
      injected.push({ table, op, error, remaining: count });
    },
  };
}
