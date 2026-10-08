import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailEnvelopeSchema, maskEmailAddress, sendEmail, type EmailEnvelope } from '@/lib/emails/send';
import { EmailSendError } from '@/lib/emails/send-result';
import { maskSecrets } from '../../../../supabase/functions/_shared/log-sanitizer';

// #1193 メール送信の失敗の記録・再試行・Idempotency-Key。
// Resend の SDK とロガー (app_logs) だけをモックにし、sendEmail 本体は実物を通す。
// vi.mock はホイストされるため、モック関数は vi.hoisted で定義する
const mocks = vi.hoisted(() => ({
  emailsSend: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  createLogger: vi.fn(),
}));

vi.mock('resend', () => {
  class MockResend {
    emails = { send: mocks.emailsSend };
  }
  return { Resend: MockResend };
});

vi.mock('@/lib/db-logger', () => ({
  createLogger: mocks.createLogger,
}));

// 本物のキーではないダミー値 (ログに出ないことを確かめるための目印。秘密情報の書式にしない)
const API_KEY = 'dummy-api-key-for-test-0123456789';
const RECIPIENT = 'test@example.com';
const MASKED_RECIPIENT = 't***@example.com';

const validEnvelope: EmailEnvelope = {
  to: RECIPIENT,
  from: 'ほめゴハン <noreply@homegohan.app>',
  subject: 'テスト件名',
  text: 'テスト本文',
  template: 'org_invite_new',
};

/** Resend の SDK が返す形 ({ data, error, headers }) */
const accepted = (id = 'sent-id') => ({ data: { id }, error: null, headers: null });
const rejected = (name: string, statusCode: number | null, message = `${name}: message`) => ({
  data: null,
  error: { name, statusCode, message },
  headers: null,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('RESEND_API_KEY', API_KEY);
  mocks.createLogger.mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
  });
  mocks.emailsSend.mockResolvedValue(accepted());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.emailsSend.mockReset();
});

/** 再試行の待ち時間 (fake timers) をすべて進めて、結果を受け取る */
async function sendAndSettle(envelope: EmailEnvelope = validEnvelope, options?: Parameters<typeof sendEmail>[1]) {
  const pending = sendEmail(envelope, options);
  await vi.runAllTimersAsync();
  return pending;
}

const loggedText = () => JSON.stringify([mocks.logWarn.mock.calls, mocks.logError.mock.calls]);

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

describe('sendEmail: 送れた場合', () => {
  it('{ ok: true, id, attempts: 1 } を返し、Resend へ 1 回だけ送る。ログは何も残さない', async () => {
    mocks.emailsSend.mockResolvedValueOnce(accepted('sent-id'));

    const result = await sendAndSettle();

    expect(result).toEqual({ ok: true, id: 'sent-id', attempts: 1, skipped: false, error: null });
    expect(mocks.emailsSend).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('宛先・件名・本文・返信先・HTML を Resend へ渡す。template (文面の名前) は Resend へ送らない', async () => {
    await sendAndSettle({
      ...validEnvelope,
      html: '<p>テスト本文</p>',
      reply_to: 'support@homegohan.app',
    });

    const [payload] = mocks.emailsSend.mock.calls[0];
    expect(payload).toEqual({
      from: validEnvelope.from,
      to: RECIPIENT,
      subject: validEnvelope.subject,
      text: validEnvelope.text,
      html: '<p>テスト本文</p>',
      replyTo: 'support@homegohan.app',
    });
    expect(payload).not.toHaveProperty('template');
  });

  it('template の名前に不備があっても (長すぎる・空など)、メールは止めずに送る。ログに出すときは 64 文字に切る', async () => {
    mocks.emailsSend.mockResolvedValueOnce(rejected('validation_error', 400)); // ログを出させる

    const result = await sendAndSettle({ ...validEnvelope, template: 'x'.repeat(200) });

    expect(result).toMatchObject({ ok: false, attempts: 1 }); // 入力の不備ではなく Resend の失敗
    expect(mocks.emailsSend).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][2].template).toBe('x'.repeat(64));
    mocks.emailsSend.mockResolvedValueOnce(accepted());
    await expect(sendAndSettle({ ...validEnvelope, template: '' })).resolves.toMatchObject({ ok: true });
  });

  it('from を省略した封筒には既定の送信元を使う', async () => {
    const { from: _from, ...withoutFrom } = validEnvelope;

    await sendAndSettle(withoutFrom as EmailEnvelope); // from は schema の default で補われる

    expect(mocks.emailsSend.mock.calls[0][0].from).toBe('ほめゴハン <noreply@homegohan.app>');
  });
});

