// @vitest-environment node
/**
 * #1433: GET /api/admin/users の registered_from / registered_to / last_login_before を JST の暦日で絞ることの回帰テスト
 *
 * operator/02-api-spec.md §4 で、この 3 つは date (登録日 FROM・登録日 TO・最終ログイン日)。
 * 以前は日付の文字列のまま created_at / last_login_at (timestamptz) を .gte / .lte していたので、DB は UTC の 0 時 = JST 9 時と読み、
 *   - registered_from=10/10 は JST 10/10 0:00〜8:59 に登録したユーザーを落とし
 *   - registered_to=10/10 は JST 10/10 9:00 以降に登録したユーザーを落とし (UTC の 10/10 0:00 まで)
 *   - last_login_before=10/10 は JST 10/10 0:00〜9:00 に最終ログインしたユーザーを入れていた
 * 今は、登録日は「FROM の JST 0 時以上・TO の翌日の JST 0 時未満」(.gte と .lt)、
 * 最終ログインは「その日の JST 0 時より前」(.lt) で絞る。実在しない日付は DB に触れる前に 400。
 * 実在するが受け付ける範囲 (0101-01-02〜9998-12-30。isCalendarDate) の外の日付も 400
 * (9999-12-31 は翌日の JST 0 時を求めるところで RangeError になり、try/catch の無いところで 500 になっていた)。
 *
 * DB は、渡された条件を時刻として評価するフェイクで置き換える (条件の値と、その条件で実際に残る行の両方を確かめる)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_TIME_ZONES, withTimeZoneAsync } from './helpers/time-zones';

type Row = { id: string; created_at: string; last_login_at: string | null };
type FilterKind = 'gte' | 'lt' | 'lte' | 'gt';
interface Filter {
  kind: FilterKind;
  column: string;
  value: unknown;
}

const state = vi.hoisted(() => ({ supabase: null as unknown }));
const requireRole = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => state.supabase }));

import { GET } from '../src/app/api/admin/users/route';

/** timestamptz の比較と同じく、書き方の違う時刻も同じ時刻なら等しい。NULL は比較でどの条件も満たさない */
function timeOf(value: unknown): number {
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) throw new Error(`時刻として読めない値で絞った: ${String(value)}`);
  return ms;
}

function matches(row: Row, filter: Filter): boolean {
  const actual = (row as Record<string, unknown>)[filter.column];
  if (actual === null || actual === undefined) return false; // SQL の NULL との比較は真にならない
  const a = timeOf(actual);
  const b = timeOf(filter.value);
  switch (filter.kind) {
    case 'gte':
      return a >= b;
    case 'gt':
      return a > b;
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
  }
}

/** select → (gte / gt / lt / lte) → order → range → await の形だけを持つフェイク。DB に触れたかも記録する */
function createFakeSupabase(rows: Row[]) {
  const filters: Filter[] = [];
  let touched = false;
  const supabase = {
    from() {
      touched = true;
      const query = {
        select() {
          return query;
        },
        order() {
          return query;
        },
        range() {
          return query;
        },
        gte(column: string, value: unknown) {
          filters.push({ kind: 'gte', column, value });
          return query;
        },
        gt(column: string, value: unknown) {
          filters.push({ kind: 'gt', column, value });
          return query;
        },
        lt(column: string, value: unknown) {
          filters.push({ kind: 'lt', column, value });
          return query;
        },
        lte(column: string, value: unknown) {
          filters.push({ kind: 'lte', column, value });
          return query;
        },
        then<T>(resolve: (result: { data: Row[]; error: null; count: number }) => T) {
          const data = rows.filter((row) => filters.every((f) => matches(row, f)));
          return Promise.resolve({ data, error: null, count: data.length }).then(resolve);
        },
      };
      return query;
    },
  };
  return { supabase, filters, wasTouched: () => touched };
}

/** 登録日時の境界の行。id は JST の暦日と時刻 */
const REGISTERED_ROWS: Row[] = [
  { id: 'reg-jst-10-09-23:59:59.999', created_at: '2026-10-09T14:59:59.999Z', last_login_at: null },
  { id: 'reg-jst-10-10-00:00', created_at: '2026-10-09T15:00:00.000Z', last_login_at: null }, // 以前は FROM=10/10 で落ちていた
  { id: 'reg-jst-10-10-08:59:59', created_at: '2026-10-09T23:59:59.000Z', last_login_at: null }, // 以前は FROM=10/10 で落ちていた
  { id: 'reg-jst-10-10-09:00', created_at: '2026-10-10T00:00:00.000Z', last_login_at: null },
  { id: 'reg-jst-10-10-23:59:59.999', created_at: '2026-10-10T14:59:59.999Z', last_login_at: null }, // 以前は TO=10/10 で落ちていた
  { id: 'reg-jst-10-11-00:00', created_at: '2026-10-10T15:00:00.000Z', last_login_at: null },
  { id: 'reg-jst-10-11-08:59:59', created_at: '2026-10-10T23:59:59.000Z', last_login_at: null },
];

