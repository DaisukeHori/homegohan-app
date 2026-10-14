/**
 * #1036 モバイル WebView 認証ブリッジのワンタイムコード (src/lib/auth/native-bridge-code.ts) の単体テスト
 *
 * カバレッジ:
 *   1. コードの生成 (43 文字の base64url・重複しない)・ハッシュ (sha256)・形式判定
 *   2. 発行: RPC にはコード本体ではなく sha256 を渡す / 失敗してもエラーにトークンを含めない
 *   3. 消費: 形式が不正なら RPC を呼ばない / 0 行は null / 行を camelCase に直す / 失敗は例外
 *   4. Bearer ヘッダの取り出し・JWT の exp の読み取り
 *   5. 旧方式の受け付け期限 (LEGACY_SUNSET_AT) と環境変数 NATIVE_BRIDGE_LEGACY_GET
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc }),
}));

import {
  LEGACY_SUNSET_AT,
  MIN_ACCESS_TOKEN_REMAINING_SECONDS,
  NATIVE_BRIDGE_CODE_TTL_SECONDS,
  NativeBridgeCodeError,
  consumeNativeBridgeCode,
  extractBearerToken,
  generateNativeBridgeCode,
  getJwtExpiresAt,
  hashNativeBridgeCode,
  isLegacyNativeBridgeAllowed,
  isWellFormedNativeBridgeCode,
  issueNativeBridgeCode,
} from '@/lib/auth/native-bridge-code';

const USER_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const ACCESS_TOKEN = 'access-token-value-that-must-not-leak';
const REFRESH_TOKEN = 'refresh-token-value-that-must-not-leak';

beforeEach(() => {
  mockRpc.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. 生成・ハッシュ・形式
// ─────────────────────────────────────────────────────────────────────────────
describe('generateNativeBridgeCode / hashNativeBridgeCode / isWellFormedNativeBridgeCode', () => {
  it('コードは 43 文字の base64url で、形式判定を通る', () => {
    const code = generateNativeBridgeCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedNativeBridgeCode(code)).toBe(true);
  });

  it('毎回違うコードになる (256 bit の乱数)', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateNativeBridgeCode()));
    expect(codes.size).toBe(200);
  });

  it('ハッシュは sha256 の小文字 16 進 64 文字で、コードそのものではない', () => {
    const code = generateNativeBridgeCode();
    const hash = hashNativeBridgeCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(code).digest('hex'));
    expect(hash).not.toContain(code);
    // 既知のテストベクタ (sha256("abc"))
    expect(hashNativeBridgeCode('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it.each([
    ['空文字', ''],
    ['42 文字', 'A'.repeat(42)],
    ['44 文字', 'A'.repeat(44)],
    ['base64 のパディング (=)', `${'A'.repeat(42)}=`],
    ['base64 の + と /', `${'A'.repeat(41)}+/`],
    ['空白を含む', `${'A'.repeat(42)} `],
    ['改行を含む', `${'A'.repeat(42)}\n`],
    ['日本語', 'あ'.repeat(43)],
  ])('形式が不正 (%s) は false', (_label, value) => {
    expect(isWellFormedNativeBridgeCode(value)).toBe(false);
  });

  it.each([[undefined], [null], [123], [{}], [['A'.repeat(43)]]])('文字列でない値 (%j) は false', (value) => {
    expect(isWellFormedNativeBridgeCode(value)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 発行
// ─────────────────────────────────────────────────────────────────────────────
describe('issueNativeBridgeCode', () => {
  it('RPC にはコード本体ではなく sha256 を渡し、呼び出し元にはコード本体を返す', async () => {
    mockRpc.mockResolvedValue({ data: '2026-10-07T00:01:00.000Z', error: null });

    const code = await issueNativeBridgeCode({
      userId: USER_ID,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    });

    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('issue_native_bridge_code');
    expect(args).toEqual({
      p_code_hash: hashNativeBridgeCode(code),
      p_user_id: USER_ID,
      p_access_token: ACCESS_TOKEN,
      p_refresh_token: REFRESH_TOKEN,
      p_ttl_seconds: NATIVE_BRIDGE_CODE_TTL_SECONDS,
    });
    // コード本体は RPC の引数のどこにも出ない
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain(code);
  });

  it('呼ぶたびに別のコードになる', async () => {
    mockRpc.mockResolvedValue({ data: '2026-10-07T00:01:00.000Z', error: null });
    const input = { userId: USER_ID, accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN };
    const a = await issueNativeBridgeCode(input);
    const b = await issueNativeBridgeCode(input);
    expect(a).not.toBe(b);
  });

  it('RPC が失敗したら NativeBridgeCodeError を投げる。SQLSTATE は持つが、トークンはメッセージに含めない', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '23503', message: `insert failed for ${ACCESS_TOKEN} / ${REFRESH_TOKEN}` },
    });

    const promise = issueNativeBridgeCode({ userId: USER_ID, accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });
    await expect(promise).rejects.toBeInstanceOf(NativeBridgeCodeError);

    const error = (await promise.catch((e) => e)) as NativeBridgeCodeError;
    expect(error.pgCode).toBe('23503');
    expect(error.message).not.toContain(ACCESS_TOKEN);
    expect(error.message).not.toContain(REFRESH_TOKEN);
    expect(error.stack ?? '').not.toContain(REFRESH_TOKEN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 消費
// ─────────────────────────────────────────────────────────────────────────────
describe('consumeNativeBridgeCode', () => {
  it('形式が不正なコードは DB に問い合わせず null を返す', async () => {
    for (const bad of ['', 'abc', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`]) {
      await expect(consumeNativeBridgeCode(bad)).resolves.toBeNull();
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('RPC にはコードの sha256 を渡し、返った行を camelCase にして返す', async () => {
    const code = generateNativeBridgeCode();
    mockRpc.mockResolvedValue({
      data: [{ user_id: USER_ID, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }],
      error: null,
    });

    const result = await consumeNativeBridgeCode(code);

    expect(result).toEqual({ userId: USER_ID, accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN });
    expect(mockRpc).toHaveBeenCalledWith('consume_native_bridge_code', { p_code_hash: hashNativeBridgeCode(code) });
    expect(JSON.stringify(mockRpc.mock.calls)).not.toContain(code);
  });

  it('PostgREST が単一オブジェクトで返した場合も受け付ける', async () => {
    mockRpc.mockResolvedValue({
      data: { user_id: USER_ID, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN },
      error: null,
    });
    await expect(consumeNativeBridgeCode(generateNativeBridgeCode())).resolves.toEqual({
      userId: USER_ID,
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    });
  });

  it.each([
    ['0 行 (無効・期限切れ・使用済み)', []],
    ['null', null],
  ])('行が無い (%s) は null', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null });
    await expect(consumeNativeBridgeCode(generateNativeBridgeCode())).resolves.toBeNull();
  });

  it('RPC が失敗したら NativeBridgeCodeError を投げる (null にしない: 呼び出し側が障害を区別できるように)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement' } });
    const promise = consumeNativeBridgeCode(generateNativeBridgeCode());
    await expect(promise).rejects.toBeInstanceOf(NativeBridgeCodeError);
    await expect(promise).rejects.toMatchObject({ pgCode: '57014' });
  });

  it('想定外の行 (列が欠ける・型が違う) は例外にする。トークンは例外に含めない', async () => {
    mockRpc.mockResolvedValue({
      data: [{ user_id: USER_ID, access_token: ACCESS_TOKEN, refresh_token: 12345 }],
      error: null,
    });
    const promise = consumeNativeBridgeCode(generateNativeBridgeCode());
    await expect(promise).rejects.toBeInstanceOf(NativeBridgeCodeError);
    const error = (await promise.catch((e) => e)) as NativeBridgeCodeError;
    expect(error.message).not.toContain(ACCESS_TOKEN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Bearer / JWT
// ─────────────────────────────────────────────────────────────────────────────
describe('extractBearerToken', () => {
  it('Bearer トークンを取り出す (スキームの大文字小文字は問わない)', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('BEARER   abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  it.each([
    ['ヘッダなし', null],
    ['undefined', undefined],
    ['空文字', ''],
    ['スキームのみ', 'Bearer'],
    ['スキームと空白のみ', 'Bearer   '],
    ['Basic 認証', 'Basic dXNlcjpwYXNz'],
    ['トークンに空白を含む', 'Bearer abc def'],
    ['スキームなし', 'abc.def.ghi'],
    ['長すぎる', `Bearer ${'a'.repeat(4097)}`],
  ])('取り出せない形式 (%s) は null', (_label, header) => {
    expect(extractBearerToken(header)).toBeNull();
  });
});

describe('getJwtExpiresAt', () => {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwtWith = (payload: unknown) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.signature`;

  it('payload の exp (UNIX 秒) を返す', () => {
    expect(getJwtExpiresAt(jwtWith({ sub: USER_ID, exp: 1_900_000_000 }))).toBe(1_900_000_000);
  });

  it.each([
    ['exp が無い', jwtWith({ sub: USER_ID })],
    ['exp が文字列', jwtWith({ exp: '1900000000' })],
    ['payload が JSON でない', `a.${Buffer.from('not json').toString('base64url')}.c`],
    ['セグメント数が違う (2)', 'a.b'],
    ['セグメント数が違う (4)', 'a.b.c.d'],
    ['空文字', ''],
  ])('読み取れない (%s) は null', (_label, jwt) => {
    expect(getJwtExpiresAt(jwt)).toBeNull();
  });
});

describe('定数', () => {
  it('コードの有効期間は 60 秒で、アクセストークンに要求する残り時間は「有効期間 + auth-js の余裕 90 秒」', () => {
    expect(NATIVE_BRIDGE_CODE_TTL_SECONDS).toBe(60);
    // auth-js は有効期限まで 90 秒未満でトークンを更新する (EXPIRY_MARGIN_MS)。コードを使う時点でもそれ以上残す
    expect(MIN_ACCESS_TOKEN_REMAINING_SECONDS).toBe(NATIVE_BRIDGE_CODE_TTL_SECONDS + 90);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 旧方式の受け付け期限
// ─────────────────────────────────────────────────────────────────────────────
describe('isLegacyNativeBridgeAllowed', () => {
  const sunsetMs = Date.parse(LEGACY_SUNSET_AT);

  it('期限は解釈できる日時で、2026-12-31 (JST) の 0 時である (仮置き。オーナー確認待ち)', () => {
    expect(Number.isNaN(sunsetMs)).toBe(false);
    expect(LEGACY_SUNSET_AT).toBe('2026-12-31T00:00:00+09:00');
    expect(new Date(sunsetMs).toISOString()).toBe('2026-12-30T15:00:00.000Z');
  });

  it('環境変数が未設定なら、期限前は受け付ける', () => {
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', '');
    expect(isLegacyNativeBridgeAllowed(sunsetMs - 1)).toBe(true);
    expect(isLegacyNativeBridgeAllowed(Date.parse('2026-10-07T00:00:00+09:00'))).toBe(true);
  });

  it('期限ちょうど・期限後は受け付けない (境界は含まない)', () => {
    expect(isLegacyNativeBridgeAllowed(sunsetMs)).toBe(false);
    expect(isLegacyNativeBridgeAllowed(sunsetMs + 1)).toBe(false);
    expect(isLegacyNativeBridgeAllowed(Date.parse('2027-06-01T00:00:00+09:00'))).toBe(false);
  });

  it.each(['off', 'OFF', 'Off', ' off ', 'off\n'])('環境変数が %j なら、期限前でも受け付けない', (value) => {
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', value);
    expect(isLegacyNativeBridgeAllowed(sunsetMs - 1)).toBe(false);
  });

  it.each(['on', 'true', '1', 'offline', ''])('環境変数が %j なら、期限前は受け付ける (off 以外では閉じない)', (value) => {
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', value);
    expect(isLegacyNativeBridgeAllowed(sunsetMs - 1)).toBe(true);
  });

  it('環境変数が on でも、期限後は受け付けない (環境変数で期限を延ばせない)', () => {
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', 'on');
    expect(isLegacyNativeBridgeAllowed(sunsetMs + 1)).toBe(false);
  });

  it('引数を省略すると現在時刻 (Date.now) で判定する', () => {
    vi.useFakeTimers();
    vi.stubEnv('NATIVE_BRIDGE_LEGACY_GET', '');
    vi.setSystemTime(sunsetMs - 1000);
    expect(isLegacyNativeBridgeAllowed()).toBe(true);
    vi.setSystemTime(sunsetMs + 1000);
    expect(isLegacyNativeBridgeAllowed()).toBe(false);
  });
});
