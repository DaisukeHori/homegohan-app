import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #1164 画像・PDF のアップロード API (POST /api/upload) のレート制限。
// 以前は回数の制限が無く、ログインしたユーザー 1 人が 10MB のファイルを毎秒何度でも Storage (fridge-images) へ送れた。
// 今は共通ヘルパー (src/lib/rate-limit.ts) の upload カテゴリ (ユーザー単位で 10 回/分 + 直近 24 時間で 100 回) を使う。
// ここでは route が「何を key に、どのカテゴリで、いつ (本文を読む前に)」判定するか、
// 超過したとき・判定できないときに何を返すかを確かめる。
// 共通ヘルパーの限度値そのものは src/__tests__/lib/rate-limit.test.ts、
// MIME / サイズ / magic bytes の検証は tests/api-security-cluster.test.ts で確かめる。

const mocks = vi.hoisted(() => {
  // 共通レートリミッタが Upstash を見に行かず、in-memory フォールバックで数えるようにする (import より前に実行される)
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  return {
    getUser: vi.fn(),
    storageFrom: vi.fn(),
    upload: vi.fn(),
    getPublicUrl: vi.fn(),
    checkRateLimit: vi.fn(),
    // 構造化ログ。認証前 (logger) と認証後 (withUser の戻り値) の error を分けて見る
    logError: vi.fn(),
    userLogError: vi.fn(),
    withUser: vi.fn(),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    storage: { from: mocks.storageFrom },
  }),
}));

vi.mock('@/lib/db-logger', () => {
  const userLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mocks.userLogError };
  return {
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: mocks.logError,
      withUser: (userId: string) => {
        mocks.withUser(userId);
        return userLogger;
      },
    }),
    generateRequestId: () => 'req_test',
  };
});

// 共通レートリミッタは本物 (in-memory フォールバック) を通しつつ、呼び出しの記録と差し替えができるようにする
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  mocks.checkRateLimit.mockImplementation(actual.checkRateLimit);
  return {
    ...actual,
    checkRateLimit: (...args: unknown[]) => mocks.checkRateLimit(...args),
  };
});

import { POST } from '@/app/api/upload/route';

const TOO_MANY_REQUESTS_MESSAGE = 'リクエストが多すぎます。しばらく時間をおいてからお試しください。';
const MINUTE_MS = 60_000;
const DAY_SEC = 24 * 60 * 60;

// ユーザー ID はテストごとに別の値にする (共通レートリミッタの in-memory の数え方はファイル内で共有されるため)
let userCounter = 0;
const newUserId = () => `00000000-0000-4000-8000-${String(++userCounter).padStart(12, '0')}`;
const OTHER_USER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** route が読む size / type / arrayBuffer() だけを持つファイル */
function fakeFile({ type = 'image/jpeg', bytes = JPEG_BYTES }: { type?: string; bytes?: Uint8Array } = {}) {
  return {
    size: bytes.length,
    type,
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as File;
}

/**
 * リクエスト。本文を読む手段は formData() だけにして、読まれたかどうかを formData のモックで確かめる
 * (route が json() や body など別の手段で読もうとすると TypeError になり、500 でテストが落ちる)。
 */
function makeRequest(fields: Record<string, unknown> = { file: fakeFile(), folder: 'meals' }) {
  const form = { get: (name: string) => fields[name] ?? null } as unknown as FormData;
  const formData = vi.fn(async () => form);
  return { request: { formData } as unknown as Request, formData };
}

function loginAs(userId: string | null) {
  mocks.getUser.mockResolvedValue(
    userId
      ? { data: { user: { id: userId } }, error: null }
      : { data: { user: null }, error: { message: 'Auth session missing' } },
  );
}

const invocationOrder = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // 時刻だけ固定する (タイマーは本物のまま)。Retry-After の秒数を決まった値で確かめるため
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  mocks.upload.mockResolvedValue({ error: null });
  mocks.getPublicUrl.mockReturnValue({ data: { publicUrl: 'https://storage.example/fridge-images/file.jpg' } });
  mocks.storageFrom.mockReturnValue({ upload: mocks.upload, getPublicUrl: mocks.getPublicUrl });
});

afterEach(() => {
  consoleError.mockRestore();
  vi.useRealTimers();
});

