/**
 * #1190・#1189・#1198 ログイン履歴・セッション・パスワード履歴の DB と核 (段 A) の結合テスト (ローカル Supabase)。
 * 設計の正典 docs/design/cross/16-auth-history-sessions.md §11 (migration)・§13 (facade)・§20.3 (この一覧)。
 *
 * 確かめること (要点):
 *   - auth.sessions の作成・更新・削除と auth.users のパスワードの変更を、トリガーが user_sessions_metadata / password_history に記録する
 *     (アプリを通らない GoTrue の直接の呼び出しも漏れない)。記録の失敗はログイン・更新・ログアウト・パスワードの変更を止めない (R-13)
 *   - RPC (auth_session_revoke・auth_password_check・claim_login_alerts・release_login_alert) と保守の関数 3 本の挙動と権限
 *   - src/lib/auth/sessions/store.ts・src/lib/auth/password/gotrue-user.ts・session-claims.ts を実物の GoTrue / PostgREST に対して
 *   - migration の目印の間 (既存の行の写し・auth の表のトリガーを作る DO ブロック) をもう一度流しても壊れない (冪等)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない。本番には接続しない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/auth-history-sessions.test.ts
 *
 * 表の書き換え (作成時刻を過去にする・制約で書き込みを失敗させる) は、ローカルスタックの postgres-meta (/pg/query) で行う
 * (anon-definer-execute.test.ts の pgQuery と同じ口)。ほかのファイルと並行に動くので、数える行は自分が作った利用者の行に絞る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient, isAuthSessionMissingError, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { updatePasswordWithAccessToken } from '@/lib/auth/password/gotrue-user';
import { PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES } from '@/lib/auth/password/policy';
import { hasRecentRecoveryMethod, readSessionAuth } from '@/lib/auth/sessions/session-claims';
import {
  claimLoginAlerts,
  finishLoginAlert,
  listPriorLogins,
  recordWebLoginContext,
  releaseLoginAlert,
  setCurrentDeviceName,
  signOutOtherSessions,
} from '@/lib/auth/sessions/store';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。');
}
// ユーザーを作り、表に制約を足し、権限を外すテストなので、ローカルのスタックだけを対象にする
const supabaseHost = new URL(url).hostname;
if (supabaseHost !== 'localhost' && supabaseHost !== '127.0.0.1') {
  throw new Error(`NEXT_PUBLIC_SUPABASE_URL はローカルの Supabase を指してください (現在のホスト: ${supabaseHost})`);
}

const ROOT = path.resolve(__dirname, '../../..');
const MIGRATION_FILE = fs
  .readdirSync(path.join(ROOT, 'supabase/migrations'))
  .find((name) => /^\d{14}_auth_history_sessions\.sql$/.test(name));
if (!MIGRATION_FILE) throw new Error('supabase/migrations に <番号>_auth_history_sessions.sql がありません');
const RAW_MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase/migrations', MIGRATION_FILE), 'utf8');

/** RPC の引数に渡す数 (store.ts の呼び出しと同じ形。値は constants.ts の既定と同じ) */
const BATCH_ALL = 1000;
const MIN_AGE_NONE = 0;
const RECLAIM_MINUTES = 10;
const MAX_AGE_HOURS = 24;
const MAX_ATTEMPTS = 3;
const PASSWORD_GENERATIONS_USER = 3;
const PASSWORD_HISTORY_KEPT = 10;
const IDLE_DAYS_PAST = 31;
const RETENTION_PAST_DAYS = 91;
const RETENTION_INSIDE_DAYS = 89;
const PRIOR_OLD_DAYS = 100;
const PRIOR_LIMIT = 1000;

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}
const srAdmin = client(serviceKey);
const asUser = (jwt: string) => client(anonKey, jwt);

