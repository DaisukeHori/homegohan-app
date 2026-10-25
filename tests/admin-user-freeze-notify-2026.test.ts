/**
 * #2026 運営の凍結 (POST /api/admin/users/{id}/freeze) の通知メール (設計 docs/design/cross/24-freeze-notify-mail.md §7.5・§9・§12)
 *
 * route の POST を本物で呼ぶ。DB は createSchemaDb (user_profiles・admin_audit_logs。tests/user-freeze-super-admin-race.test.ts と同じ)、
 * service_role の client は from と auth.admin.getUserById の偽物、sendEmail と構造化ログは差し替える。sender
 * (src/lib/admin/send-freeze-notification-email.ts) と文面 (src/lib/emails/account/account-frozen.ts) は本物を通す。
 *
 * 確認すること: 応答の data.notification・監査の details (notification_message・notification)・sendEmail の封筒と options・
 * 凍結が書けなかった道 (400 / 403 / 404 / 409) では宛先も引かず送らないこと・通知は凍結の UPDATE のあと、監査の前に 1 回だけ。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDb, type SchemaDb } from './helpers/schema-checked-db';
import { profileRow, uuid } from './helpers/route-world';
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { EmailSendError, type SendEmailResult } from '@/lib/emails/send-result';
import type { AccountFrozenEmailVars } from '@/lib/emails/account/account-frozen';

const { mockRequireRole, mockSendEmail, mockGetUserById, mockRenderAccountFrozenEmail, callOrder, loggedEntries } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSendEmail: vi.fn(),
  mockGetUserById: vi.fn(),
  mockRenderAccountFrozenEmail: vi.fn(),
  /** 通知 (宛先の引き当て・送信待ちへの登録) と監査の INSERT の呼ばれた順 */
  callOrder: [] as string[],
  /** route の構造化ログ */
  loggedEntries: [] as Array<{ level: string; message: string; metadata?: Record<string, unknown> }>,
}));

vi.mock('@/lib/auth/helpers', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: (...args: unknown[]) => {
    callOrder.push('sendEmail');
    return mockSendEmail(...args);
  },
}));

// 文面は本物を通し、渡された値 (凍結の日時・解除の予定) を確かめられるように呼び出しを記録する
vi.mock('@/lib/emails/account/account-frozen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/emails/account/account-frozen')>();
  mockRenderAccountFrozenEmail.mockImplementation(actual.renderAccountFrozenEmail);
  return { ...actual, renderAccountFrozenEmail: (vars: AccountFrozenEmailVars) => mockRenderAccountFrozenEmail(vars) };
});

vi.mock('@/lib/db-logger', () => {
  const logger = {
    debug: (message: string, metadata?: Record<string, unknown>) => loggedEntries.push({ level: 'debug', message, metadata }),
    info: (message: string, metadata?: Record<string, unknown>) => loggedEntries.push({ level: 'info', message, metadata }),
    warn: (message: string, metadata?: Record<string, unknown>) => loggedEntries.push({ level: 'warn', message, metadata }),
    error: (message: string, _error?: unknown, metadata?: Record<string, unknown>) => loggedEntries.push({ level: 'error', message, metadata }),
  };
  return {
    createLogger: () => ({ ...logger, withUser: () => logger }),
    generateRequestId: () => 'req_test',
  };
});

/** service_role の client が見る DB (利用者の行) */
let serviceDb: SchemaDb;
/** 運営本人のセッションの client が見る DB (監査ログ) */
let sessionDb: SchemaDb;
/** 凍結の UPDATE が DB に送られる直前に 1 回だけ実行する (別の運営の操作) */
let beforeProfileUpdate: (() => PromiseLike<unknown>) | null = null;

