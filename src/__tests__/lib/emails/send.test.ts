import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailEnvelopeSchema, maskEmailAddress, sendEmail, type EmailEnvelope } from '@/lib/emails/send';
import { maskEmailAddress as maskEmailAddressInOutbox } from '@/lib/emails/outbox';
import { EmailSendError, isEmailFailure } from '@/lib/emails/send-result';
import { DEFAULT_EMAIL_FROM } from '@/lib/site-config';

// #1193 sendEmail は送信待ち (email_outbox) に登録するだけ (Resend は呼ばない。送るのは worker: outbox.test.ts)。
// 設計: docs/design/operator/10-logs-and-mail-retry.md §6.3・§12。
// Resend の SDK・ロガー (app_logs)・停止リスト・service role の Supabase をモックにし、sendEmail 本体は実物を通す。
// vi.mock はホイストされるため、モック関数は vi.hoisted で定義する
const mocks = vi.hoisted(() => ({
  emailsSend: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  createLogger: vi.fn(),
  lookupEmailSuppression: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  from: vi.fn(),
  /** email_outbox への insert(row) の row */
  outboxInserts: [] as Record<string, unknown>[],
  /** insert(...).select('id').single() の結果 */
  insertSelectResult: vi.fn(),
  /** select を付けない insert(...) の結果 (停止リストの dead の記録) */
  insertResult: vi.fn(),
}));

// Resend を呼ばないことを確かめるためにモックにする (呼ばれたら赤)
vi.mock('resend', () => {
  class MockResend {
    emails = { send: mocks.emailsSend };
  }
  return { Resend: MockResend };
});

vi.mock('@/lib/db-logger', () => ({
  createLogger: mocks.createLogger,
}));

// 宛先停止リスト (email_blacklist) の引き当て (#1184)。既定は「載っていない」
vi.mock('@/lib/emails/suppression', () => ({
  lookupEmailSuppression: mocks.lookupEmailSuppression,
}));

// service role の Supabase。既定は email_outbox への INSERT が成功する偽物 (無いと環境変数の不足で例外 → すべて outbox_failed)
vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

// 本物のキーではないダミー値 (ログに出ないことを確かめるための目印。秘密情報の書式にしない)
const API_KEY = 'dummy-api-key-for-test-0123456789';
const RECIPIENT = 'test@example.com';
const MASKED_RECIPIENT = 't***@example.com';
const OUTBOX_ID = '00000000-0000-4000-8000-0000000000aa';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const validEnvelope: EmailEnvelope = {
  to: RECIPIENT,
  from: DEFAULT_EMAIL_FROM,
  subject: 'テスト件名',
  text: 'テスト本文',
  template: 'org_invite_new',
};

/** 偽物の insert: 行を積み、.select('id').single() と、select を付けない await の両方に答える */
function fakeInsert(row: Record<string, unknown>) {
  mocks.outboxInserts.push(row);
  return {
    select: (columns: string) => {
      expect(columns).toBe('id');
      return { single: () => mocks.insertSelectResult() };
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve().then(() => mocks.insertResult()).then(resolve, reject),
  };
}

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', API_KEY);
  mocks.outboxInserts.length = 0;
  mocks.createLogger.mockReturnValue({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
  });
  mocks.lookupEmailSuppression.mockResolvedValue({ status: 'clear' });
  mocks.insertSelectResult.mockResolvedValue({ data: { id: OUTBOX_ID }, error: null });
  mocks.insertResult.mockResolvedValue({ error: null });
  mocks.from.mockImplementation((table: string) => {
    if (table !== 'email_outbox') throw new Error(`unexpected table ${table}`);
    return { insert: fakeInsert };
  });
  mocks.getSupabaseAdmin.mockReturnValue({ from: mocks.from });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.emailsSend.mockReset();
  mocks.getSupabaseAdmin.mockReset();
  mocks.insertSelectResult.mockReset();
  mocks.insertResult.mockReset();
});

const sendAndSettle = (envelope: EmailEnvelope = validEnvelope, options?: Parameters<typeof sendEmail>[1]) =>
  sendEmail(envelope, options);