describe('sendEmail: 再試行する失敗 (429 / 5xx / 通信エラー)', () => {
  it.each([
    ['429 rate_limit_exceeded', rejected('rate_limit_exceeded', 429)],
    ['500 internal_server_error', rejected('internal_server_error', 500)],
    ['502 (JSON でない応答)', rejected('application_error', 502)],
    ['503', rejected('application_error', 503)],
    ['504', rejected('application_error', 504)],
    ['通信エラー (SDK は statusCode: null で返す)', rejected('application_error', null, 'Unable to fetch data.')],
    ['409 concurrent_idempotent_requests (同じキーの送信が処理中)', rejected('concurrent_idempotent_requests', 409)],
  ])('%s: 再試行して、次に受け付けられれば ok を返す (attempts: 2)', async (_label, failure) => {
    mocks.emailsSend.mockResolvedValueOnce(failure).mockResolvedValueOnce(accepted('retried-id'));

    const result = await sendAndSettle();

    expect(result).toEqual({ ok: true, id: 'retried-id', attempts: 2, skipped: false, error: null });
    expect(mocks.emailsSend).toHaveBeenCalledTimes(2);
  });

  it('SDK が例外を投げた場合も通信エラーと同じく再試行する', async () => {
    mocks.emailsSend.mockRejectedValueOnce(new Error('socket hang up')).mockResolvedValueOnce(accepted());

    const result = await sendAndSettle();

    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  it('待ち時間は指数バックオフ: 1 回目の再試行まで 500ms、次に 1000ms、次に 2000ms', async () => {
    mocks.emailsSend
      .mockResolvedValueOnce(rejected('rate_limit_exceeded', 429))
      .mockResolvedValueOnce(rejected('rate_limit_exceeded', 429))
      .mockResolvedValueOnce(rejected('rate_limit_exceeded', 429))
      .mockResolvedValueOnce(accepted('fourth'));

    const pending = sendEmail(validEnvelope);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.emailsSend).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(mocks.emailsSend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 500ms
    expect(mocks.emailsSend).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.emailsSend).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // 1000ms
    expect(mocks.emailsSend).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1999);
    expect(mocks.emailsSend).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); // 2000ms
    expect(mocks.emailsSend).toHaveBeenCalledTimes(4);

    await expect(pending).resolves.toEqual({ ok: true, id: 'fourth', attempts: 4, skipped: false, error: null });
  });

  it('最初の 1 回に加えて最大 3 回まで再試行し (合計 4 回)、それでも直らなければ ok: false を返す。例外は投げない', async () => {
    mocks.emailsSend.mockResolvedValue(rejected('application_error', 503, 'Service Unavailable'));

    const result = await sendAndSettle();

    expect(mocks.emailsSend).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ ok: false, id: null, attempts: 4, skipped: false });
    expect(result.error).toBeInstanceOf(EmailSendError);
    expect(result.error).toMatchObject({
      name: 'EmailSendError',
      code: 'application_error',
      statusCode: 503,
      attempts: 4,
      retryable: true,
      message: 'EMAIL_SEND_FAILED: Service Unavailable',
    });
    // 最後の失敗のあとには待たない (タイマーが残らない)
    expect(vi.getTimerCount()).toBe(0);
  });

  it('通信エラーが続いたときも 4 回で諦め、error.code は network_error になる', async () => {
    mocks.emailsSend.mockRejectedValue(new Error('fetch failed'));

    const result = await sendAndSettle();

    expect(mocks.emailsSend).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ ok: false, attempts: 4 });
    expect(result.error).toMatchObject({ code: 'network_error', statusCode: null, retryable: true });
  });

  it('再試行の途中で直らない種類の失敗 (400) に変わったら、そこで止める', async () => {
    mocks.emailsSend
      .mockResolvedValueOnce(rejected('rate_limit_exceeded', 429))
      .mockResolvedValueOnce(rejected('validation_error', 422, 'Invalid `to` field.'));

    const result = await sendAndSettle();

    expect(mocks.emailsSend).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, attempts: 2 });
    expect(result.error).toMatchObject({ code: 'validation_error', statusCode: 422, retryable: false });
  });

  it('再試行で回復したときは、上流の不調に気づけるよう警告を 1 件だけ残す (エラーは残さない)', async () => {
    mocks.emailsSend.mockResolvedValueOnce(rejected('rate_limit_exceeded', 429)).mockResolvedValueOnce(accepted());

    await sendAndSettle();

    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith('メールの送信は再試行で成功しました', {
      template: 'org_invite_new',
      recipient: MASKED_RECIPIENT,
      attempts: 2,
      last_error_code: 'rate_limit_exceeded',
      last_status_code: 429,
    });
  });
});

