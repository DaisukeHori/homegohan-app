/**
 * #1185 POST /api/admin/finance/refunds の単体テスト
 *
 * このアプリは返金を実行しない。担当者が Stripe ダッシュボードで返金する前に、
 * 「誰が・いつ・誰に・いくら・なぜ」を admin_audit_logs に記録し、記録できたときだけ
 * Stripe ダッシュボードのリンクを返す。確認すること:
 *   - 権限: 未認証は 401、support / 一般ユーザーなどは 403 (記録も作られない)。admin / super_admin / finance は 200
 *   - 入力の検証: 不正な入力はそれぞれ 400 で、記録は作られない
 *   - 記録される行の中身 (action_type / 対象 / 重大度 / details / IP / User-Agent) が設計どおり
 *   - INSERT が失敗したら 500 で、Stripe のリンクは返さない (supabase-js は DB エラーを例外にせず
 *     { error } で返すので、error を見ないと失敗を握りつぶしてしまう)
 *
 * DB を使った実ルートの検証は tests/integration/security/finance-refund-audit.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createClient: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  logError: vi.fn(),
  withUser: vi.fn(),
}));

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: mocks.requireRole,
}));

// 記録は本人のセッションの client (RLS 有効) で行う。service_role (getSupabaseAdmin) は使わない
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mocks.createClient(),
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError,
    withUser: mocks.withUser,
  }),
  generateRequestId: () => 'req_test',
}));

import { POST } from '@/app/api/admin/finance/refunds/route';

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_USER_ID = '22222222-2222-4222-8222-222222222222';
const INVOICE_ID = 'in_1MtHbELkdIwHu7ixl4OzzPMv';
const CHARGE_ID = 'ch_3MmlLrLkdIwHu7ix0snN0B15';
const REASON = '二重に請求されたため';

const URL_TEST_MODE = 'https://dashboard.stripe.com/test';
const URL_LIVE_MODE = 'https://dashboard.stripe.com';

type Caller = { id: string; email: string; roles: string[] };
let caller: Caller | null;

/** 画面から送られる、請求書に対する返金 (全額) の入力 */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: TARGET_USER_ID,
    stripe_invoice_id: INVOICE_ID,
    amount: 1200,
    currency: 'JPY',
    reason: REASON,
    ...overrides,
  };
}

function postRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/admin/finance/refunds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(body: unknown, headers: Record<string, string> = {}) {
  const res = await POST(postRequest(body, headers));
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  vi.clearAllMocks();
  caller = { id: CALLER_ID, email: 'finance@example.com', roles: ['finance'] };

  // 本物の requireRole と同じく、呼び出し側が渡した許可ロールと本人のロールの重なりで判定する
  // (許可ロールの一覧を route が間違えたら、このテストで気づける)
  mocks.requireRole.mockImplementation(async (allowedRoles: readonly string[]) => {
    if (!caller) throw new AuthError('AUTH_UNAUTHENTICATED');
    if (!caller.roles.some((role) => allowedRoles.includes(role))) {
      throw new ForbiddenError('PERM_DENIED', `Requires one of: ${allowedRoles.join(', ')}`);
    }
    return { ...caller, organization_id: null };
  });

  // insert は { error } を返すだけで、.select() などは持たない
  // (finance は admin_audit_logs を SELECT できないので、読み戻す実装は本番で失敗する)
  mocks.insert.mockResolvedValue({ data: null, error: null });
  mocks.from.mockImplementation(() => ({ insert: mocks.insert }));
  mocks.createClient.mockImplementation(() => ({ from: mocks.from }));
  mocks.withUser.mockImplementation(() => ({ error: mocks.logError }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('権限', () => {
  it('未認証は 401。記録は作られない', async () => {
    caller = null;
    const { status, json } = await call(validBody());

    expect(status).toBe(401);
    expect(json.error.code).toBe('AUTH_UNAUTHENTICATED');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['support', ['support']],
    ['一般ユーザー', ['user']],
    ['sales', ['sales']],
    ['content_moderator', ['content_moderator']],
    ['org_admin', ['user', 'org_admin']],
  ])('%s は 403。記録は作られない', async (_label, roles) => {
    caller = { id: CALLER_ID, email: 'someone@example.com', roles };
    const { status, json } = await call(validBody());

    expect(status).toBe(403);
    expect(json.error.code).toBe('OP_PERMISSION_DENIED');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([['finance'], ['admin'], ['super_admin']])('%s は 200', async (role) => {
    caller = { id: CALLER_ID, email: 'staff@example.com', roles: [role] };
    const { status, json } = await call(validBody());

    expect(status).toBe(200);
    expect(json.data.stripe_dashboard_url).toBeTypeOf('string');
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it('許可するロールは admin / super_admin / finance の 3 つだけ', async () => {
    await call(validBody());

    expect(mocks.requireRole).toHaveBeenCalledWith(['admin', 'super_admin', 'finance']);
  });

  it('権限の確認で想定外のエラーが起きたら 500。記録は作られない', async () => {
    mocks.requireRole.mockRejectedValue(new Error('boom'));
    const { status, json } = await call(validBody());

    expect(status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });
});

describe('入力の検証 (どれも 400 で、記録は作られない)', () => {
  it('JSON として読めない本文は INVALID_JSON', async () => {
    const { status, json } = await call('{ broken');

    expect(status).toBe(400);
    expect(json.error.code).toBe('INVALID_JSON');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['配列', [validBody()]],
    ['文字列', 'abc'],
  ])('本文がオブジェクトでない (%s)', async (_label, body) => {
    const { status, json } = await call(JSON.stringify(body));

    expect(status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  const invalidInputs: Array<[string, Record<string, unknown>]> = [
    ['user_id が無い', { user_id: undefined }],
    ['user_id が UUID でない', { user_id: 'not-a-uuid' }],
    ['user_id が空', { user_id: '' }],
    ['user_id が数値', { user_id: 123 }],

    ['stripe_charge_id も stripe_invoice_id も無い', { stripe_invoice_id: undefined }],
    ['stripe_charge_id と stripe_invoice_id の両方がある', { stripe_charge_id: CHARGE_ID }],
    ['stripe_charge_id が charge の形式でない', { stripe_invoice_id: undefined, stripe_charge_id: 'xx_123abc' }],
    ['stripe_charge_id が prefix だけ', { stripe_invoice_id: undefined, stripe_charge_id: 'ch_' }],
    ['stripe_charge_id に請求書の ID を入れた', { stripe_invoice_id: undefined, stripe_charge_id: INVOICE_ID }],
    ['stripe_charge_id に URL の区切りが入っている', { stripe_invoice_id: undefined, stripe_charge_id: 'ch_abc/../x' }],
    ['stripe_invoice_id が invoice の形式でない', { stripe_invoice_id: 'inv_123abc' }],
    ['stripe_invoice_id が prefix だけ', { stripe_invoice_id: 'in_' }],
    ['stripe_invoice_id に決済の ID を入れた', { stripe_invoice_id: CHARGE_ID }],
    ['stripe_invoice_id に URL の区切りが入っている', { stripe_invoice_id: 'in_abc?x=1' }],
    ['stripe_invoice_id が長すぎる', { stripe_invoice_id: `in_${'a'.repeat(256)}` }],

    ['amount が無い', { amount: undefined }],
    ['amount が 0', { amount: 0 }],
    ['amount が負', { amount: -100 }],
    ['amount が小数', { amount: 100.5 }],
    ['amount が文字列', { amount: '1200' }],
    ['amount が null', { amount: null }],
    ['amount が上限 (99,999,999) を超える', { amount: 100_000_000 }],

    ['currency が 2 文字', { currency: 'JP' }],
    ['currency が 4 文字', { currency: 'JPYY' }],
    ['currency が数字', { currency: '123' }],
    ['currency が空', { currency: '' }],
    ['currency が数値', { currency: 392 }],

    ['reason が無い', { reason: undefined }],
    ['reason が空', { reason: '' }],
    ['reason が空白だけ', { reason: ' \n\t　' }],
    ['reason が 501 文字', { reason: 'あ'.repeat(501) }],
    ['reason に NUL 文字が入っている', { reason: '理由\u0000です' }],
    ['reason が文字列でない', { reason: 123 }],
  ];

  it.each(invalidInputs)('%s', async (_label, overrides) => {
    const { status, json } = await call(validBody(overrides));

    expect(status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('境界値は通る: reason 500 文字 / amount 上限 / 1', async () => {
    for (const overrides of [{ reason: 'あ'.repeat(500) }, { amount: 99_999_999 }, { amount: 1 }]) {
      const { status } = await call(validBody(overrides));
      expect(status).toBe(200);
    }
    expect(mocks.insert).toHaveBeenCalledTimes(3);
  });

  it('stripe_charge_id だけ (invoice は null) でも通る', async () => {
    const { status } = await call(validBody({ stripe_invoice_id: null, stripe_charge_id: CHARGE_ID }));

    expect(status).toBe(200);
  });

  it('py_ で始まる決済 (カード以外) の ID も通る', async () => {
    const { status } = await call(validBody({ stripe_invoice_id: undefined, stripe_charge_id: 'py_3MmlLrLkdIwHu7ix0snN0B15' }));

    expect(status).toBe(200);
  });
});

describe('監査ログに記録される内容 (200)', () => {
  it('請求書への返金: 設計どおりの行が 1 件だけ入る', async () => {
    const { status } = await call(validBody());

    expect(status).toBe(200);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith('admin_audit_logs');
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledWith({
      actor_id: CALLER_ID,
      action_type: 'admin.refund.issue',
      target_id: TARGET_USER_ID,
      target_type: 'user',
      severity: 'warn',
      details: {
        amount: 1200,
        currency: 'JPY',
        reason: REASON,
        stripe_charge_id: null,
        stripe_invoice_id: INVOICE_ID,
      },
      ip_address: null,
      user_agent: null,
    });
  });

  it('User-Agent は user_agent 列に入る', async () => {
    await call(validBody(), { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0' });

    expect(mocks.insert.mock.calls[0][0].user_agent).toBe('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0');
  });

  it('決済 (charge) への返金: stripe_charge_id が入り、invoice は null', async () => {
    const { status } = await call(validBody({ stripe_invoice_id: undefined, stripe_charge_id: CHARGE_ID }));

    expect(status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          amount: 1200,
          currency: 'JPY',
          reason: REASON,
          stripe_charge_id: CHARGE_ID,
          stripe_invoice_id: null,
        },
      }),
    );
  });

  it('actor は本人。入力に actor_id / actor を混ぜても上書きできない', async () => {
    const { status } = await call(
      validBody({ actor_id: TARGET_USER_ID, actor: TARGET_USER_ID, severity: 'info', action_type: 'x', target_type: 'x' }),
    );

    expect(status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: CALLER_ID,
        action_type: 'admin.refund.issue',
        severity: 'warn',
        target_type: 'user',
      }),
    );
  });

  it('通貨は省略すると JPY、小文字は大文字にそろえる', async () => {
    await call(validBody({ currency: undefined }));
    await call(validBody({ currency: ' usd ', amount: 1234 }));

    const currencies = mocks.insert.mock.calls.map(([row]) => row.details.currency);
    expect(currencies).toEqual(['JPY', 'USD']);
  });

  it('reason は前後の空白を落として保存する (改行は残す)', async () => {
    await call(validBody({ reason: '  二重請求\n確認済み  ' }));

    expect(mocks.insert.mock.calls[0][0].details.reason).toBe('二重請求\n確認済み');
  });

  it('記録できる IP だけを ip_address に入れる (inet 型なので、複数・IP でない値は INSERT が失敗する)', async () => {
    const cases: Array<[string | null, string | null]> = [
      ['203.0.113.5', '203.0.113.5'],
      ['203.0.113.5, 70.41.3.18, 150.172.238.178', '203.0.113.5'],
      ['2001:db8::1', '2001:db8::1'],
      ['unknown', null],
      ['203.0.113.5:8080', null],
      ['', null],
      [null, null],
    ];
    for (const [header] of cases) {
      await call(validBody(), header === null ? {} : { 'x-forwarded-for': header });
    }

    const stored = mocks.insert.mock.calls.map(([row]) => row.ip_address);
    expect(stored).toEqual(cases.map(([, expected]) => expected));
  });

  it('記録は本人のセッションの client で行い、service_role は使わない', async () => {
    await call(validBody());

    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });
});

describe('Stripe ダッシュボードのリンク', () => {
  it('請求書への返金は、その請求書のページ (テストモード)', async () => {
    const { json } = await call(validBody());

    expect(json).toEqual({ data: { stripe_dashboard_url: `${URL_TEST_MODE}/invoices/${INVOICE_ID}` } });
  });

  it('決済への返金は、その決済のページ (テストモード)', async () => {
    const { json } = await call(validBody({ stripe_invoice_id: undefined, stripe_charge_id: CHARGE_ID }));

    expect(json).toEqual({ data: { stripe_dashboard_url: `${URL_TEST_MODE}/payments/${CHARGE_ID}` } });
  });

  it('本番ビルド (NODE_ENV=production) では本番モードのリンク', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const invoice = await call(validBody());
    const charge = await call(validBody({ stripe_invoice_id: undefined, stripe_charge_id: CHARGE_ID }));

    expect(invoice.json.data.stripe_dashboard_url).toBe(`${URL_LIVE_MODE}/invoices/${INVOICE_ID}`);
    expect(charge.json.data.stripe_dashboard_url).toBe(`${URL_LIVE_MODE}/payments/${CHARGE_ID}`);
  });
});

describe('記録に失敗したとき (500、Stripe のリンクは返さない)', () => {
  function expectNoStripeLink(json: unknown) {
    expect(JSON.stringify(json)).not.toContain('stripe.com');
    expect((json as { data?: unknown }).data).toBeUndefined();
  }

  it('INSERT が { error } を返したら 500。リンクを返さず、構造化ログ (db-logger) に残す', async () => {
    mocks.insert.mockResolvedValue({
      data: null,
      error: { message: 'new row violates row-level security policy', code: '42501' },
    });

    const { status, json } = await call(validBody());

    expect(status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(json.error.message).toContain('返金はまだ行わず');
    expectNoStripeLink(json);

    // 失敗は recordAdminAudit が db-logger に error で残す。誰の・どの操作かが分かり、reason (自由記述) は入れない
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const [message, error, metadata] = mocks.logError.mock.calls[0];
    expect(message).toBe('監査ログ (admin_audit_logs) への記録に失敗しました');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('new row violates row-level security policy');
    expect(metadata).toEqual({
      action_type: 'admin.refund.issue',
      actor_id: CALLER_ID,
      target_id: TARGET_USER_ID,
      target_type: 'user',
      error_code: '42501',
    });
    expect(JSON.stringify(metadata)).not.toContain(REASON);
  });

  it('INSERT が例外を投げても 500。リンクは返さず、失敗を db-logger に残す', async () => {
    mocks.insert.mockRejectedValue(new Error('network down'));

    const { status, json } = await call(validBody());

    expect(status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expectNoStripeLink(json);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it('from() が例外を投げても 500。リンクは返さない', async () => {
    mocks.from.mockImplementation(() => {
      throw new Error('boom');
    });

    const { status, json } = await call(validBody());

    expect(status).toBe(500);
    expectNoStripeLink(json);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('client の作成で例外が起きても 500。リンクは返さず、失敗を db-logger に残す', async () => {
    mocks.createClient.mockImplementation(() => {
      throw new Error('cookies() was called outside a request scope');
    });

    const { status, json } = await call(validBody());

    expect(status).toBe(500);
    expect(json.error.message).toContain('返金はまだ行わず');
    expectNoStripeLink(json);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(CALLER_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][0]).toBe('返金の記録中に想定外のエラーが発生しました');
  });

  it('失敗した直後でも、次の正常な呼び出しは 200 (状態を引きずらない)', async () => {
    mocks.insert.mockResolvedValueOnce({ data: null, error: { message: 'x', code: '42501' } });

    const failed = await call(validBody());
    const succeeded = await call(validBody());

    expect(failed.status).toBe(500);
    expect(succeeded.status).toBe(200);
  });
});
