/**
 * #1175 POST /api/account/delete の結合テスト (実際の HTTP。Bearer JWT。Next の dev サーバが要る)
 *
 * 退会の本体 (deleteAccount) の細かい確認は account-deletion.test.ts。ここは route の入口と、
 * 本物の認証・本物の DB・本物の Storage を通した流れを確かめる。
 *   A. 未ログインは 401、confirm が無ければ 400。どちらも何も消さない
 *   B. 組織のオーナーは 409 ACCOUNT_DELETE_BLOCKED_ORG_OWNER (従来と同じ形)。アカウントも行も残る
 *   C. 外部キーに ON DELETE の指定が無かった表 (support_tickets / nps_surveys / email_delivery_logs) に行がある利用者でも、
 *      200 { success: true } で退会できる。
 *        - 本人だけの記録 (nps_surveys) は消え、サポートの記録 (support_tickets) は行が残って user_id が NULL になる
 *        - メール配信ログの宛先 (本人の生のメールアドレス) が伏せられる
 *        - Storage の <user_id>/ 以下のファイルが消える
 *        - 退会したあと、同じトークンで呼ぶと 401
 *
 * 修正前 (migration を流す前) に流すと、C が 500 (本体は ACCOUNT_DELETE_FAILED。prepare_account_deletion が無い) で失敗する。
 * 退会は外部キーの違反では失敗しなくなったので、migration のあとは C が通る。
 *
 * 実行 (ローカル Supabase と Next の dev サーバが必要):
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev   # 別のターミナルで
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/account-delete-route.test.ts
 *   (dev サーバが 3000 番以外のときは INTEGRATION_BASE_URL=http://localhost:<port> を付ける)
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { apiCall } from '../helpers/api';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

// ユーザーを消すテストなので、本番や共有環境へ誤って向けない (ローカルのスタックだけを対象にする)
const supabaseHost = new URL(url).hostname;
if (supabaseHost !== 'localhost' && supabaseHost !== '127.0.0.1') {
  throw new Error(`NEXT_PUBLIC_SUPABASE_URL はローカルの Supabase を指してください (現在のホスト: ${supabaseHost})`);
}

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);

/** ローカルスタックの postgres-meta で SQL を実行する (行の作成・確認・後片付けにだけ使う) */
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

const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
const RUN = randomBytes(4).toString('hex');
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const MASKED_EMAIL = 'redacted@redacted.invalid';

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const createdUserIds: string[] = [];

async function createUser(label: string): Promise<TestUser> {
  const email = `t11-route-${label}-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `t11-route-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // 共有の srAdmin でサインインすると以後の要求がこのユーザーの JWT で送られてしまうので、使い捨てのクライアントで行う
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function count(table: string, where: string): Promise<number> {
  const rows = await pgQuery<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`);
  return rows[0].n;
}

async function userExists(userId: string): Promise<boolean> {
  const { data } = await srAdmin.auth.admin.getUserById(userId);
  return Boolean(data.user);
}

async function storageHas(path: string): Promise<boolean> {
  const slash = path.lastIndexOf('/');
  const { data, error } = await srAdmin.storage
    .from('fridge-images')
    .list(path.slice(0, slash), { limit: 100, search: path.slice(slash + 1) });
  if (error) throw new Error(`list: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === path.slice(slash + 1) && entry.id != null);
}

const ids = { org: randomUUID(), ticket: randomUUID(), nps: randomUUID(), log: randomUUID() };
let owner: TestUser;
let member: TestUser;
const memberFile = () => `${member.id}/route-${RUN}.png`;

beforeAll(async () => {
  owner = await createUser('owner');
  member = await createUser('member');
  await pgQuery(`
    insert into public.organizations (id, name, owner_id) values (${q(ids.org)}, ${q(`t11 route org ${RUN}`)}, ${q(owner.id)});
    insert into public.support_tickets (id, user_id, subject, category) values (${q(ids.ticket)}, ${q(member.id)}, ${q(`t11 route ticket ${RUN}`)}, 'account');
    insert into public.nps_surveys (id, user_id, score, sent_at) values (${q(ids.nps)}, ${q(member.id)}, 9, now());
    insert into public.email_delivery_logs (id, user_id, email, template, status) values (${q(ids.log)}, ${q(member.id)}, ${q(member.email)}, 'support_ticket_reply', 'sent');
  `);
  const upload = await srAdmin.storage
    .from('fridge-images')
    .upload(memberFile(), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { contentType: 'image/png', upsert: true });
  if (upload.error) throw new Error(`upload: ${upload.error.message}`);
}, 90_000);

