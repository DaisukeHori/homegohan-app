import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeServiceRole, leadingUsers, type FakeServiceRole } from '../../operator/membership/fake-service-role';

// POST /api/family/representative-transfer/[id]/accept の完了メール (#1110) とエラーコードの変換。
//
// 修正前は次の 3 つの理由で、完了メールが 1 通も送られなかった。
//   1. RPC (accept_family_representative_transfer) の戻り値は更新後の family_groups の行
//      (id / name / representative_id ...) なのに、{ family_id, new_representative_id, old_representative_id }
//      として読んでいた (result.family_id は常に undefined)
//   2. 宛先を user_profiles.email から読んでいた (その列は無く、メールアドレスは auth.users にしか無い)
//   3. RPC の戻り値には旧代表者が含まれない
// 外部との境界 (Supabase・メール送信・ログ) はモックにし、宛先と本文を決める route 本体は実物を通す。

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  adminClient: vi.fn(),
  sendEmail: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  withUser: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: mocks.from,
  })),
  getSupabaseAdmin: () => mocks.adminClient(),
}));

vi.mock('@/lib/emails/send', () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withUser: mocks.withUser,
  }),
  generateRequestId: () => 'req_test',
}));

import { POST } from '@/app/api/family/representative-transfer/[id]/accept/route';

const PROPOSAL_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const FAMILY_ID = 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66';
const OLD_REP_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const NEW_REP_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const BYSTANDER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

const OLD_EMAIL = 'old-rep@example.com';
const NEW_EMAIL = 'new-rep@example.com';
const BYSTANDER_EMAIL = 'bystander@example.com';

type SentEmail = { to: string; subject: string; text: string };

/** 山田家: 旧代表者 (花子) が新代表者 (太郎) へ譲渡を提案し、太郎が承諾する */
function buildFake(): FakeServiceRole {
  return createFakeServiceRole({
    tables: {
      ownership_transfer_proposals: [
        {
          id: PROPOSAL_ID,
          scope: 'family',
          scope_id: FAMILY_ID,
          from_user_id: OLD_REP_ID,
          to_user_id: NEW_REP_ID,
          status: 'pending',
        },
      ],
      user_profiles: [
        { id: OLD_REP_ID, nickname: '花子' },
        { id: NEW_REP_ID, nickname: '太郎' },
        { id: BYSTANDER_ID, nickname: '無関係の人' },
      ],
    },
    // 登録ユーザーが 50 人を超えている状態 (#1204): 実際の当事者は先頭 50 件の後ろにいる
    users: [
      ...leadingUsers(60),
      { id: OLD_REP_ID, email: OLD_EMAIL },
      { id: NEW_REP_ID, email: NEW_EMAIL },
      { id: BYSTANDER_ID, email: BYSTANDER_EMAIL },
    ],
  });
}

/**
 * accept_family_representative_transfer の戻り値 (supabase/baseline/prod_schema.sql)。
 * ★更新後の family_groups の行。representative_id は承諾した本人 (新代表者) で、旧代表者は含まれない。
 */
const rpcFamilyRow = {
  id: FAMILY_ID,
  name: '山田家',
  representative_id: NEW_REP_ID,
  plan_key: 'free',
  member_limit: 4,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-10-08T00:00:00.000Z',
  dissolved_at: null,
};

let fake: FakeServiceRole;

beforeEach(() => {
  vi.clearAllMocks();
  fake = buildFake();

  mocks.getUser.mockResolvedValue({ data: { user: { id: NEW_REP_ID, email: NEW_EMAIL } }, error: null });
  mocks.from.mockImplementation((table: string) => fake.from(table));
  mocks.adminClient.mockImplementation(() => ({ auth: fake.auth }));
  mocks.rpc.mockImplementation(async () => {
    fake.events.push('rpc:accept_family_representative_transfer');
    return { data: { ...rpcFamilyRow }, error: null };
  });
  mocks.sendEmail.mockResolvedValue({ id: 'email-1' });
  mocks.withUser.mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: mocks.logError,
  }));
});

const call = () =>
  POST(
    new Request(`http://localhost/api/family/representative-transfer/${PROPOSAL_ID}/accept`, { method: 'POST' }),
    { params: Promise.resolve({ id: PROPOSAL_ID }) },
  );

/** sendEmail に渡された封筒。同じ宛先に 2 通送っていたら気づけるよう配列で扱う */
const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);
const sentTo = (address: string) => sentEmails().filter((envelope) => envelope.to === address);