function serviceFrom(table: string) {
  const query = serviceDb.from(table);
  if (table !== 'user_profiles') return query;
  let isUpdate = false;
  const update = query.update.bind(query);
  query.update = (values) => {
    isUpdate = true;
    return update(values);
  };
  type Result = Awaited<ReturnType<typeof query.maybeSingle>>;
  const maybeSingle = query.maybeSingle.bind(query);
  query.maybeSingle = async (): Promise<Result> => {
    if (isUpdate && beforeProfileUpdate) {
      const interleave = beforeProfileUpdate;
      beforeProfileUpdate = null;
      await interleave();
    }
    return maybeSingle();
  };
  return query;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      from: (table: string) => {
        if (table === 'admin_audit_logs') callOrder.push('audit');
        return sessionDb.from(table);
      },
    }),
  getSupabaseAdmin: () => ({
    from: serviceFrom,
    auth: {
      admin: {
        getUserById: (...args: unknown[]) => {
          callOrder.push('getUserById');
          return mockGetUserById(...args);
        },
      },
    },
  }),
}));

const { POST } = await import('@/app/api/admin/users/[id]/freeze/route');
const { FREEZE_NOTIFICATION_MESSAGE_MAX_LENGTH } = await import('@/lib/admin/users-schemas');

const ACTOR_ID = uuid(1);
const TARGET_ID = uuid(50);
const TARGET_EMAIL = 'frozen-user@example.com';
const OUTBOX_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const ADMIN = { id: ACTOR_ID, email: 'admin@example.com', roles: ['admin'], organization_id: null };
const SUPER_ADMIN = { ...ADMIN, roles: ['super_admin'] };
const DURATION_DAYS = 7;
const OPERATOR_MESSAGE = '投稿内容について確認が取れるまで利用を停止しています。';
const BASE_BODY = { ban_type: 'temporary', reason_category: 'spam', reason_detail: '大量の投稿', duration_days: DURATION_DAYS };

/** 応答の本文 (成功は data、失敗は error。読む側で使う分だけ) */
type ApiBody = { data: { ban_id: string; unban_at: string | null; notification?: unknown }; error: { code: string } };
type Details = Record<string, unknown>;

