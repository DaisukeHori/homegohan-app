/**
 * #1178 service.ts の単体テスト用の、data_subject_requests の簡易 PostgREST (supabase-js のクエリビルダーの再現)。
 *
 * 行の配列を持ち、コードが付けた絞り込み (.eq / .in / .lt) を実際に適用する。絞り込みを付け忘れると他人の行が返り、
 * 条件つき UPDATE の条件が欠けると「判定の後に変わった行」を上書きしてしまうことを、テストで再現できる。
 *
 * 再現する範囲 (service.ts が使う部分だけ):
 *   - select(columns, { count: 'exact' }) / eq / in / lt / order(column, { ascending, nullsFirst }) / range / limit
 *   - maybeSingle / single / await (配列)
 *   - insert(row).select(columns).single()  部分一意索引 data_subject_requests_one_open_per_type (23505) を再現
 *   - update(patch).<絞り込み>.select(columns).maybeSingle()  updated_at はトリガーと同じく書くたびに進む
 *   - 件数より後ろのページの 416 (PGRST103)
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DSR_OPEN_STATUSES } from '@/lib/data-subject-requests/core';

export type FakeRow = Record<string, unknown>;
type Action = 'select' | 'insert' | 'update';

export interface FakeFilter {
  kind: 'eq' | 'in' | 'lt';
  column: string;
  value: unknown;
}

export interface FakeCall {
  client: string;
  table: string;
  action: Action;
  columns: string | null;
  count: boolean;
  filters: FakeFilter[];
  orders: Array<{ column: string; ascending: boolean; nullsFirst: boolean | undefined }>;
  range: [number, number] | null;
  limit: number | null;
  payload: FakeRow | null;
}

interface FakeError {
  code: string;
  message: string;
}

interface FakeResult {
  data: unknown;
  error: FakeError | null;
  count: number | null;
  status: number;
}

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_RANGE_NOT_SATISFIABLE = 416;
const HTTP_CONFLICT = 409;
const HTTP_NOT_ACCEPTABLE = 406;
const HTTP_BAD_REQUEST = 400;
/** 時刻を 1 回進める幅 (ミリ秒)。書くたびに updated_at が別の値になるようにする */
const CLOCK_STEP_MS = 1000;

function columnsOf(list: string): string[] {
  return list.split(',').map((c) => c.trim()).filter(Boolean);
}

function project(row: FakeRow, columns: string | null): FakeRow {
  if (!columns || columns.trim() === '*') return { ...row };
  const out: FakeRow = {};
  for (const column of columnsOf(columns)) {
    if (!(column in row)) throw new Error(`fake-dsr-db: unknown column ${column}`);
    out[column] = row[column];
  }
  return out;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  return String(a) < String(b) ? -1 : 1;
}

export class FakeDsrDb {
  rows: FakeRow[] = [];
  calls: FakeCall[] = [];
  /** 次の 1 回だけ、その操作をエラーにする */
  failNext: Partial<Record<Action, FakeError & { status?: number }>> = {};
  /** UPDATE を実行する直前に 1 回だけ呼ぶ (判定と書き込みの間に別の操作が入った状況の再現) */
  beforeUpdate: (() => void) | null = null;
  private clock = Date.parse('2026-10-16T00:00:00.000Z');

  tick(): string {
    this.clock += CLOCK_STEP_MS;
    return new Date(this.clock).toISOString();
  }