const loggedText = () => JSON.stringify([mocks.logInfo.mock.calls, mocks.logWarn.mock.calls, mocks.logError.mock.calls]);

describe('EmailEnvelopeSchema', () => {
  it('正常な envelope を parse できる', () => {
    const result = EmailEnvelopeSchema.safeParse(validEnvelope);
    expect(result.success).toBe(true);
  });

  it('template (文面の名前) は省略できる', () => {
    const { template: _template, ...withoutTemplate } = validEnvelope;
    expect(EmailEnvelopeSchema.safeParse(withoutTemplate).success).toBe(true);
  });

  it('空件名 (空文字列) で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({ ...validEnvelope, subject: '' });
    expect(result.success).toBe(false);
  });

  it('100文字超の件名で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({
      ...validEnvelope,
      subject: 'a'.repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it('不正な to (email 形式でない) で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({ ...validEnvelope, to: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('不正な reply_to (email 形式でない) で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({
      ...validEnvelope,
      reply_to: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('空 text で parse エラーになる', () => {
    const result = EmailEnvelopeSchema.safeParse({ ...validEnvelope, text: '' });
    expect(result.success).toBe(false);
  });
});

describe('sendEmail: 登録 (送信待ち email_outbox)', () => {
  it('登録: queued の行を INSERT し ok:true / id=行の id / attempts 0 を返す。Resend は呼ばない', async () => {
    const result = await sendAndSettle({ ...validEnvelope, html: '<p>テスト本文</p>', reply_to: 'support@example.test' });

    expect(result).toEqual({ ok: true, id: OUTBOX_ID, attempts: 0, skipped: false, error: null });
    expect(isEmailFailure(result)).toBe(false);
    expect(mocks.emailsSend).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledWith('email_outbox');
    expect(mocks.outboxInserts).toEqual([
      {
        template: 'org_invite_new',
        to_email: RECIPIENT,
        from_email: DEFAULT_EMAIL_FROM,
        reply_to: 'support@example.test',
        subject: 'テスト件名',
        text_body: 'テスト本文',
        html_body: '<p>テスト本文</p>',
        user_id: null,
        idempotency_key: expect.stringMatching(UUID_PATTERN),
        redact_after_send: false,
        status: 'queued',
      },
    ]);
    // 受け付けたことを info に残す (宛先はマスク)
    expect(mocks.logInfo).toHaveBeenCalledWith('メールを送信待ちに登録しました', {
      template: 'org_invite_new',
      recipient: MASKED_RECIPIENT,
      outbox_id: OUTBOX_ID,
    });
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('返信先・HTML が無い封筒は NULL で登録する', async () => {
    await sendAndSettle();

    expect(mocks.outboxInserts[0]).toMatchObject({ reply_to: null, html_body: null });
  });

  it('idempotencyKey / userId / redactAfterSend を行に入れる', async () => {
    await sendAndSettle(validEnvelope, { idempotencyKey: 'org-invite:1234', userId: 'user-1', redactAfterSend: true });

    expect(mocks.outboxInserts[0]).toMatchObject({
      idempotency_key: 'org-invite:1234',
      user_id: 'user-1',
      redact_after_send: true,
    });
  });

  it('別々の sendEmail 呼び出しには別の Idempotency-Key を使う (同じ内容のメールを別々に送る正当なケースを止めない)', async () => {
    await sendAndSettle();
    await sendAndSettle();

    const [first, second] = mocks.outboxInserts.map((row) => row.idempotency_key);
    expect(first).toEqual(expect.stringMatching(UUID_PATTERN));
    expect(first).not.toBe(second);
  });

  it('template が無い封筒は unknown で登録 (ログも unknown)', async () => {
    const { template: _template, ...withoutTemplate } = validEnvelope;

    await sendAndSettle(withoutTemplate);

    expect(mocks.outboxInserts[0]).toMatchObject({ template: 'unknown' });
    expect(mocks.logInfo.mock.calls[0][1]).toMatchObject({ template: 'unknown' });
  });

  it('template は 100 文字で切って登録し (表の CHECK)、ログには 64 文字に切って出す。空の template は unknown', async () => {
    await sendAndSettle({ ...validEnvelope, template: 'x'.repeat(200) });
    await sendAndSettle({ ...validEnvelope, template: '' });

    expect(mocks.outboxInserts[0].template).toBe('x'.repeat(100));
    expect(mocks.logInfo.mock.calls[0][1].template).toBe('x'.repeat(64));
    expect(mocks.outboxInserts[1].template).toBe('unknown');
  });

  it('from を省略した封筒には既定の送信元を使う', async () => {
    vi.stubEnv('EMAIL_FROM', ''); // 手元の環境変数に左右されないように、未設定にそろえる
    const { from: _from, ...withoutFrom } = validEnvelope;

    await sendAndSettle(withoutFrom as EmailEnvelope); // from は schema の default (site-config の既定値) で補われる

    expect(mocks.outboxInserts[0].from_email).toBe(DEFAULT_EMAIL_FROM);
  });

  it('登録に失敗したら ok:false outbox_failed (retryable) で error ログ (error.details は載せない)', async () => {
    mocks.insertSelectResult.mockResolvedValueOnce({
      data: null,
      error: { message: 'permission denied for table email_outbox', code: '42501', details: `Failing row contains (${RECIPIENT})` },
    });

    const result = await sendAndSettle();

    expect(result).toMatchObject({ ok: false, id: null, attempts: 0, skipped: false });
    expect(isEmailFailure(result)).toBe(true);
    expect(result.error).toBeInstanceOf(EmailSendError);
    expect(result.error).toMatchObject({
      code: 'outbox_failed',
      statusCode: null,
      attempts: 0,
      retryable: true,
      message: 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした',
    });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const [message, error, meta] = mocks.logError.mock.calls[0];
    expect(message).toBe('メールを送信待ちに登録できませんでした');
    expect((error as Error).message).toBe('permission denied for table email_outbox');
    expect(meta).toEqual({ template: 'org_invite_new', recipient: MASKED_RECIPIENT, error_code: 'outbox_failed', pg_code: '42501' });
    expect(loggedText()).not.toContain(RECIPIENT);
    expect(mocks.emailsSend).not.toHaveBeenCalled();
  });

  it('INSERT が行を返さない (data: null・error: null) ときも outbox_failed', async () => {
    mocks.insertSelectResult.mockResolvedValueOnce({ data: null, error: null });

    const result = await sendAndSettle();

    expect(result.error).toMatchObject({ code: 'outbox_failed', retryable: true });
    expect(mocks.logError.mock.calls[0][2]).toMatchObject({ error_code: 'outbox_failed', pg_code: null });
  });

  it('getSupabaseAdmin や insert が例外を投げても、例外にせず ok:false outbox_failed を返す (エラー文の中のアドレスはマスク)', async () => {
    mocks.getSupabaseAdmin.mockImplementationOnce(() => {
      throw new Error('missing service role key');
    });
    const first = await sendAndSettle();
    mocks.insertSelectResult.mockRejectedValueOnce(new Error(`network down while inserting ${RECIPIENT}`));
    const second = await sendAndSettle();

    for (const result of [first, second]) {
      expect(result).toMatchObject({ ok: false, skipped: false, attempts: 0 });
      expect(result.error).toMatchObject({ code: 'outbox_failed', retryable: true });
    }
    expect(mocks.logError).toHaveBeenCalledTimes(2);
    expect((mocks.logError.mock.calls[1][1] as Error).message).toBe(`network down while inserting ${MASKED_RECIPIENT}`);
    expect(mocks.logError.mock.calls[1][2]).toEqual({
      template: 'org_invite_new',
      recipient: MASKED_RECIPIENT,
      error_code: 'outbox_failed',
      pg_code: null,
    });
    expect(loggedText()).not.toContain(RECIPIENT);
  });

  it('ログに宛先・件名・本文・API キーを残さない', async () => {
    await sendAndSettle();
    mocks.insertSelectResult.mockResolvedValueOnce({ data: null, error: { message: 'x', code: '23514' } });
    await sendAndSettle();

    const text = loggedText();
    expect(text).not.toContain(RECIPIENT);
    expect(text).not.toContain(validEnvelope.subject);
    expect(text).not.toContain(validEnvelope.text);
    expect(text).not.toContain(API_KEY);
  });
});

describe('sendEmail: RESEND_API_KEY が未設定', () => {
  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', undefined);
  });

  it('登録せずに skipped: true (ok は false) を返す。Resend も呼ばない', async () => {
    const result = await sendAndSettle();

    expect(mocks.emailsSend).not.toHaveBeenCalled();
    expect(mocks.outboxInserts).toEqual([]);
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, id: null, attempts: 0, skipped: true });
    expect(result.error).toBeInstanceOf(EmailSendError);
    expect(result.error).toMatchObject({ code: 'not_configured', statusCode: null, retryable: false });
    // 変数名は警告のログにだけ残し、エラーの message には入れない (#1182・#1490)
    expect(result.error?.message).toMatch(/^EMAIL_NOT_CONFIGURED: /);
    expect(result.error?.message).not.toContain('RESEND_API_KEY');
  });

  it("console だけでなく app_logs にも警告を残す (createLogger('email').warn。文面の名前とマスクした宛先)", async () => {
    await sendAndSettle();

    expect(mocks.createLogger).toHaveBeenCalledWith('email');
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.stringContaining('RESEND_API_KEY'), {
      template: 'org_invite_new',
      recipient: MASKED_RECIPIENT,
    });
    // 失敗ではなく設定の問題なので、エラーログにはしない
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(RECIPIENT);
  });

  it('空文字の RESEND_API_KEY も未設定として扱う', async () => {
    vi.stubEnv('RESEND_API_KEY', '');

    const result = await sendAndSettle();

    expect(result).toMatchObject({ ok: false, skipped: true });
    expect(mocks.emailsSend).not.toHaveBeenCalled();
    expect(mocks.outboxInserts).toEqual([]);
  });
});