/** ローカルスタックの postgres-meta で SQL を実行する (ローカルだけ。上でホストを確かめている) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

const TS = Date.now();
const PASSWORD = 'Cross16Pass!2026-a';
const createdUserIds: string[] = [];
let userSeq = 0;

interface TestUser {
  id: string;
  email: string;
}
interface Device {
  client: SupabaseClient;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

/** password を null にすると、パスワード無し (Google / Apple だけの利用者と同じ形) で作る */
async function createUser(label: string, options: { password?: string | null; profile?: boolean } = {}): Promise<TestUser> {
  userSeq += 1;
  const email = `sec-1190-${label}-${userSeq}-${TS}@homegohan.test`;
  const password = options.password === undefined ? PASSWORD : options.password;
  const { data, error } = await srAdmin.auth.admin.createUser({
    email,
    ...(password === null ? {} : { password }),
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  if (password === null) {
    // GoTrue (v2.183.0) の admin.createUser は、password を渡さなくても乱数のパスワードの bcrypt を encrypted_password に入れる
    // (トリガーが password_history に 1 行を書く)。Google / Apple だけの利用者 (encrypted_password が空) の形にそろえる
    await pgQuery(`UPDATE auth.users SET encrypted_password = '' WHERE id = '${data.user.id}'`);
    await pgQuery(`DELETE FROM public.password_history WHERE user_id = '${data.user.id}'`);
  }
  if (options.profile) {
    const { error: profileError } = await srAdmin
      .from('user_profiles')
      .insert({ id: data.user.id, nickname: 'Guest', age_group: 'unspecified', gender: 'unspecified' });
    if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  }
  return { id: data.user.id, email };
}

function sessionIdOf(accessToken: string): string {
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')) as { session_id: string };
  return payload.session_id;
}

async function signIn(email: string, password: string = PASSWORD): Promise<Device> {
  const c = client(anonKey);
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return {
    client: c,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    sessionId: sessionIdOf(data.session.access_token),
  };
}

/** GoTrue にセッションが残っているか (GET /user は session_id のセッションの存在まで確かめる) */
async function tokenState(accessToken: string, userId: string): Promise<'alive' | 'revoked'> {
  const { data, error } = await client(anonKey).auth.getUser(accessToken);
  if (!error && data.user?.id === userId) return 'alive';
  if (isAuthSessionMissingError(error) || (error as { code?: string } | null)?.code === 'session_not_found') return 'revoked';
  throw new Error(`getUser が想定外の結果です: ${error?.name} ${error?.message}`);
}

interface MetaRow {
  session_id: string;
  user_id: string;
  ip_address: string | null;
  ip_network: string | null;
  user_agent: string | null;
  device_name: string | null;
  device_family: string | null;
  country_code: string | null;
  context_source: string;
  created_at: string;
  last_active_at: string;
  revoked_at: string | null;
  ended_reason: string | null;
  is_new_device: boolean | null;
  is_new_ip: boolean | null;
  is_new_country: boolean | null;
  alert_status: string;
  alert_claimed_at: string | null;
  alert_attempts: number;
  alert_sent_at: string | null;
}

async function metaRows(userId: string): Promise<MetaRow[]> {
  return pgQuery<MetaRow>(
    `SELECT session_id, user_id, host(ip_address) AS ip_address, ip_network::text AS ip_network, user_agent, device_name, device_family,
            country_code, context_source, created_at, last_active_at, revoked_at, ended_reason, is_new_device, is_new_ip, is_new_country,
            alert_status, alert_claimed_at, alert_attempts, alert_sent_at
       FROM public.user_sessions_metadata WHERE user_id = '${userId}' ORDER BY created_at`,
  );
}
async function metaRow(sessionId: string): Promise<MetaRow | undefined> {
  const rows = await pgQuery<MetaRow>(
    `SELECT session_id, user_id, host(ip_address) AS ip_address, ip_network::text AS ip_network, user_agent, device_name, device_family,
            country_code, context_source, created_at, last_active_at, revoked_at, ended_reason, is_new_device, is_new_ip, is_new_country,
            alert_status, alert_claimed_at, alert_attempts, alert_sent_at
       FROM public.user_sessions_metadata WHERE session_id = '${sessionId}'`,
  );
  return rows[0];
}
async function countOf(query: string): Promise<number> {
  const rows = await pgQuery<{ n: number | string }>(query);
  return Number(rows[0]?.n ?? 0);
}
const historyCount = (userId: string) => countOf(`SELECT count(*) AS n FROM public.password_history WHERE user_id = '${userId}'`);
const metaCount = (userId: string) => countOf(`SELECT count(*) AS n FROM public.user_sessions_metadata WHERE user_id = '${userId}'`);
const authSessionExists = async (sessionId: string) =>
  (await countOf(`SELECT count(*) AS n FROM auth.sessions WHERE id = '${sessionId}'`)) === 1;
async function encryptedPassword(userId: string): Promise<string> {
  const rows = await pgQuery<{ encrypted_password: string }>(`SELECT encrypted_password FROM auth.users WHERE id = '${userId}'`);
  return rows[0]?.encrypted_password ?? '';
}
async function profileStats(userId: string): Promise<{ last_login_at: string | null; login_count: number | null; matches_latest: boolean | null }> {
  const rows = await pgQuery<{ last_login_at: string | null; login_count: number | null; matches_latest: boolean | null }>(
    `SELECT p.last_login_at, p.login_count,
            p.last_login_at = (SELECT max(m.created_at) FROM public.user_sessions_metadata m WHERE m.user_id = p.id) AS matches_latest
       FROM public.user_profiles p WHERE p.id = '${userId}'`,
  );
  return rows[0];
}
const claimAll = (minAgeSeconds: number = MIN_AGE_NONE, batchSize: number = BATCH_ALL) =>
  claimLoginAlerts(srAdmin, { batchSize, minAgeSeconds, reclaimMinutes: RECLAIM_MINUTES, maxAgeHours: MAX_AGE_HOURS });

/** 一時的に表へ足す、必ず失敗させる制約の名前 (finally で外す) */
const FORCE_FAIL_CONSTRAINT = 'cross16_test_force_fail';

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

describe('記録: auth.sessions / auth.users のトリガー (§11.3)', () => {
  it('プロフィールの行がある利用者がパスワードでサインインすると、user_sessions_metadata に 1 行 (ip / user_agent / ip_network) が入り、user_profiles.last_login_at がその行の created_at に、login_count が 1 増える', async () => {
    const user = await createUser('signin', { profile: true });
    expect((await profileStats(user.id)).login_count).toBe(0);
    const device = await signIn(user.email);
    const rows = await metaRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: device.sessionId, context_source: 'auth', alert_status: 'pending', revoked_at: null });
    expect(rows[0].ip_address).not.toBeNull();
    expect(rows[0].ip_network).not.toBeNull();
    expect(rows[0].ip_network).toMatch(/\/(24|48)$/);
    expect(rows[0].user_agent).not.toBeNull();
    const stats = await profileStats(user.id);
    expect(stats.login_count).toBe(1);
    expect(stats.matches_latest).toBe(true);
    await signIn(user.email);
    expect((await profileStats(user.id)).login_count).toBe(2);
  });

  it('プロフィールの行が無い利用者 (admin.createUser の直後) のサインインも成功し、user_sessions_metadata に 1 行が入る (user_profiles は 0 行の更新)。そのあと accept_legal_documents と同じ列で user_profiles の行を作ると、last_login_at = そのセッションの created_at・login_count = 1 が入る (S-1)', async () => {
    const user = await createUser('noprofile');
    const device = await signIn(user.email);
    expect(await countOf(`SELECT count(*) AS n FROM public.user_profiles WHERE id = '${user.id}'`)).toBe(0);
    const rows = await metaRows(user.id);
    expect(rows.map((r) => r.session_id)).toEqual([device.sessionId]);
    const { error } = await srAdmin
      .from('user_profiles')
      .insert({ id: user.id, nickname: 'Guest', age_group: 'unspecified', gender: 'unspecified' });
    expect(error).toBeNull();
    const stats = await profileStats(user.id);
    expect(stats.login_count).toBe(1);
    expect(stats.matches_latest).toBe(true);
  });

  it('last_login_at を明示して作る user_profiles の行は、トリガーが変えない', async () => {
    const user = await createUser('explicit');
    await signIn(user.email);
    const explicit = '2026-01-01T00:00:00+00:00';
    const { error } = await srAdmin.from('user_profiles').insert({
      id: user.id,
      nickname: 'Guest',
      age_group: 'unspecified',
      gender: 'unspecified',
      last_login_at: explicit,
    });
    expect(error).toBeNull();
    const rows = await pgQuery<{ same: boolean; login_count: number }>(
      `SELECT last_login_at = '${explicit}'::timestamptz AS same, login_count FROM public.user_profiles WHERE id = '${user.id}'`,
    );
    expect(rows[0].same).toBe(true);
    expect(rows[0].login_count).toBe(0);
  });

  it('refresh で last_active_at が進み、user_agent は変わらない (盗んだ refresh token の使用 S-36 の経路も同じ。行は増えず、alert_status も変わらない)', async () => {
    const user = await createUser('refresh');
    const device = await signIn(user.email);
    // 比べやすいよう、記録の last_active_at と UA を過去・別の値にしておく (トリガーは UA を写さない)
    await pgQuery(
      `UPDATE public.user_sessions_metadata SET last_active_at = now() - interval '1 hour', user_agent = 'cross16-original-ua' WHERE session_id = '${device.sessionId}'`,
    );
    const before = (await metaRow(device.sessionId))!;
    const { data, error } = await client(anonKey).auth.refreshSession({ refresh_token: device.refreshToken });
    expect(error).toBeNull();
    expect(data.session).not.toBeNull();
    const after = (await metaRow(device.sessionId))!;
    expect(new Date(after.last_active_at).getTime()).toBeGreaterThan(new Date(before.last_active_at).getTime());
    expect(after.user_agent).toBe('cross16-original-ua');
    expect(after.alert_status).toBe(before.alert_status);
    expect(await metaCount(user.id)).toBe(1);
  });

  it('signOut (global) で revoked_at と signed_out', async () => {
    const user = await createUser('signout');
    const device = await signIn(user.email);
    const { error } = await device.client.auth.signOut({ scope: 'global' });
    expect(error).toBeNull();
    const row = (await metaRow(device.sessionId))!;
    expect(row.revoked_at).not.toBeNull();
    expect(row.ended_reason).toBe('signed_out');
    expect(await authSessionExists(device.sessionId)).toBe(false);
  });

  it('updateUser (GoTrue の PUT /user を本書の API を通さずに呼ぶ = S-33 の経路) で password_history が 1 行増え、11 回変えると 10 行に切り詰まる (照合は通らないが記録は漏れない)', async () => {
    const user = await createUser('history');
    expect(await historyCount(user.id)).toBe(1); // admin.createUser の password で 1 行
    const device = await signIn(user.email);
    const first = await device.client.auth.updateUser({ password: `${PASSWORD}-v1` });
    expect(first.error).toBeNull();
    expect(await historyCount(user.id)).toBe(2);
    for (let i = 2; i <= 11; i += 1) {
      const { error } = await device.client.auth.updateUser({ password: `${PASSWORD}-v${i}` });
      expect(error).toBeNull();
    }
    expect(await historyCount(user.id)).toBe(PASSWORD_HISTORY_KEPT);
    // 残っているのは新しい 10 世代 (最新は今の encrypted_password)
    const newest = await pgQuery<{ password_hash: string }>(
      `SELECT password_hash FROM public.password_history WHERE user_id = '${user.id}' ORDER BY changed_at DESC LIMIT 1`,
    );
    expect(newest[0].password_hash).toBe(await encryptedPassword(user.id));
  });

  it('updateUser({ email }) (メールアドレス変更の申し込み。確認のメールを送るだけ) は error 無しで返り、その前後で password_history の行数も、その利用者の user_sessions_metadata の行数も変わらない', async () => {
    const user = await createUser('email');
    const device = await signIn(user.email);
    const historyBefore = await historyCount(user.id);
    const metaBefore = await metaCount(user.id);
    const { error } = await device.client.auth.updateUser({ email: `sec-1190-email-new-${TS}@homegohan.test` });
    expect(error).toBeNull();
    expect(await historyCount(user.id)).toBe(historyBefore);
    expect(await metaCount(user.id)).toBe(metaBefore);
  });

  it('auth.admin.deleteUser で、その利用者の user_sessions_metadata と password_history の行が消える (FK の CASCADE。S-24)', async () => {
    const user = await createUser('delete');
    await signIn(user.email);
    expect(await metaCount(user.id)).toBe(1);
    expect(await historyCount(user.id)).toBe(1);
    const { error } = await srAdmin.auth.admin.deleteUser(user.id);
    expect(error).toBeNull();
    expect(await metaCount(user.id)).toBe(0);
    expect(await historyCount(user.id)).toBe(0);
  });

  it('サインインしたセッションの access_token と refresh_token を、別の client (persistSession: false) の auth.setSession に渡しても、その利用者の user_sessions_metadata の行数は変わらず、行の session_id は setSession の後の getClaims の session_id と同じ (WebView はネイティブの行を借り、行を増やさない。S-23)', async () => {
    const user = await createUser('webview');
    const device = await signIn(user.email);
    expect(await metaCount(user.id)).toBe(1);
    const webView = client(anonKey);
    const { error } = await webView.auth.setSession({ access_token: device.accessToken, refresh_token: device.refreshToken });
    expect(error).toBeNull();
    expect(await metaCount(user.id)).toBe(1);
    const claims = await webView.auth.getClaims();
    const sessionId = (claims.data?.claims as { session_id?: string } | undefined)?.session_id;
    expect(sessionId).toBe(device.sessionId);
    expect((await metaRows(user.id))[0].session_id).toBe(sessionId);
  });
});

