/**
 * #1528 比較ランキングのバッジを取った期間の表 public.user_badge_period_awards の回帰テスト (実 DB)
 *   (supabase/migrations/20261015130000_user_badge_period_awards.sql)
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
 *   - 関数 get_my_badge_period_award_summaries (GET /api/badges が呼ぶ) は、本人の行だけを、バッジごとに「取った期間の数」と
 *     「最新の期間」(付けた時刻 → 開始日 → 種類の新しい順) の 1 行にまとめる。期間の行が PostgREST の 1 回の上限 (既定 1000 行) を
 *     超える人でも、回数を打ち切らず、最新も正しい (表を行のまま読むと、黙って 1000 行で打ち切られる)。
 *     anon・service role からは呼べない (42501)
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
const MIGRATION = path.resolve(__dirname, '../../../supabase/migrations/20261015130000_user_badge_period_awards.sql');

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
/** 関数のまとめ方を確かめる専用の利用者 (ほかの describe の行と混ざらないように分ける) */
let heavy: TestUser;
const badgeIds: Record<string, string> = {};
const BADGE_CODES = ['segment_rank_1', 'segment_top_10', 'improved_10'] as const;

const UPSERT_OPTIONS = { onConflict: 'user_id,badge_id,period_type,period_start', ignoreDuplicates: true };

beforeAll(async () => {
  owner = await createTestUser('owner');
  other = await createTestUser('other');
  heavy = await createTestUser('heavy');
  const { data, error } = await srAdmin.from('badges').select('id, code').in('code', [...BADGE_CODES]);
  if (error) throw new Error(`badges マスタの取得に失敗: ${error.message}`);
  for (const code of BADGE_CODES) {
    const row = (data ?? []).find((b) => b.code === code);
    if (!row) throw new Error(`badges マスタに ${code} がありません (supabase/baseline/prod_reference_data.sql を確認)`);
    badgeIds[code] = row.id;
  }
}, 60_000);

