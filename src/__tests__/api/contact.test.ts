import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_EMAIL_FROM } from '@/lib/site-config';

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

function makeRequest(body: unknown, ip = '203.0.113.1') {
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
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

  it('本番環境で Upstash 未設定 (テスト環境の常態) でも in-memory フォールバックで受け付ける', async () => {
    // このテストスイートは UPSTASH_REDIS_REST_URL/TOKEN を設定していないため、
    // 共通ヘルパー (src/lib/rate-limit.ts) は in-memory フォールバックで数える。
    // #1044 round-2: Upstash 未設定を理由に hard 503 で拒否すると本番で問い合わせフォームが
    // 全壊するため、in-memory フォールバック + warn ログの canonical 方針に揃え、
    // NODE_ENV=production でもリクエストを通す (#1197 で route の独自実装を共通ヘルパーに置き換えた後も同じ)。
    vi.stubEnv('NODE_ENV', 'production');
    const res = await POST(makeRequest(validBody));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockInsert).toHaveBeenCalled();
  });
});

// #1194 管理者への通知メールの送信元は、ほかのメールと同じく src/lib/site-config.ts (EMAIL_FROM) で決まる
describe('POST /api/contact: 管理者への通知メールの送信元 (#1194)', () => {
  // 上のテストと同じ IP だと 1 分あたりの上限 (10 回) に近づくため、別の IP から送る
  const NOTIFY_TEST_IP = '203.0.113.99';
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', 'admin@example.com');
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Resend へ送られたリクエストの本文 */
  const sentBody = () => JSON.parse(fetchSpy.mock.calls[0][1].body as string) as { from: string; to: string[] };

  it('EMAIL_FROM があれば、それを送信元にする', async () => {
    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');

    const res = await POST(makeRequest(validBody, NOTIFY_TEST_IP));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    expect(sentBody().from).toBe('ほめゴハン <noreply@mail.example.test>');
    expect(sentBody().to).toEqual(['admin@example.com']);
  });

  it('EMAIL_FROM が未設定なら、従来と同じ既定の送信元 (DEFAULT_EMAIL_FROM)', async () => {
    vi.stubEnv('EMAIL_FROM', '');

    await POST(makeRequest(validBody, NOTIFY_TEST_IP));

    expect(sentBody().from).toBe(DEFAULT_EMAIL_FROM);
  });

  it('Resend が送信を断っても (送信元のドメインが未検証など)、問い合わせの受け付けは成功のまま', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"message":"The example.test domain is not verified."}',
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(makeRequest(validBody, NOTIFY_TEST_IP));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    // 失敗は握りつぶさず、ログに残す
    expect(consoleError).toHaveBeenCalledWith('Admin notification failed:', 403, expect.stringContaining('not verified'));
    consoleError.mockRestore();
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
