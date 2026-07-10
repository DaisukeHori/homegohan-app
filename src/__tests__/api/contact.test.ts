import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetUser = vi.fn();
const mockSingle = vi.fn();
const mockSelectAfterInsert = vi.fn(() => ({ single: mockSingle }));
const mockInsert = vi.fn(() => ({ select: mockSelectAfterInsert }));

const mockOrder = vi.fn();
const mockEq = vi.fn(() => ({ order: mockOrder }));
const mockSelect = vi.fn((_columns?: string) => ({ eq: mockEq }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: mockGetUser },
    from: () => ({
      insert: mockInsert,
      select: mockSelect,
    }),
  }),
}));

const { POST, GET } = await import('@/app/api/contact/route');

const validBody = {
  inquiryType: 'general',
  email: 'user@example.com',
  subject: 'テスト件名',
  message: 'テストメッセージ',
};

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.1' },
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  mockSingle.mockResolvedValue({
    data: { id: 'inquiry-1', inquiry_type: 'general', email: 'user@example.com', subject: 's', message: 'm' },
    error: null,
  });
  mockOrder.mockResolvedValue({ data: [], error: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/contact (#1044 F6-19)', () => {
  it('正常なリクエストは成功する', async () => {
    const res = await POST(makeRequest(validBody));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
  });

  it('不正な inquiryType は 400 を返す', async () => {
    const res = await POST(makeRequest({ ...validBody, inquiryType: 'not-a-real-type' }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('不正なメールアドレスは 400 を返す', async () => {
    const res = await POST(makeRequest({ ...validBody, email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('100文字を超える subject は 400 を返す', async () => {
    const res = await POST(makeRequest({ ...validBody, subject: 'a'.repeat(101) }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('5000文字を超える message は 400 を返す', async () => {
    const res = await POST(makeRequest({ ...validBody, message: 'a'.repeat(5001) }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('5000文字ちょうどの message は許可される', async () => {
    const res = await POST(makeRequest({ ...validBody, message: 'a'.repeat(5000) }));
    expect(res.status).toBe(200);
  });

  it('本番環境で Upstash 未設定 (テスト環境の常態) の場合は 503 を返す', async () => {
    // このテストスイートは UPSTASH_REDIS_REST_URL/TOKEN を設定していないため
    // upstashRatelimiter は null のまま。NODE_ENV を production に切り替えると
    // in-memory フォールバックへの依存を許さず 503 で拒否するはず (F6-19)。
    vi.stubEnv('NODE_ENV', 'production');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(503);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('GET /api/contact (#1044 F6-19)', () => {
  it('未認証は 401 を返す', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: new Error('no session') });
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('必要な列のみを select する (admin_notes 等を含めない)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    const selectedColumns = mockSelect.mock.calls[0][0] as string;
    expect(selectedColumns).not.toContain('*');
    expect(selectedColumns).not.toContain('admin_notes');
    expect(selectedColumns).toContain('inquiry_type');
  });
});
