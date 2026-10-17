import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { EmailSendError } from '@/lib/emails/send-result';

// sendEmail をモックにする (ticket-messages.test.ts と同じ形)。#1193 で sendEmail は Resend を呼ばず
// 送信待ち (email_outbox) に登録するだけになった。sendEmail そのものは send.test.ts、送信 (再試行) は outbox.test.ts が受け持つ。
// vi.mock はホイストされるため、モック関数は vi.hoisted で定義する
const { mockSendEmail, mockGetUserById, mockAdminInsert, mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
  mockGetUserById: vi.fn(),
  mockAdminInsert: vi.fn(),
  mockGetSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mockSendEmail,
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mockGetSupabaseAdmin,
}));

const { sendTicketReplyEmail, TICKET_REPLY_EMAIL_TEMPLATE } = await import(
  '@/lib/admin/send-ticket-reply-email'
);
const { DEFAULT_EMAIL_FROM, DEFAULT_SITE_URL } = await import('@/lib/site-config');

const CUSTOMER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const CUSTOMER_EMAIL = 'customer@example.com';
const TICKET_ID = 'a1b2c3d4-0000-4000-8000-0000000000aa';
const MESSAGE_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const REPLY_BODY = 'ご不便をおかけしております。\nパスワードの再設定をお試しください。';

const ticket = { id: TICKET_ID, user_id: CUSTOMER_ID, subject: 'ログインできません' };
const logMeta = { ticket_id: TICKET_ID, message_id: MESSAGE_ID };

const logger = { warn: vi.fn(), error: vi.fn() };

const run = () => sendTicketReplyEmail({ ticket, messageId: MESSAGE_ID, messageBody: REPLY_BODY, logger });

/** sendEmail に渡した封筒 (EmailEnvelope の形: to / text / reply_to) */
const sentEnvelope = () => mockSendEmail.mock.calls[0][0] as EmailEnvelope;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  vi.stubEnv('SUPPORT_REPLY_TO', '');
  vi.stubEnv('EMAIL_FROM', '');

  mockGetSupabaseAdmin.mockReturnValue({
    auth: { admin: { getUserById: mockGetUserById } },
    from: (table: string) => ({ insert: (row: unknown) => mockAdminInsert(table, row) }),
  });
  mockGetUserById.mockResolvedValue({
    data: { user: { id: CUSTOMER_ID, email: CUSTOMER_EMAIL } },
    error: null,
  });
  mockSendEmail.mockResolvedValue({ ok: true, id: 'outbox-id-1', attempts: 0, skipped: false, error: null });
  mockAdminInsert.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockGetSupabaseAdmin.mockReset();
  mockGetUserById.mockReset();
  mockSendEmail.mockReset();
  mockAdminInsert.mockReset();
});

