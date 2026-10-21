/**
 * 退会の完了メール (#1152) の単体テスト
 *
 * 退会 (src/lib/account-deletion.ts の deleteAccount = POST /api/account/delete の本体) が成功したときに、
 * 本人のメールアドレスへ完了メールを 1 通だけ送る (src/lib/account-deletion-notification.ts)。
 * Supabase はメモリ上の偽物、送信 (sendEmail) は差し替え。確かめること:
 *   - 成功したときに 1 回だけ送る。宛先は削除の前に getUserById で控えた本人の登録アドレス
 *   - 順番: 宛先を引くのは確認 (409) の後・記録を伏せる (prepare) 前。送るのは deleteUser が成功した後
 *   - 409 (組織のオーナー・家族の代表者)・途中の失敗 (500)・すでに消えていたユーザーのやり直しでは送らない
 *   - 送信の失敗 (送れなかった・例外・時間切れ) でも退会は成功のまま (route は 200)。失敗はログに残す
 *   - ログに生のメールアドレスも user_id も出さない
 *   - 文面: 件名・退会日時 (日本時間)・問い合わせ先・ストアの購読は退会で解約されないことの注意と各ストアの定期購読の管理のページ
 *     (STORE_SUBSCRIPTION_DELETION_NOTICE・STORE_SUBSCRIPTION_MANAGEMENT_URL。#1912。第三者に退会させられた本人は退会の確認の文を見ていない)
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  getUser: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  /** route 経由のとき (createLogger) のログ */
  routeLogs: [] as Array<{ level: string; name: string; message: string; error?: unknown; metadata?: unknown; userId?: string }>,
}));

// 送信だけを差し替える (maskEmailAddress などは本物)
vi.mock('@/lib/emails/send', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/emails/send')>();
  return { ...original, sendEmail: mocks.sendEmail };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));

// 退会の段階 billing / billing_recheck (billing/01 §11)。route 経由の it は deleteAccount に billing を渡せないので、既定の実装を
// モジュールごと差し替える (既定の実装は service_role の client と Stripe の鍵を要る)。直接呼ぶ it は run() で偽物を渡す
vi.mock('@/lib/billing/account-deletion', () => ({
  defaultAccountDeletionBilling: {
    cancelForAccountDeletion: async () => ({ cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' }),
  },
}));

vi.mock('@/lib/db-logger', () => {
  const make = (name: string, userId?: string) => ({
    debug: vi.fn(),
    info: (message: string, metadata?: unknown) => mocks.routeLogs.push({ level: 'info', name, message, metadata, userId }),
    warn: (message: string, metadata?: unknown) => mocks.routeLogs.push({ level: 'warn', name, message, metadata, userId }),
    error: (message: string, error?: unknown, metadata?: unknown) =>
      mocks.routeLogs.push({ level: 'error', name, message, error, metadata, userId }),
  });
  return {
    createLogger: (name: string) => ({ ...make(name), withUser: (userId: string) => make(name, userId) }),
    generateRequestId: () => 'req_route_email',
  };
});

import { deleteAccount, type AccountDeletionAdmin, type AccountDeletionLogger } from '../src/lib/account-deletion';
import {
  ACCOUNT_DELETED_EMAIL_TEMPLATE,
  notifyAccountDeleted,
  readAccountDeletionEmail,
} from '../src/lib/account-deletion-notification';
import {
  IAP_STORE_LABELS,
  PURCHASE_STORES,
  STORE_SUBSCRIPTION_DELETION_NOTICE,
  STORE_SUBSCRIPTION_MANAGEMENT_URL,
} from '@homegohan/shared';
import {
  accountDeletedStoreSubscriptionNotice,
  formatAccountDeletedAt,
  renderAccountDeletedEmail,
} from '../src/lib/emails/account/account-deleted';
import { EmailEnvelopeSchema, type EmailEnvelope } from '../src/lib/emails/envelope';
import { EmailSendError } from '../src/lib/emails/send-result';
import { DEFAULT_SUPPORT_EMAIL } from '../src/lib/site-config';
import { POST } from '../src/app/api/account/delete/route';

const USER = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'Taro.Yamada@example.com';
const REQUEST_ID = 'req_email_1';
/** 2026-10-10 00:05 (日本時間) */
const DELETED_AT = new Date('2026-10-09T15:05:00.000Z');

interface World {
  calls: string[];
  owner: boolean;
  representative: boolean;
  getUserById: { email?: string | null; error?: { message: string; status?: number; code?: string } | null; throws?: boolean };
  prepareError: { message: string } | null;
  storageListError: { message: string } | null;
  /** 削除の実行記録 (#1562) を始める RPC の失敗 */
  recordError: { message: string } | null;
  deleteUserError: { message: string; status?: number; code?: string } | null;
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    calls: [],
    owner: false,
    representative: false,
    getUserById: { email: EMAIL },
    prepareError: null,
    storageListError: null,
    recordError: null,
    deleteUserError: null,
    ...overrides,
  };
}

function makeAdmin(world: World): AccountDeletionAdmin {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'limit', 'not', 'order', 'range']) b[method] = () => b;
    b.then = (resolve: (value: unknown) => unknown) => {
      world.calls.push(`from:${table}`);
      const blocked = (table === 'organizations' && world.owner) || (table === 'family_groups' && world.representative);
      return resolve({ data: blocked ? [{ id: `${table}-1`, name: 'テスト' }] : [], error: null });
    };
    return b;
  };
  return {
    from: (table: string) => builder(table),
    rpc: async (name: string) => {
      world.calls.push(`rpc:${name}`);
      if (name === 'prepare_account_deletion' && world.prepareError) return { data: null, error: world.prepareError };
      if (name === 'begin_account_deletion_record') {
        // 削除の実行記録 (#1562)。記録の id を返す
        return world.recordError ? { data: null, error: world.recordError } : { data: 'deletion-record-1', error: null };
      }
      return { data: null, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        list: async () => {
          world.calls.push(`storage.list:${bucket}`);
          return world.storageListError ? { data: null, error: world.storageListError } : { data: [], error: null };
        },
        remove: async () => ({ data: [], error: null }),
      }),
    },
    auth: {
      admin: {
        getUserById: async () => {
          world.calls.push('auth.getUserById');
          if (world.getUserById.throws) throw new Error('auth api is down');
          if (world.getUserById.error) return { data: { user: null }, error: world.getUserById.error };
          return { data: { user: { id: USER, email: world.getUserById.email } }, error: null };
        },
        deleteUser: async () => {
          world.calls.push('auth.deleteUser');
          return { data: null, error: world.deleteUserError };
        },
      },
    },
  } as unknown as AccountDeletionAdmin;
}

