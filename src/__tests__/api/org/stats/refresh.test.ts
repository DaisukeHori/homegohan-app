import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/org/stats/refresh (組織ダッシュボードの「Refresh Data」) (#1167)
//
// 以前はブラウザが Edge Function aggregate-org-stats を直接呼んでいた。この関数はバッチ専用で、
// 利用者の JWT では 401 になるうえ、ブラウザから呼べるように CORS を開けるのは危険だった。
// 今は、この API ルートが「所属組織の owner / admin か」を確認したあと、サーバーから service role key を付けて呼ぶ。

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const client = { auth: { getUser: mockGetUser }, from: mockFrom };

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => client),
}));

const mockLogError = vi.fn();
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLogError };

vi.mock('@/lib/db-logger', () => ({
  createLogger: vi.fn(() => ({ ...logger, withUser: vi.fn(() => logger) })),
  generateRequestId: vi.fn(() => 'req_test'),
}));

const { POST } = await import('@/app/api/org/stats/refresh/route');

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_ROLE_KEY = 'service-role-key-for-test';
const USER = { id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', email: 'admin@example.com' };
const ORG_ID = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
const OTHER_ORG_ID = 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33';

const ORIGINAL_ENV = { ...process.env };

function profileQuery(result: unknown) {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.single = vi.fn(async () => result);
  return query;
}

let fetchMock: ReturnType<typeof vi.fn>;

function edgeResponse(status: number, body: unknown = { success: true, processed: [] }) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY };

  mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'user_profiles') {
      return profileQuery({ data: { organization_id: ORG_ID, org_role: 'admin' }, error: null });
    }
    throw new Error(`unexpected table: ${table}`);
  });

  fetchMock = vi.fn().mockResolvedValue(edgeResponse(200));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('POST /api/org/stats/refresh: 権限の確認 (#1167)', () => {
  it('RF-1: 未ログインは 401。Edge Function は呼ばない', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const res = await POST();

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['一般メンバー (org_role = member)', { organization_id: ORG_ID, org_role: 'member' }],
    ['組織に所属していない', { organization_id: null, org_role: 'admin' }],
    ['org_role が無い', { organization_id: ORG_ID, org_role: null }],
    ['プロフィールが読めない', null],
  ])('RF-2: %s は 403。Edge Function は呼ばない', async (_label, profile) => {
    mockFrom.mockImplementation(() => profileQuery({ data: profile, error: null }));

    const res = await POST();

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('RF-3: org_role が %s なら実行できる', async (orgRole) => {
    mockFrom.mockImplementation(() =>
      profileQuery({ data: { organization_id: ORG_ID, org_role: orgRole }, error: null }),
    );

    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/org/stats/refresh: Edge Function の呼び出し (#1167)', () => {
  it('RF-4: 自分の組織だけを、service role key を付けて aggregate-org-stats に依頼する', async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${SUPABASE_URL}/functions/v1/aggregate-org-stats`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    // 組織はプロフィールで確認した organization_id だけ。日付は関数の既定 (今日) に任せるので送らない
    expect(JSON.parse(init.body as string)).toEqual({ organizationId: ORG_ID });
  });

  it('RF-5: リクエストに別の組織 ID を載せても使わない (他の組織を集計させられない)', async () => {
    await (POST as unknown as (req: Request) => Promise<Response>)(
      new Request('http://localhost/api/org/stats/refresh', {
        method: 'POST',
        body: JSON.stringify({ organizationId: OTHER_ORG_ID, date: '2020-01-01' }),
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ organizationId: ORG_ID });
    expect(init.body as string).not.toContain(OTHER_ORG_ID);
  });

  it('RF-6: service role key を応答に含めない', async () => {
    const ok = await POST();
    expect(JSON.stringify(await ok.json())).not.toContain(SERVICE_ROLE_KEY);

    fetchMock.mockResolvedValue(edgeResponse(500, { error: `boom ${SERVICE_ROLE_KEY}` }));
    const failed = await POST();
    expect(JSON.stringify(await failed.json())).not.toContain(SERVICE_ROLE_KEY);
  });

  it('RF-7: Supabase の接続情報が無いときは、成功を装わず 503。Edge Function は呼ばない', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const res = await POST();

    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('ORG_STATS_REFRESH_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledTimes(1);

    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect((await POST()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 500, 503])('RF-8: Edge Function が %i を返したら 502。関数のエラー文は利用者へ返さずログに残す', async (status) => {
    fetchMock.mockResolvedValue(edgeResponse(status, { error: 'relation "internal_table" does not exist' }));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe('ORG_STATS_REFRESH_FAILED');
    expect(JSON.stringify(body)).not.toContain('internal_table');
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError.mock.calls[0][2]).toEqual(
      expect.objectContaining({ organizationId: ORG_ID, status, detail: expect.stringContaining('internal_table') }),
    );
  });

  it('RF-9: Edge Function への接続に失敗 (タイムアウトなど) したら 502', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'));

    const res = await POST();

    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('ORG_STATS_REFRESH_FAILED');
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it('RF-10: 呼び出しには待ち時間の上限 (タイムアウト) が付く', async () => {
    await POST();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('RF-11: 予期しない例外は 500。内部のエラー文は返さない', async () => {
    mockGetUser.mockRejectedValue(new Error('connection refused to 10.0.0.5'));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
