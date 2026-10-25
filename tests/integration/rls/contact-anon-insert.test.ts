/**
 * POST /api/contact (お問い合わせの送信) を、ローカル Supabase の実 DB に対して確かめる。
 *
 * /contact は未ログインで開ける (lib/supabase/middleware.ts の publicPaths)。route は本人のセッションのクライアント
 * (createClient()) で inquiries に INSERT する。inquiries の SELECT のポリシーは authenticated だけ
 * ("Users can view own inquiries"・"Admins can view all inquiries") で、anon が読める行は無い。
 * INSERT … RETURNING (supabase-js の insert().select()) は SELECT のポリシーも新しい行に当てるので、
 * 以前の route (insert().select().single()) は未ログインの送信が RLS の違反 (42501) で落ち、
 * 「お問い合わせの保存に失敗しました」の 500 になっていた。
 *
 * ここで確かめること (route のハンドラーをそのまま呼ぶ。セッションのクライアントは実物):
 *   A-1: 未ログイン (anon) の送信は 200。返した inquiryId の行が、user_id = NULL・status = pending で 1 行だけ保存される
 *   A-2: 管理者への通知は、保存した行の id (inquiryId と同じ) と入力の件名で送信待ちに登録する
 *   A-3: ログイン中の送信も 200。行の user_id は本人
 *   A-4: 未ログインのクライアントは、保存した行を読み返せない (RETURNING を付けない理由。SELECT のポリシーは今までどおり)
 *
 * 実行:
 *   bash scripts/supabase-local.sh start
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/contact-anon-insert.test.ts
 *
 * 自分の行は件名の目印 (SUBJECT_MARK) で識別し、開始時と終了時に必ず削除する。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import ws from 'ws';

// ---------------------------------------------------------------
// 環境変数 / クライアント
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);

/** route の createClient() が返すクライアント。テストごとに未ログイン (anon) かサインイン済みを入れる */
let routeClient: SupabaseClient;

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => routeClient,
}));

// 管理者への通知は sendEmail (送信待ちへの登録) を通る。ここでは何を登録しようとしたかだけを記録する
const mockSendEmail = vi.hoisted(() => vi.fn());
vi.mock('@/lib/emails/send', () => ({ sendEmail: mockSendEmail }));

// ---------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------
const TS = Date.now();
const PASSWORD = 'TestPass!2026-contact';
/** 自分の行を見分ける件名の目印 (件名は 100 文字以内) */
const SUBJECT_MARK = `it-contact-anon-${TS}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let userId: string | undefined;
let userEmail: string;
let signedInClient: SupabaseClient;

/** レート制限 (IP 単位) に他のテストと同じ枠を使わせないため、テストごとに別の IP から送る */
let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq}`;

function contactRequest(subject: string, email = 'guest@example.com') {
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ inquiryType: 'general', email, subject, message: 'お問い合わせの本文' }),
  }) as unknown as import('next/server').NextRequest;
}

async function rowsWithSubject(subject: string) {
  const { data, error } = await srAdmin
    .from('inquiries')
    .select('id, user_id, status, email, subject, admin_notes, resolved_at')
    .eq('subject', subject);
  if (error) throw new Error(`inquiries read: ${error.message}`);
  return data ?? [];
}

async function purgeOwnRows() {
  await srAdmin.from('inquiries').delete().like('subject', `${SUBJECT_MARK}%`);
}

const { POST } = await import('../../../src/app/api/contact/route');

beforeAll(async () => {
  await purgeOwnRows();
  userEmail = `it-contact-anon-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email: userEmail, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  signedInClient = client(anonKey);
  const session = await signedInClient.auth.signInWithPassword({ email: userEmail, password: PASSWORD });
  if (session.error || !session.data.session) throw new Error(`signIn: ${session.error?.message}`);
}, 60_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  mockSendEmail.mockReset();
  await purgeOwnRows();
});

afterAll(async () => {
  await purgeOwnRows();
  if (userId) await srAdmin.auth.admin.deleteUser(userId);
}, 30_000);

describe('POST /api/contact (実 DB): 未ログインでも送れる', () => {
  it('A-1: 未ログイン (anon) の送信は 200。返した inquiryId の行が user_id = NULL・status = pending で 1 行だけ保存される', async () => {
    routeClient = client(anonKey);
    const subject = `${SUBJECT_MARK} anon`;

    const res = await POST(contactRequest(subject));
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.success).toBe(true);
    expect(body.inquiryId).toMatch(UUID_PATTERN);
    expect(await rowsWithSubject(subject)).toEqual([
      { id: body.inquiryId, user_id: null, status: 'pending', email: 'guest@example.com', subject, admin_notes: null, resolved_at: null },
    ]);
  });

  it('A-2: 管理者への通知は、保存した行の id (inquiryId と同じ) と入力の件名で送信待ちに登録する', async () => {
    routeClient = client(anonKey);
    vi.stubEnv('ADMIN_NOTIFICATION_EMAIL', 'admin@example.com');
    mockSendEmail.mockResolvedValue({ ok: true, id: 'outbox-id-1', attempts: 0, skipped: false, error: null });
    const subject = `${SUBJECT_MARK} notify`;

    const res = await POST(contactRequest(subject));
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(200);
    const [saved] = await rowsWithSubject(subject);
    expect(saved?.id).toBe(body.inquiryId);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const envelope = mockSendEmail.mock.calls[0][0] as { subject: string; text: string; to: string };
    expect(envelope.to).toBe('admin@example.com');
    expect(envelope.subject).toBe(`[お問い合わせ] ${subject}`);
    expect(envelope.text).toContain(body.inquiryId);
  });

  it('A-3: ログイン中の送信も 200。行の user_id は本人', async () => {
    routeClient = signedInClient;
    const subject = `${SUBJECT_MARK} signed-in`;

    const res = await POST(contactRequest(subject, userEmail));
    const body = await res.json();

    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(await rowsWithSubject(subject)).toEqual([
      { id: body.inquiryId, user_id: userId, status: 'pending', email: userEmail, subject, admin_notes: null, resolved_at: null },
    ]);
  });

  it('A-4: 未ログインのクライアントは、保存した行を読み返せない (SELECT のポリシーは authenticated だけのまま)', async () => {
    routeClient = client(anonKey);
    const subject = `${SUBJECT_MARK} unreadable`;

    const res = await POST(contactRequest(subject));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);

    const { data, error } = await client(anonKey).from('inquiries').select('id').eq('id', body.inquiryId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect(await rowsWithSubject(subject)).toHaveLength(1);
  });
});
