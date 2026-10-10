import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE } from '@/lib/api/errors';

const mockRpc = vi.fn();
const mockFetch = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();

// 同意の判定 (T15 / #1154) は「同意済み」に差し替える。同意が無いときに AI へ送らないことは tests/ai-consent-enforcement-routes.test.ts が実際の route を呼んで確かめる
vi.mock('@/lib/ai/consent-guard', () => import('../../../../tests/helpers/ai-consent-guard-allowed'));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: mockRpc,
    from: () => ({
      update: () => ({ eq: () => ({ eq: () => ({ in: vi.fn() }) }) }),
    }),
  })),
}));

// 構造化ログ (app_logs への保存) はここでは確かめない。取り直しのときに警告を出すことだけ見る
vi.mock('@/lib/db-logger', () => ({
  createLogger: () => ({
    withUser: () => ({ info: vi.fn(), warn: mockLogWarn, error: mockLogError }),
    info: vi.fn(),
    warn: mockLogWarn,
    error: mockLogError,
  }),
  // internalError() が使う (#1182)
  generateRequestId: () => 'req-test',
}));

const { GET } = await import('@/app/api/cron/process-menu-queue/route');

function makeRequest(authorization?: string) {
  return new Request('http://localhost/api/cron/process-menu-queue', {
    headers: authorization ? { authorization } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CRON_SECRET', 'my-cron-secret-value');
  // #1196: 入れ替え中だけ設定する旧い値。開発者の環境に残っていても結果が変わらないよう未設定にそろえる
  vi.stubEnv('CRON_SECRET_PREVIOUS', undefined);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
  mockRpc.mockResolvedValue({ data: null, error: null }); // idle
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/cron/process-menu-queue (#1044 cron timing-safe suggestion)', () => {
  it('CRON_SECRET 未設定時は 503 を返す', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');
    const res = await GET(makeRequest('Bearer anything'));
    expect(res.status).toBe(503);
  });

  it('Authorization ヘッダなしは 401 を返す', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('誤った secret (同じ長さ) は 401 を返す', async () => {
    const res = await GET(makeRequest('Bearer my-cron-secret-XXXXX'));
    expect(res.status).toBe(401);
  });

  it('誤った secret (異なる長さ) は 401 を返す', async () => {
    const res = await GET(makeRequest('Bearer short'));
    expect(res.status).toBe(401);
  });

  it('正しい secret は認可され idle を返す', async () => {
    const res = await GET(makeRequest('Bearer my-cron-secret-value'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.idle).toBe(true);
  });
});

// ---------------------------------------------------------------
// #1202: 取り直した行 (前のワーカーが止まった行) は、保存済みの current_step から続きから再開する
//   _continue を付けないと Edge Function (generate-menu-v5) は Step1 から始め直し、
//   進んだ工程を巻き戻して二重に処理する。
// ---------------------------------------------------------------
describe('GET /api/cron/process-menu-queue: 取り直した行は続きから再開する (#1202)', () => {
  const V5_URL = 'https://example.supabase.co/functions/v1/generate-menu-v5';
  const GENERATED_DATA = {
    userId: 'user-1',
    requestId: 'req-1',
    targetSlots: [{ date: '2026-10-05', mealType: 'dinner' }],
    ultimateMode: true,
    step3: { cursor: 5 },
  };

  function claimedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'req-1',
      user_id: 'user-1',
      status: 'processing',
      attempt_count: 1,
      current_step: 1,
      generated_data: GENERATED_DATA,
      ...overrides,
    };
  }

  async function dispatch(claimed: Record<string, unknown>) {
    mockRpc.mockResolvedValue({ data: claimed, error: null });
    const res = await GET(makeRequest('Bearer my-cron-secret-value'));
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    return { res, url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    // 呼び出しごとに新しい Response を返す (body は 1 回しか読めないため)
    mockFetch.mockImplementation(
      async () => new Response(JSON.stringify({ status: 'processing', request_id: 'req-1', step: 1 }), { status: 202 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('C-1: 初回のクレーム (attempt_count=1, current_step=1) は、従来どおり generated_data を渡し、_continue は付けない', async () => {
    const { res, url, init, body } = await dispatch(claimedRow());

    expect(res.status).toBe(200);
    expect(url).toBe(V5_URL);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer service-role-key');
    expect(body._continue).toBeUndefined();
    expect(body.requestId).toBe('req-1');
    expect(body.userId).toBe('user-1');
    expect(body.targetSlots).toEqual(GENERATED_DATA.targetSlots);
    expect(body.ultimateMode).toBe(true);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('C-2: 取り直した行 (attempt_count>1) は _continue と userId を付け、generated_data は渡さない', async () => {
    const { res, body } = await dispatch(claimedRow({ attempt_count: 2, current_step: 4 }));

    expect(res.status).toBe(200);
    // Edge 側は current_step を DB から読んで、その工程から再開する。巨大な generated_data をもう一度送る必要は無い
    expect(body).toEqual({ requestId: 'req-1', userId: 'user-1', _continue: true });
  });

  it('C-3: attempt_count が 1 でも、すでに工程が進んでいる行 (current_step>1) は続きから再開する', async () => {
    const { body } = await dispatch(claimedRow({ attempt_count: 1, current_step: 3 }));

    expect(body).toEqual({ requestId: 'req-1', userId: 'user-1', _continue: true });
  });

  it('C-4: Step1 の途中で止まった行 (attempt_count>1, current_step=1) も _continue で渡す', async () => {
    const { body } = await dispatch(claimedRow({ attempt_count: 3, current_step: 1 }));

    expect(body).toEqual({ requestId: 'req-1', userId: 'user-1', _continue: true });
  });

  it('C-5: userId は行の user_id を使う (generated_data に書かれた userId では上書きされない)', async () => {
    const forged = { ...GENERATED_DATA, userId: 'someone-else', requestId: 'req-other' };

    const first = await dispatch(claimedRow({ generated_data: forged }));
    expect(first.body.userId).toBe('user-1');
    expect(first.body.requestId).toBe('req-1');

    mockFetch.mockClear();
    const resumed = await dispatch(claimedRow({ attempt_count: 2, current_step: 2, generated_data: forged }));
    expect(resumed.body).toEqual({ requestId: 'req-1', userId: 'user-1', _continue: true });
  });

  it('C-6: generated_data が空 (null) の初回クレームでも userId を渡す', async () => {
    const { body } = await dispatch(claimedRow({ generated_data: null }));

    expect(body).toEqual({ requestId: 'req-1', userId: 'user-1' });
  });

  it('C-7: 取り直したときだけ、警告ログに取り直した回数と再開するステップを残す', async () => {
    await dispatch(claimedRow({ attempt_count: 2, current_step: 4 }));

    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn.mock.calls[0][1]).toMatchObject({ requestId: 'req-1', attemptCount: 2, currentStep: 4 });
  });

  it('C-8: Edge Function がエラーを返したら 500 を返す。本文に例外の文面を出さず、構造化ログに残す (#1172)', async () => {
    mockFetch.mockImplementation(async () => new Response('boom', { status: 500 }));

    const { res } = await dispatch(claimedRow({ attempt_count: 2, current_step: 4 }));

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: INTERNAL_ERROR_MESSAGE, code: INTERNAL_ERROR_CODE });
    expect(text).not.toContain('boom');
    // 元の例外は構造化ログにだけ残る (本文にはその文面が 1 文字も出ない)
    expect(mockLogError).toHaveBeenCalledTimes(1);
    const loggedError = mockLogError.mock.calls[0][1] as Error;
    expect(loggedError).toBeInstanceOf(Error);
    expect(loggedError.message).not.toBe('');
    expect(text).not.toContain(loggedError.message);
  });
});

describe('GET /api/cron/process-menu-queue (#1196 シークレットの入れ替え)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('入れ替え中は CRON_SECRET_PREVIOUS (旧い値) でも認可され、現行の値も引き続き認可される', async () => {
    vi.stubEnv('CRON_SECRET_PREVIOUS', 'my-old-cron-secret');

    const withOld = await GET(makeRequest('Bearer my-old-cron-secret'));
    expect(withOld.status).toBe(200);
    expect((await withOld.json()).idle).toBe(true);

    const withNew = await GET(makeRequest('Bearer my-cron-secret-value'));
    expect(withNew.status).toBe(200);
    expect((await withNew.json()).idle).toBe(true);
  });

  it('旧い値を外した (CRON_SECRET_PREVIOUS を空にした) あとは、旧い値は 401', async () => {
    vi.stubEnv('CRON_SECRET_PREVIOUS', '');
    const res = await GET(makeRequest('Bearer my-old-cron-secret'));
    expect(res.status).toBe(401);
  });

  it('CRON_SECRET_PREVIOUS が空でも、Authorization ヘッダーなし・空のトークンは 401', async () => {
    vi.stubEnv('CRON_SECRET_PREVIOUS', '');
    expect((await GET(makeRequest())).status).toBe(401);
    expect((await GET(makeRequest('Bearer '))).status).toBe(401);
    expect((await GET(makeRequest('Bearer'))).status).toBe(401);
  });

  it('CRON_SECRET が未設定なら、CRON_SECRET_PREVIOUS があっても 503', async () => {
    vi.stubEnv('CRON_SECRET', undefined);
    vi.stubEnv('CRON_SECRET_PREVIOUS', 'my-old-cron-secret');
    const res = await GET(makeRequest('Bearer my-old-cron-secret'));
    expect(res.status).toBe(503);
  });

  it('認証に通らなければ、キューには触らない (RPC を呼ばない)', async () => {
    vi.stubEnv('CRON_SECRET_PREVIOUS', 'my-old-cron-secret');
    await GET(makeRequest('Bearer not-a-secret'));
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// #1182 / #1172: 必須の環境変数が欠けていたら、汎用の 500 で止める。
//   本文には変数名を出さず、変数名は構造化ログ (db-logger) にだけ渡す。キューには触らない。
// ---------------------------------------------------------------
describe('GET /api/cron/process-menu-queue: 必須の環境変数 (#1182)', () => {
  it.each(['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])(
    '%s が未設定なら、汎用の 500 (本文に変数名なし)。変数名は db-logger に渡し、キューには触らない',
    async (name) => {
      vi.stubEnv(name, undefined);

      const res = await GET(makeRequest('Bearer my-cron-secret-value'));
      const text = await res.text();

      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: '処理中にエラーが発生しました', code: 'INTERNAL_ERROR' });
      expect(text).not.toContain(name);
      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError.mock.calls[0][1]).toMatchObject({ name: 'MissingEnvError', envName: name });
      expect(mockRpc).not.toHaveBeenCalled();
    },
  );

  it('認証に通らなければ、環境変数が欠けていても 401 (設定の不足を教えない)', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);

    const res = await GET(makeRequest('Bearer wrong-secret'));

    expect(res.status).toBe(401);
    expect(mockLogError).not.toHaveBeenCalled();
  });
});
