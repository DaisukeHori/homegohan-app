/**
 * #1176 運営ロールの MFA (AAL2 の入口) を、ローカルの Supabase + Next で確かめる (段 B)。
 * docs/design/cross/12-operator-mfa.md §21.4 (M-1〜M-4・M-6・M-7・M-9〜M-14。M-5 は段 C・M-8 は欠番)
 *
 * 結合テストが叩く Next は 1 つで、OPERATOR_MFA_ENFORCE_FROM を設定しない (= 猶予なし・即時)。猶予の枝 (pass_grace) は
 * 単体の mfa-gate.test.ts と route の auth-mfa-routes.test.ts で守る。
 * 利用者はこのファイルの中で service_role で作り、使い捨ての anon client で signInWithPassword して aal1 のセッションを得る
 * (MFA の登録・確認そのものを試すので、signInForIntegration の自動の昇格は使わない。aal2 の super_admin だけは createTestUserWithRoles)。
 * 自己サービスの route (enroll / verify / recover) は Cookie のセッションで呼ぶ (route の Supabase client が Cookie のセッションで
 * challengeAndVerify し、aal2 のセッションを Set-Cookie で返す)。運営の API は Bearer で呼ぶ。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/operator-mfa.test.ts
 */
import { randomUUID } from 'node:crypto';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { generateTotp, TOTP_STEP_SECONDS } from '../../helpers/totp';
import { apiCall } from '../helpers/api';
import { cleanupTestUser, createTestUserWithRoles } from '../helpers/users';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE_URL = process.env.INTEGRATION_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY must be set');
}

/** Supabase の公式の rate-limits の表の MFA の challenge / verify のバースト (§22.4.4。M-13 がこれより 1 回多く呼ぶ) */
const SUPABASE_MFA_BURST_LIMIT = 30;
/** バックアップコードの個数 (cross/01 §5.2・src/lib/auth/mfa/backup-codes.ts の BACKUP_CODE_COUNT) */
const EXPECTED_BACKUP_CODE_COUNT = 10;
/** 1 秒のミリ秒 */
const MILLISECONDS_PER_SECOND = 1000;
/** 6 桁の不一致の HTTP ステータス (自己サービスの verify は 400 AUTH_2FA_INVALID) */
const HTTP_BAD_REQUEST = 400;
/** 回数制限の HTTP ステータス */
const HTTP_TOO_MANY_REQUESTS = 429;
/** PostgreSQL の権限なし */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

const TS = Date.now();
const createdUserIds: string[] = [];

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);

interface TestUser {
  id: string;
  email: string;
  password: string;
}

/** service_role で利用者と roles を作る (セッションは作らない) */
async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `sec-operator-mfa-${label}-${TS}@homegohan.test`;
  // テスト用ユーザーのパスワードは固定値を置かず、実行ごとに作る
  const password = `Aa1!${randomUUID()}`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname: `mfa-${label}`, age_group: '30s', gender: 'other', roles }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  return { id: data.user.id, email, password };
}

/** 使い捨ての anon client でサインインし、aal1 のセッションと、そのセッションを持つ client を返す */
async function signIn(user: TestUser): Promise<{ client: SupabaseClient; session: Session }> {
  const userClient = client(anonKey);
  const { data, error } = await userClient.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error || !data.session) throw new Error(`signIn ${user.email}: ${error?.message}`);
  return { client: userClient, session: data.session };
}

/** client のセッションで TOTP を登録・確認する (Supabase を直接)。次の窓で 1 回だけ打ち直す */
async function enrollWithSupabase(userClient: SupabaseClient): Promise<{ factorId: string; secret: string; aal2Token: string }> {
  const { data: enrolled, error } = await userClient.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'integration-m' });
  if (error || !enrolled) throw new Error(`enroll: ${error?.message}`);
  const aal2Token = await verifyWithSupabase(userClient, enrolled.id, enrolled.totp.secret);
  return { factorId: enrolled.id, secret: enrolled.totp.secret, aal2Token };
}

async function verifyWithSupabase(userClient: SupabaseClient, factorId: string, secret: string): Promise<string> {
  const now = Date.now() / MILLISECONDS_PER_SECOND;
  for (const at of [now, now + TOTP_STEP_SECONDS]) {
    const { data, error } = await userClient.auth.mfa.challengeAndVerify({ factorId, code: generateTotp(secret, at) });
    if (!error && data) return data.access_token;
  }
  throw new Error('challengeAndVerify が 2 回とも失敗しました');
}