describe('失効: auth_session_revoke (§11.4)', () => {
  it('auth_session_revoke は他人の行を消せず not_found、本人の他の行を消すと revoked、自分の行は current', async () => {
    const user = await createUser('revoke');
    const other = await createUser('revoke-other');
    const current = await signIn(user.email);
    const second = await signIn(user.email);
    const othersDevice = await signIn(other.email);

    const asCurrent = asUser(current.accessToken);
    const notFound = await asCurrent.rpc('auth_session_revoke', { p_session_id: othersDevice.sessionId });
    expect(notFound.error).toBeNull();
    expect(notFound.data).toBe('not_found');
    expect(await authSessionExists(othersDevice.sessionId)).toBe(true);
    expect((await metaRow(othersDevice.sessionId))!.ended_reason).toBeNull();

    const revoked = await asCurrent.rpc('auth_session_revoke', { p_session_id: second.sessionId });
    expect(revoked.error).toBeNull();
    expect(revoked.data).toBe('revoked');
    expect(await authSessionExists(second.sessionId)).toBe(false);
    const row = (await metaRow(second.sessionId))!;
    expect(row.revoked_at).not.toBeNull();
    expect(row.ended_reason).toBe('revoked_by_user');

    const self = await asCurrent.rpc('auth_session_revoke', { p_session_id: current.sessionId });
    expect(self.error).toBeNull();
    expect(self.data).toBe('current');
    expect(await authSessionExists(current.sessionId)).toBe(true);
  });

  it('消した後の JWT で getUser すると session_not_found', async () => {
    const user = await createUser('revoke-jwt');
    const current = await signIn(user.email);
    const second = await signIn(user.email);
    expect(await tokenState(second.accessToken, user.id)).toBe('alive');
    const { data, error } = await asUser(current.accessToken).rpc('auth_session_revoke', { p_session_id: second.sessionId });
    expect(error).toBeNull();
    expect(data).toBe('revoked');
    const { error: getUserError } = await client(anonKey).auth.getUser(second.accessToken);
    expect(getUserError).not.toBeNull();
    expect((getUserError as { code?: string }).code === 'session_not_found' || isAuthSessionMissingError(getUserError)).toBe(true);
    expect(await tokenState(current.accessToken, user.id)).toBe('alive');
  });
});

