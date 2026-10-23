// @vitest-environment node
/**
 * 運営 (/api/admin/**) と問い合わせ・サポート (/api/support/**) の API の失敗の本文が日本語の固定の文であることの回帰テスト (#1917)
 *
 * 以前は次のようになっていた:
 *  - 401 / 403 の本文に例外の文面 (err.message) をそのまま入れていた。requireRole が投げる ForbiddenError の文面は英語
 *    ('Requires one of: admin, super_admin')、AuthError の文面は code ('AUTH_UNAUTHENTICATED') なので、画面に英語が出た
 *  - 500 の本文が 'Internal server error'、404 が 'Lead not found' / 'Ticket not found' / 'User not found'、
 *    400 が 'Invalid JSON' / 'Note content is required' (英語)
 *  - 営業・問い合わせの 400 VALIDATION_ERROR は message に検証の結果のオブジェクトを入れていた
 *    (画面は `new Error(json.error?.message)` で文として出すので '[object Object]' になった)
 *  - カタログの取り込みの失敗の本文は `{ error: 'invalid_source', message }` で、error に英字の code が入っていた
 *
 * 直したあとの不変条件:
 *  - 本文の文は日本語の固定の文。例外の文面・DB の生の文面は本文に入らない
 *  - 本文の形 (flat / nested) と code は従来のまま (営業・問い合わせ = 401 は例外の code・403 は OP_PERMISSION_DENIED、
 *    会計 = 401 は UNAUTHENTICATED・403 は OP_PERMISSION_DENIED、/api/support = flat)。
 *    カタログの取り込みだけは、同じ route の 401 / 403 と同じ nested の形にした (code は従来の値)
 *
 * 走査 (tests/api-error-japanese-scan.test.ts) は本文のリテラルを見る。こちらは route を実際に呼んで、返る本文そのものを見る。
 */
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, ForbiddenError, MfaRequiredError } from '@/lib/auth/errors';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: (...args: unknown[]) => mocks.loggerError(...args),
      withUser: () => logger,
    };
    return logger;
  },
  generateRequestId: () => 'req_test',
}));

// 認可を通らない・入力の検査で止まる経路だけを呼ぶので、DB には届かない (届いたらテストの誤り)
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('DB に届いてはいけない');
  },
  getSupabaseAdmin: () => {
    throw new Error('DB に届いてはいけない');
  },
}));

const salesLeads = await import('@/app/api/admin/sales/leads/route');
const salesLead = await import('@/app/api/admin/sales/leads/[id]/route');
const salesActivities = await import('@/app/api/admin/sales/leads/[id]/activities/route');
const tickets = await import('@/app/api/admin/support/tickets/route');
const ticket = await import('@/app/api/admin/support/tickets/[id]/route');
const ticketMessages = await import('@/app/api/admin/support/tickets/[id]/messages/route');
const ticketAssign = await import('@/app/api/admin/support/tickets/[id]/assign/route');
const financeDashboard = await import('@/app/api/admin/finance/dashboard/route');
const financeExports = await import('@/app/api/admin/finance/exports/route');
const financeInvoices = await import('@/app/api/admin/finance/invoices/route');
const financeInvoice = await import('@/app/api/admin/finance/invoices/[id]/route');
const financeNps = await import('@/app/api/admin/finance/nps/route');
const financeReconciliation = await import('@/app/api/admin/finance/reconciliation/route');
const financeRevenue = await import('@/app/api/admin/finance/revenue/route');
const supportStats = await import('@/app/api/support/stats/route');
const supportUser = await import('@/app/api/support/users/[id]/route');
const supportNotes = await import('@/app/api/support/users/[id]/notes/route');
const catalogImport = await import('@/app/api/admin/catalog/import/route');

const ID = '00000000-0000-4000-8000-000000000001';
const BASE = 'http://localhost';
/** 例外の文面 (英語・DB の生の文面)。どれも本文に出てはいけない */
const FORBIDDEN_RAW = 'Requires one of: admin, super_admin';
const UNEXPECTED_RAW = 'relation "sales_leads" does not exist';

const LOGIN_REQUIRED = 'ログインが必要です';
const NO_PERMISSION = 'この操作を行う権限がありません';
const INTERNAL = '処理中にエラーが発生しました';

function get(path: string): NextRequest {
  return new NextRequest(`${BASE}${path}`);
}

