/**
 * #1708 (#1193) POST /api/super-admin/email-outbox/[id]/requeue の単体テスト
 *
 * 届けられなかったメール (dead) の再送。正本: docs/design/operator/10-logs-and-mail-retry.md §9.2・§10・§11・§12。
 *   - 認可: super_admin だけ。それ以外は 403、未ログインは 401 で、service role の client を作らない
 *   - id が UUID でなければ 400 (DB に触れない)。行が無ければ 404 OP_EMAIL_OUTBOX_NOT_FOUND
 *   - requeue_email_outbox が 'requeued' なら 200 と監査ログ 1 行 (super_admin.email_outbox.requeue。target は user_id か行の id)
 *   - 'not_dead' / 'redacted' は 409 OP_EMAIL_OUTBOX_NOT_REQUEUEABLE (details.reason) で、監査を残さない
 *   - 読み取り・RPC の失敗は 500 (汎用の文) で、監査を残さない。監査の記録の失敗では応答を変えない (fail-open)
 *   - 本文を読まない
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aal2AuthMock } from './helpers/mfa-claims';

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  profile: null as {
    roles: string[] | null;
    organization_id: string | null;
    frozen_at: string | null;
    unban_at: string | null;
  } | null,
  /** service role の client が返す行 (select('id, template, user_id, status').eq('id', id).maybeSingle()) */
  row: null as { id: string; template: string; user_id: string | null; status: string } | null,
  readError: null as { code: string; message: string } | null,
  /** requeue_email_outbox の結果 */
  rpcResult: { data: 'requeued', error: null } as { data: unknown; error: { code: string; message: string } | null },
  auditInserts: [] as Array<Record<string, unknown>>,
  auditResult: { error: null } as { error: { message: string } | null } | 'throw',
  /** service role の client への呼び出しの記録 */
  adminCalls: [] as Array<{ method: string; args: unknown[] }>,
}));
const getSupabaseAdmin = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    const getUser = async () =>
      state.user
        ? { data: { user: state.user }, error: null }
        : { data: { user: null }, error: { message: 'Auth session missing!' } };
    return {
      auth: { getUser, ...aal2AuthMock(getUser) },
      from: (table: string) => {
        if (table === 'admin_audit_logs') {
          return {
            insert: async (row: Record<string, unknown>) => {
              if (state.auditResult === 'throw') throw new Error('audit insert crashed');
              state.auditInserts.push(row);
              return state.auditResult;
            },
          };
        }
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
  createLogger: vi.fn(() => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError, withUser: vi.fn() };
    logger.withUser.mockReturnValue(logger);
    return logger;
  }),
  generateRequestId: vi.fn(() => 'req_test'),
}));

const route = await import('@/app/api/super-admin/email-outbox/[id]/requeue/route');
const { POST } = route;

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_A = '00000000-0000-4000-8000-0000000000b1';
const OUTBOX_ID = '00000000-0000-4000-8000-0000000000c1';

function adminClient() {
  return {
    from(table: string) {
      if (table !== 'email_outbox') throw new Error(`service role の client が想定外のテーブル ${table} に触れた`);
      const builder = {
        select: (...args: unknown[]) => (state.adminCalls.push({ method: 'select', args }), builder),
        eq: (...args: unknown[]) => (state.adminCalls.push({ method: 'eq', args }), builder),
        maybeSingle: async () => {
          state.adminCalls.push({ method: 'maybeSingle', args: [] });
          return state.readError ? { data: null, error: state.readError } : { data: state.row, error: null };
        },
      };
      return builder;
    },
    rpc: async (fn: string, args: unknown) => {
      state.adminCalls.push({ method: 'rpc', args: [fn, args] });
      return state.rpcResult;
    },
  };
}

function asUser(roles: string[] | null) {
  state.user = { id: ADMIN_ID, email: 'ops@example.com' };
  state.profile = { roles, organization_id: null, frozen_at: null, unban_at: null };
}

