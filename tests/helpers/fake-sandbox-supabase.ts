/**
 * sandbox 適格性チェック (src/lib/handson-tour/sandbox-eligibility.ts) を通る route の
 * 単体テスト用 Supabase モック。
 *
 * 本物の PostgREST と同じ振る舞いを user_profiles について再現する。
 *   - 主キー id で引いたときだけ行を返す
 *   - user_id のように存在しない列でフィルタすると 42703 (undefined_column) を返す
 *   - 行が無いときは .single() が PGRST116 を返す
 * 「存在しない列で引き、error を見ずに data だけ使う」種類の不具合 (#1109) を、
 * 実 DB なしでも単体テストで再現できるようにするため。
 *
 * user_profiles 以外のテーブルは `tables` に「操作ごとの結果」を渡して差し込む。
 * 渡していないテーブルを from() すると、テストの書き漏らしに気づけるようエラーにする。
 */
import { vi } from 'vitest';

export type FakeOp = 'select' | 'insert' | 'update' | 'delete';

export interface FakeResult {
  data: unknown;
  error: unknown;
}

export interface FakeCall {
  op: FakeOp;
  filters: Array<[string, unknown]>;
  payload?: unknown;
}

export type FakeTableHandler = (call: FakeCall) => FakeResult;

/** user_profiles に実在する列 (主キーは id。user_id 列は無い) */
const USER_PROFILES_COLUMNS = new Set([
  'id',
  'handson_tour_completed_at',
  'handson_tour_skipped_at',
  'roles',
]);

export interface FakeSandboxDbOptions {
  /** auth.getUser() が返すユーザー id */
  userId: string;
  /** user_profiles の行 (id = userId)。null なら該当行なし */
  profile?: Record<string, unknown> | null;
  /** 指定すると user_profiles の取得が必ずこのエラーになる (DB 障害の模擬) */
  profileFailure?: { code: string; message: string } | null;
  /** user_has_non_sandbox_activity RPC の結果 (既定は「既存データなし」) */
  rpcResult?: FakeResult;
  /** user_profiles 以外のテーブルの結果 */
  tables?: Record<string, FakeTableHandler>;
}

export interface FakeSandboxDbState {
  /** user_profiles に対して呼ばれた .eq(column, value) の記録 */
  profileFilters: Array<[string, unknown]>;
  /** 呼ばれた RPC 名の記録 */
  rpcCalls: string[];
  /** insert / update / delete の記録 (拒否されたリクエストでは空のままであるべき) */
  writes: Array<{ table: string; op: Exclude<FakeOp, 'select'>; payload?: unknown }>;
}

export function eligibleProfile(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: userId,
    handson_tour_completed_at: null,
    handson_tour_skipped_at: null,
    roles: ['user'],
    ...overrides,
  };
}

export function createFakeSandboxDb(options: FakeSandboxDbOptions) {
  const { userId, profile = null, profileFailure = null, tables = {} } = options;
  const rpcResult: FakeResult = options.rpcResult ?? { data: false, error: null };

  const state: FakeSandboxDbState = { profileFilters: [], rpcCalls: [], writes: [] };

  function execute(table: string, call: FakeCall): FakeResult {
    if (table === 'user_profiles') {
      if (profileFailure) return { data: null, error: profileFailure };
      const unknownColumn = call.filters.find(([column]) => !USER_PROFILES_COLUMNS.has(column));
      if (unknownColumn) {
        return {
          data: null,
          error: { code: '42703', message: `column user_profiles.${unknownColumn[0]} does not exist` },
        };
      }
      const idFilter = call.filters.find(([column]) => column === 'id');
      if (profile && idFilter && idFilter[1] === profile.id) {
        return { data: profile, error: null };
      }
      return {
        data: null,
        error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
      };
    }

    const handler = tables[table];
    if (!handler) throw new Error(`fake-sandbox-supabase: unexpected table "${table}" (${call.op})`);
    return handler(call);
  }

  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: userId } }, error: null })),
    },
    rpc: vi.fn(async (name: string) => {
      state.rpcCalls.push(name);
      return rpcResult;
    }),
    from: vi.fn((table: string) => {
      const call: FakeCall = { op: 'select', filters: [] };
      const run = () => execute(table, call);
      const write = (op: Exclude<FakeOp, 'select'>, payload?: unknown) => {
        call.op = op;
        call.payload = payload;
        state.writes.push({ table, op, payload });
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: unknown) => {
          call.filters.push([column, value]);
          if (table === 'user_profiles') state.profileFilters.push([column, value]);
          return builder;
        }),
        insert: vi.fn((payload: unknown) => {
          write('insert', payload);
          return builder;
        }),
        update: vi.fn((payload: unknown) => {
          write('update', payload);
          return builder;
        }),
        delete: vi.fn(() => {
          write('delete');
          return builder;
        }),
        single: vi.fn(async () => run()),
        // await builder で結果を受け取るクエリ (select 一覧 / delete / update) 用
        then: (onFulfilled: (value: FakeResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(run()).then(onFulfilled, onRejected),
      };
      return builder;
    }),
  };

  return { client, state };
}