afterAll(async () => {
  const statements = [
    `delete from public.email_delivery_logs where id = ${q(ids.log)}`,
    `delete from public.support_tickets where id = ${q(ids.ticket)}`,
    `delete from public.nps_surveys where id = ${q(ids.nps)}`,
    `delete from public.organizations where id = ${q(ids.org)}`,
  ];
  for (const statement of statements) {
    await pgQuery(statement).catch(() => undefined);
  }
  await srAdmin.storage.from('fridge-images').remove([memberFile()]).catch(() => undefined);
  for (const userId of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(userId).catch(() => undefined);
  }
}, 90_000);

describe('#1175 POST /api/account/delete: 入口', () => {
  it('A-1: 未ログインは 401。何も消えない', async () => {
    const res = await apiCall('POST', '/api/account/delete', null, { confirm: true });
    expect(res.status).toBe(401);
    expect(await userExists(member.id)).toBe(true);
  }, 60_000);

  it('A-2: confirm が無ければ 400。アカウントも行も残る', async () => {
    const res = await apiCall('POST', '/api/account/delete', member.jwt, {});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'confirm is required' });
    expect(await userExists(member.id)).toBe(true);
    expect(await count('support_tickets', `id = ${q(ids.ticket)} and user_id = ${q(member.id)}`)).toBe(1);
  }, 60_000);

  it('B: 組織のオーナーは 409 ACCOUNT_DELETE_BLOCKED_ORG_OWNER (従来と同じ形)。アカウントは残る', async () => {
    const res = await apiCall<Record<string, unknown>>('POST', '/api/account/delete', owner.jwt, { confirm: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'ACCOUNT_DELETE_BLOCKED_ORG_OWNER',
      message: '組織のオーナーです。先にオーナーを譲渡するか組織を解散してください。',
      organization: { id: ids.org, name: `t11 route org ${RUN}` },
    });
    expect(await userExists(owner.id)).toBe(true);
  }, 60_000);
});

describe('#1175 POST /api/account/delete: 退会', () => {
  it('C: ON DELETE の指定が無かった表に行がある利用者でも 200 { success: true } で退会でき、記録は個人を特定できない形で残る', async () => {
    expect(await storageHas(memberFile())).toBe(true);

    const res = await apiCall<Record<string, unknown>>('POST', '/api/account/delete', member.jwt, { confirm: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ success: true });

    // アカウントは消えている
    expect(await userExists(member.id)).toBe(false);
    expect(await count('user_profiles', `id = ${q(member.id)}`)).toBe(0);

    // 本人だけの記録は消え、サポートの記録は行が残って本人との紐づけだけが外れる
    expect(await count('nps_surveys', `id = ${q(ids.nps)}`)).toBe(0);
    const ticket = await pgQuery<{ user_id: string | null; subject: string }>(
      `select user_id, subject from public.support_tickets where id = ${q(ids.ticket)}`,
    );
    expect(ticket).toEqual([{ user_id: null, subject: `t11 route ticket ${RUN}` }]);

    // 生のメールアドレスはどこにも残らない (行は残る)
    const log = await pgQuery<{ user_id: string | null; email: string }>(
      `select user_id, email from public.email_delivery_logs where id = ${q(ids.log)}`,
    );
    expect(log).toEqual([{ user_id: null, email: MASKED_EMAIL }]);
    expect(await count('email_delivery_logs', `lower(email) = lower(${q(member.email)})`)).toBe(0);

    // Storage の本人のフォルダのファイルも消えている
    expect(await storageHas(memberFile())).toBe(false);
  }, 120_000);

  it('退会したあと、同じトークンでもう一度呼ぶと 401 (ユーザーが無いので認証で止まる)', async () => {
    const res = await apiCall('POST', '/api/account/delete', member.jwt, { confirm: true });
    expect(res.status).toBe(401);
  }, 60_000);
});
