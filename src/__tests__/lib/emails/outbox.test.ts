import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMAIL_OUTBOX_BATCH_SIZE,
  EMAIL_OUTBOX_MAX_ATTEMPTS,
  EMAIL_OUTBOX_QUEUED_MAX_AGE_MS,
  EMAIL_OUTBOX_RETRY_DELAYS_SECONDS,
  EMAIL_OUTBOX_SEND_INTERVAL_MS,
  createResendTransport,
  isRetryableResendError,
  maskEmailAddress,
  parseClaimedRows,
  processEmailOutbox,
  redactEmailAddresses,
  resolveEmailOutboxSettings,
  retryDelaySeconds,
  type EmailOutboxClaimedRow,
  type EmailOutboxWorkerDeps,
  type EmailTransportFailure,
  type EmailTransportOutcome,
  type OutboxFailOutcome,
} from '@/lib/emails/outbox';
import { maskSecrets } from '../../../../supabase/functions/_shared/log-sanitizer';

// #1193 メールの送信待ち (email_outbox) の worker の本体と、Resend の送信 (createResendTransport)。
// 設計: docs/design/operator/10-logs-and-mail-retry.md §6.2・§12。
// Resend の SDK だけをモックにし、worker は DB・Resend・停止リストを引数の偽物で受ける (純粋)
const mocks = vi.hoisted(() => ({
  emailsSend: vi.fn(),
  resendConstructed: vi.fn(),
}));

vi.mock('resend', () => {
  class MockResend {
    emails = { send: mocks.emailsSend };
    constructor(apiKey: string) {
      mocks.resendConstructed(apiKey);
    }
  }
  return { Resend: MockResend };
});

const API_KEY = 'dummy-api-key-for-test-0123456789';
const RECIPIENT = 'test@example.com';
const MASKED_RECIPIENT = 't***@example.com';
const NOW = Date.parse('2026-10-16T03:00:00.000Z');
const ONE_MINUTE_MS = 60_000;

/** Resend の SDK が返す形 ({ data, error, headers }) */
const accepted = (id = 'sent-id') => ({ data: { id }, error: null, headers: null });
const rejected = (name: string, statusCode: number | null, message = `${name}: message`) => ({
  data: null,
  error: { name, statusCode, message },
  headers: null,
});

function makeRow(overrides: Partial<EmailOutboxClaimedRow> = {}): EmailOutboxClaimedRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    template: 'family_invite',
    to_email: RECIPIENT,
    from_email: 'ほめゴハン <noreply@example.test>',
    reply_to: null,
    subject: 'テスト件名',
    text_body: 'テスト本文',
    html_body: null,
    idempotency_key: 'idem-key-1',
    attempts: 0,
    created_at: new Date(NOW - ONE_MINUTE_MS).toISOString(),
    redact_after_send: false,
    ...overrides,
  };
}

interface Harness {
  deps: EmailOutboxWorkerDeps;
  claim: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  suppression: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  clock: { now: number };
}

function makeHarness(rows: EmailOutboxClaimedRow[]): Harness {
  const clock = { now: NOW };
  const claim = vi.fn(async () => rows);
  const complete = vi.fn(async () => true);
  const fail = vi.fn(async (): Promise<OutboxFailOutcome> => 'queued');
  const send = vi.fn(async (row: EmailOutboxClaimedRow): Promise<EmailTransportOutcome> => ({ ok: true, id: `resend-${row.id}` }));
  const suppression = vi.fn(async () => ({ status: 'clear' as const }));
  const sleep = vi.fn(async () => undefined);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    deps: {
      store: { claim, complete, fail },
      transport: { send },
      suppression,
      now: () => clock.now,
      sleep,
      log,
    },
    claim,
    complete,
    fail,
    send,
    suppression,
    sleep,
    log,
    clock,
  };
}

const RUN = { workerId: 'worker-1', maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS, batchSize: EMAIL_OUTBOX_BATCH_SIZE };

beforeEach(() => {
  mocks.emailsSend.mockResolvedValue(accepted());
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.emailsSend.mockReset();
});

