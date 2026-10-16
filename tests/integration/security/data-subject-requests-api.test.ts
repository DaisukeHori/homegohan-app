/**
 * #1178 / #1702 個人情報の請求 (開示・訂正・利用停止・消去。DSR) の API の結合テスト (実 DB + 実 route + 実 RLS)
 *   設計: docs/design/cross/15-data-subject-requests.md §15 の `tests/integration/security/data-subject-requests-api.test.ts` の行
 *
 * 単体テスト (tests/api/account-data-requests-route.test.ts・tests/admin-data-requests-route.test.ts) は Supabase を偽物に
 * 置き換えているため、ここでは本物の認証・PostgREST・RLS・列の GRANT・監査ログ (inet 列) を通して次を確かめる。
 *
 *   - 本人: create (201・pending_verification・hash を返さない) → verify (200・received) → 一覧に received と due_at
 *   - 他人の id は 404 (詳細・取り下げ。他人の行は書き換わらない)
 *   - roles に admin を持つ本人 (運営ロール) でも、本人向けの一覧は自分の行だけ・他人の id の詳細は 404。
 *     同じ利用者が本人のセッションの client で表を直接読むと他人の行が見える (= RLS は運営に全行を見せるので、
 *     route の `.eq('user_id', 本人)` が絞っている) ことも同じ it で確かめる
 *   - 本人の GET の応答に admin_notes (と verification_token_hash) が無い (運営が admin_notes を書いた後でも)
 *   - 運営: support は 403・admin / super_admin は 200・詳細に admin_notes が出る・PATCH の 412 (古い If-Unmodified-Since)
 *   - 監査ログの inet 列: x-forwarded-for が複数ホップでも先頭の IP が ip_address に入り、user_agent も残る
 *
 * 本人確認のトークン: 生のトークンはメールにだけ入り、DB には sha256 だけが残る (tokens.ts)。確認のメールは秘密を含む文面として
 * 送信の後に本文と件名が伏せられる (#1785) ので、メールからトークンを読まない。作った請求の hash を、テストが知っている
 * トークンの hash に service_role で置き換えてから verify を呼ぶ (書き込みの口は service_role だけ。設計 §4.3)。
 *
 * 後片付け: service_role にも DELETE が無いので、作った請求の行は消さない。ユーザーの削除で user_id = NULL になって残る
 * (退会と同じ。部分一意索引は user_id が NULL の行を数えない)。監査ログは actor_id が SET NULL になる前に消す。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/data-subject-requests-api.test.ts
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { apiCallNoAuth } from '../helpers/api';
import { signInForIntegration } from '../helpers/mfa';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';
import {
  DSR_ACCOUNT_API_PATH,
  DSR_ADMIN_API_PATH,
  DSR_AUDIT_ACTIONS,
  DSR_OWN_COLUMNS,
  computeDsrDueAt,
  resolveDsrResponseDueDays,
  type DsrAdminDetailDto,
  type DsrAdminSummaryDto,
  type DsrOwnDto,
} from '@/lib/data-subject-requests/core';
import { DSR_TOKEN_BYTES, hashDsrVerificationToken } from '@/lib/data-subject-requests/tokens';

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

const TABLE = 'data_subject_requests';
/** 存在しない請求の id (UUID の形だけ正しい。warmup と 404 の確かめに使う) */
const MISSING_ID = '00000000-0000-4000-8000-000000000000';
/** 監査ログの x-forwarded-for (複数ホップ)。先頭が利用者の IP として ip_address に入る (src/lib/admin/client-ip.ts) */
const VIEW_CLIENT_IP = '203.0.113.71';
const UPDATE_CLIENT_IP = '203.0.113.72';
const LIST_CLIENT_IP = '203.0.113.73';
const PROXY_HOP_IP = '10.17.2.1';
const TEST_USER_AGENT = 'i1702-dsr-integration';
/** 運営の一覧で、このテストの行を探すときの 1 ページの件数 (DSR_ADMIN_LIST_LIMITS.max と同じ上限) */
const ADMIN_LIST_PER_PAGE = 100;
/** 1 日のミリ秒 (応答期限 = 受付 + 日数) */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_PRECONDITION_FAILED = 412;