/** @supabase/ssr (0.1.0) の Cookie の名前 (sb-<URL のホスト名の最初の段>-auth-token) */
function sessionCookieName(): string {
  return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
}

/** Cookie のセッション (ブラウザと同じ形) で Next の route を呼ぶ */
async function cookieCall(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  session: Session,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; session: Session | null }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${sessionCookieName()}=${encodeURIComponent(JSON.stringify(session))}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: json, session: sessionFromSetCookie(response) };
}

/** Set-Cookie の sb-*-auth-token(.N) をつなげて、新しいセッションを取り出す (無ければ null) */
function sessionFromSetCookie(response: Response): Session | null {
  const chunks = response.headers
    .getSetCookie()
    .map((raw) => {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    })
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name) && c.value !== '')
    .sort((a, b) => Number(a.name.split('.')[1] ?? -1) - Number(b.name.split('.')[1] ?? -1));
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(chunks.map((c) => decodeURIComponent(c.value)).join('')) as Session;
  } catch {
    return null;
  }
}

/** 自己サービスの route で登録する (enroll → verify)。打ち直しは次の窓で 1 回。aal2 のセッションとバックアップコードを返す */
async function enrollViaApp(session: Session): Promise<{ aal2: Session; backupCodes: string[]; secret: string; factorId: string }> {
  const enroll = await cookieCall('POST', '/api/auth/mfa/enroll', session);
  expect(enroll.status, JSON.stringify(enroll.body)).toBe(200);
  const factorId = String(enroll.body.factor_id);
  const secret = String(enroll.body.secret);
  const now = Date.now() / MILLISECONDS_PER_SECOND;
  for (const at of [now, now + TOTP_STEP_SECONDS]) {
    const verify = await cookieCall('POST', '/api/auth/mfa/verify', session, { factor_id: factorId, code: generateTotp(secret, at) });
    if (verify.status === HTTP_BAD_REQUEST) continue;
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    expect(verify.session, '応答の Set-Cookie に aal2 のセッションが無い').not.toBeNull();
    return { aal2: verify.session!, backupCodes: (verify.body.backup_codes ?? []) as string[], secret, factorId };
  }
  throw new Error('verify が 2 回とも 6 桁の不一致でした');
}

/** 自己サービスの route で確認する (登録済み・verify)。aal2 のセッションを返す */
async function verifyViaApp(session: Session, factorId: string, secret: string): Promise<{ aal2: Session; body: Record<string, unknown> }> {
  const now = Date.now() / MILLISECONDS_PER_SECOND;
  for (const at of [now, now + TOTP_STEP_SECONDS]) {
    const verify = await cookieCall('POST', '/api/auth/mfa/verify', session, { factor_id: factorId, code: generateTotp(secret, at) });
    if (verify.status === HTTP_BAD_REQUEST) continue;
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    return { aal2: verify.session!, body: verify.body };
  }
  throw new Error('verify が 2 回とも 6 桁の不一致でした');
}

afterAll(async () => {
  for (const id of createdUserIds) await cleanupTestUser(id).catch(() => {});
});

