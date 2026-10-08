import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// #1160 除名・脱退の通知メールの共通ヘルパー。
// route 経由のテスト (src/__tests__/api/**/remove.test.ts, leave.test.ts) では再現しにくい、
// 「例外を投げない」「応答しないメール API を待ち続けない」という性質を確かめる。

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  resolveAuthEmails: vi.fn(),
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock('@/lib/membership/resolve-auth-emails', () => ({
  resolveAuthEmails: mocks.resolveAuthEmails,
}));

import {
  NOTICE_TIMEOUT_MS,
  notifyMemberLeft,
  notifyMemberRemoved,
  readFamilyMemberToNotify,
  readFamilyNotice,
  readFamilyNoticeOfMember,
  readOrganizationNotice,
  readOrganizationNoticeOfMember,
  type NoticeLogger,
  type NoticeScope,
} from '@/lib/membership/exit-notification';

const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const USER_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const RECIPIENT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const RECIPIENT_EMAIL = 'recipient@example.com';

let log: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.clearAllMocks();
  log = { warn: vi.fn(), error: vi.fn() };
  mocks.resolveAuthEmails.mockResolvedValue(new Map([[RECIPIENT_ID, RECIPIENT_EMAIL]]));
  mocks.sendEmail.mockResolvedValue({ id: 'email-1' });
});

afterEach(() => {
  vi.useRealTimers();
});

const logger = () => log as unknown as NoticeLogger;

