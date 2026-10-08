/**
 * #1306: GET / DELETE /api/super-admin/exports/[id] の回帰テスト
 *
 * エクスポートは gdpr_deletion_requests を代用しているが、このテーブルに status / created_at 列は無い
 * (状態は cancelled_at / executed_at、作成日時は requested_at)。
 * 修正前の DELETE は存在しない status を select しており、本番では PostgREST が 42703 で失敗し、
 * error を見ていなかったので、どの id でも 404 になっていた (キャンセルは一度も成功しなかった)。
 * GET は select('*') だったので失敗はせず、status は常に pending、created_at は欠けた形で返っていた。
 * 単体テストは Supabase をモックして列の有無を見ないため、検出できなかった。
 *
 * ここでは本番スキーマ (supabase/baseline/prod_schema.sql に新しい migration を重ねたもの) の列を知っているフェイク
 * (tests/helpers/schema-checked-supabase.ts) を使い、存在しない列を読むと失敗する状態で確かめる。
 * 実 DB での確認は tests/integration/security/super-admin-columns.test.ts と select-columns-exist.test.ts。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { deriveExportStatus } from '@/lib/super-admin/exports-schemas';
import {
  createSchemaCheckedDb,
  pgError,
  schemaColumns,
  type SchemaCheckedDb,
} from './helpers/schema-checked-supabase';

const state = vi.hoisted(() => ({ supabase: null as unknown }));
const requireRole = vi.hoisted(() => vi.fn());
/** createLogger(...).withUser(user.id).error の呼び出し (DB エラーの記録) */
const logUserError = vi.hoisted(() => vi.fn());
/** createLogger(...).error の呼び出し (想定外の例外の記録) */
const logError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth/helpers', () => ({ requireRole }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => state.supabase,
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

import { DELETE, GET } from '../src/app/api/super-admin/exports/[id]/route';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const SUBJECT_ID = '00000000-0000-4000-8000-0000000000b1';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTED_AT = '2026-10-01T00:00:00+00:00';

function gdprRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    user_id: SUBJECT_ID,
    requested_at: REQUESTED_AT,
    cooling_until: '2026-10-31T00:00:00+00:00',
    cancelled_at: null,
    executed_at: null,
    certificate_url: null,
    executed_by: null,
    notes: null,
    ...overrides,
  };
}

let db: SchemaCheckedDb;

function setup(rows: Array<Record<string, unknown>> = [gdprRow()]) {
  db = createSchemaCheckedDb({ gdpr_deletion_requests: rows, admin_audit_logs: [] });
  state.supabase = db.supabase;
}