/** 最終ログイン日時の境界の行 (登録日時は範囲外の昔にそろえる) */
const OLD_CREATED_AT = '2026-01-01T00:00:00.000Z';
const LAST_LOGIN_ROWS: Row[] = [
  { id: 'login-never', created_at: OLD_CREATED_AT, last_login_at: null },
  { id: 'login-jst-10-09-23:59:59.999', created_at: OLD_CREATED_AT, last_login_at: '2026-10-09T14:59:59.999Z' },
  { id: 'login-jst-10-10-00:00', created_at: OLD_CREATED_AT, last_login_at: '2026-10-09T15:00:00.000Z' }, // 以前は入っていた
  { id: 'login-jst-10-10-08:59:59', created_at: OLD_CREATED_AT, last_login_at: '2026-10-09T23:59:59.000Z' }, // 以前は入っていた
  { id: 'login-jst-10-10-09:00', created_at: OLD_CREATED_AT, last_login_at: '2026-10-10T00:00:00.000Z' }, // 以前は入っていた (lte)
  { id: 'login-jst-10-10-12:00', created_at: OLD_CREATED_AT, last_login_at: '2026-10-10T03:00:00.000Z' },
];

let fake: ReturnType<typeof createFakeSupabase>;

function useRows(rows: Row[]) {
  fake = createFakeSupabase(rows);
  state.supabase = fake.supabase;
}

async function idsOf(query: string): Promise<string[]> {
  const res = await GET(new Request(`http://localhost/api/admin/users${query}`));
  expect(res.status, query).toBe(200);
  const json = (await res.json()) as { data: Array<{ id: string }> };
  return json.data.map((row) => row.id).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  // support はメールを引かない (メールの RPC をフェイクに持たせなくて済む)
  requireRole.mockResolvedValue({ id: 'support-user', roles: ['support'] });
  useRows(REGISTERED_ROWS);
});

describe('GET /api/admin/users: 登録日 (registered_from / registered_to) は JST の暦日 (#1433)', () => {
  it.each(TEST_TIME_ZONES)(
    'TZ=%s でも、registered_from=registered_to=10/10 は JST 10/10 0:00 〜 23:59:59.999 に登録した行だけ',
    async (tz) => {
      const ids = await withTimeZoneAsync(tz, () => idsOf('?registered_from=2026-10-10&registered_to=2026-10-10'));
      expect(ids).toEqual(
        ['reg-jst-10-10-00:00', 'reg-jst-10-10-08:59:59', 'reg-jst-10-10-09:00', 'reg-jst-10-10-23:59:59.999'].sort(),
      );
      expect(fake.filters).toEqual([
        { kind: 'gte', column: 'created_at', value: '2026-10-09T15:00:00.000Z' },
        { kind: 'lt', column: 'created_at', value: '2026-10-10T15:00:00.000Z' },
      ]);
    },
  );

  it('registered_from だけ: その日の JST 0 時以上 (JST 0:00 ちょうど・8:59:59 の登録も入る)', async () => {
    const ids = await idsOf('?registered_from=2026-10-10');
    expect(ids).toEqual(REGISTERED_ROWS.filter((r) => r.id !== 'reg-jst-10-09-23:59:59.999').map((r) => r.id).sort());
    expect(fake.filters).toEqual([{ kind: 'gte', column: 'created_at', value: '2026-10-09T15:00:00.000Z' }]);
  });

  it('registered_to だけ: その日の翌日の JST 0 時未満 (翌日の JST 0:00・8:59:59 の登録は入らない)', async () => {
    const ids = await idsOf('?registered_to=2026-10-10');
    expect(ids).toEqual(
      [
        'reg-jst-10-09-23:59:59.999',
        'reg-jst-10-10-00:00',
        'reg-jst-10-10-08:59:59',
        'reg-jst-10-10-09:00',
        'reg-jst-10-10-23:59:59.999',
      ].sort(),
    );
    expect(fake.filters).toEqual([{ kind: 'lt', column: 'created_at', value: '2026-10-10T15:00:00.000Z' }]);
  });

  it.each([
    ['月末をまたぐ (10/31 〜 11/1)', '?registered_from=2026-10-31&registered_to=2026-11-01', '2026-10-30T15:00:00.000Z', '2026-11-01T15:00:00.000Z'],
    ['年末をまたぐ (12/31 〜 1/1)', '?registered_from=2026-12-31&registered_to=2027-01-01', '2026-12-30T15:00:00.000Z', '2027-01-01T15:00:00.000Z'],
    ['うるう年の 2 月末 (2/29 〜 2/29)', '?registered_from=2028-02-29&registered_to=2028-02-29', '2028-02-28T15:00:00.000Z', '2028-02-29T15:00:00.000Z'],
  ])('%s: FROM の JST 0 時 〜 TO の翌日の JST 0 時', async (_label, query, gte, lt) => {
    await idsOf(query);
    expect(fake.filters).toEqual([
      { kind: 'gte', column: 'created_at', value: gte },
      { kind: 'lt', column: 'created_at', value: lt },
    ]);
  });

  it('空欄 (registered_from=&registered_to=&last_login_before=) は指定なしとして絞らない', async () => {
    const ids = await idsOf('?registered_from=&registered_to=&last_login_before=');
    expect(ids).toEqual(REGISTERED_ROWS.map((r) => r.id).sort());
    expect(fake.filters).toEqual([]);
  });
});

