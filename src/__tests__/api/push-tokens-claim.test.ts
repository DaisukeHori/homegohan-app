// @vitest-environment node
/**
 * POST /api/push-tokens/claim のテスト (#1599 / #1636)
 *
 * 共有の端末で、前の利用者のログアウトの削除 (user_push_tokens の本人の行) がオフラインなどで失敗すると、
 * 前の利用者の行が残り、次の利用者がログインしたあとも前の利用者宛ての通知がこの端末に届き得た。
 * いまはアプリが登録 (本人の行の upsert) の直後にこの API を呼び、同じトークンのほかの利用者の行をサーバーで外す。
 * #1636: 外すのは同じ端末の前の利用者の行 (端末の秘密の値のハッシュが同じ行) と、ハッシュの無い古い行だけ。
 * トークンの値を知っているだけの他人 (別の端末・別の秘密の値) は、持ち主の行を外せない。
 *
 * user_push_tokens を、RLS (本人の行だけ読める・書ける・消せる) と service_role (すべて) を真似た表で持ち、
 *   - 利用者 A が登録した同じトークンを、利用者 B が登録して claim すると、A には紐づかない (B の 1 行だけ)
 *   - A の別の端末のトークン・ほかのトークンの行は消さない
 *   - 他人の秘密の値 (別の端末) では、ハッシュのある持ち主の行を外せない。同じ端末の秘密の値なら外せる (#1636)
 *   - 秘密の値の発行 (issue_install_secret)・古い版のアプリ (秘密の値なし) の扱い (#1636)
 *   - 認証・本文の形・本人の登録の確認に落ちたら、何も消さない (service_role のクライアントも作らない)
 *   - 消すのに失敗したら、汎用の 500 (DB のエラー文を本文に出さない)
 * を確かめる。
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { INTERNAL_ERROR_CODE } from '@/lib/api/errors';
import { MAX_EXPO_PUSH_TOKEN_LENGTH, PUSH_TOKEN_CLAIM_ERROR_CODES } from '@/lib/push-tokens';
import { isPushInstallSecret } from '@homegohan/shared';

type Row = {
  id: string;
  user_id: string;
  expo_push_token: string;
  platform: string | null;
  install_secret_hash: string | null;
};
type Filter = (row: Row) => boolean;

const h = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    user_id: string;
    expo_push_token: string;
    platform: string | null;
    install_secret_hash: string | null;
  }>,
  /** いまの要求の認証済みの利用者 (null なら未ログイン) */
  currentUserId: null as string | null,
  /** 設定すると、service_role の delete がこのエラーを返す */
  adminDeleteError: null as { message: string; code: string } | null,
  /** 設定すると、service_role の update がこのエラーを返す */
  adminUpdateError: null as { message: string; code: string } | null,
  /** 設定すると、本人のクライアントの select がこのエラーを返す */
  ownSelectError: null as { message: string; code: string } | null,
  getSupabaseAdminCalls: 0,
  nextId: 0,
  logErrors: [] as unknown[],
}));

/** PostgREST の or の絞り込みの文字列 (`列.演算子.値` をカンマでつないだもの) のうち、このテストで使う is.null と eq だけを読む */
function orFilter(expression: string): Filter {
  const parts = expression.split(',').map((part) => {
    const [column, op, ...rest] = part.split('.');
    const value = rest.join('.');
    if (op === 'is' && value === 'null') return (row: Row) => row[column as keyof Row] === null;
    if (op === 'eq') return (row: Row) => row[column as keyof Row] === value;
    throw new Error(`この偽の表が読めない or の条件: ${part}`);
  });
  return (row) => parts.some((test) => test(row));
}

/**
 * user_push_tokens の 1 回の問い合わせ。visible は RLS で見える行 (本人のクライアントなら本人の行だけ)。
 * postgrest-js と同じく、絞り込みは自分自身を返し、await で結果になる。
 */