describe('POST /api/upload: 判定の key・カテゴリ・タイミング', () => {
  it('認証したユーザーの ID を key に、upload カテゴリで 1 回だけ判定する', async () => {
    const userId = newUserId();
    loginAs(userId);

    const { request } = makeRequest();
    const res = await POST(request);

    expect(res.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(userId, 'upload');
  });

  it('判定は、認証のあとで、本文 (formData) を読む前に行う', async () => {
    loginAs(newUserId());

    const { request, formData } = makeRequest();
    await POST(request);

    expect(invocationOrder(mocks.getUser)).toBeLessThan(invocationOrder(mocks.checkRateLimit));
    expect(invocationOrder(mocks.checkRateLimit)).toBeLessThan(invocationOrder(formData));
  });

  it('フォームに別のユーザーの ID (folder など) があっても、key は認証した本人の ID だけ', async () => {
    const userId = newUserId();
    loginAs(userId);

    const { request } = makeRequest({ file: fakeFile(), folder: OTHER_USER, user_id: OTHER_USER });
    await POST(request);

    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(userId, 'upload');
    expect(mocks.checkRateLimit).not.toHaveBeenCalledWith(OTHER_USER, expect.anything());
  });

  it('検証で 400 になるリクエストも枠を使う (大きな無効ファイルの連打も止める)', async () => {
    loginAs(newUserId());
    const invalid = () => makeRequest({ file: fakeFile({ type: 'application/x-msdownload' }), folder: 'meals' });

    for (let i = 0; i < 10; i++) {
      expect((await POST(invalid().request)).status).toBe(400);
    }
    const res = await POST(invalid().request);

    expect(res.status).toBe(429);
  });
});

describe('POST /api/upload: 未ログイン (401)', () => {
  it('401 を返す。回数制限の枠は使わず、本文も Storage も触らない', async () => {
    loginAs(null);

    const { request, formData } = makeRequest();
    const res = await POST(request);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });

  it('未ログインで何度送っても枠は数えない (何回でも 401 のまま)', async () => {
    loginAs(null);

    for (let i = 0; i < 15; i++) {
      expect((await POST(makeRequest().request)).status).toBe(401);
    }

    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('POST /api/upload: 上限を超えたとき (429)', () => {
  it('判定が失敗したら 429。共通形式の本文と Retry-After を返し、本文の読み込みも保存もしない', async () => {
    loginAs(newUserId());
    mocks.checkRateLimit.mockResolvedValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 30_000,
      windowSec: 60,
    });

    const { request, formData } = makeRequest();
    const res = await POST(request);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ error: TOO_MANY_REQUESTS_MESSAGE, code: 'RATE_LIMITED', retryAfter: 30 });
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.storageFrom).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('同じユーザーの 11 回目は 429 (10 回/分)。10 回目までは保存し、429 のリクエストは保存しない', async () => {
    loginAs(newUserId());

    for (let i = 0; i < 10; i++) {
      expect((await POST(makeRequest().request)).status).toBe(200);
    }
    expect(mocks.upload).toHaveBeenCalledTimes(10);

    const { request, formData } = makeRequest();
    const res = await POST(request);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.upload).toHaveBeenCalledTimes(10);
  });

  it('別のユーザーの枠は影響を受けない', async () => {
    const exhausted = newUserId();
    loginAs(exhausted);
    for (let i = 0; i < 10; i++) {
      await POST(makeRequest().request);
    }
    expect((await POST(makeRequest().request)).status).toBe(429);

    loginAs(newUserId());
    expect((await POST(makeRequest().request)).status).toBe(200);
  });

  it('60 秒たつと分あたりの枠が戻り、また保存できる', async () => {
    loginAs(newUserId());
    for (let i = 0; i < 10; i++) {
      await POST(makeRequest().request);
    }
    expect((await POST(makeRequest().request)).status).toBe(429);

    vi.setSystemTime(Date.now() + MINUTE_MS + 1_000);

    expect((await POST(makeRequest().request)).status).toBe(200);
  });

  it('直近 24 時間で 100 回を超えると、分あたりの枠が戻っていても 429。Retry-After は日次のウィンドウに合わせる', async () => {
    loginAs(newUserId());
    const startedAt = Date.now();

    for (let i = 0; i < 100; i++) {
      expect((await POST(makeRequest().request)).status).toBe(200);
      // 分あたりの枠だけを戻して、日次の判定を分離して確かめる
      vi.setSystemTime(Date.now() + MINUTE_MS + 1_000);
    }
    expect(mocks.upload).toHaveBeenCalledTimes(100);

    const { request, formData } = makeRequest();
    const res = await POST(request);

    expect(res.status).toBe(429);
    // 最初のリクエストの 24 時間後まで。分あたりで止まったのなら最大でも 60 秒になる
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    expect(res.headers.get('Retry-After')).toBe(String(DAY_SEC - elapsedSec));
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(3600);
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.upload).toHaveBeenCalledTimes(100);
  });
});

