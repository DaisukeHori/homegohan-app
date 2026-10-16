/**
 * #1178 個人情報の請求 (DSR) のメール src/lib/data-subject-requests/notifications.ts の単体テスト (設計 cross/15 §6・§10・§15)
 * sendEmail と admin.auth.admin.getUserById をモックする。
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailEnvelope } from '@/lib/emails/envelope';
import type { SendEmailOptions } from '@/lib/emails/send';
import { EmailSendError, type SendEmailResult } from '@/lib/emails/send-result';
import { DSR_ADMIN_PATH, DSR_SETTINGS_PATH, type DsrNotificationRow } from '@/lib/data-subject-requests/core';
import type { DsrLogger } from '@/lib/data-subject-requests/service';

const sendEmailMock = vi.hoisted(() => vi.fn<(envelope: EmailEnvelope, options?: SendEmailOptions) => Promise<SendEmailResult>>());
vi.mock('@/lib/emails/send', () => ({ sendEmail: sendEmailMock }));

import {
  DSR_EMAIL_TEMPLATES,
  sendDsrOperatorNotice,
  sendDsrReceivedEmail,
  sendDsrResolvedEmail,
  sendDsrVerificationEmail,
} from '@/lib/data-subject-requests/notifications';

const SITE = 'https://app.example.test';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const EMAIL = 'requester-secret@example.com';
const OPERATOR_EMAIL = 'operator-secret@example.test';
const TOKEN = 'c'.repeat(64);
const DUE_AT = '2026-11-14T03:00:00.000Z';

const SENT: SendEmailResult = { ok: true, id: 'email-1', attempts: 1, skipped: false, error: null };

function row(overrides: Partial<DsrNotificationRow> = {}): DsrNotificationRow {
  return { id: ID, user_id: USER_ID, request_type: 'disclosure', status: 'received', due_at: DUE_AT, ...overrides };
}

type GetUserById = (id: string) => Promise<{ data: { user: { email?: string | null } | null } | null; error: unknown }>;

function makeAdmin(getUserById: GetUserById) {
  const fn = vi.fn(getUserById);
  const admin = { auth: { admin: { getUserById: fn } } } as unknown as SupabaseClient;
  return { admin, getUserById: fn };
}

function adminWithEmail(email: string | null = EMAIL) {
  return makeAdmin(async () => ({ data: { user: { email } }, error: null }));
}

function makeLog() {
  const info = vi.fn<DsrLogger['info']>();
  const warn = vi.fn<DsrLogger['warn']>();
  const error = vi.fn<DsrLogger['error']>();
  const log: DsrLogger = { info, warn, error };
  return { log, info, warn, error };
}

/** どのログの呼び出しにも宛先のアドレスが入っていない */
function expectNoAddressInLogs(logs: ReturnType<typeof makeLog>): void {
  const serialized = JSON.stringify([logs.info.mock.calls, logs.warn.mock.calls, logs.error.mock.calls]);
  expect(serialized).not.toContain(EMAIL);
  expect(serialized).not.toContain(OPERATOR_EMAIL);
}

