import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/org/stats/refresh (組織統計の再集計。停止中) (#1325)
//
// 以前は、組織ダッシュボードの「Refresh Data」ボタンが押されると、このルートが権限を確認したあと、
// サーバーから Edge Function aggregate-org-stats を呼んでいた (#1167)。
// オーナー判断 (#1325) で組織の集計は止めた。ボタンは取り除き、このルートは、古い画面から呼ばれたときに
// 「停止している」とはっきり答えるために残してある。権限の確認 (401 / 403) は停止前と同じで、
// 確認を通った owner / admin には 410 (DISABLED) を返す。Edge Function は一切呼ばない。

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

const DISABLED_BODY = { error: { code: 'DISABLED', message: '組織の集計は停止しています' } };

const ORIGINAL_ENV = { ...process.env };

function profileQuery(result: unknown) {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.single = vi.fn(async () => result);
  return query;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** fetch が受け取った URL の一覧 (どこにも通信していないことの確認に使う) */
function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
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

  // どこかへ通信しようとしたら検出できるよう、fetch は呼び出しを記録する偽物にしておく
  fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('POST /api/org/stats/refresh: 権限の確認 (停止前と同じ。#1167)', () => {
  it('RF-1: 未ログインは 401。何も呼ばない', async () => {
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
  ])('RF-2: %s は 403。何も呼ばない', async (_label, profile) => {
    mockFrom.mockImplementation(() => profileQuery({ data: profile, error: null }));

    const res = await POST();

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('RF-3: org_role が %s なら権限の確認を通り、410 (DISABLED) を返す', async (orgRole) => {
    mockFrom.mockImplementation(() =>
      profileQuery({ data: { organization_id: ORG_ID, org_role: orgRole }, error: null }),
    );

    const res = await POST();

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(DISABLED_BODY);
  });
});

describe('POST /api/org/stats/refresh: 集計の停止 (#1325)', () => {
  it('RF-4: Edge Function aggregate-org-stats を呼ばない。どこにも通信しない', async () => {
    const res = await POST();

    expect(res.status).toBe(410);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchedUrls().filter((url) => url.includes('aggregate-org-stats') || url.includes('/functions/v1/'))).toEqual(
      [],
    );
  });

  it('RF-5: リクエストに組織 ID や日付を載せても結果は同じ (410。集計を依頼しない)', async () => {
    const res = await (POST as unknown as (req: Request) => Promise<Response>)(
      new Request('http://localhost/api/org/stats/refresh', {
        method: 'POST',
        body: JSON.stringify({ organizationId: OTHER_ORG_ID, date: '2020-01-01' }),
      }),
    );

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(DISABLED_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RF-6: Supabase の接続情報の有無に関係なく 410 (以前の 503 にはならない)。service role key を応答に含めない', async () => {
    const withKey = await POST();
    expect(withKey.status).toBe(410);
    expect(JSON.stringify(await withKey.json())).not.toContain(SERVICE_ROLE_KEY);

    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const withoutKey = await POST();
    expect(withoutKey.status).toBe(410);
    expect(await withoutKey.json()).toEqual(DISABLED_BODY);

    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect((await POST()).status).toBe(410);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('RF-7: 予期しない例外は 500。内部のエラー文は返さず、ログに残す', async () => {
    mockGetUser.mockRejectedValue(new Error('connection refused to 10.0.0.5'));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RF-8: ルートのソースが、fetch・Edge Function の URL・service role key を使っていない', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../../app/api/org/stats/refresh/route.ts'), 'utf8');

    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain('functions/v1');
    expect(source).not.toContain('SERVICE_ROLE');
    // 権限の確認は共通ヘルパー (#1161)。user_profiles を手書きで読まない
    expect(source).toContain('requireOrgAdmin');
    expect(source).not.toContain('user_profiles');
  });
});
