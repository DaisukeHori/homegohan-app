/**
 * src/lib/admin/send-freeze-notification-email.ts の単体テスト (#2026。設計 docs/design/cross/24-freeze-notify-mail.md §7.4・§12)
 *
 * sendEmail は差し替える (send-ticket-reply-email.test.ts と同じ形)。sendEmail は Resend を呼ばず送信待ち (email_outbox) に登録するだけで、
 * sendEmail そのものは send.test.ts、送信 (再試行) は outbox.test.ts が受け持つ。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { EmailSendError, type SendEmailResult } from '@/lib/emails/send-result';
import type { FreezeNotificationLogger } from '@/lib/admin/send-freeze-notification-email';

const { mockSendEmail, mockGetUserById, mockListUsers, mockGetSupabaseAdmin } = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
  mockGetUserById: vi.fn(),
  mockListUsers: vi.fn(),
  mockGetSupabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mockSendEmail,
}));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: mockGetSupabaseAdmin,
}));

const {
  FREEZE_NOTIFICATION_EMAIL_TEMPLATE,
  FREEZE_NOTIFICATION_IDEMPOTENCY_PREFIX,
  freezeNotificationIdempotencyKey,
  sendFreezeNotificationEmail,
} = await import('@/lib/admin/send-freeze-notification-email');
const { ACCOUNT_FROZEN_EMAIL_TEMPLATE, renderAccountFrozenEmail } = await import('@/lib/emails/account/account-frozen');

const TARGET_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const TARGET_EMAIL = 'frozen-user@example.com';
const BAN_ID = 'a1b2c3d4-0000-4000-8000-0000000000aa';
const OUTBOX_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const FROZEN_AT = new Date('2026-10-25T01:00:00.000Z');
const UNBAN_AT = new Date('2026-11-01T01:00:00.000Z');
const OPERATOR_MESSAGE = '投稿内容について確認が取れるまで利用を停止しています。';

type LogEntry = { level: 'warn' | 'error'; message: string; error?: unknown; metadata?: Record<string, unknown> };

/** 呼ばれたログを配列に積む偽物のロガー */
function recordingLogger(): { logger: FreezeNotificationLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      warn: (message, metadata) => {
        entries.push({ level: 'warn', message, metadata });
      },
      error: (message, error, metadata) => {
        entries.push({ level: 'error', message, error, metadata });
      },
    },
  };
}

let log: ReturnType<typeof recordingLogger>;

const run = (overrides: { operatorMessage?: string | null; unbanAt?: Date | null; logger?: FreezeNotificationLogger } = {}) =>
  sendFreezeNotificationEmail({
    userId: TARGET_ID,
    banId: BAN_ID,
    frozenAt: FROZEN_AT,
    unbanAt: overrides.unbanAt === undefined ? UNBAN_AT : overrides.unbanAt,
    operatorMessage: overrides.operatorMessage === undefined ? null : overrides.operatorMessage,
    logger: overrides.logger ?? log.logger,
  });

/** sendEmail に渡した封筒 */
const sentEnvelope = () => mockSendEmail.mock.calls[0][0] as EmailEnvelope;

const skippedResult = (): SendEmailResult => ({
  ok: false,
  id: null,
  attempts: 0,
  skipped: true,
  error: new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED', null, 0, false),
});

const failedResult = (code: string, retryable: boolean): SendEmailResult => ({
  ok: false,
  id: null,
  attempts: 0,
  skipped: false,
  error: new EmailSendError(code, `EMAIL_${code.toUpperCase()}`, null, 0, retryable),
});

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  vi.stubEnv('EMAIL_FROM', '');
  log = recordingLogger();
  mockGetSupabaseAdmin.mockReturnValue({
    auth: { admin: { getUserById: mockGetUserById, listUsers: mockListUsers } },
  });
  mockGetUserById.mockResolvedValue({ data: { user: { id: TARGET_ID, email: TARGET_EMAIL } }, error: null });
  mockSendEmail.mockResolvedValue({ ok: true, id: OUTBOX_ID, attempts: 0, skipped: false, error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  mockGetSupabaseAdmin.mockReset();
  mockGetUserById.mockReset();
  mockListUsers.mockReset();
  mockSendEmail.mockReset();
});