function makeLogger() {
  const entries: Array<{ level: string; message: string; metadata?: unknown; error?: unknown; viaUser: boolean }> = [];
  const make = (viaUser: boolean) => ({
    debug: vi.fn(),
    info: (message: string, metadata?: unknown) => entries.push({ level: 'info', message, metadata, viaUser }),
    warn: (message: string, metadata?: unknown) => entries.push({ level: 'warn', message, metadata, viaUser }),
    error: (message: string, error?: unknown, metadata?: unknown) =>
      entries.push({ level: 'error', message, error, metadata, viaUser }),
  });
  const logger = { ...make(false), withUser: () => make(true) } as unknown as AccountDeletionLogger;
  return { logger, entries };
}

/** ログ (メッセージ・メタデータ・エラーの文) をまとめて文字列にする。生のアドレスが混ざっていないかを見る */
function serializeLogs(entries: ReadonlyArray<{ message: string; metadata?: unknown; error?: unknown }>): string {
  return JSON.stringify(
    entries.map((entry) => ({
      message: entry.message,
      metadata: entry.metadata,
      error: entry.error instanceof Error ? `${entry.error.name}: ${entry.error.message}` : entry.error,
    })),
  );
}

const SENT = { ok: true, id: 'email-1', attempts: 1, skipped: false, error: null };

let world: World;
let logs: ReturnType<typeof makeLogger>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.routeLogs.length = 0;
  world = makeWorld();
  logs = makeLogger();
  mocks.sendEmail.mockImplementation(async () => {
    world.calls.push('sendEmail');
    return SENT;
  });
});