const TS = Date.now();
const MARK = `i1702-${TS}`;

interface TestUser {
  id: string;
  jwt: string;
}

type DsrOwnBody = { request?: DsrOwnDto; error?: string; code?: string };
type DsrOwnListBody = { requests?: DsrOwnDto[]; error?: string; code?: string };
type DsrAdminDetailBody = { data?: DsrAdminDetailDto; error?: { code: string; message: string } };
type DsrAdminListBody = {
  data?: DsrAdminSummaryDto[];
  meta?: { total: number | null; page: number; per_page: number };
  error?: { code: string; message: string };
};

interface HttpResult<T> {
  status: number;
  body: T;
}

/** 実 route を HTTP で呼ぶ (Bearer JWT。監査の確かめに x-forwarded-for / user-agent / If-Unmodified-Since を付けられる) */
async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  jwt: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const body = (contentType.includes('application/json') ? await res.json() : await res.text()) as T;
  return { status: res.status, body };
}

const createdUserIds: string[] = [];

/** テストユーザーを作り (roles は service role で入れる)、サインインして JWT を得る。必須ロールなら TOTP で aal2 にする (#1176) */
async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `sec-dsr-${label}-${TS}@homegohan.test`;
  // テスト用ユーザーのパスワードは固定値を置かず、実行ごとに作る
  const password = `Aa1!${randomUUID()}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db
      .from('user_profiles')
      .upsert({ id: data.user.id, nickname: `dsr-${label}-${TS}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' }),
  );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  const jwt = await signInForIntegration({ email, password, roles });
  return { id: data.user.id, jwt };
}