describe('resolveEmailOutboxSettings', () => {
  it('未設定は既定 (6 回・20 件)', () => {
    expect(resolveEmailOutboxSettings({ maxAttempts: undefined, batchSize: undefined })).toEqual({
      maxAttempts: 6,
      batchSize: 20,
      ignored: [],
    });
    expect(resolveEmailOutboxSettings({ maxAttempts: '  ', batchSize: '' })).toEqual({ maxAttempts: 6, batchSize: 20, ignored: [] });
  });

  it('範囲内の整数はその値を使う (前後の空白は除く)', () => {
    expect(resolveEmailOutboxSettings({ maxAttempts: ' 1 ', batchSize: '100' })).toEqual({ maxAttempts: 1, batchSize: 100, ignored: [] });
    expect(resolveEmailOutboxSettings({ maxAttempts: '20', batchSize: '1' })).toEqual({ maxAttempts: 20, batchSize: 1, ignored: [] });
  });

  it.each([
    ['0', '0'],
    ['21', '101'],
    ['3.5', '1e2'],
    ['-1', 'abc'],
    ['６', '0x10'],
  ])('整数でない・範囲外は既定に戻し変数名だけを ignored に (%s / %s)', (maxAttempts, batchSize) => {
    const settings = resolveEmailOutboxSettings({ maxAttempts, batchSize });
    expect(settings).toEqual({
      maxAttempts: 6,
      batchSize: 20,
      ignored: ['EMAIL_OUTBOX_MAX_ATTEMPTS', 'EMAIL_OUTBOX_BATCH_SIZE'],
    });
    // 値そのものは返さない (返すのは変数名と既定値だけ)
    expect(Object.keys(settings).sort()).toEqual(['batchSize', 'ignored', 'maxAttempts']);
  });
});

describe('retryDelaySeconds', () => {
  it.each([
    [1, 60],
    [2, 300],
    [3, 900],
    [4, 3600],
    [5, 14400],
    [6, 14400],
    [20, 14400],
  ])('%i 回目の失敗のあとは %i 秒待つ (6 以上は最後の値)', (failedAttempt, seconds) => {
    expect(retryDelaySeconds(failedAttempt)).toBe(seconds);
  });

  it('0 以下は 1 回目と同じ (表の外に出ない)', () => {
    expect(retryDelaySeconds(0)).toBe(EMAIL_OUTBOX_RETRY_DELAYS_SECONDS[0]);
    expect(retryDelaySeconds(-3)).toBe(EMAIL_OUTBOX_RETRY_DELAYS_SECONDS[0]);
  });
});

describe('parseClaimedRows', () => {
  it('正しい形の行を返す。null は 0 件', () => {
    const row = makeRow();
    expect(parseClaimedRows([{ ...row, status: 'queued', worker_id: 'w' }])).toEqual([row]);
    expect(parseClaimedRows(null)).toEqual([]);
  });

  it.each([
    ['配列でない', { id: 'x' }],
    ['id が uuid でない', [{ ...makeRow(), id: 'not-a-uuid' }]],
    ['attempts が数値でない', [{ ...makeRow(), attempts: '1' }]],
    ['redact_after_send が無い', [{ ...makeRow(), redact_after_send: undefined }]],
  ])('形が違えば例外 (黙って 0 件にしない): %s', (_label, data) => {
    expect(() => parseClaimedRows(data)).toThrow();
  });
});

describe('isRetryableResendError', () => {
  it.each([
    ['429 rate_limit_exceeded', { name: 'rate_limit_exceeded', statusCode: 429 }],
    ['500 internal_server_error', { name: 'internal_server_error', statusCode: 500 }],
    ['502 (JSON でない応答)', { name: 'application_error', statusCode: 502 }],
    ['503', { name: 'application_error', statusCode: 503 }],
    ['504', { name: 'application_error', statusCode: 504 }],
    ['通信エラー (SDK は statusCode: null で返す)', { name: 'application_error', statusCode: null }],
    ['409 concurrent_idempotent_requests (同じキーの送信が処理中)', { name: 'concurrent_idempotent_requests', statusCode: 409 }],
  ])('%s: 再試行する (true)', (_label, error) => {
    expect(isRetryableResendError(error)).toBe(true);
  });

  it.each([
    ['400 validation_error', { name: 'validation_error', statusCode: 400 }],
    ['403 validation_error (送信元ドメインが未検証など)', { name: 'validation_error', statusCode: 403 }],
    ['422 validation_error', { name: 'validation_error', statusCode: 422 }],
    ['401 invalid_api_key', { name: 'invalid_api_key', statusCode: 401 }],
    ['403 restricted_api_key', { name: 'restricted_api_key', statusCode: 403 }],
    ['404 not_found', { name: 'not_found', statusCode: 404 }],
    ['409 invalid_idempotent_request (同じキーで中身が違う)', { name: 'invalid_idempotent_request', statusCode: 409 }],
    ['429 daily_quota_exceeded (送信数の上限。待っても直らない)', { name: 'daily_quota_exceeded', statusCode: 429 }],
    ['429 monthly_quota_exceeded (送信数の上限。待っても直らない)', { name: 'monthly_quota_exceeded', statusCode: 429 }],
    ['statusCode が無い validation_error (想定外の形)', { name: 'validation_error' }],
    // SDK が送る前に弾いた入力の不備は statusCode: null で返る。通信の失敗 (application_error) とは区別して再試行しない
    ['statusCode: null の missing_required_field (SDK が送る前に弾いた入力の不備)', { name: 'missing_required_field', statusCode: null }],
  ])('%s: 再試行しない (false)', (_label, error) => {
    expect(isRetryableResendError(error)).toBe(false);
  });
});