function tableQuery(visible: (row: Row) => boolean, errors: { select?: unknown; delete?: unknown; update?: unknown }) {
  const filters: Filter[] = [];
  let mode: 'select' | 'delete' | 'update' = 'select';
  let patch: Partial<Row> = {};
  const target = (row: Row) => visible(row) && filters.every((test) => test(row));
  const builder = {
    select: () => {
      mode = 'select';
      return builder;
    },
    delete: (_options?: { count?: string }) => {
      mode = 'delete';
      return builder;
    },
    update: (values: Partial<Row>) => {
      mode = 'update';
      patch = values;
      return builder;
    },
    eq: (column: keyof Row, value: string) => {
      filters.push((row) => row[column] === value);
      return builder;
    },
    neq: (column: keyof Row, value: string) => {
      filters.push((row) => row[column] !== value);
      return builder;
    },
    is: (column: keyof Row, value: null) => {
      filters.push((row) => row[column] === value);
      return builder;
    },
    or: (expression: string) => {
      filters.push(orFilter(expression));
      return builder;
    },
    maybeSingle: async () => {
      if (errors.select) return { data: null, error: errors.select };
      const found = h.rows.filter(target);
      return { data: found[0] ? { id: found[0].id } : null, error: null };
    },
    then: (resolve: (value: { error: unknown; count: number | null }) => void) => {
      if (mode === 'update') {
        if (errors.update) return resolve({ error: errors.update, count: null });
        h.rows = h.rows.map((row) => (target(row) ? { ...row, ...patch } : row));
        return resolve({ error: null, count: null });
      }
      if (mode !== 'delete') throw new Error('この偽の表は、await では delete と update だけを扱う');
      if (errors.delete) return resolve({ error: errors.delete, count: null });
      const before = h.rows.length;
      h.rows = h.rows.filter((row) => !target(row));
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
        return tableQuery(() => true, { delete: h.adminDeleteError, update: h.adminUpdateError });
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
const USER_C = '33333333-3333-4333-8333-333333333333';
const SHARED_DEVICE_TOKEN = 'ExponentPushToken[shared-device]';
const A_OTHER_DEVICE_TOKEN = 'ExponentPushToken[a-other-device]';
/** 共有の端末の秘密の値 (ダミー。43 文字の base64url) */
const SHARED_DEVICE_SECRET = 'shared-device-secret-aaaaaaaaaaaaaaaaaaaaaa'; // gitleaks:allow
/** 別の端末 (他人) の秘密の値 (ダミー) */
const OTHER_DEVICE_SECRET = 'other-device-secret-bbbbbbbbbbbbbbbbbbbbbbb'; // gitleaks:allow

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** アプリの登録 (本人のクライアントでの upsert。RLS で本人の行だけ。ハッシュの列は送らないので触れない) を真似る */
function registerAs(userId: string, token: string): void {
  if (h.rows.some((row) => row.user_id === userId && row.expo_push_token === token)) return;
  h.nextId += 1;
  h.rows.push({ id: `row-${h.nextId}`, user_id: userId, expo_push_token: token, platform: 'ios', install_secret_hash: null });
}

function hashOf(userId: string, token: string): string | null | undefined {
  return h.rows.find((row) => row.user_id === userId && row.expo_push_token === token)?.install_secret_hash;
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
  h.adminUpdateError = null;
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

describe('POST /api/push-tokens/claim — 端末の秘密の値による所有の証明 (#1636)', () => {
  it('テストの秘密の値は、取り決めの形 (32 バイトの base64url) をしている', () => {
    expect(isPushInstallSecret(SHARED_DEVICE_SECRET)).toBe(true);
    expect(isPushInstallSecret(OTHER_DEVICE_SECRET)).toBe(true);
  });

  it('他人の値で claim できない: トークンの値を知っているだけの他人 (別の端末の秘密の値) は、ハッシュのある持ち主の行を外せない', async () => {
    // 持ち主 A がこの端末で登録し、端末の秘密の値つきで claim した (A の行にハッシュが付く)
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    expect(await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: SHARED_DEVICE_SECRET })).toEqual({
      status: 200,
      json: { released: 0 },
    });
    expect(hashOf(USER_A, SHARED_DEVICE_TOKEN)).toBe(sha256(SHARED_DEVICE_SECRET));

    // 他人 C が A のトークンの値を知り、自分の行として登録して、自分の端末の秘密の値で claim する
    registerAs(USER_C, SHARED_DEVICE_TOKEN);
    expect(await claimAs(USER_C, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: OTHER_DEVICE_SECRET })).toEqual({
      status: 200,
      json: { released: 0 },
    });
    // 秘密の値を送らない (古い版のアプリと同じ形) でも外せない
    expect(await claimAs(USER_C, { expo_push_token: SHARED_DEVICE_TOKEN })).toEqual({ status: 200, json: { released: 0 } });
    // 秘密の値を作り直させても外せない
    const issued = await claimAs(USER_C, { expo_push_token: SHARED_DEVICE_TOKEN, issue_install_secret: true });
    expect(issued.status).toBe(200);
    expect(issued.json.released).toBe(0);

    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A, USER_C]);
    expect(hashOf(USER_A, SHARED_DEVICE_TOKEN)).toBe(sha256(SHARED_DEVICE_SECRET));
  });

  it('同じ端末の前の利用者の行は引き取れる: 同じ端末の秘密の値で claim すると、前の利用者の行 (同じハッシュ) が外れる', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: SHARED_DEVICE_SECRET });

    // A のログアウトの削除が失敗して行が残ったまま、同じ端末で B がログインして登録する
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    const res = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: SHARED_DEVICE_SECRET });

    expect(res).toEqual({ status: 200, json: { released: 1 } });
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_B]);
    expect(hashOf(USER_B, SHARED_DEVICE_TOKEN)).toBe(sha256(SHARED_DEVICE_SECRET));
  });

  it('同じ端末でも、他人の行 (別のハッシュ) は外さない。ハッシュの無い古い行は外す (移行のあいだ)', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN); // 古い版のアプリの行 (ハッシュなし)
    registerAs(USER_C, SHARED_DEVICE_TOKEN);
    await claimAs(USER_C, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: OTHER_DEVICE_SECRET });
    // C の claim は、ハッシュの無い A の行を外した (#1599 の動きのまま)
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_C]);

    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    const res = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: SHARED_DEVICE_SECRET });

    // ハッシュの無い A の行は外れ、別のハッシュの C の行は残る
    expect(res).toEqual({ status: 200, json: { released: 1 } });
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_B, USER_C]);
  });

  it('端末に秘密の値がまだ無い (issue_install_secret): サーバーが値を作って 1 度だけ返し、本人の行にはハッシュだけを書く', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN); // ハッシュの無い古い行

    const res = await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN, issue_install_secret: true });

    expect(res.status).toBe(200);
    expect(res.json.released).toBe(1);
    const secret = res.json.install_secret;
    expect(isPushInstallSecret(secret)).toBe(true);
    // DB には値そのものは無く、ハッシュだけ
    expect(hashOf(USER_A, SHARED_DEVICE_TOKEN)).toBe(sha256(secret as string));
    expect(JSON.stringify(h.rows)).not.toContain(secret as string);
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A]);

    // 返した値で、同じ端末の次の利用者が A の行を引き取れる
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    expect(await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: secret })).toEqual({
      status: 200,
      json: { released: 1 },
    });
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_B]);
  });

  it('発行のたびに違う値を作る (乱数)', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    const first = await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN, issue_install_secret: true });
    const second = await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN, issue_install_secret: true });
    expect(first.json.install_secret).not.toBe(second.json.install_secret);
    // やり直しは本人の行のハッシュを書き換える (最後に返した値が使える)
    expect(hashOf(USER_A, SHARED_DEVICE_TOKEN)).toBe(sha256(second.json.install_secret as string));
  });

  it('古い版のアプリ (秘密の値なし) の claim は壊れない: 200 { released } で、本人の行のハッシュには触れない', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: SHARED_DEVICE_SECRET });

    const res = await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN });

    expect(res).toEqual({ status: 200, json: { released: 0 } });
    expect(Object.keys(res.json)).toEqual(['released']);
    expect(hashOf(USER_A, SHARED_DEVICE_TOKEN)).toBe(sha256(SHARED_DEVICE_SECRET));
  });

  it('応答は途中の置き場に残させない (Cache-Control: no-store。発行した値を含むことがある)', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    h.currentUserId = USER_A;
    const res = await POST(claimRequest({ expo_push_token: SHARED_DEVICE_TOKEN, issue_install_secret: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it.each([
    ['install_secret が短い', { install_secret: 'short' }],
    ['install_secret が長い', { install_secret: `${SHARED_DEVICE_SECRET}x` }],
    ['install_secret に使えない文字', { install_secret: `${SHARED_DEVICE_SECRET.slice(0, 42)}=` }],
    ['install_secret が文字列でない', { install_secret: 123 }],
    ['install_secret が null', { install_secret: null }],
    ['issue_install_secret が true 以外', { issue_install_secret: 'true' }],
    ['issue_install_secret が false', { issue_install_secret: false }],
    ['install_secret と issue_install_secret を同時に送った', { install_secret: SHARED_DEVICE_SECRET, issue_install_secret: true }],
  ])('%s: 400 (service_role のクライアントを作らない・何も書かない)', async (_label, extra) => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN);

    const res = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN, ...extra });

    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe(PUSH_TOKEN_CLAIM_ERROR_CODES.INVALID_REQUEST);
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A, USER_B]);
    expect(hashOf(USER_B, SHARED_DEVICE_TOKEN)).toBeNull();
    expect(h.getSupabaseAdminCalls).toBe(0);
  });

  it('呼び出した利用者の行にそのトークンが無ければ、秘密の値を送っても 404 で、何も書かない・発行しない', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    await claimAs(USER_A, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: SHARED_DEVICE_SECRET });
    h.getSupabaseAdminCalls = 0;

    const withSecret = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: SHARED_DEVICE_SECRET });
    const issue = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN, issue_install_secret: true });

    expect(withSecret.status).toBe(404);
    expect(issue.status).toBe(404);
    expect(issue.json.install_secret).toBeUndefined();
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A]);
    expect(h.getSupabaseAdminCalls).toBe(0);
  });

  it('本人の行にハッシュを書くのに失敗したら、汎用の 500 で、ほかの行は消さない・値を返さない', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    h.adminUpdateError = { message: 'update failed secret detail', code: '42501' };

    const res = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN, issue_install_secret: true });

    expect(res.status).toBe(500);
    expect(res.json.code).toBe(INTERNAL_ERROR_CODE);
    expect(res.json.install_secret).toBeUndefined();
    expect(JSON.stringify(res.json)).not.toContain('secret detail');
    expect(ownersOf(SHARED_DEVICE_TOKEN)).toEqual([USER_A, USER_B]);
    expect(h.logErrors).toHaveLength(1);
  });

  it('秘密の値はログにも本文にも出さない (500 のとき)', async () => {
    registerAs(USER_A, SHARED_DEVICE_TOKEN);
    registerAs(USER_B, SHARED_DEVICE_TOKEN);
    h.adminDeleteError = { message: 'delete failed', code: '42501' };

    const res = await claimAs(USER_B, { expo_push_token: SHARED_DEVICE_TOKEN, install_secret: SHARED_DEVICE_SECRET });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toContain(SHARED_DEVICE_SECRET);
    expect(JSON.stringify(h.logErrors)).not.toContain(SHARED_DEVICE_SECRET);
  });
});