describe('sendTicketReplyEmail: 送信待ちに登録できる場合', () => {
  it('チケットの顧客本人のメールアドレス宛に、返信の本文を載せて送り、sent を返す', async () => {
    const outcome = await run();

    expect(outcome).toEqual({ status: 'sent' });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sent = sentEnvelope();
    expect(sent.to).toBe(CUSTOMER_EMAIL);
    expect(sent.from).toBe(DEFAULT_EMAIL_FROM);
    expect(sent.subject).toContain('ログインできません');
    expect(sent.subject).toContain('#a1b2c3d4');
    expect(sent.text).toContain(REPLY_BODY);
    expect(sent.template).toBe(TICKET_REPLY_EMAIL_TEMPLATE);
    expect(TICKET_REPLY_EMAIL_TEMPLATE).toBe('support_ticket_reply');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('sendEmail の 2 つ目の引数は { userId: ticket.user_id }', async () => {
    await run();

    expect(mockSendEmail.mock.calls[0][1]).toEqual({ userId: CUSTOMER_ID });
  });

  it('email_delivery_logs には書かない (送信の記録は email_outbox)', async () => {
    await run();

    expect(mockAdminInsert).not.toHaveBeenCalled();
  });

  it('sendEmail が ok:true (送信待ちに受け付けた) なら sent を返す (登録したあとの送信の失敗はここでは分からない: R-24)', async () => {
    mockSendEmail.mockResolvedValue({ ok: true, id: 'outbox-id-2', attempts: 0, skipped: false, error: null });

    await expect(run()).resolves.toEqual({ status: 'sent' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('宛先は ticket.user_id を auth.admin.getUserById で 1 人分だけ引く (listUsers は使わない)', async () => {
    await run();

    expect(mockGetUserById).toHaveBeenCalledTimes(1);
    expect(mockGetUserById).toHaveBeenCalledWith(CUSTOMER_ID);
    // 取り違え防止: 管理者や他のユーザーのアドレスには送らない
    expect(sentEnvelope().to).toBe(CUSTOMER_EMAIL);
  });

  it('お問い合わせフォームの URL は NEXT_PUBLIC_APP_URL 基点 (末尾の / は除く)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test/');

    await run();

    const text = sentEnvelope().text;
    expect(text.split('\n')).toContain('https://app.example.test/contact');
    expect(text).not.toContain('test//contact');
  });

  it('NEXT_PUBLIC_APP_URL が未設定なら、サイトの URL の既定値 (DEFAULT_SITE_URL) を基点にする', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');

    await run();

    expect(sentEnvelope().text.split('\n')).toContain(`${DEFAULT_SITE_URL}/contact`);
  });

  it('SUPPORT_REPLY_TO 未設定: reply_to を付けない (noreply のまま)', async () => {
    await run();

    expect(sentEnvelope().reply_to).toBeUndefined();
    expect(sentEnvelope().text).toContain('返信しても届きません');
  });

  it('SUPPORT_REPLY_TO 設定: 返信先に使う', async () => {
    vi.stubEnv('SUPPORT_REPLY_TO', ' support@example.test ');

    const outcome = await run();

    expect(outcome).toEqual({ status: 'sent' });
    expect(sentEnvelope().reply_to).toBe('support@example.test');
    expect(sentEnvelope().text).toContain('そのまま返信していただくと');
  });

  it('SUPPORT_REPLY_TO がメールアドレスの形式でなくても、通知は止めずに noreply のまま送り警告を残す', async () => {
    vi.stubEnv('SUPPORT_REPLY_TO', 'ほめゴハン サポート <support@example.test>');

    const outcome = await run();

    expect(outcome).toEqual({ status: 'sent' });
    expect(sentEnvelope().reply_to).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('SUPPORT_REPLY_TO'));
  });
});

describe('sendTicketReplyEmail: 送信待ちに登録できない場合 (返信は失敗させず、結果を返してログに残す)', () => {
  it('RESEND_API_KEY 未設定 (sendEmail が skipped / not_configured): skipped / not_configured を返し、警告を残す', async () => {
    mockSendEmail.mockResolvedValue({
      ok: false,
      id: null,
      attempts: 0,
      skipped: true,
      error: new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED: メールの送信の設定が無いため、メールを送信しませんでした', null, 0, false),
    });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipped'), logMeta);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('送信待ちに登録できない (outbox_failed) なら failed / send_failed。構造化ログに記録する', async () => {
    const error = new EmailSendError('outbox_failed', 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', null, 0, true);
    mockSendEmail.mockResolvedValue({ ok: false, id: null, attempts: 0, skipped: false, error });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'send_failed' });
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, loggedError, metadata] = logger.error.mock.calls[0];
    expect(message).toContain('send failed');
    expect(loggedError).toBe(error);
    expect(metadata).toEqual(logMeta);
    // ログに顧客のメールアドレスを載せない
    expect(JSON.stringify(logger.error.mock.calls[0][2])).not.toContain(CUSTOMER_EMAIL);
  });

  it.each([['suppressed'], ['invalid_envelope']])('宛先停止リスト・文面の不備 (%s) も failed / send_failed', async (code) => {
    mockSendEmail.mockResolvedValue({
      ok: false,
      id: null,
      attempts: 0,
      skipped: false,
      error: new EmailSendError(code, `EMAIL_${code.toUpperCase()}`, null, 0, false),
    });

    await expect(run()).resolves.toEqual({ status: 'failed', reason: 'send_failed' });
    // #1577 の 7: 宛先停止リスト (意図した停止) はログを warn、文面の不備は error のまま
    if (code === 'suppressed') {
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('send failed'), { ...logMeta, error_code: 'suppressed' });
    } else {
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('send failed'), expect.any(EmailSendError), logMeta);
    }
  });

  it('文面の組み立てなどで sendEmail が例外を投げても、failed / send_failed を返し記録する', async () => {
    mockSendEmail.mockRejectedValue(new Error('render failed'));

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
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('recipient lookup failed'), expect.anything(), logMeta);
  });

  it('起票した利用者が退会している (ticket.user_id が null): 宛先を引かず failed / no_recipient、送信しない (#1175)', async () => {
    const outcome = await sendTicketReplyEmail({
      ticket: { ...ticket, user_id: null },
      messageId: MESSAGE_ID,
      messageBody: REPLY_BODY,
      logger,
    });

    expect(outcome).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('has left'), logMeta);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('getUserById が例外を投げる: failed / no_recipient、送信しない', async () => {
    mockGetUserById.mockRejectedValue(new Error('network down'));

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('service role の環境変数が無く getSupabaseAdmin が例外を投げる: failed / no_recipient、送信しない', async () => {
    mockGetSupabaseAdmin.mockImplementation(() => {
      throw new Error('Supabase admin env is missing');
    });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['email が undefined (電話番号だけのアカウントなど)', undefined],
    ['email が空文字', ''],
  ])('顧客にメールアドレスが無い (%s): failed / no_recipient、送信しない', async (_label, email) => {
    mockGetUserById.mockResolvedValue({ data: { user: { id: CUSTOMER_ID, email } }, error: null });

    const outcome = await run();

    expect(outcome).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockAdminInsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no email'), logMeta);
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