describe('パスワード: auth_password_check (§11.5) と GoTrue の更新 (§13.7)', () => {
  const check = (userId: string, current: string | null, next: string) =>
    srAdmin.rpc('auth_password_check', {
      p_user_id: userId,
      p_current_password: current,
      p_new_password: next,
      p_generations: PASSWORD_GENERATIONS_USER,
    });

  it('auth_password_check が §11.5 の決定表の 7 行を返す: bcrypt の利用者は変更で current_mismatch / reused / ok、再設定 (p_current_password = NULL) で reused / ok。パスワード無しで作った利用者は変更で no_password、再設定で ok。encrypted_password を pgQuery で `$argon2id$` で始まる値にした利用者は変更で unsupported_hash、再設定で ok (bcrypt の履歴と同じなら reused)', async () => {
    const bcryptUser = await createUser('check-bcrypt');
    expect((await check(bcryptUser.id, 'wrong-password', 'Another!2026')).data).toBe('current_mismatch');
    expect((await check(bcryptUser.id, PASSWORD, PASSWORD)).data).toBe('reused');
    expect((await check(bcryptUser.id, PASSWORD, 'Another!2026')).data).toBe('ok');
    expect((await check(bcryptUser.id, null, PASSWORD)).data).toBe('reused');
    expect((await check(bcryptUser.id, null, 'Another!2026')).data).toBe('ok');

    const noPassword = await createUser('check-nopass', { password: null });
    expect((await check(noPassword.id, 'anything', 'Another!2026')).data).toBe('no_password');
    expect((await check(noPassword.id, null, 'Another!2026')).data).toBe('ok');

    const argonUser = await createUser('check-argon');
    await pgQuery(
      `UPDATE auth.users SET encrypted_password = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo' WHERE id = '${argonUser.id}'`,
    );
    expect((await check(argonUser.id, PASSWORD, 'Another!2026')).data).toBe('unsupported_hash');
    expect((await check(argonUser.id, null, 'Another!2026')).data).toBe('ok');
    expect((await check(argonUser.id, null, PASSWORD)).data).toBe('reused');
    // 世代数の範囲の外は 22023
    const outOfRange = await srAdmin.rpc('auth_password_check', {
      p_user_id: bcryptUser.id,
      p_current_password: null,
      p_new_password: 'x',
      p_generations: PASSWORD_HISTORY_KEPT + 1,
    });
    expect(outOfRange.error?.code).toBe('22023');
  });

  it('パスワード無しで作った利用者が generate_link (recovery) → POST /verify (token_hash) の JWT で updatePasswordWithAccessToken (第 3 引数 null) を呼ぶと、encrypted_password が bcrypt になり password_history が 1 行になる (S-28)', async () => {
    const user = await createUser('recovery-nopass', { password: null });
    expect(await historyCount(user.id)).toBe(0);
    const { data: link, error: linkError } = await srAdmin.auth.admin.generateLink({ type: 'recovery', email: user.email });
    expect(linkError).toBeNull();
    const { data: verified, error: verifyError } = await client(anonKey).auth.verifyOtp({
      token_hash: link.properties!.hashed_token,
      type: 'recovery',
    });
    expect(verifyError).toBeNull();
    const result = await updatePasswordWithAccessToken(verified.session!.access_token, 'FirstPassword!2026', null);
    expect(result).toEqual({ error: null });
    expect((await encryptedPassword(user.id)).startsWith('$2')).toBe(true);
    expect(await historyCount(user.id)).toBe(1);
  });

  it('Cookie を持たず Bearer の JWT だけで updatePasswordWithAccessToken を (第 3 引数に現在のパスワードを入れて) 呼ぶと、encrypted_password が変わり、呼んだセッションは残り、同じ利用者の他のセッションは消える', async () => {
    const user = await createUser('bearer-update');
    const caller = await signIn(user.email);
    const other = await signIn(user.email);
    const before = await encryptedPassword(user.id);
    const result = await updatePasswordWithAccessToken(caller.accessToken, `${PASSWORD}-bearer`, PASSWORD);
    expect(result).toEqual({ error: null });
    expect(await encryptedPassword(user.id)).not.toBe(before);
    expect(await tokenState(caller.accessToken, user.id)).toBe('alive');
    expect(await tokenState(other.accessToken, user.id)).toBe('revoked');
  });

  it('signOutOtherSessions(admin, Bearer の JWT) は同じ利用者の他のセッションを消し、呼んだセッションは残す', async () => {
    const user = await createUser('others');
    const caller = await signIn(user.email);
    const other = await signIn(user.email);
    await signOutOtherSessions(srAdmin, caller.accessToken);
    expect(await tokenState(caller.accessToken, user.id)).toBe('alive');
    expect(await tokenState(other.accessToken, user.id)).toBe('revoked');
    expect((await metaRow(other.sessionId))!.ended_reason).toBe('signed_out');
  });

  it('generate_link (recovery) → POST /verify (token_hash) で作ったセッションの JWT は amr に otp を持ち、hasRecentRecoveryMethod が真', async () => {
    const user = await createUser('amr-otp');
    const { data: link } = await srAdmin.auth.admin.generateLink({ type: 'recovery', email: user.email });
    const c = client(anonKey);
    const { data: verified, error } = await c.auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: 'recovery' });
    expect(error).toBeNull();
    const auth = await readSessionAuth(c.auth, `Bearer ${verified.session!.access_token}`);
    expect(auth).not.toBeNull();
    expect(auth!.claims.amr?.map((entry) => entry.method)).toContain('otp');
    expect(hasRecentRecoveryMethod(auth!.claims, new Date(), PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES)).toBe(true);
  });

  it('パスワードでサインインしたセッションの JWT は amr が password で、hasRecentRecoveryMethod が偽', async () => {
    const user = await createUser('amr-password');
    const device = await signIn(user.email);
    const auth = await readSessionAuth(device.client.auth, `Bearer ${device.accessToken}`);
    expect(auth).not.toBeNull();
    expect(auth!.claims.amr?.map((entry) => entry.method)).toEqual(['password']);
    expect(hasRecentRecoveryMethod(auth!.claims, new Date(), PASSWORD_RESET_RECOVERY_MAX_AGE_MINUTES)).toBe(false);
  });
});

