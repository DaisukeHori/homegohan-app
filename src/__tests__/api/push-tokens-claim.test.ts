// @vitest-environment node
/**
 * POST /api/push-tokens/claim のテスト (#1599)
 *
 * 共有の端末で、前の利用者のログアウトの削除 (user_push_tokens の本人の行) がオフラインなどで失敗すると、
 * 前の利用者の行が残り、次の利用者がログインしたあとも前の利用者宛ての通知がこの端末に届き得た。
 * いまはアプリが登録 (本人の行の upsert) の直後にこの API を呼び、同じトークンのほかの利用者の行をサーバーで外す。
 *
 * user_push_tokens を、RLS (本人の行だけ読める・書ける・消せる) と service_role (すべて) を真似た表で持ち、
 *   - 利用者 A が登録した同じトークンを、利用者 B が登録して claim すると、A には紐づかない (B の 1 行だけ)
 *   - A の別の端末のトークン・ほかのトークンの行は消さない
 *   - 認証・本文の形・本人の登録の確認に落ちたら、何も消さない (service_role のクライアントも作らない)
 *   - 消すのに失敗したら、汎用の 500 (DB のエラー文を本文に出さない)
 * を確かめる。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { INTERNAL_ERROR_CODE } from '@/lib/api/errors';
import { MAX_EXPO_PUSH_TOKEN_LENGTH, PUSH_TOKEN_CLAIM_ERROR_CODES } from '@/lib/push-tokens';

type Row = { id: string; user_id: string; expo_push_token: string; platform: string | null };
type Filter = { column: keyof Row; op: 'eq' | 'neq'; value: string };

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; user_id: string; expo_push_token: string; platform: string | null }>,
  /** いまの要求の認証済みの利用者 (null なら未ログイン) */
  currentUserId: null as string | null,
  /** 設定すると、service_role の delete がこのエラーを返す */
  adminDeleteError: null as { message: string; code: string } | null,
  /** 設定すると、本人のクライアントの select がこのエラーを返す */
  ownSelectError: null as { message: string; code: string } | null,
  getSupabaseAdminCalls: 0,
  nextId: 0,
  logErrors: [] as unknown[],
}));

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => (f.op === 'eq' ? row[f.column] === f.value : row[f.column] !== f.value));
}

/**
 * user_push_tokens の 1 回の問い合わせ。visible は RLS で見える行 (本人のクライアントなら本人の行だけ)。
 * postgrest-js と同じく、絞り込みは自分自身を返し、await で結果になる。
 */
function tableQuery(visible: (row: Row) => boolean, errors: { select?: unknown; delete?: unknown }) {
  const filters: Filter[] = [];
  let mode: 'select' | 'delete' = 'select';
  const builder = {
    select: () => {
      mode = 'select';
      return builder;
    },
    delete: (_options?: { count?: string }) => {
      mode = 'delete';
      return builder;
    },
    eq: (column: keyof Row, value: string) => {
      filters.push({ column, op: 'eq', value });
      return builder;
    },
    neq: (column: keyof Row, value: string) => {
      filters.push({ column, op: 'neq', value });
      return builder;
    },
    maybeSingle: async () => {
      if (errors.select) return { data: null, error: errors.select };
      const found = h.rows.filter((row) => visible(row) && matches(row, filters));
      return { data: found[0] ? { id: found[0].id } : null, error: null };
    },
    then: (resolve: (value: { error: unknown; count: number | null }) => void) => {
      if (mode !== 'delete') throw new Error('この偽の表は、await では delete だけを扱う');
      if (errors.delete) return resolve({ error: errors.delete, count: null });
      const before = h.rows.length;
      h.rows = h.rows.filter((row) => !(visible(row) && matches(row, filters)));
      return resolve({ error: null, count: before - h.rows.length });
    },
  };
  return builder;
}

vi.mock('@/lib/supabase/server', () => ({
  // 本人のクライアント (Cookie / Bearer のセッション。RLS で本人の行だけ)
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.currentUserId ? { id: h.currentUserId } : null }, error: null }),
    },
    from: (table: string) => {
      if (table !== 'user_push_tokens') throw new Error(`想定外の表: ${table}`);
      return tableQuery((row) => row.user_id === h.currentUserId, { select: h.ownSelectError });
    },
  })),
  // service_role のクライアント (RLS を越えて、すべての行)
  getSupabaseAdmin: vi.fn(() => {
    h.getSupabaseAdminCalls += 1;
    return {
      from: (table: string) => {
        if (table !== 'user_push_tokens') throw new Error(`想定外の表: ${table}`);
        return tableQuery(() => true, { delete: h.adminDeleteError });
      },
    };
  }),
}));

// internalError() の構造化ログ。app_logs へは書かない
vi.mock('@/lib/db-logger', () => {
  const logger = {
    error: (...args: unknown[]) => h.logErrors.push(args),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    withUser: () => logger,
  };
  return { createLogger: () => logger, generateRequestId: () => 'req-test' };
});

const { POST } = await import('@/app/api/push-tokens/claim/route');

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const SHARED_DEVICE_TOKEN = 'ExponentPushToken[shared-device]';
const A_OTHER_DEVICE_TOKEN = 'ExponentPushToken[a-other-device]';

/** アプリの登録 (本人のクライアントでの upsert。RLS で本人の行だけ) を真似る */
function registerAs(userId: string, token: string): void {
  if (h.rows.some((row) => row.user_id === userId && row.expo_push_token === token)) return;
  h.nextId += 1;
  h.rows.push({ id: `row-${h.nextId}`, user_id: userId, expo_push_token: token, platform: 'ios' });
}

function claimRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/push-tokens/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function claimAs(userId: string | null, body: unknown) {
  h.currentUserId = userId;
  const res = await POST(claimRequest(body));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** いまの表の、トークンごとの持ち主 */
function ownersOf(token: string): string[] {
  return h.rows.filter((row) => row.expo_push_token === token).map((row) => row.user_id).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.currentUserId = null;
  h.adminDeleteError = null;
  h.ownSelectError = null;
  h.getSupabaseAdminCalls = 0;
  h.nextId = 0;
  h.logErrors = [];
});

describe('POST /api/push-tokens/claim — 同じトークンは、最後に登録した 1 人にだけ紐づく (#1599)', () => {
  it('利用者 A で登録したトークンを、同じ端末で利用者 B が登録して claim すると、A には紐づかない', async () => {
    // A がこの端末で登録 → ログアウトの削除がオフラインで失敗して A の行が残った
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    expect(await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN })).toEqual({ status: 200, json: { released: 0 } });

    // 同じ端末で B がログインして登録
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A, USER_B]);

    const res = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN });

    expect(res).toEqual({ status: 200, json: { released: 1 } });
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_B]);
  });

  it('A の別の端末のトークンの行と、B のほかの行は消さない (同じトークンのほかの利用者の行だけ)', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_A, A_OTHER_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, 'ExpoPushToken[b-tablet]');

    await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN });

    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_B]);
    expect(ownersOf(A_OTHER_DEVICE_TOKEN)).toEqual([USER_A]);
    expect(ownersOf('ExpoPushToken[b-tablet]')).toEqual([USER_B]);
  });

  it('A がもう一度この端末でログインし直せば、今度は B の行が外れる (何度呼んでも、最後の 1 人だけ)', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN });

    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    expect(await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN })).toEqual({ status: 200, json: { released: 1 } });
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A]);

    // やり直しても同じ結果 (消す行が無いだけ)
    expect(await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN })).toEqual({ status: 200, json: { released: 0 } });
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A]);
  });

  it('新しい SDK の形 (ExpoPushToken[...]) も受け付ける', async () => {
    const token = 'ExpoPushToken[new-sdk-format]';
    registerAs(USER_A, token);
    registerAs(USER_B, token);

    expect(await claimAs(USER_B, { expo_push_token: token })).toEqual({ status: 200, json: { released: 1 } });
    expect(ownersOf(token)).toEqual([USER_B]);
  });
});

describe('POST /api/push-tokens/claim — 確かめに落ちたら、何も消さない', () => {
  it('未ログインは 401 (service_role のクライアントを作らない)', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);

    const res = await claimAs(null, { expo_push_token: SHARED_DEVICE_TOKEN });

    expect(res.status).toBe(401);
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A]);
    expect(h.getSupabaseAdminCalls).toBe(0);
  });

  it.each([
    ['本文が JSON でない', 'not-json'],
    ['expo_push_token が無い', {}],
    ['本文が null', null],
    ['文字列でない', { expo_push_token: 123 }],
    ['空', { expo_push_token: '' }],
    ['Expo の形でない', { expo_push_token: 'some-other-string' }],
    ['中身が空の括弧', { expo_push_token: 'ExponentPushToken[]' }],
    ['前後に余計な文字', { expo_push_token: ` ${SHARED_DEVICE_TOKEN}` }],
    ['上限より長い', { expo_push_token: `ExponentPushToken[${'x'.repeat(MAX_EXPO_PUSH_TOKEN_LENGTH)}]` }],
  ])('%s: 400 (service_role のクライアントを作らない)', async (_label, body) => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN);

    const res = await claimAs(USER_B, body);

    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe(PUSH_TOKEN_CLAIM_ERROR_CODES.INVALID_REQUEST);
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A, USER_B]);
    expect(h.getSupabaseAdminCalls).toBe(0);
  });

  it('呼び出した利用者の行にそのトークンが無ければ 404。登録していないトークンで、ほかの利用者の行を消させない', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);

    const res = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN });

    expect(res.status).toBe(404);
    expect((res.json.error as { code: string }).code).toBe(PUSH_TOKEN_CLAIM_ERROR_CODES.NOT_REGISTERED);
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A]);
    expect(h.getSupabaseAdminCalls).toBe(0);
  });

  it('本人の行を確かめる問い合わせが失敗したら、汎用の 500 で、何も消さない', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    h.ownSelectError = { message: 'relation "user_push_tokens" secret detail', code: '42P01' };

    const res = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN });

    expect(res.status).toBe(500);
    expect(res.json.code).toBe(INTERNAL_ERROR_CODE);
    expect(JSON.stringify(res.json)).not.toContain('secret detail');
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A, USER_B]);
    expect(h.getSupabaseAdminCalls).toBe(0);
  });

  it('ほかの利用者の行を消すのに失敗したら、汎用の 500 (DB のエラー文・トークンを本文に出さない。元のエラーはログへ)', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    h.adminDeleteError = { message: 'permission denied secret detail', code: '42501' };

    const res = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN });

    expect(res.status).toBe(500);
    expect(res.json.code).toBe(INTERNAL_ERROR_CODE);
    const sent = JSON.stringify(res.json);
    expect(sent).not.toContain('secret detail');
    expect(sent).not.toContain(SHARED_DEVICE_TOKEN);
    expect(h.logErrors).toHaveLength(1);
    // 消せていないので、アプリは登録の失敗として扱い、次の起動でやり直す
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A, USER_B]);
  });
});