/** 本人向け 3 通を同じ形で呼ぶ */
const REQUESTER_SENDERS = [
  {
    template: DSR_EMAIL_TEMPLATES.verification,
    send: (admin: SupabaseClient, r: DsrNotificationRow, log: DsrLogger) =>
      sendDsrVerificationEmail(admin, r, TOKEN, SITE, log),
    status: 'pending_verification' as const,
  },
  {
    template: DSR_EMAIL_TEMPLATES.received,
    send: (admin: SupabaseClient, r: DsrNotificationRow, log: DsrLogger) => sendDsrReceivedEmail(admin, r, SITE, log),
    status: 'received' as const,
  },
  {
    template: DSR_EMAIL_TEMPLATES.resolved,
    send: (admin: SupabaseClient, r: DsrNotificationRow, log: DsrLogger) => sendDsrResolvedEmail(admin, r, SITE, log),
    status: 'fulfilled' as const,
  },
];

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(SENT);
  vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', OPERATOR_EMAIL);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('本人向け 3 通 (本人確認・受付・完了)', () => {
  it.each(REQUESTER_SENDERS)('$template: 宛先は getUserById の email で、template 名が入る', async ({ template, send, status }) => {
    const { admin, getUserById } = adminWithEmail();
    const logs = makeLog();

    await expect(send(admin, row({ status }), logs.log)).resolves.toBeUndefined();

    expect(getUserById).toHaveBeenCalledWith(USER_ID);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const envelope = sendEmailMock.mock.calls[0][0];
    expect(envelope.to).toBe(EMAIL);
    expect(envelope.template).toBe(template);
    // 誰についてのメールか (email_outbox.user_id) に請求した本人を入れる (退会の伏せ字が user_id でも行を見つけられる。#1708)
    expect(sendEmailMock.mock.calls[0][1]).toStrictEqual({ userId: USER_ID });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it.each(REQUESTER_SENDERS)('$template: user_id が NULL (退会済み) なら getUserById も sendEmail も呼ばず info ログ', async ({ template, send, status }) => {
    const { admin, getUserById } = adminWithEmail();
    const logs = makeLog();

    await send(admin, row({ status, user_id: null }), logs.log);

    expect(getUserById).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(logs.info).toHaveBeenCalledTimes(1);
    expect(logs.info.mock.calls[0][1]).toStrictEqual({ dsr_request_id: ID, template });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it.each(REQUESTER_SENDERS)('$template: getUserById が error を返したら送らず warn (コードだけ)', async ({ template, send, status }) => {
    const { admin } = makeAdmin(async () => ({
      data: null,
      error: { code: 'unexpected_failure', status: 500, name: 'AuthApiError', message: `failed for ${EMAIL}` },
    }));
    const logs = makeLog();

    await send(admin, row({ status }), logs.log);

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0][1]).toStrictEqual({
      dsr_request_id: ID,
      template,
      error_code: 'unexpected_failure',
      error_status: 500,
      error_name: 'AuthApiError',
    });
    expectNoAddressInLogs(logs);
  });

  it.each(REQUESTER_SENDERS)('$template: エラーの手がかりは型が合うものだけ (文字列の code・数値の status・文字列の name)', async ({ template, send, status }) => {
    const { admin } = makeAdmin(async () => ({ data: null, error: { code: 401, status: '500', name: null } }));
    const logs = makeLog();

    await send(admin, row({ status }), logs.log);

    expect(logs.warn.mock.calls[0][1]).toStrictEqual({ dsr_request_id: ID, template });
  });

  it.each(REQUESTER_SENDERS)('$template: email が無い (null・空白) なら送らず warn', async ({ send, status }) => {
    for (const email of [null, '   ']) {
      sendEmailMock.mockClear();
      const { admin } = adminWithEmail(email);
      const logs = makeLog();

      await send(admin, row({ status }), logs.log);

      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(logs.warn).toHaveBeenCalledTimes(1);
    }
  });

  it.each(REQUESTER_SENDERS)('$template: getUserById が例外を投げても reject せず、送らず warn (エラーの名前だけを残す)', async ({ template, send, status }) => {
    const { admin } = makeAdmin(async () => {
      throw new Error(`boom ${EMAIL}`);
    });
    const logs = makeLog();

    await expect(send(admin, row({ status }), logs.log)).resolves.toBeUndefined();

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0][1]).toStrictEqual({ dsr_request_id: ID, template, error_name: 'Error' });
    expectNoAddressInLogs(logs);
  });

  it.each(REQUESTER_SENDERS)('$template: オブジェクトでない例外 (文字列・null) でも reject せず、手がかり無しで warn', async ({ template, send, status }) => {
    for (const thrown of ['boom', null]) {
      const { admin } = makeAdmin(async () => {
        throw thrown;
      });
      const logs = makeLog();

      await expect(send(admin, row({ status }), logs.log)).resolves.toBeUndefined();

      expect(logs.warn.mock.calls[0][1]).toStrictEqual({ dsr_request_id: ID, template });
    }
  });

  it.each(REQUESTER_SENDERS)('$template: sendEmail が { ok: false } (送れなかった) なら warn で resolve', async ({ template, send, status }) => {
    sendEmailMock.mockResolvedValue({
      ok: false,
      id: null,
      attempts: 4,
      skipped: false,
      error: new EmailSendError('rate_limit_exceeded', 'limited', 429, 4, true),
    });
    const { admin } = adminWithEmail();
    const logs = makeLog();

    await expect(send(admin, row({ status }), logs.log)).resolves.toBeUndefined();

    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0][1]).toStrictEqual({
      dsr_request_id: ID,
      template,
      error_code: 'rate_limit_exceeded',
      skipped: false,
      attempts: 4,
    });
    expectNoAddressInLogs(logs);
  });

  it.each(REQUESTER_SENDERS)('$template: sendEmail が skipped (RESEND_API_KEY 無し) でも warn', async ({ send, status }) => {
    sendEmailMock.mockResolvedValue({
      ok: false,
      id: null,
      attempts: 0,
      skipped: true,
      error: new EmailSendError('not_configured', 'no key', null, 0, false),
    });
    const { admin } = adminWithEmail();
    const logs = makeLog();

    await send(admin, row({ status }), logs.log);

    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0][1]).toMatchObject({ error_code: 'not_configured', skipped: true });
  });

  it.each(REQUESTER_SENDERS)('$template: sendEmail が例外を投げても reject せず warn', async ({ template, send, status }) => {
    sendEmailMock.mockRejectedValue(Object.assign(new TypeError(`network down for ${EMAIL}`), { code: 'ECONNRESET' }));
    const { admin } = adminWithEmail();
    const logs = makeLog();

    await expect(send(admin, row({ status }), logs.log)).resolves.toBeUndefined();

    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0][1]).toStrictEqual({
      dsr_request_id: ID,
      template,
      error_code: 'ECONNRESET',
      error_name: 'TypeError',
    });
    expectNoAddressInLogs(logs);
  });
});

