/**
 * POST /api/admin/support/tickets/[id]/messages (#1183)
 *
 * 顧客向けの返信 (is_internal=false) は顧客本人へメールで知らせる。メール送信 (sendEmail) はモックにして、
 * 「内部メモは送らない」「解決した宛先へ送る」「送れなくても 201」「結果を応答に載せる」を確かめる。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { EmailSendError } from '@/lib/emails/send-result';

const {
  mockRequireRole,
  mockSendEmail,
  mockGetUserById,
  mockAdminInsert,
  mockGetSupabaseAdmin,
  mockCreateClient,
  mockLogWarn,
  mockLogError,
  mockWithUser,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSendEmail: vi.fn(),
  mockGetUserById: vi.fn(),
  mockAdminInsert: vi.fn(),
  mockGetSupabaseAdmin: vi.fn(),
  mockCreateClient: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockWithUser: vi.fn(),
}));

vi.mock('@/lib/auth/helpers', () => ({ requireRole: mockRequireRole }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClient,
  getSupabaseAdmin: mockGetSupabaseAdmin,
}));

// 構造化ログのモック (メール通知の失敗は createLogger(...).withUser(user.id) で記録される)
vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: mockWithUser,
  })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

// メール送信のモック (実際には送らない)
vi.mock('@/lib/emails/send', () => ({ sendEmail: mockSendEmail }));

const { POST } = await import('@/app/api/admin/support/tickets/[id]/messages/route');

const TICKET_ID = 'a1b2c3d4-0000-4000-8000-0000000000aa';
const CUSTOMER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const CUSTOMER_EMAIL = 'customer@example.com';
const MESSAGE_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const STAFF = {
  id: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22',
  email: 'staff@example.com',
  roles: ['support'],
  organization_id: null,
};
const REPLY_BODY = 'ご不便をおかけしております。\nパスワードの再設定をお試しください。';
const INTERNAL_NOTE = '社内メモ: この顧客は過去に返金トラブルあり (顧客に見せない)';

const ticketRow = { id: TICKET_ID, status: 'open', user_id: CUSTOMER_ID, subject: 'ログインできません' };
const messageRow = (isInternal: boolean, body: string) => ({
  id: MESSAGE_ID,
  ticket_id: TICKET_ID,
  sender_id: STAFF.id,
  is_internal: isInternal,
  body,
  attachments: [],
  created_at: '2026-10-07T09:00:00.000Z',
});

type DbResult = { data: unknown; error: unknown };

// 副作用が起きた順番 (チケット更新 → メール送信)。テストごとに空にする
let callOrder: string[] = [];

/**
 * チケットとメッセージの表の Supabase クライアントの代役 (本人の権限 (RLS あり) の client と、service_role の client が同じ代わりの表を使う)。
 * from(table).select().eq()... のようなチェーンは何を呼んでも自分自身を返し、await すると
 * テーブルと呼んだ操作に応じた結果を返す。呼び出しは、呼んだ client (via) つきで calls に記録する。
 * 運営の書き込みのポリシーは消した (#1917 の続き) ので、メッセージの保存とチケットの更新は service_role の client (via = 'admin') から来る。
 */
function createUserClientFake(state: {
  ticket: DbResult;
  message: DbResult;
  ticketUpdate: DbResult;
  thread: unknown[];
}) {
  const calls: Array<{ table: string; method: string; args: unknown[]; via: 'session' | 'admin' }> = [];

  const resolveResult = (table: string, ops: string[]): DbResult => {
    if (table === 'support_tickets') return ops.includes('update') ? state.ticketUpdate : state.ticket;
    if (table === 'support_ticket_messages') {
      // insert → 作ったメッセージ。insert 無しの読み取りはスレッド全体 (内部メモを含む)
      return ops.includes('insert') ? state.message : { data: state.thread, error: null };
    }
    return { data: null, error: null };
  };

  const client = {
    from(table: string, via: 'session' | 'admin' = 'session') {
      const ops: string[] = [];
      const builder: unknown = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (value: DbResult) => unknown) => resolve(resolveResult(table, ops));
            }
            return (...args: unknown[]) => {
              ops.push(String(prop));
              calls.push({ table, method: String(prop), args, via });
              if (table === 'support_tickets' && prop === 'update') callOrder.push('ticket_update');
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };

  return { client, calls };
}