/** 本文を読まれたら失敗させる Request (本文を読まないことを確かめる) */
function requestFor(id: string) {
  const request = new Request(`http://localhost/api/super-admin/email-outbox/${id}/requeue`, {
    method: 'POST',
    headers: { 'user-agent': 'vitest', 'x-forwarded-for': '203.0.113.7' },
  });
  for (const reader of ['json', 'text', 'formData', 'arrayBuffer', 'blob'] as const) {
    Object.defineProperty(request, reader, {
      value: () => {
        throw new Error(`本文を読んだ (${reader})`);
      },
    });
  }
  return request;
}

async function post(id = OUTBOX_ID) {
  const res = await POST(requestFor(id) as never, { params: Promise.resolve({ id }) });
  return { res, json: await res.json() };
}

const rpcCalls = () => state.adminCalls.filter((c) => c.method === 'rpc').map((c) => c.args);

beforeEach(() => {
  vi.clearAllMocks();
  state.adminCalls = [];
  state.auditInserts = [];
  state.auditResult = { error: null };
  state.readError = null;
  state.row = { id: OUTBOX_ID, template: 'family_invite', user_id: USER_A, status: 'dead' };
  state.rpcResult = { data: 'requeued', error: null };
  getSupabaseAdmin.mockImplementation(adminClient);
  asUser(['super_admin']);
});

describe('POST /api/super-admin/email-outbox/[id]/requeue: 認可', () => {
  it('未ログインは 401。service role の client を作らず、監査も残さない', async () => {
    state.user = null;

    const { res, json } = await post();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(state.auditInserts).toEqual([]);
  });

  it.each([
    ['admin', ['admin']],
    ['support', ['support']],
    ['一般ユーザー', ['user']],
  ])('%s は 403。service role の client を作らず、監査も残さない', async (_label, roles) => {
    asUser(roles);

    const { res, json } = await post();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(state.auditInserts).toEqual([]);
  });

  it('id が不正でも、認可が先 (一般ユーザーは 403)', async () => {
    asUser(['user']);

    expect((await post('not-a-uuid')).res.status).toBe(403);
  });
});