describe('保守の関数 3 本と権限 (§11.6)', () => {
  it('expire_idle_auth_sessions が refreshed_at の古い行だけを消して idle_expired にする', async () => {
    const user = await createUser('idle');
    const idle = await signIn(user.email);
    const fresh = await signIn(user.email);
    await pgQuery(
      `UPDATE auth.sessions SET created_at = now() - interval '${IDLE_DAYS_PAST} days', refreshed_at = (now() - interval '${IDLE_DAYS_PAST} days') AT TIME ZONE 'UTC' WHERE id = '${idle.sessionId}'`,
    );
    const { data, error } = await srAdmin.rpc('expire_idle_auth_sessions');
    expect(error).toBeNull();
    expect(Number(data)).toBeGreaterThanOrEqual(1);
    expect(await authSessionExists(idle.sessionId)).toBe(false);
    expect(await authSessionExists(fresh.sessionId)).toBe(true);
    expect((await metaRow(idle.sessionId))!).toMatchObject({ ended_reason: 'idle_expired' });
    expect((await metaRow(idle.sessionId))!.revoked_at).not.toBeNull();
    expect((await metaRow(fresh.sessionId))!.revoked_at).toBeNull();
  });

  it('reconcile が auth.sessions に無い live の行を signed_out にする', async () => {
    const user = await createUser('reconcile');
    const live = await signIn(user.email);
    const orphan = randomUUID();
    await pgQuery(
      `INSERT INTO public.user_sessions_metadata (session_id, user_id, created_at, last_active_at) VALUES ('${orphan}', '${user.id}', now(), now())`,
    );
    const { error } = await srAdmin.rpc('reconcile_user_sessions_metadata');
    expect(error).toBeNull();
    expect((await metaRow(orphan))!).toMatchObject({ ended_reason: 'signed_out' });
    expect((await metaRow(orphan))!.revoked_at).not.toBeNull();
    expect((await metaRow(live.sessionId))!.revoked_at).toBeNull();
  });

  it('cleanup が 90 日より古い終了行だけを消す', async () => {
    const user = await createUser('cleanup');
    const old = randomUUID();
    const inside = randomUUID();
    const live = randomUUID();
    await pgQuery(
      `INSERT INTO public.user_sessions_metadata (session_id, user_id, created_at, last_active_at, revoked_at, ended_reason) VALUES
         ('${old}', '${user.id}', now() - interval '120 days', now() - interval '120 days', now() - interval '${RETENTION_PAST_DAYS} days', 'signed_out'),
         ('${inside}', '${user.id}', now() - interval '120 days', now() - interval '120 days', now() - interval '${RETENTION_INSIDE_DAYS} days', 'signed_out'),
         ('${live}', '${user.id}', now() - interval '120 days', now() - interval '120 days', NULL, NULL)`,
    );
    const { error } = await srAdmin.rpc('cleanup_ended_user_sessions_metadata');
    expect(error).toBeNull();
    expect(await metaRow(old)).toBeUndefined();
    expect(await metaRow(inside)).toBeDefined();
    expect(await metaRow(live)).toBeDefined();
  });

  it('anon / authenticated は 7 本の関数 (RPC 4 本と保守 3 本) のうち auth_session_revoke だけを (authenticated が) 実行できる', async () => {
    const rows = await pgQuery<{ sig: string; anon_exec: boolean; auth_exec: boolean }>(`
      SELECT regexp_replace(p.oid::regprocedure::text, '^public\\.', '') AS sig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('auth_session_revoke', 'auth_password_check', 'claim_login_alerts', 'release_login_alert',
                           'expire_idle_auth_sessions', 'reconcile_user_sessions_metadata', 'cleanup_ended_user_sessions_metadata')
       ORDER BY 1`);
    expect(rows).toHaveLength(7);
    expect(rows.filter((r) => r.anon_exec)).toEqual([]);
    expect(rows.filter((r) => r.auth_exec).map((r) => r.sig)).toEqual(['auth_session_revoke(uuid)']);
    // PostgREST から anon で呼んでも断られる
    const { error } = await client(anonKey).rpc('expire_idle_auth_sessions');
    expect(error).not.toBeNull();
  });
});

