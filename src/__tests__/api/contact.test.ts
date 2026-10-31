import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_EMAIL_FROM } from '@/lib/site-config';
import type { EmailEnvelope } from '@/lib/emails/envelope';
import { EmailSendError } from '@/lib/emails/send-result';

const mockGetUser = vi.fn();
/** insert の結果 ({ error })。route は保存した行を読み返さない (RETURNING を付けない) */
const mockInsertResult = vi.fn();
/** insert().select() が呼ばれたかの見張り。未ログイン (anon) は inquiries を読めないので、呼ぶと実 DB では RLS の違反になる */
const mockSelectAfterInsert = vi.fn();
const mockInsert = vi.fn((_row: Record<string, unknown>) =>
  Object.assign(Promise.resolve().then(() => mockInsertResult()), { select: mockSelectAfterInsert }),
);

const mockOrder = vi.fn();
/** order を重ねられる鎖 (並びは作った日時の新しい順 → id の順と 2 回重ねる。#2139 T1)。await すると最後の mockOrder の戻り値になる */
interface OrderChain {
  order: (...args: unknown[]) => OrderChain;
  then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => Promise<unknown>;
}
let lastOrderResult: unknown;
const orderChain: OrderChain = {
  order: (...args: unknown[]) => {
    lastOrderResult = mockOrder(...args);
    return orderChain;
  },
  then: (onFulfilled, onRejected) => Promise.resolve(lastOrderResult).then(onFulfilled, onRejected),
};
const mockEq = vi.fn(() => orderChain);
const mockSelect = vi.fn((_columns?: string) => ({ eq: mockEq }));

