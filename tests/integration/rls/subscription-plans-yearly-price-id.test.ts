/**
 * #1102 subscription_plans.stripe_yearly_price_id (年額用の Stripe Price ID) の回帰テスト
 *
 * 修正前の subscription_plans は Stripe Price ID を stripe_price_id の 1 列しか持てなかった。
 * そのため月額と年額を同時に Stripe へ同期できず、価格変更 API は「月額と年額を両方変える」リクエストを 422 で断っていた。
 * また、この列は「最後に触った側 (月額か年額か) の Price」を指す意味になり、片方の Price の参照が失われた。
 *
 * オーナー判断 (2026-10-08): 価格変更は新規契約だけに適用し、年額用の欄を足す。
 * 修正 (20261008140100_add_stripe_yearly_price_id.sql):
 *   - subscription_plans に stripe_yearly_price_id varchar(255) (NULL 可・既定値なし) を足す
 *   - stripe_price_id は「月額」の Price ID と決め、列コメントに残す (stripe_yearly_price_id は「年額」)
 *   - 行の権限 (RLS ポリシー) は変えない
 *
 * 確認すること:
 *   A. カタログ: 列の型・NULL 許容・既定値、列コメント、RLS ポリシーが期待どおりで、ほかの定義が変わっていない
 *   B. 読み書き: 列を指定しない INSERT では NULL。月額・年額の Price ID を別々に書けて、片方を書いてももう片方は変わらない。
 *      255 文字まで入り、256 文字は拒否される
 *   C. 書き込み権限: super_admin だけが書ける (匿名・一般ユーザー・admin の書き込みは行を変えない)
 *   D. migration を 2 回流しても失敗せず (冪等)、すでに書いた値は消えない
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/subscription-plans-yearly-price-id.test.ts
 *
 * カタログの確認と migration の流し直しは、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で行う。
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import ws from 'ws';

// ---------------------------------------------------------------
// 環境変数
// ---------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。',
  );
}

const REPO_ROOT = path.resolve(__dirname, '../../..');
const MIGRATION_FILE = 'supabase/migrations/20261008140100_add_stripe_yearly_price_id.sql';

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

/** ローカルスタックの postgres-meta でカタログを読む・migration を流し直す (本番には向けない) */
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

// ---------------------------------------------------------------
// A. カタログ
// ---------------------------------------------------------------
describe('#1102 A. subscription_plans の Stripe Price ID 列 (カタログ)', () => {
  it('stripe_price_id (月額) と stripe_yearly_price_id (年額) は、どちらも varchar(255)・NULL 可・既定値なし', async () => {
    const rows = await pgQuery<{
      column_name: string;
      data_type: string;
      character_maximum_length: number;
      is_nullable: string;
      column_default: string | null;
    }>(`
      SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'subscription_plans'
        AND column_name IN ('stripe_price_id', 'stripe_yearly_price_id')
      ORDER BY column_name
    `);

    expect(rows).toEqual([
      {
        column_name: 'stripe_price_id',
        data_type: 'character varying',
        character_maximum_length: 255,
        is_nullable: 'YES',
        column_default: null,
      },
      {
        column_name: 'stripe_yearly_price_id',
        data_type: 'character varying',
        character_maximum_length: 255,
        is_nullable: 'YES',
        column_default: null,
      },
    ]);
  });

  it('列コメントに、stripe_price_id は月額・stripe_yearly_price_id は年額の Price ID だと書いてある', async () => {
    const rows = await pgQuery<{ attname: string; comment: string | null }>(`
      SELECT a.attname, col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a
      WHERE a.attrelid = 'public.subscription_plans'::regclass
        AND a.attname IN ('stripe_price_id', 'stripe_yearly_price_id')
        AND NOT a.attisdropped
      ORDER BY a.attname
    `);
    const comments = Object.fromEntries(rows.map((r) => [r.attname, r.comment ?? '']));

    expect(comments.stripe_price_id).toContain('月額');
    expect(comments.stripe_price_id).toContain('stripe_yearly_price_id');
    expect(comments.stripe_yearly_price_id).toContain('年額');
    expect(comments.stripe_yearly_price_id).toContain('stripe_price_id');
  });

  it('RLS は有効のままで、ポリシーは 2 本 (super_admin の全操作 / 公開・非公開プランの SELECT) から増減していない', async () => {
    const policies = await pgQuery<{ policyname: string; cmd: string }>(`
      SELECT policyname, cmd
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'subscription_plans'
      ORDER BY policyname
    `);
    expect(policies).toEqual([
      { policyname: 'subscription_plans_mutate_super_admin', cmd: 'ALL' },
      { policyname: 'subscription_plans_select_public', cmd: 'SELECT' },
    ]);

    const rls = await pgQuery<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.subscription_plans'::regclass`,
    );
    expect(rls).toEqual([{ relrowsecurity: true }]);
  });
});