const request = (method: 'GET' | 'DELETE', headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/super-admin/exports/${REQUEST_ID}`, { method, headers }) as never;
const context = (id: string) => ({ params: { id } });

const gdprRows = () => db.tables.gdpr_deletion_requests;

/**
 * logger に渡された Error を取り出す。
 * postgrest-js の error は Error ではない素のオブジェクトで、そのまま渡すと db-logger が
 * app_logs.error_message に String(error) = '[object Object]' を書く。そのため message を持つ Error に包んで渡す。
 */
const loggedError = (mock: ReturnType<typeof vi.fn>, call = 0) => mock.mock.calls[call][1];

beforeEach(() => {
  vi.clearAllMocks();
  requireRole.mockResolvedValue({ id: ADMIN_ID, roles: ['super_admin'] });
  setup();
});

describe('deriveExportStatus: gdpr_deletion_requests の列から状態を導く', () => {
  it('どちらも空なら pending', () => {
    expect(deriveExportStatus({ cancelled_at: null, executed_at: null })).toBe('pending');
  });

  it('cancelled_at があれば cancelled', () => {
    expect(deriveExportStatus({ cancelled_at: '2026-10-02T00:00:00Z', executed_at: null })).toBe('cancelled');
  });

  it('executed_at があれば completed', () => {
    expect(deriveExportStatus({ cancelled_at: null, executed_at: '2026-10-31T00:00:00Z' })).toBe('completed');
  });

  it('両方あれば実行済みを優先する (実行は取り消せない)', () => {
    expect(
      deriveExportStatus({ cancelled_at: '2026-10-02T00:00:00Z', executed_at: '2026-10-31T00:00:00Z' }),
    ).toBe('completed');
  });
});

describe('GET /api/super-admin/exports/[id]', () => {
  it('未キャンセル・未実行の要求は pending で返す。画面が読む項目 (種別・形式・依頼者・依頼日) がそろっている', async () => {
    const res = await GET(request('GET'), context(REQUEST_ID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: REQUEST_ID,
        export_type: 'gdpr',
        format: 'csv',
        status: 'pending',
        requested_by: SUBJECT_ID,
        created_at: REQUESTED_AT,
        file_url: null,
      },
    });
    expect(requireRole).toHaveBeenCalledWith(['super_admin']);
  });

  it('select する列は、すべて本番スキーマの gdpr_deletion_requests に存在する (status を読まない)', async () => {
    await GET(request('GET'), context(REQUEST_ID));

    const select = db.calls.find((c) => c.table === 'gdpr_deletion_requests' && c.op === 'select');
    expect(select).toBeDefined();
    const selected = select!.columns!.split(',').map((s) => s.trim());
    expect(selected).not.toContain('status');
    const real = schemaColumns('gdpr_deletion_requests');
    for (const name of selected) {
      expect(real).toContain(name);
    }
  });

  it('cancelled_at があれば cancelled', async () => {
    setup([gdprRow({ cancelled_at: '2026-10-02T00:00:00+00:00' })]);

    const res = await GET(request('GET'), context(REQUEST_ID));

    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('cancelled');
  });

  it('executed_at があれば completed', async () => {
    setup([gdprRow({ executed_at: '2026-10-31T00:00:00+00:00' })]);

    const res = await GET(request('GET'), context(REQUEST_ID));

    expect((await res.json()).data.status).toBe('completed');
  });

  it('存在しない id は 404。DB のエラーとして記録しない', async () => {
    const res = await GET(request('GET'), context('22222222-2222-4222-8222-222222222222'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(logUserError).not.toHaveBeenCalled();
  });

  it('UUID の形でない id は、DB に問い合わせず 404', async () => {
    const res = await GET(request('GET'), context('not-a-uuid'));

    expect(res.status).toBe(404);
    expect(db.calls).toHaveLength(0);
  });

  it('DB のエラーを「見つからない」にせず 500 で返し、原因を記録する (エラー文は画面に出さない)', async () => {
    const error = pgError('XX000', 'connection to server was lost');
    db.failNext('gdpr_deletion_requests', 'select', error);

    const res = await GET(request('GET'), context(REQUEST_ID));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('connection to server was lost');
    expect(logUserError).toHaveBeenCalledWith('エクスポートの取得に失敗', expect.any(Error), {
      exportId: REQUEST_ID,
      pg_code: 'XX000',
    });
    // app_logs.error_message が '[object Object]' にならず、DB の message が読める
    expect(loggedError(logUserError)).toBeInstanceOf(Error);
    expect(loggedError(logUserError)).toHaveProperty('message', 'connection to server was lost');
  });

  it('未認証は 401、権限が無ければ 403。DB には触れない', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await GET(request('GET'), context(REQUEST_ID))).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    expect((await GET(request('GET'), context(REQUEST_ID))).status).toBe(403);

    expect(db.calls).toHaveLength(0);
  });

  it('想定外の例外は 500 にして記録する (例外の文は画面に出さない)', async () => {
    const boom = new Error('boom: internal detail');
    requireRole.mockRejectedValueOnce(boom);

    const res = await GET(request('GET'), context(REQUEST_ID));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('internal detail');
    expect(logError).toHaveBeenCalledWith(expect.any(String), boom);
  });
});

describe('DELETE /api/super-admin/exports/[id]', () => {
  it('実行前の要求をキャンセルする: cancelled_at だけを更新し、監査ログを残す。その後の状態は cancelled', async () => {
    const before = Date.now();
    const res = await DELETE(
      request('DELETE', { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'vitest-agent' }),
      context(REQUEST_ID),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: REQUEST_ID, deleted: true } });

    const row = gdprRows()[0];
    expect(typeof row.cancelled_at).toBe('string');
    expect(Date.parse(row.cancelled_at as string)).toBeGreaterThanOrEqual(before);
    expect(row.executed_at).toBeNull();

    // 存在しない status を更新しない。更新するのは cancelled_at だけ
    const update = db.calls.find((c) => c.op === 'update')!;
    expect(Object.keys(update.payload!)).toEqual(['cancelled_at']);

    expect(db.tables.admin_audit_logs).toEqual([
      expect.objectContaining({
        actor_id: ADMIN_ID,
        action_type: 'admin.export.request',
        target_type: 'export',
        target_id: REQUEST_ID,
        details: { action: 'cancel', subject_user_id: SUBJECT_ID },
        severity: 'info',
        // 共通の監査ヘルパー (recordAdminAudit) が、操作元の IP と User-Agent も残す
        ip_address: '203.0.113.9',
        user_agent: 'vitest-agent',
      }),
    ]);

    const after = await GET(request('GET'), context(REQUEST_ID));
    expect((await after.json()).data.status).toBe('cancelled');
  });

  it('状態の確認と同じ条件 (id・未キャンセル・未実行) を更新にも付ける', async () => {
    await DELETE(request('DELETE'), context(REQUEST_ID));

    const update = db.calls.find((c) => c.op === 'update')!;
    expect(update.filters).toEqual([
      { kind: 'eq', column: 'id', value: REQUEST_ID },
      { kind: 'is', column: 'cancelled_at', value: null },
      { kind: 'is', column: 'executed_at', value: null },
    ]);
  });

  it('実行済み (executed_at あり) の要求は 422 でキャンセルできない。何も変えず、監査ログも残さない', async () => {
    setup([gdprRow({ executed_at: '2026-10-31T00:00:00+00:00' })]);

    const res = await DELETE(request('DELETE'), context(REQUEST_ID));

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    expect(gdprRows()[0].cancelled_at).toBeNull();
    expect(db.calls.some((c) => c.op === 'update')).toBe(false);
    expect(db.tables.admin_audit_logs).toHaveLength(0);
  });

  it('すでにキャンセル済みなら 200 で何もしない (cancelled_at を上書きせず、監査ログも重ねない)', async () => {
    setup([gdprRow({ cancelled_at: '2026-10-02T00:00:00+00:00' })]);

    const res = await DELETE(request('DELETE'), context(REQUEST_ID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: REQUEST_ID, deleted: true } });
    expect(gdprRows()[0].cancelled_at).toBe('2026-10-02T00:00:00+00:00');
    expect(db.calls.some((c) => c.op === 'update')).toBe(false);
    expect(db.tables.admin_audit_logs).toHaveLength(0);
  });

  it('確認のあと更新までの間にバッチが実行した場合は 409。実行済みの行を上書きせず、監査ログも残さない', async () => {
    db.beforeNext('gdpr_deletion_requests', 'update', () => {
      gdprRows()[0].executed_at = '2026-10-31T00:00:00+00:00';
    });

    const res = await DELETE(request('DELETE'), context(REQUEST_ID));

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('CONFLICT_STALE_DATA');
    expect(gdprRows()[0].cancelled_at).toBeNull();
    expect(gdprRows()[0].executed_at).toBe('2026-10-31T00:00:00+00:00');
    expect(db.tables.admin_audit_logs).toHaveLength(0);
  });

  it('存在しない id は 404', async () => {
    const res = await DELETE(request('DELETE'), context('22222222-2222-4222-8222-222222222222'));

    expect(res.status).toBe(404);
    expect(db.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('UUID の形でない id は、DB に問い合わせず 404', async () => {
    const res = await DELETE(request('DELETE'), context('not-a-uuid'));

    expect(res.status).toBe(404);
    expect(db.calls).toHaveLength(0);
  });

  it('対象の取得に失敗したら、404 にせず 500 で返し、記録する。更新はしない', async () => {
    const error = pgError('XX000', 'connection to server was lost');
    db.failNext('gdpr_deletion_requests', 'select', error);

    const res = await DELETE(request('DELETE'), context(REQUEST_ID));

    expect(res.status).toBe(500);
    expect(logUserError).toHaveBeenCalledWith('キャンセル対象のエクスポートの取得に失敗', expect.any(Error), {
      exportId: REQUEST_ID,
      pg_code: 'XX000',
    });
    expect(loggedError(logUserError)).toBeInstanceOf(Error);
    expect(loggedError(logUserError)).toHaveProperty('message', 'connection to server was lost');
    expect(db.calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('更新に失敗したら 500 で返し、記録する。監査ログは残さない', async () => {
    const error = pgError('XX000', 'could not serialize access');
    db.failNext('gdpr_deletion_requests', 'update', error);

    const res = await DELETE(request('DELETE'), context(REQUEST_ID));

    expect(res.status).toBe(500);
    expect(logUserError).toHaveBeenCalledWith('エクスポートのキャンセルに失敗', expect.any(Error), {
      exportId: REQUEST_ID,
      pg_code: 'XX000',
    });
    expect(loggedError(logUserError)).toBeInstanceOf(Error);
    expect(loggedError(logUserError)).toHaveProperty('message', 'could not serialize access');
    expect(gdprRows()[0].cancelled_at).toBeNull();
    expect(db.tables.admin_audit_logs).toHaveLength(0);
  });

  it('監査ログの記録に失敗しても、済んだキャンセルは成功として返し、失敗を記録する', async () => {
    const error = pgError('42501', 'new row violates row-level security policy');
    db.failNext('admin_audit_logs', 'insert', error);

    const res = await DELETE(request('DELETE'), context(REQUEST_ID));

    expect(res.status).toBe(200);
    expect(gdprRows()[0].cancelled_at).not.toBeNull();
    // recordAdminAudit が db-logger (app_logs) に error として残す
    expect(logError).toHaveBeenCalledWith(
      '監査ログ (admin_audit_logs) への記録に失敗しました',
      expect.any(Error),
      expect.objectContaining({
        action_type: 'admin.export.request',
        actor_id: ADMIN_ID,
        target_id: REQUEST_ID,
        error_code: '42501',
      }),
    );
  });

  it('未認証は 401、権限が無ければ 403。DB には触れない', async () => {
    requireRole.mockRejectedValueOnce(new AuthError('AUTH_UNAUTHENTICATED'));
    expect((await DELETE(request('DELETE'), context(REQUEST_ID))).status).toBe(401);

    requireRole.mockRejectedValueOnce(new ForbiddenError('PERM_DENIED', 'Requires one of: super_admin'));
    expect((await DELETE(request('DELETE'), context(REQUEST_ID))).status).toBe(403);

    expect(db.calls).toHaveLength(0);
  });
});
