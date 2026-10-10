// @vitest-environment node
/**
 * #1433: 監査ログの 2 つの API の期間 (from / to) を JST の暦日で絞ることの回帰テスト
 *   - GET /api/super-admin/audit-logs        (admin_audit_logs。画面 src/app/super-admin/audit-logs/page.tsx の日付の入力)
 *   - GET /api/operator/membership/audit     (membership_audit。画面 src/app/(operator)/operator/membership/audit/page.tsx の日付の入力)
 *
 * 以前はどちらも `.gte('created_at', from)` / `.lte('created_at', to + 'T23:59:59Z')` で、日付を UTC の暦日として読んでいた。
 * 運用者が 10/10 を選ぶと JST 10/10 9:00 〜 10/11 8:59:59 の行が返り、JST 10/10 0:00〜8:59 の操作が表示されず、
 * 翌日の朝の操作が混ざっていた。今は開始日の JST 0 時以上・終了日の翌日の JST 0 時未満 (.gte と .lt) で絞る。
 *
 * DB は、渡された条件 (gte / lt / lte / eq) を created_at の時刻として評価するフェイクで置き換える
 * (条件の値と、その条件で実際に残る行の両方を確かめる)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_TIME_ZONES, withTimeZoneAsync } from './helpers/time-zones';

type Row = { id: string; created_at: string };
type FilterKind = 'eq' | 'gte' | 'lt' | 'lte' | 'ilike';
interface Filter {
  kind: FilterKind;
  column: string;
  value: unknown;
}
interface RecordedSelect {
  table: string;
  filters: Filter[];
}

const state = vi.hoisted(() => ({ supabase: null as unknown }));
const requireRole = vi.hoisted(() => vi.fn());
const requireSuperAdmin = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));
vi.mock('@/lib/auth/operator-permissions', () => ({ requireSuperAdmin }));
// super-admin/audit-logs は await createClient()、operator/membership/audit は createClient() をそのまま使う。どちらでも同じ値を返す
vi.mock('@/lib/supabase/server', () => ({ createClient: () => state.supabase }));

import { GET as getSuperAdminAuditLogs } from '../src/app/api/super-admin/audit-logs/route';
import { GET as getMembershipAudit } from '../src/app/api/operator/membership/audit/route';

/** created_at の時刻として比べる (DB の timestamptz の比較と同じく、書き方の違う時刻も同じ時刻なら等しい) */
function timeOf(value: unknown): number {
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) throw new Error(`時刻として読めない値で created_at を絞った: ${String(value)}`);
  return ms;
}

function matches(row: Row, filter: Filter): boolean {
  const actual = (row as Record<string, unknown>)[filter.column];
  switch (filter.kind) {
    case 'eq':
      return actual === filter.value;
    case 'ilike':
      return true; // このテストでは使わない (action などの文字列の絞り込み)
    case 'gte':
      return timeOf(actual) >= timeOf(filter.value);
    case 'lt':
      return timeOf(actual) < timeOf(filter.value);
    case 'lte':
      return timeOf(actual) <= timeOf(filter.value);
  }
}

/** select('*', { count }) → order → range → eq / ilike / gte / lt / lte → await の形だけを持つフェイク */
function createFakeSupabase(tables: Record<string, Row[]>) {
  const selects: RecordedSelect[] = [];
  const supabase = {
    from(table: string) {
      const recorded: RecordedSelect = { table, filters: [] };
      const query = {
        select() {
          selects.push(recorded);
          return query;
        },
        order() {
          return query;
        },
        range() {
          return query;
        },
        eq(column: string, value: unknown) {
          recorded.filters.push({ kind: 'eq', column, value });
          return query;
        },
        ilike(column: string, value: unknown) {
          recorded.filters.push({ kind: 'ilike', column, value });
          return query;
        },
        gte(column: string, value: unknown) {
          recorded.filters.push({ kind: 'gte', column, value });
          return query;
        },
        lt(column: string, value: unknown) {
          recorded.filters.push({ kind: 'lt', column, value });
          return query;
        },
        lte(column: string, value: unknown) {
          recorded.filters.push({ kind: 'lte', column, value });
          return query;
        },
        then<T>(resolve: (result: { data: Row[]; error: null; count: number }) => T) {
          const data = (tables[table] ?? []).filter((row) => recorded.filters.every((f) => matches(row, f)));
          return Promise.resolve({ data, error: null, count: data.length }).then(resolve);
        },
      };
      return query;
    },
  };
  return { supabase, selects };
}

/**
 * 境界の行。id は JST の暦日と時刻 (JST 10/10 を選んだときに入るかどうかが読めるように)
 */
const BOUNDARY_ROWS: Row[] = [
  { id: 'jst-10-09-23:59:59.999', created_at: '2026-10-09T14:59:59.999Z' },
  { id: 'jst-10-10-00:00', created_at: '2026-10-09T15:00:00.000Z' }, // 以前は落ちていた (UTC では 10/9)
  { id: 'jst-10-10-08:59:59', created_at: '2026-10-09T23:59:59.000Z' }, // 以前は落ちていた (UTC では 10/9)
  { id: 'jst-10-10-09:00', created_at: '2026-10-10T00:00:00.000Z' },
  { id: 'jst-10-10-23:59:59.999', created_at: '2026-10-10T14:59:59.999Z' },
  { id: 'jst-10-11-00:00', created_at: '2026-10-10T15:00:00.000Z' }, // 以前は入っていた ('T23:59:59Z' 以下)
  { id: 'jst-10-11-08:59:59', created_at: '2026-10-10T23:59:59.000Z' }, // 以前は入っていた ('T23:59:59Z' 以下)
  { id: 'jst-10-11-09:00', created_at: '2026-10-11T00:00:00.000Z' },
];