describe('sendEmail: 文面 (封筒) が不正', () => {
  it('件名が長すぎる: 登録せず ok: false (invalid_envelope) を返し、エラーログに残す。例外は投げない', async () => {
    const result = await sendAndSettle({ ...validEnvelope, subject: 'あ'.repeat(101) });

    expect(mocks.emailsSend).not.toHaveBeenCalled();
    expect(mocks.outboxInserts).toEqual([]);
    expect(result).toMatchObject({ ok: false, id: null, attempts: 0, skipped: false });
    expect(result.error).toMatchObject({ code: 'invalid_envelope', retryable: false });
    expect(result.error?.message).toContain('subject');
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][2]).toEqual({
      template: 'org_invite_new',
      recipient: MASKED_RECIPIENT,
      error_code: 'invalid_envelope',
      attempts: 0,
    });
  });

  it('宛先がメールアドレスの形でない: アドレスらしき値をログに出さず、*** にする', async () => {
    const result = await sendAndSettle({ ...validEnvelope, to: 'taro-at-example' });

    expect(mocks.outboxInserts).toEqual([]);
    expect(result).toMatchObject({ ok: false });
    expect(mocks.logError.mock.calls[0][2]).toMatchObject({ recipient: '***' });
    expect(loggedText()).not.toContain('taro-at-example');
  });

  it('封筒そのものが空 (null) でも例外にならない', async () => {
    const result = await sendAndSettle(null as unknown as EmailEnvelope);

    expect(result).toMatchObject({ ok: false, attempts: 0 });
    expect(mocks.logError.mock.calls[0][2]).toMatchObject({ template: 'unknown', recipient: '***' });
  });
});