describe('運営の MFA の入口 (#1176 cross/12 §21.4)', () => {
  // M-1〜M-4 は同じ admin で順に進める (登録 → 新しいログイン → 回復)
  let admin: TestUser;
  let enrolled: { aal2: Session; backupCodes: string[]; secret: string; factorId: string };
  /** M-3 で 6 桁を入れた aal2 のセッション (M-4 の回復の後に終わっていることを確かめる) */
  let m3Aal2: Session;

  it('M-1: admin (aal1) は GET /api/admin/users が 403、GET /api/auth/mfa/status は 200 enrolled:false', async () => {
    admin = await createUser('m1-admin', ['admin']);
    const { session } = await signIn(admin);
    const users = await apiCall('GET', '/api/admin/users', session.access_token);
    expect(users.status).toBe(403);
    const status = await apiCall<Record<string, unknown>>('GET', '/api/auth/mfa/status', session.access_token);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enrolled: false, aal: 'aal1' });
  });

  it('M-2: enroll → verify (helpers/totp で 6 桁) → aal2 → GET /api/admin/users が 200、backup_codes が 10 個', async () => {
    const { session } = await signIn(admin);
    enrolled = await enrollViaApp(session);
    expect(enrolled.backupCodes).toHaveLength(EXPECTED_BACKUP_CODE_COUNT);
    const users = await apiCall('GET', '/api/admin/users', enrolled.aal2.access_token);
    expect(users.status).toBe(200);
  });

  it('M-3: 新しいログイン (aal1) は 403 → verify → 200 (ログインごとに challenge)', async () => {
    const { session } = await signIn(admin);
    expect((await apiCall('GET', '/api/admin/users', session.access_token)).status).toBe(403);
    const { aal2, body } = await verifyViaApp(session, enrolled.factorId, enrolled.secret);
    // 登録済みの factor の verify はバックアップコードを返さない
    expect(body.backup_codes).toBeUndefined();
    expect((await apiCall('GET', '/api/admin/users', aal2.access_token)).status).toBe(200);
    m3Aal2 = aal2;
  });

  it('M-4: recover: コードを 1 個使うと factor が消え (admin.mfa.listFactors が 0)、同じコードは 2 回目 400、旧セッションの token は 401 (回復に使った aal1 のセッションも、M-3 の aal2 のセッションも、refresh もできない)', async () => {
    const before = await signIn(admin);
    // 回復の前: M-3 の aal2 のセッションは運営の API を通る (回復の後に 401 になることの対照)
    expect((await apiCall('GET', '/api/admin/users', m3Aal2.access_token)).status).toBe(200);
    const recovered = await cookieCall('POST', '/api/auth/mfa/recover', before.session, { code: enrolled.backupCodes[0] });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.next).toBe('/login?next=%2Fsettings%2Fsecurity%2Fmfa%2Fsetup');
    const { data: listed } = await srAdmin.auth.admin.mfa.listFactors({ userId: admin.id });
    expect(listed?.factors ?? []).toHaveLength(0);

    // 旧セッションは回復の route が全部終えている (§3.1・§14.5・§26.3)。admin の deleteFactor だけではローカルの GoTrue (v2.183.0) は
    // セッションを終えないので、route の admin.signOut (global) が無いとここが赤になる
    for (const [label, old] of [
      ['回復に使った aal1', before.session],
      ['M-3 の aal2', m3Aal2],
    ] as const) {
      expect((await apiCall('GET', '/api/auth/mfa/status', old.access_token)).status, label).toBe(401);
      expect((await apiCall('GET', '/api/admin/users', old.access_token)).status, label).toBe(401);
      const { error: refreshError } = await client(anonKey).auth.refreshSession({ refresh_token: old.refresh_token });
      expect(refreshError, label).not.toBeNull();
    }

    // 登録し直すと、使ったコードはもう使えない (新しい 10 個に入れ替わる)
    const again = await signIn(admin);
    const reEnrolled = await enrollViaApp(again.session);
    const next = await signIn(admin);
    const reused = await cookieCall('POST', '/api/auth/mfa/recover', next.session, { code: enrolled.backupCodes[0] });
    expect(reused.status).toBe(HTTP_BAD_REQUEST);
    expect(reused.body.code).toBe('AUTH_2FA_INVALID');
    expect(reEnrolled.backupCodes).toHaveLength(EXPECTED_BACKUP_CODE_COUNT);
  });

  it('M-6: operator_mfa_backup_codes は anon / authenticated から読めない (42501)', async () => {
    const anonResult = await client(anonKey).from('operator_mfa_backup_codes').select('id').limit(1);
    expect(anonResult.error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    const user = await createUser('m6-user', ['user']);
    const { session } = await signIn(user);
    const authed = await client(anonKey, session.access_token).from('operator_mfa_backup_codes').select('id').limit(1);
    expect(authed.error?.code).toBe(PG_INSUFFICIENT_PRIVILEGE);
  });

  it('M-7: support だけのユーザーは aal1 のまま /api/support/stats が 200', async () => {
    const support = await createUser('m7-support', ['support']);
    const { session } = await signIn(support);
    expect((await apiCall('GET', '/api/support/stats', session.access_token)).status).toBe(200);
  });

  it('M-9: 登録済み admin の 2 つの aal1 のセッション (A と B。別々の anon client でログイン) のうち B で challenge の verify (登録ではない) に成功すると、A の refresh token での refreshSession が失敗する (S-25)', async () => {
    const user = await createUser('m9-admin', ['admin']);
    const first = await signIn(user);
    const { factorId, secret } = await enrollWithSupabase(first.client);
    const a = await signIn(user);
    const b = await signIn(user);
    await verifyWithSupabase(b.client, factorId, secret);
    const { error } = await a.client.auth.refreshSession({ refresh_token: a.session.refresh_token });
    expect(error).not.toBeNull();
  });

  it('M-14: 未登録 admin の 2 つの aal1 のセッション (A と B。別々の anon client でログイン) のうち B で enroll → verify (登録) に成功すると、A の refresh token での refreshSession が失敗する (S-25)', async () => {
    const user = await createUser('m14-admin', ['admin']);
    const a = await signIn(user);
    const b = await signIn(user);
    await enrollWithSupabase(b.client);
    const { error } = await a.client.auth.refreshSession({ refresh_token: a.session.refresh_token });
    expect(error).not.toBeNull();
  });

  it('M-10: admin と finance を両方持つ利用者・finance だけの利用者 (どちらも登録済み・aal1) は GET /api/admin/finance/invoices が 403、同じ利用者が verify で aal2 にすると 200 (S-13)', async () => {
    for (const [label, roles] of [
      ['m10-admin-finance', ['admin', 'finance']],
      ['m10-finance', ['finance']],
    ] as const) {
      const user = await createUser(label, [...roles]);
      const first = await signIn(user);
      const { factorId, secret } = await enrollWithSupabase(first.client);
      const fresh = await signIn(user);
      expect((await apiCall('GET', '/api/admin/finance/invoices', fresh.session.access_token)).status, label).toBe(403);
      const aal2Token = await verifyWithSupabase(fresh.client, factorId, secret);
      expect((await apiCall('GET', '/api/admin/finance/invoices', aal2Token)).status, label).toBe(200);
    }
  });

  it('M-11: support だけの利用者 (aal1) は GET /api/admin/users が 200 → super_admin (aal2) が PUT /api/admin/users/{id}/role で roles を [support, admin] にする → 同じ aal1 の token の次の GET /api/admin/users は 403 (猶予なし)、GET /api/auth/mfa/status は 200 enrolled:false', async () => {
    const support = await createUser('m11-support', ['support']);
    const { session } = await signIn(support);
    expect((await apiCall('GET', '/api/admin/users', session.access_token)).status).toBe(200);

    const superAdmin = await createTestUserWithRoles({ email: `sec-operator-mfa-m11-sa-${TS}@homegohan.test`, roles: ['super_admin'] });
    createdUserIds.push(superAdmin.userId);
    const granted = await apiCall('PUT', `/api/admin/users/${support.id}/role`, superAdmin.jwt, { roles: ['support', 'admin'] });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);

    expect((await apiCall('GET', '/api/admin/users', session.access_token)).status).toBe(403);
    const status = await apiCall<Record<string, unknown>>('GET', '/api/auth/mfa/status', session.access_token);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enrolled: false });
  });

  it("M-12: 登録済み super_admin (aal1) の POST /api/comparison/trigger は 403 { error: { code: 'FORBIDDEN' } } で、集計の Edge Function を呼ばない (S-23)", async () => {
    const user = await createUser('m12-super-admin', ['super_admin']);
    const first = await signIn(user);
    await enrollWithSupabase(first.client);
    const fresh = await signIn(user);
    const result = await apiCall<{ error?: { code?: string } }>('POST', '/api/comparison/trigger', fresh.session.access_token, {
      periodType: 'weekly',
    });
    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe('FORBIDDEN');
  });

  it('M-13: ローカルの Supabase では MFA の回数制限が効かない: 必須ロールを持たない利用者を作って mfa.enroll した直後の factor に、mfa.challenge を SUPABASE_MFA_BURST_LIMIT + 1 回 (31 回) 続けて呼び、429 が 1 回も無い (§22.4.4)', async () => {
    const user = await createUser('m13-user', ['user']);
    const { client: userClient } = await signIn(user);
    const { data: enrolledFactor, error } = await userClient.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'integration-m13' });
    expect(error).toBeNull();
    const statuses: number[] = [];
    for (let i = 0; i < SUPABASE_MFA_BURST_LIMIT + 1; i += 1) {
      const { error: challengeError } = await userClient.auth.mfa.challenge({ factorId: enrolledFactor!.id });
      if (challengeError) statuses.push(challengeError.status ?? 0);
    }
    expect(statuses.filter((status) => status === HTTP_TOO_MANY_REQUESTS)).toEqual([]);
    expect(statuses).toEqual([]);
  });
});