afterAll(async () => {
  const userIds = [owner, other, heavy].filter(Boolean).map((u) => u.userId);
  if (userIds.length > 0) {
    await srAdmin.from(TABLE).delete().in('user_id', userIds);
    await srAdmin.from('user_badges').delete().in('user_id', userIds);
    const { data: left } = await srAdmin.from(TABLE).select('user_id').in('user_id', userIds);
    expect(left ?? []).toEqual([]);
  }
  for (const u of [owner, other, heavy]) {
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

/** PostgREST が 1 回の応答で返す行数の上限 (Supabase の既定 max_rows。supabase/config.toml では変えていない) */
const POSTGREST_MAX_ROWS = 1000;
/** 上限を超える、1 つのバッジの日の期間の数 */
const HEAVY_DAILY_PERIODS = POSTGREST_MAX_ROWS + 5;
const HEAVY_FIRST_DAY_UTC = Date.UTC(2023, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/** HEAVY_FIRST_DAY_UTC から i 日目の YYYY-MM-DD */
function dayString(i: number): string {
  return new Date(HEAVY_FIRST_DAY_UTC + i * DAY_MS).toISOString().slice(0, 10);
}

interface SummaryRow {
  badge_id: string;
  award_count: number;
  latest_period_type: string;
  latest_period_start: string;
  latest_message: string | null;
  latest_awarded_at: string;
}

describe('#1528 関数 get_my_badge_period_award_summaries: 本人の行を、バッジごとに回数と最新の期間にまとめる', () => {
  beforeAll(async () => {
    // segment_top_10: 日の期間を上限 (1000) を超えて 1005 個 + 週の期間 1 個 (付けた時刻は最も古い)。最新は最後の日
    const daily = Array.from({ length: HEAVY_DAILY_PERIODS }, (_, i) => ({
      user_id: heavy.userId,
      badge_id: badgeIds.segment_top_10,
      period_type: 'daily',
      period_start: dayString(i),
      message: `day ${i}`,
      awarded_at: new Date(HEAVY_FIRST_DAY_UTC + (i + 1) * DAY_MS).toISOString(),
    }));
    const weekly = {
      user_id: heavy.userId,
      badge_id: badgeIds.segment_top_10,
      period_type: 'weekly',
      period_start: '2022-12-26',
      message: 'week',
      awarded_at: '2023-01-01T00:00:00Z',
    };
    // improved_10: 付けた時刻が同じ 2 行 → 期間の開始日の新しい方 (日の 2026-10-11) が最新
    // segment_rank_1: 付けた時刻も開始日も同じ 2 行 → 種類の文字の順で後ろの方 (monthly) が最新
    const sameTime = '2026-10-11T15:05:00Z';
    const ties = [
      { badge_id: badgeIds.improved_10, period_type: 'weekly', period_start: '2026-10-05', message: 'week', awarded_at: sameTime },
      { badge_id: badgeIds.improved_10, period_type: 'daily', period_start: '2026-10-11', message: 'day', awarded_at: sameTime },
      { badge_id: badgeIds.segment_rank_1, period_type: 'daily', period_start: '2026-10-01', message: 'day', awarded_at: sameTime },
      { badge_id: badgeIds.segment_rank_1, period_type: 'monthly', period_start: '2026-10-01', message: 'month', awarded_at: sameTime },
    ].map((row) => ({ user_id: heavy.userId, ...row }));

    const { error } = await srAdmin.from(TABLE).insert([...daily, weekly, ...ties]);
    if (error) throw new Error(`heavy の期間の行の投入に失敗: ${error.message}`);
  }, 60_000);

  it('P-6: 期間の行が PostgREST の上限を超えても、回数を打ち切らず、最新の期間も正しい', async () => {
    const asHeavy = client(anonKey, heavy.jwt);

    // 前提の番兵: 表を行のまま読むと、上限で黙って打ち切られる (この打ち切りが、関数でまとめる理由)
    const raw = await asHeavy.from(TABLE).select('badge_id, period_type, period_start');
    expect(raw.error).toBeNull();
    expect((raw.data ?? []).length).toBeLessThan(HEAVY_DAILY_PERIODS);

    const { data, error } = await asHeavy.rpc('get_my_badge_period_award_summaries');
    expect(error).toBeNull();
    const rows = (data ?? []) as SummaryRow[];
    const byBadge = new Map(rows.map((row) => [row.badge_id, row]));
    expect(rows).toHaveLength(3);

    const lastDay = HEAVY_DAILY_PERIODS - 1;
    expect(byBadge.get(badgeIds.segment_top_10)).toMatchObject({
      award_count: HEAVY_DAILY_PERIODS + 1,
      latest_period_type: 'daily',
      latest_period_start: dayString(lastDay),
      latest_message: `day ${lastDay}`,
    });
    expect(Date.parse(String(byBadge.get(badgeIds.segment_top_10)?.latest_awarded_at))).toBe(
      HEAVY_FIRST_DAY_UTC + (lastDay + 1) * DAY_MS,
    );
    expect(byBadge.get(badgeIds.improved_10)).toMatchObject({
      award_count: 2,
      latest_period_type: 'daily',
      latest_period_start: '2026-10-11',
      latest_message: 'day',
    });
    expect(byBadge.get(badgeIds.segment_rank_1)).toMatchObject({
      award_count: 2,
      latest_period_type: 'monthly',
      latest_period_start: '2026-10-01',
      latest_message: 'month',
    });
  });

  it('P-7: 別のログインユーザーが呼ぶと、その人の行だけのまとめ (heavy の行は混ざらない)', async () => {
    const { data, error } = await client(anonKey, other.jwt).rpc('get_my_badge_period_award_summaries');
    expect(error).toBeNull();
    const rows = (data ?? []) as SummaryRow[];

    const own = await srAdmin.from(TABLE).select('badge_id').eq('user_id', other.userId);
    expect(own.error).toBeNull();
    const expectedCounts = new Map<string, number>();
    for (const row of own.data ?? []) expectedCounts.set(row.badge_id, (expectedCounts.get(row.badge_id) ?? 0) + 1);
    expect(new Map(rows.map((row) => [row.badge_id, row.award_count]))).toEqual(expectedCounts);
    for (const row of rows) expect(row.award_count).toBeLessThan(HEAVY_DAILY_PERIODS);
  });

  it('P-8: anon・service role からは呼べない (EXECUTE は authenticated だけ。42501)', async () => {
    const fromAnon = await anon().rpc('get_my_badge_period_award_summaries');
    expect(fromAnon.error?.code).toBe('42501');
    const fromServiceRole = await srAdmin.rpc('get_my_badge_period_award_summaries');
    expect(fromServiceRole.error?.code).toBe('42501');
  });
});
