import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// resend だけをモックし、sendEmail 本体 (RESEND_API_KEY 未設定なら { skipped: true } を返す等) は実装のまま通す。
// vi.mock はホイストされるため、モック関数は vi.hoisted で定義する
const { mockEmailsSend, mockGetUserById, mockAdminInsert, mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockEmailsSend: vi.fn(),
  mockGetUserById: vi.fn(),
  mockAdminInsert: vi.fn(),
  mockGetSupabaseAdmin: vi.fn(),
}));

vi.mock('resend', () => {
  class MockResend {
    emails = { send: mockEmailsSend };
  }
  return { Resend: MockResend };
});

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mockGetSupabaseAdmin,
}));

const { sendTicketReplyEmail, TICKET_REPLY_EMAIL_TEMPLATE } = await import(
  '@/lib/admin/send-ticket-reply-email'
);

const CUSTOMER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const CUSTOMER_EMAIL = 'customer@example.com';
const TICKET_ID = 'a1b2c3d4-0000-4000-8000-0000000000aa';
const MESSAGE_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const REPLY_BODY = 'ご不便をおかけしております。\nパスワードの再設定をお試しください。';

const ticket = { id: TICKET_ID, user_id: CUSTOMER_ID, subject: 'ログインできません' };
const logMeta = { ticket_id: TICKET_ID, message_id: MESSAGE_ID };

const logger = { warn: vi.fn(), error: vi.fn() };

const run = () => sendTicketReplyEmail({ ticket, messageId: MESSAGE_ID, messageBody: REPLY_BODY, logger });

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 're_test_key');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  vi.stubEnv('SUPPORT_REPLY_TO', '');

  mockGetSupabaseAdmin.mockReturnValue({
    auth: { admin: { getUserById: mockGetUserById } },
    from: (table: string) => ({ insert: (row: unknown) => mockAdminInsert(table, row) }),
  });
  mockGetUserById.mockResolvedValue({
    data: { user: { id: CUSTOMER_ID, email: CUSTOMER_EMAIL } },
    error: null,
  });
  mockEmailsSend.mockResolvedValue({ data: { id: 're_abc123' }, error: null });
  mockAdminInsert.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockGetSupabaseAdmin.mockReset();
  mockGetUserById.mockReset();
  mockEmailsSend.mockReset();
  mockAdminInsert.mockReset();
});

describe('sendTicketReplyEmail: 送信できる場合', () => {
  it('チケットの顧客本人のメールアドレス宛に、返信の本文を載せて送り、sent を返す', async () => {
    const outcome = await run();

    expect(outcome).toEqual({ status: 'sent' });
    expect(mockEmailsSend).toHaveBeenCalledTimes(1);
    const sent = mockEmailsSend.mock.calls[0][0];
    expect(sent.to).toBe(CUSTOMER_EMAIL);
    expect(sent.from).toBe('ほめゴハン <noreply@homegohan.app>');
    expect(sent.subject).toContain('ログインできません');
    expect(sent.subject).toContain('#a1b2c3d4');
    expect(sent.text).toContain(REPLY_BODY);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('宛先は ticket.user_id を auth.admin.getUserById で 1 人分だけ引く (listUsers は使わない)', async () => {
    await run();

    expect(mockGetUserById).toHaveBeenCalledTimes(1);
    expect(mockGetUserById).toHaveBeenCalledWith(CUSTOMER_ID);
    // 取り違え防止: 管理者や他のユーザーのアドレスには送らない
    expect(mockEmailsSend.mock.calls[0][0].to).toBe(CUSTOMER_EMAIL);
  });

  it('email_delivery_logs に実在する列だけで 1 行残す (recipient_id / template_key / subject は使わない)', async () => {
    await run();

    expect(mockAdminInsert).toHaveBeenCalledTimes(1);
    const [table, row] = mockAdminInsert.mock.calls[0];
    expect(table).toBe('email_delivery_logs');
    expect(row).toEqual({
      user_id: CUSTOMER_ID,
      email: CUSTOMER_EMAIL,
      template: 'support_ticket_reply',
      resend_message_id: 're_abc123',
      status: 'sent',
      metadata: logMeta,
    });
    expect(TICKET_REPLY_EMAIL_TEMPLATE).toBe('support_ticket_reply');
    expect(Object.keys(row).sort()).toEqual([
      'email',
      'metadata',
      'resend_message_id',
      'status',
      'template',
      'user_id',
    ]);
  });

  it('お問い合わせフォームの URL は NEXT_PUBLIC_APP_URL 基点 (末尾の / は除く)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test/');

    await run();

    const text: string = mockEmailsSend.mock.calls[0][0].text;
    expect(text.split('\n')).toContain('https://app.example.test/contact');
    expect(text).not.toContain('test//contact');
  });

  it('NEXT_PUBLIC_APP_URL が未設定なら https://homegohan.app を基点にする', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');

    await run();

    expect(mockEmailsSend.mock.calls[0][0].text.split('\n')).toContain('https://homegohan.app/contact');
  });

  it('SUPPORT_REPLY_TO 未設定: reply_to を付けない (noreply のまま)', async () => {
    await run();

    expect(mockEmailsSend.mock.calls[0][0].replyTo).toBeUndefined();
    expect(mockEmailsSend.mock.calls[0][0].text).toContain('返信しても届きません');
  });

  it('SUPPORT_REPLY_TO 設定: 返信先に使う', async () => {
    vi.stubEnv('SUPPORT_REPLY_TO', ' support@homegohan.app ');

    const outcome = await run();

    expect(outcome).toEqual({ status: 'sent' });
    expect(mockEmailsSend.mock.calls[0][0].replyTo).toBe('support@homegohan.app');
    expect(mockEmailsSend.mock.calls[0][0].text).toContain('そのまま返信していただくと');
  });

  it('SUPPORT_REPLY_TO がメールアドレスの形式でなくても、通知は止めずに noreply のまま送り警告を残す', async () => {
    vi.stubEnv('SUPPORT_REPLY_TO', 'ほめゴハン サポート <support@homegohan.app>');

    const outcome = await run();

    expect(outcome).toEqual({ status: 'sent' });
    expect(mockEmailsSend.mock.calls[0][0].replyTo).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('SUPPORT_REPLY_TO'));
  });
});

