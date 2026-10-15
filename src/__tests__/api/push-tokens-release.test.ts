// @vitest-environment node
/**
 * POST /api/push-tokens/release のテスト (#1636)
 *
 * ログアウト (アプリの signOut.ts) を通らずにセッションが終わったとき (自動更新の失効の SIGNED_OUT など) は、
 * セッションが無いので RLS では user_push_tokens の行を消せない。アプリは端末の秘密の値でこの API を呼ぶ。
 * サーバーは、利用者 ID・トークン・秘密の値のハッシュの 3 つが合う行だけを消す。
 *
 * service_role の表を真似た偽の表で、
 *   - 3 つが合う行だけを消す (同じ端末のほかの利用者の行・別の端末の行・ハッシュの無い古い行は消さない)
 *   - 秘密の値を知らない他人は消せない (別の秘密の値・ハッシュそのものを送っても 0 件)
 *   - 本文の形が違えば 400 で、service_role のクライアントを作らない
 *   - 消すのに失敗したら汎用の 500 (DB のエラー文・秘密の値を本文に出さない)
 * を確かめる。
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { INTERNAL_ERROR_CODE } from '@/lib/api/errors';
import { PUSH_TOKEN_CLAIM_ERROR_CODES } from '@/lib/push-tokens';

type Row = { id: string; user_id: string; expo_push_token: string; install_secret_hash: string | null };

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; user_id: string; expo_push_token: string; install_secret_hash: string | null }>,
  /** 設定すると、service_role の delete がこのエラーを返す */
  adminDeleteError: null as { message: string; code: string } | null,
  getSupabaseAdminCalls: 0,
  logErrors: [] as unknown[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('release は本人のクライアント (セッション) を使わない');
  }),
  getSupabaseAdmin: vi.fn(() => {
    h.getSupabaseAdminCalls += 1;
    return {
      from: (table: string) => {
        if (table !== 'user_push_tokens') throw new Error(`想定外の表: ${table}`);
        const filters: Array<(row: Row) => boolean> = [];
        const builder = {
          delete: (_options?: { count?: string }) => builder,
          eq: (column: keyof Row, value: string) => {
            filters.push((row) => row[column] === value);
            return builder;
          },
          then: (resolve: (value: { error: unknown; count: number | null }) => void) => {
            if (h.adminDeleteError) return resolve({ error: h.adminDeleteError, count: null });
            const before = h.rows.length;
            h.rows = h.rows.filter((row) => !filters.every((test) => test(row)));
            return resolve({ error: null, count: before - h.rows.length });
          },
        };
        return builder;
      },
    };
  }),
}));

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

const { POST } = await import('@/app/api/push-tokens/release/route');

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const DEVICE_TOKEN = 'ExponentPushToken[shared-device]';
const OTHER_TOKEN = 'ExponentPushToken[other-device]';
/** この端末の秘密の値 (ダミー。43 文字の base64url) */
const DEVICE_SECRET = 'shared-device-secret-aaaaaaaaaaaaaaaaaaaaaa'; // gitleaks:allow
/** 他人の端末の秘密の値 (ダミー) */
const OTHER_SECRET = 'other-device-secret-bbbbbbbbbbbbbbbbbbbbbbb'; // gitleaks:allow

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function addRow(userId: string, token: string, hash: string | null): void {
  h.rows.push({ id: `row-${h.rows.length + 1}`, user_id: userId, expo_push_token: token, install_secret_hash: hash });
}

