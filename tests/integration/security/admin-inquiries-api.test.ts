/**
 * #1121 /api/admin/inquiries 系の結合テスト (実 DB + 実ルート + 実 RLS)
 *
 * 修正前は /api/admin/inquiries 自体が存在せず、Web のサポート画面もモバイルの問い合わせ画面も
 * 常に失敗した (Web は失敗を握りつぶして「該当する問い合わせはありません」と表示していた)。
 * 単体テスト (tests/admin-inquiries-route.test.ts) は Supabase を偽物に置き換えているため、
 * ここでは本物の RLS・PostgREST・監査ログ (inet 列) を通して次を確かめる。
 *
 *   - 認可: 未ログイン 401 / 運営ロール以外 403 / admin・super_admin・support は 200。拒否された要求は何も書き換えず、監査ログも残さない
 *   - 一覧: 新しい順、status の絞り込み、limit / page、範囲外のページ (PostgREST の 416) は空のページ、
 *     会員の問い合わせにニックネーム (userName)。ゲストは null。概要だけで、本文と管理者メモは返さない
 *   - 詳細・更新: 200 / 400 / 404、PATCH と PUT が同じ結果、resolved_at の決め方、書き込む列の限定
 *   - 監査ログ (#1200): 詳細の閲覧と更新を記録する (対象は閲覧された本人。ゲストは問い合わせそのもの)。
 *     プロキシ経由の x-forwarded-for (複数ホップ) でも inet 列に入る。値 (メール・本文・メモ) は入れない。一覧は記録しない
 *   - RLS: 運営ロール以外は、直接 PostgREST を叩いても他人の問い合わせを読めず、更新もできない
 *   - 同時の更新: 更新は直前に読んだ status と updated_at を条件にする。PostgREST が返した updated_at の文字列で
 *     条件が一致すること (秒未満まで)、ずれた値では 0 行になること、運営が同時に更新しても監査の status_from が
 *     実際の直前の値とつながること (200 か 409 CONFLICT_STALE_DATA だけ)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/admin-inquiries-api.test.ts
 */

import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';
import { apiCall, apiCallNoAuth } from '../helpers/api';
import { signInForIntegration } from '../helpers/mfa';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