describe('通知の取り置き・戻し・完了 (claim_login_alerts・release_login_alert §11.4 / store.ts §13.1)', () => {
  /** 自分の利用者の行の session_id だけを取り出す (ほかのファイルのサインインの行も取り置かれうる) */
  const mine = (rows: Array<{ session_id: string }>, ids: string[]) => rows.map((r) => r.session_id).filter((id) => ids.includes(id));

  it('listPriorLogins は created_at が 90 日より前の live の行も返し、自分の行と、後に作られた行は返さない', async () => {
    const user = await createUser('prior');
    const s1 = await signIn(user.email);
    const s2 = await signIn(user.email);
    const s3 = await signIn(user.email);
    await pgQuery(`UPDATE public.user_sessions_metadata SET created_at = now() - interval '${PRIOR_OLD_DAYS} days' WHERE session_id = '${s1.sessionId}'`);
    await pgQuery(`UPDATE public.user_sessions_metadata SET created_at = now() + interval '1 minute' WHERE session_id = '${s3.sessionId}'`);
    const current = (await metaRow(s2.sessionId))!;
    const prior = await listPriorLogins(srAdmin, { userId: user.id, sessionId: s2.sessionId, createdAt: current.created_at, limit: PRIOR_LIMIT });
    expect(prior).toHaveLength(1);
    expect(prior[0].ip_network).toBe((await metaRow(s1.sessionId))!.ip_network);
    expect(Object.keys(prior[0]).sort()).toEqual(['country_code', 'device_family', 'ip_network', 'user_agent']);
  });

  it('claimLoginAlerts を 2 つ同時に (Promise.all で) 呼ぶと、同じ pending の行はどちらか一方だけが返し、両方の戻りの session_id に重なりが無い (S-19)', async () => {
    const user = await createUser('claim-race');
    const ids = [(await signIn(user.email)).sessionId, (await signIn(user.email)).sessionId, (await signIn(user.email)).sessionId];
    const [a, b] = await Promise.all([claimAll(), claimAll()]);
    const aIds = new Set(a.map((r) => r.session_id));
    expect(b.filter((r) => aIds.has(r.session_id))).toEqual([]);
    for (const id of ids) {
      expect(Number(aIds.has(id)) + Number(b.some((r) => r.session_id === id)), id).toBe(1);
    }
  });

  it('claimLoginAlerts は created_at が minAgeSeconds より新しい行と done の行を取らず、取った行を processing・alert_claimed_at = now にする', async () => {
    const user = await createUser('claim-age');
    const old = await signIn(user.email);
    const young = await signIn(user.email);
    const done = await signIn(user.email);
    await pgQuery(`UPDATE public.user_sessions_metadata SET created_at = now() - interval '2 hours' WHERE session_id IN ('${old.sessionId}', '${done.sessionId}')`);
    await pgQuery(`UPDATE public.user_sessions_metadata SET alert_status = 'done' WHERE session_id = '${done.sessionId}'`);
    const minAgeOneHour = 3600;
    const claimed = await claimAll(minAgeOneHour);
    expect(mine(claimed, [old.sessionId, young.sessionId, done.sessionId])).toEqual([old.sessionId]);
    const row = (await metaRow(old.sessionId))!;
    expect(row.alert_status).toBe('processing');
    expect(row.alert_claimed_at).not.toBeNull();
    expect(await countOf(`SELECT count(*) AS n FROM public.user_sessions_metadata WHERE session_id = '${old.sessionId}' AND alert_claimed_at > now() - interval '1 minute'`)).toBe(1);
    expect((await metaRow(young.sessionId))!.alert_status).toBe('pending');
    expect((await metaRow(done.sessionId))!.alert_status).toBe('done');
  });

  it('claimLoginAlerts は processing のまま alert_claimed_at が reclaimMinutes より前の行を取り直し、reclaimMinutes 以内の processing の行は取らない (§10 の取り置きの行)', async () => {
    const user = await createUser('claim-reclaim');
    const stuck = await signIn(user.email);
    const busy = await signIn(user.email);
    await pgQuery(
      `UPDATE public.user_sessions_metadata SET created_at = now() - interval '1 hour', alert_status = 'processing', alert_claimed_at = now() - interval '11 minutes' WHERE session_id = '${stuck.sessionId}'`,
    );
    await pgQuery(
      `UPDATE public.user_sessions_metadata SET created_at = now() - interval '1 hour', alert_status = 'processing', alert_claimed_at = now() - interval '5 minutes' WHERE session_id = '${busy.sessionId}'`,
    );
    const claimed = await claimAll();
    expect(mine(claimed, [stuck.sessionId, busy.sessionId])).toEqual([stuck.sessionId]);
    expect(await countOf(`SELECT count(*) AS n FROM public.user_sessions_metadata WHERE session_id = '${busy.sessionId}' AND alert_claimed_at < now() - interval '4 minutes'`)).toBe(1);
  });

  it('claimLoginAlerts は 1 回に batchSize 行までしか取らない', async () => {
    const user = await createUser('claim-batch');
    for (let i = 0; i < 3; i += 1) await signIn(user.email);
    const batchOfTwo = 2;
    const claimed = await claimAll(MIN_AGE_NONE, batchOfTwo);
    expect(claimed).toHaveLength(batchOfTwo);
  });

  it('claimLoginAlerts は、created_at が maxAgeHours より前の pending の行と、created_at が maxAgeHours より前で alert_claimed_at が reclaimMinutes より前の processing の行を返さず、done にする (alert_claimed_at は NULL、device_family・is_new_*・alert_sent_at は NULL のまま)。同じ呼び出しで、created_at が maxAgeHours 以内の pending の行は返す', async () => {
    const user = await createUser('claim-expire');
    const stalePending = await signIn(user.email);
    const staleProcessing = await signIn(user.email);
    const recent = await signIn(user.email);
    await pgQuery(`UPDATE public.user_sessions_metadata SET created_at = now() - interval '25 hours' WHERE session_id = '${stalePending.sessionId}'`);
    await pgQuery(
      `UPDATE public.user_sessions_metadata SET created_at = now() - interval '25 hours', alert_status = 'processing', alert_claimed_at = now() - interval '11 minutes' WHERE session_id = '${staleProcessing.sessionId}'`,
    );
    await pgQuery(`UPDATE public.user_sessions_metadata SET created_at = now() - interval '23 hours' WHERE session_id = '${recent.sessionId}'`);
    const claimed = await claimAll();
    expect(mine(claimed, [stalePending.sessionId, staleProcessing.sessionId, recent.sessionId])).toEqual([recent.sessionId]);
    for (const id of [stalePending.sessionId, staleProcessing.sessionId]) {
      expect((await metaRow(id))!).toMatchObject({
        alert_status: 'done',
        alert_claimed_at: null,
        device_family: null,
        is_new_device: null,
        is_new_ip: null,
        is_new_country: null,
        alert_sent_at: null,
      });
    }
  });

  it('claimLoginAlerts は、created_at が maxAgeHours より前でも、done の行と、alert_claimed_at が reclaimMinutes 以内の processing の行 (ほかの worker が処理中) は変えない', async () => {
    const user = await createUser('claim-keep');
    const done = await signIn(user.email);
    const busy = await signIn(user.email);
    await pgQuery(
      `UPDATE public.user_sessions_metadata SET created_at = now() - interval '25 hours', alert_status = 'done', device_family = 'ios/safari', is_new_device = true, is_new_ip = false, is_new_country = false WHERE session_id = '${done.sessionId}'`,
    );
    await pgQuery(
      `UPDATE public.user_sessions_metadata SET created_at = now() - interval '25 hours', alert_status = 'processing', alert_claimed_at = now() - interval '5 minutes' WHERE session_id = '${busy.sessionId}'`,
    );
    const busyBefore = (await metaRow(busy.sessionId))!;
    const claimed = await claimAll();
    expect(mine(claimed, [done.sessionId, busy.sessionId])).toEqual([]);
    expect((await metaRow(done.sessionId))!).toMatchObject({ alert_status: 'done', device_family: 'ios/safari', is_new_device: true });
    const busyAfter = (await metaRow(busy.sessionId))!;
    expect(busyAfter.alert_status).toBe('processing');
    expect(busyAfter.alert_claimed_at).toBe(busyBefore.alert_claimed_at);
  });

  it('alert_status を指定せずに user_sessions_metadata に INSERT した行 (pgQuery。user_id はテストの利用者・session_id は新しい UUID・created_at は 1 分前) は done で、claimLoginAlerts が取らない (列の既定 §11.1・S-35)', async () => {
    const user = await createUser('default-done');
    const id = randomUUID();
    await pgQuery(
      `INSERT INTO public.user_sessions_metadata (session_id, user_id, created_at, last_active_at) VALUES ('${id}', '${user.id}', now() - interval '1 minute', now())`,
    );
    expect((await metaRow(id))!.alert_status).toBe('done');
    expect(mine(await claimAll(), [id])).toEqual([]);
  });

  it('claimLoginAlerts は revoked_at のある (終わった) pending の行も取り (サインインして minAgeSeconds より前に signOut した行)、finishLoginAlert で done にする。revoked_at と ended_reason は変わらない (§10 の ended の行・S-29)', async () => {
    const user = await createUser('claim-ended');
    const device = await signIn(user.email);
    await device.client.auth.signOut({ scope: 'local' });
    const ended = (await metaRow(device.sessionId))!;
    expect(ended.revoked_at).not.toBeNull();
    expect(ended.alert_status).toBe('pending');
    expect(mine(await claimAll(), [device.sessionId])).toEqual([device.sessionId]);
    await finishLoginAlert(srAdmin, {
      sessionId: device.sessionId,
      deviceFamily: 'other/server',
      isNewDevice: false,
      isNewIp: false,
      isNewCountry: false,
      sentAt: null,
    });
    const after = (await metaRow(device.sessionId))!;
    expect(after.alert_status).toBe('done');
    expect(after.revoked_at).toBe(ended.revoked_at);
    expect(after.ended_reason).toBe(ended.ended_reason);
  });

  it('releaseLoginAlert は processing の行の alert_attempts を 1 増やして pending に戻し (alert_claimed_at は NULL)、maxAttempts 回目 (attempts が 3 になる回) で done にする。processing でない行は変えない (§10 の例外の行)', async () => {
    const user = await createUser('release');
    const device = await signIn(user.email);
    const setProcessing = () =>
      pgQuery(`UPDATE public.user_sessions_metadata SET alert_status = 'processing', alert_claimed_at = now() WHERE session_id = '${device.sessionId}'`);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await setProcessing();
      await releaseLoginAlert(srAdmin, { sessionId: device.sessionId, maxAttempts: MAX_ATTEMPTS });
      expect((await metaRow(device.sessionId))!).toMatchObject({ alert_status: 'pending', alert_attempts: attempt, alert_claimed_at: null });
    }
    await setProcessing();
    await releaseLoginAlert(srAdmin, { sessionId: device.sessionId, maxAttempts: MAX_ATTEMPTS });
    expect((await metaRow(device.sessionId))!).toMatchObject({ alert_status: 'done', alert_attempts: MAX_ATTEMPTS, alert_claimed_at: null });
    // processing でない (pending の) 行は変えない
    const other = await signIn(user.email);
    await releaseLoginAlert(srAdmin, { sessionId: other.sessionId, maxAttempts: MAX_ATTEMPTS });
    expect((await metaRow(other.sessionId))!).toMatchObject({ alert_status: 'pending', alert_attempts: 0 });
  });

  it('finishLoginAlert は done にして device_family・is_new_*・alert_sent_at を書く', async () => {
    const user = await createUser('finish');
    const device = await signIn(user.email);
    const sentAt = new Date('2026-10-16T01:02:03.000Z');
    await finishLoginAlert(srAdmin, {
      sessionId: device.sessionId,
      deviceFamily: 'windows/chrome',
      isNewDevice: true,
      isNewIp: true,
      isNewCountry: false,
      sentAt,
    });
    const row = (await metaRow(device.sessionId))!;
    expect(row).toMatchObject({ alert_status: 'done', device_family: 'windows/chrome', is_new_device: true, is_new_ip: true, is_new_country: false });
    expect(new Date(row.alert_sent_at!).toISOString()).toBe(sentAt.toISOString());
  });
});