let userDb: ReturnType<typeof createUserClientFake>;
/** service_role の client でも userDb の代わりの表を使う表 */
const SUPPORT_TABLES: readonly string[] = ['support_tickets', 'support_ticket_messages'];
/** 書き込みの操作 */
const WRITE_METHODS: readonly string[] = ['insert', 'update', 'upsert', 'delete'];

function postRequest(body: unknown) {
  return new Request(`http://localhost/api/admin/support/tickets/${TICKET_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const post = (body: unknown) => POST(postRequest(body), { params: Promise.resolve({ id: TICKET_ID }) });
const postExternal = (body: string = REPLY_BODY) => post({ body, is_internal: false });
const postInternal = (body: string = INTERNAL_NOTE) => post({ body, is_internal: true });

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 're_test_key');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  vi.stubEnv('SUPPORT_REPLY_TO', '');
  callOrder = [];

  mockRequireRole.mockResolvedValue(STAFF);

  userDb = createUserClientFake({
    ticket: { data: ticketRow, error: null },
    message: { data: messageRow(false, REPLY_BODY), error: null },
    ticketUpdate: { data: null, error: null },
    // 過去の内部メモを含むスレッド。メールに混ざらないことの確認用 (route はスレッドを読まない)
    thread: [messageRow(true, INTERNAL_NOTE)],
  });
  // テストの中で userDb を差し替えるケースがあるため、呼ばれた時点の userDb を返す
  mockCreateClient.mockImplementation(() => userDb.client);

  mockGetSupabaseAdmin.mockReturnValue({
    auth: { admin: { getUserById: mockGetUserById } },
    // チケットとメッセージの表は本人の権限の client と同じ代わりの表 (呼ばれた時点の userDb) を使う。ほかの表 (送信ログ) は mockAdminInsert
    from: (table: string) =>
      SUPPORT_TABLES.includes(table) ? userDb.client.from(table, 'admin') : { insert: (row: unknown) => mockAdminInsert(table, row) },
  });
  mockGetUserById.mockResolvedValue({
    data: { user: { id: CUSTOMER_ID, email: CUSTOMER_EMAIL } },
    error: null,
  });
  mockAdminInsert.mockResolvedValue({ error: null });

  mockSendEmail.mockImplementation(async () => {
    callOrder.push('send_email');
    return { id: 're_abc123' };
  });

  mockWithUser.mockReturnValue({ debug: vi.fn(), info: vi.fn(), warn: mockLogWarn, error: mockLogError });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mockSendEmail.mockReset();
  mockGetSupabaseAdmin.mockReset();
  mockGetUserById.mockReset();
  mockAdminInsert.mockReset();
  mockRequireRole.mockReset();
  mockCreateClient.mockReset();
});

const sentEnvelopes = () => mockSendEmail.mock.calls.map((c) => c[0]);

describe('POST /api/admin/support/tickets/[id]/messages: 内部メモ (is_internal=true)', () => {
  it('201 でメッセージを保存し、メールは送らない (宛先の解決も送信ログもしない)', async () => {
    userDb = createUserClientFake({
      ticket: { data: ticketRow, error: null },
      message: { data: messageRow(true, INTERNAL_NOTE), error: null },
      ticketUpdate: { data: null, error: null },
      thread: [],
    });

    const res = await postInternal();
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.is_internal).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
    // service_role の client は保存の 1 回だけ (#1917 の続き)。宛先の解決はしない
    expect(mockGetSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockAdminInsert).not.toHaveBeenCalled();
  });

  it('応答に email を含めない (画面は内部メモでメール未送信の案内を出さない)', async () => {
    const res = await postInternal();
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).not.toHaveProperty('email');
  });

  it('初回応答 (first_response_at) の記録もしない', async () => {
    await postInternal();

    expect(userDb.calls.some((c) => c.table === 'support_tickets' && c.method === 'update')).toBe(false);
  });
});

describe('POST /api/admin/support/tickets/[id]/messages: 顧客向けの返信 (is_internal=false)', () => {
  it('201 で保存し、チケットの顧客本人のメールアドレス宛に返信の本文を送り、email.status=sent を返す', async () => {
    const res = await postExternal();
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.id).toBe(MESSAGE_ID);
    expect(json.email).toEqual({ status: 'sent' });

    expect(mockGetUserById).toHaveBeenCalledWith(CUSTOMER_ID);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const envelope = sentEnvelopes()[0];
    expect(envelope.to).toBe(CUSTOMER_EMAIL);
    expect(envelope.to).not.toBe(STAFF.email);
    expect(envelope.subject).toContain('ログインできません');
    expect(envelope.subject.length).toBeLessThanOrEqual(100);
    expect(envelope.text).toContain(REPLY_BODY);
  });

  it('保存するメッセージは sender_id = 返信した運営ユーザー、is_internal=false', async () => {
    await postExternal();

    const insert = userDb.calls.find((c) => c.table === 'support_ticket_messages' && c.method === 'insert');
    expect(insert?.args[0]).toEqual({
      ticket_id: TICKET_ID,
      sender_id: STAFF.id,
      is_internal: false,
      body: REPLY_BODY,
      attachments: [],
    });
    // 保存は service_role の client から。本人の権限の client では書かない (#1917 の続き)
    expect(insert?.via).toBe('admin');
    expect(userDb.calls.filter((c) => c.via === 'session' && WRITE_METHODS.includes(c.method))).toEqual([]);
  });

  it('メールには今回の返信だけを載せ、スレッドにある内部メモは混ざらない', async () => {
    await postExternal();

    const everything = JSON.stringify(sentEnvelopes());
    expect(everything).toContain('ご不便をおかけしております');
    expect(everything).not.toContain('社内メモ');
    expect(everything).not.toContain('返金トラブル');
  });

  it('送信ログ (email_delivery_logs) は書かない。sendEmail に userId (チケットの user_id) を渡す', async () => {
    await postExternal();

    // #1193 送信の記録は送信待ち (email_outbox。sendEmail が登録する) にあり、email_delivery_logs には書かない
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(userDb.calls.some((c) => c.table === 'email_delivery_logs')).toBe(false);
    expect(mockSendEmail.mock.calls[0][1]).toEqual({ userId: CUSTOMER_ID });
  });

  it('SUPPORT_REPLY_TO があれば reply_to に付ける', async () => {
    vi.stubEnv('SUPPORT_REPLY_TO', 'support@example.test');

    await postExternal();

    expect(sentEnvelopes()[0].reply_to).toBe('support@example.test');
  });

  it('SUPPORT_REPLY_TO が無ければ reply_to は付けず、本文でお問い合わせフォームへ誘導する', async () => {
    await postExternal();

    const envelope = sentEnvelopes()[0];
    expect(envelope).not.toHaveProperty('reply_to');
    expect(envelope.text.split('\n')).toContain('https://app.example.test/contact');
  });

  it('初回応答 (first_response_at) とステータスを更新し、その後でメールを送る', async () => {
    await postExternal();

    const update = userDb.calls.find((c) => c.table === 'support_tickets' && c.method === 'update');
    expect(update?.via).toBe('admin');
    expect(update?.args[0]).toMatchObject({ status: 'in_progress' });
    expect(update?.args[0]).toHaveProperty('first_response_at');
    // メール送信が遅い・失敗しても初回応答の記録が残るよう、通知は最後にする
    expect(callOrder).toEqual(['ticket_update', 'send_email']);
  });

  describe('メールが送れない場合でも返信は成功する (201)', () => {
    it('Resend が失敗する: 201 + email.status=failed。構造化ログに記録し、送信ログは作らない', async () => {
      mockSendEmail.mockRejectedValue(new Error('EMAIL_SEND_FAILED: The domain is not verified'));

      const res = await postExternal();
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.data.id).toBe(MESSAGE_ID);
      expect(json.email).toEqual({ status: 'failed', reason: 'send_failed' });
      expect(mockWithUser).toHaveBeenCalledWith(STAFF.id);
      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(
        expect.stringContaining('send failed'),
        expect.objectContaining({ message: 'EMAIL_SEND_FAILED: The domain is not verified' }),
        { ticket_id: TICKET_ID, message_id: MESSAGE_ID },
      );
      expect(mockAdminInsert).not.toHaveBeenCalled();
    });

    it('sendEmail が reject せず ok: false の結果を返す (#1193): 201 + email.status=failed。送信済みの送信ログは作らない', async () => {
      const sendError = new EmailSendError('validation_error', 'EMAIL_SEND_FAILED: The domain is not verified', 403, 1, false);
      mockSendEmail.mockResolvedValue({ ok: false, id: null, attempts: 1, skipped: false, error: sendError });

      const res = await postExternal();
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.data.id).toBe(MESSAGE_ID);
      expect(json.email).toEqual({ status: 'failed', reason: 'send_failed' });
      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('send failed'), sendError, {
        ticket_id: TICKET_ID,
        message_id: MESSAGE_ID,
      });
      expect(mockAdminInsert).not.toHaveBeenCalled();
    });

    it('RESEND_API_KEY が未設定 (sendEmail が skipped を返す): 201 + email.status=skipped', async () => {
      mockSendEmail.mockResolvedValue({
        ok: false,
        id: null,
        attempts: 0,
        skipped: true,
        error: new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED: RESEND_API_KEY が未設定', null, 0, false),
      });

      const res = await postExternal();
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.email).toEqual({ status: 'skipped', reason: 'not_configured' });
      expect(mockAdminInsert).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('skipped'), {
        ticket_id: TICKET_ID,
        message_id: MESSAGE_ID,
      });
    });

    it('宛先のメールアドレスを取得できない (getUserById がエラー): 201 + email.status=failed、メールは送らない', async () => {
      mockGetUserById.mockResolvedValue({ data: { user: null }, error: { message: 'User not found' } });

      const res = await postExternal();
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.email).toEqual({ status: 'failed', reason: 'no_recipient' });
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockLogError).toHaveBeenCalledTimes(1);
    });

    it('顧客にメールアドレスが無い: 201 + email.status=failed、メールは送らない', async () => {
      mockGetUserById.mockResolvedValue({ data: { user: { id: CUSTOMER_ID, email: undefined } }, error: null });

      const res = await postExternal();
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.email).toEqual({ status: 'failed', reason: 'no_recipient' });
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledTimes(1);
    });

    it('宛先の解決で service role の client を作れない (getSupabaseAdmin が例外): 201 + email.status=failed', async () => {
      // 保存と初回応答の記録 (service_role の client を 2 回作る) のあと、宛先の解決で作れない
      const adminClient: unknown = mockGetSupabaseAdmin();
      const SAVE_AND_FIRST_RESPONSE_CALLS = 2;
      let calls = 0;
      mockGetSupabaseAdmin.mockImplementation(() => {
        calls += 1;
        if (calls <= SAVE_AND_FIRST_RESPONSE_CALLS) return adminClient;
        throw new Error('Supabase admin env is missing');
      });

      const res = await postExternal();
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.email).toEqual({ status: 'failed', reason: 'no_recipient' });
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockLogError).toHaveBeenCalledTimes(1);
    });

    it('メールが送れなくても初回応答 (first_response_at) の記録は残る', async () => {
      mockSendEmail.mockRejectedValue(new Error('EMAIL_SEND_FAILED: boom'));

      await postExternal();

      expect(userDb.calls.some((c) => c.table === 'support_tickets' && c.method === 'update')).toBe(true);
    });
  });
});

describe('POST /api/admin/support/tickets/[id]/messages: 認可・入力検証・保存失敗ではメールを送らない', () => {
  it('未認証: 401', async () => {
    mockRequireRole.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));

    const res = await postExternal();

    expect(res.status).toBe(401);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('権限なし (一般ユーザー): 403。service role も使わない', async () => {
    mockRequireRole.mockRejectedValue(new ForbiddenError('PERM_DENIED'));

    const res = await postExternal();

    expect(res.status).toBe(403);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('本文が空: 400。保存もメールもしない', async () => {
    const res = await post({ body: '', is_internal: false });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(userDb.calls).toHaveLength(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  // 空白だけの本文は、顧客向けの返信としてメールに載せても「担当者からのメッセージ」が空欄になる。画面は trim で防いでいるが、API だけの穴だった
  it.each([
    ['半角スペース', '   '],
    ['改行とタブ', '\n\t\n'],
    ['全角スペース', '　　'],
    ['空白の混在', ' \n　\t '],
  ])('本文が空白だけ (%s): 400。保存もメールもしない', async (_label, body) => {
    const res = await post({ body, is_internal: false });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(userDb.calls).toHaveLength(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('内部メモでも本文が空白だけなら 400 (保存しない)', async () => {
    const res = await post({ body: '  \n ', is_internal: true });

    expect(res.status).toBe(400);
    expect(userDb.calls).toHaveLength(0);
  });

  it('本文の前後の空白は除いて保存し、メールにもその本文を載せる', async () => {
    await postExternal(`  \n${REPLY_BODY}\n　 `);

    const insert = userDb.calls.find((c) => c.table === 'support_ticket_messages' && c.method === 'insert');
    expect(insert?.args[0]).toMatchObject({ body: REPLY_BODY });
    expect(sentEnvelopes()[0].text).toContain(REPLY_BODY);
  });

  it('チケットが存在しない: 404。メールは送らない', async () => {
    userDb = createUserClientFake({
      // maybeSingle は行が無いと data: null・error: null を返す (#1917。DB の失敗は 404 ではなく 500)
      ticket: { data: null, error: null },
      message: { data: null, error: null },
      ticketUpdate: { data: null, error: null },
      thread: [],
    });

    const res = await postExternal();

    expect(res.status).toBe(404);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('メッセージの保存に失敗: 500。保存されていない返信をメールで知らせない', async () => {
    userDb = createUserClientFake({
      ticket: { data: ticketRow, error: null },
      message: { data: null, error: { message: 'insert failed' } },
      ticketUpdate: { data: null, error: null },
      thread: [],
    });

    const res = await postExternal();

    expect(res.status).toBe(500);
    expect(mockSendEmail).not.toHaveBeenCalled();
    // service_role の client は保存 (失敗した) の 1 回だけ作る。宛先の解決はしない
    expect(mockGetSupabaseAdmin).toHaveBeenCalledTimes(1);
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(userDb.calls.some((c) => c.table === 'support_tickets' && c.method === 'update')).toBe(false);
  });

  it('service role の client を作れない (環境変数が無い) ときは保存できないので 500。本人の権限の client では書かず、メールも送らない (#1917 の続き)', async () => {
    mockGetSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing');
    });

    const res = await postExternal();

    expect(res.status).toBe(500);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(userDb.calls.filter((c) => WRITE_METHODS.includes(c.method))).toEqual([]);
  });
});