function send(method: 'POST' | 'PATCH', path: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const withId = () => ({ params: Promise.resolve({ id: ID }) });

type Call = () => Promise<Response | NextResponse>;

/** 営業・問い合わせの形 (401 = 例外の code・403 = OP_PERMISSION_DENIED) の handler */
const ERROR_CODE_FAMILY: ReadonlyArray<[string, Call]> = [
  ['GET /api/admin/sales/leads', () => salesLeads.GET(get('/api/admin/sales/leads'))],
  ['POST /api/admin/sales/leads', () => salesLeads.POST(send('POST', '/api/admin/sales/leads', { company_name: '株式会社テスト' }))],
  ['GET /api/admin/sales/leads/[id]', () => salesLead.GET(get(`/api/admin/sales/leads/${ID}`), withId())],
  ['PATCH /api/admin/sales/leads/[id]', () => salesLead.PATCH(send('PATCH', `/api/admin/sales/leads/${ID}`, { stage: 'proposal' }), withId())],
  ['GET /api/admin/sales/leads/[id]/activities', () => salesActivities.GET(get(`/api/admin/sales/leads/${ID}/activities`), withId())],
  [
    'POST /api/admin/sales/leads/[id]/activities',
    () => salesActivities.POST(send('POST', `/api/admin/sales/leads/${ID}/activities`, { activity_type: 'note', content: 'メモ' }), withId()),
  ],
  ['GET /api/admin/support/tickets', () => tickets.GET(get('/api/admin/support/tickets'))],
  ['POST /api/admin/support/tickets', () => tickets.POST(send('POST', '/api/admin/support/tickets', { subject: '件名' }))],
  ['GET /api/admin/support/tickets/[id]', () => ticket.GET(get(`/api/admin/support/tickets/${ID}`), withId())],
  ['PATCH /api/admin/support/tickets/[id]', () => ticket.PATCH(send('PATCH', `/api/admin/support/tickets/${ID}`, { status: 'resolved' }), withId())],
  ['GET /api/admin/support/tickets/[id]/messages', () => ticketMessages.GET(get(`/api/admin/support/tickets/${ID}/messages`), withId())],
  [
    'POST /api/admin/support/tickets/[id]/messages',
    () => ticketMessages.POST(send('POST', `/api/admin/support/tickets/${ID}/messages`, { body: '返信' }), withId()),
  ],
  [
    'POST /api/admin/support/tickets/[id]/assign',
    () => ticketAssign.POST(send('POST', `/api/admin/support/tickets/${ID}/assign`, { assignee_id: ID }), withId()),
  ],
];

/** 会計の形 (401 = UNAUTHENTICATED・403 = OP_PERMISSION_DENIED) の handler (catch で認可の失敗を受けるもの) */
const FINANCE_FAMILY: ReadonlyArray<[string, Call]> = [
  ['GET /api/admin/finance/dashboard', () => financeDashboard.GET()],
  ['POST /api/admin/finance/exports', () => financeExports.POST(send('POST', '/api/admin/finance/exports', { export_type: 'revenue' }))],
  ['GET /api/admin/finance/invoices', () => financeInvoices.GET(get('/api/admin/finance/invoices'))],
  ['GET /api/admin/finance/invoices/[id]', () => financeInvoice.GET(get(`/api/admin/finance/invoices/${ID}`), withId())],
  ['GET /api/admin/finance/nps', () => financeNps.GET(get('/api/admin/finance/nps'))],
  ['GET /api/admin/finance/reconciliation', () => financeReconciliation.GET(get('/api/admin/finance/reconciliation'))],
  ['GET /api/admin/finance/revenue', () => financeRevenue.GET(get('/api/admin/finance/revenue'))],
];

/** /api/support の flat の形 ({ error: '<文>' }) の handler */
const SUPPORT_FLAT_FAMILY: ReadonlyArray<[string, Call]> = [
  ['GET /api/support/stats', () => supportStats.GET(get('/api/support/stats'))],
  ['GET /api/support/users/[id]', () => supportUser.GET(get(`/api/support/users/${ID}`), withId())],
  ['GET /api/support/users/[id]/notes', () => supportNotes.GET(get(`/api/support/users/${ID}/notes`), withId())],
  ['POST /api/support/users/[id]/notes', () => supportNotes.POST(send('POST', `/api/support/users/${ID}/notes`, { note: 'メモ' }), withId())],
];

async function bodyOf(res: Response): Promise<{ text: string; json: unknown }> {
  const text = await res.text();
  return { text, json: JSON.parse(text) };
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.loggerError.mockReset();
});

