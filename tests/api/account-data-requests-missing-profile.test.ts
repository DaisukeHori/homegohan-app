// @vitest-environment node
/**
 * #1751 個人情報の請求 (DSR) の本人向け API (/api/account/data-requests/**) を、user_profiles の行がまだ無い利用者も使えることの回帰テスト
 * (設計 docs/design/cross/15-data-subject-requests.md §7.1・§9.1)。
 *
 * user_profiles の行は新規登録の時点では無く、同意 (accept_legal_documents)・初期設定・招待の承諾で作られる。
 * 同意の画面の「請求の画面へ」の案内を押すのは多くが新規登録の直後の人 (行が無い) なので、6 route の認証が
 * requireUser (行が無いと AUTH_PROFILE_NOT_FOUND → 401) のままだと、画面は開けても一覧も作成も 401 で請求できなかった。
 *
 * tests/api/account-data-requests-route.test.ts は認証の helper をモックするが、ここでは本物の
 * requireUserAllowingMissingProfile (src/lib/auth/helpers.ts) と authenticateDsrRequester を通し、Supabase の client だけを差し替える。
 * user_profiles の読み取りは本物の PostgREST と同じ 0 行の扱いにする (maybeSingle は data: null・error: null、single は PGRST116)。
 * 認証が .single() の読み方 (requireUser) に戻ると、行の無い利用者がここで 401 になり赤くなる。
 * あわせて、6 route と requester-http.ts が行を要る認証 (requireUser / requireRole) を呼ばないことを、本文 (コメントを除く) で見張る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LEGAL_CONSENT_EXEMPT_API_PATHS } from '@homegohan/shared';
import { hashDsrVerificationToken } from '@/lib/data-subject-requests/tokens';
import { FakeDsrDb, type FakeRow } from '../../src/__tests__/lib/data-subject-requests/fake-dsr-db';
import { listRouteFiles, stripComments } from '../helpers/ai-reach';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  createClient: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  checkRateLimit: vi.fn(),
  sendEmail: vi.fn(),
  getUserById: vi.fn(),
}));

// 認証の helper (@/lib/auth/helpers) はモックしない。本物が createClient の client で auth.getUser と user_profiles を読む
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient, getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit');
  return { ...actual, checkRateLimit: mocks.checkRateLimit };
});
vi.mock('@/lib/emails/send', () => ({ sendEmail: mocks.sendEmail }));

import { GET as listHandler, POST as createHandler } from '@/app/api/account/data-requests/route';
import { GET as detailHandler } from '@/app/api/account/data-requests/[id]/route';
import { POST as verifyHandler } from '@/app/api/account/data-requests/[id]/verify/route';
import { POST as resendHandler } from '@/app/api/account/data-requests/[id]/resend-verification/route';
import { POST as withdrawHandler } from '@/app/api/account/data-requests/[id]/withdraw/route';

const ME = '11111111-1111-4111-8111-111111111111';
const MY_EMAIL = 'new-user@example.test';
const OPERATOR_EMAIL = 'operator@example.test';
const TOKEN = 'a'.repeat(64);
const BASE = 'http://localhost/api/account/data-requests';
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
/** 連打の上限の結果の形 (カテゴリ dsr の先頭の規則: 10 分に 5 回) */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SEC = 600;
const RATE_LIMIT_RESET_IN_MS = 120_000;
/** PostgREST が .single() で 0 行のときに返すエラー */
const NO_ROW_ERROR = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
/** 凍結した日時の例 (無期限 BAN) */
const FROZEN_AT = '2026-07-01T00:00:00.000Z';

type ProfileState = { kind: 'missing' } | { kind: 'row'; row: Record<string, unknown> } | { kind: 'error'; error: unknown };

let db: FakeDsrDb;
let profileState: ProfileState;
/** user_profiles の読み取りの記録 (最後に呼んだのが maybeSingle か single か) */
let profileReads: Array<{ columns: string; filters: Array<[string, unknown]>; terminal: string }>;

/** user_profiles の読み取り。0 行の扱いは本物の PostgREST と同じ */
function profileQuery() {
  const read = { columns: '', filters: [] as Array<[string, unknown]>, terminal: '' };
  profileReads.push(read);
  const result = (terminal: 'maybeSingle' | 'single') => {
    read.terminal = terminal;
    if (profileState.kind === 'error') return { data: null, error: profileState.error };
    if (profileState.kind === 'row') return { data: profileState.row, error: null };
    return terminal === 'maybeSingle' ? { data: null, error: null } : { data: null, error: NO_ROW_ERROR };
  };
  const builder = {
    select: (columns: string) => {
      read.columns = columns;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      read.filters.push([column, value]);
      return builder;
    },
    maybeSingle: async () => result('maybeSingle'),
    single: async () => result('single'),
  };
  return builder;
}

