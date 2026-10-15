/**
 * #1528 比較ランキングのバッジを取った期間の表 public.user_badge_period_awards の回帰テスト (実 DB)
 *   (supabase/migrations/20261015120000_user_badge_period_awards.sql)
 *
 * 背景: user_badges は (user_id, badge_id) が主キーで、同じバッジを 2 回目以降の期間で取っても記録が残らない。
 * 獲得済みのバッジの一覧 (GET /api/badges) で「どの期間に取ったか」「何回取ったか」を出すため、
 * Edge Function calculate-segment-stats の確定の回が、取った期間を 1 期間 1 行でこの表にも書く。
 *
 * 期待する挙動:
 *   - 本人は自分の行だけ読める。別のログインユーザーには見えない。anon は読めない (42501)
 *   - ログインユーザーは書けない (自分の user_id でも 42501。バッジの自己付与の防止。user_badges と同じ考え方 #1215)。
 *     UPDATE / DELETE もできない (42501)
 *   - service role は Edge Function と同じ upsert (onConflict = 主キー・ignoreDuplicates) で書け、同じ期間をやり直しても 1 行のまま。
 *     別の期間なら同じバッジでも別の行になる
 *   - 期間の種類は daily / weekly / monthly だけ (CHECK 制約。23514)
 *   - migration の写し (INSERT ... SELECT) は、user_badges の context_json に期間が入った行だけを写し、何度流しても増えない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/user-badge-period-awards.test.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

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
const anon = () => client(anonKey);

/** ローカルスタックの postgres-meta で SQL を実行する (migration の写しの文を流し直すのに使う) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(body)}`);
  return body as T[];
}

const TABLE = 'user_badge_period_awards';
const MIGRATION = path.resolve(__dirname, '../../../supabase/migrations/20261015120000_user_badge_period_awards.sql');

/** migration の写しの文 (INSERT INTO public.user_badge_period_awards ... ;) をそのまま取り出す */
function backfillStatement(): string {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const match = /INSERT INTO public\.user_badge_period_awards[\s\S]*?;/.exec(sql);
  if (!match) throw new Error('migration に写しの INSERT 文がありません');
  return match[0];
}