describe('sendEmail: 再試行しない失敗 (400 / 403 など)', () => {
  it.each([
    ['400 validation_error', rejected('validation_error', 400)],
    ['403 validation_error (送信元ドメインが未検証など)', rejected('validation_error', 403, 'The homegohan.app domain is not verified')],
    ['422 validation_error', rejected('validation_error', 422)],
    ['401 invalid_api_key', rejected('invalid_api_key', 401)],
    ['403 restricted_api_key', rejected('restricted_api_key', 403)],
    ['404 not_found', rejected('not_found', 404)],
    ['409 invalid_idempotent_request (同じキーで中身が違う)', rejected('invalid_idempotent_request', 409)],
    ['429 daily_quota_exceeded (送信数の上限。待っても直らない)', rejected('daily_quota_exceeded', 429)],
    ['429 monthly_quota_exceeded (送信数の上限。待っても直らない)', rejected('monthly_quota_exceeded', 429)],
    ['statusCode が無い validation_error (想定外の形)', { data: null, error: { name: 'validation_error', message: 'bad' } }],
    // SDK が送る前に弾いた入力の不備は statusCode: null で返る。通信の失敗 (application_error) とは区別して再試行しない
    ['statusCode: null の missing_required_field (SDK が送る前に弾いた入力の不備)', rejected('missing_required_field', null)],
  ])('%s: 再試行せずに ok: false を返す (Resend へ 1 回だけ)', async (_label, failure) => {
    mocks.emailsSend.mockResolvedValue(failure);

    const result = await sendAndSettle();

    expect(mocks.emailsSend).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toMatchObject({ ok: false, id: null, attempts: 1, skipped: false });
    expect(result.error).toBeInstanceOf(EmailSendError);
    expect(result.error).toMatchObject({ retryable: false, attempts: 1 });
  });

  it('Resend のエラーコードと HTTP ステータスを error に持つ', async () => {
    mocks.emailsSend.mockResolvedValue(rejected('validation_error', 403, 'The homegohan.app domain is not verified'));

    const result = await sendAndSettle();

    expect(result.error).toMatchObject({
      code: 'validation_error',
      statusCode: 403,
      message: 'EMAIL_SEND_FAILED: The homegohan.app domain is not verified',
    });
  });

  it('成功した応答に ID が無いときは、再試行せずに invalid_response で失敗にする', async () => {
    mocks.emailsSend.mockResolvedValue({ data: null, error: null, headers: null });

    const result = await sendAndSettle();

    expect(mocks.emailsSend).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(result.error).toMatchObject({ code: 'invalid_response', retryable: false });
  });
});

describe('sendEmail: 失敗の記録 (app_logs)', () => {
  it("createLogger('email') で、文面の名前・マスクした宛先・Resend のエラーコード・送った回数をエラーログに残す", async () => {
    mocks.emailsSend.mockResolvedValue(rejected('validation_error', 403, 'The homegohan.app domain is not verified'));

    const result = await sendAndSettle();

    expect(mocks.createLogger).toHaveBeenCalledWith('email');
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith('メールの送信に失敗しました', result.error, {
      template: 'org_invite_new',
      recipient: MASKED_RECIPIENT,
      error_code: 'validation_error',
      status_code: 403,
      attempts: 1,
      retryable: false,
    });
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('再試行を使い切って失敗したときも、エラーログは 1 件だけ (retryable: true, attempts: 4)', async () => {
    mocks.emailsSend.mockResolvedValue(rejected('rate_limit_exceeded', 429, 'Too many requests'));

    await sendAndSettle();

    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][2]).toEqual({
      template: 'org_invite_new',
      recipient: MASKED_RECIPIENT,
      error_code: 'rate_limit_exceeded',
      status_code: 429,
      attempts: 4,
      retryable: true,
    });
  });

  it('template が無い封筒は unknown として記録する', async () => {
    mocks.emailsSend.mockResolvedValue(rejected('validation_error', 400));
    const { template: _template, ...withoutTemplate } = validEnvelope;

    await sendAndSettle(withoutTemplate);

    expect(mocks.logError.mock.calls[0][2]).toMatchObject({ template: 'unknown' });
  });

  it('ログに宛先のメールアドレス・件名・本文・API キーを残さない', async () => {
    mocks.emailsSend.mockResolvedValue(rejected('application_error', 503, 'Service Unavailable'));

    await sendAndSettle();

    const text = loggedText();
    expect(text).not.toContain(RECIPIENT);
    expect(text).not.toContain(validEnvelope.subject);
    expect(text).not.toContain(validEnvelope.text);
    expect(text).not.toContain(API_KEY);
  });

  it('Resend のエラー文に宛先のアドレスが含まれていても、結果の error にもログにもそのまま出さない', async () => {
    mocks.emailsSend.mockResolvedValue(
      rejected('validation_error', 422, `The recipient ${RECIPIENT} is not allowed (reply-to: boss@corp.example.jp)`),
    );

    const result = await sendAndSettle();

    expect(result.error?.message).not.toContain(RECIPIENT);
    expect(result.error?.message).toContain(MASKED_RECIPIENT);
    expect(result.error?.message).toContain('b***@corp.example.jp'); // 宛先以外のアドレスも同じ
    expect(result.error?.message).not.toContain('boss@corp.example.jp');
    expect(loggedText()).not.toContain(RECIPIENT);
  });

  it('マスクした宛先は、app_logs のサニタイザ ([email] への置換) に消されずに残る', () => {
    // サニタイザはメールアドレスをすべて [email] にする。マスクした形が残るのは、* がアドレスの文字に含まれないため
    expect(maskSecrets({ recipient: maskEmailAddress(RECIPIENT) })).toEqual({ recipient: MASKED_RECIPIENT });
    expect(maskSecrets({ recipient: RECIPIENT })).toEqual({ recipient: '[email]' });
  });
});

