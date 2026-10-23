// @vitest-environment node
/**
 * #1178 / #1702 個人情報の請求 (DSR) の本人向け API (/api/account/data-requests/**) の route テスト
 * (設計 docs/design/cross/15-data-subject-requests.md §7.1・§7.2・§13・§15)。
 *
 * - DB は src/__tests__/lib/data-subject-requests/fake-dsr-db.ts (絞り込みを実際に適用する簡易 PostgREST)。
 *   本人のセッションの client (createClient) は 'user'、service_role の client (getSupabaseAdmin) は 'admin' として呼び分けを記録する。
 * - 認証は requireUserAllowingMissingProfile をモックする (AuthError → 401・ForbiddenError (凍結) → 403 の変換を見る)。
 *   user_profiles の行が無い利用者を本物の helper で通すことは tests/api/account-data-requests-missing-profile.test.ts (#1751)。
 * - メールは notifications.ts をそのまま通し、送信 (sendEmail) と宛先の取得 (auth.admin.getUserById) をモックする。
 * - 連打の上限 (checkRateLimit) はモックする (429 の本文は本物の rateLimitExceededResponse)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NULL_CHARACTER_ERROR_CODE, NULL_CHARACTER_ERROR_MESSAGE } from '@/lib/api/null-character';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import {
  DSR_DETAILS_MAX_LENGTH,
  DSR_OPEN_STATUSES,
  DSR_OWN_COLUMNS,
  DSR_OWN_LIST_LIMIT,
  DSR_REQUESTER_ACTION_COLUMNS,
  DSR_RESPONSE_DUE_DAYS_DEFAULT,
  DSR_VERIFICATION_MAX_SENDS,
  type DsrStatus,
} from '@/lib/data-subject-requests/core';
import { hashDsrVerificationToken } from '@/lib/data-subject-requests/tokens';
import { FakeDsrDb, type FakeRow } from '../../src/__tests__/lib/data-subject-requests/fake-dsr-db';

const mocks = vi.hoisted(() => ({
  requireUserAllowingMissingProfile: vi.fn(),
  createClient: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  checkRateLimit: vi.fn(),
  sendEmail: vi.fn(),
  getUserById: vi.fn(),
}));

// 本人の確認は requester-http.ts の authenticateDsrRequester が requireUserAllowingMissingProfile で行う (#1751。行の無い利用者も通す)。
// requireUser はモックに置かない (認証が requireUser に戻ると、モックに無い export の参照が例外になって 500 になり、この表の 401 / 403 / 200 が赤くなる)
vi.mock('@/lib/auth/helpers', () => ({ requireUserAllowingMissingProfile: mocks.requireUserAllowingMissingProfile }));
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
const OTHER = '22222222-2222-4222-8222-222222222222';
const MY_EMAIL = 'me@example.test';
const OPERATOR_EMAIL = 'operator@example.test';
const TOKEN = 'a'.repeat(64);
const WRONG_TOKEN = 'b'.repeat(64);
const NOT_A_UUID = 'not-a-uuid';
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
/** 時刻の比較の許容 (テストの実行中に進む時間) */
const CLOCK_TOLERANCE_MS = 60 * 1000;
/** 環境変数で上書きする応答期限 (日)。既定 (30) と違う値 */
const OVERRIDDEN_DUE_DAYS = 10;
const BASE = 'http://localhost/api/account/data-requests';
const NUL = '\u0000';
/** 連打の上限の結果の形 (カテゴリ dsr の先頭の規則: 10 分に 5 回) */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SEC = 600;
/** 上限に掛かったときの、再開までの時間 (ミリ秒) */
const RATE_LIMIT_RESET_IN_MS = 120_000;

function rateLimitResult(success: boolean) {
  return {
    success,
    limit: RATE_LIMIT_MAX,
    remaining: success ? RATE_LIMIT_MAX - 1 : 0,
    reset: Date.now() + RATE_LIMIT_RESET_IN_MS,
    windowSec: RATE_LIMIT_WINDOW_SEC,
  };
}

let db: FakeDsrDb;

function adminClient(): SupabaseClient {
  const base = db.client('admin') as unknown as Record<string, unknown>;
  return { ...base, auth: { admin: { getUserById: mocks.getUserById } } } as unknown as SupabaseClient;
}