describe('sendEmail: 宛先停止リスト (email_blacklist。#1184)', () => {
  it('載っている宛先へは送らず、suppressed の失敗 (ok: false / skipped: false / attempts: 0) を返す', async () => {
    mocks.lookupEmailSuppression.mockResolvedValueOnce({ status: 'suppressed', reason: 'bounce' });

    const result = await sendAndSettle();

    expect(mocks.lookupEmailSuppression).toHaveBeenCalledWith(RECIPIENT);
    expect(mocks.emailsSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, id: null, attempts: 0, skipped: false });
    expect(result.error).toBeInstanceOf(EmailSendError);
    expect(result.error?.code).toBe('suppressed');
    expect(result.error?.retryable).toBe(false);
    // 届いていないので、呼び出し側からは送れなかったメールに見える (skipped の「設定が無い」とは区別する)
    expect(isEmailFailure(result)).toBe(true);
  });

  it('送らなかった記録として dead (suppressed・attempts 0) の行を 1 行 INSERT する (queued の行は作らない)', async () => {
    mocks.lookupEmailSuppression.mockResolvedValueOnce({ status: 'suppressed', reason: 'bounce' });

    await sendAndSettle(validEnvelope, { userId: 'user-1' });

    expect(mocks.outboxInserts).toEqual([
      expect.objectContaining({
        template: 'org_invite_new',
        to_email: RECIPIENT,
        user_id: 'user-1',
        redact_after_send: false,
        status: 'dead',
        dead_at: expect.any(String),
        last_error_code: 'suppressed',
      }),
    ]);
    expect(Number.isFinite(Date.parse(String(mocks.outboxInserts[0].dead_at)))).toBe(true);
    expect(mocks.outboxInserts[0]).not.toHaveProperty('attempts'); // attempts は表の既定 0
  });

  it('苦情 (complaint) で載っている宛先も同じく送らない', async () => {
    mocks.lookupEmailSuppression.mockResolvedValueOnce({ status: 'suppressed', reason: 'complaint' });

    const result = await sendAndSettle();

    expect(mocks.emailsSend).not.toHaveBeenCalled();
    expect(result.error?.code).toBe('suppressed');
  });

  it('送らなかったことを app_logs に warn で残す。宛先はマスクし、生のアドレスは結果にもログにも出さない', async () => {
    mocks.lookupEmailSuppression.mockResolvedValueOnce({ status: 'suppressed', reason: 'bounce' });

    const result = await sendAndSettle();

    expect(mocks.createLogger).toHaveBeenCalledWith('email');
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toEqual({
      template: 'org_invite_new',
      recipient: MASKED_RECIPIENT,
      suppression_reason: 'bounce',
    });
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(RECIPIENT);
    expect(result.error?.message).not.toContain(RECIPIENT);
  });

  it('redactAfterSend の登録で宛先が停止リストに載っていれば、行を作らずに suppressed を返す (R-10)', async () => {
    mocks.lookupEmailSuppression.mockResolvedValueOnce({ status: 'suppressed', reason: 'bounce' });

    const result = await sendAndSettle(validEnvelope, { redactAfterSend: true });

    expect(result.error?.code).toBe('suppressed');
    expect(mocks.outboxInserts).toEqual([]);
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('停止リストで dead の行を残す INSERT が { error } でも例外でも、結果は suppressed のまま (warn を残す)', async () => {
    mocks.lookupEmailSuppression.mockResolvedValue({ status: 'suppressed', reason: 'bounce' });
    mocks.insertResult.mockResolvedValueOnce({ error: { message: 'x', code: '42501' } });
    const first = await sendAndSettle();
    mocks.insertResult.mockRejectedValueOnce(new Error(`boom ${RECIPIENT}`));
    const second = await sendAndSettle();
    mocks.getSupabaseAdmin.mockImplementationOnce(() => {
      throw new Error('missing service role key');
    });
    const third = await sendAndSettle();

    for (const result of [first, second, third]) {
      expect(result).toMatchObject({ ok: false, skipped: false });
      expect(result.error?.code).toBe('suppressed');
    }
    const recordWarns = mocks.logWarn.mock.calls.filter(([message]) => message === '送らなかった記録 (dead) を残せませんでした');
    expect(recordWarns).toHaveLength(3);
    expect(recordWarns[0][1]).toEqual({ template: 'org_invite_new', recipient: MASKED_RECIPIENT, pg_code: '42501' });
    expect(recordWarns[1][1]).toEqual({ template: 'org_invite_new', recipient: MASKED_RECIPIENT, error_message: `boom ${MASKED_RECIPIENT}` });
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(RECIPIENT);
  });

  it('載っていなければ queued で登録する (引き当ては 1 回だけ)', async () => {
    const result = await sendAndSettle();

    expect(result).toMatchObject({ ok: true, id: OUTBOX_ID });
    expect(mocks.lookupEmailSuppression).toHaveBeenCalledTimes(1);
    expect(mocks.outboxInserts[0]).toMatchObject({ status: 'queued' });
  });

  it('停止リストを引けなかったとき (DB の失敗・時間切れ) は登録する。引けなかったことを warn に残す (エラー文の中のアドレスはマスク)', async () => {
    mocks.lookupEmailSuppression.mockResolvedValueOnce({
      status: 'lookup_failed',
      error: { message: `timeout while reading ${RECIPIENT}`, code: '57014' },
    });

    const result = await sendAndSettle();

    expect(result).toMatchObject({ ok: true, id: OUTBOX_ID, attempts: 0 });
    expect(mocks.outboxInserts[0]).toMatchObject({ status: 'queued' });
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][0]).toBe('宛先停止リストを引けなかったため、確かめずにメールを送信待ちに登録します');
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ recipient: MASKED_RECIPIENT, error_code: '57014' });
    expect(loggedText()).not.toContain(RECIPIENT);
  });

  it('RESEND_API_KEY が無いとき・封筒が不正なときは、停止リストを引かない (登録しないので DB を読む必要がない)', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    await sendAndSettle();
    vi.stubEnv('RESEND_API_KEY', API_KEY);
    await sendAndSettle({ ...validEnvelope, subject: '' });

    expect(mocks.lookupEmailSuppression).not.toHaveBeenCalled();
    expect(mocks.outboxInserts).toEqual([]);
  });
});