// ---------------------------------------------------------------
// テスト用のデータ
// ---------------------------------------------------------------
interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`; // 使い捨てユーザー用。実行のたびに変わる
const createdUserIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(label: string, roles: string[]): Promise<TestUser> {
  const email = `rls-yearly-price-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert(
      { id: data.user.id, nickname: `yearly-price-${label}`, age_group: '30s', gender: 'other', roles },
      { onConflict: 'id' },
    );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

/** draft のプランを作る (draft は削除できる。stripe 系の列は指定しない = 既存の行と同じ状態) */
async function createPlan(label: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await srAdmin
    .from('subscription_plans')
    .insert({
      plan_key: `t1102_${label}_${TS}`,
      display_name: `T1102 ${label} ${TS}`,
      plan_type: 'personal',
      status: 'draft',
      ...extra,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`subscription_plans insert (${label}): ${error?.message}`);
  createdPlanIds.push(data.id as string);
  return data.id as string;
}

async function readPriceIds(planId: string): Promise<{ stripe_price_id: string | null; stripe_yearly_price_id: string | null }> {
  const { data, error } = await srAdmin
    .from('subscription_plans')
    .select('stripe_price_id, stripe_yearly_price_id')
    .eq('id', planId)
    .single();
  if (error || !data) throw new Error(`subscription_plans select: ${error?.message}`);
  return data as { stripe_price_id: string | null; stripe_yearly_price_id: string | null };
}

afterAll(async () => {
  // personal_subscriptions.plan_key は ON DELETE RESTRICT だが、このテストは契約を作らないので、プランをそのまま消せる
  if (createdPlanIds.length > 0) {
    await srAdmin.from('subscription_plans').delete().in('id', createdPlanIds);
  }
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

// ---------------------------------------------------------------
// B. 読み書き
// ---------------------------------------------------------------
describe('#1102 B. 月額・年額の Price ID を別々に書ける', () => {
  it('列を指定せずに作ったプラン (既存の行と同じ状態) は、どちらの Price ID も NULL', async () => {
    const planId = await createPlan('default');
    expect(await readPriceIds(planId)).toEqual({ stripe_price_id: null, stripe_yearly_price_id: null });
  });

  it('月額だけ・年額だけを書いても、もう片方は変わらない', async () => {
    const planId = await createPlan('independent');

    const monthly = await srAdmin.from('subscription_plans').update({ stripe_price_id: 'price_month_1' }).eq('id', planId);
    expect(monthly.error).toBeNull();
    expect(await readPriceIds(planId)).toEqual({ stripe_price_id: 'price_month_1', stripe_yearly_price_id: null });

    const yearly = await srAdmin.from('subscription_plans').update({ stripe_yearly_price_id: 'price_year_1' }).eq('id', planId);
    expect(yearly.error).toBeNull();
    expect(await readPriceIds(planId)).toEqual({ stripe_price_id: 'price_month_1', stripe_yearly_price_id: 'price_year_1' });

    // 月額だけ新しい Price に差し替えても、年額の参照は残る (修正前は片方の参照が失われた)
    const monthlyAgain = await srAdmin.from('subscription_plans').update({ stripe_price_id: 'price_month_2' }).eq('id', planId);
    expect(monthlyAgain.error).toBeNull();
    expect(await readPriceIds(planId)).toEqual({ stripe_price_id: 'price_month_2', stripe_yearly_price_id: 'price_year_1' });
  });

  it('月額・年額を 1 回の更新で同時に書ける (価格変更 API が 1 回の UPDATE で書く形)', async () => {
    const planId = await createPlan('both');
    const { error } = await srAdmin
      .from('subscription_plans')
      .update({ stripe_price_id: 'price_month_new', stripe_yearly_price_id: 'price_year_new' })
      .eq('id', planId);
    expect(error).toBeNull();
    expect(await readPriceIds(planId)).toEqual({ stripe_price_id: 'price_month_new', stripe_yearly_price_id: 'price_year_new' });
  });

  it('INSERT の時点で年額の Price ID を指定でき、NULL に戻すこともできる', async () => {
    const planId = await createPlan('insert', { stripe_price_id: 'price_m', stripe_yearly_price_id: 'price_y' });
    expect(await readPriceIds(planId)).toEqual({ stripe_price_id: 'price_m', stripe_yearly_price_id: 'price_y' });

    const { error } = await srAdmin.from('subscription_plans').update({ stripe_yearly_price_id: null }).eq('id', planId);
    expect(error).toBeNull();
    expect(await readPriceIds(planId)).toEqual({ stripe_price_id: 'price_m', stripe_yearly_price_id: null });
  });

  it('255 文字まで入り、256 文字は拒否される (varchar(255))', async () => {
    const planId = await createPlan('length');

    const ok = await srAdmin.from('subscription_plans').update({ stripe_yearly_price_id: 'y'.repeat(255) }).eq('id', planId);
    expect(ok.error).toBeNull();
    expect((await readPriceIds(planId)).stripe_yearly_price_id).toHaveLength(255);

    const tooLong = await srAdmin.from('subscription_plans').update({ stripe_yearly_price_id: 'y'.repeat(256) }).eq('id', planId);
    // 22001 = string_data_right_truncation
    expect(tooLong.error?.code).toBe('22001');
    expect((await readPriceIds(planId)).stripe_yearly_price_id).toHaveLength(255);
  });
});

// ---------------------------------------------------------------
// C. 書き込み権限 (列を足しても、書ける人は増えない)
// ---------------------------------------------------------------
describe('#1102 C. stripe_yearly_price_id を書けるのは super_admin だけ', () => {
  let superAdmin: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let planId = '';

  beforeAll(async () => {
    [superAdmin, admin, member] = await Promise.all([
      createUser('sa', ['super_admin']),
      createUser('admin', ['admin']),
      createUser('member', ['user']),
    ]);
    planId = await createPlan('perm', { stripe_yearly_price_id: 'price_year_original' });
  }, 60_000);

  /** RLS で弾かれた UPDATE は、エラーにならず 0 行を更新する場合と、エラーになる場合がある。どちらでも、行が変わらなければよい */
  async function tryUpdate(c: SupabaseClient, value: string) {
    return c.from('subscription_plans').update({ stripe_yearly_price_id: value }).eq('id', planId).select('id');
  }

  it('匿名 (anon) は書き込めず、値は変わらない', async () => {
    const res = await tryUpdate(anon(), 'price_year_by_anon');
    expect(res.error !== null || (res.data ?? []).length === 0).toBe(true);
    expect((await readPriceIds(planId)).stripe_yearly_price_id).toBe('price_year_original');
  });

  it('一般ユーザーは書き込めず、値は変わらない', async () => {
    const res = await tryUpdate(asUser(member.jwt), 'price_year_by_member');
    expect(res.error !== null || (res.data ?? []).length === 0).toBe(true);
    expect((await readPriceIds(planId)).stripe_yearly_price_id).toBe('price_year_original');
  });

  it('admin (super_admin ではない運営ロール) は書き込めず、値は変わらない', async () => {
    const res = await tryUpdate(asUser(admin.jwt), 'price_year_by_admin');
    expect(res.error !== null || (res.data ?? []).length === 0).toBe(true);
    expect((await readPriceIds(planId)).stripe_yearly_price_id).toBe('price_year_original');
  });

  it('super_admin は、自分のセッションで月額・年額の Price ID を書ける (価格変更 API と同じ経路)', async () => {
    const res = await asUser(superAdmin.jwt)
      .from('subscription_plans')
      .update({ stripe_price_id: 'price_month_by_sa', stripe_yearly_price_id: 'price_year_by_sa' })
      .eq('id', planId)
      .select('id, stripe_price_id, stripe_yearly_price_id');
    expect(res.error).toBeNull();
    expect(res.data).toEqual([
      { id: planId, stripe_price_id: 'price_month_by_sa', stripe_yearly_price_id: 'price_year_by_sa' },
    ]);
    expect(await readPriceIds(planId)).toEqual({
      stripe_price_id: 'price_month_by_sa',
      stripe_yearly_price_id: 'price_year_by_sa',
    });
  });
});

// ---------------------------------------------------------------
// D. migration を流し直しても同じ (冪等)
// ---------------------------------------------------------------
describe('#1102 D. migration の冪等性', () => {
  it('2 回流しても失敗せず、すでに書いた値は消えず、列と列コメントは 1 つのまま', async () => {
    const planId = await createPlan('idempotent', { stripe_price_id: 'price_m_keep', stripe_yearly_price_id: 'price_y_keep' });
    const migrationSql = fs.readFileSync(path.join(REPO_ROOT, MIGRATION_FILE), 'utf8');

    await pgQuery(migrationSql);
    await pgQuery(migrationSql);

    expect(await readPriceIds(planId)).toEqual({ stripe_price_id: 'price_m_keep', stripe_yearly_price_id: 'price_y_keep' });

    const columns = await pgQuery<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'subscription_plans' AND column_name = 'stripe_yearly_price_id'
    `);
    expect(columns).toHaveLength(1);
  });
});