describe('sendEmail: Idempotency-Key', () => {
  it('Resend へ idempotencyKey を付けて送る', async () => {
    await sendAndSettle();

    const [, requestOptions] = mocks.emailsSend.mock.calls[0];
    expect(requestOptions).toEqual({ idempotencyKey: expect.any(String) });
    expect(requestOptions.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('再試行では同じキーを使う (1 回目が届いていても二重に送られない)', async () => {
    mocks.emailsSend
      .mockResolvedValueOnce(rejected('application_error', 503))
      .mockResolvedValueOnce(rejected('rate_limit_exceeded', 429))
      .mockResolvedValueOnce(accepted());

    await sendAndSettle();

    const keys = mocks.emailsSend.mock.calls.map(([, requestOptions]) => requestOptions.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('別々の sendEmail 呼び出しには別のキーを使う (同じ内容のメールを別々に送る正当なケースを止めない)', async () => {
    await sendAndSettle();
    await sendAndSettle();

    const [first, second] = mocks.emailsSend.mock.calls.map(([, requestOptions]) => requestOptions.idempotencyKey);
    expect(first).not.toBe(second);
  });

  it('呼び出し側がキーを指定したときは、それを最初の送信にも再試行にも使う', async () => {
    mocks.emailsSend.mockResolvedValueOnce(rejected('application_error', 502)).mockResolvedValueOnce(accepted());

    await sendAndSettle(validEnvelope, { idempotencyKey: 'org-invite:1234' });

    const keys = mocks.emailsSend.mock.calls.map(([, requestOptions]) => requestOptions.idempotencyKey);
    expect(keys).toEqual(['org-invite:1234', 'org-invite:1234']);
  });
});

describe('sendEmail: RESEND_API_KEY が未設定', () => {
  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', undefined);
  });

  it('送らずに skipped: true (ok は false) を返す。Resend は呼ばず、再試行もしない', async () => {
    const result = await sendAndSettle();

    expect(mocks.emailsSend).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toMatchObject({ ok: false, id: null, attempts: 0, skipped: true });
    expect(result.error).toBeInstanceOf(EmailSendError);
    expect(result.error).toMatchObject({ code: 'not_configured', statusCode: null, retryable: false });
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
  });
});

describe('sendEmail: 文面 (封筒) が不正', () => {
  it('件名が長すぎる: Resend へ送らず ok: false (invalid_envelope) を返し、エラーログに残す。例外は投げない', async () => {
    const result = await sendAndSettle({ ...validEnvelope, subject: 'あ'.repeat(101) });

    expect(mocks.emailsSend).not.toHaveBeenCalled();
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

    expect(mocks.emailsSend).not.toHaveBeenCalled();
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

describe('maskEmailAddress', () => {
  it.each([
    ['taro@example.com', 't***@example.com'],
    ['abc@example.com', 'a***@example.com'],
    // ローカル部が短いと 1 文字目が実質アドレスそのものなので、1 文字目も隠す
    ['ab@example.com', '***@example.com'],
    ['a@example.com', '***@example.com'],
    ['first.last+tag@sub.example.co.jp', 'f***@sub.example.co.jp'],
    // アドレスの形でないものは、元の文字列を一切出さない
    ['not-an-email', '***'],
    ['@example.com', '***'],
    ['taro@', '***'],
    ['', '***'],
  ])('%s → %s', (input, expected) => {
    expect(maskEmailAddress(input)).toBe(expected);
  });

  it('サロゲートペア (絵文字) の途中で切らない (孤立サロゲートは app_logs の JSON 保存を失敗させる)', () => {
    const masked = maskEmailAddress('😀😀😀😀@example.com');

    expect(masked).toBe('😀***@example.com');
    expect(() => encodeURIComponent(masked)).not.toThrow(); // 孤立サロゲートがあると URIError
  });
});