/** 2 つのルートを同じ形で呼ぶ */
const ROUTES = [
  {
    name: 'GET /api/super-admin/audit-logs',
    table: 'admin_audit_logs',
    call: (query: string) =>
      getSuperAdminAuditLogs(new Request(`http://localhost/api/super-admin/audit-logs${query}`) as never),
  },
  {
    name: 'GET /api/operator/membership/audit',
    table: 'membership_audit',
    call: (query: string) =>
      getMembershipAudit(new Request(`http://localhost/api/operator/membership/audit${query}`) as never),
  },
] as const;

let fake: ReturnType<typeof createFakeSupabase>;

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ id: 'admin', roles: ['super_admin'] });
  requireSuperAdmin.mockResolvedValue({ id: 'admin', roles: ['super_admin'] });
  fake = createFakeSupabase({ admin_audit_logs: BOUNDARY_ROWS, membership_audit: BOUNDARY_ROWS });
  state.supabase = fake.supabase;
});

describe.each(ROUTES)('$name: 期間は JST の暦日 (#1433)', ({ table, call }) => {
  const idsOf = async (query: string) => {
    const res = await call(query);
    expect(res.status, query).toBe(200);
    const json = (await res.json()) as { data: Row[] };
    return json.data.map((row) => row.id).sort();
  };
  const createdAtFilters = () =>
    fake.selects.filter((s) => s.table === table).flatMap((s) => s.filters.filter((f) => f.column === 'created_at'));

  it.each(TEST_TIME_ZONES)(
    'TZ=%s でも、from=to=10/10 は JST 10/10 0:00 〜 23:59:59.999 の行だけ (JST 0:00 ちょうど・8:59:59 は入り、翌日の 0:00・8:59:59 は入らない)',
    async (tz) => {
      const ids = await withTimeZoneAsync(tz, () => idsOf('?from=2026-10-10&to=2026-10-10'));
      expect(ids).toEqual(['jst-10-10-00:00', 'jst-10-10-08:59:59', 'jst-10-10-09:00', 'jst-10-10-23:59:59.999'].sort());
      expect(createdAtFilters()).toEqual([
        { kind: 'gte', column: 'created_at', value: '2026-10-09T15:00:00.000Z' },
        { kind: 'lt', column: 'created_at', value: '2026-10-10T15:00:00.000Z' },
      ]);
    },
  );

  it('from だけ: 開始日の JST 0 時以上 (上限なし)。開始日の JST 0:00〜8:59 の行も入る', async () => {
    const ids = await idsOf('?from=2026-10-10');
    expect(ids).toEqual(BOUNDARY_ROWS.filter((r) => r.id !== 'jst-10-09-23:59:59.999').map((r) => r.id).sort());
    expect(createdAtFilters()).toEqual([{ kind: 'gte', column: 'created_at', value: '2026-10-09T15:00:00.000Z' }]);
  });

  it('to だけ: 終了日の翌日の JST 0 時未満 (下限なし)。翌日の JST 0:00〜8:59 の行は入らない', async () => {
    const ids = await idsOf('?to=2026-10-10');
    expect(ids).toEqual(
      ['jst-10-09-23:59:59.999', 'jst-10-10-00:00', 'jst-10-10-08:59:59', 'jst-10-10-09:00', 'jst-10-10-23:59:59.999'].sort(),
    );
    expect(createdAtFilters()).toEqual([{ kind: 'lt', column: 'created_at', value: '2026-10-10T15:00:00.000Z' }]);
  });

  it('期間を指定しなければ created_at で絞らない', async () => {
    const ids = await idsOf('');
    expect(ids).toEqual(BOUNDARY_ROWS.map((r) => r.id).sort());
    expect(createdAtFilters()).toEqual([]);
  });

  it.each([
    ['月末をまたぐ (10/31 〜 11/1)', '?from=2026-10-31&to=2026-11-01', '2026-10-30T15:00:00.000Z', '2026-11-01T15:00:00.000Z'],
    ['年末をまたぐ (12/31 〜 1/1)', '?from=2026-12-31&to=2027-01-01', '2026-12-30T15:00:00.000Z', '2027-01-01T15:00:00.000Z'],
  ])('%s: 開始日の JST 0 時 〜 終了日の翌日の JST 0 時', async (_label, query, gte, lt) => {
    await idsOf(query);
    expect(createdAtFilters()).toEqual([
      { kind: 'gte', column: 'created_at', value: gte },
      { kind: 'lt', column: 'created_at', value: lt },
    ]);
  });

  it.each(['?from=2026-02-30', '?to=2026-13-01', '?from=2026/10/10', '?to=garbage'])(
    '存在しない日付・形の違う日付 (%s) は 400。DB には触れない (JST 0 時の時刻に直す前に入口で弾く)',
    async (query) => {
      const res = await call(query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
      expect(fake.selects).toHaveLength(0);
    },
  );
});