describe('営業・問い合わせの API: 401 は例外の code・403 は OP_PERMISSION_DENIED のまま、文は日本語の固定の文', () => {
  it.each(ERROR_CODE_FAMILY)('%s: 401', async (_name, call) => {
    mocks.requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await call();
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).json).toEqual({ error: { code: 'AUTH_UNAUTHENTICATED', message: LOGIN_REQUIRED } });
  });

  it.each(ERROR_CODE_FAMILY)('%s: 403 (requireRole の英語の文面を出さない)', async (_name, call) => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED', FORBIDDEN_RAW));
    const res = await call();
    expect(res.status).toBe(403);
    const { text, json } = await bodyOf(res);
    expect(json).toEqual({ error: { code: 'OP_PERMISSION_DENIED', message: NO_PERMISSION } });
    expect(text).not.toContain('Requires');
  });

  it.each(ERROR_CODE_FAMILY)('%s: 想定外の例外は 500 (例外の文面は本文に出さず、ログにだけ残す)', async (_name, call) => {
    const cause = new Error(UNEXPECTED_RAW);
    mocks.requireRole.mockRejectedValue(cause);
    const res = await call();
    expect(res.status).toBe(500);
    const { text, json } = await bodyOf(res);
    expect(json).toEqual({ error: { code: 'INTERNAL_ERROR', message: INTERNAL } });
    expect(text).not.toContain('sales_leads');
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError.mock.calls[0][1]).toBe(cause);
  });
});

describe('会計の API: 401 は UNAUTHENTICATED・403 は OP_PERMISSION_DENIED のまま、文は日本語の固定の文', () => {
  it.each(FINANCE_FAMILY)('%s: 401', async (_name, call) => {
    mocks.requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await call();
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).json).toEqual({ error: { code: 'UNAUTHENTICATED', message: LOGIN_REQUIRED } });
  });

  it.each(FINANCE_FAMILY)('%s: 403 (requireRole の英語の文面を出さない)', async (_name, call) => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED', FORBIDDEN_RAW));
    const res = await call();
    expect(res.status).toBe(403);
    const { text, json } = await bodyOf(res);
    expect(json).toEqual({ error: { code: 'OP_PERMISSION_DENIED', message: NO_PERMISSION } });
    expect(text).not.toContain('Requires');
  });

  it.each(FINANCE_FAMILY)('%s: 想定外の例外は 500 (例外の文面は本文に出さない)', async (_name, call) => {
    mocks.requireRole.mockRejectedValue(new Error(UNEXPECTED_RAW));
    const res = await call();
    expect(res.status).toBe(500);
    const { text, json } = await bodyOf(res);
    expect(json).toEqual({ error: { code: 'INTERNAL_ERROR', message: INTERNAL } });
    expect(text).not.toContain('sales_leads');
  });

  it('二段階認証の確認が要る 403 は、その理由の日本語の文にする (code は OP_PERMISSION_DENIED のまま)', async () => {
    mocks.requireRole.mockRejectedValue(new MfaRequiredError('AUTH_2FA_REQUIRED'));
    const res = await financeDashboard.GET();
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).json).toEqual({ error: { code: 'OP_PERMISSION_DENIED', message: '二段階認証の確認が必要です' } });
  });
});

