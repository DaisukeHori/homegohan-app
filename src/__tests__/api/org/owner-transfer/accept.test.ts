import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailSendError } from '@/lib/emails/send-result';
import { MEMBERSHIP_ERROR_MESSAGES, MembershipErrorCode } from '@/lib/errors/membership-errors';
import {
  createFakeServiceRole,
  leadingUsers,
  type FakeServiceRole,
} from '../../operator/membership/fake-service-role';

// POST /api/org/owner-transfer/[id]/accept の完了メール (#1110) とエラーコードの変換。
//
// 修正前は sendEmail / renderOrgTransferCompletedEmail を import しているだけで、どこからも呼ばれず、
// 完了メールが実装されていなかった (console.info だけ)。また、旧オーナーのニックネームを本人の
// セッション (RLS で他人の user_profiles は読めない) で読んでいたため、旧オーナーの名前は取れなかった。
// 外部との境界 (Supabase・メール送信・ログ) はモックにし、宛先と本文を決める route 本体は実物を通す。

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  userClientFrom: vi.fn(),
  adminClient: vi.fn(),
  sendEmail: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  withUser: vi.fn(),
}));

// 承諾する本人のセッション (RLS あり)。ownership_transfer_proposals は当事者だけが読める
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: mocks.userClientFrom,
  }),
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

import { POST } from '@/app/api/org/owner-transfer/[id]/accept/route';

const PROPOSAL_ID = 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44';
const ORG_ID = 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55';
const OLD_OWNER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const NEW_OWNER_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const MEMBER_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

const OLD_EMAIL = 'old-owner@example.com';
const NEW_EMAIL = 'new-owner@example.com';
const MEMBER_EMAIL = 'member@example.com';

type SentEmail = { to: string; subject: string; text: string };

/** 承諾する本人 (新オーナー) のセッションで読める範囲: 自分が当事者の提案だけ。他人の user_profiles は読めない */
let userDb: FakeServiceRole;
/** service_role (Auth Admin API とニックネームの読み取り) */
let adminDb: FakeServiceRole;

function buildDatabases() {
  userDb = createFakeServiceRole({
    tables: {
      ownership_transfer_proposals: [
        {
          id: PROPOSAL_ID,
          scope: 'organization',
          scope_id: ORG_ID,
          from_user_id: OLD_OWNER_ID,
          to_user_id: NEW_OWNER_ID,
          status: 'pending',
        },
      ],
    },
    users: [],
  });
  adminDb = createFakeServiceRole({
    tables: {
      user_profiles: [
        { id: OLD_OWNER_ID, nickname: '社長' },
        { id: NEW_OWNER_ID, nickname: '部長' },
        { id: MEMBER_ID, nickname: '一般社員' },
      ],
    },
    // 登録ユーザーが 50 人を超えている状態 (#1204): 実際の当事者は先頭 50 件の後ろにいる
    users: [
      ...leadingUsers(60),
      { id: OLD_OWNER_ID, email: OLD_EMAIL },
      { id: NEW_OWNER_ID, email: NEW_EMAIL },
      { id: MEMBER_ID, email: MEMBER_EMAIL },
    ],
  });
}

/** accept_org_owner_transfer の戻り値: 更新後の organizations の行 (owner_id は新オーナー) */
const rpcOrgRow = {
  id: ORG_ID,
  name: 'ほめゴハン株式会社',
  owner_id: NEW_OWNER_ID,
  plan: 'standard',
  status: 'active',
};

