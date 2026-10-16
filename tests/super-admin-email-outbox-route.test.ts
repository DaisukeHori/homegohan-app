/**
 * #1708 (#1193) GET /api/super-admin/email-outbox の単体テスト
 *
 * メールの送信待ち (email_outbox) の一覧。正本: docs/design/operator/10-logs-and-mail-retry.md §9.2・§11・§12。次を確かめる。
 *   - 認可: super_admin だけが 200。admin を含むそれ以外は 403、未ログインは 401 で、どちらも service role の client を作らない
 *   - 一覧: 既定は dead を新しい順。宛先はマスクし、件名・本文・宛先の生の値・Idempotency-Key・Resend の ID は返さない
 *     (select にも入れない)。伏せ字の行は recipient '[redacted]' と redacted true
 *   - 絞り込み: status / template。ページ送り: カーソルで全行が 1 回ずつ。limit は 1〜200 に直す
 *   - 入力検証: 不正な値は 400 で、email_outbox に触れない
 *   - エラー: DB の失敗は 500 (時間切れは 504)。中身は画面に出さず記録する。no-store
 *
 * requireRole は本物 (src/lib/auth/helpers.ts) を使い、ログイン中のユーザーと user_profiles の取得だけを差し替える。
 * email_outbox は、絞り込み・並べ替え・or 条件 (カーソル) を実際に評価するフェイクに置き換える。列名はリポジトリの
 * スキーマ (supabase/baseline/prod_schema.sql + migration) に存在するものだけを許す (存在しない列は 42703)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaColumns } from './helpers/schema-checked-supabase';
import { aal2AuthMock } from './helpers/mfa-claims';
import { EMAIL_OUTBOX_REDACTED_EMAIL } from '@/lib/super-admin/email-outbox';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  profile: null as {
    roles: string[] | null;
    organization_id: string | null;
    frozen_at: string | null;
    unban_at: string | null;
  } | null,
  adminClient: null as unknown,
}));
const getSupabaseAdmin = vi.hoisted(() => vi.fn());
const logUserError = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({
  // requireRole が使う、ログイン中の本人の権限の client。user_profiles 以外に触れたら失敗させる
  createClient: () => {
    const getUser = async () =>
      state.user
        ? { data: { user: state.user }, error: null }
        : { data: { user: null }, error: { message: 'Auth session missing!' } };
    return {
      auth: { getUser, ...aal2AuthMock(getUser) },
      from: (table: string) => {
        if (table !== 'user_profiles') throw new Error(`本人の権限の client が ${table} に触れた`);
        const builder = {
          select: () => builder,
          eq: () => builder,
          single: async () =>
            state.profile ? { data: state.profile, error: null } : { data: null, error: { message: 'no rows' } },
        };
        return builder;
      },
    };
  },
  getSupabaseAdmin: () => getSupabaseAdmin(),
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: logError,
    withUser: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logUserError })),
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

const route = await import('@/app/api/super-admin/email-outbox/route');
const { GET } = route;

// ─────────────────────────────────────────────────────────────────────────────
// email_outbox のフェイク (このルートが使う PostgREST の部分だけ)
// ─────────────────────────────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  args: unknown[];
}
interface PgError {
  code: string;
  message: string;
}

/** 日時は PostgreSQL と同じマイクロ秒の精度で比べる (秒 13 桁 + 小数 6 桁の文字列の辞書順) */
function timestampKey(value: unknown): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(String(value));
  if (!match) throw new Error(`フェイク: 日時として読めない値 ${String(value)}`);
  const seconds = Date.parse(`${match[1]}${match[3]}`) / 1000;
  return `${String(seconds).padStart(13, '0')}${(match[2] ?? '').padEnd(6, '0')}`;
}

function compareValues(column: string, actual: unknown, expected: unknown): number | null {
  if (actual === null || actual === undefined || expected === null || expected === undefined) return null;
  const [a, b] = column === 'created_at' ? [timestampKey(actual), timestampKey(expected)] : [String(actual), String(expected)];
  return a < b ? -1 : a > b ? 1 : 0;
}