  /** 完全な 1 行を足す (既定値は pending_verification の請求) */
  seed(overrides: FakeRow = {}): FakeRow {
    const at = this.tick();
    const row: FakeRow = {
      id: randomUUID(),
      user_id: randomUUID(),
      request_type: 'disclosure',
      status: 'pending_verification',
      details: '請求の内容',
      verification_method: 'email_link',
      verification_token_hash: null,
      verification_sent_at: at,
      verification_expires_at: at,
      verification_send_count: 1,
      verified_at: null,
      due_at: null,
      response_note: null,
      admin_notes: null,
      resolved_at: null,
      created_at: at,
      updated_at: at,
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  find(id: unknown): FakeRow | undefined {
    return this.rows.find((r) => r.id === id);
  }

  client(name: string): SupabaseClient {
    const from = (table: string) => new FakeBuilder(this, name, table);
    return { from } as unknown as SupabaseClient;
  }

  callsOf(action: Action, client?: string): FakeCall[] {
    return this.calls.filter((c) => c.action === action && (client === undefined || c.client === client));
  }

  execute(call: FakeCall, mode: 'many' | 'maybeSingle' | 'single'): FakeResult {
    this.calls.push(call);
    const injected = this.failNext[call.action];
    if (injected) {
      delete this.failNext[call.action];
      return { data: null, error: { code: injected.code, message: injected.message }, count: null, status: injected.status ?? HTTP_BAD_REQUEST };
    }
    if (call.action === 'insert') return this.executeInsert(call, mode);
    if (call.action === 'update') return this.executeUpdate(call, mode);
    return this.executeSelect(call, mode);
  }

  private matches(row: FakeRow, filters: FakeFilter[]): boolean {
    return filters.every((f) => {
      const v = row[f.column];
      if (f.kind === 'eq') return v === f.value;
      if (f.kind === 'in') return (f.value as unknown[]).includes(v);
      return v !== null && v !== undefined && compare(v, f.value) < 0;
    });
  }

  private shape(rows: FakeRow[], call: FakeCall, mode: 'many' | 'maybeSingle' | 'single', okStatus: number): FakeResult {
    const projected = rows.map((r) => project(r, call.columns));
    if (mode === 'many') return { data: projected, error: null, count: null, status: okStatus };
    if (projected.length > 1) {
      return { data: null, error: { code: 'PGRST116', message: 'multiple rows' }, count: null, status: HTTP_NOT_ACCEPTABLE };
    }
    if (projected.length === 0 && mode === 'single') {
      return { data: null, error: { code: 'PGRST116', message: 'no rows' }, count: null, status: HTTP_NOT_ACCEPTABLE };
    }
    return { data: projected[0] ?? null, error: null, count: null, status: okStatus };
  }

  private executeSelect(call: FakeCall, mode: 'many' | 'maybeSingle' | 'single'): FakeResult {
    let rows = this.rows.filter((r) => this.matches(r, call.filters));
    const total = rows.length;
    rows = [...rows].sort((a, b) => {
      for (const order of call.orders) {
        const av = a[order.column];
        const bv = b[order.column];
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        if (aNull || bNull) {
          if (aNull && bNull) continue;
          // PostgREST の既定: 昇順は NULL が最後・降順は NULL が最初 (nullsFirst で上書き)
          const nullsFirst = order.nullsFirst ?? !order.ascending;
          return aNull === nullsFirst ? -1 : 1;
        }
        const c = compare(av, bv);
        if (c !== 0) return order.ascending ? c : -c;
      }
      return 0;
    });
    if (call.range) {
      const [from, to] = call.range;
      if (from > 0 && from >= total) {
        return {
          data: null,
          error: { code: 'PGRST103', message: 'Requested range not satisfiable' },
          count: null,
          status: HTTP_RANGE_NOT_SATISFIABLE,
        };
      }
      rows = rows.slice(from, to + 1);
    }
    if (call.limit !== null) rows = rows.slice(0, call.limit);
    const result = this.shape(rows, call, mode, HTTP_OK);
    return call.count ? { ...result, count: total } : result;
  }

  private executeInsert(call: FakeCall, mode: 'many' | 'maybeSingle' | 'single'): FakeResult {
    const payload = call.payload ?? {};
    const open = DSR_OPEN_STATUSES as ReadonlyArray<unknown>;
    const status = payload.status ?? 'pending_verification';
    const conflict =
      payload.user_id !== null &&
      open.includes(status) &&
      this.rows.some(
        (r) => r.user_id === payload.user_id && r.request_type === payload.request_type && open.includes(r.status),
      );
    if (conflict) {
      return {
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "data_subject_requests_one_open_per_type"' },
        count: null,
        status: HTTP_CONFLICT,
      };
    }
    const row = this.seed({ verification_sent_at: null, verification_expires_at: null, verification_send_count: 0, ...payload });
    return this.shape([row], call, mode, HTTP_CREATED);
  }

  private executeUpdate(call: FakeCall, mode: 'many' | 'maybeSingle' | 'single'): FakeResult {
    const hook = this.beforeUpdate;
    this.beforeUpdate = null;
    hook?.();
    const targets = this.rows.filter((r) => this.matches(r, call.filters));
    const updatedAt = this.tick();
    for (const row of targets) Object.assign(row, call.payload ?? {}, { updated_at: updatedAt });
    return this.shape(targets, call, mode, HTTP_OK);
  }
}

class FakeBuilder implements PromiseLike<FakeResult> {
  private call: FakeCall;

  constructor(
    private readonly db: FakeDsrDb,
    client: string,
    table: string,
  ) {
    this.call = {
      client,
      table,
      action: 'select',
      columns: null,
      count: false,
      filters: [],
      orders: [],
      range: null,
      limit: null,
      payload: null,
    };
  }

  select(columns: string, options?: { count?: string }): this {
    this.call.columns = columns;
    if (options?.count === 'exact') this.call.count = true;
    return this;
  }

  insert(payload: FakeRow): this {
    this.call.action = 'insert';
    this.call.payload = payload;
    return this;
  }

  update(payload: FakeRow): this {
    this.call.action = 'update';
    this.call.payload = payload;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.call.filters.push({ kind: 'eq', column, value });
    return this;
  }

  in(column: string, value: unknown[]): this {
    this.call.filters.push({ kind: 'in', column, value: [...value] });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.call.filters.push({ kind: 'lt', column, value });
    return this;
  }

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.call.orders.push({ column, ascending: options?.ascending ?? true, nullsFirst: options?.nullsFirst });
    return this;
  }

  range(from: number, to: number): this {
    this.call.range = [from, to];
    return this;
  }

  limit(n: number): this {
    this.call.limit = n;
    return this;
  }

  maybeSingle(): Promise<FakeResult> {
    return Promise.resolve(this.db.execute(this.call, 'maybeSingle'));
  }

  single(): Promise<FakeResult> {
    return Promise.resolve(this.db.execute(this.call, 'single'));
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.db.execute(this.call, 'many')).then(onfulfilled, onrejected);
  }
}