/** 本人の API で請求を出し、テストが知っているトークンの hash に置き換えてから verify する (received にする) */
async function createAndVerify(user: TestUser, details: string): Promise<DsrOwnDto> {
  const created = await call<DsrOwnBody>('POST', DSR_ACCOUNT_API_PATH, user.jwt, {
    body: { request_type: 'disclosure', details },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(HTTP_CREATED);
  const id = created.body.request!.id;

  const token = randomBytes(DSR_TOKEN_BYTES).toString('hex');
  const { data: replaced, error } = await srAdmin
    .from(TABLE)
    .update({ verification_token_hash: hashDsrVerificationToken(token) })
    .eq('id', id)
    .eq('status', 'pending_verification')
    .select('id');
  if (error || replaced?.length !== 1) throw new Error(`hash の置き換え ${id}: ${error?.message ?? `${replaced?.length} 行`}`);

  const verified = await call<DsrOwnBody>('POST', `${DSR_ACCOUNT_API_PATH}/${id}/verify`, user.jwt, { body: { token } });
  expect(verified.status, JSON.stringify(verified.body)).toBe(HTTP_OK);
  return verified.body.request!;
}

/** service_role で行の全列を読む (書き換わっていないことの確かめ) */
async function dbRow(id: string): Promise<Record<string, unknown>> {
  const { data, error } = await srAdmin.from(TABLE).select('*').eq('id', id).single();
  if (error) throw new Error(`${TABLE} ${id}: ${error.message}`);
  return data as Record<string, unknown>;
}

async function auditRows(actorId: string, actionType: string) {
  const { data, error } = await srAdmin
    .from('admin_audit_logs')
    .select('actor_id, action_type, target_id, target_type, details, severity, ip_address, user_agent')
    .eq('actor_id', actorId)
    .eq('action_type', actionType);
  if (error) throw new Error(`admin_audit_logs: ${error.message}`);
  return data ?? [];
}

/** 運営の一覧を全ページたどって、指定の id の行を探す (他のテストの行が先のページに並んでいても見つける) */
async function findInAdminList(jwt: string, id: string, query: string): Promise<DsrAdminSummaryDto | undefined> {
  for (let page = 1; ; page += 1) {
    const res = await call<DsrAdminListBody>(
      'GET',
      `${DSR_ADMIN_API_PATH}?${query}&per_page=${ADMIN_LIST_PER_PAGE}&page=${page}`,
      jwt,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(HTTP_OK);
    const rows = res.body.data ?? [];
    const found = rows.find((row) => row.id === id);
    if (found) return found;
    if (rows.length < ADMIN_LIST_PER_PAGE) return undefined;
  }
}

let requester: TestUser;
let other: TestUser;
let operatorRequester: TestUser;
let support: TestUser;
let admin: TestUser;
let superAdmin: TestUser;
/** requester が出して受け付けた (received) 請求 */
let requesterDsr: DsrOwnDto;
/** other が出した、確認待ち (pending_verification) の請求 */
let otherPendingId: string;

beforeAll(async () => {
  // dev サーバは route への初回アクセスでコンパイルする。テスト本体の時間切れに含まれないよう、先に叩いておく
  const warmup = Promise.all([
    apiCallNoAuth('GET', DSR_ACCOUNT_API_PATH),
    apiCallNoAuth('GET', `${DSR_ACCOUNT_API_PATH}/${MISSING_ID}`),
    apiCallNoAuth('POST', `${DSR_ACCOUNT_API_PATH}/${MISSING_ID}/verify`, { token: 'x' }),
    apiCallNoAuth('POST', `${DSR_ACCOUNT_API_PATH}/${MISSING_ID}/withdraw`),
    apiCallNoAuth('GET', DSR_ADMIN_API_PATH),
    apiCallNoAuth('GET', `${DSR_ADMIN_API_PATH}/${MISSING_ID}`),
  ]);
  warmup.catch(() => undefined); // 先に別の準備で失敗したときに、未処理の拒否として報告されないように

  [requester, other, operatorRequester, support, admin, superAdmin] = await Promise.all([
    createUser('requester', ['user']),
    createUser('other', ['user']),
    createUser('operator-requester', ['admin']),
    createUser('support', ['support']),
    createUser('admin', ['admin']),
    createUser('super-admin', ['super_admin']),
  ]);
  await warmup;

  requesterDsr = await createAndVerify(requester, `${MARK} 本人の開示の請求`);

  const pending = await call<DsrOwnBody>('POST', DSR_ACCOUNT_API_PATH, other.jwt, {
    body: { request_type: 'correction', details: `${MARK} 他人の訂正の請求` },
  });
  expect(pending.status, JSON.stringify(pending.body)).toBe(HTTP_CREATED);
  otherPendingId = pending.body.request!.id;
}, 240_000);

afterAll(async () => {
  // 監査ログは actor_id が SET NULL になる前に消す
  if (createdUserIds.length > 0) {
    await srAdmin.from('admin_audit_logs').delete().in('actor_id', createdUserIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.from('user_profiles').delete().eq('id', id);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────
// 本人の経路
// ─────────────────────────────────────────────────────────────────────────────

describe('本人: create → verify → received', () => {
  it('作成は 201 で pending_verification・hash を返さない。verify で received と due_at が付き、一覧に出る', async () => {
    const created = await call<DsrOwnBody>('POST', DSR_ACCOUNT_API_PATH, requester.jwt, {
      body: { request_type: 'erasure', details: `${MARK} 消去の請求` },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(HTTP_CREATED);
    const request = created.body.request!;
    expect(request.status).toBe('pending_verification');
    expect(request.request_type).toBe('erasure');
    expect(request.verification_send_count).toBe(1);
    expect(request.verified_at).toBeNull();
    expect(request.due_at).toBeNull();
    expect(request).not.toHaveProperty('verification_token_hash');
    expect(request).not.toHaveProperty('admin_notes');
    expect(request).not.toHaveProperty('user_id');
    // DB には hash だけが入っている (64 桁の 16 進)
    const stored = await dbRow(request.id);
    expect(stored.user_id).toBe(requester.id);
    expect(stored.verification_token_hash).toMatch(/^[0-9a-f]{64}$/);

    // 前もって受け付けた開示の請求 (beforeAll の createAndVerify) は received で due_at が付いている
    expect(requesterDsr.status).toBe('received');
    expect(requesterDsr.verified_at).not.toBeNull();
    const dueDays = resolveDsrResponseDueDays(process.env.DSR_RESPONSE_DUE_DAYS);
    expect(new Date(requesterDsr.due_at!).getTime()).toBe(
      computeDsrDueAt(new Date(requesterDsr.verified_at!), dueDays).getTime(),
    );
    expect(new Date(requesterDsr.due_at!).getTime() - new Date(requesterDsr.verified_at!).getTime()).toBe(
      dueDays * MS_PER_DAY,
    );
    const verifiedRow = await dbRow(requesterDsr.id);
    expect(verifiedRow.status).toBe('received');
    expect(verifiedRow.verification_token_hash).toBeNull();

    const list = await call<DsrOwnListBody>('GET', DSR_ACCOUNT_API_PATH, requester.jwt);
    expect(list.status, JSON.stringify(list.body)).toBe(HTTP_OK);
    const requests = list.body.requests!;
    const listed = requests.find((r) => r.id === requesterDsr.id);
    expect(listed?.status).toBe('received');
    expect(listed?.due_at).toBe(requesterDsr.due_at);
    expect(requests.map((r) => r.id)).toEqual(expect.arrayContaining([requesterDsr.id, request.id]));
    // 自分の行だけ (他人の確認待ちの請求は出ない)
    expect(requests.map((r) => r.id)).not.toContain(otherPendingId);
  });

  it('他人の id は 404 (詳細・verify・取り下げ)。他人の行は書き換わらない', async () => {
    const before = await dbRow(otherPendingId);

    const detail = await call<DsrOwnBody>('GET', `${DSR_ACCOUNT_API_PATH}/${otherPendingId}`, requester.jwt);
    expect(detail.status).toBe(HTTP_NOT_FOUND);
    expect(detail.body.code).toBe('NOT_FOUND');
    expect(detail.body).not.toHaveProperty('request');

    const verify = await call<DsrOwnBody>('POST', `${DSR_ACCOUNT_API_PATH}/${otherPendingId}/verify`, requester.jwt, {
      body: { token: randomBytes(DSR_TOKEN_BYTES).toString('hex') },
    });
    expect(verify.status).toBe(HTTP_NOT_FOUND);
    expect(verify.body.code).toBe('NOT_FOUND');

    const withdraw = await call<DsrOwnBody>('POST', `${DSR_ACCOUNT_API_PATH}/${otherPendingId}/withdraw`, requester.jwt);
    expect(withdraw.status).toBe(HTTP_NOT_FOUND);
    expect(withdraw.body.code).toBe('NOT_FOUND');

    const after = await dbRow(otherPendingId);
    expect(after).toEqual(before);
    expect(after.status).toBe('pending_verification');

    // 持ち主の本人には見える (404 は「他人の行」だからで、行が無いからではない)
    const own = await call<DsrOwnBody>('GET', `${DSR_ACCOUNT_API_PATH}/${otherPendingId}`, other.jwt);
    expect(own.status).toBe(HTTP_OK);
    expect(own.body.request?.id).toBe(otherPendingId);
  });

  it('roles に admin を持つ本人でも、本人向けの一覧は自分の行だけ・他人の id の詳細は 404 (RLS は全行を見せるが route が本人で絞る)', async () => {
    const own = await call<DsrOwnBody>('POST', DSR_ACCOUNT_API_PATH, operatorRequester.jwt, {
      body: { request_type: 'suspension', details: `${MARK} 運営ロールの本人の利用停止の請求` },
    });
    expect(own.status, JSON.stringify(own.body)).toBe(HTTP_CREATED);
    const ownId = own.body.request!.id;

    // 同じ利用者が本人のセッションの client で表を直接読むと、他人の行も見える (select_operator の RLS)
    const direct = await client(anonKey, operatorRequester.jwt)
      .from(TABLE)
      .select(DSR_OWN_COLUMNS)
      .in('id', [requesterDsr.id, otherPendingId, ownId]);
    expect(direct.error).toBeNull();
    expect((direct.data ?? []).map((row) => row.id).sort()).toEqual(
      [requesterDsr.id, otherPendingId, ownId].sort(),
    );

    // 本人向けの一覧は自分の行だけ
    const list = await call<DsrOwnListBody>('GET', DSR_ACCOUNT_API_PATH, operatorRequester.jwt);
    expect(list.status, JSON.stringify(list.body)).toBe(HTTP_OK);
    expect(list.body.requests!.map((r) => r.id)).toEqual([ownId]);

    // 他人の id の詳細は 404。自分の id は 200
    for (const id of [requesterDsr.id, otherPendingId]) {
      const detail = await call<DsrOwnBody>('GET', `${DSR_ACCOUNT_API_PATH}/${id}`, operatorRequester.jwt);
      expect(detail.status, id).toBe(HTTP_NOT_FOUND);
      expect(detail.body.code, id).toBe('NOT_FOUND');
    }
    const ownDetail = await call<DsrOwnBody>('GET', `${DSR_ACCOUNT_API_PATH}/${ownId}`, operatorRequester.jwt);
    expect(ownDetail.status).toBe(HTTP_OK);
    expect(ownDetail.body.request?.id).toBe(ownId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 運営の経路
// ─────────────────────────────────────────────────────────────────────────────

describe('運営: 認可・詳細の admin_notes・PATCH の 412・監査の inet', () => {
  it('support は 403 OP_PERMISSION_DENIED (一覧・詳細・PATCH)。行は書き換わらず、監査ログも残らない', async () => {
    const before = await dbRow(requesterDsr.id);
    const calls: Array<[string, () => Promise<HttpResult<DsrAdminDetailBody>>]> = [
      ['GET 一覧', () => call('GET', DSR_ADMIN_API_PATH, support.jwt)],
      ['GET 詳細', () => call('GET', `${DSR_ADMIN_API_PATH}/${requesterDsr.id}`, support.jwt)],
      [
        'PATCH',
        () =>
          call('PATCH', `${DSR_ADMIN_API_PATH}/${requesterDsr.id}`, support.jwt, {
            body: { admin_notes: `${MARK} support のメモ` },
            headers: { 'If-Unmodified-Since': String(before.updated_at) },
          }),
      ],
    ];
    for (const [label, run] of calls) {
      const res = await run();
      expect(res.status, label).toBe(HTTP_FORBIDDEN);
      expect(res.body.error?.code, label).toBe('OP_PERMISSION_DENIED');
    }
    expect(await dbRow(requesterDsr.id)).toEqual(before);
    for (const action of Object.values(DSR_AUDIT_ACTIONS)) {
      expect(await auditRows(support.id, action), action).toEqual([]);
    }
  });

  it.each([
    ['admin', () => admin],
    ['super_admin', () => superAdmin],
  ])('%s は一覧と詳細を 200 で読める', async (_label, who) => {
    const found = await findInAdminList(who().jwt, requesterDsr.id, 'status=received&request_type=disclosure');
    expect(found?.status).toBe('received');
    expect(found?.user_id).toBe(requester.id);
    expect(found?.due_at).toBe(requesterDsr.due_at);
    // 一覧は概要だけ (内容・応答・内部メモは返さない)
    expect(found).not.toHaveProperty('details');
    expect(found).not.toHaveProperty('admin_notes');

    const detail = await call<DsrAdminDetailBody>('GET', `${DSR_ADMIN_API_PATH}/${requesterDsr.id}`, who().jwt);
    expect(detail.status, JSON.stringify(detail.body)).toBe(HTTP_OK);
    expect(detail.body.data?.id).toBe(requesterDsr.id);
    expect(detail.body.data?.requester?.user_id).toBe(requester.id);
    expect(detail.body.data).toHaveProperty('admin_notes');
    expect(detail.body.data).not.toHaveProperty('verification_token_hash');
  });

  it('詳細に admin_notes が出て、古い If-Unmodified-Since の PATCH は 412。本人の GET には admin_notes が出ない。監査の inet は x-forwarded-for の先頭', async () => {
    const adminNote = `${MARK} 運営の内部メモ (本人には見せない)`;

    // 詳細の閲覧 (複数ホップの x-forwarded-for)
    const viewed = await call<DsrAdminDetailBody>('GET', `${DSR_ADMIN_API_PATH}/${requesterDsr.id}`, admin.jwt, {
      headers: { 'x-forwarded-for': `${VIEW_CLIENT_IP}, ${PROXY_HOP_IP}`, 'user-agent': TEST_USER_AGENT },
    });
    expect(viewed.status, JSON.stringify(viewed.body)).toBe(HTTP_OK);
    const staleUpdatedAt = viewed.body.data!.updated_at;
    expect(viewed.body.data!.admin_notes).toBeNull();

    // 内部メモを書いて対応中にする (GET が返した updated_at をそのまま If-Unmodified-Since に)
    const updated = await call<DsrAdminDetailBody>('PATCH', `${DSR_ADMIN_API_PATH}/${requesterDsr.id}`, admin.jwt, {
      body: { status: 'in_progress', admin_notes: adminNote },
      headers: {
        'If-Unmodified-Since': staleUpdatedAt,
        'x-forwarded-for': `${UPDATE_CLIENT_IP}, ${PROXY_HOP_IP}`,
        'user-agent': TEST_USER_AGENT,
      },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(HTTP_OK);
    expect(updated.body.data?.status).toBe('in_progress');
    expect(updated.body.data?.admin_notes).toBe(adminNote);
    expect(updated.body.data?.updated_at).not.toBe(staleUpdatedAt);

    // 古い updated_at のままもう一度 PATCH すると 412。行は書き換わらず、更新の監査も増えない
    const rowAfterUpdate = await dbRow(requesterDsr.id);
    const updateAuditsBefore = (await auditRows(admin.id, DSR_AUDIT_ACTIONS.update)).length;
    const stale = await call<DsrAdminDetailBody>('PATCH', `${DSR_ADMIN_API_PATH}/${requesterDsr.id}`, admin.jwt, {
      body: { admin_notes: `${MARK} 古い版からの上書き` },
      headers: { 'If-Unmodified-Since': staleUpdatedAt },
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(HTTP_PRECONDITION_FAILED);
    expect(stale.body.error?.code).toBe('CONFLICT_OPTIMISTIC_LOCK');
    expect(await dbRow(requesterDsr.id)).toEqual(rowAfterUpdate);
    expect((await auditRows(admin.id, DSR_AUDIT_ACTIONS.update)).length).toBe(updateAuditsBefore);

    // 詳細を読み直すと admin_notes が出る
    const reread = await call<DsrAdminDetailBody>('GET', `${DSR_ADMIN_API_PATH}/${requesterDsr.id}`, admin.jwt);
    expect(reread.status).toBe(HTTP_OK);
    expect(reread.body.data?.admin_notes).toBe(adminNote);

    // 本人の GET (一覧・詳細) には admin_notes も hash も出ない。メモの文字列も応答のどこにも入らない
    const ownDetail = await call<DsrOwnBody>('GET', `${DSR_ACCOUNT_API_PATH}/${requesterDsr.id}`, requester.jwt);
    expect(ownDetail.status).toBe(HTTP_OK);
    expect(ownDetail.body.request?.status).toBe('in_progress');
    expect(ownDetail.body.request).not.toHaveProperty('admin_notes');
    expect(ownDetail.body.request).not.toHaveProperty('verification_token_hash');
    expect(JSON.stringify(ownDetail.body)).not.toContain(adminNote);
    const ownList = await call<DsrOwnListBody>('GET', DSR_ACCOUNT_API_PATH, requester.jwt);
    expect(ownList.status).toBe(HTTP_OK);
    for (const row of ownList.body.requests!) {
      expect(row).not.toHaveProperty('admin_notes');
      expect(row).not.toHaveProperty('verification_token_hash');
    }
    expect(JSON.stringify(ownList.body)).not.toContain(adminNote);

    // 監査: 閲覧と更新の行の ip_address が x-forwarded-for の先頭・user_agent が入る。対象は本人 (user)
    const views = await auditRows(admin.id, DSR_AUDIT_ACTIONS.view);
    const view = views.find((v) => v.ip_address === VIEW_CLIENT_IP);
    expect(view, `ip_address が ${VIEW_CLIENT_IP} の閲覧記録 (${JSON.stringify(views.map((v) => v.ip_address))})`).toBeDefined();
    expect(view?.user_agent).toBe(TEST_USER_AGENT);
    expect(view?.target_id).toBe(requester.id);
    expect(view?.target_type).toBe('user');
    expect((view?.details as { request_id?: string }).request_id).toBe(requesterDsr.id);

    const updates = await auditRows(admin.id, DSR_AUDIT_ACTIONS.update);
    const update = updates.find((u) => u.ip_address === UPDATE_CLIENT_IP);
    expect(update, `ip_address が ${UPDATE_CLIENT_IP} の更新記録 (${JSON.stringify(updates.map((u) => u.ip_address))})`).toBeDefined();
    expect(update?.user_agent).toBe(TEST_USER_AGENT);
    expect(update?.target_id).toBe(requester.id);
    expect(update?.details).toMatchObject({
      request_id: requesterDsr.id,
      status_from: 'received',
      status_to: 'in_progress',
      admin_notes_changed: true,
      changed: true,
    });
    // 内部メモの中身は監査に入れない
    expect(JSON.stringify(update?.details)).not.toContain(adminNote);
  });

  it('一覧の監査 (admin.dsr.list) も x-forwarded-for の先頭を inet 列に残す (条件と件数だけ)', async () => {
    const res = await call<DsrAdminListBody>(
      'GET',
      `${DSR_ADMIN_API_PATH}?request_type=disclosure&per_page=${ADMIN_LIST_PER_PAGE}`,
      admin.jwt,
      { headers: { 'x-forwarded-for': `${LIST_CLIENT_IP}, ${PROXY_HOP_IP}`, 'user-agent': TEST_USER_AGENT } },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(HTTP_OK);
    expect((res.body.data ?? []).length).toBeGreaterThan(0);

    const lists = await auditRows(admin.id, DSR_AUDIT_ACTIONS.list);
    const listed = lists.find((l) => l.ip_address === LIST_CLIENT_IP);
    expect(listed, `ip_address が ${LIST_CLIENT_IP} の一覧の記録 (${JSON.stringify(lists.map((l) => l.ip_address))})`).toBeDefined();
    expect(listed?.user_agent).toBe(TEST_USER_AGENT);
    expect(listed?.target_id).toBeNull();
    expect(listed?.target_type).toBe('data_subject_request');
    // 返した行の id や内容は入れない
    expect(JSON.stringify(listed?.details)).not.toContain(requesterDsr.id);
    expect(JSON.stringify(listed?.details)).not.toContain(MARK);
  });
});