describe('POST /api/upload: 判定できないとき (fail-closed)', () => {
  it('判定が例外を投げたら 500。保存せず、内部のエラー文は返さず、構造化ログに error を残す', async () => {
    const userId = newUserId();
    loginAs(userId);
    const failure = new Error('ECONNREFUSED: upstash unreachable (internal-host.upstash.io)');
    mocks.checkRateLimit.mockRejectedValueOnce(failure);

    const { request, formData } = makeRequest();
    const res = await POST(request);
    const text = await res.text();

    // fail-open (通してしまう) にはしない。レスポンスは汎用メッセージだけ (#1172)
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Upload failed' });
    expect(text).not.toContain('upstash');
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.withUser).toHaveBeenCalledWith(userId);
    expect(mocks.userLogError).toHaveBeenCalledTimes(1);
    expect(mocks.userLogError).toHaveBeenCalledWith('Upload API error', failure);
  });

  it('次のリクエストは、判定が戻れば通常どおり受け付ける', async () => {
    loginAs(newUserId());
    mocks.checkRateLimit.mockRejectedValueOnce(new Error('transient'));
    expect((await POST(makeRequest().request)).status).toBe(500);

    expect((await POST(makeRequest().request)).status).toBe(200);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('認証の途中で例外になったときは、ユーザーなしのログに残し、枠も使わない', async () => {
    const failure = new Error('auth backend down');
    mocks.getUser.mockRejectedValue(failure);

    const res = await POST(makeRequest().request);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Upload failed' });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.withUser).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith('Upload API error', failure);
  });
});

describe('POST /api/upload: レスポンスとログ (回帰)', () => {
  it('成功時の本文は { url } だけ', async () => {
    const userId = newUserId();
    loginAs(userId);

    const res = await POST(makeRequest().request);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://storage.example/fridge-images/file.jpg' });
    expect(mocks.storageFrom).toHaveBeenCalledWith('fridge-images');
    const [path] = mocks.upload.mock.calls[0];
    expect(path).toMatch(new RegExp(`^${userId}/meals/.+\\.jpg$`));
  });

  it('Storage への保存に失敗したら 500 の汎用メッセージ。詳細は構造化ログだけに残す (console.error は使わない)', async () => {
    const userId = newUserId();
    loginAs(userId);
    const storageError = new Error('new row violates row-level security policy for table "objects"');
    mocks.upload.mockResolvedValue({ error: storageError });

    const res = await POST(makeRequest().request);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Upload failed' });
    expect(text).not.toContain('row-level security');
    expect(mocks.userLogError).toHaveBeenCalledTimes(1);
    expect(mocks.userLogError).toHaveBeenCalledWith(
      'Upload to storage failed',
      storageError,
      expect.objectContaining({
        path: expect.stringMatching(new RegExp(`^${userId}/meals/.+\\.jpg$`)),
        content_type: 'image/jpeg',
        size: JPEG_BYTES.length,
      }),
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('想定外の例外 (本文の解析失敗など) も 500 の汎用メッセージ。例外の文言は返さず、構造化ログに残す', async () => {
    loginAs(newUserId());
    const failure = new TypeError('Content-Type was not one of "multipart/form-data" or "application/x-www-form-urlencoded".');
    const request = { formData: vi.fn().mockRejectedValue(failure) } as unknown as Request;

    const res = await POST(request);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Upload failed' });
    expect(text).not.toContain('Content-Type');
    expect(mocks.userLogError).toHaveBeenCalledWith('Upload API error', failure);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