describe('createResendTransport', () => {
  it('受け付けたら ok と id。鍵で Resend を作り、Idempotency-Key を付けて宛先・件名・本文・HTML・返信先を渡す (template は送らない)', async () => {
    mocks.emailsSend.mockResolvedValueOnce(accepted('resend-id-1'));
    const transport = createResendTransport(API_KEY);

    const outcome = await transport.send(makeRow({ html_body: '<p>本文</p>', reply_to: 'support@example.test' }));

    expect(outcome).toEqual({ ok: true, id: 'resend-id-1' });
    expect(mocks.resendConstructed).toHaveBeenCalledWith(API_KEY);
    const [payload, requestOptions] = mocks.emailsSend.mock.calls[0];
    expect(payload).toEqual({
      from: 'ほめゴハン <noreply@example.test>',
      to: RECIPIENT,
      subject: 'テスト件名',
      text: 'テスト本文',
      html: '<p>本文</p>',
      replyTo: 'support@example.test',
    });
    expect(payload).not.toHaveProperty('template');
    expect(requestOptions).toEqual({ idempotencyKey: 'idem-key-1' });
  });

  it('HTML・返信先が無い行は undefined で渡す (null を送らない)', async () => {
    await createResendTransport(API_KEY).send(makeRow());

    const [payload] = mocks.emailsSend.mock.calls[0];
    expect(payload.html).toBeUndefined();
    expect(payload.replyTo).toBeUndefined();
  });

  it('error は code / statusCode / retryable を持ち、message の中のアドレスはマスクする', async () => {
    mocks.emailsSend.mockResolvedValueOnce(rejected('validation_error', 403, `The recipient ${RECIPIENT} is not allowed`));

    const outcome = await createResendTransport(API_KEY).send(makeRow());

    expect(outcome).toEqual({
      ok: false,
      failure: { code: 'validation_error', message: `The recipient ${MASKED_RECIPIENT} is not allowed`, statusCode: 403, retryable: false },
    });
  });

  it('retryable は isRetryableResendError で決める (503 は true)', async () => {
    mocks.emailsSend.mockResolvedValueOnce(rejected('application_error', 503, 'Service Unavailable'));

    const outcome = await createResendTransport(API_KEY).send(makeRow());

    expect(outcome).toEqual({
      ok: false,
      failure: { code: 'application_error', message: 'Service Unavailable', statusCode: 503, retryable: true },
    });
  });

  it('error の name・message が空なら unknown_error、statusCode が無ければ null', async () => {
    mocks.emailsSend.mockResolvedValueOnce({ data: null, error: { name: '', message: '' }, headers: null });

    const outcome = await createResendTransport(API_KEY).send(makeRow());

    expect(outcome).toEqual({ ok: false, failure: { code: 'unknown_error', message: 'unknown_error', statusCode: null, retryable: false } });
  });

  it('ID 無しは invalid_response (再試行しない)', async () => {
    mocks.emailsSend.mockResolvedValueOnce({ data: null, error: null, headers: null });

    const outcome = await createResendTransport(API_KEY).send(makeRow());

    expect(outcome).toEqual({
      ok: false,
      failure: { code: 'invalid_response', message: 'Resend の応答にメール ID がありません', statusCode: null, retryable: false },
    });
  });

  it('例外は network_error で retryable (例外の文の中のアドレスはマスク)', async () => {
    mocks.emailsSend.mockRejectedValueOnce(new Error(`socket hang up while sending to ${RECIPIENT}`));

    const outcome = await createResendTransport(API_KEY).send(makeRow());

    expect(outcome).toEqual({
      ok: false,
      failure: { code: 'network_error', message: `socket hang up while sending to ${MASKED_RECIPIENT}`, statusCode: null, retryable: true },
    });
  });
});