describe('sendTicketReplyEmail: 送信できない場合 (返信は失敗させず、結果を返してログに残す)', () => {
  it('RESEND_API_KEY 未設定: 送らずに skipped / not_configured を返し、警告を残す (送信ログは作らない)', async () => {
    vi.stubEnv('RESEND_API_KEY', undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await run();

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(mockEmailsSend).not.toHaveBeenCalled();
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipped'), logMeta);
    expect(logger.error).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  it('Resend がエラーを返す: failed / send_failed を返し、構造化ログに記録する (送信ログは作らない)', async () => {
    mockEmailsSend.mockResolvedValue({
      data: null,
      error: { message: 'The homegohan.app domain is not verified', name: 'validation_error' },
    });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'send_failed' });
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, error, metadata] = logger.error.mock.calls[0];
    expect(message).toContain('send failed');
    expect((error as Error).message).toBe('EMAIL_SEND_FAILED: The homegohan.app domain is not verified');
    expect(metadata).toEqual(logMeta);
    // ログに顧客のメールアドレスを載せない
    expect(JSON.stringify(logger.error.mock.calls[0][2])).not.toContain(CUSTOMER_EMAIL);
  });

  it('Resend の呼び出しが例外になる (ネットワーク断など): failed / send_failed', async () => {
    mockEmailsSend.mockRejectedValue(new Error('fetch failed'));

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'send_failed' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('send failed'), expect.any(Error), logMeta);
  });

  it('顧客のユーザーが見つからない (getUserById がエラーを返す): failed / no_recipient、送信しない', async () => {
    mockGetUserById.mockResolvedValue({
      data: { user: null },
      error: { message: 'User not found', status: 404 },
    });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(mockEmailsSend).not.toHaveBeenCalled();
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('recipient lookup failed'), expect.anything(), logMeta);
  });

  it('getUserById が例外を投げる: failed / no_recipient、送信しない', async () => {
    mockGetUserById.mockRejectedValue(new Error('network down'));

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(mockEmailsSend).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('service role の環境変数が無く getSupabaseAdmin が例外を投げる: failed / no_recipient、送信しない', async () => {
    mockGetSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing');
    });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(mockEmailsSend).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['email が undefined (電話番号だけのアカウントなど)', undefined],
    ['email が空文字', ''],
  ])('顧客にメールアドレスが無い (%s): failed / no_recipient、送信しない', async (_label, email) => {
    mockGetUserById.mockResolvedValue({ data: { user: { id: CUSTOMER_ID, email } }, error: null });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(mockEmailsSend).not.toHaveBeenCalled();
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no email'), logMeta);
  });
});

describe('sendTicketReplyEmail: 送信ログの書き込みに失敗した場合', () => {
  it('INSERT が { error } を返しても (supabase-js は例外にしない)、送信済みなので sent を返し、失敗を記録する', async () => {
    mockAdminInsert.mockResolvedValue({
      error: { message: 'new row violates check constraint', code: '23514' },
    });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'sent' });
    expect(mockEmailsSend).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('delivery log insert failed'),
      expect.anything(),
      logMeta,
    );
  });

  it('INSERT が例外を投げても、sent を返し、失敗を記録する', async () => {
    mockAdminInsert.mockRejectedValue(new Error('connection reset'));

    const outcome = await run();

    expect(outcome).toEqual({ status: 'sent' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('delivery log insert failed'),
      expect.any(Error),
      logMeta,
    );
  });
});

describe('sendTicketReplyEmail: 例外を外に出さない', () => {
  it('想定外の例外 (ロガーの警告が投げる) でも投げずに failed を返し、記録する', async () => {
    mockGetUserById.mockResolvedValue({ data: { user: { id: CUSTOMER_ID, email: '' } }, error: null });
    logger.warn.mockImplementationOnce(() => {
      throw new Error('logger is down');
    });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'send_failed' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unexpected error'),
      expect.any(Error),
      logMeta,
    );
  });
});