describe('GET /api/admin/users: last_login_before は「最終ログイン日がこの日より前」= その日の JST 0 時より前 (#1433)', () => {
  beforeEach(() => {
    useRows(LAST_LOGIN_ROWS);
  });

  it.each(TEST_TIME_ZONES)(
    'TZ=%s でも、last_login_before=10/10 は JST 10/9 23:59:59.999 までにログインした行だけ (10/10 JST 0:00 ちょうど以降・未ログインは入らない)',
    async (tz) => {
      const ids = await withTimeZoneAsync(tz, () => idsOf('?last_login_before=2026-10-10'));
      expect(ids).toEqual(['login-jst-10-09-23:59:59.999']);
      expect(fake.filters).toEqual([{ kind: 'lt', column: 'last_login_at', value: '2026-10-09T15:00:00.000Z' }]);
    },
  );

  it.each([
    ['月初 (11/1 より前 = 10/31 まで)', '2026-11-01', '2026-10-31T15:00:00.000Z'],
    ['年初 (1/1 より前 = 前年の 12/31 まで)', '2027-01-01', '2026-12-31T15:00:00.000Z'],
  ])('%s: その日の JST 0 時より前', async (_label, day, lt) => {
    await idsOf(`?last_login_before=${day}`);
    expect(fake.filters).toEqual([{ kind: 'lt', column: 'last_login_at', value: lt }]);
  });
});

describe('GET /api/admin/users: 実在しない日付・形の違う日付は DB に触れる前に 400 (#1433)', () => {
  it.each([
    ['registered_from', '2026-02-30'],
    ['registered_to', '2026-13-01'],
    ['last_login_before', '2027-02-29'], // 平年の 2/29
    ['registered_from', '2026-10-10T00:00:00Z'], // 日時は受けない (§4 は date)
    ['registered_to', '2026/10/10'],
    ['last_login_before', 'yesterday'],
    // 実在するが、受け付ける範囲 (0101-01-02〜9998-12-30) の外。以前の実装では registered_to=9999-12-31 が
    // 翌日の JST 0 時を求めるところ (addDaysToDate が "+010000-01" を返す) で RangeError になり 500 だった
    ['registered_to', '9999-12-31'],
    ['registered_to', '9998-12-31'], // 受け付ける最後の日の翌日
    ['registered_from', '9999-12-31'],
    ['registered_from', '0100-01-01'],
    ['last_login_before', '9999-12-31'],
    ['last_login_before', '0101-01-01'], // 受け付ける最初の日の前日
  ])('%s=%s は 400 VALIDATION_ERROR', async (name, value) => {
    const res = await GET(new Request(`http://localhost/api/admin/users?${name}=${encodeURIComponent(value)}`));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; details: { fieldErrors: Record<string, unknown> } } };
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(json.error.details.fieldErrors)).toEqual([name]);
    expect(fake.wasTouched()).toBe(false);
  });
});

describe('GET /api/admin/users: 受け付ける範囲の端 (0101-01-02 / 9998-12-30) の日付は 200 で絞る (#1433)', () => {
  it('registered_from=0101-01-02&registered_to=9998-12-30 は、FROM の JST 0 時 〜 TO の翌日 (9998-12-31) の JST 0 時', async () => {
    const ids = await idsOf('?registered_from=0101-01-02&registered_to=9998-12-30');
    expect(ids).toEqual(REGISTERED_ROWS.map((r) => r.id).sort());
    expect(fake.filters).toEqual([
      { kind: 'gte', column: 'created_at', value: '0101-01-01T15:00:00.000Z' },
      { kind: 'lt', column: 'created_at', value: '9998-12-30T15:00:00.000Z' },
    ]);
  });

  it('last_login_before=9998-12-30 は、その日の JST 0 時より前', async () => {
    useRows(LAST_LOGIN_ROWS);
    const ids = await idsOf('?last_login_before=9998-12-30');
    expect(ids).toEqual(LAST_LOGIN_ROWS.filter((r) => r.last_login_at !== null).map((r) => r.id).sort());
    expect(fake.filters).toEqual([{ kind: 'lt', column: 'last_login_at', value: '9998-12-29T15:00:00.000Z' }]);
  });
});
