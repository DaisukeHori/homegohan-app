import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockRpc = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: mockRpc,
    from: () => ({
      update: () => ({ eq: () => ({ eq: () => ({ in: vi.fn() }) }) }),
    }),
  })),
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