const OPERATORS: Record<string, (cmp: number) => boolean> = {
  eq: (cmp) => cmp === 0,
  lt: (cmp) => cmp < 0,
  lte: (cmp) => cmp <= 0,
};

interface Condition {
  columns: string[];
  test: (row: Row) => boolean;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function parseCondition(term: string): Condition {
  const group = /^(and|or)\(([\s\S]*)\)$/.exec(term);
  if (group) {
    const children = splitTopLevel(group[2]).map(parseCondition);
    const combine = group[1] === 'and' ? 'every' : 'some';
    return { columns: children.flatMap((c) => c.columns), test: (row) => children[combine]((c) => c.test(row)) };
  }
  const first = term.indexOf('.');
  const second = term.indexOf('.', first + 1);
  const column = term.slice(0, first);
  const predicate = OPERATORS[term.slice(first + 1, second)];
  if (!predicate) throw new Error(`フェイク: 未対応の条件 ${term}`);
  const value = term.slice(second + 1);
  return {
    columns: [column],
    test: (row) => {
      const cmp = compareValues(column, row[column], value);
      return cmp !== null && predicate(cmp);
    },
  };
}

interface FakeOutbox {
  client: { from: (table: string) => unknown };
  rows: Row[];
  queries: RecordedCall[][];
  failNext(error: PgError): void;
}

function createFakeOutbox(seed: Row[]): FakeOutbox {
  const known = schemaColumns('email_outbox');
  const rows = seed.map((row) => ({ ...row }));
  const queries: RecordedCall[][] = [];
  let injected: PgError | null = null;

  const client = {
    from(table: string) {
      if (table !== 'email_outbox') throw new Error(`service role の client が想定外のテーブル ${table} に触れた`);
      const calls: RecordedCall[] = [];
      queries.push(calls);
      const conditions: Condition[] = [];
      const sorts: Array<{ column: string; ascending: boolean }> = [];
      let selected: string[] | null = null;
      let max: number | null = null;
      const record = (method: string, args: unknown[]) => calls.push({ method, args });
      const addComparison = (method: string, column: string, value: unknown) => {
        record(method, [column, value]);
        conditions.push(parseCondition(`${column}.${method}.${String(value)}`));
      };

      function execute(): { data: Row[] | null; error: PgError | null } {
        if (injected) {
          const error = injected;
          injected = null;
          return { data: null, error };
        }
        const used = [...(selected ?? []), ...conditions.flatMap((c) => c.columns), ...sorts.map((s) => s.column)];
        const missing = used.find((column) => !known.includes(column));
        if (missing) return { data: null, error: { code: '42703', message: `column email_outbox.${missing} does not exist` } };
        let result = rows.filter((row) => conditions.every((c) => c.test(row)));
        result = [...result].sort((a, b) => {
          for (const { column, ascending } of sorts) {
            const cmp = compareValues(column, a[column], b[column]) ?? 0;
            if (cmp !== 0) return ascending ? cmp : -cmp;
          }
          return 0;
        });
        if (max !== null) result = result.slice(0, max);
        const columns = selected ?? known;
        return { data: result.map((row) => structuredClone(Object.fromEntries(columns.map((c) => [c, row[c] ?? null])))), error: null };
      }

      const builder = {
        select(list: string) {
          record('select', [list]);
          selected = list.split(',').map((s) => s.trim());
          return builder;
        },
        eq: (column: string, value: unknown) => (addComparison('eq', column, value), builder),
        lte: (column: string, value: unknown) => (addComparison('lte', column, value), builder),
        or(filters: string) {
          record('or', [filters]);
          conditions.push(parseCondition(`or(${filters})`));
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          record('order', [column, options]);
          sorts.push({ column, ascending: options?.ascending ?? true });
          return builder;
        },
        limit(count: number) {
          record('limit', [count]);
          max = count;
          return builder;
        },
        then<T1, T2>(
          onFulfilled?: ((value: ReturnType<typeof execute>) => T1 | PromiseLike<T1>) | null,
          onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ) {
          return Promise.resolve().then(execute).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };

  return {
    client,
    rows,
    queries,
    failNext(error) {
      injected = error;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 種まきと呼び出しの補助
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_A = '00000000-0000-4000-8000-0000000000b1';
const BASE = Date.parse('2026-10-16T00:00:00.000Z');
const REDACTED = 'redacted@redacted.invalid';

function pgTimestamp(ms: number, micro = 0): string {
  return `${new Date(ms).toISOString().slice(0, 23)}${String(micro).padStart(3, '0')}+00:00`;
}
const outboxId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** i が大きいほど新しく、id も大きい。秘密を含む列 (件名・本文・鍵) に印を入れ、応答に漏れないことを確かめる */
function mail(i: number, overrides: Row = {}): Row {
  const createdAt = pgTimestamp(BASE + i * 60_000);
  return {
    id: outboxId(i),
    created_at: createdAt,
    updated_at: createdAt,
    status: 'dead',
    template: 'family_invite',
    to_email: `taro${i}@example.com`,
    from_email: 'noreply@homegohan.app',
    reply_to: 'support@homegohan.app',
    subject: `SECRET-SUBJECT-${i}`,
    text_body: `SECRET-BODY-${i} https://homegohan.app/invite?token=SECRET-TOKEN-${i}`,
    html_body: `<p>SECRET-HTML-${i}</p>`,
    user_id: null,
    idempotency_key: `SECRET-IDEMPOTENCY-${i}`,
    redact_after_send: false,
    attempts: 1,
    requeue_count: 0,
    next_attempt_at: createdAt,
    lease_expires_at: null,
    worker_id: null,
    last_error_code: 'validation_error',
    last_error_message: 'The domain is not verified',
    last_status_code: 403,
    sent_at: null,
    resend_message_id: `SECRET-RESEND-${i}`,
    dead_at: createdAt,
    requeued_at: null,
    dead_alerted_at: null,
    ...overrides,
  };
}

let fake: FakeOutbox;
function seed(rows: Row[]) {
  fake = createFakeOutbox(rows);
  state.adminClient = fake.client;
}

function asUser(roles: string[] | null, extra: Partial<NonNullable<typeof state.profile>> = {}) {
  state.user = { id: ADMIN_ID, email: 'ops@example.com' };
  state.profile = { roles, organization_id: null, frozen_at: null, unban_at: null, ...extra };
}

async function get(query = '') {
  const res = await GET(new Request(`http://localhost/api/super-admin/email-outbox${query}`) as never);
  return { res, json: await res.json() };
}

function indexes(json: { data: Array<{ id: string }> }): number[] {
  return json.data.map((row) => Number(row.id.slice(-12)));
}

const RETURNED_KEYS = [
  'attempts',
  'created_at',
  'dead_at',
  'id',
  'last_error_code',
  'last_error_message',
  'last_status_code',
  'lease_expires_at',
  'next_attempt_at',
  'recipient',
  'redacted',
  'requeue_count',
  'requeued_at',
  'sent_at',
  'status',
  'template',
  'updated_at',
  'user_id',
].sort();

beforeEach(() => {
  vi.clearAllMocks();
  getSupabaseAdmin.mockImplementation(() => state.adminClient);
  asUser(['super_admin']);
  seed([mail(1), mail(2), mail(3)]);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/super-admin/email-outbox: 認可', () => {
  it('未ログインは 401。service role の client を作らず、email_outbox にも触れない', async () => {
    state.user = null;

    const { res, json } = await get();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(fake.queries).toHaveLength(0);
  });

  it.each([
    ['一般ユーザー', ['user']],
    ['admin (super_admin だけに限る)', ['admin']],
    ['support', ['support']],
    ['roles が空', null],
  ])('%s は 403。service role の client を作らず、email_outbox にも触れない', async (_label, roles) => {
    asUser(roles);

    const { res, json } = await get();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(fake.queries).toHaveLength(0);
  });

  it('凍結中の super_admin は 403', async () => {
    asUser(['super_admin'], { frozen_at: '2026-10-01T00:00:00.000Z', unban_at: null });

    expect((await get()).res.status).toBe(403);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('super_admin は 200', async () => {
    expect((await get()).res.status).toBe(200);
  });

  it('入力が不正でも、認可が先 (一般ユーザーは 403)', async () => {
    asUser(['user']);

    expect((await get('?status=bogus')).res.status).toBe(403);
  });
});

describe('GET /api/super-admin/email-outbox: 一覧', () => {
  it('既定は dead を新しい順。続きが無ければ has_more は false / next_cursor は null', async () => {
    fake.rows.push(mail(4, { status: 'queued', dead_at: null, last_error_code: null }));

    const { res, json } = await get();

    expect(res.status).toBe(200);
    expect(indexes(json)).toEqual([3, 2, 1]);
    expect(json.meta).toEqual({ limit: 50, has_more: false, next_cursor: null });
    expect(fake.queries[0].filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([['status', 'dead']]);
  });

  it('宛先はマスクし、件名・本文・宛先の生の値・Idempotency-Key・Resend の ID は返さない', async () => {
    const { json } = await get();

    expect(Object.keys(json.data[0]).sort()).toEqual(RETURNED_KEYS);
    expect(json.data[0].recipient).toBe('t***@example.com');
    expect(json.data[0].redacted).toBe(false);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('taro3@example.com');
  });

  it('select する列に件名・本文・宛先の生の値以外の秘密 (鍵・Resend の ID) を入れない。列は実在する', async () => {
    await get();

    const select = fake.queries[0].find((c) => c.method === 'select')!;
    const selected = (select.args[0] as string).split(',').map((s) => s.trim());
    const real = schemaColumns('email_outbox');
    for (const column of selected) expect(real).toContain(column);
    for (const secret of ['subject', 'text_body', 'html_body', 'idempotency_key', 'resend_message_id', 'reply_to']) {
      expect(selected).not.toContain(secret);
    }
    expect(fake.queries[0].filter((c) => c.method === 'order').map((c) => c.args)).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
  });

  it("伏せ字の行は recipient '[redacted]' と redacted true", async () => {
    expect(EMAIL_OUTBOX_REDACTED_EMAIL).toBe(REDACTED);
    seed([mail(1, { to_email: REDACTED, user_id: null }), mail(2, { user_id: USER_A })]);

    const { json } = await get();

    expect(json.data.map((row: { user_id: string | null }) => row.user_id)).toEqual([USER_A, null]);
    expect(json.data.map((row: { recipient: string; redacted: boolean }) => [row.recipient, row.redacted])).toEqual([
      ['t***@example.com', false],
      ['[redacted]', true],
    ]);
  });

  it('失敗の文面は 200 文字までに切る', async () => {
    seed([mail(1, { last_error_message: 'x'.repeat(500) })]);

    const { json } = await get();

    expect(json.data[0].last_error_message).toHaveLength(200);
  });

  it('行が 1 件も無いときは、空の配列', async () => {
    seed([]);

    const { res, json } = await get();

    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
  });

  it('保存させない (Cache-Control: no-store)。毎回 DB を読む (force-dynamic)。GET だけを公開する', async () => {
    const { res } = await get();

    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(route.dynamic).toBe('force-dynamic');
    expect(Object.keys(route).filter((name) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(name))).toEqual([]);
  });
});

describe('GET /api/super-admin/email-outbox: 絞り込みとページ送り', () => {
  beforeEach(() =>
    seed([
      mail(1),
      mail(2, { template: 'support_ticket_reply' }),
      mail(3, { status: 'queued', dead_at: null, last_error_code: null, last_error_message: null, last_status_code: null }),
      mail(4, { status: 'sent', dead_at: null, sent_at: pgTimestamp(BASE), last_error_code: null }),
      mail(5),
      mail(6, { template: 'support_ticket_reply' }),
      mail(7),
    ]),
  );

  it.each([
    ['status=queued', '?status=queued', [3]],
    ['status=sent', '?status=sent', [4]],
    ['status=dead', '?status=dead', [7, 6, 5, 2, 1]],
    ['template (完全一致)', '?template=support_ticket_reply', [6, 2]],
    ['template は部分一致にしない', '?template=support', []],
    ['status と template の AND', '?status=queued&template=support_ticket_reply', []],
  ])('%s', async (_label, query, expected) => {
    const { res, json } = await get(query);

    expect(res.status).toBe(200);
    expect(indexes(json)).toEqual(expected);
  });

  it('前後の空白は取り除き、空文字は指定なし (既定の dead)', async () => {
    const { json } = await get('?status=%20&template=%20support_ticket_reply%20');

    expect(indexes(json)).toEqual([6, 2]);
  });

  it('カーソルで最後まで読むと、全行が重複も欠落もなく新しい順に 1 回ずつ出る。DB には limit + 1 件を頼む', async () => {
    const pages: number[][] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const { json } = await get(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      pages.push(indexes(json));
      cursor = json.meta.next_cursor;
      if (!cursor) break;
    }

    expect(pages).toEqual([[7, 6], [5, 2], [1]]);
    expect(fake.queries[0].find((c) => c.method === 'limit')!.args).toEqual([3]);
    const second = fake.queries[1];
    expect(second.filter((c) => c.method === 'lte').map((c) => c.args[0])).toEqual(['created_at']);
    expect(second.filter((c) => c.method === 'or')).toHaveLength(1);
  });

  it('同じ時刻の行が limit をまたいでも、飛ばさず重複もしない (id の大きい順)', async () => {
    const same = pgTimestamp(BASE, 123);
    seed([mail(1, { created_at: same }), mail(2, { created_at: same }), mail(3, { created_at: same })]);

    const first = await get('?limit=2');
    const next = await get(`?limit=2&cursor=${encodeURIComponent(first.json.meta.next_cursor)}`);

    expect([...indexes(first.json), ...indexes(next.json)]).toEqual([3, 2, 1]);
  });

  it('limit の範囲: 最大 200。0 以下は 1、数字でなければ既定の 50', async () => {
    for (const [raw, expected] of [
      ['1000', 200],
      ['0', 1],
      ['abc', 50],
    ] as const) {
      const { json } = await get(`?limit=${raw}`);
      expect(json.meta.limit, raw).toBe(expected);
    }
  });
});

describe('GET /api/super-admin/email-outbox: 入力検証 (400。email_outbox には触れない)', () => {
  it.each([
    ['status が列挙の外', '?status=failed', 'status'],
    ['template が 100 文字超', `?template=${'a'.repeat(101)}`, 'template'],
    ['cursor が壊れている', '?cursor=%21%21', 'cursor'],
  ])('%s', async (_label, query, field) => {
    const { res, json } = await get(query);

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(json.error.details.fieldErrors)).toEqual([field]);
    expect(fake.queries).toHaveLength(0);
  });
});

describe('GET /api/super-admin/email-outbox: エラー', () => {
  it('DB の失敗は 500。エラー文は画面に出さず、原因と条件を記録する', async () => {
    fake.failNext({ code: '42P01', message: 'relation "public.email_outbox" does not exist' });

    const { res, json } = await get('?status=queued');

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('relation');
    expect(logUserError).toHaveBeenCalledWith(
      'メールの送信待ちの取得に失敗',
      expect.any(Error),
      expect.objectContaining({ pg_code: '42P01', status: 'queued' }),
    );
  });

  it('DB の時間切れ (57014) は 504', async () => {
    fake.failNext({ code: '57014', message: 'canceling statement due to statement timeout' });

    const { res, json } = await get();

    expect(res.status).toBe(504);
    expect(json.error.code).toBe('QUERY_TIMEOUT');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('DB が返した行の形が想定と違えば、黙って返さずに 500 にして記録する', async () => {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'lte', 'or', 'order', 'limit']) builder[method] = () => builder;
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [{ id: 'not-a-uuid', status: 'dead' }], error: null }).then(resolve);
    state.adminClient = { from: () => builder };

    const { res, json } = await get();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(logUserError).toHaveBeenCalled();
  });

  it('service role の client を作れないときは 500。中身は出さず記録する', async () => {
    const boom = new Error('Supabase admin env is missing (SUPABASE_SERVICE_ROLE_KEY)');
    getSupabaseAdmin.mockImplementation(() => {
      throw boom;
    });

    const { res, json } = await get();

    expect(res.status).toBe(500);
    expect(JSON.stringify(json)).not.toContain('SERVICE_ROLE');
    expect(logError).toHaveBeenCalledWith(expect.any(String), boom);
  });
});