/** 本人のセッションの client: auth.getUser は本人、user_profiles は profileState、ほかの表は FakeDsrDb ('user') */
function sessionClient(): SupabaseClient {
  const dsr = db.client('user') as unknown as { from: (table: string) => unknown };
  return {
    auth: { getUser: mocks.getUser },
    from: (table: string) => (table === 'user_profiles' ? profileQuery() : dsr.from(table)),
  } as unknown as SupabaseClient;
}

function adminClient(): SupabaseClient {
  const base = db.client('admin') as unknown as Record<string, unknown>;
  return { ...base, auth: { admin: { getUserById: mocks.getUserById } } } as unknown as SupabaseClient;
}

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function plainRequest(url: string, method = 'POST'): Request {
  return new Request(url, { method });
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** 本人確認待ちの本人の行 (トークンは TOKEN、期限は 1 時間後) */
function seedPending(): FakeRow {
  return db.seed({
    user_id: ME,
    status: 'pending_verification',
    verification_token_hash: hashDsrVerificationToken(TOKEN),
    verification_sent_at: iso(-MS_PER_HOUR),
    verification_expires_at: iso(MS_PER_HOUR),
    verification_send_count: 1,
  });
}

beforeEach(() => {
  db = new FakeDsrDb();
  profileState = { kind: 'missing' };
  profileReads = [];
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: ME, email: MY_EMAIL } }, error: null });
  mocks.createClient.mockReset().mockImplementation(async () => sessionClient());
  mocks.getSupabaseAdmin.mockReset().mockImplementation(() => adminClient());
  mocks.checkRateLimit.mockReset().mockResolvedValue({
    success: true,
    limit: RATE_LIMIT_MAX,
    remaining: RATE_LIMIT_MAX - 1,
    reset: Date.now() + RATE_LIMIT_RESET_IN_MS,
    windowSec: RATE_LIMIT_WINDOW_SEC,
  });
  mocks.sendEmail.mockReset().mockResolvedValue({ ok: true, id: 'email-1' });
  mocks.getUserById.mockReset().mockResolvedValue({ data: { user: { id: ME, email: MY_EMAIL } }, error: null });
  vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', OPERATOR_EMAIL);
  vi.stubEnv('DSR_RESPONSE_DUE_DAYS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 6 handler。seed は呼ぶ前に入れる本人の行 (要るものだけ)、ok はその handler の本来の成功の status */
type HandlerCase = { name: string; seed: () => FakeRow | null; call: (row: FakeRow | null) => Promise<Response>; ok: number };

const idOf = (row: FakeRow | null): string => String(row?.id);

const HANDLERS: HandlerCase[] = [
  { name: 'GET 一覧', seed: () => null, call: () => listHandler(), ok: 200 },
  {
    name: 'POST 作成',
    seed: () => null,
    call: () => createHandler(jsonRequest(BASE, { request_type: 'disclosure', details: '保有している情報を開示してください' })),
    ok: 201,
  },
  {
    name: 'GET 詳細',
    seed: seedPending,
    call: (row) => detailHandler(plainRequest(`${BASE}/${idOf(row)}`, 'GET'), context(idOf(row))),
    ok: 200,
  },
  {
    name: 'POST verify',
    seed: seedPending,
    call: (row) => verifyHandler(jsonRequest(`${BASE}/${idOf(row)}/verify`, { token: TOKEN }), context(idOf(row))),
    ok: 200,
  },
  {
    name: 'POST resend',
    seed: seedPending,
    call: (row) => resendHandler(plainRequest(`${BASE}/${idOf(row)}/resend-verification`), context(idOf(row))),
    ok: 200,
  },
  {
    name: 'POST withdraw',
    seed: seedPending,
    call: (row) => withdrawHandler(plainRequest(`${BASE}/${idOf(row)}/withdraw`), context(idOf(row))),
    ok: 200,
  },
];

describe('user_profiles の行がまだ無い利用者 (新規登録の直後・未同意・初期設定の前) も請求の API を使える (#1751)', () => {
  it.each(HANDLERS)('★$name: 401 にならず本来の応答 ($ok) に進む。user_profiles は maybeSingle で frozen_at・unban_at だけを本人の id で読む', async ({ seed, call, ok }) => {
    const row = seed();

    const res = await call(row);

    expect(res.status).toBe(ok);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(profileReads).toEqual([{ columns: 'frozen_at, unban_at', filters: [['id', ME]], terminal: 'maybeSingle' }]);
  });

  it('一覧: 本人の行だけを読み、まだ請求が無ければ { requests: [] }', async () => {
    const res = await listHandler();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requests: [] });
    expect(db.callsOf('select', 'user').map((call) => call.filters.map((f) => [f.kind, f.column, f.value]))).toEqual([[['eq', 'user_id', ME]]]);
  });

  it('作成: 本人の請求を本人確認待ちで作り、登録アドレスへ本人確認のメールを送る (行を作らずに出せる)', async () => {
    const res = await createHandler(jsonRequest(BASE, { request_type: 'erasure', details: 'すべて消してください' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.request).toMatchObject({ status: 'pending_verification', request_type: 'erasure' });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].user_id).toBe(ME);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail.mock.calls[0][0]).toMatchObject({ template: 'dsr_verification', to: MY_EMAIL });
  });
});