describe('sendFreezeNotificationEmail: 送信待ちに登録できる場合 (cross/24 §7.4)', () => {
  it('N-1 本人の登録アドレス宛に renderAccountFrozenEmail の封筒を送り、sent と outbox_id を返す', async () => {
    const result = await run();

    expect(result).toEqual({ outcome: { status: 'sent' }, outbox_id: OUTBOX_ID });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(sentEnvelope()).toEqual(
      renderAccountFrozenEmail({ to_email: TARGET_EMAIL, frozen_at: FROZEN_AT, unban_at: UNBAN_AT, operator_message: null }),
    );
    expect(sentEnvelope().to).toBe(TARGET_EMAIL);
    expect(sentEnvelope().text).toContain('解除の予定: 2026年11月1日 10:00 (日本時間)');
    expect(log.entries).toEqual([]);
  });

  it("N-2 sendEmail の 2 つ目の引数は { userId, idempotencyKey: 'account-frozen:' + banId }", async () => {
    await run();

    expect(mockSendEmail.mock.calls[0][1]).toEqual({ userId: TARGET_ID, idempotencyKey: `account-frozen:${BAN_ID}` });
    // redactAfterSend は渡さない (秘密を含まない文面)
    expect(mockSendEmail.mock.calls[0][1]).not.toHaveProperty('redactAfterSend');
    expect(FREEZE_NOTIFICATION_IDEMPOTENCY_PREFIX).toBe('account-frozen:');
    expect(freezeNotificationIdempotencyKey(BAN_ID)).toBe(`account-frozen:${BAN_ID}`);
  });

  it('N-3 宛先は userId を auth.admin.getUserById で 1 人分だけ引く (listUsers は呼ばない)', async () => {
    await run();

    expect(mockGetUserById).toHaveBeenCalledTimes(1);
    expect(mockGetUserById).toHaveBeenCalledWith(TARGET_ID);
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it('N-4 operatorMessage を封筒の本文に入れ、null なら段が無い', async () => {
    await run({ operatorMessage: OPERATOR_MESSAGE });
    expect(sentEnvelope().text).toContain(`▼ 運営からのメッセージ\n${OPERATOR_MESSAGE}\n`);

    mockSendEmail.mockClear();
    await run({ operatorMessage: null });
    expect(sentEnvelope().text).not.toContain('運営からのメッセージ');
  });

  it('N-14 FREEZE_NOTIFICATION_EMAIL_TEMPLATE は封筒の template と同じ値', async () => {
    await run();

    expect(FREEZE_NOTIFICATION_EMAIL_TEMPLATE).toBe('account_frozen');
    expect(FREEZE_NOTIFICATION_EMAIL_TEMPLATE).toBe(ACCOUNT_FROZEN_EMAIL_TEMPLATE);
    expect(sentEnvelope().template).toBe(FREEZE_NOTIFICATION_EMAIL_TEMPLATE);
  });
});

describe('sendFreezeNotificationEmail: sendEmail が登録しなかった場合 (cross/24 §9.3 (b) 段 2)', () => {
  it('N-5 RESEND_API_KEY 未設定 (sendEmail が skipped): skipped / not_configured・outbox_id null・warn を残す', async () => {
    mockSendEmail.mockResolvedValue(skippedResult());

    await expect(run()).resolves.toEqual({ outcome: { status: 'skipped', reason: 'not_configured' }, outbox_id: null });
    expect(log.entries.map((entry) => entry.level)).toEqual(['warn']);
  });

  it('N-6 outbox_failed: failed / send_failed・error を残す', async () => {
    mockSendEmail.mockResolvedValue(failedResult('outbox_failed', true));

    await expect(run()).resolves.toEqual({ outcome: { status: 'failed', reason: 'send_failed' }, outbox_id: null });
    expect(log.entries.map((entry) => entry.level)).toEqual(['error']);
    expect(log.entries[0].metadata).toEqual({
      ban_id: BAN_ID,
      target_id: TARGET_ID,
      template: 'account_frozen',
      error_code: 'outbox_failed',
    });
  });

  it('N-7 suppressed: failed / send_failed・warn (error でない) を残す', async () => {
    mockSendEmail.mockResolvedValue(failedResult('suppressed', false));

    await expect(run()).resolves.toEqual({ outcome: { status: 'failed', reason: 'send_failed' }, outbox_id: null });
    expect(log.entries.map((entry) => entry.level)).toEqual(['warn']);
    expect(log.entries[0].metadata).toMatchObject({ ban_id: BAN_ID, error_code: 'suppressed' });
  });

  it('N-8 sendEmail が例外: failed / send_failed', async () => {
    mockSendEmail.mockRejectedValue(new Error('boom'));

    await expect(run()).resolves.toEqual({ outcome: { status: 'failed', reason: 'send_failed' }, outbox_id: null });
    expect(log.entries.map((entry) => entry.level)).toEqual(['error']);
  });
});

describe('sendFreezeNotificationEmail: 宛先が引けない場合 (cross/24 §9.3 (b) 段 1)', () => {
  it('N-9 getUserById が error: failed / no_recipient・sendEmail を呼ばない', async () => {
    mockGetUserById.mockResolvedValue({ data: { user: null }, error: { name: 'AuthApiError', status: 500, code: 'unexpected_failure' } });

    await expect(run()).resolves.toEqual({ outcome: { status: 'failed', reason: 'no_recipient' }, outbox_id: null });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(log.entries.map((entry) => entry.level)).toEqual(['error']);
    expect(log.entries[0].metadata).toEqual({
      ban_id: BAN_ID,
      target_id: TARGET_ID,
      template: 'account_frozen',
      error_code: 'unexpected_failure',
      error_status: 500,
      error_name: 'AuthApiError',
    });
  });

  it('N-10 email が無い (null / 空): failed / no_recipient・warn', async () => {
    for (const email of [null, '', undefined]) {
      log = recordingLogger();
      mockSendEmail.mockClear();
      mockGetUserById.mockResolvedValue({ data: { user: { id: TARGET_ID, email } }, error: null });

      await expect(run()).resolves.toEqual({ outcome: { status: 'failed', reason: 'no_recipient' }, outbox_id: null });
      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(log.entries.map((entry) => entry.level)).toEqual(['warn']);
    }
    // user そのものが無いときも同じ
    log = recordingLogger();
    mockGetUserById.mockResolvedValue({ data: { user: null }, error: null });
    await expect(run()).resolves.toEqual({ outcome: { status: 'failed', reason: 'no_recipient' }, outbox_id: null });
    expect(log.entries.map((entry) => entry.level)).toEqual(['warn']);
  });

  it('N-11 getUserById が例外・getSupabaseAdmin が例外: failed / no_recipient', async () => {
    mockGetUserById.mockRejectedValue(new Error('network'));
    await expect(run()).resolves.toEqual({ outcome: { status: 'failed', reason: 'no_recipient' }, outbox_id: null });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(log.entries.map((entry) => entry.level)).toEqual(['error']);

    log = recordingLogger();
    mockGetSupabaseAdmin.mockImplementation(() => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    });
    await expect(run()).resolves.toEqual({ outcome: { status: 'failed', reason: 'no_recipient' }, outbox_id: null });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(log.entries.map((entry) => entry.level)).toEqual(['error']);
  });
});

describe('sendFreezeNotificationEmail: ログと例外 (cross/24 §7.4・R-12)', () => {
  it('N-12 ログの metadata に宛先のアドレスを含めない (ban_id・target_id・template だけ)', async () => {
    const cases: Array<() => void> = [
      () => mockSendEmail.mockResolvedValue(skippedResult()),
      () => mockSendEmail.mockResolvedValue(failedResult('outbox_failed', true)),
      () => mockSendEmail.mockResolvedValue(failedResult('suppressed', false)),
      () => mockSendEmail.mockRejectedValue(new Error(`failed for ${TARGET_EMAIL}`)),
      () => mockGetUserById.mockResolvedValue({ data: { user: { id: TARGET_ID, email: null } }, error: null }),
    ];
    for (const arrange of cases) {
      log = recordingLogger();
      arrange();
      await run();
      expect(log.entries.length).toBeGreaterThan(0);
      for (const entry of log.entries) {
        expect(JSON.stringify(entry.metadata)).not.toContain(TARGET_EMAIL);
        expect(entry.message).not.toContain(TARGET_EMAIL);
        expect(entry.metadata).toMatchObject({ ban_id: BAN_ID, target_id: TARGET_ID, template: 'account_frozen' });
        const keys = Object.keys(entry.metadata ?? {}).filter((key) => !['ban_id', 'target_id', 'template'].includes(key));
        // 足してよいのはエラーの短い手がかり (コード・HTTP ステータス・名前) だけ
        for (const key of keys) expect(['error_code', 'error_status', 'error_name']).toContain(key);
      }
      mockSendEmail.mockReset();
      mockSendEmail.mockResolvedValue({ ok: true, id: OUTBOX_ID, attempts: 0, skipped: false, error: null });
      mockGetUserById.mockResolvedValue({ data: { user: { id: TARGET_ID, email: TARGET_EMAIL } }, error: null });
    }
  });

  it('N-13 ロガーが例外を投げても failed を返し、外に投げない', async () => {
    const throwingLogger: FreezeNotificationLogger = {
      warn: () => {
        throw new Error('logger broken');
      },
      error: () => {
        throw new Error('logger broken');
      },
    };
    mockSendEmail.mockResolvedValue(skippedResult());

    await expect(run({ logger: throwingLogger })).resolves.toEqual({ outcome: { status: 'failed', reason: 'send_failed' }, outbox_id: null });

    // 宛先が無い (warn) 道でも同じ
    mockGetUserById.mockResolvedValue({ data: { user: { id: TARGET_ID, email: null } }, error: null });
    await expect(run({ logger: throwingLogger })).resolves.toEqual({ outcome: { status: 'failed', reason: 'send_failed' }, outbox_id: null });
  });
});