describe('/api/support: flat の形 ({ error: <文> }) のまま、文は日本語の固定の文', () => {
  it.each(SUPPORT_FLAT_FAMILY)('%s: 401', async (_name, call) => {
    mocks.requireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));
    const res = await call();
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).json).toEqual({ error: LOGIN_REQUIRED });
  });

  it.each(SUPPORT_FLAT_FAMILY)('%s: 403', async (_name, call) => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED', FORBIDDEN_RAW));
    const res = await call();
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).json).toEqual({ error: NO_PERMISSION });
  });

  it.each(SUPPORT_FLAT_FAMILY)('%s: 想定外の例外は 500', async (_name, call) => {
    mocks.requireRole.mockRejectedValue(new Error(UNEXPECTED_RAW));
    const res = await call();
    expect(res.status).toBe(500);
    expect((await bodyOf(res)).json).toEqual({ error: INTERNAL });
  });

  it('メモの追加: 本文が JSON でない・メモが空・id が UUID でないときの文', async () => {
    mocks.requireRole.mockResolvedValue({ id: ID, roles: ['support'] });

    const notJson = new NextRequest(`${BASE}/api/support/users/${ID}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const invalid = await supportNotes.POST(notJson, withId());
    expect(invalid.status).toBe(400);
    expect((await bodyOf(invalid)).json).toEqual({ error: 'リクエストボディが不正です' });

    const empty = await supportNotes.POST(send('POST', `/api/support/users/${ID}/notes`, { note: '   ' }), withId());
    expect(empty.status).toBe(400);
    expect((await bodyOf(empty)).json).toEqual({ error: 'メモの内容を入力してください' });

    const badId = await supportNotes.POST(send('POST', '/api/support/users/x/notes', { note: 'メモ' }), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    expect(badId.status).toBe(404);
    expect((await bodyOf(badId)).json).toEqual({ error: 'ユーザーが見つかりません' });
  });
});

describe('営業・問い合わせの 400 VALIDATION_ERROR: message は日本語の文、検証の結果は details', () => {
  const VALIDATION_CASES: ReadonlyArray<[string, Call]> = [
    ['GET /api/admin/sales/leads (stage が不正)', () => salesLeads.GET(get('/api/admin/sales/leads?stage=unknown_stage'))],
    ['POST /api/admin/sales/leads (会社名なし)', () => salesLeads.POST(send('POST', '/api/admin/sales/leads', {}))],
    ['PATCH /api/admin/sales/leads/[id] (stage が不正)', () => salesLead.PATCH(send('PATCH', `/api/admin/sales/leads/${ID}`, { stage: 'unknown_stage' }), withId())],
    [
      'POST /api/admin/sales/leads/[id]/activities (種類が不正)',
      () => salesActivities.POST(send('POST', `/api/admin/sales/leads/${ID}/activities`, { activity_type: 'unknown_type' }), withId()),
    ],
    ['GET /api/admin/support/tickets (status が不正)', () => tickets.GET(get('/api/admin/support/tickets?status=unknown_status'))],
    ['POST /api/admin/support/tickets (件名なし)', () => tickets.POST(send('POST', '/api/admin/support/tickets', {}))],
    ['PATCH /api/admin/support/tickets/[id] (status が不正)', () => ticket.PATCH(send('PATCH', `/api/admin/support/tickets/${ID}`, { status: 'unknown_status' }), withId())],
    ['POST /api/admin/support/tickets/[id]/messages (本文なし)', () => ticketMessages.POST(send('POST', `/api/admin/support/tickets/${ID}/messages`, {}), withId())],
    ['POST /api/admin/support/tickets/[id]/assign (担当なし)', () => ticketAssign.POST(send('POST', `/api/admin/support/tickets/${ID}/assign`, {}), withId())],
  ];

  it.each(VALIDATION_CASES)('%s', async (_name, call) => {
    mocks.requireRole.mockResolvedValue({ id: ID, roles: ['admin'] });
    const res = await call();
    expect(res.status).toBe(400);
    const body = (await bodyOf(res)).json as { error: { code: unknown; message: unknown; details: unknown } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('入力内容を確認してください');
    expect(body.error.details).toEqual(expect.objectContaining({ fieldErrors: expect.any(Object) }));
  });
});

describe('カタログの取り込み: 同じ route の 401 / 403 と同じ nested の形 (code は従来の値)', () => {
  it('JSON でない本文は 400 invalid_json', async () => {
    mocks.requireRole.mockResolvedValue({ id: ID, roles: ['admin'] });
    const req = new NextRequest(`${BASE}/api/admin/catalog/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const res = await catalogImport.POST(req);
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).json).toEqual({ error: { code: 'invalid_json', message: 'リクエストボディが不正です' } });
  });

  it('知らない sourceCode は 400 invalid_source (検証の結果は details)', async () => {
    mocks.requireRole.mockResolvedValue({ id: ID, roles: ['admin'] });
    const res = await catalogImport.POST(send('POST', '/api/admin/catalog/import', { sourceCode: 'invalid_source' }));
    expect(res.status).toBe(400);
    const body = (await bodyOf(res)).json as { error: unknown; details: unknown };
    expect(body.error).toEqual({ code: 'invalid_source', message: 'sourceCode が不正です' });
    expect(body.details).toEqual(expect.objectContaining({ fieldErrors: expect.any(Object) }));
  });
});