describe('POST /api/family/representative-transfer/[id]/accept: 完了メール (#1110)', () => {
  it('承諾が成功したら、旧代表者と新代表者の 2 人に、それぞれの立場の本文で完了メールを送る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('accept_family_representative_transfer', { p_proposal_id: PROPOSAL_ID });
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([OLD_EMAIL, NEW_EMAIL].sort());

    const [toOld] = sentTo(OLD_EMAIL);
    const [toNew] = sentTo(NEW_EMAIL);
    // 旧代表者: 「譲渡しました」。譲渡先は新代表者の名前
    expect(toOld.text).toContain('「山田家」の代表者を 太郎 様に譲渡しました');
    expect(toOld.text).not.toContain('新しい代表者として');
    // 新代表者: 「新しい代表者になった」
    expect(toNew.text).toContain('「山田家」の代表者が 太郎 様に変更されました');
    expect(toNew.text).toContain('新しい代表者として');
    expect(toNew.text).not.toContain('譲渡しました');
    for (const envelope of [toOld, toNew]) {
      expect(envelope.subject).toBe('【ほめゴハン】家族代表者が変更されました');
    }
  });

  it('旧代表者のアドレスは、Auth ユーザー一覧の先頭 50 件より後ろにいても解決できる (#1204)', async () => {
    await call();

    expect(sentTo(OLD_EMAIL)).toHaveLength(1);
    // 必要な ID だけを引く。listUsers() (先頭 50 件のみ) には頼らない
    expect(fake.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById.mock.calls.map(([id]) => id)).toEqual([OLD_REP_ID]);
  });

  it('旧代表者は RPC の戻り値ではなく、承諾の前に読んだ提案の提案者 (from_user_id) から決める', async () => {
    await call();

    const rpcAt = fake.events.indexOf('rpc:accept_family_representative_transfer');
    const proposalReads = fake.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'read:ownership_transfer_proposals');

    expect(rpcAt).toBeGreaterThan(-1);
    expect(proposalReads.map(({ index }) => index < rpcAt)).toEqual([true]);
    // 新代表者に旧代表者宛の本文を送ったり、旧代表者に新代表者宛の本文を送ったりしていない
    expect(sentTo(OLD_EMAIL)[0].text).toContain('譲渡しました');
    expect(sentTo(NEW_EMAIL)[0].text).toContain('新しい代表者として');
  });

  it('メールアドレスを user_profiles から読まない (その列は無い)。無関係のユーザーには送らない', async () => {
    await call();

    const profileSelects = fake.selects.filter(({ table }) => table === 'user_profiles');
    for (const { columns } of profileSelects) {
      expect(columns ?? '').not.toMatch(/\bemail\b/);
    }
    expect(sentTo(BYSTANDER_EMAIL)).toHaveLength(0);
  });

  it('新代表者のアドレスは認証済みセッションの値を使い、他人のアドレスを探すために Auth API を呼ばない', async () => {
    await call();

    expect(fake.auth.admin.getUserById).not.toHaveBeenCalledWith(NEW_REP_ID);
    expect(sentTo(NEW_EMAIL)).toHaveLength(1);
  });

  it('レスポンスは RPC の戻り値をそのまま返し、メールアドレスを含めない', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ id: FAMILY_ID, name: '山田家', representative_id: NEW_REP_ID });
    const body = JSON.stringify(json);
    expect(body).not.toContain(OLD_EMAIL);
    expect(body).not.toContain(NEW_EMAIL);
  });

  it('メールが一部送れなくても 200 を返し、もう一方には送り、失敗の件数を構造化ログに残す', async () => {
    const sendError = new Error('EMAIL_SEND_FAILED: temporarily unavailable');
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === OLD_EMAIL) throw sendError;
      return { id: 'email-ok' };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.withUser).toHaveBeenCalledWith(NEW_REP_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      proposal_id: PROPOSAL_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('旧代表者のアドレスを取得できなくても 200 を返し、新代表者には送り、警告ログに残す', async () => {
    fake.auth.admin.getUserById.mockRejectedValue(new Error('auth admin api is down'));

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to)).toEqual([NEW_EMAIL]);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 1, failed: 1, failed_user_ids: [OLD_REP_ID] });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });

  it('Auth 管理 API の環境変数が無くても承諾は成功させ、新代表者には送り、警告ログに残す', async () => {
    mocks.adminClient.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to)).toEqual([NEW_EMAIL]);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it('承諾の前の提案を読めなかったときも 200 を返し、新代表者には送り、旧代表者へ送れなかったことを構造化ログに残す', async () => {
    const readError = { message: 'connection reset by peer', code: '08006' };
    fake.readErrors.ownership_transfer_proposals = readError;

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to)).toEqual([NEW_EMAIL]);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), readError, { proposal_id: PROPOSAL_ID });
    // 旧代表者が分からないので、誰のアドレスも探さない
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  it('宛先のメールアドレスを持たない人 (電話番号のみなど) にだけ送らず、失敗扱いにもしない', async () => {
    fake.users.find((user) => user.id === OLD_REP_ID)!.email = null;

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to)).toEqual([NEW_EMAIL]);
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('新代表者のニックネームを読めなくても、既定の呼称で完了メールを送る', async () => {
    fake.readErrors.user_profiles = { message: 'permission denied', code: '42501' };

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentTo(OLD_EMAIL)[0].text).toContain('新代表者 様に譲渡しました');
  });
});

describe('POST /api/family/representative-transfer/[id]/accept: RPC のエラー', () => {
  it.each([
    ['TRANSFER_PROPOSAL_NOT_FOUND', 404, '譲渡提案が見つかりません'],
    ['TRANSFER_NOT_PENDING', 409, '譲渡提案は既に処理済みです'],
    [
      'TRANSFER_ACCEPTOR_NOT_IN_FAMILY',
      403,
      'あなたは現在この家族のメンバーではないため、代表者権限を引き継げません。',
    ],
    ['TRANSFER_PROPOSAL_EXPIRED', 410, '譲渡提案の有効期限が切れています。'],
  ])('RPC が %s で失敗: %i と専用の文言を返し、完了メールは送らない', async (code, status, message) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: code, code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(status);
    expect(json.error).toEqual({ code, message });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(fake.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  it('想定外のエラー: 500 と汎用の文言を返し、RPC の生メッセージを画面に出さない', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'connection to server was lost' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toEqual({ code: 'UNKNOWN', message: '代表者譲渡の承諾に失敗しました' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('未認証: 401 を返し、提案も RPC も触らない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('NOT_AUTHENTICATED');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fake.events).toEqual([]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