function client(key: string, jwt?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(jwt ? { global: { headers: { Authorization: `Bearer ${jwt}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);

interface TestUser {
  id: string;
  jwt: string;
  nickname: string;
}

/** 一覧が返す 1 件 (概要)。本文と管理者メモは含まない */
interface InquirySummaryDto {
  id: string;
  userId: string | null;
  userName: string | null;
  inquiryType: string;
  email: string;
  subject: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

/** 詳細・更新が返す 1 件 (概要 + 本文 + 管理者メモ) */
interface InquiryDto extends InquirySummaryDto {
  message: string;
  adminNotes: string | null;
}

const SUMMARY_KEYS = [
  'createdAt',
  'email',
  'id',
  'inquiryType',
  'resolvedAt',
  'status',
  'subject',
  'updatedAt',
  'userId',
  'userName',
];
const DETAIL_KEYS = [...SUMMARY_KEYS, 'adminNotes', 'message'].sort();

interface ListResponse {
  inquiries: InquirySummaryDto[];
  total: number | null;
  page: number;
  limit: number;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

const TS = Date.now();
const MARK = `#1121-${TS}`;
const createdUserIds: string[] = [];
const createdInquiryIds: string[] = [];

let support: TestUser;
let admin: TestUser;
let superAdmin: TestUser;
let sales: TestUser;
let general: TestUser;
let customer: TestUser;

/** 運営ロールを持つテストユーザー (roles は service role で入れる) を作り、サインインして JWT を得る */
async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `sec-inquiries-${label}-${TS}@homegohan.test`;
  // テスト用ユーザーのパスワードは固定値を置かず、実行ごとに作る
  const password = `Aa1!${randomUUID()}`;
  const nickname = `inq-${label}-${TS}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う。必須ロールなら TOTP で aal2 にする (#1176。cross/12 §22.4.1)
  const jwt = await signInForIntegration({ email, password, roles });
  return { id: data.user.id, jwt, nickname };
}

interface Seeded {
  guestPending: string;
  customerInProgress: string;
  guestResolved: string;
}
let seeded: Seeded;

async function dbRow(id: string) {
  const { data, error } = await srAdmin.from('inquiries').select('*').eq('id', id).single();
  if (error) throw new Error(`inquiries ${id}: ${error.message}`);
  return data as Record<string, unknown>;
}

async function auditRows(actorId: string, actionType: string, targetId?: string) {
  let query = srAdmin
    .from('admin_audit_logs')
    .select('actor_id, action_type, target_id, target_type, details, severity, ip_address')
    .eq('actor_id', actorId)
    .eq('action_type', actionType);
  if (targetId) query = query.eq('target_id', targetId);
  const { data, error } = await query;
  if (error) throw new Error(`admin_audit_logs: ${error.message}`);
  return data ?? [];
}

beforeAll(async () => {
  // dev サーバは route への初回アクセスでコンパイルする。テスト本体の 30 秒の制限に含まれないよう、先に叩いておく
  const warmup = Promise.all([
    apiCallNoAuth('GET', '/api/admin/inquiries'),
    apiCallNoAuth('GET', '/api/admin/inquiries/00000000-0000-4000-8000-000000000000'),
  ]);
  warmup.catch(() => undefined); // 先に別の準備で失敗したときに、未処理の拒否として報告されないように

  [support, admin, superAdmin, sales, general, customer] = await Promise.all([
    createUser('support', ['support']),
    createUser('admin', ['admin']),
    createUser('super-admin', ['super_admin']),
    createUser('sales', ['sales']),
    createUser('general', ['user']),
    createUser('customer', ['user']),
  ]);

  const base = Date.now();
  const { data, error } = await srAdmin
    .from('inquiries')
    .insert([
      {
        user_id: null,
        inquiry_type: 'general',
        email: `guest-${TS}@homegohan.test`,
        subject: `${MARK} ゲストの問い合わせ (未対応)`,
        message: '使い方を教えてください',
        status: 'pending',
        created_at: new Date(base).toISOString(),
      },
      {
        user_id: customer.id,
        inquiry_type: 'bug',
        email: `customer-${TS}@homegohan.test`,
        subject: `${MARK} 会員の不具合報告 (対応中)`,
        message: '画面が真っ白になります',
        status: 'in_progress',
        admin_notes: '調査中',
        created_at: new Date(base - 1000).toISOString(),
      },
      {
        user_id: null,
        inquiry_type: 'feature',
        email: `guest2-${TS}@homegohan.test`,
        subject: `${MARK} 機能要望 (解決済み)`,
        message: 'ダークモードが欲しいです',
        status: 'resolved',
        resolved_at: new Date(base - 5000).toISOString(),
        created_at: new Date(base - 2000).toISOString(),
      },
    ])
    .select('id, subject');
  if (error || !data || data.length !== 3) throw new Error(`seed inquiries: ${error?.message}`);
  createdInquiryIds.push(...data.map((r) => r.id as string));
  const idOf = (needle: string) => data.find((r) => (r.subject as string).includes(needle))!.id as string;
  seeded = {
    guestPending: idOf('未対応'),
    customerInProgress: idOf('対応中'),
    guestResolved: idOf('解決済み'),
  };

  await warmup;
}, 120_000);

afterAll(async () => {
  // 監査ログは actor_id が SET NULL になる前に消す
  if (createdUserIds.length > 0) {
    await srAdmin.from('admin_audit_logs').delete().in('actor_id', createdUserIds);
  }
  if (createdInquiryIds.length > 0) {
    await srAdmin.from('inquiries').delete().in('id', createdInquiryIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

/** 一覧からこのテストで作った行だけを取り出す */
function ours(list: ListResponse): InquirySummaryDto[] {
  return list.inquiries.filter((i) => i.subject.startsWith(MARK));
}

// ─────────────────────────────────────────────────────────────────────────────
// 認可
// ─────────────────────────────────────────────────────────────────────────────

describe('認可', () => {
  const calls = (id: string): Array<[string, (jwt: string | null) => ReturnType<typeof apiCall>]> => [
    ['GET 一覧', (jwt) => apiCall('GET', '/api/admin/inquiries', jwt)],
    ['GET 詳細', (jwt) => apiCall('GET', `/api/admin/inquiries/${id}`, jwt)],
    ['PATCH', (jwt) => apiCall('PATCH', `/api/admin/inquiries/${id}`, jwt, { status: 'closed', adminNotes: 'NG' })],
    ['PUT', (jwt) => apiCall('PUT', `/api/admin/inquiries/${id}`, jwt, { status: 'closed', adminNotes: 'NG' })],
  ];

  it('未ログインは 401 (一覧・詳細・PATCH・PUT)', async () => {
    for (const [label, call] of calls(seeded.guestPending)) {
      const res = await call(null);
      expect(res.status, label).toBe(401);
      expect((res.body as ErrorResponse).error.code, label).toBe('AUTH_UNAUTHENTICATED');
    }
    const noAuth = await apiCallNoAuth('GET', '/api/admin/inquiries');
    expect(noAuth.status).toBe(401);
  });

  it.each([
    ['一般ユーザー', () => general],
    ['sales', () => sales],
    ['問い合わせをした本人 (一般ユーザー)', () => customer],
  ])('%s は 403 で、何も書き換わらず、監査ログも残らない', async (_label, who) => {
    for (const [label, call] of calls(seeded.customerInProgress)) {
      const res = await call(who().jwt);
      expect(res.status, label).toBe(403);
      expect((res.body as ErrorResponse).error.code, label).toBe('OP_PERMISSION_DENIED');
    }
    const row = await dbRow(seeded.customerInProgress);
    expect(row.status).toBe('in_progress');
    expect(row.admin_notes).toBe('調査中');
    expect(await auditRows(who().id, 'admin.inquiry.update')).toEqual([]);
    expect(await auditRows(who().id, 'admin.inquiry.view')).toEqual([]);
  });

  it.each([
    ['support', () => support],
    ['admin', () => admin],
    ['super_admin', () => superAdmin],
  ])('%s は一覧と詳細を読める', async (_label, who) => {
    const list = await apiCall<ListResponse>('GET', '/api/admin/inquiries?limit=100', who().jwt);
    expect(list.status).toBe(200);
    expect(ours(list.body)).toHaveLength(3);

    const detail = await apiCall<{ inquiry: InquiryDto }>(
      'GET',
      `/api/admin/inquiries/${seeded.guestPending}`,
      who().jwt,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.inquiry.id).toBe(seeded.guestPending);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 一覧
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/inquiries', () => {
  it('新しい順に、画面が読む camelCase の概要で返す (本文と管理者メモは詳細でだけ返す)', async () => {
    const res = await apiCall<ListResponse>('GET', '/api/admin/inquiries?limit=100', support.jwt);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');

    const mine = ours(res.body);
    expect(mine.map((i) => i.id)).toEqual([seeded.guestPending, seeded.customerInProgress, seeded.guestResolved]);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(100);
    expect(res.body.total).toBeGreaterThanOrEqual(3);

    for (const item of mine) {
      expect(Object.keys(item).sort()).toEqual(SUMMARY_KEYS);
    }
    expect(mine[0]).toMatchObject({
      userId: null,
      userName: null,
      inquiryType: 'general',
      email: `guest-${TS}@homegohan.test`,
      status: 'pending',
      resolvedAt: null,
    });
    // 本文・管理者メモの中身そのものも、一覧の応答には出ない
    const serialized = JSON.stringify(mine);
    for (const value of ['使い方を教えてください', '画面が真っ白', 'ダークモード', '調査中']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('会員の問い合わせにはニックネームを userName として付ける (RLS で読めない他人の user_profiles を service role で解決)', async () => {
    const res = await apiCall<ListResponse>('GET', '/api/admin/inquiries?limit=100', support.jwt);
    const member = ours(res.body).find((i) => i.id === seeded.customerInProgress)!;
    expect(member.userId).toBe(customer.id);
    expect(member.userName).toBe(customer.nickname);
    expect(member.email).toBe(`customer-${TS}@homegohan.test`);
  });

  it.each([
    ['pending', 'guestPending'],
    ['in_progress', 'customerInProgress'],
    ['resolved', 'guestResolved'],
  ] as const)('status=%s で絞り込める', async (status, key) => {
    const res = await apiCall<ListResponse>('GET', `/api/admin/inquiries?status=${status}&limit=100`, support.jwt);
    expect(res.status).toBe(200);
    expect(res.body.inquiries.every((i) => i.status === status)).toBe(true);
    expect(ours(res.body).map((i) => i.id)).toEqual([seeded[key]]);
  });

  it('status が不正なら 400', async () => {
    const res = await apiCall<ErrorResponse>('GET', '/api/admin/inquiries?status=done', support.jwt);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('limit と page でページを切れる', async () => {
    const first = await apiCall<ListResponse>('GET', '/api/admin/inquiries?limit=1&page=1', support.jwt);
    const second = await apiCall<ListResponse>('GET', '/api/admin/inquiries?limit=1&page=2', support.jwt);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.inquiries).toHaveLength(1);
    expect(second.body.inquiries).toHaveLength(1);
    expect(first.body.inquiries[0].id).not.toBe(second.body.inquiries[0].id);
    expect(second.body.page).toBe(2);
    expect(second.body.total).toBeGreaterThanOrEqual(3);
  });

  it('範囲外の値 (limit=99999 / limit=abc / page=0) は丸める。500 にならない', async () => {
    const big = await apiCall<ListResponse>('GET', '/api/admin/inquiries?limit=99999', support.jwt);
    expect(big.status).toBe(200);
    expect(big.body.limit).toBe(100);
    expect(big.body.inquiries.length).toBeLessThanOrEqual(100);

    const junk = await apiCall<ListResponse>('GET', '/api/admin/inquiries?limit=abc&page=0', support.jwt);
    expect(junk.status).toBe(200);
    expect(junk.body.limit).toBe(50);
    expect(junk.body.page).toBe(1);
  });

  it('件数より後ろのページ (PostgREST は 416) でも、エラーにせず空のページを返す', async () => {
    const res = await apiCall<ListResponse>('GET', '/api/admin/inquiries?limit=100&page=10000', support.jwt);
    expect(res.status).toBe(200);
    expect(res.body.inquiries).toEqual([]);
    expect(res.body.total).toBeNull();
    expect(res.body.page).toBe(10000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 詳細
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/inquiries/[id]', () => {
  it('{ inquiry } を返す (本文と管理者メモを含む)。会員は userName 付き', async () => {
    const res = await apiCall<{ inquiry: InquiryDto }>(
      'GET',
      `/api/admin/inquiries/${seeded.customerInProgress}`,
      support.jwt,
    );
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(Object.keys(res.body.inquiry).sort()).toEqual(DETAIL_KEYS);
    expect(res.body.inquiry).toMatchObject({
      id: seeded.customerInProgress,
      userId: customer.id,
      userName: customer.nickname,
      inquiryType: 'bug',
      email: `customer-${TS}@homegohan.test`,
      message: '画面が真っ白になります',
      status: 'in_progress',
      adminNotes: '調査中',
      resolvedAt: null,
    });
  });

  it('存在しない id は 404、UUID でない id は 400', async () => {
    const missing = await apiCall<ErrorResponse>('GET', '/api/admin/inquiries/00000000-0000-4000-8000-000000000000', support.jwt);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const bad = await apiCall<ErrorResponse>('GET', '/api/admin/inquiries/not-a-uuid', support.jwt);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 更新 (上から順に、同じ行の状態を進める)
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH / PUT /api/admin/inquiries/[id]', () => {
  const path = () => `/api/admin/inquiries/${seeded.guestPending}`;
  let firstResolvedAt: string;

  it('support が PATCH でステータスとメモを更新できる (モバイルの呼び方)', async () => {
    const res = await apiCall<{ inquiry: InquiryDto }>('PATCH', path(), support.jwt, {
      status: 'in_progress',
      adminNotes: '確認中です',
    });
    expect(res.status).toBe(200);
    expect(res.body.inquiry).toMatchObject({ id: seeded.guestPending, status: 'in_progress', adminNotes: '確認中です', resolvedAt: null });

    const row = await dbRow(seeded.guestPending);
    expect(row).toMatchObject({ status: 'in_progress', admin_notes: '確認中です', resolved_at: null });
  });

  it('admin が PUT で解決済みにすると resolved_at が入る (Web の呼び方)。メモは消えない', async () => {
    const res = await apiCall<{ inquiry: InquiryDto }>('PUT', path(), admin.jwt, { status: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.body.inquiry.status).toBe('resolved');
    expect(res.body.inquiry.adminNotes).toBe('確認中です');
    expect(res.body.inquiry.resolvedAt).not.toBeNull();
    firstResolvedAt = res.body.inquiry.resolvedAt!;

    const row = await dbRow(seeded.guestPending);
    expect(new Date(row.resolved_at as string).getTime()).toBe(new Date(firstResolvedAt).getTime());
    // updated_at はトリガーで進む
    expect(new Date(row.updated_at as string).getTime()).toBeGreaterThan(new Date(row.created_at as string).getTime());
  });

  it('super_admin が完了 (closed) にしても、最初に解決した時刻のまま', async () => {
    const res = await apiCall<{ inquiry: InquiryDto }>('PATCH', path(), superAdmin.jwt, { status: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.inquiry.status).toBe('closed');
    expect(new Date(res.body.inquiry.resolvedAt!).getTime()).toBe(new Date(firstResolvedAt).getTime());
  });

  it('メモだけの更新では、ステータスと resolved_at に触れない', async () => {
    const res = await apiCall<{ inquiry: InquiryDto }>('PATCH', path(), support.jwt, { adminNotes: '追記: 回答済み' });
    expect(res.status).toBe(200);
    expect(res.body.inquiry.status).toBe('closed');
    expect(res.body.inquiry.adminNotes).toBe('追記: 回答済み');
    expect(new Date(res.body.inquiry.resolvedAt!).getTime()).toBe(new Date(firstResolvedAt).getTime());
  });

  it('再オープン (pending) すると resolved_at が null に戻る', async () => {
    const res = await apiCall<{ inquiry: InquiryDto }>('PATCH', path(), support.jwt, { status: 'pending' });
    expect(res.status).toBe(200);
    expect(res.body.inquiry.resolvedAt).toBeNull();
    expect((await dbRow(seeded.guestPending)).resolved_at).toBeNull();
  });

  it('メモを空にすると消える (null)', async () => {
    const res = await apiCall<{ inquiry: InquiryDto }>('PATCH', path(), support.jwt, { adminNotes: '' });
    expect(res.status).toBe(200);
    expect(res.body.inquiry.adminNotes).toBeNull();
    expect((await dbRow(seeded.guestPending)).admin_notes).toBeNull();
  });

  it('本文・メールアドレス・問い合わせ者などをボディに入れても書き換わらない (ステータスは実際に変える)', async () => {
    // guestResolved (resolved → closed) で、書き込み経路を通しながら余計なキーが無視されることを確かめる
    const before = await dbRow(seeded.guestResolved);
    const res = await apiCall<{ inquiry: InquiryDto }>('PATCH', `/api/admin/inquiries/${seeded.guestResolved}`, support.jwt, {
      status: 'closed',
      email: 'attacker@homegohan.test',
      message: '書き換え',
      subject: '書き換え',
      user_id: general.id,
      userId: general.id,
      inquiry_type: 'bug',
      inquiryType: 'bug',
      resolved_at: '2000-01-01T00:00:00.000Z',
      resolvedAt: '2000-01-01T00:00:00.000Z',
      created_at: '2000-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.inquiry.status).toBe('closed');

    const after = await dbRow(seeded.guestResolved);
    expect(after.status).toBe('closed');
    expect(after).toMatchObject({
      email: before.email,
      message: before.message,
      subject: before.subject,
      user_id: null,
      inquiry_type: before.inquiry_type,
      created_at: before.created_at,
    });
    // 解決済み → 完了では元の解決時刻のまま (ボディの resolved_at は無視される)
    expect(new Date(after.resolved_at as string).getTime()).toBe(new Date(before.resolved_at as string).getTime());
  });

  it('不正なボディは 400、存在しない id は 404、UUID でない id は 400。何も書き換わらない', async () => {
    const before = await dbRow(seeded.guestResolved);
    const target = `/api/admin/inquiries/${seeded.guestResolved}`;

    for (const body of [{ status: 'done' }, {}, { adminNotes: 'あ'.repeat(5001) }, { adminNotes: 1 }]) {
      const res = await apiCall<ErrorResponse>('PATCH', target, support.jwt, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    const notJson = await fetch(`${BASE_URL}${target}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${support.jwt}` },
      body: '{not json',
    });
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as ErrorResponse).error.code).toBe('INVALID_JSON');

    const missing = await apiCall<ErrorResponse>('PATCH', '/api/admin/inquiries/00000000-0000-4000-8000-000000000000', support.jwt, { status: 'closed' });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const badId = await apiCall<ErrorResponse>('PATCH', '/api/admin/inquiries/not-a-uuid', support.jwt, { status: 'closed' });
    expect(badId.status).toBe(400);

    expect(await dbRow(seeded.guestResolved)).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 同時の更新 (条件つきの更新。監査の status_from と resolved_at を取り違えない)
// ─────────────────────────────────────────────────────────────────────────────

describe('同時の更新', () => {
  /** このブロック専用の問い合わせを作る (ほかのテストの行の状態に依らない) */
  async function createInquiry(label: string): Promise<string> {
    const { data, error } = await srAdmin
      .from('inquiries')
      .insert({
        user_id: null,
        inquiry_type: 'general',
        email: `race-${label}-${TS}@homegohan.test`,
        subject: `${MARK} 同時の更新 ${label}`,
        message: '同時の更新の確認',
        status: 'pending',
      })
      .select('id')
      .single();
    if (error || !data) throw new Error(`seed inquiries (${label}): ${error?.message}`);
    createdInquiryIds.push(data.id as string);
    return data.id as string;
  }

  it('route が条件に使う updated_at は、PostgREST が返した文字列で一致し (秒未満まで)、別の更新で進んだあとは 0 行になる', async () => {
    const id = await createInquiry('stale');
    const supportClient = client(anonKey, support.jwt);
    const first = await supportClient.from('inquiries').select('status, updated_at').eq('id', id).single();
    expect(first.error).toBeNull();
    const staleUpdatedAt = first.data!.updated_at as string;

    // 別の運営の更新 (API 経由)。updated_at はトリガーで進む
    const res = await apiCall<{ inquiry: InquiryDto }>('PUT', `/api/admin/inquiries/${id}`, admin.jwt, { status: 'in_progress' });
    expect(res.status).toBe(200);

    // 古い updated_at を条件にした更新は 0 行 (route の 409 の元)。route と同じく service_role の client で書く
    // (運営の UPDATE のポリシーは消した。20261025100000・#1917 の続き)
    const stale = await srAdmin
      .from('inquiries')
      .update({ status: 'resolved' })
      .eq('id', id)
      .eq('status', 'pending')
      .eq('updated_at', staleUpdatedAt)
      .select('id');
    expect(stale.error).toBeNull();
    expect(stale.data).toEqual([]);

    // 読み直した updated_at の文字列そのままなら一致する (秒未満が丸められて毎回 0 行にならない)
    const current = await supportClient.from('inquiries').select('status, updated_at').eq('id', id).single();
    const fresh = await srAdmin
      .from('inquiries')
      .update({ admin_notes: '条件つきの更新' })
      .eq('id', id)
      .eq('status', current.data!.status as string)
      .eq('updated_at', current.data!.updated_at as string)
      .select('id');
    expect(fresh.error).toBeNull();
    expect(fresh.data).toHaveLength(1);
  });

  it('運営 3 人が同時にステータスを変えても、応答は 200 か 409 CONFLICT_STALE_DATA だけで、監査の status_from は実際の直前の値とつながる', async () => {
    const id = await createInquiry('parallel');
    const operators = [support, admin, superAdmin];
    const targets = ['in_progress', 'resolved', 'closed', 'pending', 'resolved', 'in_progress'] as const;

    const responses = await Promise.all(
      targets.map((status, i) =>
        apiCall<{ inquiry?: InquiryDto; error?: { code: string } }>(
          'PUT',
          `/api/admin/inquiries/${id}`,
          operators[i % operators.length].jwt,
          { status },
        ),
      ),
    );
    for (const res of responses) {
      expect([200, 409]).toContain(res.status);
      if (res.status === 409) expect(res.body.error?.code).toBe('CONFLICT_STALE_DATA');
    }
    expect(responses.some((r) => r.status === 200)).toBe(true);

    const { data: logs, error } = await srAdmin
      .from('admin_audit_logs')
      .select('details')
      .eq('action_type', 'admin.inquiry.update')
      .eq('target_id', id);
    expect(error).toBeNull();
    // 監査は 200 の応答と同じ数だけ (409 は記録しない)
    expect(logs ?? []).toHaveLength(responses.filter((r) => r.status === 200).length);

    // 実際に書いた更新 (changed) の from → to は、pending から今の status への 1 本の道になる。
    // 条件なしで古い current を使うと、同じ from から 2 本出る (例: pending → in_progress と pending → resolved) ので、出入りの数が合わない
    const edges = (logs ?? [])
      .map((l) => l.details as { status_from: string; status_to: string; changed: boolean })
      .filter((d) => d.changed && d.status_from !== d.status_to);
    const finalRow = await dbRow(id);
    const balance = new Map<string, number>();
    for (const e of edges) {
      balance.set(e.status_from, (balance.get(e.status_from) ?? 0) + 1);
      balance.set(e.status_to, (balance.get(e.status_to) ?? 0) - 1);
    }
    const start = 'pending';
    const end = finalRow.status as string;
    if (start !== end) {
      expect(balance.get(start), `pending から出る更新 (${JSON.stringify(edges)})`).toBe(1);
      expect(balance.get(end), `${end} に入る更新 (${JSON.stringify(edges)})`).toBe(-1);
    }
    for (const [status, net] of balance) {
      const expected = start === end ? 0 : status === start ? 1 : status === end ? -1 : 0;
      expect(net, `${status} の出入り (${JSON.stringify(edges)})`).toBe(expected);
    }

    // resolved_at は今の status に合う (解決済み・完了なら入り、それ以外は null)
    if (end === 'resolved' || end === 'closed') {
      expect(finalRow.resolved_at).not.toBeNull();
    } else {
      expect(finalRow.resolved_at).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 監査ログ
// ─────────────────────────────────────────────────────────────────────────────

describe('監査ログ (admin_audit_logs)', () => {
  it('更新を admin.inquiry.update として記録する。ゲストの問い合わせは問い合わせそのものが対象。メモの中身は入れない', async () => {
    const rows = await auditRows(support.id, 'admin.inquiry.update', seeded.guestPending);
    // ここまでに support が guestPending に行った更新: in_progress / 追記 / pending / メモ削除
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.target_type).toBe('inquiry');
      expect(row.severity).toBe('info');
      expect(Object.keys(row.details as object).sort()).toEqual([
        'admin_notes_changed',
        'changed',
        'inquiry_id',
        'status_from',
        'status_to',
      ]);
      expect((row.details as { inquiry_id: string }).inquiry_id).toBe(seeded.guestPending);
    }
    const first = rows.find((r) => (r.details as { status_to: string }).status_to === 'in_progress');
    expect(first?.details).toEqual({
      inquiry_id: seeded.guestPending,
      status_from: 'pending',
      status_to: 'in_progress',
      admin_notes_changed: true,
      changed: true,
    });
    expect(JSON.stringify(rows)).not.toContain('確認中です');
    expect(JSON.stringify(rows)).not.toContain('追記: 回答済み');
  });

  it('会員の問い合わせの更新は会員 (user) が対象。変更が無い更新も、本文を返すので記録する (行は書き換えない)', async () => {
    const before = await dbRow(seeded.customerInProgress);
    const rowsBefore = await auditRows(support.id, 'admin.inquiry.update', customer.id);

    const res = await apiCall<{ inquiry: InquiryDto }>(
      'PATCH',
      `/api/admin/inquiries/${seeded.customerInProgress}`,
      support.jwt,
      { status: 'in_progress', adminNotes: '調査中' },
    );
    expect(res.status).toBe(200);
    expect(res.body.inquiry.message).toBe('画面が真っ白になります');

    // 行は動かない (updated_at もトリガーで進まない)
    expect(await dbRow(seeded.customerInProgress)).toEqual(before);

    const rows = await auditRows(support.id, 'admin.inquiry.update', customer.id);
    expect(rows).toHaveLength(rowsBefore.length + 1);
    expect(rows.find((r) => (r.details as { changed: boolean }).changed === false)).toMatchObject({
      target_type: 'user',
      severity: 'info',
      details: {
        inquiry_id: seeded.customerInProgress,
        status_from: 'in_progress',
        status_to: 'in_progress',
        admin_notes_changed: false,
        changed: false,
      },
    });
  });

  it('詳細の閲覧を admin.inquiry.view として記録する。会員は本人 (user) が対象で、複数ホップの x-forwarded-for でも inet 列に入る', async () => {
    const detail = await fetch(`${BASE_URL}/api/admin/inquiries/${seeded.customerInProgress}`, {
      headers: { Authorization: `Bearer ${support.jwt}`, 'x-forwarded-for': '203.0.113.50, 10.1.1.1' },
    });
    expect(detail.status).toBe(200);

    // これより前のテストでも support が詳細を開いているので、送った IP で見分ける
    const views = await auditRows(support.id, 'admin.inquiry.view', customer.id);
    const viewed = views.find((v) => v.ip_address === '203.0.113.50');
    expect(
      viewed,
      `ip_address が 203.0.113.50 の閲覧記録 (全 ${views.length} 件: ${JSON.stringify(views.map((v) => v.ip_address))})`,
    ).toBeDefined();
    expect(viewed).toMatchObject({ target_type: 'user', severity: 'info' });
    const details = viewed!.details as { inquiry_id: string; viewed_fields: string[] };
    expect(Object.keys(details).sort()).toEqual(['inquiry_id', 'viewed_fields']);
    expect(details.inquiry_id).toBe(seeded.customerInProgress);
    expect([...details.viewed_fields].sort()).toEqual(DETAIL_KEYS);

    // 返した項目名だけを残し、値 (メールアドレス・本文・メモ・ニックネーム) は入れない
    const serialized = JSON.stringify(views);
    for (const value of [`customer-${TS}@homegohan.test`, '画面が真っ白', '調査中', customer.nickname]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('ゲストの問い合わせの閲覧は、問い合わせそのものが対象', async () => {
    const detail = await fetch(`${BASE_URL}/api/admin/inquiries/${seeded.guestResolved}`, {
      headers: { Authorization: `Bearer ${admin.jwt}`, 'x-forwarded-for': '203.0.113.52' },
    });
    expect(detail.status).toBe(200);
    const views = await auditRows(admin.id, 'admin.inquiry.view', seeded.guestResolved);
    const viewed = views.find((v) => v.ip_address === '203.0.113.52');
    expect(viewed).toMatchObject({ target_type: 'inquiry', severity: 'info' });
    expect((viewed!.details as { inquiry_id: string }).inquiry_id).toBe(seeded.guestResolved);
  });

  it('存在しない id の閲覧は、何も返していないので記録しない', async () => {
    const before = (await auditRows(admin.id, 'admin.inquiry.view', '00000000-0000-4000-8000-000000000000')).length;
    const res = await apiCall('GET', '/api/admin/inquiries/00000000-0000-4000-8000-000000000000', admin.jwt);
    expect(res.status).toBe(404);
    expect((await auditRows(admin.id, 'admin.inquiry.view', '00000000-0000-4000-8000-000000000000')).length).toBe(before);
  });

  it('一覧は本文を返さないので記録しない', async () => {
    const countOfAdmin = async () => {
      const { count, error } = await srAdmin
        .from('admin_audit_logs')
        .select('id', { count: 'exact', head: true })
        .eq('actor_id', admin.id);
      if (error) throw new Error(`admin_audit_logs count: ${error.message}`);
      return count ?? 0;
    };
    const before = await countOfAdmin();
    const res = await apiCall<ListResponse>('GET', '/api/admin/inquiries?status=pending&limit=5', admin.jwt);
    expect(res.status).toBe(200);
    expect(await countOfAdmin()).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS (API を通さず、PostgREST を直接叩く)
// ─────────────────────────────────────────────────────────────────────────────

describe('RLS: 直接 PostgREST を叩いても、運営ロール以外は他人の問い合わせを読めず、誰も更新できない', () => {
  it('一般ユーザーは、他人 (会員・ゲスト) の問い合わせを読めない', async () => {
    const { data, error } = await client(anonKey, general.jwt)
      .from('inquiries')
      .select('id')
      .in('id', [seeded.guestPending, seeded.customerInProgress, seeded.guestResolved]);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('一般ユーザーは、問い合わせを更新できない (42501。anon / authenticated は UPDATE の権限を持たない。#1917 の続き)', async () => {
    const before = await dbRow(seeded.guestResolved);
    const { error } = await client(anonKey, general.jwt)
      .from('inquiries')
      .update({ status: 'pending', admin_notes: 'RLS' })
      .eq('id', seeded.guestResolved)
      .select('id');
    expect(error?.code).toBe('42501');
    expect(await dbRow(seeded.guestResolved)).toEqual(before);
  });

  it('support は直接読めるが、直接は書けない (42501。更新は API が requireRole の後で service_role で書く。#1917 の続き)', async () => {
    const supportClient = client(anonKey, support.jwt);
    const read = await supportClient.from('inquiries').select('id').eq('id', seeded.guestResolved);
    expect(read.error).toBeNull();
    expect(read.data).toHaveLength(1);

    const before = await dbRow(seeded.guestResolved);
    const update = await supportClient.from('inquiries').update({ admin_notes: 'RLS 確認' }).eq('id', seeded.guestResolved).select('id');
    expect(update.error?.code).toBe('42501');
    expect(await dbRow(seeded.guestResolved)).toEqual(before);
  });

  it('他人の user_profiles は一般ユーザー・support のセッションでは読めない (だから ニックネームの解決に service role が要る)', async () => {
    const asSupport = await client(anonKey, support.jwt).from('user_profiles').select('id, nickname').eq('id', customer.id);
    expect(asSupport.error).toBeNull();
    expect(asSupport.data).toEqual([]);
  });
});