describe('Web の文脈・端末名 (recordWebLoginContext・setCurrentDeviceName §13.1・§13.5)', () => {
  const webInput = (userId: string, sessionId: string) => ({
    userId,
    sessionId,
    ipAddress: '203.0.113.77',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36',
    countryCode: 'JP',
  });

  it('recordWebLoginContext は context_source が auth で alert_status が pending の行を web にして true を返す。終わった (revoked_at の入った) pending の行も上書きする。alert_status を processing・done にした行と、context_source が mobile の行は変えずに false を返す。行の無い session_id (新しい UUID) でも false を返す (§10)', async () => {
    const user = await createUser('web-guard');
    const pending = await signIn(user.email);
    const ended = await signIn(user.email);
    await ended.client.auth.signOut({ scope: 'local' });
    const processing = await signIn(user.email);
    const done = await signIn(user.email);
    const mobile = await signIn(user.email);
    await pgQuery(`UPDATE public.user_sessions_metadata SET alert_status = 'processing', alert_claimed_at = now() WHERE session_id = '${processing.sessionId}'`);
    await pgQuery(`UPDATE public.user_sessions_metadata SET alert_status = 'done' WHERE session_id = '${done.sessionId}'`);
    await pgQuery(`UPDATE public.user_sessions_metadata SET context_source = 'mobile' WHERE session_id = '${mobile.sessionId}'`);

    expect(await recordWebLoginContext(srAdmin, webInput(user.id, pending.sessionId))).toBe(true);
    expect((await metaRow(pending.sessionId))!.context_source).toBe('web');
    expect(await recordWebLoginContext(srAdmin, webInput(user.id, ended.sessionId))).toBe(true);
    expect((await metaRow(ended.sessionId))!.context_source).toBe('web');
    for (const device of [processing, done, mobile]) {
      const before = (await metaRow(device.sessionId))!;
      expect(await recordWebLoginContext(srAdmin, webInput(user.id, device.sessionId))).toBe(false);
      expect(await metaRow(device.sessionId)).toEqual(before);
    }
    expect(await recordWebLoginContext(srAdmin, webInput(user.id, randomUUID()))).toBe(false);
  });

  it('recordWebLoginContext は context_source = auth の行を web にして IP・ip_network・UA・国を書き true、context_source = mobile の行 (端末名あり) と web の行は変えずに false (§10 の recordWebLoginContext の行のガード)', async () => {
    const user = await createUser('web-write');
    const device = await signIn(user.email);
    const input = webInput(user.id, device.sessionId);
    expect(await recordWebLoginContext(srAdmin, input)).toBe(true);
    expect((await metaRow(device.sessionId))!).toMatchObject({
      context_source: 'web',
      ip_address: '203.0.113.77',
      ip_network: '203.0.113.0/24',
      user_agent: input.userAgent,
      country_code: 'JP',
    });
    // 既に web の行はもう一度は上書きしない
    expect(await recordWebLoginContext(srAdmin, { ...input, ipAddress: '198.51.100.1' })).toBe(false);
    expect((await metaRow(device.sessionId))!.ip_address).toBe('203.0.113.77');
    // 端末名を登録した mobile の行も変えない
    const phone = await signIn(user.email);
    expect(await setCurrentDeviceName(srAdmin, { userId: user.id, sessionId: phone.sessionId, deviceName: 'iPhone 15 Pro (iOS 18.0)' })).toBe(true);
    const before = (await metaRow(phone.sessionId))!;
    expect(await recordWebLoginContext(srAdmin, webInput(user.id, phone.sessionId))).toBe(false);
    expect(await metaRow(phone.sessionId)).toEqual(before);
  });

  it('setCurrentDeviceName は本人の行に device_name と context_source = mobile を書き、他人の session_id では false', async () => {
    const user = await createUser('device-name');
    const other = await createUser('device-name-other');
    const device = await signIn(user.email);
    const othersDevice = await signIn(other.email);
    expect(await setCurrentDeviceName(srAdmin, { userId: user.id, sessionId: device.sessionId, deviceName: 'Pixel 8 (Android 14)' })).toBe(true);
    expect((await metaRow(device.sessionId))!).toMatchObject({ device_name: 'Pixel 8 (Android 14)', context_source: 'mobile' });
    expect(await setCurrentDeviceName(srAdmin, { userId: user.id, sessionId: othersDevice.sessionId, deviceName: 'x' })).toBe(false);
    expect((await metaRow(othersDevice.sessionId))!).toMatchObject({ device_name: null, context_source: 'auth' });
  });
});

describe('migration の目印の間をもう一度流す (冪等 §11.2・§11.3)', () => {
  function block(begin: string, end: string): string {
    const start = RAW_MIGRATION.indexOf(begin);
    const stop = RAW_MIGRATION.indexOf(end);
    if (start < 0 || stop <= start) throw new Error(`目印 ${begin} / ${end} が migration にありません`);
    return RAW_MIGRATION.slice(start + begin.length, stop);
  }

  it('migration の [cross16-backfill:begin] と [cross16-backfill:end] の間 (§11.2) を切り出し、ローカルの postgres-meta でもう一度流しても、user_sessions_metadata と password_history の行数は変わらない (冪等)', async () => {
    const user = await createUser('backfill');
    await signIn(user.email);
    await signIn(user.email);
    const ids = createdUserIds.map((id) => `'${id}'`).join(', ');
    const metaBefore = await countOf(`SELECT count(*) AS n FROM public.user_sessions_metadata WHERE user_id IN (${ids})`);
    const historyBefore = await countOf(`SELECT count(*) AS n FROM public.password_history WHERE user_id IN (${ids})`);
    await pgQuery(block('-- [cross16-backfill:begin]', '-- [cross16-backfill:end]'));
    expect(await countOf(`SELECT count(*) AS n FROM public.user_sessions_metadata WHERE user_id IN (${ids})`)).toBe(metaBefore);
    expect(await countOf(`SELECT count(*) AS n FROM public.password_history WHERE user_id IN (${ids})`)).toBe(historyBefore);
    // 写しの行は通知の対象にならない (done)・トリガーの行は pending のまま
    expect((await metaRows(user.id)).map((r) => r.alert_status)).toEqual(['pending', 'pending']);
  });

  it('migration の [cross16-auth-triggers:begin] と [cross16-auth-triggers:end] の間 (§11.3 の auth の表のトリガーを作る DO ブロック) を切り出し、pgQuery でもう一度流しても失敗せず、pg_trigger の on_auth_session_created・on_auth_session_refreshed・on_auth_session_deleted (auth.sessions)・on_auth_user_password_changed (auth.users) は 1 本ずつのまま (同じ名前があれば作らない)', async () => {
    await pgQuery(block('-- [cross16-auth-triggers:begin]', '-- [cross16-auth-triggers:end]'));
    const rows = await pgQuery<{ rel: string; tgname: string; n: number | string }>(`
      SELECT t.tgrelid::regclass::text AS rel, t.tgname, count(*) AS n
        FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid IN ('auth.sessions'::regclass, 'auth.users'::regclass) AND NOT t.tgisinternal
         AND t.tgname IN ('on_auth_session_created', 'on_auth_session_refreshed', 'on_auth_session_deleted', 'on_auth_user_password_changed')
       GROUP BY 1, 2 ORDER BY 2`);
    expect(rows.map((r) => ({ rel: r.rel, tgname: r.tgname, n: Number(r.n) }))).toEqual([
      { rel: 'auth.sessions', tgname: 'on_auth_session_created', n: 1 },
      { rel: 'auth.sessions', tgname: 'on_auth_session_deleted', n: 1 },
      { rel: 'auth.sessions', tgname: 'on_auth_session_refreshed', n: 1 },
      { rel: 'auth.users', tgname: 'on_auth_user_password_changed', n: 1 },
    ]);
  });
});