beforeEach(() => {
  vi.clearAllMocks();
  buildDatabases();

  mocks.getUser.mockResolvedValue({ data: { user: { id: NEW_OWNER_ID, email: NEW_EMAIL } }, error: null });
  mocks.userClientFrom.mockImplementation((table: string) => userDb.from(table));
  mocks.adminClient.mockImplementation(() => adminDb.client);
  mocks.rpc.mockImplementation(async () => {
    userDb.events.push('rpc:accept_org_owner_transfer');
    return { data: { ...rpcOrgRow }, error: null };
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
  POST(new Request(`http://localhost/api/org/owner-transfer/${PROPOSAL_ID}/accept`, { method: 'POST' }), {
    params: Promise.resolve({ id: PROPOSAL_ID }),
  });

/** sendEmail に渡された封筒。同じ宛先に 2 通送っていたら気づけるよう配列で扱う */
const sentEmails = () => mocks.sendEmail.mock.calls.map(([envelope]) => envelope as SentEmail);
const sentTo = (address: string) => sentEmails().filter((envelope) => envelope.to === address);

describe('POST /api/org/owner-transfer/[id]/accept: 完了メール (#1110)', () => {
  it('承諾が成功したら、旧オーナーと新オーナーの 2 人に、それぞれの立場の本文で完了メールを送る', async () => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith('accept_org_owner_transfer', { p_proposal_id: PROPOSAL_ID });
    expect(sentEmails().map((envelope) => envelope.to).sort()).toEqual([OLD_EMAIL, NEW_EMAIL].sort());

    const [toOld] = sentTo(OLD_EMAIL);
    const [toNew] = sentTo(NEW_EMAIL);
    // 旧オーナー: 「譲渡しました」。譲渡先は新オーナーの名前
    expect(toOld.text).toContain('社長 様');
    expect(toOld.text).toContain('あなたは「ほめゴハン株式会社」のオーナー権限を 部長 様に譲渡しました。');
    // 新オーナー: 「新しいオーナーになりました」。旧オーナーの名前 (他人の user_profiles なので service_role で読む)
    expect(toNew.text).toContain('部長 様');
    expect(toNew.text).toContain('あなたは「ほめゴハン株式会社」の新しいオーナーになりました。');
    expect(toNew.text).toContain('旧オーナー: 社長 様');
    for (const envelope of [toOld, toNew]) {
      expect(envelope.subject).toBe('【ほめゴハン】組織オーナーが変更されました');
    }
  });

  it('旧オーナー・新オーナーのアドレスは、Auth ユーザー一覧の先頭 50 件より後ろにいても解決できる (#1204)', async () => {
    await call();

    expect(sentTo(OLD_EMAIL)).toHaveLength(1);
    expect(sentTo(NEW_EMAIL)).toHaveLength(1);
    // 必要な 2 人だけを引く。listUsers() (先頭 50 件のみ) には頼らない
    expect(adminDb.auth.admin.listUsers).not.toHaveBeenCalled();
    expect(adminDb.auth.admin.getUserById.mock.calls.map(([id]) => id).sort()).toEqual(
      [OLD_OWNER_ID, NEW_OWNER_ID].sort(),
    );
  });

  it('組織内のほかのメンバーには送らない (宛先は旧オーナーと新オーナーだけ)', async () => {
    await call();

    expect(sentTo(MEMBER_EMAIL)).toHaveLength(0);
    expect(sentEmails()).toHaveLength(2);
  });

  it('組織名は RPC の戻り値 (更新後の organizations の行) から入れる', async () => {
    await call();

    for (const envelope of sentEmails()) {
      expect(envelope.text).toContain('ほめゴハン株式会社');
    }
    // 組織を別途読み直さない
    expect(userDb.selects.map(({ table }) => table)).not.toContain('organizations');
  });

  it('提案は承諾の前に読む (旧オーナーは提案の提案者 from_user_id)。存在しない列 reason は読まない', async () => {
    await call();

    const rpcAt = userDb.events.indexOf('rpc:accept_org_owner_transfer');
    const proposalReads = userDb.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event === 'read:ownership_transfer_proposals');

    expect(rpcAt).toBeGreaterThan(-1);
    expect(proposalReads.map(({ index }) => index < rpcAt)).toEqual([true]);
    for (const { table, columns } of userDb.selects.filter(({ table }) => table === 'ownership_transfer_proposals')) {
      expect(table).toBe('ownership_transfer_proposals');
      expect(columns ?? '').not.toMatch(/\breason\b/);
    }
  });

  it('レスポンスは { ok: true, result } のままで、メールアドレスを含めない', async () => {
    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, result: { id: ORG_ID, name: 'ほめゴハン株式会社' } });
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
    expect(mocks.withUser).toHaveBeenCalledWith(NEW_OWNER_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      proposal_id: PROPOSAL_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('sendEmail が reject せず ok: false の結果を返した宛先も失敗として数え、200 のまま、ほかの宛先には送り、構造化ログに残す (#1193)', async () => {
    const sendError = new EmailSendError('rate_limit_exceeded', 'EMAIL_SEND_FAILED: Too many requests', 429, 4, true);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === OLD_EMAIL) return { ok: false, id: null, attempts: 4, skipped: false, error: sendError };
      return { ok: true, id: 'email-ok', attempts: 1, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.withUser).toHaveBeenCalledWith(NEW_OWNER_ID);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), sendError, {
      proposal_id: PROPOSAL_ID,
      failed_count: 1,
    });
    // ログに宛先のメールアドレスを残さない
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('@example.com');
  });

  it('reject された宛先と ok: false の宛先が混ざっても、失敗の件数を合計して 1 件のログにまとめる (#1193)', async () => {
    const thrown = new Error('EMAIL_SEND_FAILED: unexpected');
    const resultError = new EmailSendError('application_error', 'EMAIL_SEND_FAILED: Service Unavailable', 503, 4, true);
    mocks.sendEmail.mockImplementation(async (envelope: SentEmail) => {
      if (envelope.to === OLD_EMAIL) throw thrown;
      if (envelope.to === NEW_EMAIL) return { ok: false, id: null, attempts: 4, skipped: false, error: resultError };
      return { ok: true, id: 'email-ok', attempts: 1, skipped: false, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    const [, reason, metadata] = mocks.logError.mock.calls[0];
    expect([thrown, resultError]).toContain(reason);
    expect(metadata).toEqual({
      proposal_id: PROPOSAL_ID,
      failed_count: 2,
    });
  });

  it('RESEND_API_KEY が無くて送らなかった (skipped) 宛先は、失敗に数えず、エラーログも残さない (#1193)', async () => {
    const skippedError = new EmailSendError('not_configured', 'EMAIL_NOT_CONFIGURED: RESEND_API_KEY が未設定', null, 0, false);
    mocks.sendEmail.mockResolvedValue({ ok: false, id: null, attempts: 0, skipped: true, error: skippedError });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('旧オーナーのアドレスを取得できなくても 200 を返し、新オーナーには送り、警告ログに残す', async () => {
    adminDb.auth.admin.getUserById.mockImplementation(async (id: string) => {
      if (id === OLD_OWNER_ID) throw new Error('auth admin api is down');
      return { data: { user: { id, email: NEW_EMAIL } }, error: null };
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to)).toEqual([NEW_EMAIL]);
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn.mock.calls[0][1]).toMatchObject({ requested: 2, failed: 1, failed_user_ids: [OLD_OWNER_ID] });
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain('@example.com');
  });

  it('Auth 管理 API の環境変数が無くても承諾は成功させ、メールは送らず、ログに残す', async () => {
    mocks.adminClient.mockImplementation(() => {
      throw new Error('Supabase admin env is missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ message: expect.stringContaining('Supabase admin env is missing') }),
      { proposal_id: PROPOSAL_ID },
    );
  });

  it('承諾の前の提案を読めなかったときも 200 を返し、宛先が分からないのでメールは送らず、構造化ログに残す', async () => {
    const readError = { message: 'connection reset by peer', code: '08006' };
    userDb.readErrors.ownership_transfer_proposals = readError;

    const res = await call();

    expect(res.status).toBe(200);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), readError, { proposal_id: PROPOSAL_ID });
    expect(adminDb.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  it('ニックネームを読めなくても、既定の呼称で完了メールを送る', async () => {
    adminDb.readErrors.user_profiles = { message: 'connection reset by peer', code: '08006' };

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentTo(OLD_EMAIL)[0].text).toContain('新オーナー 様に譲渡しました');
    expect(sentTo(NEW_EMAIL)[0].text).toContain('旧オーナー: 旧オーナー 様');
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it('宛先のメールアドレスを持たない人 (電話番号のみなど) にだけ送らず、失敗扱いにもしない', async () => {
    adminDb.users.find((user) => user.id === OLD_OWNER_ID)!.email = null;

    const res = await call();

    expect(res.status).toBe(200);
    expect(sentEmails().map((envelope) => envelope.to)).toEqual([NEW_EMAIL]);
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });
});

describe('POST /api/org/owner-transfer/[id]/accept: 名前に仮置きの Guest を使わない (#1649)', () => {
  function setNickname(userId: string, nickname: string) {
    const row = adminDb.tables.user_profiles.find((r) => r.id === userId);
    if (!row) throw new Error(`user_profiles に ${userId} がありません`);
    row.nickname = nickname;
  }

  it.each(['Guest', ' Guest ', '   '])(
    '両者の nickname が %j なら、宛名はメールアドレス・本文の名前は既定の「旧オーナー」「新オーナー」',
    async (nickname) => {
      setNickname(OLD_OWNER_ID, nickname);
      setNickname(NEW_OWNER_ID, nickname);

      const res = await call();

      expect(res.status).toBe(200);
      const [toOld] = sentTo(OLD_EMAIL);
      const [toNew] = sentTo(NEW_EMAIL);
      expect(toOld.text.startsWith(`${OLD_EMAIL} 様`)).toBe(true);
      expect(toOld.text).toContain('オーナー権限を 新オーナー 様に譲渡しました');
      expect(toNew.text.startsWith(`${NEW_EMAIL} 様`)).toBe(true);
      expect(toNew.text).toContain('旧オーナー: 旧オーナー 様');
      for (const envelope of sentEmails()) expect(envelope.text).not.toContain('Guest');
    },
  );

  it.each([
    ['guest', 'guest'],
    [' 社長 ', '社長'],
  ])('旧オーナーの nickname が %j (本人が付けた名前) なら、宛名と本文にその名前を使う', async (nickname, expected) => {
    setNickname(OLD_OWNER_ID, nickname);

    await call();

    expect(sentTo(OLD_EMAIL)[0].text.startsWith(`${expected} 様`)).toBe(true);
    expect(sentTo(NEW_EMAIL)[0].text).toContain(`旧オーナー: ${expected} 様`);
  });
});

describe('POST /api/org/owner-transfer/[id]/accept: RPC のエラー', () => {
  it.each([
    ['TRANSFER_PROPOSAL_NOT_FOUND', 404, '譲渡提案が見つかりません。'],
    ['TRANSFER_NOT_PENDING', 409, 'この譲渡提案は既に処理済みです。'],
    [
      'TRANSFER_ACCEPTOR_NOT_IN_ORG',
      403,
      'あなたは現在この組織のメンバーではないため、オーナー権限を引き継げません。',
    ],
    ['TRANSFER_PROPOSAL_EXPIRED', 410, '譲渡提案の有効期限が切れています。'],
    // 20261022110000_org_transfer_toctou.sql: 解散と同時の承諾・運営の強制譲渡のあとに残った提案
    ['ORG_ALREADY_DISSOLVED', 409, 'この組織は解散しているため、オーナー権限を引き継げません。'],
    [
      'NOT_ORG_OWNER',
      403,
      '譲渡を申し出た人が今はこの組織のオーナーではないため、オーナー権限を引き継げません。',
    ],
  ])('RPC が %s で失敗: %i と専用の文言を返し、完了メールは送らない', async (code, status, message) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: code, code: 'P0001' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(status);
    expect(json.error).toEqual({ code, message });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(adminDb.auth.admin.getUserById).not.toHaveBeenCalled();
  });

  it('想定外のエラー: 500 と汎用の文言を返し、RPC の生メッセージを画面に出さない', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'connection to server was lost' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toEqual({ code: 'UNKNOWN', message: '組織オーナー権限の引き継ぎに失敗しました。' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('CHECK 違反 (23514) などの生の DB のエラーは、本文に出さず 500 と汎用の文言にし、構造化ログにだけ残す', async () => {
    const rawMessage =
      'new row for relation "user_profiles" violates check constraint "user_profiles_org_consistency"';
    mocks.rpc.mockResolvedValue({ data: null, error: { message: rawMessage, code: '23514' } });

    const res = await call();
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'UNKNOWN', message: '組織オーナー権限の引き継ぎに失敗しました。' },
    });
    expect(text).not.toContain('user_profiles_org_consistency');
    expect(text).not.toContain('23514');
    expect(mocks.logError).toHaveBeenCalledTimes(1);
    expect(mocks.logError.mock.calls[0][2]).toEqual({ proposal_id: PROPOSAL_ID, pg_code: '23514' });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('デッドロック (SQLSTATE 40P01) は 409 CONFLICT_RETRY と「もう一度お試しください」の文にする (SQLSTATE を mapPgErrorToHttp に渡す)', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'deadlock detected', code: '40P01' } });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toEqual({
      code: 'CONFLICT_RETRY',
      message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.CONFLICT_RETRY],
    });
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('未認証: 401 を返し、提案も RPC も触らない', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe('NOT_AUTHENTICATED');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(userDb.events).toEqual([]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

describe('POST /api/org/owner-transfer/[id]/accept: 18 歳未満の本人 (#1173 T-MN4)', () => {
  it('RPC が MINOR_ACCOUNT_NOT_ALLOWED を返したら 403 (message は MEMBERSHIP_ERROR_MESSAGES の文。固定の文にならない)。メールは送らない', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'MINOR_ACCOUNT_NOT_ALLOWED: caller user_profiles.birth_date is under 18' } });

    const res = await call();
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'MINOR_ACCOUNT_NOT_ALLOWED', message: MEMBERSHIP_ERROR_MESSAGES[MembershipErrorCode.MINOR_ACCOUNT_NOT_ALLOWED] },
    });
    expect(text).not.toContain('組織オーナー権限の引き継ぎに失敗しました。');
    expect(text).not.toContain('birth_date');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