function run() {
  return deleteAccount({
    userId: USER,
    admin: makeAdmin(world),
    requestId: REQUEST_ID,
    logger: logs.logger,
    now: () => DELETED_AT,
    // billing/01 §11 の段階 billing / billing_recheck は偽物にする (既定の実装は service_role の client と Stripe の鍵を要る)
    billing: { cancelForAccountDeletion: async () => ({ cancelled_subscriptions: 0, expired_checkout_sessions: 0, customer: 'none' }) },
  });
}

function sentEnvelopes(): EmailEnvelope[] {
  return mocks.sendEmail.mock.calls.map((call) => call[0] as EmailEnvelope);
}

describe('退会の完了メール: 成功したときに 1 回だけ送る', () => {
  it('退会が成功したら、削除の前に控えた本人のアドレスへ完了メールを 1 通送る', async () => {
    expect(await run()).toEqual({ ok: true });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const [envelope] = sentEnvelopes();
    expect(envelope.to).toBe(EMAIL);
    expect(envelope.template).toBe(ACCOUNT_DELETED_EMAIL_TEMPLATE);
    expect(envelope.subject).toBe('【ほめゴハン】退会が完了しました');
    expect(envelope.text).toContain('2026年10月10日 00:05 (日本時間)');
  });

  it('完了メールは redactAfterSend: true で登録する (sendEmail の 2 つ目の引数。userId は渡さない)', async () => {
    await run();

    // #1193 送信待ち (email_outbox) の行は、送れたとき・届けられなかったときに宛先・件名・本文を伏せる (R-10)
    expect(mocks.sendEmail.mock.calls[0][1]).toEqual({ redactAfterSend: true });
    expect(mocks.sendEmail.mock.calls[0][1]).not.toHaveProperty('userId');
  });

  it('順番: 宛先を引くのは確認の後・記録を伏せる (prepare) 前。送るのは deleteUser の成功の後', async () => {
    await run();

    const at = (call: string) => world.calls.indexOf(call);
    expect(at('auth.getUserById')).toBeGreaterThan(at('from:family_groups'));
    expect(at('auth.getUserById')).toBeLessThan(at('rpc:prepare_account_deletion'));
    expect(at('sendEmail')).toBeGreaterThan(at('auth.deleteUser'));
    expect(world.calls[world.calls.length - 1]).toBe('sendEmail');
    expect(world.calls.filter((call) => call === 'sendEmail')).toHaveLength(1);
    expect(world.calls.filter((call) => call === 'auth.getUserById')).toHaveLength(1);
  });

  it('成功のログ (account deleted) が残り、ログには生のアドレスも user_id も出ない', async () => {
    await run();

    expect(logs.entries.some((entry) => entry.message === 'account deleted')).toBe(true);
    const serialized = serializeLogs(logs.entries);
    expect(serialized.toLowerCase()).not.toContain(EMAIL.toLowerCase());
    expect(serialized).not.toContain(USER);
  });
});