function freeze(body: Record<string, unknown> = BASE_BODY, id = TARGET_ID) {
  return POST(
    new Request(`http://localhost/api/admin/users/${id}/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const targetNow = () => serviceDb.rows('user_profiles').find((row) => row.id === TARGET_ID);
const auditRows = () => sessionDb.rows('admin_audit_logs');
const auditDetails = (index = 0) => auditRows()[index].details as Details;
const sentEnvelope = (index = 0) => mockSendEmail.mock.calls[index][0] as EmailEnvelope;
const sentOptions = (index = 0) => mockSendEmail.mock.calls[index][1] as Details;
const renderVars = (index = 0) => mockRenderAccountFrozenEmail.mock.calls[index][0] as AccountFrozenEmailVars;

function failedResult(code: string, retryable: boolean): SendEmailResult {
  return { ok: false, id: null, attempts: 0, skipped: false, error: new EmailSendError(code, `EMAIL_${code.toUpperCase()}`, null, 0, retryable) };
}

/** 凍結が書けなかった (400 / 403 / 404 / 409) ときに、宛先も引かず送らず、監査も残さないこと */
function expectNoNotificationAndNoAudit() {
  expect(mockGetUserById).not.toHaveBeenCalled();
  expect(mockSendEmail).not.toHaveBeenCalled();
  expect(auditRows()).toHaveLength(0);
}

beforeEach(() => {
  mockRequireRole.mockReset();
  mockSendEmail.mockReset();
  mockGetUserById.mockReset();
  mockRenderAccountFrozenEmail.mockClear();
  callOrder.length = 0;
  loggedEntries.length = 0;
  beforeProfileUpdate = null;
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  mockRequireRole.mockResolvedValue(ADMIN);
  mockGetUserById.mockResolvedValue({ data: { user: { id: TARGET_ID, email: TARGET_EMAIL } }, error: null });
  mockSendEmail.mockResolvedValue({ ok: true, id: OUTBOX_ID, attempts: 0, skipped: false, error: null });
  serviceDb = createSchemaDb({ tables: { user_profiles: [profileRow(TARGET_ID, { roles: ['user'] })] } });
  sessionDb = createSchemaDb({ tables: { admin_audit_logs: [] } });
});

describe('POST /api/admin/users/{id}/freeze: 通知メールを送る (cross/24 §9.1 P-2・P-3)', () => {
  it('R-1 notify_user 省略: 凍結のあと sendEmail が account_frozen の封筒で 1 回呼ばれ、200 の data.notification が sent、監査の details に notification { sent, null, outbox_id } と notification_message null', async () => {
    const res = await freeze();
    expect(res.status).toBe(200);
    const json = (await res.json()) as ApiBody;
    expect(json.data).toEqual({ ban_id: expect.any(String), unban_at: expect.any(String), notification: { status: 'sent' } });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(sentEnvelope().template).toBe('account_frozen');
    expect(sentEnvelope().to).toBe(TARGET_EMAIL);
    expect(sentEnvelope().subject).toBe('【ほめゴハン】アカウントが凍結されました');
    expect(sentEnvelope().text).toContain('凍結の種類: 一時的な凍結');
    expect(sentEnvelope().text).not.toContain('運営からのメッセージ');
    expect(sentOptions()).toEqual({ userId: TARGET_ID, idempotencyKey: `account-frozen:${json.data.ban_id}` });
    expect(mockGetUserById).toHaveBeenCalledWith(TARGET_ID);

    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0].action_type).toBe('admin.user.ban');
    expect(auditDetails()).toEqual({
      ban_id: json.data.ban_id,
      ban_type: 'temporary',
      reason_category: 'spam',
      reason_detail: '大量の投稿',
      duration_days: DURATION_DAYS,
      notify_user: true,
      unban_at: json.data.unban_at,
      notification_message: null,
      notification: { status: 'sent', reason: null, outbox_id: OUTBOX_ID },
    });
    // 宛先のメールアドレスは監査に残さない
    expect(JSON.stringify(auditRows()[0])).not.toContain(TARGET_EMAIL);
  });

  it('R-2 notification_message あり: 本文に段が入り、監査の notification_message に trim 後の文', async () => {
    const res = await freeze({ ...BASE_BODY, notify_user: true, notification_message: `  ${OPERATOR_MESSAGE}\n  ` });
    expect(res.status).toBe(200);
    expect(sentEnvelope().text).toContain(`▼ 運営からのメッセージ\n${OPERATOR_MESSAGE}\n`);
    expect(renderVars().operator_message).toBe(OPERATOR_MESSAGE);
    expect(auditDetails().notification_message).toBe(OPERATOR_MESSAGE);
  });

  it('R-4 notification_message が空白だけ: 「無し」として扱う (段なし・監査 null)', async () => {
    const res = await freeze({ ...BASE_BODY, notification_message: '   \n ' });
    expect(res.status).toBe(200);
    expect(renderVars().operator_message).toBeNull();
    expect(sentEnvelope().text).not.toContain('運営からのメッセージ');
    expect(auditDetails().notification_message).toBeNull();
    expect(auditDetails().notification).toEqual({ status: 'sent', reason: null, outbox_id: OUTBOX_ID });
  });
});

describe('POST /api/admin/users/{id}/freeze: notify_user が false (cross/24 §9.1 P-1)', () => {
  it('R-3 notify_user false: getUserById も sendEmail も呼ばれず、not_requested。notification_message を送っても監査は null', async () => {
    const res = await freeze({ ...BASE_BODY, notify_user: false, notification_message: OPERATOR_MESSAGE });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ApiBody).data.notification).toEqual({ status: 'not_requested' });
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
    expect(auditDetails()).toMatchObject({
      notify_user: false,
      notification_message: null,
      notification: { status: 'not_requested', reason: null, outbox_id: null },
    });
  });
});

describe('POST /api/admin/users/{id}/freeze: 凍結しないときは送らない (cross/24 §9.1 P-8〜P-10・§9.3 (a))', () => {
  it('R-5 notification_message が 1001 文字・ban_type temporary で duration_days 無し: どちらも 400 VALIDATION_ERROR で凍結しない・送らない・監査なし', async () => {
    const tooLong = await freeze({ ...BASE_BODY, notification_message: 'あ'.repeat(FREEZE_NOTIFICATION_MESSAGE_MAX_LENGTH + 1) });
    expect(tooLong.status).toBe(400);
    expect(((await tooLong.json()) as ApiBody).error.code).toBe('VALIDATION_ERROR');

    const noDuration = await freeze({ ban_type: 'temporary', reason_category: 'spam', reason_detail: '大量の投稿' });
    expect(noDuration.status).toBe(400);
    expect(((await noDuration.json()) as ApiBody).error.code).toBe('VALIDATION_ERROR');

    expect(targetNow()?.frozen_at).toBeNull();
    expectNoNotificationAndNoAudit();

    // 上限ちょうど (前後の空白は数えない) は通る
    const exact = await freeze({ ...BASE_BODY, notification_message: ` ${'あ'.repeat(FREEZE_NOTIFICATION_MESSAGE_MAX_LENGTH)} ` });
    expect(exact.status).toBe(200);
    expect(auditDetails().notification_message).toBe('あ'.repeat(FREEZE_NOTIFICATION_MESSAGE_MAX_LENGTH));
  });

  it('R-6 対象が super_admin (403)・UPDATE が 0 行 (409)・対象なし (404): getUserById も sendEmail も呼ばれない', async () => {
    serviceDb = createSchemaDb({ tables: { user_profiles: [profileRow(TARGET_ID, { roles: ['user', 'super_admin'] })] } });
    const protectedRes = await freeze();
    expect(protectedRes.status).toBe(403);
    expect(((await protectedRes.json()) as ApiBody).error.code).toBe('OP_TARGET_PROTECTED');
    expectNoNotificationAndNoAudit();

    serviceDb = createSchemaDb({ tables: { user_profiles: [profileRow(TARGET_ID, { roles: ['user'] })] } });
    beforeProfileUpdate = () => serviceDb.from('user_profiles').update({ roles: ['user', 'super_admin'] }).eq('id', TARGET_ID);
    const staleRes = await freeze();
    expect(staleRes.status).toBe(409);
    expect(((await staleRes.json()) as ApiBody).error.code).toBe('CONFLICT_STALE_DATA');
    expect(targetNow()?.frozen_at).toBeNull();
    expectNoNotificationAndNoAudit();

    const missingRes = await freeze(BASE_BODY, uuid(99));
    expect(missingRes.status).toBe(404);
    const notUuidRes = await freeze(BASE_BODY, 'not-a-uuid');
    expect(notUuidRes.status).toBe(404);
    expectNoNotificationAndNoAudit();
  });

  it('R-14 notification_message に NULL 文字: 400 INVALID_CHARACTER で凍結しない・getUserById も sendEmail も呼ばれない', async () => {
    const res = await freeze({ ...BASE_BODY, notification_message: 'メッセージ\u0000' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiBody).error.code).toBe('INVALID_CHARACTER');
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(targetNow()?.frozen_at).toBeNull();
    expectNoNotificationAndNoAudit();
  });
});

describe('POST /api/admin/users/{id}/freeze: 送れなくても凍結は 200 (cross/24 §9.1 P-4〜P-7)', () => {
  it('R-7 getUserById が email 無し: 200・failed / no_recipient・監査に同じ・sendEmail を呼ばない', async () => {
    mockGetUserById.mockResolvedValue({ data: { user: { id: TARGET_ID, email: null } }, error: null });
    const res = await freeze();
    expect(res.status).toBe(200);
    expect(((await res.json()) as ApiBody).data.notification).toEqual({ status: 'failed', reason: 'no_recipient' });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
    expect(auditDetails().notification).toEqual({ status: 'failed', reason: 'no_recipient', outbox_id: null });
    expect(loggedEntries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('R-8 sendEmail が skipped: 200・skipped / not_configured', async () => {
    mockSendEmail.mockResolvedValue({
      ok: false,
      id: null,
      attempts: 0,
      skipped: true,
      error: new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED', null, 0, false),
    });
    const res = await freeze();
    expect(res.status).toBe(200);
    expect(((await res.json()) as ApiBody).data.notification).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(auditDetails().notification).toEqual({ status: 'skipped', reason: 'not_configured', outbox_id: null });
  });

  it('R-9 sendEmail が outbox_failed: 200・failed / send_failed・凍結は済んでいる (frozen_at あり)', async () => {
    mockSendEmail.mockResolvedValue(failedResult('outbox_failed', true));
    const res = await freeze();
    expect(res.status).toBe(200);
    expect(((await res.json()) as ApiBody).data.notification).toEqual({ status: 'failed', reason: 'send_failed' });
    expect(targetNow()?.frozen_at).toEqual(expect.any(String));
    expect(auditDetails().notification).toEqual({ status: 'failed', reason: 'send_failed', outbox_id: null });
    expect(loggedEntries.some((entry) => entry.level === 'error')).toBe(true);
    for (const entry of loggedEntries) expect(JSON.stringify(entry)).not.toContain(TARGET_EMAIL);
  });
});

describe('POST /api/admin/users/{id}/freeze: 凍結の日時と順番 (cross/24 §7.5 (3)(4))', () => {
  it('R-10 UPDATE の frozen_at と封筒の frozen_at が同じ時刻、unban_at が frozen_at + duration_days', async () => {
    const res = await freeze();
    expect(res.status).toBe(200);
    const vars = renderVars();
    const frozenAt = targetNow()?.frozen_at as string;
    expect(vars.frozen_at.toISOString()).toBe(frozenAt);
    const expectedUnban = new Date(frozenAt);
    expectedUnban.setDate(expectedUnban.getDate() + DURATION_DAYS);
    expect(vars.unban_at?.toISOString()).toBe(expectedUnban.toISOString());
    expect(targetNow()?.unban_at).toBe(expectedUnban.toISOString());
    expect(((await res.json()) as ApiBody).data.unban_at).toBe(expectedUnban.toISOString());
  });

  it('R-11 permanent: 封筒の unban_at が null', async () => {
    mockRequireRole.mockResolvedValue(SUPER_ADMIN);
    const res = await freeze({ ban_type: 'permanent', reason_category: 'abuse', reason_detail: '不正な決済' });
    expect(res.status).toBe(200);
    expect(renderVars().unban_at).toBeNull();
    expect(sentEnvelope().text).toContain('凍結の種類: 無期限の凍結\n解除の予定はありません。');
    expect(((await res.json()) as ApiBody).data.unban_at).toBeNull();
  });

  it('R-12 recordAdminAudit は通知のあとに 1 回だけ (順番)', async () => {
    const res = await freeze();
    expect(res.status).toBe(200);
    expect(callOrder).toEqual(['getUserById', 'sendEmail', 'audit']);
    expect(auditRows()).toHaveLength(1);
  });

  it('R-13 凍結中の対象をもう一度凍結: 200・sendEmail が 2 回目も呼ばれ、2 回目の idempotencyKey は新しい ban_id の account-frozen:<ban_id> で 1 回目と違う', async () => {
    const first = (await (await freeze()).json()) as ApiBody;
    const secondRes = await freeze({ ...BASE_BODY, duration_days: DURATION_DAYS * 2 });
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as ApiBody;

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(second.data.ban_id).not.toBe(first.data.ban_id);
    expect(sentOptions(0).idempotencyKey).toBe(`account-frozen:${first.data.ban_id}`);
    expect(sentOptions(1).idempotencyKey).toBe(`account-frozen:${second.data.ban_id}`);
    expect(sentOptions(1).idempotencyKey).not.toBe(sentOptions(0).idempotencyKey);
    expect(auditRows()).toHaveLength(2);
    expect(auditDetails(1).ban_id).toBe(second.data.ban_id);
  });
});