async function release(body: unknown, headers: Record<string, string> = {}) {
  const res = await POST(
    new NextRequest('http://localhost/api/push-tokens/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

function remaining(): Array<[string, string]> {
  return h.rows.map((row) => [row.user_id, row.expo_push_token] as [string, string]).sort();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
  h.adminDeleteError = null;
  h.getSupabaseAdminCalls = 0;
  h.logErrors = [];
});

describe('POST /api/push-tokens/release — セッション無しで、サインアウトした利用者の、この端末の行を消す (#1636)', () => {
  it('利用者 ID・トークン・秘密の値のハッシュが合う行だけを消す (セッションは要らない)', async () => {
    addRow(USER_A, DEVICE_TOKEN, sha256(DEVICE_SECRET));
    addRow(USER_A, OTHER_TOKEN, sha256(OTHER_SECRET)); // A の別の端末
    addRow(USER_B, DEVICE_TOKEN, sha256(DEVICE_SECRET)); // 同じ端末で、あとからログインした B

    const res = await release({ expo_push_token: DEVICE_TOKEN, install_secret: DEVICE_SECRET, user_id: USER_A });

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ released: 1 });
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(remaining()).toEqual([
      [USER_A, OTHER_TOKEN],
      [USER_B, DEVICE_TOKEN],
    ]);
  });

  it('何度呼んでも同じ結果 (消す行が無ければ 0 件で 200)', async () => {
    addRow(USER_A, DEVICE_TOKEN, sha256(DEVICE_SECRET));
    const body = { expo_push_token: DEVICE_TOKEN, install_secret: DEVICE_SECRET, user_id: USER_A };

    expect((await release(body)).json).toEqual({ released: 1 });
    expect((await release(body)).json).toEqual({ released: 0 });
    expect(remaining()).toEqual([]);
  });

  it('秘密の値を知らない他人は消せない: 別の秘密の値・ハッシュの無い行・ハッシュそのものを送っても 0 件', async () => {
    addRow(USER_A, DEVICE_TOKEN, sha256(DEVICE_SECRET));
    addRow(USER_B, DEVICE_TOKEN, null); // 古い版のアプリの行 (所有を確かめられないので、release では消さない)

    expect((await release({ expo_push_token: DEVICE_TOKEN, install_secret: OTHER_SECRET, user_id: USER_A })).json).toEqual({
      released: 0,
    });
    expect((await release({ expo_push_token: DEVICE_TOKEN, install_secret: OTHER_SECRET, user_id: USER_B })).json).toEqual({
      released: 0,
    });
    expect((await release({ expo_push_token: DEVICE_TOKEN, install_secret: DEVICE_SECRET, user_id: USER_B })).json).toEqual({
      released: 0,
    });
    // ハッシュ (64 文字の 16 進) は秘密の値の形ではないので 400
    expect((await release({ expo_push_token: DEVICE_TOKEN, install_secret: sha256(DEVICE_SECRET), user_id: USER_A })).status).toBe(400);

    expect(remaining()).toEqual([
      [USER_A, DEVICE_TOKEN],
      [USER_B, DEVICE_TOKEN],
    ]);
  });

  it('Authorization が付いていても見ない (本文の利用者の行だけ。セッションのクライアントを作らない)', async () => {
    addRow(USER_A, DEVICE_TOKEN, sha256(DEVICE_SECRET));
    addRow(USER_B, DEVICE_TOKEN, sha256(DEVICE_SECRET));

    const res = await release(
      { expo_push_token: DEVICE_TOKEN, install_secret: DEVICE_SECRET, user_id: USER_A },
      { Authorization: 'Bearer header.payload.signature' },
    );

    expect(res.json).toEqual({ released: 1 });
    expect(remaining()).toEqual([[USER_B, DEVICE_TOKEN]]);
  });

  it.each([
    ['本文が JSON でない', 'not-json'],
    ['本文が null', null],
    ['expo_push_token が無い', { install_secret: DEVICE_SECRET, user_id: USER_A }],
    ['expo_push_token が Expo の形でない', { expo_push_token: 'x', install_secret: DEVICE_SECRET, user_id: USER_A }],
    ['install_secret が無い', { expo_push_token: DEVICE_TOKEN, user_id: USER_A }],
    ['install_secret が短い', { expo_push_token: DEVICE_TOKEN, install_secret: 'short', user_id: USER_A }],
    ['user_id が無い', { expo_push_token: DEVICE_TOKEN, install_secret: DEVICE_SECRET }],
    ['user_id が UUID でない', { expo_push_token: DEVICE_TOKEN, install_secret: DEVICE_SECRET, user_id: 'user-a' }],
    ['user_id が文字列でない', { expo_push_token: DEVICE_TOKEN, install_secret: DEVICE_SECRET, user_id: 1 }],
  ])('%s: 400 (service_role のクライアントを作らない)', async (_label, body) => {
    addRow(USER_A, DEVICE_TOKEN, sha256(DEVICE_SECRET));

    const res = await release(body);

    expect(res.status).toBe(400);
    expect((res.json.error as { code: string }).code).toBe(PUSH_TOKEN_CLAIM_ERROR_CODES.INVALID_REQUEST);
    expect(remaining()).toEqual([[USER_A, DEVICE_TOKEN]]);
    expect(h.getSupabaseAdminCalls).toBe(0);
  });

  it('消すのに失敗したら、汎用の 500 (DB のエラー文・秘密の値を本文とログに出さない)', async () => {
    addRow(USER_A, DEVICE_TOKEN, sha256(DEVICE_SECRET));
    h.adminDeleteError = { message: 'permission denied secret detail', code: '42501' };

    const res = await release({ expo_push_token: DEVICE_TOKEN, install_secret: DEVICE_SECRET, user_id: USER_A });

    expect(res.status).toBe(500);
    expect(res.json.code).toBe(INTERNAL_ERROR_CODE);
    const sent = JSON.stringify(res.json);
    expect(sent).not.toContain('secret detail');
    expect(sent).not.toContain(DEVICE_SECRET);
    expect(h.logErrors).toHaveLength(1);
    expect(JSON.stringify(h.logErrors)).not.toContain(DEVICE_SECRET);
    expect(remaining()).toEqual([[USER_A, DEVICE_TOKEN]]);
  });
});
