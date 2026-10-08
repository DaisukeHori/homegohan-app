/**
 * 外国の AI 事業者への提供の同意 (T15 / #1154): 記録・状況・撤回を、本物の DB (PostgREST + RLS + 部分ユニーク索引) で確かめる
 *
 * 単体テスト (src/__tests__/lib/ai/consent.test.ts, tests/api/ai-consent-route.test.ts) は、列を知っているフェイクの上で
 * 検証している。このテストは同じ関数 (src/lib/ai/consent.ts) を、本物のローカル Supabase に向けて動かし、
 * フェイクと本物の食い違いで見落とすものを拾う:
 *   - `.is('revoked_at', null)` の絞り込み、`update().select('id')` の戻り、inet 列への IP アドレス (IPv4 / IPv6)
 *   - 部分ユニーク索引 idx_ext_consents_active に弾かれたときのエラーコード (23505) が supabase-js まで届くこと
 *   - 同時に 2 回押されても、有効な行は (user_id, provider) ごとに 1 件に収まること
 *   - 利用者本人のセッション (RLS) で、自分の行だけが読めること。他人の user_id を指定しても何も見えないこと
 *   - 撤回しても行は残り (監査のため)、撤回のあとに同意し直せること (拒否の行を作らない設計の裏返し)
 *
 * 書き込み (grant / revoke) は service role、読み取りは本人のセッション (本番の route と同じ使い分け)。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/ai-consent-flow.test.ts
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import {
  AI_CONSENT_PROVIDERS,
  AI_CONSENT_VERSION,
  getAiConsentStatus,
  grantAiConsent,
  revokeAiConsent,
} from '@/lib/ai/consent';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

function makeClient(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

/** サーバーの書き込み用 (service role)。本番の route では getSupabaseAdmin() */
const srAdmin = makeClient(serviceKey);

const TABLE = 'external_data_consents';
const TS = Date.now();
const PASSWORD = 'TestPass!2026-ai-consent';

interface TestUser {
  id: string;
  /** 本人のセッションのクライアント (RLS が効く)。本番の route では createClient() */
  client: SupabaseClient;
}

const createdUserIds: string[] = [];