interface TestUser {
  userId: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = 'TestPass!2026-rls-1528';

async function createTestUser(label: string): Promise<TestUser> {
  const email = `rls-1528-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`Failed to create auth user ${email}: ${error?.message}`);
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) {
    await srAdmin.auth.admin.deleteUser(data.user.id);
    throw new Error(`Failed to sign in ${email}: ${signIn.error?.message}`);
  }
  return { userId: data.user.id, jwt: signIn.data.session.access_token };
}

let owner: TestUser;
let other: TestUser;
const badgeIds: Record<string, string> = {};
const BADGE_CODES = ['segment_rank_1', 'segment_top_10', 'improved_10'] as const;

const UPSERT_OPTIONS = { onConflict: 'user_id,badge_id,period_type,period_start', ignoreDuplicates: true };

beforeAll(async () => {
  owner = await createTestUser('owner');
  other = await createTestUser('other');
  const { data, error } = await srAdmin.from('badges').select('id, code').in('code', [...BADGE_CODES]);
  if (error) throw new Error(`badges マスタの取得に失敗: ${error.message}`);
  for (const code of BADGE_CODES) {
    const row = (data ?? []).find((b) => b.code === code);
    if (!row) throw new Error(`badges マスタに ${code} がありません (supabase/baseline/prod_reference_data.sql を確認)`);
    badgeIds[code] = row.id;
  }
}, 60_000);

afterAll(async () => {
  const userIds = [owner, other].filter(Boolean).map((u) => u.userId);
  if (userIds.length > 0) {
    await srAdmin.from(TABLE).delete().in('user_id', userIds);
    await srAdmin.from('user_badges').delete().in('user_id', userIds);
    const { data: left } = await srAdmin.from(TABLE).select('user_id').in('user_id', userIds);
    expect(left ?? []).toEqual([]);
  }
  for (const u of [owner, other]) {
    if (u?.userId) await srAdmin.auth.admin.deleteUser(u.userId);
  }
}, 30_000);

async function periodsOf(userId: string): Promise<string[]> {
  const { data, error } = await srAdmin
    .from(TABLE)
    .select('badge_id, period_type, period_start')
    .eq('user_id', userId);
  if (error) throw new Error(`periodsOf: ${error.message}`);
  return (data ?? []).map((r) => `${r.badge_id}:${r.period_type}:${r.period_start}`).sort();
}

describe('#1528 user_badge_period_awards: service role の upsert (Edge Function と同じ形)', () => {
  it('P-1: 同じ期間をやり直しても 1 行のまま。別の期間は同じバッジでも別の行になる', async () => {
    const row = (periodType: string, periodStart: string, message: string) => ({
      user_id: owner.userId,
      badge_id: badgeIds.segment_rank_1,
      period_type: periodType,
      period_start: periodStart,
      context_json: { period_type: periodType, period_start: periodStart, rank: 1 },
      message,
    });

    const first = await srAdmin.from(TABLE).upsert([row('weekly', '2026-09-28', '1 回目')], UPSERT_OPTIONS);
    expect(first.error).toBeNull();
    // 確定の回の再試行: 同じ期間。文が違っても置き換わらない
    const retry = await srAdmin.from(TABLE).upsert([row('weekly', '2026-09-28', 'やり直し')], UPSERT_OPTIONS);
    expect(retry.error).toBeNull();
    // 次の週・月の確定の回
    const next = await srAdmin
      .from(TABLE)
      .upsert([row('weekly', '2026-10-05', '2 回目'), row('monthly', '2026-09-01', '月')], UPSERT_OPTIONS);
    expect(next.error).toBeNull();

    const b = badgeIds.segment_rank_1;
    expect(await periodsOf(owner.userId)).toEqual(
      [`${b}:monthly:2026-09-01`, `${b}:weekly:2026-09-28`, `${b}:weekly:2026-10-05`].sort(),
    );
    const { data } = await srAdmin
      .from(TABLE)
      .select('message, awarded_at')
      .eq('user_id', owner.userId)
      .eq('period_start', '2026-09-28')
      .single();
    expect(data?.message).toBe('1 回目');
    expect(data?.awarded_at).toBeTruthy();
  });

  it('P-2: 期間の種類は daily / weekly / monthly だけ (all_time などは CHECK 制約で 23514)', async () => {
    const { error } = await srAdmin.from(TABLE).insert({
      user_id: owner.userId,
      badge_id: badgeIds.segment_top_10,
      period_type: 'all_time',
      period_start: '2024-01-01',
    });
    expect(error?.code).toBe('23514');
  });
});

describe('#1528 user_badge_period_awards: 読み取りは本人の行だけ。利用者は書けない', () => {
  it('P-3: 本人は自分の行を読める。別のログインユーザーには見えない。anon は読めない', async () => {
    const own = await client(anonKey, owner.jwt).from(TABLE).select('badge_id, period_type, period_start');
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBe(3);

    const others = await client(anonKey, other.jwt).from(TABLE).select('badge_id').eq('user_id', owner.userId);
    expect(others.error).toBeNull();
    expect(others.data ?? []).toEqual([]);

    const fromAnon = await anon().from(TABLE).select('badge_id').eq('user_id', owner.userId);
    expect(fromAnon.error?.code).toBe('42501');
  });

  it('P-4: ログインユーザーは自分の user_id でも書けない (42501)。UPDATE / DELETE もできない', async () => {
    const before = await periodsOf(owner.userId);
    const asOwner = client(anonKey, owner.jwt);

    const inserted = await asOwner.from(TABLE).insert({
      user_id: owner.userId,
      badge_id: badgeIds.improved_10,
      period_type: 'weekly',
      period_start: '2026-10-05',
    });
    expect(inserted.error?.code).toBe('42501');

    const updated = await asOwner.from(TABLE).update({ message: 'forged' }).eq('user_id', owner.userId);
    expect(updated.error?.code).toBe('42501');

    const deleted = await asOwner.from(TABLE).delete().eq('user_id', owner.userId);
    expect(deleted.error?.code).toBe('42501');

    expect(await periodsOf(owner.userId)).toEqual(before);
  });
});

describe('#1528 migration の写し: user_badges の context_json に期間が入った行だけを写す', () => {
  it('P-5: 期間 (daily / weekly / monthly と YYYY-MM-DD) の入った行だけを写し、流し直しても増えない', async () => {
    const { error } = await srAdmin.from('user_badges').insert([
      {
        user_id: other.userId,
        badge_id: badgeIds.segment_rank_1,
        context_json: { period_type: 'monthly', period_start: '2026-08-01', rank: 1 },
        message: '写す',
        obtained_at: '2026-09-01T00:05:00Z',
      },
      // 期間の種類が対象外 (確定の回は付けない種類)
      {
        user_id: other.userId,
        badge_id: badgeIds.segment_top_10,
        context_json: { period_type: 'all_time', period_start: '2024-01-01' },
        message: '写さない (種類)',
      },
      // 期間の無い行
      { user_id: other.userId, badge_id: badgeIds.improved_10, message: '写さない (期間なし)' },
    ]);
    expect(error).toBeNull();

    const statement = backfillStatement();
    await pgQuery(statement);
    await pgQuery(statement);

    const { data, error: readError } = await srAdmin
      .from(TABLE)
      .select('badge_id, period_type, period_start, message, awarded_at, context_json')
      .eq('user_id', other.userId);
    expect(readError).toBeNull();
    expect(data ?? []).toHaveLength(1);
    expect(data?.[0]).toMatchObject({
      badge_id: badgeIds.segment_rank_1,
      period_type: 'monthly',
      period_start: '2026-08-01',
      message: '写す',
      context_json: { period_type: 'monthly', period_start: '2026-08-01', rank: 1 },
    });
    expect(Date.parse(String(data?.[0].awarded_at))).toBe(Date.parse('2026-09-01T00:05:00Z'));
  });
});