// #1193 お問い合わせの管理者通知は sendEmail (送信待ちへの登録) を通る。送信そのものは send.test.ts が受け持つ
const mockSendEmail = vi.hoisted(() => vi.fn());
vi.mock('@/lib/emails/send', () => ({ sendEmail: mockSendEmail }));

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  mockInsertResult.mockReturnValue({ data: null, error: null });
  mockOrder.mockResolvedValue({ data: [], error: null });
  mockSendEmail.mockResolvedValue({ ok: true, id: 'outbox-id-1', attempts: 0, skipped: false, error: null });
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

  it('未ログインの送信は、route で決めた UUID の id と user_id = NULL で INSERT し、保存した行を読み返さない (insert().select() を呼ばない)', async () => {
    const res = await POST(makeRequest(validBody, '203.0.113.2'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0][0];
    expect(row).toEqual({
      id: expect.stringMatching(UUID_PATTERN),
      user_id: null,
      inquiry_type: 'general',
      email: 'user@example.com',
      subject: 'テスト件名',
      message: 'テストメッセージ',
      status: 'pending',
    });
    expect(mockSelectAfterInsert).not.toHaveBeenCalled();
    expect(json.inquiryId).toBe(row.id);
  });

  it('ログイン中の送信は、本人の user_id で INSERT する (読み返さないのは同じ)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });

    const res = await POST(makeRequest(validBody, '203.0.113.3'));

    expect(res.status).toBe(200);
    expect(mockInsert.mock.calls[0][0]).toMatchObject({ user_id: 'user-1', status: 'pending' });
    expect(mockSelectAfterInsert).not.toHaveBeenCalled();
  });

  it('INSERT が失敗したら 500 (お問い合わせの保存に失敗しました)。通知は送らない', async () => {
    mockInsertResult.mockReturnValue({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(makeRequest(validBody, '203.0.113.4'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('お問い合わせの保存に失敗しました');
    expect(mockSendEmail).not.toHaveBeenCalled();
    consoleError.mockRestore();
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

// #1194 管理者への通知メールの送信元は、ほかのメールと同じく src/lib/site-config.ts (EMAIL_FROM) で決まる。
// #1193 通知は Resend を直接呼ばず、sendEmail で送信待ち (email_outbox) に登録する (送るのは worker)。
// 本文の送信者はマスクし、全体はサポートの画面 (/support/inquiries) で見る (docs/design/operator/10-logs-and-mail-retry.md §6.6)
describe('POST /api/contact: 管理者への通知メールの送信元 (#1194)', () => {
  // 上のテストと同じ IP だと 1 分あたりの上限 (10 回) に近づくため、別の IP から送る
  const NOTIFY_TEST_IP = '203.0.113.99';
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', 'admin@example.com');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
    fetchSpy.mockReset();
    // Resend の API を直接呼ばないことを確かめるための見張り (呼ばれても成功を返す)
    fetchSpy.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** sendEmail に渡した封筒 */
  const sentEnvelope = () => mockSendEmail.mock.calls[0][0] as EmailEnvelope;

  it('EMAIL_FROM があれば、それを送信元にする', async () => {
    vi.stubEnv('EMAIL_FROM', 'ほめゴハン <noreply@mail.example.test>');

    const res = await POST(makeRequest(validBody, NOTIFY_TEST_IP));

    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(sentEnvelope().from).toBe('ほめゴハン <noreply@mail.example.test>');
    expect(sentEnvelope().to).toBe('admin@example.com');
  });

  it('EMAIL_FROM が未設定なら、従来と同じ既定の送信元 (DEFAULT_EMAIL_FROM)', async () => {
    vi.stubEnv('EMAIL_FROM', '');

    await POST(makeRequest(validBody, NOTIFY_TEST_IP));

    expect(sentEnvelope().from).toBe(DEFAULT_EMAIL_FROM);
  });

  it('送信待ちへの登録が失敗しても (sendEmail が ok:false の outbox_failed)、問い合わせの受け付けは成功のまま。warn を残す', async () => {
    mockSendEmail.mockResolvedValue({
      ok: false,
      id: null,
      attempts: 0,
      skipped: false,
      error: new EmailSendError('outbox_failed', 'EMAIL_OUTBOX_FAILED: メールを送信待ちに登録できませんでした', null, 0, true),
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(makeRequest(validBody, NOTIFY_TEST_IP));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    // 失敗は握りつぶさず、ログに残す (どの問い合わせか・コードだけ)
    expect(consoleWarn.mock.calls.some(([first]) => String(first).includes('お問い合わせの通知メールを送信待ちに登録できませんでした'))).toBe(true);
    consoleWarn.mockRestore();
  });

  it('通知は template contact_admin_notification で、本文の送信者はマスクする (user@example.com を含まず u***@example.com を含む)。サポートの画面の URL (/support/inquiries) が単独の行', async () => {
    await POST(makeRequest(validBody, NOTIFY_TEST_IP));

    const envelope = sentEnvelope();
    expect(envelope.template).toBe('contact_admin_notification');
    expect(envelope.subject).toBe('[お問い合わせ] テスト件名');
    // 本文の ID は、保存した行の id (応答の inquiryId と同じ)
    expect(envelope.text).toContain(`ID: ${mockInsert.mock.calls[0][0].id}`);
    expect(envelope.text).not.toContain('user@example.com');
    expect(envelope.text).toContain('u***@example.com');
    expect(envelope.text.split('\n')).toContain('https://app.example.test/support/inquiries');
    // userId は渡さない (行に本人のアドレスが無いので伏せる対象が無い)
    expect(mockSendEmail.mock.calls[0]).toHaveLength(1);
  });

  it('ADMIN_NOTIFICATION_EMAIL が未設定なら sendEmail を呼ばずに 200', async () => {
    vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', '');
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(makeRequest(validBody, NOTIFY_TEST_IP));

    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(consoleWarn.mock.calls.some(([first]) => String(first).includes('ADMIN_NOTIFICATION_EMAIL が未設定'))).toBe(true);
    consoleWarn.mockRestore();
  });

  it('Resend の API (fetch) を直接呼ばない', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_key');

    await POST(makeRequest(validBody, NOTIFY_TEST_IP));

    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('api.resend.com'))).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
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
