/**
 * #1306 awardBadge (src/lib/badges/awardBadge.ts) の実 DB での回帰テスト
 *
 * 修正前は badges から存在しない列 icon_url を select していた (実列は icon)。PostgREST は 42703 を返すが、
 * supabase-js は { data: null, error } を返すだけで、error を見ていなかったため「バッジが無い」と区別できず、
 * planner バッジが常に付与されなかった (POST /api/menu-plans/add の badge_awarded が常に null)。
 * 単体テスト (src/__tests__/lib/badges/award-badge.test.ts) は本番スキーマを模したフェイクを使う。
 * ここでは実クライアントで、ローカル Supabase (本番スキーマのベースライン) の badges / user_badges に対して
 * awardBadge をそのまま呼び、次を確かめる。
 *   - 付与できる: user_badges に 1 行入り、icon_url は badges.icon の値 (修正前は付与されず awarded: false だった)
 *   - 2 回目は重複して付与せず、獲得日時も変わらない
 *   - 同時に 2 回呼んでも、付与されるのは 1 回だけで、行も 1 件 (主キー重複 23505 は例外にしない)
 *   - マスターに無い code は付与せず、例外にもならない。警告は app_logs に構造化ログとして残る
 *   - セッションの client (user_badges に INSERT ポリシーが無く RLS で 42501) だと、握りつぶさず例外にして
 *     error ログを app_logs に残す (修正前は error を見ていなかった)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/award-badge.test.ts
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, afterAll } from 'vitest';
import ws from 'ws';
import { awardBadge } from '@/lib/badges/awardBadge';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);

const TS = Date.now();
const createdUserIds: string[] = [];

interface TestUser {
  id: string;
  email: string;
  password: string;
}

async function createUser(label: string): Promise<TestUser> {
  const email = `sec-award-badge-${label}-${TS}@homegohan.test`;
  const password = randomBytes(16).toString('hex');
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email, password };
}

interface BadgeMaster {
  id: string;
  name: string;
  icon: string | null;
}

async function readMaster(code: string): Promise<BadgeMaster> {
  const { data, error } = await srAdmin.from('badges').select('id, name, icon').eq('code', code).single();
  if (error || !data) {
    throw new Error(`badges マスタに ${code} がありません (supabase/baseline/prod_reference_data.sql を確認): ${error?.message}`);
  }
  return data as BadgeMaster;
}

async function userBadgeRows(userId: string): Promise<Array<{ badge_id: string; obtained_at: string }>> {
  const { data, error } = await srAdmin.from('user_badges').select('badge_id, obtained_at').eq('user_id', userId);
  if (error) throw new Error(`user_badges: ${error.message}`);
  return (data ?? []) as Array<{ badge_id: string; obtained_at: string }>;
}

interface LogRow {
  level: string;
  source: string;
  function_name: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
}

/** ログは非同期 (待たずに) app_logs へ書かれるので、出るまで少し待つ */
async function waitForAwardBadgeLogs(userId: string): Promise<LogRow[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { data, error } = await srAdmin
      .from('app_logs')
      .select('level, source, function_name, message, metadata')
      .eq('user_id', userId)
      .eq('function_name', 'award-badge');
    if (error) throw new Error(`app_logs: ${error.message}`);
    if (data && data.length > 0) return data as LogRow[];
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return [];
}

afterAll(async () => {
  if (createdUserIds.length === 0) return;
  // user_badges / user_profiles は auth ユーザーの削除で連鎖削除される。app_logs は user_id が NULL になるだけなので先に消す
  await srAdmin.from('app_logs').delete().eq('function_name', 'award-badge').in('user_id', createdUserIds);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
  const { data: leftBadges } = await srAdmin.from('user_badges').select('user_id').in('user_id', createdUserIds);
  expect(leftBadges ?? []).toEqual([]);
}, 60_000);

describe('#1306 awardBadge (実 DB)', () => {
  it('J-1: planner を付与できる。user_badges に 1 行入り、icon_url は badges.icon の値になる (修正前は awarded: false だった)', async () => {
    const user = await createUser('grant');
    const master = await readMaster('planner');
    // icon_url が null のままだと、列名の取り違えを見分けられない
    expect(master.icon, 'planner に icon が必要 (supabase/baseline/prod_reference_data.sql)').toBeTruthy();

    const result = await awardBadge(srAdmin, user.id, 'planner');

    expect(result.awarded).toBe(true);
    expect(result.badge_id).toBe(master.id);
    expect(result.name).toBe(master.name);
    expect(result.icon_url).toBe(master.icon);
    expect(result.obtained_at).toBeTruthy();

    const rows = await userBadgeRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].badge_id).toBe(master.id);
    expect(new Date(rows[0].obtained_at).getTime()).toBe(new Date(result.obtained_at!).getTime());
  });

  it('J-2: 2 回目は重複して付与せず、獲得日時と icon_url は 1 回目のまま', async () => {
    const user = await createUser('repeat');

    const first = await awardBadge(srAdmin, user.id, 'planner');
    const second = await awardBadge(srAdmin, user.id, 'planner');

    expect(first.awarded).toBe(true);
    expect(second.awarded).toBe(false);
    expect(second.badge_id).toBe(first.badge_id);
    expect(second.name).toBe(first.name);
    expect(second.icon_url).toBe(first.icon_url);
    expect(new Date(second.obtained_at!).getTime()).toBe(new Date(first.obtained_at!).getTime());
    expect(await userBadgeRows(user.id)).toHaveLength(1);
  });

  it('J-3: 同時に 2 回呼んでも、付与されるのは 1 回だけで、行も 1 件 (どちらも例外にならない)', async () => {
    const user = await createUser('race');

    const results = await Promise.all([
      awardBadge(srAdmin, user.id, 'planner'),
      awardBadge(srAdmin, user.id, 'planner'),
    ]);

    expect(results.filter((r) => r.awarded)).toHaveLength(1);
    expect(await userBadgeRows(user.id)).toHaveLength(1);
  });

  it('J-4: マスターに無い code は付与せず、例外にもならない。警告が app_logs に構造化ログとして残る', async () => {
    const user = await createUser('unknown');

    const result = await awardBadge(srAdmin, user.id, 'no_such_badge_1306');

    expect(result).toEqual({ awarded: false, badge_id: null, obtained_at: null, name: null, icon_url: null });
    expect(await userBadgeRows(user.id)).toEqual([]);

    const logs = await waitForAwardBadgeLogs(user.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warn', source: 'api-route', function_name: 'award-badge' });
    expect(logs[0].metadata).toMatchObject({ badge_code: 'no_such_badge_1306' });
  });

  it('J-5: セッションの client (RLS で user_badges に書けない 42501) だと、握りつぶさず例外にして error ログを残す', async () => {
    const user = await createUser('rls');
    const signIn = await client(anonKey).auth.signInWithPassword({ email: user.email, password: user.password });
    if (signIn.error || !signIn.data.session) throw new Error(`signIn: ${signIn.error?.message}`);
    const sessionClient = client(anonKey, signIn.data.session.access_token);

    // badges は誰でも読める。user_badges の確認 (本人の行の SELECT) までは通り、INSERT で RLS に拒否される
    await expect(awardBadge(sessionClient, user.id, 'planner')).rejects.toMatchObject({ code: '42501' });
    expect(await userBadgeRows(user.id)).toEqual([]);

    const logs = await waitForAwardBadgeLogs(user.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'error', source: 'api-route', function_name: 'award-badge' });
    expect(logs[0].metadata).toMatchObject({ badge_code: 'planner', error_code: '42501' });
  });
});