/** どのメソッドを何段つないでも同じ連鎖を返し、maybeSingle() で result を返すフェイクのクライアント */
function clientReturning(result: { data: unknown; error: unknown }): SupabaseClient {
  const chain: unknown = new Proxy(
    {},
    { get: (_target, property) => (property === 'maybeSingle' ? async () => result : () => chain) },
  );
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

/** from() 自体が例外を投げるクライアント (接続の初期化に失敗した場合など) */
function clientThrowing(): SupabaseClient {
  return {
    from: vi.fn(() => {
      throw new Error('client is broken');
    }),
  } as unknown as SupabaseClient;
}

const familyScope: NoticeScope = { kind: 'family', id: FAMILY_ID, name: '山田家', leaveRecipientId: RECIPIENT_ID };
const orgScope: NoticeScope = { kind: 'organization', id: ORG_ID, name: '株式会社ほめゴハン', leaveRecipientId: RECIPIENT_ID };

describe('read*Notice: 所属先の情報を読む (RPC の前に呼ぶ)', () => {
  it('家族グループ: 名前と代表者を返す', async () => {
    const supabase = clientReturning({ data: { name: '山田家', representative_id: RECIPIENT_ID }, error: null });

    await expect(readFamilyNotice(supabase, FAMILY_ID, logger())).resolves.toEqual(familyScope);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('組織: 名前とオーナーを返す', async () => {
    const supabase = clientReturning({ data: { name: '株式会社ほめゴハン', owner_id: RECIPIENT_ID }, error: null });

    await expect(readOrganizationNotice(supabase, ORG_ID, logger())).resolves.toEqual(orgScope);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('組織: オーナーが未設定 (owner_id が NULL) なら、名前だけ返し、通知先は無し。警告は出さない', async () => {
    const supabase = clientReturning({ data: { name: '株式会社ほめゴハン', owner_id: null }, error: null });

    await expect(readOrganizationNotice(supabase, ORG_ID, logger())).resolves.toEqual({
      ...orgScope,
      leaveRecipientId: null,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('行が見えない (RLS で隠れている・存在しない) ときは、名前も通知先も無しで返す。警告は出さない', async () => {
    const supabase = clientReturning({ data: null, error: null });

    await expect(readFamilyNotice(supabase, FAMILY_ID, logger())).resolves.toEqual({
      kind: 'family',
      id: FAMILY_ID,
      name: null,
      leaveRecipientId: null,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['家族グループ', (s: SupabaseClient) => readFamilyNotice(s, FAMILY_ID, logger()), 'family', FAMILY_ID],
    ['組織', (s: SupabaseClient) => readOrganizationNotice(s, ORG_ID, logger()), 'organization', ORG_ID],
  ])('%s: 読み取りがエラーを返したら、例外を投げず、名前も通知先も無しで返し、警告ログに残す', async (_label, read, kind, id) => {
    const supabase = clientReturning({ data: null, error: { message: 'permission denied', code: '42501' } });

    await expect(read(supabase)).resolves.toEqual({ kind, id, name: null, leaveRecipientId: null });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toEqual({ scope: kind, scope_id: id, error: 'permission denied' });
  });

  it.each([
    ['家族グループ', (s: SupabaseClient) => readFamilyNotice(s, FAMILY_ID, logger()), 'family', FAMILY_ID],
    ['組織', (s: SupabaseClient) => readOrganizationNotice(s, ORG_ID, logger()), 'organization', ORG_ID],
    ['家族グループ (本人の所属から)', (s: SupabaseClient) => readFamilyNoticeOfMember(s, USER_ID, logger()), 'family', null],
    ['組織 (本人の所属から)', (s: SupabaseClient) => readOrganizationNoticeOfMember(s, USER_ID, logger()), 'organization', null],
  ])('%s: クライアントが例外を投げても、例外を投げず、警告ログに残す', async (_label, read, kind, id) => {
    await expect(read(clientThrowing())).resolves.toEqual({ kind, id, name: null, leaveRecipientId: null });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toEqual({ scope: kind, scope_id: id, error: 'client is broken' });
  });

  it('本人の所属から読む: どこにも所属していなければ (行が無い)、何も分からない状態で返す。警告は出さない', async () => {
    const supabase = clientReturning({ data: null, error: null });

    await expect(readFamilyNoticeOfMember(supabase, USER_ID, logger())).resolves.toEqual({
      kind: 'family',
      id: null,
      name: null,
      leaveRecipientId: null,
    });
    await expect(readOrganizationNoticeOfMember(supabase, USER_ID, logger())).resolves.toEqual({
      kind: 'organization',
      id: null,
      name: null,
      leaveRecipientId: null,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('本人の所属から読む: 組織に所属していない (organization_id が NULL) ときも、何も分からない状態で返す', async () => {
    const supabase = clientReturning({ data: { organization_id: null }, error: null });

    await expect(readOrganizationNoticeOfMember(supabase, USER_ID, logger())).resolves.toMatchObject({
      id: null,
      name: null,
      leaveRecipientId: null,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('readFamilyMemberToNotify: 除名しようとしている家族の行 (RPC の前に読む)', () => {
  it('active で、アカウントを持つメンバーなら、その user_id を返す', async () => {
    const supabase = clientReturning({ data: { user_id: USER_ID, status: 'active' }, error: null });

    await expect(readFamilyMemberToNotify(supabase, FAMILY_ID, 'member-row', logger())).resolves.toBe(USER_ID);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['アカウントを持たない子供メンバー (user_id が NULL)', { user_id: null, status: 'active' }],
    ['すでに脱退した行 (left)', { user_id: USER_ID, status: 'left' }],
    ['すでに除名した行 (removed)', { user_id: USER_ID, status: 'removed' }],
    ['行が見えない (RLS で隠れている・存在しない)', null],
  ])('%s は null を返す (通知しない)。警告は出さない', async (_label, data) => {
    const supabase = clientReturning({ data, error: null });

    await expect(readFamilyMemberToNotify(supabase, FAMILY_ID, 'member-row', logger())).resolves.toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('読み取りがエラーを返したら、初めての除名か確かめられないので null を返し、警告ログに残す', async () => {
    const supabase = clientReturning({ data: null, error: { message: 'permission denied', code: '42501' } });

    await expect(readFamilyMemberToNotify(supabase, FAMILY_ID, 'member-row', logger())).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toEqual({ scope: 'family', scope_id: FAMILY_ID, error: 'permission denied' });
  });

  it('クライアントが例外を投げても、例外を投げずに null を返し、警告ログに残す', async () => {
    await expect(readFamilyMemberToNotify(clientThrowing(), FAMILY_ID, 'member-row', logger())).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toEqual({ scope: 'family', scope_id: FAMILY_ID, error: 'client is broken' });
  });
});

describe('notifyMemberRemoved: 外された本人への通知', () => {
  it('外された本人のアドレスを引いて、除名のメールを 1 通送る', async () => {
    await notifyMemberRemoved({ scope: familyScope, removedUserId: RECIPIENT_ID, actorUserId: USER_ID, log: logger() });

    expect(mocks.resolveAuthEmails).toHaveBeenCalledWith([RECIPIENT_ID], { logger: log });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const envelope = mocks.sendEmail.mock.calls[0][0] as { to: string; subject: string };
    expect(envelope.to).toBe(RECIPIENT_EMAIL);
    expect(envelope.subject).toBe('【ほめゴハン】家族グループ「山田家」から外されました');
  });

  it.each([
    ['null (アカウントを持たない子供メンバー)', null],
    ['undefined', undefined],
    ['空文字', ''],
  ])('外された人が %s のときは、宛先を探さず、何も送らない', async (_label, removedUserId) => {
    await notifyMemberRemoved({ scope: familyScope, removedUserId, actorUserId: USER_ID, log: logger() });

    expect(mocks.resolveAuthEmails).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('実行者と外された人が同じ (自分で自分を外した) ときは、何も送らない', async () => {
    await notifyMemberRemoved({ scope: familyScope, removedUserId: USER_ID, actorUserId: USER_ID, log: logger() });

    expect(mocks.resolveAuthEmails).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('アドレスが取れなかった (Map に無い) ときは、送らず、ログも残さない', async () => {
    mocks.resolveAuthEmails.mockResolvedValue(new Map());

    await notifyMemberRemoved({ scope: familyScope, removedUserId: RECIPIENT_ID, actorUserId: USER_ID, log: logger() });

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('送信が失敗しても例外を投げず、所属先と宛先の user_id だけをエラーログに残す', async () => {
    const sendError = new Error('EMAIL_SEND_FAILED: down');
    mocks.sendEmail.mockRejectedValue(sendError);

    await expect(
      notifyMemberRemoved({ scope: orgScope, removedUserId: RECIPIENT_ID, actorUserId: USER_ID, log: logger() }),
    ).resolves.toBeUndefined();

    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.any(String), sendError, {
      scope: 'organization',
      scope_id: ORG_ID,
      recipient_user_id: RECIPIENT_ID,
    });
  });

  it('送信が失敗し、そのログの出力自体も例外を投げても、呼び出し元には例外を投げない', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('EMAIL_SEND_FAILED: down'));
    log.error.mockImplementation(() => {
      throw new Error('logger is broken');
    });

    await expect(
      notifyMemberRemoved({ scope: familyScope, removedUserId: RECIPIENT_ID, actorUserId: USER_ID, log: logger() }),
    ).resolves.toBeUndefined();
  });

  it('resolveAuthEmails が予期せず例外を投げても、例外を投げずエラーログに残す', async () => {
    mocks.resolveAuthEmails.mockRejectedValue(new Error('unexpected'));

    await expect(
      notifyMemberRemoved({ scope: familyScope, removedUserId: RECIPIENT_ID, actorUserId: USER_ID, log: logger() }),
    ).resolves.toBeUndefined();

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe('notifyMemberLeft: 代表者 / オーナーへの通知', () => {
  it('家族グループ: 代表者のアドレスを引いて、家族グループのメンバー管理画面つきの脱退メールを送る', async () => {
    await notifyMemberLeft({ scope: familyScope, log: logger() });

    expect(mocks.resolveAuthEmails).toHaveBeenCalledWith([RECIPIENT_ID], { logger: log });
    const envelope = mocks.sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(envelope.to).toBe(RECIPIENT_EMAIL);
    expect(envelope.subject).toBe('【ほめゴハン】家族グループ「山田家」からメンバーが脱退しました');
    expect(envelope.text.split('\n').some((line) => /^https?:\/\/.+\/family\/members$/.test(line))).toBe(true);
  });

  it('組織: 組織のメンバー管理画面つきの脱退メールを送る', async () => {
    await notifyMemberLeft({ scope: orgScope, log: logger() });

    const envelope = mocks.sendEmail.mock.calls[0][0] as { subject: string; text: string };
    expect(envelope.subject).toBe('【ほめゴハン】組織「株式会社ほめゴハン」からメンバーが脱退しました');
    expect(envelope.text.split('\n').some((line) => /^https?:\/\/.+\/org\/members$/.test(line))).toBe(true);
  });

  it('通知先が分からない (leaveRecipientId が null) ときは、宛先を探さず、何も送らない', async () => {
    await notifyMemberLeft({ scope: { ...familyScope, leaveRecipientId: null }, log: logger() });

    expect(mocks.resolveAuthEmails).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('名前を読めなかった (name が null) ときは、名前を省いた文面で送る', async () => {
    await notifyMemberLeft({ scope: { ...orgScope, name: null }, log: logger() });

    const envelope = mocks.sendEmail.mock.calls[0][0] as { subject: string };
    expect(envelope.subject).toBe('【ほめゴハン】組織からメンバーが脱退しました');
  });
});

describe('通知を待つ時間の上限', () => {
  it('メール API が応答しなくても、上限 (NOTICE_TIMEOUT_MS) で待つのをやめ、例外を投げず、警告ログに残す', async () => {
    vi.useFakeTimers();
    mocks.sendEmail.mockReturnValue(new Promise(() => {}));
    let finished = false;

    const pending = notifyMemberLeft({ scope: familyScope, log: logger() }).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(NOTICE_TIMEOUT_MS - 1);
    expect(finished).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(finished).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toEqual({
      scope: 'family',
      scope_id: FAMILY_ID,
      recipient_user_id: RECIPIENT_ID,
      timeout_ms: NOTICE_TIMEOUT_MS,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('時間内に終われば警告は出さず、タイマーも残らない', async () => {
    vi.useFakeTimers();

    await notifyMemberLeft({ scope: familyScope, log: logger() });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('上限は 5 秒 (関数のタイムアウトより十分短い)', () => {
    expect(NOTICE_TIMEOUT_MS).toBe(5000);
  });
});