describe('本人確認のメールの中身', () => {
  it('確認リンクは siteUrl + 確認画面のパスで、id と生のトークンが入る', async () => {
    const { admin } = adminWithEmail();
    await sendDsrVerificationEmail(admin, row({ status: 'pending_verification', due_at: null }), TOKEN, SITE, makeLog().log);

    const text = sendEmailMock.mock.calls[0][0].text;
    const link = text.split('\n').find((line) => line.startsWith(`${SITE}/`)) ?? '';
    const url = new URL(link);
    expect(url.pathname).toBe('/settings/data-requests/verify');
    expect(url.searchParams.get('id')).toBe(ID);
    expect(url.searchParams.get('token')).toBe(TOKEN);
  });
});

describe('受付・完了のメールの中身', () => {
  it('受付: 設定画面のリンクと期限 (日本時間の日付)', async () => {
    const { admin } = adminWithEmail();
    await sendDsrReceivedEmail(admin, row(), SITE, makeLog().log);
    const text = sendEmailMock.mock.calls[0][0].text;
    expect(text).toContain(`${SITE}${DSR_SETTINGS_PATH}`);
    expect(text).toContain('2026年11月14日');
  });

  it.each(['fulfilled', 'rejected'] as const)('完了 (%s): 結果のラベルと設定画面のリンク', async (status) => {
    const { admin } = adminWithEmail();
    await sendDsrResolvedEmail(admin, row({ status }), SITE, makeLog().log);
    const text = sendEmailMock.mock.calls[0][0].text;
    expect(text).toContain(`${SITE}${DSR_SETTINGS_PATH}`);
    expect(text).toContain(status === 'fulfilled' ? '結果: 対応済み' : '結果: 対応できず');
  });

  it.each(['pending_verification', 'received', 'in_progress', 'withdrawn'] as const)(
    '完了のメールは終わっていない・取り下げの行 (%s) では送らず warn (getUserById も呼ばない)',
    async (status) => {
      const { admin, getUserById } = adminWithEmail();
      const logs = makeLog();

      await expect(sendDsrResolvedEmail(admin, row({ status }), SITE, logs.log)).resolves.toBeUndefined();

      expect(getUserById).not.toHaveBeenCalled();
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(logs.warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe('運営への知らせ', () => {
  it('ADMIN_NOTIFICATION_EMAIL が未設定 (空) なら送らず warn', async () => {
    vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', '');
    const logs = makeLog();

    await expect(sendDsrOperatorNotice(row(), SITE, logs.log)).resolves.toBeUndefined();

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(logs.warn.mock.calls[0][1]).toStrictEqual({ dsr_request_id: ID, template: DSR_EMAIL_TEMPLATES.operatorNotice });
  });

  it('設定ありならそのアドレスへ 1 通。本文に請求者の情報 (user_id・ニックネーム・メールアドレス・内容) を含まない', async () => {
    const logs = makeLog();

    await sendDsrOperatorNotice(row({ request_type: 'erasure' }), SITE, logs.log);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const envelope = sendEmailMock.mock.calls[0][0];
    expect(envelope.to).toBe(OPERATOR_EMAIL);
    expect(envelope.template).toBe(DSR_EMAIL_TEMPLATES.operatorNotice);
    expect(envelope.subject).toContain('消去');
    expect(envelope.text).toContain(`${SITE}${DSR_ADMIN_PATH}/${ID}`);
    expect(envelope.text).not.toContain(USER_ID);
    expect(envelope.text).not.toContain(EMAIL);
    // 運営宛は本人の行ではないので userId を渡さない (渡すと、本人の退会で運営宛の行が伏せられ dead になる)
    expect(sendEmailMock.mock.calls[0][1]).toStrictEqual({});
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('退会済みの行 (user_id が NULL) でも運営には送る (宛先は固定のアドレス)', async () => {
    await sendDsrOperatorNotice(row({ user_id: null }), SITE, makeLog().log);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('sendEmail が { ok: false } でも例外でも reject せず warn。ログに宛先が入らない', async () => {
    sendEmailMock.mockResolvedValueOnce({
      ok: false,
      id: null,
      attempts: 1,
      skipped: false,
      error: new EmailSendError('validation_error', 'bad', 422, 1, false),
    });
    const first = makeLog();
    await expect(sendDsrOperatorNotice(row(), SITE, first.log)).resolves.toBeUndefined();
    expect(first.warn).toHaveBeenCalledTimes(1);
    expectNoAddressInLogs(first);

    sendEmailMock.mockRejectedValueOnce(new Error(`down ${OPERATOR_EMAIL}`));
    const second = makeLog();
    await expect(sendDsrOperatorNotice(row(), SITE, second.log)).resolves.toBeUndefined();
    expect(second.warn).toHaveBeenCalledTimes(1);
    expectNoAddressInLogs(second);
  });
});