describe('退会の完了メール: 送らない場合', () => {
  it('組織のオーナー (409) では送らない。宛先も引かない', async () => {
    world.owner = true;
    expect(await run()).toMatchObject({ ok: false, status: 409, error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(world.calls).not.toContain('auth.getUserById');
  });

  it('家族の代表者 (409) では送らない。宛先も引かない', async () => {
    world.representative = true;
    expect(await run()).toMatchObject({ ok: false, status: 409, error: 'ACCOUNT_DELETE_BLOCKED_FAMILY_REPRESENTATIVE' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(world.calls).not.toContain('auth.getUserById');
  });

  it.each([
    ['prepare', (w: World) => { w.prepareError = { message: 'db down' }; }],
    ['storage', (w: World) => { w.storageListError = { message: 'storage down' }; }],
    ['record', (w: World) => { w.recordError = { message: 'db down' }; }],
    ['delete_user', (w: World) => { w.deleteUserError = { message: 'auth down', status: 500, code: 'unexpected_failure' }; }],
  ] as const)('途中の失敗 (%s で 500) では送らない', async (step, breakWorld) => {
    breakWorld(world);
    expect(await run()).toMatchObject({ ok: false, status: 500, error: 'ACCOUNT_DELETE_FAILED', step });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('すでに消えていたユーザーの退会のやり直し (deleteUser が 404) では送らない (最初の退会で送っている)', async () => {
    world.deleteUserError = { message: 'User not found', status: 404, code: 'user_not_found' };
    expect(await run()).toEqual({ ok: true });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('宛先を引いたときにユーザーがもういない (404) なら、退会は続けて送らない。警告も出さない', async () => {
    world.getUserById = { error: { message: 'User not found', status: 404, code: 'user_not_found' } };
    world.deleteUserError = { message: 'User not found', status: 404, code: 'user_not_found' };
    expect(await run()).toEqual({ ok: true });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(logs.entries.some((entry) => /completion email/.test(entry.message))).toBe(false);
  });

  it('メールアドレスを持たないユーザー (電話番号だけの登録など) は、退会して送らない', async () => {
    world.getUserById = { email: null };
    expect(await run()).toEqual({ ok: true });
    expect(world.calls).toContain('auth.deleteUser');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['エラーを返した', { error: { message: 'internal error', status: 500, code: 'unexpected_failure' } }],
    ['例外を投げた', { throws: true }],
  ] as const)('宛先を引けなかった (%s) ときも退会は続け、送らない。警告にはアドレスも user_id も載せない', async (_label, lookup) => {
    world.getUserById = lookup;
    expect(await run()).toEqual({ ok: true });
    expect(world.calls).toContain('auth.deleteUser');
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    const warning = logs.entries.find((entry) => entry.level === 'warn' && /could not read the email address/.test(entry.message));
    expect(warning).toBeDefined();
    expect(warning?.viaUser).toBe(false);
    expect(warning?.metadata).toMatchObject({ request_id: REQUEST_ID });
    expect(serializeLogs(logs.entries)).not.toContain(USER);
  });
});

describe('退会の完了メール: 送信に失敗しても退会は成功のまま', () => {
  it('送れなかった (sendEmail が ok: false) ときは、退会は成功のまま。失敗をログに残す (アドレス・user_id なし)', async () => {
    mocks.sendEmail.mockImplementation(async () => {
      world.calls.push('sendEmail');
      return {
        ok: false,
        id: null,
        attempts: 4,
        skipped: false,
        error: new EmailSendError('rate_limit_exceeded', 'EMAIL_SEND_FAILED: Too many requests', 429, 4, true),
      };
    });
    expect(await run()).toEqual({ ok: true });

    const failure = logs.entries.find((entry) => entry.level === 'error');
    expect(failure?.message).toMatch(/completion email could not be sent/);
    expect(failure?.viaUser).toBe(false); // 削除の後なので user_id は付けない
    expect(failure?.metadata).toMatchObject({
      request_id: REQUEST_ID,
      template: ACCOUNT_DELETED_EMAIL_TEMPLATE,
      error_code: 'rate_limit_exceeded',
      attempts: 4,
    });
    const serialized = serializeLogs(logs.entries);
    expect(serialized.toLowerCase()).not.toContain(EMAIL.toLowerCase());
    expect(serialized).not.toContain(USER);
  });

  it('宛先停止リストで止めた (suppressed) ときは意図した動きなので、error ではなく warn を残す (#1577 の 7)', async () => {
    mocks.sendEmail.mockImplementation(async () => {
      world.calls.push('sendEmail');
      return {
        ok: false,
        id: null,
        attempts: 0,
        skipped: false,
        error: new EmailSendError(
          'suppressed',
          'EMAIL_SUPPRESSED: 宛先停止リストに載っている宛先のため、メールを送信しませんでした',
          null,
          0,
          false,
        ),
      };
    });
    expect(await run()).toEqual({ ok: true });

    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(false);
    const notice = logs.entries.find((entry) => entry.level === 'warn' && /completion email could not be sent/.test(entry.message));
    expect(notice?.viaUser).toBe(false);
    expect(notice?.metadata).toMatchObject({
      request_id: REQUEST_ID,
      template: ACCOUNT_DELETED_EMAIL_TEMPLATE,
      error_code: 'suppressed',
      attempts: 0,
    });
    const serialized = serializeLogs(logs.entries);
    expect(serialized.toLowerCase()).not.toContain(EMAIL.toLowerCase());
    expect(serialized).not.toContain(USER);
  });

  it('RESEND_API_KEY が無くて送らなかった (skipped) ときは、失敗としてログに残さない (sendEmail が警告を残す)', async () => {
    mocks.sendEmail.mockResolvedValue({
      ok: false,
      id: null,
      attempts: 0,
      skipped: true,
      error: new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED', null, 0, false),
    });
    expect(await run()).toEqual({ ok: true });
    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(false);
  });

  it('送信が例外を投げても退会は成功のまま。例外の文にアドレスが入っていても、ログには生で残さない', async () => {
    mocks.sendEmail.mockRejectedValue(new Error(`connect failed while sending to ${EMAIL.toLowerCase()}`));
    expect(await run()).toEqual({ ok: true });

    const failure = logs.entries.find((entry) => entry.level === 'error');
    expect(failure?.message).toMatch(/completion email could not be sent/);
    expect((failure?.error as Error).message).toContain('connect failed while sending to');
    expect((failure?.error as Error).message).toContain('***@example.com');
    expect(serializeLogs(logs.entries).toLowerCase()).not.toContain(EMAIL.toLowerCase());
  });

  it('送信が時間内に終わらなければ、待つのをやめて警告を残す (例外は投げない)', async () => {
    mocks.sendEmail.mockImplementation(() => new Promise(() => {}));
    const timeoutMs = 10;
    await expect(
      notifyAccountDeleted({ toEmail: EMAIL, deletedAt: DELETED_AT, requestId: REQUEST_ID, log: logs.logger, timeoutMs }),
    ).resolves.toBeUndefined();

    const warning = logs.entries.find((entry) => entry.level === 'warn');
    expect(warning?.message).toMatch(/did not finish in time/);
    expect(warning?.metadata).toMatchObject({ request_id: REQUEST_ID, timeout_ms: timeoutMs });
    expect(serializeLogs(logs.entries).toLowerCase()).not.toContain(EMAIL.toLowerCase());
  });
});

describe('readAccountDeletionEmail', () => {
  it('空白だけのアドレスは「無い」と同じ (送らない)', async () => {
    world.getUserById = { email: '   ' };
    expect(await readAccountDeletionEmail(makeAdmin(world), USER, { log: logs.logger, requestId: REQUEST_ID })).toBeNull();
  });

  it('登録アドレスをそのまま返す', async () => {
    expect(await readAccountDeletionEmail(makeAdmin(world), USER, { log: logs.logger, requestId: REQUEST_ID })).toBe(EMAIL);
  });
});

describe('POST /api/account/delete: 完了メールと HTTP の応答', () => {
  const request = () =>
    new Request('http://localhost/api/account/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });

  beforeEach(() => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: USER, email: EMAIL } }, error: null });
    mocks.getSupabaseAdmin.mockImplementation(() => makeAdmin(world));
  });

  it('成功すれば 200 { success: true }、完了メールを 1 通送る', async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(sentEnvelopes()[0].to).toBe(EMAIL);
  });

  it('完了メールの送信に失敗しても 200 { success: true } (アカウントはもう消えている)。ログに生のアドレスを残さない', async () => {
    mocks.sendEmail.mockResolvedValue({
      ok: false,
      id: null,
      attempts: 1,
      skipped: false,
      error: new EmailSendError('validation_error', 'EMAIL_SEND_FAILED: invalid', 422, 1, false),
    });
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const failure = mocks.routeLogs.find((entry) => entry.level === 'error');
    expect(failure?.message).toMatch(/completion email could not be sent/);
    expect(failure?.userId).toBeUndefined();
    const serialized = serializeLogs(mocks.routeLogs);
    expect(serialized.toLowerCase()).not.toContain(EMAIL.toLowerCase());
  });

  it('送信が例外を投げても 200', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('boom'));
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('409 では送らない', async () => {
    world.owner = true;
    const res = await POST(request());
    expect(res.status).toBe(409);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('途中の失敗 (500) では送らない', async () => {
    world.storageListError = { message: 'storage down' };
    const res = await POST(request());
    expect(res.status).toBe(500);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe('完了メールの文面 (renderAccountDeletedEmail)', () => {
  it('件名・宛先・template・退会日時 (日本時間)・問い合わせ先・心当たりが無い場合の案内を入れる', () => {
    const envelope = renderAccountDeletedEmail({ to_email: EMAIL, deleted_at: DELETED_AT });

    expect(envelope.to).toBe(EMAIL);
    expect(envelope.template).toBe('account_deleted');
    expect(envelope.subject).toBe('【ほめゴハン】退会が完了しました');
    expect(envelope.text).toContain('2026年10月10日 00:05 (日本時間)');
    expect(envelope.text).toContain('退会が完了しました');
    expect(envelope.text).toContain('心当たりが無い場合は');
    expect(envelope.text).toContain(DEFAULT_SUPPORT_EMAIL);
    expect(EmailEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it('日時は日本時間で書く (UTC の日付をまたぐ時刻でも、日本の日付になる)', () => {
    expect(formatAccountDeletedAt(new Date('2026-12-31T15:30:00.000Z'))).toBe('2027年1月1日 00:30');
    expect(formatAccountDeletedAt(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026年1月1日 09:00');
  });
});

describe('完了メールの文面: ストアの購読は退会で解約されないことの注意 (#1912)', () => {
  /** 本文の中で needle が現れる回数 */
  const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it('本文 (text) に STORE_SUBSCRIPTION_DELETION_NOTICE の文がちょうど 1 回入る', () => {
    const envelope = renderAccountDeletedEmail({ to_email: EMAIL, deleted_at: DELETED_AT });

    expect(countOf(envelope.text, STORE_SUBSCRIPTION_DELETION_NOTICE)).toBe(1);
  });

  it.each(PURCHASE_STORES.map((store) => [store] as const))(
    '本文 (text) に %s の定期購読の管理のページが「表示名: URL」の行でちょうど 1 回入る',
    (store) => {
      const envelope = renderAccountDeletedEmail({ to_email: EMAIL, deleted_at: DELETED_AT });
      const line = `${IAP_STORE_LABELS[store]}: ${STORE_SUBSCRIPTION_MANAGEMENT_URL[store]}`;

      expect(countOf(envelope.text, STORE_SUBSCRIPTION_MANAGEMENT_URL[store])).toBe(1);
      expect(envelope.text.split('\n').filter((l) => l === line)).toHaveLength(1);
    },
  );

  it('注意の文の直後の行から、各ストアの管理のページが PURCHASE_STORES の順に並ぶ (注意と案内がひとかたまり)', () => {
    const lines = renderAccountDeletedEmail({ to_email: EMAIL, deleted_at: DELETED_AT }).text.split('\n');
    const at = lines.indexOf(STORE_SUBSCRIPTION_DELETION_NOTICE);

    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 1 + PURCHASE_STORES.length)).toEqual(
      PURCHASE_STORES.map((store) => `${IAP_STORE_LABELS[store]}: ${STORE_SUBSCRIPTION_MANAGEMENT_URL[store]}`),
    );
    // 退会の完了の文の後・問い合わせ先の前に置く
    const body = lines.join('\n');
    expect(body.indexOf('退会が完了しました')).toBeLessThan(body.indexOf(STORE_SUBSCRIPTION_DELETION_NOTICE));
    expect(body.indexOf(STORE_SUBSCRIPTION_DELETION_NOTICE)).toBeLessThan(body.indexOf('心当たりが無い場合は'));
  });

  it('accountDeletedStoreSubscriptionNotice は shared の定数だけから組む (注意の文 + ストアごとの 1 行)', () => {
    expect(accountDeletedStoreSubscriptionNotice()).toBe(
      [
        STORE_SUBSCRIPTION_DELETION_NOTICE,
        ...PURCHASE_STORES.map((store) => `${IAP_STORE_LABELS[store]}: ${STORE_SUBSCRIPTION_MANAGEMENT_URL[store]}`),
      ].join('\n'),
    );
  });

  it('文面はテキストだけで HTML を持たない (HTML の本文を足すときは、そちらにも注意と案内を入れてこの it を改める)', () => {
    const envelope = renderAccountDeletedEmail({ to_email: EMAIL, deleted_at: DELETED_AT });

    expect(envelope.html).toBeUndefined();
  });

  it('文面のソースに注意の文と管理のページの URL を直接書かない (shared の定数から組む)', () => {
    const source = readFileSync(resolvePath(__dirname, '../src/lib/emails/account/account-deleted.ts'), 'utf8');

    expect(source).not.toContain(STORE_SUBSCRIPTION_DELETION_NOTICE);
    for (const store of PURCHASE_STORES) expect(source).not.toContain(STORE_SUBSCRIPTION_MANAGEMENT_URL[store]);
    expect(source).toMatch(/from '@homegohan\/shared'/);
  });
});