function context(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function plainRequest(url: string, method = 'POST'): Request {
  return new Request(url, { method });
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** 本人確認待ちの行 (トークンは TOKEN、期限は 1 時間後) */
function seedPending(overrides: FakeRow = {}): FakeRow {
  return db.seed({
    user_id: ME,
    status: 'pending_verification',
    verification_token_hash: hashDsrVerificationToken(TOKEN),
    verification_sent_at: iso(-MS_PER_HOUR),
    verification_expires_at: iso(MS_PER_HOUR),
    verification_send_count: 1,
    ...overrides,
  });
}

/** 受付より後の状態の行 */
function seedVerified(status: DsrStatus, overrides: FakeRow = {}): FakeRow {
  const terminal = status === 'fulfilled' || status === 'rejected' || status === 'withdrawn';
  return db.seed({
    user_id: ME,
    status,
    verification_token_hash: null,
    verified_at: iso(-MS_PER_DAY),
    due_at: iso(MS_PER_DAY),
    resolved_at: terminal ? iso(-MS_PER_HOUR) : null,
    ...overrides,
  });
}

/** 送ったメールの template 名 (送った順) */
function sentTemplates(): string[] {
  return mocks.sendEmail.mock.calls.map((call) => (call[0] as { template: string }).template);
}

function filtersOf(call: { filters: Array<{ kind: string; column: string; value: unknown }> }) {
  return call.filters.map((f) => [f.kind, f.column, f.value]);
}

beforeEach(() => {
  db = new FakeDsrDb();
  mocks.requireUserAllowingMissingProfile.mockReset().mockResolvedValue({ id: ME, email: MY_EMAIL });
  mocks.createClient.mockReset().mockImplementation(async () => db.client('user'));
  mocks.getSupabaseAdmin.mockReset().mockImplementation(() => adminClient());
  mocks.checkRateLimit.mockReset().mockResolvedValue(rateLimitResult(true));
  mocks.sendEmail.mockReset().mockResolvedValue({ ok: true, id: 'email-1' });
  mocks.getUserById.mockReset().mockResolvedValue({ data: { user: { id: ME, email: MY_EMAIL } }, error: null });
  vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', OPERATOR_EMAIL);
  vi.stubEnv('DSR_RESPONSE_DUE_DAYS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// 認証・id の形式 (6 handler 共通)
// ─────────────────────────────────────────────────────────────────────────────

type HandlerCase = { name: string; call: (id: string) => Promise<Response>; hasId: boolean };

const HANDLERS: HandlerCase[] = [
  { name: 'GET 一覧', call: () => listHandler(), hasId: false },
  {
    name: 'POST 作成',
    call: () => createHandler(jsonRequest(BASE, { request_type: 'disclosure', details: '開示してください' })),
    hasId: false,
  },
  { name: 'GET 詳細', call: (id) => detailHandler(plainRequest(`${BASE}/${id}`, 'GET'), context(id)), hasId: true },
  { name: 'POST verify', call: (id) => verifyHandler(jsonRequest(`${BASE}/${id}/verify`, { token: TOKEN }), context(id)), hasId: true },
  { name: 'POST resend', call: (id) => resendHandler(plainRequest(`${BASE}/${id}/resend-verification`), context(id)), hasId: true },
  { name: 'POST withdraw', call: (id) => withdrawHandler(plainRequest(`${BASE}/${id}/withdraw`), context(id)), hasId: true },
];

describe('6 handler 共通: 認証と id の形式 (§7.1・§7.2)', () => {
  it.each(HANDLERS)('$name: 未ログイン (AuthError) は 401 AUTH_UNAUTHENTICATED。表に触れずメールも送らない', async ({ call }) => {
    const row = seedPending();
    mocks.requireUserAllowingMissingProfile.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));

    const res = await call(String(row.id));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'ログインが必要です', code: 'AUTH_UNAUTHENTICATED' });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(db.calls).toHaveLength(0);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each(HANDLERS)('$name: 凍結中 (ForbiddenError) は 403 AUTH_ACCOUNT_FROZEN。表に触れずメールも送らない', async ({ call }) => {
    const row = seedPending();
    mocks.requireUserAllowingMissingProfile.mockRejectedValue(new ForbiddenError('AUTH_ACCOUNT_FROZEN', 'アカウントが凍結されています'));

    const res = await call(String(row.id));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'アカウントが凍結されています', code: 'AUTH_ACCOUNT_FROZEN' });
    expect(db.calls).toHaveLength(0);
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each(HANDLERS)('$name: 認証の確認そのものが例外 (DB の障害) なら 500 INTERNAL_ERROR (生のエラー文を出さない)', async ({ call }) => {
    const row = seedPending();
    mocks.requireUserAllowingMissingProfile.mockRejectedValue(new Error('connection refused to db.internal:5432'));

    const res = await call(String(row.id));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('db.internal');
    expect(db.calls).toHaveLength(0);
  });

  it.each(HANDLERS.filter((h) => h.hasId))('$name: id が UUID でなければ 400 VALIDATION_ERROR。表に触れない', async ({ call }) => {
    const res = await call(NOT_A_UUID);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toBe('入力内容を確認してください');
    expect(db.calls).toHaveLength(0);
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('本文を読む 2 handler (POST 作成・verify): NULL 文字は認証より先に 400 (§7.1・S-15)', () => {
  const BODY_READERS = [
    {
      name: 'POST 作成',
      call: (body: unknown) => createHandler(jsonRequest(BASE, body)),
    },
    {
      name: 'POST verify',
      call: (body: unknown) => verifyHandler(jsonRequest(`${BASE}/${OTHER}/verify`, body), context(OTHER)),
    },
  ];

  it.each(BODY_READERS)('$name: 未ログインでも、本文に NULL 文字があれば 400 INVALID_CHARACTER (本人の確認も DB も呼ばない)', async ({ call }) => {
    mocks.requireUserAllowingMissingProfile.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));

    const res = await call({ request_type: 'disclosure', details: `内容${NUL}`, token: `${TOKEN}${NUL}` });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: NULL_CHARACTER_ERROR_MESSAGE, code: NULL_CHARACTER_ERROR_CODE });
    expect(mocks.requireUserAllowingMissingProfile).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it.each(BODY_READERS)('$name: 未ログインで NULL 文字が無ければ 401', async ({ call }) => {
    mocks.requireUserAllowingMissingProfile.mockRejectedValue(new AuthError('AUTH_UNAUTHENTICATED'));

    const res = await call({ request_type: 'disclosure', details: '内容', token: TOKEN });

    expect(res.status).toBe(401);
    expect(mocks.requireUserAllowingMissingProfile).toHaveBeenCalledTimes(1);
  });

  it.each(BODY_READERS)('$name: 本文が JSON でなければ 400 INVALID_JSON', async ({ call }) => {
    const res = await call('{not json');
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'リクエストボディが不正です', code: 'INVALID_JSON' });
    expect(db.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET 一覧・GET 詳細
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/account/data-requests (一覧)', () => {
  it('本人のセッションの client で DSR_OWN_COLUMNS を読み、本人の user_id で絞り、新しい順・最大 DSR_OWN_LIST_LIMIT 件', async () => {
    seedVerified('received');
    seedPending({ request_type: 'erasure' });

    const res = await listHandler();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(body.requests).toHaveLength(2);
    const [call] = db.callsOf('select');
    expect(call.client).toBe('user');
    expect(call.columns).toBe(DSR_OWN_COLUMNS);
    expect(filtersOf(call)).toEqual([['eq', 'user_id', ME]]);
    expect(call.orders).toEqual([
      { column: 'created_at', ascending: false, nullsFirst: undefined },
      { column: 'id', ascending: false, nullsFirst: undefined },
    ]);
    expect(call.limit).toBe(DSR_OWN_LIST_LIMIT);
    // 新しい順 (後に作った erasure が先)
    expect(body.requests.map((r: { request_type: string }) => r.request_type)).toEqual(['erasure', 'disclosure']);
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('運営ロール (admin) の本人でも、RLS 任せにせず user_id で絞る: 他人の行は応答に出ない (S-16)', async () => {
    // 運営ロールの本人のセッションには、RLS (select_operator) が全行を見せる。表に他人の行を置き、絞り込みが選ぶ行だけが返ることを見る
    mocks.requireUserAllowingMissingProfile.mockResolvedValue({ id: ME, email: MY_EMAIL, app_metadata: { roles: ['admin'] } });
    const mine = seedVerified('received');
    db.seed({ user_id: OTHER, status: 'received', verified_at: iso(-MS_PER_DAY), due_at: iso(MS_PER_DAY) });
    db.seed({ user_id: OTHER, request_type: 'erasure' });

    const res = await listHandler();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.requests.map((r: { id: string }) => r.id)).toEqual([mine.id]);
    expect(filtersOf(db.callsOf('select')[0])).toContainEqual(['eq', 'user_id', ME]);
  });

  it('応答に admin_notes・verification_token_hash・user_id が無く、verification_expired が入る', async () => {
    seedPending({ admin_notes: '内部メモ', verification_expires_at: iso(-MS_PER_HOUR) });

    const body = await (await listHandler()).json();
    const [request] = body.requests;

    expect(request).not.toHaveProperty('admin_notes');
    expect(request).not.toHaveProperty('verification_token_hash');
    expect(request).not.toHaveProperty('user_id');
    expect(request.verification_expired).toBe(true);
    expect(JSON.stringify(body)).not.toContain('内部メモ');
  });

  it('読み取りの失敗は 500 INTERNAL_ERROR (DB の生のエラー文を出さない)', async () => {
    db.failNext.select = { code: '42501', message: 'permission denied for table data_subject_requests' };

    const res = await listHandler();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });
});

describe('GET /api/account/data-requests/[id] (詳細)', () => {
  it('本人のセッションの client で id と本人の user_id の両方で絞って読み、{ request } を返す (応答に hash・内部メモが無い)', async () => {
    const row = seedVerified('fulfilled', { response_note: '開示の結果です', admin_notes: '内部メモ' });

    const res = await detailHandler(plainRequest(`${BASE}/${row.id}`, 'GET'), context(String(row.id)));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.request.id).toBe(row.id);
    expect(body.request.response_note).toBe('開示の結果です');
    expect(body.request).not.toHaveProperty('admin_notes');
    expect(body.request).not.toHaveProperty('verification_token_hash');
    const [call] = db.callsOf('select');
    expect(call.client).toBe('user');
    expect(call.columns).toBe(DSR_OWN_COLUMNS);
    expect(filtersOf(call)).toEqual([
      ['eq', 'id', row.id],
      ['eq', 'user_id', ME],
    ]);
  });

  it('運営ロール (admin) の本人でも、他人の id は 404 NOT_FOUND (S-16)', async () => {
    mocks.requireUserAllowingMissingProfile.mockResolvedValue({ id: ME, email: MY_EMAIL, app_metadata: { roles: ['admin'] } });
    const others = db.seed({ user_id: OTHER, status: 'received', verified_at: iso(-MS_PER_DAY), due_at: iso(MS_PER_DAY) });

    const res = await detailHandler(plainRequest(`${BASE}/${others.id}`, 'GET'), context(String(others.id)));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: '請求が見つかりません', code: 'NOT_FOUND' });
  });

  it('退会済み (user_id が NULL) の行も 404', async () => {
    const orphan = db.seed({ user_id: null, status: 'received', verified_at: iso(-MS_PER_DAY), due_at: iso(MS_PER_DAY) });

    const res = await detailHandler(plainRequest(`${BASE}/${orphan.id}`, 'GET'), context(String(orphan.id)));

    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST 作成
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/account/data-requests (作成)', () => {
  it('201 { request }: 本人確認待ちの行を service_role で作り、hash を返さず、本人確認のメールを 1 通送る', async () => {
    const res = await createHandler(jsonRequest(BASE, { request_type: 'disclosure', details: '保有している情報を開示してください' }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(body.request.status).toBe('pending_verification');
    expect(body.request.request_type).toBe('disclosure');
    expect(body.request.verification_send_count).toBe(1);
    expect(body.request).not.toHaveProperty('verification_token_hash');
    expect(body.request).not.toHaveProperty('admin_notes');
    expect(db.callsOf('insert')).toHaveLength(1);
    expect(db.callsOf('insert')[0].client).toBe('admin');
    expect(db.rows[0].user_id).toBe(ME);
    expect(typeof db.rows[0].verification_token_hash).toBe('string');
    expect(sentTemplates()).toEqual(['dsr_verification']);
    expect(mocks.sendEmail.mock.calls[0][0].to).toBe(MY_EMAIL);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(ME, 'dsr');
  });

  it('メールの送信に失敗しても 201 (best-effort)', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('resend is down'));

    const res = await createHandler(jsonRequest(BASE, { request_type: 'correction', details: '住所を直してください' }));

    expect(res.status).toBe(201);
    expect(db.rows).toHaveLength(1);
  });

  it(`内容が ${DSR_DETAILS_MAX_LENGTH + 1} 字なら 400 VALIDATION_ERROR (DB に触れない)`, async () => {
    const res = await createHandler(
      jsonRequest(BASE, { request_type: 'disclosure', details: 'あ'.repeat(DSR_DETAILS_MAX_LENGTH + 1) }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.fieldErrors.details).toBeDefined();
    expect(db.calls).toHaveLength(0);
  });

  it('未知の種類・空の内容は 400 VALIDATION_ERROR', async () => {
    for (const payload of [
      { request_type: 'deletion', details: '消して' },
      { request_type: 'erasure', details: '   ' },
      { request_type: 'erasure' },
    ]) {
      const res = await createHandler(jsonRequest(BASE, payload));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_ERROR');
    }
    expect(db.calls).toHaveLength(0);
  });

  it('同じ種類の開いている請求があれば 409 DSR_ALREADY_OPEN (23505)。行は増えずメールも送らない (S-4)', async () => {
    seedVerified('in_progress', { request_type: 'erasure' });

    const res = await createHandler(jsonRequest(BASE, { request_type: 'erasure', details: 'もう一度' }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: '同じ種類の請求がすでに受け付けられています。先にその請求の完了か取り下げをお待ちください',
      code: 'DSR_ALREADY_OPEN',
    });
    expect(db.rows).toHaveLength(1);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('連打の上限に掛かれば 429 RATE_LIMITED (Retry-After つき)。本文を読む前で、DB に触れない', async () => {
    mocks.checkRateLimit.mockResolvedValue(rateLimitResult(false));

    const res = await createHandler(jsonRequest(BASE, { request_type: 'disclosure', details: '開示' }));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(db.calls).toHaveLength(0);
    expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('連打の判定ができない (Redis の障害) ときは通さず 500 (fail-close)', async () => {
    mocks.checkRateLimit.mockRejectedValue(new Error('upstash unreachable'));

    const res = await createHandler(jsonRequest(BASE, { request_type: 'disclosure', details: '開示' }));

    expect(res.status).toBe(500);
    expect(db.calls).toHaveLength(0);
  });

  it('連打の判定は本文の検査より前 (§7.2 の順): 上限に掛かれば本文が壊れていても 429', async () => {
    mocks.checkRateLimit.mockResolvedValue(rateLimitResult(false));

    const res = await createHandler(jsonRequest(BASE, '{broken'));

    expect(res.status).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST verify
// ─────────────────────────────────────────────────────────────────────────────

function verify(id: unknown, token = TOKEN): Promise<Response> {
  return verifyHandler(jsonRequest(`${BASE}/${id}/verify`, { token }), context(String(id)));
}

describe('POST /api/account/data-requests/[id]/verify', () => {
  it('一致・期限内なら 200 で received・due_at = 受付 + 30 日・hash = null。メールは受付 (本人) と運営への知らせの 2 通', async () => {
    const row = seedPending();
    const before = Date.now();

    const res = await verify(row.id);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.request.status).toBe('received');
    const stored = db.find(row.id)!;
    expect(stored.status).toBe('received');
    expect(stored.verification_token_hash).toBeNull();
    const verifiedAt = Date.parse(String(stored.verified_at));
    expect(verifiedAt).toBeGreaterThanOrEqual(before - CLOCK_TOLERANCE_MS);
    expect(Date.parse(String(stored.due_at)) - verifiedAt).toBe(DSR_RESPONSE_DUE_DAYS_DEFAULT * MS_PER_DAY);
    expect(body.request.due_at).toBe(stored.due_at);
    expect([...sentTemplates()].sort()).toEqual(['dsr_operator_notice', 'dsr_received']);
    const recipients = mocks.sendEmail.mock.calls.map((call) => call[0].to).sort();
    expect(recipients).toEqual([MY_EMAIL, OPERATOR_EMAIL].sort());
  });

  it('行は service_role で DSR_REQUESTER_ACTION_COLUMNS を本人の user_id で絞って読み、UPDATE は状態と読んだ hash を条件にする', async () => {
    const row = seedPending();

    await verify(row.id);

    const [read] = db.callsOf('select');
    expect(read.client).toBe('admin');
    expect(read.columns).toBe(DSR_REQUESTER_ACTION_COLUMNS);
    expect(filtersOf(read)).toEqual([
      ['eq', 'id', row.id],
      ['eq', 'user_id', ME],
    ]);
    const [update] = db.callsOf('update');
    expect(update.client).toBe('admin');
    expect(filtersOf(update)).toEqual([
      ['eq', 'id', row.id],
      ['eq', 'user_id', ME],
      ['eq', 'status', 'pending_verification'],
      ['eq', 'verification_token_hash', hashDsrVerificationToken(TOKEN)],
    ]);
    expect(update.columns).toBe(DSR_OWN_COLUMNS);
  });

  it('環境変数 DSR_RESPONSE_DUE_DAYS で期限の日数を変えられる', async () => {
    vi.stubEnv('DSR_RESPONSE_DUE_DAYS', String(OVERRIDDEN_DUE_DAYS));
    const row = seedPending();

    await verify(row.id);

    const stored = db.find(row.id)!;
    expect(Date.parse(String(stored.due_at)) - Date.parse(String(stored.verified_at))).toBe(OVERRIDDEN_DUE_DAYS * MS_PER_DAY);
  });

  it('他人の id は 404 NOT_FOUND (書き込みもメールも無し)', async () => {
    const others = seedPending({ user_id: OTHER });

    const res = await verify(others.id);

    expect(res.status).toBe(404);
    expect(db.find(others.id)!.status).toBe('pending_verification');
    expect(db.callsOf('update')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it.each(['received', 'withdrawn', 'fulfilled'] as const)(
    '%s の請求は 409 DSR_INVALID_STATE (期限・トークンより先に判定。書き込みもメールも無し)',
    async (status) => {
      // 期限切れ・別のトークンでも 409 になること (判定の順が状態 → 期限 → トークン)
      const row = seedVerified(status, { verification_expires_at: iso(-MS_PER_HOUR) });

      const res = await verify(row.id, WRONG_TOKEN);

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'この請求は現在の状態ではその操作ができません', code: 'DSR_INVALID_STATE' });
      expect(db.callsOf('update')).toHaveLength(0);
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    },
  );

  it('期限切れは 410 DSR_VERIFICATION_EXPIRED (トークンより先。状態は変えない)', async () => {
    const row = seedPending({ verification_expires_at: iso(-MS_PER_HOUR) });

    const res = await verify(row.id, WRONG_TOKEN);

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: '確認リンクの期限が切れています。確認メールを再送してください',
      code: 'DSR_VERIFICATION_EXPIRED',
    });
    expect(db.find(row.id)!.status).toBe('pending_verification');
    expect(db.callsOf('update')).toHaveLength(0);
  });

  it('トークンの不一致は 400 DSR_VERIFICATION_INVALID', async () => {
    const row = seedPending();

    const res = await verify(row.id, WRONG_TOKEN);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '確認リンクが正しくありません', code: 'DSR_VERIFICATION_INVALID' });
    expect(db.callsOf('update')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('トークンの形 (64 桁の 16 進) でなければ 400 VALIDATION_ERROR (DB に触れない)', async () => {
    const row = seedPending();

    const res = await verify(row.id, 'short');

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(db.calls).toHaveLength(0);
  });

  it('判定の後に別のタブで取り下げられて UPDATE が 0 行なら 409 DSR_INVALID_STATE。メールを送らない', async () => {
    const row = seedPending();
    db.beforeUpdate = () => {
      Object.assign(db.find(row.id)!, { status: 'withdrawn', resolved_at: iso(0), verification_token_hash: null });
    };

    const res = await verify(row.id);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DSR_INVALID_STATE');
    expect(db.find(row.id)!.status).toBe('withdrawn');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST resend-verification
// ─────────────────────────────────────────────────────────────────────────────

function resend(id: unknown): Promise<Response> {
  return resendHandler(plainRequest(`${BASE}/${id}/resend-verification`), context(String(id)));
}

describe('POST /api/account/data-requests/[id]/resend-verification', () => {
  it('200: 新しい hash と期限で送信回数 +1・確認メールを 1 通。UPDATE は状態と読んだ送信回数を条件にする', async () => {
    const row = seedPending({ verification_send_count: 2, verification_expires_at: iso(-MS_PER_HOUR) });
    const oldHash = row.verification_token_hash;

    const res = await resend(row.id);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.request.verification_send_count).toBe(3);
    expect(body.request.verification_expired).toBe(false);
    const stored = db.find(row.id)!;
    expect(stored.verification_token_hash).not.toBe(oldHash);
    expect(Date.parse(String(stored.verification_expires_at))).toBeGreaterThan(Date.now());
    expect(sentTemplates()).toEqual(['dsr_verification']);
    const [update] = db.callsOf('update');
    expect(update.client).toBe('admin');
    expect(filtersOf(update)).toEqual([
      ['eq', 'id', row.id],
      ['eq', 'user_id', ME],
      ['eq', 'status', 'pending_verification'],
      ['eq', 'verification_send_count', 2],
    ]);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(ME, 'dsr');
  });

  it.each(['received', 'fulfilled', 'withdrawn'] as const)('%s の請求は 409 DSR_INVALID_STATE (書き込みもメールも無し)', async (status) => {
    const row = seedVerified(status);

    const res = await resend(row.id);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DSR_INVALID_STATE');
    expect(db.callsOf('update')).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it(`送信回数が ${DSR_VERIFICATION_MAX_SENDS} なら 409 DSR_VERIFICATION_LIMIT`, async () => {
    const row = seedPending({ verification_send_count: DSR_VERIFICATION_MAX_SENDS });

    const res = await resend(row.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: '確認メールの送信回数が上限に達しました。お問い合わせください',
      code: 'DSR_VERIFICATION_LIMIT',
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('判定の後に別のタブで確認が済んで UPDATE が 0 行なら 409 DSR_INVALID_STATE。メールを送らない', async () => {
    const row = seedPending();
    db.beforeUpdate = () => {
      Object.assign(db.find(row.id)!, {
        status: 'received',
        verified_at: iso(0),
        due_at: iso(MS_PER_DAY),
        verification_token_hash: null,
      });
    };

    const res = await resend(row.id);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DSR_INVALID_STATE');
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('他人の id は 404', async () => {
    const others = seedPending({ user_id: OTHER });

    expect((await resend(others.id)).status).toBe(404);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('連打の上限に掛かれば 429 (DB に触れない)', async () => {
    mocks.checkRateLimit.mockResolvedValue(rateLimitResult(false));
    const row = seedPending();

    const res = await resend(row.id);

    expect(res.status).toBe(429);
    expect(db.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST withdraw
// ─────────────────────────────────────────────────────────────────────────────

function withdraw(id: unknown): Promise<Response> {
  return withdrawHandler(plainRequest(`${BASE}/${id}/withdraw`), context(String(id)));
}

describe('POST /api/account/data-requests/[id]/withdraw', () => {
  it('received は withdrawn になり resolved_at が入る・hash = null。UPDATE は開いている 3 状態を条件にする。メールは送らない', async () => {
    const row = seedVerified('received');

    const res = await withdraw(row.id);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.request.status).toBe('withdrawn');
    expect(body.request.resolved_at).not.toBeNull();
    const stored = db.find(row.id)!;
    expect(stored.status).toBe('withdrawn');
    expect(stored.verification_token_hash).toBeNull();
    const [update] = db.callsOf('update');
    expect(update.client).toBe('admin');
    expect(filtersOf(update)).toEqual([
      ['eq', 'id', row.id],
      ['eq', 'user_id', ME],
      ['in', 'status', [...DSR_OPEN_STATUSES]],
    ]);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('本人確認待ちも取り下げられ、hash が消える (S-3)', async () => {
    const row = seedPending();

    const res = await withdraw(row.id);

    expect(res.status).toBe(200);
    expect(db.find(row.id)!.verification_token_hash).toBeNull();
  });

  it('fulfilled は 409 DSR_INVALID_STATE (書き込み無し)', async () => {
    const row = seedVerified('fulfilled', { response_note: '対応しました' });

    const res = await withdraw(row.id);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DSR_INVALID_STATE');
    expect(db.callsOf('update')).toHaveLength(0);
  });

  it('判定の後に運営が fulfilled にして UPDATE が 0 行なら 409 DSR_INVALID_STATE (対応済みの行を上書きしない)', async () => {
    const row = seedVerified('in_progress');
    db.beforeUpdate = () => {
      Object.assign(db.find(row.id)!, { status: 'fulfilled', resolved_at: iso(0), response_note: '対応しました' });
    };

    const res = await withdraw(row.id);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DSR_INVALID_STATE');
    expect(db.find(row.id)!.status).toBe('fulfilled');
    expect(db.find(row.id)!.response_note).toBe('対応しました');
  });

  it('他人の id は 404', async () => {
    const others = seedVerified('received', { user_id: OTHER });

    expect((await withdraw(others.id)).status).toBe(404);
    expect(db.find(others.id)!.status).toBe('received');
  });
});