describe('行がある利用者は今までどおり凍結を見る (#1751 で変えない)', () => {
  it.each(HANDLERS)('$name: 凍結中 (無期限 BAN) なら 403 AUTH_ACCOUNT_FROZEN。表に触れずメールも送らない', async ({ seed, call }) => {
    const row = seed();
    profileState = { kind: 'row', row: { frozen_at: FROZEN_AT, unban_at: null } };
    const callsBefore = db.calls.length;

    const res = await call(row);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'アカウントが凍結されています', code: 'AUTH_ACCOUNT_FROZEN' });
    expect(db.calls).toHaveLength(callsBefore);
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('一時 BAN の期限 (unban_at) を過ぎていれば通す', async () => {
    profileState = { kind: 'row', row: { frozen_at: FROZEN_AT, unban_at: iso(-MS_PER_DAY) } };

    expect((await listHandler()).status).toBe(200);
  });

  it('一時 BAN が続いている (unban_at が未来) なら 403', async () => {
    profileState = { kind: 'row', row: { frozen_at: FROZEN_AT, unban_at: iso(MS_PER_DAY) } };

    expect((await listHandler()).status).toBe(403);
  });

  it('凍結されていない行なら通す', async () => {
    profileState = { kind: 'row', row: { frozen_at: null, unban_at: null } };

    expect((await listHandler()).status).toBe(200);
  });
});

describe('行が無いのと読み取りの失敗は区別する', () => {
  it.each(HANDLERS)('$name: user_profiles の読み取りそのものが失敗したら 500 INTERNAL_ERROR (401 にも、凍結を確かめずに通すこともしない)。DB の文は出さない', async ({ seed, call }) => {
    const row = seed();
    profileState = { kind: 'error', error: { code: 'PGRST301', message: 'connection refused to db.internal:5432' } };
    const callsBefore = db.calls.length;

    const res = await call(row);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('db.internal');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(db.calls).toHaveLength(callsBefore);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each(HANDLERS)('$name: 未ログイン (getUser が user を返さない) なら 401 AUTH_UNAUTHENTICATED。user_profiles も読まない', async ({ seed, call }) => {
    const row = seed();
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await call(row);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'ログインが必要です', code: 'AUTH_UNAUTHENTICATED' });
    expect(profileReads).toEqual([]);
  });
});

describe('見張り: 本人の権利の請求の route は、行を要る認証 (requireUser / requireRole) を呼ばない (#1751)', () => {
  const ROOT = path.resolve(__dirname, '../..');
  /** 行を要る認証の呼び出し (requireUserAllowingMissingProfile は名前が続くので当たらない) */
  const PROFILE_REQUIRING_AUTH = /\brequire(?:User|Role)\s*\(/;
  const read = (file: string) => stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));

  /** 同意ゲートの許可リストで reason が data_subject_rights の行に当たる route のファイル */
  const dsrEntries = LEGAL_CONSENT_EXEMPT_API_PATHS.filter((entry) => entry.reason === 'data_subject_rights');
  const dsrRouteFiles = listRouteFiles().filter((file) => {
    const apiPath = file.replace(/^src\/app/, '').replace(/\/route\.tsx?$/, '');
    return dsrEntries.some((entry) => apiPath === entry.path || (entry.match === 'prefix' && apiPath.startsWith(`${entry.path}/`)));
  });

  it('許可リストの data_subject_rights の行は、src/app/api/account/data-requests の 5 ファイル (6 handler) に当たる', () => {
    expect(dsrEntries.map((entry) => entry.path)).toEqual(['/api/account/data-requests']);
    expect(dsrRouteFiles).toEqual([
      'src/app/api/account/data-requests/[id]/resend-verification/route.ts',
      'src/app/api/account/data-requests/[id]/route.ts',
      'src/app/api/account/data-requests/[id]/verify/route.ts',
      'src/app/api/account/data-requests/[id]/withdraw/route.ts',
      'src/app/api/account/data-requests/route.ts',
    ]);
  });

  it('各 route は本人の確認を authenticateDsrRequester に任せ、requireUser / requireRole を呼ばない', () => {
    for (const file of dsrRouteFiles) {
      const body = read(file);
      expect(body, file).toMatch(/\bauthenticateDsrRequester\s*\(/);
      expect(body, file).not.toMatch(PROFILE_REQUIRING_AUTH);
    }
  });

  it('authenticateDsrRequester (requester-http.ts) は requireUserAllowingMissingProfile を呼び、requireUser / requireRole を呼ばない', () => {
    const body = read('src/lib/data-subject-requests/requester-http.ts');
    expect(body).toMatch(/\brequireUserAllowingMissingProfile\s*\(/);
    expect(body).not.toMatch(PROFILE_REQUIRING_AUTH);
  });
});