describe('記録の失敗で本体の操作を止めない (R-13・S-20)', () => {
  it('記録の失敗でログインを止めない: user_sessions_metadata に CHECK (false) NOT VALID を足した間、プロフィールの行がある利用者のパスワードのサインインは成功し、auth.sessions にその session_id の行があり、user_sessions_metadata にはその行が無く、user_profiles.login_count は増えない', async () => {
    const user = await createUser('r13-signin', { profile: true });
    let device: Device | null = null;
    try {
      await pgQuery(`ALTER TABLE public.user_sessions_metadata ADD CONSTRAINT ${FORCE_FAIL_CONSTRAINT} CHECK (false) NOT VALID`);
      device = await signIn(user.email);
      expect(await tokenState(device.accessToken, user.id)).toBe('alive');
      expect(await authSessionExists(device.sessionId)).toBe(true);
      expect(await metaRow(device.sessionId)).toBeUndefined();
      expect((await profileStats(user.id)).login_count).toBe(0);
    } finally {
      await pgQuery(`ALTER TABLE public.user_sessions_metadata DROP CONSTRAINT IF EXISTS ${FORCE_FAIL_CONSTRAINT}`);
      // 記録の無いセッションを残さない (ほかの it の写し・reconcile の数に混ざらないように)
      if (device) await srAdmin.auth.admin.signOut(device.accessToken, 'global');
    }
  });

  it('記録の失敗で更新 (refresh)・ログアウトを止めない (auth_session_refreshed・auth_session_deleted): 行がある状態で制約を足した間に、refreshSession は新しい session を返し、auth.sessions の refreshed_at は変わるが、user_sessions_metadata の last_active_at は控えた値のまま。続けて signOut (global) も成功し、auth.sessions の行は消え、user_sessions_metadata の行は revoked_at も ended_reason も NULL のまま', async () => {
    const user = await createUser('r13-refresh');
    const device = await signIn(user.email);
    const before = (await metaRow(device.sessionId))!;
    expect(before.revoked_at).toBeNull();
    const refreshedBefore = await pgQuery<{ refreshed_at: string | null }>(`SELECT refreshed_at FROM auth.sessions WHERE id = '${device.sessionId}'`);
    try {
      await pgQuery(`ALTER TABLE public.user_sessions_metadata ADD CONSTRAINT ${FORCE_FAIL_CONSTRAINT} CHECK (false) NOT VALID`);
      const { data, error } = await client(anonKey).auth.refreshSession({ refresh_token: device.refreshToken });
      expect(error).toBeNull();
      expect(data.session).not.toBeNull();
      const refreshedAfter = await pgQuery<{ refreshed_at: string | null }>(`SELECT refreshed_at FROM auth.sessions WHERE id = '${device.sessionId}'`);
      expect(refreshedAfter[0].refreshed_at).not.toBeNull();
      expect(refreshedAfter[0].refreshed_at).not.toBe(refreshedBefore[0].refreshed_at);
      expect((await metaRow(device.sessionId))!.last_active_at).toBe(before.last_active_at);

      const signOut = await srAdmin.auth.admin.signOut(data.session!.access_token, 'global');
      expect(signOut.error).toBeNull();
      expect(await authSessionExists(device.sessionId)).toBe(false);
      expect((await metaRow(device.sessionId))!).toMatchObject({ revoked_at: null, ended_reason: null });
    } finally {
      await pgQuery(`ALTER TABLE public.user_sessions_metadata DROP CONSTRAINT IF EXISTS ${FORCE_FAIL_CONSTRAINT}`);
    }
  });

  it('履歴の記録の失敗でパスワードの更新を止めない: password_history に CHECK (false) NOT VALID を足した間、updatePasswordWithAccessToken は error が null で、auth.users.encrypted_password は変わり、password_history の行数は変わらない', async () => {
    const user = await createUser('r13-history');
    const device = await signIn(user.email);
    const hashBefore = await encryptedPassword(user.id);
    const countBefore = await historyCount(user.id);
    try {
      await pgQuery(`ALTER TABLE public.password_history ADD CONSTRAINT ${FORCE_FAIL_CONSTRAINT} CHECK (false) NOT VALID`);
      const result = await updatePasswordWithAccessToken(device.accessToken, `${PASSWORD}-r13`, null);
      expect(result).toEqual({ error: null });
      expect(await encryptedPassword(user.id)).not.toBe(hashBefore);
      expect(await historyCount(user.id)).toBe(countBefore);
    } finally {
      await pgQuery(`ALTER TABLE public.password_history DROP CONSTRAINT IF EXISTS ${FORCE_FAIL_CONSTRAINT}`);
    }
  });

  it('ログインの数の補完の失敗でプロフィールの行の作成を止めない: REVOKE SELECT ON public.user_sessions_metadata FROM service_role をした間、service_role の client で user_profiles に行を INSERT すると、error 無しで行ができ、last_login_at は NULL のまま', async () => {
    const user = await createUser('r13-fill');
    await signIn(user.email);
    expect(await metaCount(user.id)).toBe(1);
    try {
      await pgQuery('REVOKE SELECT ON public.user_sessions_metadata FROM service_role');
      const { error } = await srAdmin
        .from('user_profiles')
        .insert({ id: user.id, nickname: 'Guest', age_group: 'unspecified', gender: 'unspecified' });
      expect(error).toBeNull();
    } finally {
      await pgQuery('GRANT SELECT ON public.user_sessions_metadata TO service_role');
    }
    const stats = await profileStats(user.id);
    expect(stats).toBeDefined();
    expect(stats.last_login_at).toBeNull();
  });
});