describe('POST /api/super-admin/email-outbox/[id]/requeue: 再送', () => {
  it('id が UUID でなければ 400 で、DB に触れない', async () => {
    const { res, json } = await post('not-a-uuid');

    expect(res.status).toBe(400);
    expect(json.error).toEqual({ code: 'VALIDATION_ERROR', message: 'ID (id) の形式が正しくありません' });
    expect(state.adminCalls).toEqual([]);
  });

  it('行が無ければ 404 OP_EMAIL_OUTBOX_NOT_FOUND で、RPC を呼ばず監査も残さない', async () => {
    state.row = null;

    const { res, json } = await post();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('OP_EMAIL_OUTBOX_NOT_FOUND');
    expect(rpcCalls()).toEqual([]);
    expect(state.auditInserts).toEqual([]);
  });

  it('requeued なら 200 { data: { id, status: queued } }。RPC は p_id だけを渡す。読むのは id・template・user_id・status だけ', async () => {
    const { res, json } = await post();

    expect(res.status).toBe(200);
    expect(json).toEqual({ data: { id: OUTBOX_ID, status: 'queued' } });
    expect(rpcCalls()).toEqual([['requeue_email_outbox', { p_id: OUTBOX_ID }]]);
    expect(state.adminCalls.find((c) => c.method === 'select')!.args).toEqual(['id, template, user_id, status']);
    expect(state.adminCalls.find((c) => c.method === 'eq')!.args).toEqual(['id', OUTBOX_ID]);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('監査ログに super_admin.email_outbox.requeue を 1 行 (target は行の user_id。details は行の id・文面・前の状態だけ)', async () => {
    await post();

    expect(state.auditInserts).toHaveLength(1);
    expect(state.auditInserts[0]).toMatchObject({
      actor_id: ADMIN_ID,
      action_type: 'super_admin.email_outbox.requeue',
      target_id: USER_A,
      target_type: 'user',
      details: { outbox_id: OUTBOX_ID, template: 'family_invite', previous_status: 'dead' },
      user_agent: 'vitest',
    });
  });

  it('#1917: 読んだときの status が dead でなくても (読んでから RPC までの間に dead になった)、監査の前の状態は RPC がロックの下で確かめた dead', async () => {
    // 先の読み取りは queued (送信中) だったが、worker が送れずに dead にした後で requeue_email_outbox が FOR UPDATE で行を取った
    state.row = { id: OUTBOX_ID, template: 'family_invite', user_id: USER_A, status: 'queued' };
    state.rpcResult = { data: 'requeued', error: null };

    const { res } = await post();

    expect(res.status).toBe(200);
    expect(state.auditInserts).toHaveLength(1);
    expect(state.auditInserts[0]).toMatchObject({
      details: { outbox_id: OUTBOX_ID, template: 'family_invite', previous_status: 'dead' },
    });
  });

  it('行に user_id が無ければ、target は行の id (target_type email_outbox)', async () => {
    state.row = { id: OUTBOX_ID, template: 'contact_admin_notification', user_id: null, status: 'dead' };

    await post();

    expect(state.auditInserts[0]).toMatchObject({ target_id: OUTBOX_ID, target_type: 'email_outbox' });
  });

  it('大文字の UUID は小文字にそろえて DB と監査に渡す (#1707)', async () => {
    const { res } = await post(OUTBOX_ID.toUpperCase());

    expect(res.status).toBe(200);
    expect(rpcCalls()).toEqual([['requeue_email_outbox', { p_id: OUTBOX_ID }]]);
    expect(state.adminCalls.find((c) => c.method === 'eq')!.args).toEqual(['id', OUTBOX_ID]);
  });

  it.each([
    ['not_dead', '届けられなかったメールだけを再送できます'],
    ['redacted', '宛先を伏せた行は再送できません'],
  ])('%s は 409 OP_EMAIL_OUTBOX_NOT_REQUEUEABLE (details.reason) で、監査を残さない', async (reason, message) => {
    state.rpcResult = { data: reason, error: null };

    const { res, json } = await post();

    expect(res.status).toBe(409);
    expect(json.error).toEqual({ code: 'OP_EMAIL_OUTBOX_NOT_REQUEUEABLE', message, details: { reason } });
    expect(state.auditInserts).toEqual([]);
  });

  it('RPC が not_found (読んだあとに消えた) なら 404 で、監査を残さない', async () => {
    state.rpcResult = { data: 'not_found', error: null };

    const { res, json } = await post();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('OP_EMAIL_OUTBOX_NOT_FOUND');
    expect(state.auditInserts).toEqual([]);
  });

  it.each([
    ['読み取りの失敗', () => (state.readError = { code: '42501', message: 'permission denied for table email_outbox' })],
    ['RPC の失敗', () => (state.rpcResult = { data: null, error: { code: '42501', message: 'permission denied for function requeue_email_outbox' } })],
    ['RPC が想定外の値', () => (state.rpcResult = { data: 'weird', error: null })],
  ])('%s は 500 (汎用の文) で、DB の文を出さず、監査を残さない', async (_label, arrange) => {
    arrange();

    const { res, json } = await post();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(json)).not.toContain('permission denied');
    expect(state.auditInserts).toEqual([]);
    expect(logError).toHaveBeenCalled();
  });

  it('監査の記録に失敗しても ({ error } でも例外でも) 200 のまま (fail-open)', async () => {
    state.auditResult = { error: { message: 'new row violates row-level security policy' } };
    expect((await post()).res.status).toBe(200);

    state.auditResult = 'throw';
    expect((await post()).res.status).toBe(200);
  });

  it('POST だけを公開する', () => {
    expect(Object.keys(route).filter((name) => ['GET', 'PUT', 'PATCH', 'DELETE'].includes(name))).toEqual([]);
  });
});