describe('maskEmailAddress', () => {
  it('maskEmailAddress は @/lib/emails/send から再エクスポートされ、outbox のものと同じ関数', () => {
    expect(maskEmailAddress).toBe(maskEmailAddressInOutbox);
    expect(maskEmailAddress(RECIPIENT)).toBe(MASKED_RECIPIENT);
  });
});

// #1194 送信元の既定値は src/lib/site-config.ts で決まり、スキーマは envelope.ts の 1 つだけにまとめた
describe('EmailEnvelopeSchema: 送信元 (#1194)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const withoutFrom = { to: 'test@example.com', subject: 'テスト件名', text: 'テスト本文' };

  it('from を省略すると、EMAIL_FROM が未設定なら既定値になる', () => {
    vi.stubEnv('EMAIL_FROM', '');
    expect(EmailEnvelopeSchema.parse(withoutFrom).from).toBe(DEFAULT_EMAIL_FROM);
  });

  it('from を省略すると、EMAIL_FROM があればそれになる (parse のたびに読む)', () => {
    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');
    expect(EmailEnvelopeSchema.parse(withoutFrom).from).toBe('ほめゴハン <noreply@mail.example.test>');

    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@other.example.test>');
    expect(EmailEnvelopeSchema.parse(withoutFrom).from).toBe('ほめゴハン <noreply@other.example.test>');
  });

  it('from が渡されたときは、それをそのまま使う (EMAIL_FROM より優先)', () => {
    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');
    expect(EmailEnvelopeSchema.parse({ ...withoutFrom, from: 'テスト <t@example.test>' }).from).toBe(
      'テスト <t@example.test>',
    );
  });

  it('スキーマは 1 つだけ: send.ts・membership/templates.ts・envelope.ts が同じものを指す', async () => {
    const templates = await import('@/lib/emails/membership/templates');
    const envelope = await import('@/lib/emails/envelope');
    expect(EmailEnvelopeSchema).toBe(envelope.EmailEnvelopeSchema);
    expect(templates.EmailEnvelopeSchema).toBe(envelope.EmailEnvelopeSchema);
  });

  it('sendEmail: from の無い envelope は、EMAIL_FROM を送信元にして送信待ちに登録する', async () => {
    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');

    await sendAndSettle(withoutFrom as unknown as EmailEnvelope);

    expect(mocks.outboxInserts[0].from_email).toBe('ほめゴハン <noreply@mail.example.test>');
  });
});