async function createTestUser(label: string): Promise<TestUser> {
  const email = `ai-consent-flow-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);

  const signIn = await makeClient(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, client: makeClient(anonKey, signIn.data.session.access_token) };
}

interface Row {
  id: string;
  user_id: string;
  provider: string;
  consented: boolean;
  consented_at: string;
  revoked_at: string | null;
  policy_version: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

/** service role で、ユーザーの行を全部読む (古い順) */
async function rowsOf(userId: string): Promise<Row[]> {
  const { data, error } = await srAdmin
    .from(TABLE)
    .select('id, user_id, provider, consented, consented_at, revoked_at, policy_version, ip_address, user_agent')
    .eq('user_id', userId)
    .order('consented_at', { ascending: true })
    .order('provider', { ascending: true });
  if (error) throw new Error(`rowsOf: ${error.message}`);
  return (data ?? []) as Row[];
}

const activeRows = (rows: Row[]) => rows.filter((r) => r.revoked_at === null);

/** service role で行を足す (フィクスチャ用。route を通さない状態を作る) */
async function seedRow(userId: string, provider: string, fields: Record<string, unknown> = {}) {
  const { error } = await srAdmin
    .from(TABLE)
    .insert({ user_id: userId, provider, consented: true, ip_address: '203.0.113.50', user_agent: 'seed-ua', ...fields });
  if (error) throw new Error(`seedRow ${provider}: ${error.message}`);
}

async function clearRows(userId: string) {
  const { error } = await srAdmin.from(TABLE).delete().eq('user_id', userId);
  if (error) throw new Error(`clearRows: ${error.message}`);
}

let userA: TestUser;
let userB: TestUser;

beforeAll(async () => {
  userA = await createTestUser('a');
  userB = await createTestUser('b');
}, 60_000);

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // このテストのユーザーの行だけを消す (ほかの同意記録は消さない)
    await srAdmin.from(TABLE).delete().in('user_id', createdUserIds);
    const { data: left } = await srAdmin.from(TABLE).select('id').in('user_id', createdUserIds);
    expect(left ?? []).toEqual([]);
  }
  for (const id of createdUserIds) await srAdmin.auth.admin.deleteUser(id);
}, 30_000);

const input = (userId: string, overrides: Record<string, unknown> = {}) => ({
  userId,
  ipAddress: '203.0.113.5',
  userAgent: 'Mozilla/5.0 ai-consent-flow',
  ...overrides,
});

describe('grantAiConsent / getAiConsentStatus: 実 DB', () => {
  it('同意: 3 事業者ぶんの行が、版・IP アドレス・User-Agent つきで作られ、本人のセッションで読める', async () => {
    await clearRows(userA.id);

    const status = await grantAiConsent(input(userA.id), srAdmin);

    expect(status).toMatchObject({ version: AI_CONSENT_VERSION, consented: true, revokedAt: null });
    const rows = await rowsOf(userA.id);
    expect(rows.map((r) => r.provider).sort()).toEqual([...AI_CONSENT_PROVIDERS].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        consented: true,
        revoked_at: null,
        policy_version: AI_CONSENT_VERSION,
        ip_address: '203.0.113.5',
        user_agent: 'Mozilla/5.0 ai-consent-flow',
      });
    }

    // 本番の GET /api/ai/consent と同じ: 本人のセッションのクライアントで読む
    const own = await getAiConsentStatus(userA.id, userA.client);
    expect(own.consented).toBe(true);
    expect(own.providers.map((p) => p.state)).toEqual(AI_CONSENT_PROVIDERS.map(() => 'granted'));
  });

  it('RLS: 別のユーザーのセッションでは、他人の user_id を指定しても、同意は見えない (未同意に見える)', async () => {
    await clearRows(userA.id);
    await grantAiConsent(input(userA.id), srAdmin);

    const asB = await getAiConsentStatus(userA.id, userB.client);

    expect(asB.consented).toBe(false);
    expect(asB.providers.every((p) => p.state === 'none')).toBe(true);
  });

  it('IPv6 の IP アドレスも inet 列に入る。IP アドレスが取れなかったとき (null) も同意は記録される', async () => {
    await clearRows(userA.id);
    await grantAiConsent(input(userA.id, { ipAddress: '2001:db8::1' }), srAdmin);
    expect((await rowsOf(userA.id)).every((r) => r.ip_address === '2001:db8::1')).toBe(true);

    await clearRows(userA.id);
    await grantAiConsent(input(userA.id, { ipAddress: null, userAgent: null }), srAdmin);
    const rows = await rowsOf(userA.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ip_address === null && r.user_agent === null && r.consented)).toBe(true);
  });

  it('冪等: 同じ版への同意を何度記録しても行は増えず、最初の日時・IP アドレスが残る', async () => {
    await clearRows(userA.id);
    await grantAiConsent(input(userA.id, { ipAddress: '203.0.113.5' }), srAdmin);
    const first = await rowsOf(userA.id);

    const again = await grantAiConsent(input(userA.id, { ipAddress: '198.51.100.9' }), srAdmin);

    expect(again.consented).toBe(true);
    expect(await rowsOf(userA.id)).toEqual(first);
  });

  it('同時に 2 回押されても (部分ユニーク索引の 23505)、例外にならず、有効な行は事業者ごとに 1 件', async () => {
    await clearRows(userB.id);

    const [x, y] = await Promise.all([
      grantAiConsent(input(userB.id), srAdmin),
      grantAiConsent(input(userB.id), srAdmin),
    ]);

    expect(x.consented).toBe(true);
    expect(y.consented).toBe(true);
    const rows = await rowsOf(userB.id);
    expect(activeRows(rows)).toHaveLength(AI_CONSENT_PROVIDERS.length);
    expect(new Set(activeRows(rows).map((r) => r.provider)).size).toBe(AI_CONSENT_PROVIDERS.length);
  });

  it('文面の版が変わったあと (古い版への同意が残っている): outdated になり、再同意で古い行を閉じて新しい行を作る', async () => {
    await clearRows(userA.id);
    for (const provider of AI_CONSENT_PROVIDERS) await seedRow(userA.id, provider, { policy_version: 'older-version' });

    const before = await getAiConsentStatus(userA.id, userA.client);
    expect(before.consented).toBe(false);
    expect(before.providers.map((p) => p.state)).toEqual(AI_CONSENT_PROVIDERS.map(() => 'outdated'));

    const after = await grantAiConsent(input(userA.id), srAdmin);

    expect(after.consented).toBe(true);
    const rows = await rowsOf(userA.id);
    expect(rows).toHaveLength(AI_CONSENT_PROVIDERS.length * 2);
    // 古い行は消さず、revoked_at を入れて履歴として残す
    expect(rows.filter((r) => r.policy_version === 'older-version').every((r) => r.revoked_at !== null)).toBe(true);
    expect(activeRows(rows).every((r) => r.policy_version === AI_CONSENT_VERSION && r.consented)).toBe(true);
  });

  it('版が無い行 (policy_version = NULL。版を記録する前の行) も outdated。再同意で置き換わる', async () => {
    await clearRows(userA.id);
    for (const provider of AI_CONSENT_PROVIDERS) await seedRow(userA.id, provider);

    const before = await getAiConsentStatus(userA.id, userA.client);
    expect(before.providers.map((p) => p.state)).toEqual(AI_CONSENT_PROVIDERS.map(() => 'outdated'));
    expect(before.providers.every((p) => p.policyVersion === null)).toBe(true);

    expect((await grantAiConsent(input(userA.id), srAdmin)).consented).toBe(true);
  });

  it('古い版からの再同意を同時に 2 回押しても、有効な行は事業者ごとに 1 件 (閉じる更新も重ならない)', async () => {
    await clearRows(userB.id);
    for (const provider of AI_CONSENT_PROVIDERS) await seedRow(userB.id, provider, { policy_version: 'older-version' });

    const results = await Promise.all([
      grantAiConsent(input(userB.id), srAdmin),
      grantAiConsent(input(userB.id), srAdmin),
    ]);

    expect(results.every((r) => r.consented)).toBe(true);
    const active = activeRows(await rowsOf(userB.id));
    expect(active).toHaveLength(AI_CONSENT_PROVIDERS.length);
    expect(active.every((r) => r.policy_version === AI_CONSENT_VERSION)).toBe(true);
  });

  it('拒否の行 (consented = false の有効な行) があっても、同意として数えない。再同意で閉じて同意の行を作る', async () => {
    await clearRows(userA.id);
    await seedRow(userA.id, 'xai', { consented: false, policy_version: AI_CONSENT_VERSION });

    const before = await getAiConsentStatus(userA.id, userA.client);
    expect(before.consented).toBe(false);
    expect(before.providers.find((p) => p.provider === 'xai')?.state).toBe('none');

    expect((await grantAiConsent(input(userA.id), srAdmin)).consented).toBe(true);
    const xai = (await rowsOf(userA.id)).filter((r) => r.provider === 'xai');
    expect(xai).toHaveLength(2);
    expect(xai.find((r) => !r.consented)?.revoked_at).not.toBeNull();
    expect(activeRows(xai).every((r) => r.consented)).toBe(true);
  });
});

describe('revokeAiConsent: 実 DB', () => {
  it('撤回: 有効な行に revoked_at を入れる。行は残る。他人の行には触れない', async () => {
    await clearRows(userA.id);
    await clearRows(userB.id);
    await grantAiConsent(input(userA.id), srAdmin);
    await grantAiConsent(input(userB.id), srAdmin);

    const { revokedCount } = await revokeAiConsent(userA.id, srAdmin);

    expect(revokedCount).toBe(AI_CONSENT_PROVIDERS.length);
    const a = await rowsOf(userA.id);
    expect(a).toHaveLength(AI_CONSENT_PROVIDERS.length);
    expect(a.every((r) => r.revoked_at !== null)).toBe(true);
    expect(activeRows(await rowsOf(userB.id))).toHaveLength(AI_CONSENT_PROVIDERS.length);

    const status = await getAiConsentStatus(userA.id, userA.client);
    expect(status.consented).toBe(false);
    expect(status.providers.every((p) => p.state === 'none')).toBe(true);
    expect(status.revokedAt).toEqual(expect.any(String));
  });

  it('有効な同意が無ければ、何も書かずに 0 件。すでに撤回した行の日時は書き換えない', async () => {
    await clearRows(userA.id);
    await grantAiConsent(input(userA.id), srAdmin);
    await revokeAiConsent(userA.id, srAdmin);
    const before = await rowsOf(userA.id);

    const { revokedCount } = await revokeAiConsent(userA.id, srAdmin);

    expect(revokedCount).toBe(0);
    expect(await rowsOf(userA.id)).toEqual(before);
  });

  it('撤回のあとに同意し直せる (部分ユニーク索引は、撤回した行を数えない)。古い行は履歴として残る', async () => {
    await clearRows(userA.id);
    await grantAiConsent(input(userA.id), srAdmin);
    await revokeAiConsent(userA.id, srAdmin);

    const status = await grantAiConsent(input(userA.id, { ipAddress: '198.51.100.20' }), srAdmin);

    expect(status.consented).toBe(true);
    const rows = await rowsOf(userA.id);
    expect(rows).toHaveLength(AI_CONSENT_PROVIDERS.length * 2);
    expect(activeRows(rows).every((r) => r.ip_address === '198.51.100.20')).toBe(true);
    expect(rows.filter((r) => r.revoked_at !== null).every((r) => r.ip_address === '203.0.113.5')).toBe(true);
  });
});