describe('processEmailOutbox', () => {
  it('取った行を順に送り complete する', async () => {
    const rows = [makeRow({ id: '00000000-0000-4000-8000-000000000001' }), makeRow({ id: '00000000-0000-4000-8000-000000000002' })];
    const h = makeHarness(rows);

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(h.claim).toHaveBeenCalledWith('worker-1', EMAIL_OUTBOX_BATCH_SIZE, 120);
    expect(h.send.mock.calls.map(([row]) => row.id)).toEqual(rows.map((r) => r.id));
    expect(h.complete.mock.calls).toEqual([
      [rows[0].id, 'worker-1', `resend-${rows[0].id}`],
      [rows[1].id, 'worker-1', `resend-${rows[1].id}`],
    ]);
    expect(h.fail).not.toHaveBeenCalled();
    expect(summary).toEqual({ claimed: 2, sent: 2, requeued: 0, dead: 0, dead_codes: {}, stopped_early: false });
  });

  it('送信の間隔を空ける (2 通目の前に sleep。1 通目の前には待たない)', async () => {
    const h = makeHarness([makeRow(), makeRow({ id: '00000000-0000-4000-8000-000000000002' }), makeRow({ id: '00000000-0000-4000-8000-000000000003' })]);
    const order: string[] = [];
    h.sleep.mockImplementation(async (ms: number) => {
      order.push(`sleep:${ms}`);
    });
    h.send.mockImplementation(async (row: EmailOutboxClaimedRow) => {
      order.push(`send:${row.id.slice(-1)}`);
      return { ok: true, id: 'x' };
    });

    await processEmailOutbox(h.deps, RUN);

    expect(order).toEqual([
      'send:1',
      `sleep:${EMAIL_OUTBOX_SEND_INTERVAL_MS}`,
      'send:2',
      `sleep:${EMAIL_OUTBOX_SEND_INTERVAL_MS}`,
      'send:3',
    ]);
  });

  it('retryable の失敗は fail(queued) で requeued に数える。fail には n 回目の失敗の待ちと試行の上限を渡す', async () => {
    const h = makeHarness([makeRow({ attempts: 1 })]);
    const failure: EmailTransportFailure = { code: 'application_error', message: 'Service Unavailable', statusCode: 503, retryable: true };
    h.send.mockResolvedValueOnce({ ok: false, failure });
    h.fail.mockResolvedValueOnce('queued');

    const summary = await processEmailOutbox(h.deps, { ...RUN, maxAttempts: 4 });

    expect(h.fail).toHaveBeenCalledWith(makeRow().id, 'worker-1', failure, { maxAttempts: 4, retryAfterSeconds: 300 });
    expect(summary).toMatchObject({ claimed: 1, sent: 0, requeued: 1, dead: 0, dead_codes: {} });
    expect(h.log.warn).toHaveBeenCalledWith('メールの送信に失敗しました。時間をおいて再試行します', {
      outbox_id: makeRow().id,
      template: 'family_invite',
      recipient: MASKED_RECIPIENT,
      attempt: 2,
      error_code: 'application_error',
      status_code: 503,
      retryable: true,
    });
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('非 retryable は dead に数え error ログ (宛先はマスク)', async () => {
    const h = makeHarness([makeRow()]);
    const failure: EmailTransportFailure = { code: 'validation_error', message: 'domain is not verified', statusCode: 403, retryable: false };
    h.send.mockResolvedValueOnce({ ok: false, failure });
    h.fail.mockResolvedValueOnce('dead');

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(summary).toMatchObject({ claimed: 1, sent: 0, requeued: 0, dead: 1, dead_codes: { validation_error: 1 } });
    expect(h.log.error).toHaveBeenCalledTimes(1);
    const [message, error, meta] = h.log.error.mock.calls[0];
    expect(message).toBe('メールを届けられませんでした (dead)');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('domain is not verified');
    expect(meta).toEqual({
      outbox_id: makeRow().id,
      template: 'family_invite',
      recipient: MASKED_RECIPIENT,
      attempt: 1,
      error_code: 'validation_error',
      status_code: 403,
      retryable: false,
    });
    const logged = JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls]);
    expect(logged).not.toContain(RECIPIENT);
    expect(logged).not.toContain('テスト件名');
    expect(logged).not.toContain('テスト本文');
  });

  it('dead_codes はコードごとに数える', async () => {
    const rows = [1, 2, 3].map((n) => makeRow({ id: `00000000-0000-4000-8000-00000000000${n}` }));
    const h = makeHarness(rows);
    h.send
      .mockResolvedValueOnce({ ok: false, failure: { code: 'validation_error', message: 'a', statusCode: 403, retryable: false } })
      .mockResolvedValueOnce({ ok: false, failure: { code: 'validation_error', message: 'b', statusCode: 403, retryable: false } })
      .mockResolvedValueOnce({ ok: false, failure: { code: 'invalid_api_key', message: 'c', statusCode: 401, retryable: false } });
    h.fail.mockResolvedValue('dead');

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(summary.dead).toBe(3);
    expect(summary.dead_codes).toEqual({ validation_error: 2, invalid_api_key: 1 });
  });

  it('7 日より古い行は Resend を呼ばず expired で dead (停止リストも引かない)', async () => {
    const h = makeHarness([makeRow({ created_at: new Date(NOW - EMAIL_OUTBOX_QUEUED_MAX_AGE_MS - 1).toISOString() })]);
    h.fail.mockResolvedValueOnce('dead');

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(h.send).not.toHaveBeenCalled();
    expect(h.suppression).not.toHaveBeenCalled();
    expect(h.fail).toHaveBeenCalledWith(
      makeRow().id,
      'worker-1',
      { code: 'expired', message: '作成から 7 日を超えたため送りませんでした', statusCode: null, retryable: false },
      { maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS, retryAfterSeconds: 60 },
    );
    expect(summary).toMatchObject({ dead: 1, dead_codes: { expired: 1 } });
  });

  it('ちょうど 7 日の行はまだ送る (超えたものだけ expired)', async () => {
    const h = makeHarness([makeRow({ created_at: new Date(NOW - EMAIL_OUTBOX_QUEUED_MAX_AGE_MS).toISOString() })]);

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(summary.sent).toBe(1);
  });

  it('停止リストに載った宛先は Resend を呼ばず suppressed で dead', async () => {
    const h = makeHarness([makeRow()]);
    h.suppression.mockResolvedValueOnce({ status: 'suppressed', reason: 'bounce' });
    h.fail.mockResolvedValueOnce('dead');

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(h.suppression).toHaveBeenCalledWith(RECIPIENT);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.fail.mock.calls[0][2]).toEqual({
      code: 'suppressed',
      message: '宛先停止リストに載っている宛先のため送りませんでした',
      statusCode: null,
      retryable: false,
    });
    expect(summary).toMatchObject({ dead: 1, dead_codes: { suppressed: 1 } });
  });

  it('停止リストを引けなければ warn して送る', async () => {
    const h = makeHarness([makeRow()]);
    h.suppression.mockResolvedValueOnce({ status: 'lookup_failed', error: new Error('timeout') });

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(summary.sent).toBe(1);
    expect(h.log.warn).toHaveBeenCalledWith('宛先停止リストを引けなかったため、確かめずに送ります', {
      outbox_id: makeRow().id,
      template: 'family_invite',
      recipient: MASKED_RECIPIENT,
      attempt: 1,
    });
  });

  it('transport が例外を投げても network_error として fail し、次の行へ進む', async () => {
    const rows = [makeRow(), makeRow({ id: '00000000-0000-4000-8000-000000000002' })];
    const h = makeHarness(rows);
    h.send.mockRejectedValueOnce(new Error(`boom for ${RECIPIENT}`));

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(h.fail).toHaveBeenCalledWith(
      rows[0].id,
      'worker-1',
      { code: 'network_error', message: `boom for ${MASKED_RECIPIENT}`, statusCode: null, retryable: true },
      { maxAttempts: EMAIL_OUTBOX_MAX_ATTEMPTS, retryAfterSeconds: 60 },
    );
    expect(h.complete).toHaveBeenCalledWith(rows[1].id, 'worker-1', `resend-${rows[1].id}`);
    expect(summary).toMatchObject({ claimed: 2, sent: 1, requeued: 1 });
  });

  it('complete が false (取り直された・退会で伏せられた) なら sent に数えず warn', async () => {
    const h = makeHarness([makeRow()]);
    h.complete.mockResolvedValueOnce(false);

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(summary.sent).toBe(0);
    expect(h.log.warn).toHaveBeenCalledWith(
      '送れたが、行は別の worker に取り直されたか、退会で伏せられていました (記録は更新していません)',
      expect.objectContaining({ outbox_id: makeRow().id, recipient: MASKED_RECIPIENT }),
    );
  });

  it("fail が 'ignored' (行が無い・取り直された・退会で伏せられた) なら requeued にも dead にも数えず warn", async () => {
    const h = makeHarness([makeRow()]);
    h.send.mockResolvedValueOnce({ ok: false, failure: { code: 'validation_error', message: 'x', statusCode: 400, retryable: false } });
    h.fail.mockResolvedValueOnce('ignored');

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(summary).toMatchObject({ sent: 0, requeued: 0, dead: 0, dead_codes: {} });
    expect(h.log.warn).toHaveBeenCalledWith(
      '失敗の記録先の行が無い、別の worker に取り直された、または退会で伏せられていました',
      expect.objectContaining({ outbox_id: makeRow().id, error_code: 'validation_error' }),
    );
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('時間の予算を超えたら残りを送らず stopped_early (残りの行は complete も fail もしない)', async () => {
    const rows = [1, 2, 3].map((n) => makeRow({ id: `00000000-0000-4000-8000-00000000000${n}` }));
    const h = makeHarness(rows);
    const budget = 1000;
    h.send.mockImplementation(async (row: EmailOutboxClaimedRow) => {
      h.clock.now += budget + 1; // 1 通送るごとに予算を超える時間がたつ
      return { ok: true, id: `resend-${row.id}` };
    });

    const summary = await processEmailOutbox(h.deps, { ...RUN, runBudgetMs: budget });

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.fail).not.toHaveBeenCalled();
    expect(summary).toEqual({ claimed: 3, sent: 1, requeued: 0, dead: 0, dead_codes: {}, stopped_early: true });
  });

  it('予算ちょうどまでは続ける (超えたときだけ打ち切る)', async () => {
    const rows = [1, 2].map((n) => makeRow({ id: `00000000-0000-4000-8000-00000000000${n}` }));
    const h = makeHarness(rows);
    const budget = 1000;
    h.send.mockImplementation(async (row: EmailOutboxClaimedRow) => {
      h.clock.now += budget;
      return { ok: true, id: `resend-${row.id}` };
    });

    const summary = await processEmailOutbox(h.deps, { ...RUN, runBudgetMs: budget });

    expect(summary).toMatchObject({ sent: 2, stopped_early: false });
  });

  it('claim が 0 件なら何もしない', async () => {
    const h = makeHarness([]);

    const summary = await processEmailOutbox(h.deps, RUN);

    expect(summary).toEqual({ claimed: 0, sent: 0, requeued: 0, dead: 0, dead_codes: {}, stopped_early: false });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.suppression).not.toHaveBeenCalled();
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.log.info).not.toHaveBeenCalled();
    expect(h.log.warn).not.toHaveBeenCalled();
  });

  it('claim の失敗 (例外) はそのまま投げる (route が 500 にする)', async () => {
    const h = makeHarness([]);
    h.claim.mockRejectedValueOnce(new Error('claim_email_outbox failed: 42501'));

    await expect(processEmailOutbox(h.deps, RUN)).rejects.toThrow('claim_email_outbox failed: 42501');
  });

  it('リース・間隔・予算・期限の既定は定数 (120 秒・600ms・40 秒・7 日)', async () => {
    const h = makeHarness([makeRow()]);

    await processEmailOutbox(h.deps, RUN);

    expect(h.claim).toHaveBeenCalledWith('worker-1', EMAIL_OUTBOX_BATCH_SIZE, 120);
  });
});

describe('maskEmailAddress / redactEmailAddresses (send.ts から移した)', () => {
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

  it('マスクした宛先は、app_logs のサニタイザ ([email] への置換) に消されずに残る', () => {
    expect(maskSecrets({ recipient: maskEmailAddress(RECIPIENT) })).toEqual({ recipient: MASKED_RECIPIENT });
    expect(maskSecrets({ recipient: RECIPIENT })).toEqual({ recipient: '[email]' });
  });

  it('redactEmailAddresses: 文の中のアドレスをすべてマスクし、ほかの文字は変えない', () => {
    expect(redactEmailAddresses(`to ${RECIPIENT} (reply-to: boss@corp.example.jp)`)).toBe(
      `to ${MASKED_RECIPIENT} (reply-to: b***@corp.example.jp)`,
    );
    expect(redactEmailAddresses('アドレスなし')).toBe('アドレスなし');
  });
});
