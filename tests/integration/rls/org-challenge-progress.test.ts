/**
 * #1132 組織チャレンジの進み具合 (current_value) と順位 (rank) を、食事の記録から計算する DB 関数と RLS の回帰テスト
 *
 * 修正前は、記録から current_value / rank を計算して書き込む処理がどこにも無く、参加しても進み具合も順位も動かなかった。
 * さらに organization_challenge_participants は、同じ組織の全員 (管理者・参加していない人を含む) が、全参加者の
 * user_id・current_value・rank を読めた。
 * 修正後 (supabase/migrations/*_org_challenge_progress.sql):
 *   - update_org_challenge_progress(p_now): 開催中の 3 種類のチャレンジ (breakfast_rate / veg_score / cooking_rate) の
 *     参加者ごとの current_value を、JST の暦日・前日までの記録から計算し、チャレンジの中で rank() をつける。
 *     終了日 (JST) を過ぎた開催中のチャレンジを completed にする。service_role だけが実行できる。
 *   - get_org_challenge_aggregates(p_organization_id): 管理者に見せる集計。参加者数と平均だけ。
 *     参加者が 5 人に満たなければ参加者数は NULL、集計が済んだ参加者が 5 人に満たなければ平均は NULL。service_role だけが実行できる。
 *   - get_org_challenge_ranking(p_challenge_id, p_user_id, p_limit, p_with_names): 参加者に見せる順位表。
 *     参加していない人には 0 行。他人の user_id は返さない。表示名は p_with_names が true のときだけ。service_role だけが実行できる。
 *   - 参加者の行は本人だけが読める (SELECT)。本人の行だけ消せる (DELETE = 参加をやめる)。
 *
 * 確認すること:
 *   A. カタログ: 関数の種類 (SECURITY DEFINER / INVOKER)・search_path・実行権限 (service_role だけ)・pg_cron のジョブ
 *   B. 朝食をとれた日の割合: 日数で数える・完了した記録だけ・食べない (skip) は除く・ハンズオンの記録は除く・期間の外は除く・同点は同順位
 *      今も組織のメンバーである参加者だけが対象 (脱退した人・別の組織の人の行は更新しない)
 *   C. 野菜スコアの平均 / 自炊の割合
 *   D. JST の境界: 集計の最後の日 (前日) の切り替わりと、チャレンジが終了になる時刻が、UTC ではなく JST の 0 時
 *   E. チャレンジの状態: 終了日を過ぎたものだけ completed になる。対象外の種類・状態・開始前のチャレンジの参加者は更新しない
 *   F. 繰り返し実行しても同じ結果 (変わらない行は書き換えない) / 終了日より後の記録は数えない
 *   G. 権限: anon / authenticated は関数を呼べない (42501)。service_role は呼べる
 *   H. 管理者向けの集計: 最小人数 (5) 未満では人数も平均も返さない (境界は 4 人と 5 人)・今も組織のメンバーである参加者だけ・
 *      他組織のチャレンジは返さない・個人の値の列が無い
 *   I. RLS: 参加者の行は本人だけが読める (管理者・参加していない人・他組織の人は読めない)。本人の行だけ消せる
 *   J. 参加者向けの順位表: 参加者本人にだけ返る (管理者・参加していない人・脱退した人・他組織の人には 0 行)・他人の ID を返さない・
 *      表示名は指定したときだけ・上位 N 人と本人の行・順位がついていない参加者と脱退した人は入らない
 *
 * 日付は 2020 年を使う。update_org_challenge_progress は DB 中の開催中のチャレンジを全部処理するため、
 * 他のテストが作る今の日付 (2026 年) のチャレンジに触れないよう、p_now に過去の日時を渡す。
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/org-challenge-progress.test.ts
 * カタログの確認は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で読み取りだけ行う。本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
const asUser = (jwt: string) => client(anonKey, jwt);

/** ローカルスタックの postgres-meta でカタログを読む (読み取り専用の確認にだけ使う) */
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

interface TestUser {
  id: string;
  jwt: string | null;
}

const RUN = randomBytes(4).toString('hex');
const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`; // 使い捨てユーザー用。実行のたびに変わる
const createdUserIds: string[] = [];
const createdChallengeIds: string[] = [];

let orgA = '';
let orgB = '';

// 組織 A のメンバー。a1〜a7 が参加者、admin は組織 A の管理者 (参加しない)
let a1: TestUser;
let a2: TestUser;
let a3: TestUser;
let a4: TestUser;
let a5: TestUser;
let a6: TestUser;
let a7: TestUser;
let admin: TestUser;
let outsider: TestUser; // 組織 A のメンバーだが参加しない
let former: TestUser; // 以前は組織 A のメンバー。いまはどの組織にも所属しない (参加行だけが残っている)
let b1: TestUser; // 組織 B のメンバー

async function createUser(label: string, options: { signIn?: boolean } = {}): Promise<TestUser> {
  const email = `it1132-${label}-${RUN}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert({ id: data.user.id, nickname: `it1132-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' });
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  let jwt: string | null = null;
  if (options.signIn) {
    // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
    const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
    if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
    jwt = signIn.data.session.access_token;
  }
  return { id: data.user.id, jwt };
}

/** 所属は特権列のため service_role で設定する */
async function setMembership(userId: string, orgId: string | null, orgRole: 'owner' | 'admin' | 'member' = 'member') {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({
      organization_id: orgId,
      org_role: orgId ? orgRole : null,
      is_active_in_org: orgId !== null,
      roles: ['user'],
    })
    .eq('id', userId);
  if (error) throw new Error(`setMembership: ${error.message}`);
}

interface ChallengeSeed {
  org?: string;
  type?: string;
  status?: string;
  start: string;
  end: string;
  title?: string;
}

async function createChallenge(seed: ChallengeSeed): Promise<string> {
  const { data, error } = await srAdmin
    .from('organization_challenges')
    .insert({
      organization_id: seed.org ?? orgA,
      title: seed.title ?? `it1132-${seed.type ?? 'breakfast_rate'}-${RUN}`,
      challenge_type: seed.type ?? 'breakfast_rate',
      start_date: seed.start,
      end_date: seed.end,
      status: seed.status ?? 'active',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organization_challenges: ${error?.message}`);
  createdChallengeIds.push(data.id);
  return data.id;
}

async function join(challengeId: string, userId: string, extra: Record<string, unknown> = {}) {
  const { error } = await srAdmin
    .from('organization_challenge_participants')
    .insert({ challenge_id: challengeId, user_id: userId, ...extra });
  if (error) throw new Error(`participant: ${error.message}`);
}

interface MealSeed {
  type?: string;
  completed?: boolean;
  /** 省略: 'cook' (列の既定値)。null: mode を NULL にする */
  mode?: string | null;
  veg?: number | null;
}

/** user_daily_meals の 1 日分と、その planned_meals を作る。completed の既定は true (食べた記録) */
async function seedDay(userId: string, dayDate: string, meals: MealSeed[], options: { sandbox?: boolean } = {}) {
  const { data: day, error } = await srAdmin
    .from('user_daily_meals')
    .insert({ user_id: userId, day_date: dayDate, is_sandbox: options.sandbox ?? false })
    .select('id')
    .single();
  if (error || !day) throw new Error(`user_daily_meals ${dayDate}: ${error?.message}`);
  if (meals.length === 0) return;
  const rows = meals.map((m, i) => {
    const row: Record<string, unknown> = {
      daily_meal_id: day.id,
      meal_type: m.type ?? 'lunch',
      dish_name: `it1132-${i}`,
      is_completed: m.completed ?? true,
      veg_score: m.veg ?? null,
    };
    if (m.mode !== undefined) row.mode = m.mode;
    return row;
  });
  const { error: mealError } = await srAdmin.from('planned_meals').insert(rows);
  if (mealError) throw new Error(`planned_meals ${dayDate}: ${mealError.message}`);
}

interface ParticipantRow {
  user_id: string;
  current_value: number | string | null;
  rank: number | null;
}

async function participants(challengeId: string): Promise<Map<string, { value: number; rank: number | null }>> {
  const { data, error } = await srAdmin
    .from('organization_challenge_participants')
    .select('user_id, current_value, rank')
    .eq('challenge_id', challengeId);
  if (error) throw new Error(`participants: ${error.message}`);
  const map = new Map<string, { value: number; rank: number | null }>();
  for (const row of (data ?? []) as ParticipantRow[]) {
    map.set(row.user_id, { value: Number(row.current_value), rank: row.rank });
  }
  return map;
}

async function challengeStatus(challengeId: string): Promise<string> {
  const { data, error } = await srAdmin.from('organization_challenges').select('status').eq('id', challengeId).single();
  if (error || !data) throw new Error(`challenge status: ${error?.message}`);
  return data.status as string;
}

interface ProgressResult {
  today_jst: string;
  last_day: string;
  challenges: number;
  participants: number;
  changed: number;
  completed: number;
}

async function runProgress(pNow: string): Promise<ProgressResult> {
  const { data, error } = await srAdmin.rpc('update_org_challenge_progress', { p_now: pNow });
  if (error) throw new Error(`update_org_challenge_progress: ${error.code} ${error.message}`);
  return data as ProgressResult;
}

beforeAll(async () => {
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([{ name: `#1132 Org A ${RUN}` }, { name: `#1132 Org B ${RUN}` }])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('#1132 Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('#1132 Org B'))!.id;

  [a1, a2, a3, a4, a5, a6, a7, outsider, former, b1] = await Promise.all([
    createUser('a1', { signIn: true }),
    createUser('a2'),
    createUser('a3'),
    createUser('a4'),
    createUser('a5'),
    createUser('a6'),
    createUser('a7'),
    createUser('outsider', { signIn: true }),
    createUser('former'),
    createUser('b1', { signIn: true }),
  ]);
  admin = await createUser('admin', { signIn: true });

  for (const u of [a1, a2, a3, a4, a5, a6, a7, outsider]) await setMembership(u.id, orgA);
  await setMembership(admin.id, orgA, 'admin');
  await setMembership(b1.id, orgB);
  // former は、どの組織にも所属しない (参加行だけが残る状況を作る)
}, 180_000);

afterEach(async () => {
  // 次のテストに記録・チャレンジを持ち越さない (チャレンジを消すと参加行も消える)
  if (createdChallengeIds.length > 0) {
    await srAdmin.from('organization_challenges').delete().in('id', createdChallengeIds);
    createdChallengeIds.length = 0;
  }
  await srAdmin.from('user_daily_meals').delete().in('user_id', createdUserIds);
}, 60_000);

afterAll(async () => {
  for (const id of createdUserIds) {
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false })
      .eq('id', id);
  }
  await srAdmin.from('user_daily_meals').delete().in('user_id', createdUserIds);
  await srAdmin.from('organization_challenge_participants').delete().in('user_id', createdUserIds);
  if (orgA || orgB) await srAdmin.from('organizations').delete().in('id', [orgA, orgB].filter(Boolean));
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 120_000);

// 2020-03-02 (月) 〜 03-08 (日) の 7 日間。p_now が JST 03-06 12:00 のとき、集計に入るのは 03-02〜03-05 の 4 日
const START = '2020-03-02';
const END = '2020-03-08';
const NOW_MIDWEEK = '2020-03-06T03:00:00Z'; // JST 2020-03-06 12:00。今日 = 03-06、集計の最後の日 = 03-05
const BREAKFAST = { type: 'breakfast' };

// ================================================================
// A. カタログ
// ================================================================
describe('#1132 A. 関数の種類・権限・pg_cron のジョブ', () => {
  interface ProcRow {
    proname: string;
    args: string;
    prosecdef: boolean;
    provolatile: string;
    proconfig: string[] | null;
    result: string;
    acl: string | null;
    owner: string;
  }

  async function procs(): Promise<Map<string, ProcRow>> {
    const rows = await pgQuery<ProcRow>(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.provolatile::text as provolatile,
             p.proconfig, pg_get_function_result(p.oid) as result, p.proacl::text as acl, pg_get_userbyid(p.proowner) as owner
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('update_org_challenge_progress', 'get_org_challenge_aggregates', 'get_org_challenge_ranking')
    `);
    return new Map(rows.map((r) => [r.proname, r]));
  }

  it('update_org_challenge_progress は SECURITY DEFINER・search_path が空・jsonb を返す', async () => {
    const p = (await procs()).get('update_org_challenge_progress');
    expect(p, 'update_org_challenge_progress が無い').toBeDefined();
    expect(p!.args).toBe('p_now timestamp with time zone');
    expect(p!.prosecdef).toBe(true);
    expect(p!.proconfig).toContain('search_path=""');
    expect(p!.result).toBe('jsonb');
  });

  it('get_org_challenge_aggregates は SECURITY INVOKER・STABLE・search_path が空', async () => {
    const p = (await procs()).get('get_org_challenge_aggregates');
    expect(p, 'get_org_challenge_aggregates が無い').toBeDefined();
    expect(p!.args).toBe('p_organization_id uuid');
    expect(p!.prosecdef).toBe(false);
    expect(p!.provolatile).toBe('s');
    expect(p!.proconfig).toContain('search_path=""');
  });

  it('get_org_challenge_ranking は SECURITY INVOKER・STABLE・search_path が空', async () => {
    const p = (await procs()).get('get_org_challenge_ranking');
    expect(p, 'get_org_challenge_ranking が無い').toBeDefined();
    expect(p!.args).toBe('p_challenge_id uuid, p_user_id uuid, p_limit integer, p_with_names boolean');
    expect(p!.prosecdef).toBe(false);
    expect(p!.provolatile).toBe('s');
    expect(p!.proconfig).toContain('search_path=""');
  });

  it('3 つの関数とも、EXECUTE を持つのは所有者と service_role だけ (PUBLIC / anon / authenticated には無い)', async () => {
    const all = await procs();
    for (const name of ['update_org_challenge_progress', 'get_org_challenge_aggregates', 'get_org_challenge_ranking']) {
      const p = all.get(name);
      expect(p, `${name} が無い`).toBeDefined();
      const grantees = (p!.acl ?? '')
        .replace(/^\{|\}$/g, '')
        .split(',')
        .filter(Boolean)
        .map((entry) => entry.split('=')[0]); // PUBLIC は空文字
      expect(grantees.sort(), `${name} の EXECUTE`).toEqual([p!.owner, 'service_role'].sort());
    }
  });

  it('pg_cron のジョブ update-org-challenge-progress が 1 本、毎日 18:10 UTC (= 03:10 JST) で登録されている', async () => {
    // cron.job は行レベルセキュリティ (username = current_user) があるため、migration を流す postgres ロールで読む
    const rows = await pgQuery<{ schedule: string; command: string; active: boolean }>(
      `SET LOCAL ROLE postgres;\nselect schedule, command, active from cron.job where jobname = 'update-org-challenge-progress'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toBe('10 18 * * *');
    expect(rows[0].command).toContain('public.update_org_challenge_progress()');
    expect(rows[0].active).toBe(true);
  });
});

// ================================================================
// B. 朝食をとれた日の割合 (breakfast_rate)
// ================================================================
describe('#1132 B. breakfast_rate: 朝食をとれた日の割合', () => {
  it('日数で数える。完了した記録だけ・skip とハンズオンの記録は除く・期間の外は除く・同点は同順位', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    for (const u of [a1, a2, a3, a4, a5, a6, a7]) await join(challenge, u.id);
    await join(challenge, former.id); // 脱退済み (組織に所属しない)
    await join(challenge, b1.id); // 別の組織の人 (service_role なら入れられる)

    // a1: 4 日とも朝食 -> 4/4 = 100.0
    for (const d of ['2020-03-02', '2020-03-03', '2020-03-04', '2020-03-05']) await seedDay(a1.id, d, [BREAKFAST]);
    // a2: 03-02 に朝食が 2 件 (1 日と数える)、03-03 に 1 件。今日 (03-06) の朝食は数えない -> 2/4 = 50.0
    await seedDay(a2.id, '2020-03-02', [BREAKFAST, BREAKFAST]);
    await seedDay(a2.id, '2020-03-03', [BREAKFAST]);
    await seedDay(a2.id, '2020-03-06', [BREAKFAST]);
    // a3: 03-04 と 03-05 -> 2/4 = 50.0 (a2 と同点)
    await seedDay(a3.id, '2020-03-04', [BREAKFAST]);
    await seedDay(a3.id, '2020-03-05', [BREAKFAST]);
    // a4: 03-02 だけ -> 1/4 = 25.0
    await seedDay(a4.id, '2020-03-02', [BREAKFAST]);
    // a5: 朝食はあるが完了していない / 食べない (skip) だけ完了 -> 0.0
    for (const d of ['2020-03-02', '2020-03-03', '2020-03-04', '2020-03-05']) {
      await seedDay(a5.id, d, [{ ...BREAKFAST, completed: false }]);
    }
    await seedDay(a5.id, '2020-03-06', [{ ...BREAKFAST, mode: 'skip' }]);
    // a6: ハンズオンのお試しの記録 (is_sandbox) と、昼食だけの日 -> 0.0
    await seedDay(a6.id, '2020-03-02', [BREAKFAST], { sandbox: true });
    await seedDay(a6.id, '2020-03-03', [{ type: 'lunch' }]);
    // a7: 期間の前 (03-01) と後 (03-09) -> 0.0
    await seedDay(a7.id, '2020-03-01', [BREAKFAST]);
    await seedDay(a7.id, '2020-03-09', [BREAKFAST]);
    // former / b1: 毎日朝食をとっていても、更新されない
    for (const d of ['2020-03-02', '2020-03-03', '2020-03-04', '2020-03-05']) {
      await seedDay(former.id, d, [BREAKFAST]);
      await seedDay(b1.id, d, [BREAKFAST]);
    }

    const result = await runProgress(NOW_MIDWEEK);

    const rows = await participants(challenge);
    expect(rows.get(a1.id)).toEqual({ value: 100, rank: 1 });
    expect(rows.get(a2.id)).toEqual({ value: 50, rank: 2 });
    expect(rows.get(a3.id)).toEqual({ value: 50, rank: 2 }); // 同点は同順位
    expect(rows.get(a4.id)).toEqual({ value: 25, rank: 4 }); // 1, 2, 2 の次は 4 位
    expect(rows.get(a5.id)).toEqual({ value: 0, rank: 5 });
    expect(rows.get(a6.id)).toEqual({ value: 0, rank: 5 });
    expect(rows.get(a7.id)).toEqual({ value: 0, rank: 5 });
    // 脱退済みの人・別の組織の人は、順位づけにも入らず、行も更新されない
    expect(rows.get(former.id)).toEqual({ value: 0, rank: null });
    expect(rows.get(b1.id)).toEqual({ value: 0, rank: null });

    expect(result).toMatchObject({ today_jst: '2020-03-06', last_day: '2020-03-05', challenges: 1, participants: 7, completed: 0 });
  });

  it('同じ日の割合は小数第 1 位に丸める (7 日中 2 日 = 28.6)', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    await join(challenge, a1.id);
    await seedDay(a1.id, '2020-03-02', [BREAKFAST]);
    await seedDay(a1.id, '2020-03-08', [BREAKFAST]);

    // 03-09 12:00 JST: 今日 = 03-09 -> 03-08 まで (7 日)。終了日を過ぎているので最後の計算のあと completed になる
    await runProgress('2020-03-09T03:00:00Z');

    expect((await participants(challenge)).get(a1.id)).toEqual({ value: 28.6, rank: 1 });
    expect(await challengeStatus(challenge)).toBe('completed');
  });
});

// ================================================================
// C. 野菜スコアの平均 / 自炊の割合
// ================================================================
describe('#1132 C. veg_score と cooking_rate', () => {
  it('veg_score: 完了した食事のうち、野菜スコアのあるものの平均 (小数第 1 位)。skip・未完了・スコアなしは除く。0 件は 0', async () => {
    const challenge = await createChallenge({ type: 'veg_score', start: START, end: END });
    for (const u of [a1, a2, a3, a4, a5, a6]) await join(challenge, u.id);

    // a1: 5, 4, 3 -> 4.0
    await seedDay(a1.id, '2020-03-02', [
      { type: 'breakfast', veg: 5 },
      { type: 'lunch', veg: 4 },
    ]);
    await seedDay(a1.id, '2020-03-03', [{ type: 'dinner', veg: 3 }]);
    // a2: 3 だけが対象。スコアなし・未完了 (5)・skip (5)・今日の分 (5) は除く -> 3.0
    await seedDay(a2.id, '2020-03-02', [
      { type: 'lunch', veg: 3 },
      { type: 'dinner', veg: null },
      { type: 'breakfast', veg: 5, completed: false },
      { type: 'snack', veg: 5, mode: 'skip' },
    ]);
    await seedDay(a2.id, '2020-03-06', [{ type: 'lunch', veg: 5 }]);
    // a3: 4, 5 -> 4.5
    await seedDay(a3.id, '2020-03-05', [
      { type: 'lunch', veg: 4 },
      { type: 'dinner', veg: 5 },
    ]);
    // a4: 4, 4, 3 -> 3.666... -> 3.7
    await seedDay(a4.id, '2020-03-02', [{ type: 'lunch', veg: 4 }]);
    await seedDay(a4.id, '2020-03-03', [{ type: 'lunch', veg: 4 }]);
    await seedDay(a4.id, '2020-03-04', [{ type: 'lunch', veg: 3 }]);
    // a5: 記録なし -> 0
    // a6: 3 -> 3.0 (a2 と同点)
    await seedDay(a6.id, '2020-03-03', [{ type: 'lunch', veg: 3 }]);

    await runProgress(NOW_MIDWEEK);

    const rows = await participants(challenge);
    expect(rows.get(a3.id)).toEqual({ value: 4.5, rank: 1 });
    expect(rows.get(a1.id)).toEqual({ value: 4, rank: 2 });
    expect(rows.get(a4.id)).toEqual({ value: 3.7, rank: 3 });
    expect(rows.get(a2.id)).toEqual({ value: 3, rank: 4 });
    expect(rows.get(a6.id)).toEqual({ value: 3, rank: 4 });
    expect(rows.get(a5.id)).toEqual({ value: 0, rank: 6 });
  });

  it('cooking_rate: 完了した食事のうち mode が cook / quick (未設定は cook) の割合。skip は食事に数えない。0 件は 0', async () => {
    const challenge = await createChallenge({ type: 'cooking_rate', start: START, end: END });
    for (const u of [a1, a2, a3, a4, a5]) await join(challenge, u.id);

    // a1: cook, quick, 未設定 (= cook), buy -> 3/4 = 75.0
    await seedDay(a1.id, '2020-03-02', [
      { type: 'breakfast', mode: 'cook' },
      { type: 'lunch', mode: 'quick' },
    ]);
    await seedDay(a1.id, '2020-03-03', [
      { type: 'lunch', mode: null },
      { type: 'dinner', mode: 'buy' },
    ]);
    // a2: cook, out, ai_creative, buy -> 1/4 = 25.0。skip と未完了は分母に入れない
    await seedDay(a2.id, '2020-03-02', [
      { type: 'breakfast', mode: 'cook' },
      { type: 'lunch', mode: 'out' },
      { type: 'dinner', mode: 'ai_creative' },
      { type: 'snack', mode: 'buy' },
      { type: 'midnight_snack', mode: 'skip' },
      { type: 'snack', mode: 'cook', completed: false },
    ]);
    // a3: skip だけ -> 食事が 0 件 -> 0.0
    await seedDay(a3.id, '2020-03-02', [{ type: 'lunch', mode: 'skip' }]);
    // a4: cook 2 件 -> 100.0
    await seedDay(a4.id, '2020-03-04', [
      { type: 'lunch', mode: 'cook' },
      { type: 'dinner', mode: 'cook' },
    ]);
    // a5: 記録なし -> 0.0

    await runProgress(NOW_MIDWEEK);

    const rows = await participants(challenge);
    expect(rows.get(a4.id)).toEqual({ value: 100, rank: 1 });
    expect(rows.get(a1.id)).toEqual({ value: 75, rank: 2 });
    expect(rows.get(a2.id)).toEqual({ value: 25, rank: 3 });
    expect(rows.get(a3.id)).toEqual({ value: 0, rank: 4 });
    expect(rows.get(a5.id)).toEqual({ value: 0, rank: 4 });
  });
});

// ================================================================
// D. JST の境界
// ================================================================
describe('#1132 D. JST の境界', () => {
  it('集計の最後の日は「JST の前日」: JST 23:59:59 までは前日分、JST 0:00 から今日分が増える (UTC の日付では切り替わらない)', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: '2020-03-31' });
    await join(challenge, a1.id);
    await seedDay(a1.id, '2020-03-05', [BREAKFAST]);

    // JST 2020-03-05 23:59:59 (= UTC 14:59:59)。今日 = 03-05 なので、03-05 はまだ数えない。03-02〜03-04 の 3 日 -> 0.0
    const before = await runProgress('2020-03-05T14:59:59Z');
    expect(before).toMatchObject({ today_jst: '2020-03-05', last_day: '2020-03-04' });
    expect((await participants(challenge)).get(a1.id)).toEqual({ value: 0, rank: 1 });

    // JST 2020-03-06 00:00:00 (= UTC 15:00:00)。UTC ではまだ 03-05 だが、JST では 03-06。03-05 が入る -> 1/4 = 25.0
    const after = await runProgress('2020-03-05T15:00:00Z');
    expect(after).toMatchObject({ today_jst: '2020-03-06', last_day: '2020-03-05' });
    expect((await participants(challenge)).get(a1.id)).toEqual({ value: 25, rank: 1 });
  });

  it('開始日が「JST の今日」のチャレンジは、集計できる日がまだ無いので更新しない。翌日の JST 0:00 から集計が始まる', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: '2020-03-06', end: '2020-03-31' });
    await join(challenge, a1.id);
    await seedDay(a1.id, '2020-03-06', [BREAKFAST]);

    // JST 2020-03-06 12:00。開始日 = 今日なので、まだ集計しない
    const same = await runProgress('2020-03-06T03:00:00Z');
    expect(same.challenges).toBe(0);
    expect((await participants(challenge)).get(a1.id)).toEqual({ value: 0, rank: null });

    // JST 2020-03-07 00:00 (= UTC 03-06 15:00)。03-06 の 1 日分 -> 100.0
    await runProgress('2020-03-06T15:00:00Z');
    expect((await participants(challenge)).get(a1.id)).toEqual({ value: 100, rank: 1 });
  });
});

// ================================================================
// E. チャレンジの状態
// ================================================================
describe('#1132 E. チャレンジの終了 (completed) と、対象外のチャレンジ', () => {
  it('終了日を過ぎる JST 0:00 に completed になる。最後の日 (終了日) までの記録で最終の値を計算してから終わる', async () => {
    const ending = await createChallenge({ type: 'breakfast_rate', start: START, end: '2020-03-05' });
    await join(ending, a1.id);
    await seedDay(a1.id, '2020-03-04', [BREAKFAST]);
    await seedDay(a1.id, '2020-03-05', [BREAKFAST]); // 終了日の記録

    // JST 2020-03-05 23:59:59: 終了日はまだ終わっていない -> 開催中のまま。集計は前日 (03-04) まで: 03-02〜03-04 の 3 日のうち 1 日 = 33.3
    const before = await runProgress('2020-03-05T14:59:59Z');
    expect(before.completed).toBe(0);
    expect(await challengeStatus(ending)).toBe('active');
    expect((await participants(ending)).get(a1.id)).toEqual({ value: 33.3, rank: 1 });

    // JST 2020-03-06 00:00:00: 終了日を過ぎた -> 最後の計算 (03-02〜03-05 の 4 日のうち 2 日 = 50.0) のあとで completed
    const after = await runProgress('2020-03-05T15:00:00Z');
    expect(after.completed).toBe(1);
    expect(await challengeStatus(ending)).toBe('completed');
    expect((await participants(ending)).get(a1.id)).toEqual({ value: 50, rank: 1 });
  });

  it('対象外の種類 (歩数) は参加者の値を更新しないが、終了日を過ぎれば completed になる。下書き・中止・終了済み・開始前のチャレンジは何も変わらない', async () => {
    const steps = await createChallenge({ type: 'steps', start: START, end: '2020-03-05' });
    const draft = await createChallenge({ type: 'breakfast_rate', status: 'draft', start: START, end: '2020-03-05' });
    const cancelled = await createChallenge({ type: 'breakfast_rate', status: 'cancelled', start: START, end: '2020-03-05' });
    const done = await createChallenge({ type: 'breakfast_rate', status: 'completed', start: START, end: '2020-03-05' });
    const future = await createChallenge({ type: 'breakfast_rate', start: '2020-04-01', end: '2020-04-30' });
    for (const c of [steps, draft, cancelled, done, future]) await join(c, a1.id);
    // 下書き・中止・終了済みの値は、計算されていたとしても書き換わらないことを確かめるため、目印の値を入れておく
    for (const c of [steps, draft, cancelled, done]) {
      await srAdmin
        .from('organization_challenge_participants')
        .update({ current_value: 7, rank: 3 })
        .eq('challenge_id', c)
        .eq('user_id', a1.id);
    }
    await seedDay(a1.id, '2020-03-02', [BREAKFAST]);

    const result = await runProgress('2020-03-05T15:00:00Z'); // JST 2020-03-06 00:00

    expect(await challengeStatus(steps)).toBe('completed');
    expect(await challengeStatus(draft)).toBe('draft');
    expect(await challengeStatus(cancelled)).toBe('cancelled');
    expect(await challengeStatus(done)).toBe('completed');
    expect(await challengeStatus(future)).toBe('active');
    for (const c of [steps, draft, cancelled, done]) {
      expect((await participants(c)).get(a1.id), `チャレンジ ${c}`).toEqual({ value: 7, rank: 3 });
    }
    expect((await participants(future)).get(a1.id)).toEqual({ value: 0, rank: null });
    expect(result.completed).toBe(1);
  });
});

// ================================================================
// F. 繰り返し実行・終了日より後の記録
// ================================================================
describe('#1132 F. 繰り返し実行しても同じ結果。終了日より後の記録は数えない', () => {
  it('2 回目は何も書き換えない (changed = 0)。値も順位も同じ', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    for (const u of [a1, a2, a3]) await join(challenge, u.id);
    await seedDay(a1.id, '2020-03-02', [BREAKFAST]);
    await seedDay(a2.id, '2020-03-02', [BREAKFAST]);
    await seedDay(a2.id, '2020-03-03', [BREAKFAST]);

    const first = await runProgress(NOW_MIDWEEK);
    const snapshot = await participants(challenge);
    const second = await runProgress(NOW_MIDWEEK);

    expect(first.changed).toBe(3);
    expect(second).toMatchObject({ participants: 3, changed: 0, completed: 0 });
    expect(await participants(challenge)).toEqual(snapshot);
    expect(snapshot.get(a2.id)).toEqual({ value: 50, rank: 1 });
    expect(snapshot.get(a1.id)).toEqual({ value: 25, rank: 2 });
    expect(snapshot.get(a3.id)).toEqual({ value: 0, rank: 3 });
  });

  it('終了日より後に何日たっても、終了日までの記録だけで計算する (後から入れた記録で値が動かない)', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: '2020-03-04' });
    await join(challenge, a1.id);
    await seedDay(a1.id, '2020-03-02', [BREAKFAST]);
    await seedDay(a1.id, '2020-03-05', [BREAKFAST]); // 終了日 (03-04) より後

    await runProgress('2020-03-10T03:00:00Z'); // 今日 = 03-10。集計は 03-02〜03-04 の 3 日まで

    expect((await participants(challenge)).get(a1.id)).toEqual({ value: 33.3, rank: 1 });
    expect(await challengeStatus(challenge)).toBe('completed');
  });
});

// ================================================================
// G. 権限
// ================================================================
describe('#1132 G. 実行権限: service_role だけ', () => {
  it('anon / authenticated は update_org_challenge_progress を呼べない (42501)。service_role は呼べる', async () => {
    const asAnon = await anon().rpc('update_org_challenge_progress', { p_now: NOW_MIDWEEK });
    expect(asAnon.error?.code).toBe('42501');

    const asMember = await asUser(a1.jwt!).rpc('update_org_challenge_progress', { p_now: NOW_MIDWEEK });
    expect(asMember.error?.code).toBe('42501');
    const asAdmin = await asUser(admin.jwt!).rpc('update_org_challenge_progress', { p_now: NOW_MIDWEEK });
    expect(asAdmin.error?.code).toBe('42501');

    const asService = await srAdmin.rpc('update_org_challenge_progress', { p_now: NOW_MIDWEEK });
    expect(asService.error).toBeNull();
  });

  it('anon / authenticated は get_org_challenge_aggregates を呼べない (42501)。service_role は呼べる', async () => {
    const asAnon = await anon().rpc('get_org_challenge_aggregates', { p_organization_id: orgA });
    expect(asAnon.error?.code).toBe('42501');

    const asAdmin = await asUser(admin.jwt!).rpc('get_org_challenge_aggregates', { p_organization_id: orgA });
    expect(asAdmin.error?.code).toBe('42501');

    const asService = await srAdmin.rpc('get_org_challenge_aggregates', { p_organization_id: orgA });
    expect(asService.error).toBeNull();
  });

  it('anon / authenticated は get_org_challenge_ranking を呼べない (42501)。service_role は呼べる', async () => {
    const args = { p_challenge_id: orgA, p_user_id: a1.id }; // 存在しない challenge でも、権限の確認は先に行われる
    const asAnon = await anon().rpc('get_org_challenge_ranking', args);
    expect(asAnon.error?.code).toBe('42501');

    const asMember = await asUser(a1.jwt!).rpc('get_org_challenge_ranking', args);
    expect(asMember.error?.code).toBe('42501');

    const asService = await srAdmin.rpc('get_org_challenge_ranking', args);
    expect(asService.error).toBeNull();
  });
});

// ================================================================
// H. 管理者向けの集計
// ================================================================
describe('#1132 H. get_org_challenge_aggregates: 人数と平均だけ。5 人未満では人数も平均も返さない', () => {
  interface AggregateRow {
    challenge_id: string;
    participant_count: number | null;
    min_participants: number;
    average_value: number | null;
  }

  async function aggregates(orgId: string): Promise<Map<string, AggregateRow>> {
    const { data, error } = await srAdmin.rpc('get_org_challenge_aggregates', { p_organization_id: orgId });
    if (error) throw new Error(`get_org_challenge_aggregates: ${error.code} ${error.message}`);
    const rows = (data ?? []) as AggregateRow[];
    return new Map(
      rows.map((r) => [
        r.challenge_id,
        { ...r, average_value: r.average_value === null ? null : Number(r.average_value) },
      ]),
    );
  }

  it('参加者が 4 人なら人数も平均も NULL、5 人になると人数と平均が出る (境界は 4 人と 5 人)', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    const values: Array<[TestUser, number]> = [
      [a1, 100],
      [a2, 50],
      [a3, 50],
      [a4, 25],
    ];
    for (const [u, v] of values) await join(challenge, u.id, { current_value: v, rank: 1 });

    let row = (await aggregates(orgA)).get(challenge)!;
    expect(row).toEqual({
      challenge_id: challenge,
      participant_count: null, // 4 人 (最小人数 5 に満たない): 人数も出さない
      min_participants: 5,
      average_value: null,
    });

    await join(challenge, a5.id, { current_value: 0, rank: 5 });
    row = (await aggregates(orgA)).get(challenge)!;
    expect(row.participant_count).toBe(5);
    expect(row.min_participants).toBe(5);
    expect(row.average_value).toBe(45); // (100 + 50 + 50 + 25 + 0) / 5
  });

  it('参加者が 5 人でも、集計が済んだ (順位がついた) 人が 5 人に満たなければ、人数は出るが平均は NULL', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    for (const u of [a1, a2, a3, a4]) await join(challenge, u.id, { current_value: 80, rank: 1 });
    await join(challenge, a5.id); // 参加したばかりで、まだ集計されていない (rank が NULL)

    let row = (await aggregates(orgA)).get(challenge)!;
    expect(row.participant_count).toBe(5);
    expect(row.average_value, '4 人分の平均から個人が分かってしまう').toBeNull();

    // 集計が済んだ人が 5 人になると、平均が出る。参加したばかりの 6 人目は、人数にだけ入る
    await srAdmin
      .from('organization_challenge_participants')
      .update({ current_value: 30, rank: 5 })
      .eq('challenge_id', challenge)
      .eq('user_id', a5.id);
    await join(challenge, a6.id);
    row = (await aggregates(orgA)).get(challenge)!;
    expect(row.participant_count).toBe(6);
    expect(row.average_value).toBe(70); // (80 * 4 + 30) / 5。a6 (未集計) は平均に入らない
  });

  it('平均は小数第 1 位に丸める', async () => {
    const challenge = await createChallenge({ type: 'veg_score', start: START, end: END });
    const values: Array<[TestUser, number]> = [
      [a1, 4.5],
      [a2, 3.7],
      [a3, 3],
      [a4, 3],
      [a5, 0],
    ];
    for (const [u, v] of values) await join(challenge, u.id, { current_value: v, rank: 1 });

    expect((await aggregates(orgA)).get(challenge)!.average_value).toBe(2.8); // 14.2 / 5 = 2.84
  });

  it('脱退した人・別の組織の人の参加行は数えない。参加者のいないチャレンジは人数 NULL。他組織のチャレンジは返らない', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    const empty = await createChallenge({ type: 'cooking_rate', start: START, end: END });
    const other = await createChallenge({ org: orgB, type: 'breakfast_rate', start: START, end: END });
    // 今の組織のメンバーは 5 人 (a1〜a5)。脱退した人 (former) と別の組織の人 (b1) の行が混ざっていても、人数は 5 のまま
    for (const u of [a1, a2, a3, a4, a5]) await join(challenge, u.id, { current_value: 10, rank: 1 });
    await join(challenge, former.id, { current_value: 99, rank: 1 });
    await join(challenge, b1.id, { current_value: 99, rank: 1 });
    await join(other, b1.id, { current_value: 20, rank: 1 });

    const mapA = await aggregates(orgA);
    expect(mapA.get(challenge)).toMatchObject({ participant_count: 5, average_value: 10 });
    expect(mapA.get(empty)).toMatchObject({ participant_count: null, average_value: null });
    expect(mapA.has(other), '他組織のチャレンジは返らない').toBe(false);

    const mapB = await aggregates(orgB);
    expect(mapB.get(other)).toMatchObject({ participant_count: null, average_value: null }); // 1 人 (最小人数に満たない)
    expect(mapB.has(challenge)).toBe(false);
  });

  it('返す列は、集計の 4 列だけ (参加者の ID・順位・個人の値の列を含まない)', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    for (const u of [a1, a2, a3, a4, a5]) await join(challenge, u.id, { current_value: 10, rank: 1 });

    const { data, error } = await srAdmin.rpc('get_org_challenge_aggregates', { p_organization_id: orgA });
    expect(error).toBeNull();
    const row = (data as Record<string, unknown>[]).find((r) => r.challenge_id === challenge)!;
    expect(Object.keys(row).sort()).toEqual(['average_value', 'challenge_id', 'min_participants', 'participant_count'].sort());
    // 値の中にも、参加者の ID は現れない
    for (const u of [a1, a2, a3, a4, a5]) expect(JSON.stringify(data)).not.toContain(u.id);
  });
});

// ================================================================
// I. 参加者の行の RLS
// ================================================================
describe('#1132 I. 参加者の行は本人だけが読める。本人の行だけ消せる', () => {
  it('参加者は自分の行だけ読める。同じチャレンジの他の参加者・管理者・参加していないメンバー・他組織の人には、他人の行は見えない', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    await join(challenge, a1.id, { current_value: 10, rank: 2 });
    await join(challenge, a2.id, { current_value: 20, rank: 1 });
    // a2 の JWT が無いので、読むのは a1 (JWT あり)・管理者・参加していないメンバー・他組織の人

    const visibleTo = async (jwt: string) => {
      const { data, error } = await asUser(jwt)
        .from('organization_challenge_participants')
        .select('user_id, current_value, rank')
        .eq('challenge_id', challenge);
      expect(error).toBeNull();
      return (data ?? []).map((r) => r.user_id as string).sort();
    };

    expect(await visibleTo(a1.jwt!)).toEqual([a1.id]); // 自分の行だけ。a2 の行は見えない
    expect(await visibleTo(admin.jwt!)).toEqual([]); // 管理者でも、参加者の行は読めない
    expect(await visibleTo(outsider.jwt!)).toEqual([]); // 同じ組織でも、参加していなければ読めない
    expect(await visibleTo(b1.jwt!)).toEqual([]); // 他組織の人

    const asAnon = await anon()
      .from('organization_challenge_participants')
      .select('user_id')
      .eq('challenge_id', challenge);
    expect(asAnon.data ?? []).toEqual([]);
  });

  it('参加をやめる (DELETE) のは本人の行だけ。他人の行・他組織の人の操作では消えない', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    await join(challenge, a1.id);
    await join(challenge, a2.id);

    // 管理者・参加していないメンバー・他組織の人は、a1 / a2 の行を消せない (エラーにはならず 0 件)
    for (const jwt of [admin.jwt!, outsider.jwt!, b1.jwt!]) {
      const { data, error } = await asUser(jwt)
        .from('organization_challenge_participants')
        .delete()
        .eq('challenge_id', challenge)
        .select('user_id');
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    }
    // 本人 (a1) は、自分の行だけ消せる。条件に a2 の行を含めても、a2 の行は残る
    const own = await asUser(a1.jwt!)
      .from('organization_challenge_participants')
      .delete()
      .eq('challenge_id', challenge)
      .select('user_id');
    expect(own.error).toBeNull();
    expect((own.data ?? []).map((r) => r.user_id)).toEqual([a1.id]);

    const left = await participants(challenge);
    expect([...left.keys()]).toEqual([a2.id]);
  });
});

// ================================================================
// J. 参加者向けの順位表
// ================================================================
describe('#1132 J. get_org_challenge_ranking: 参加者本人にだけ順位表を返す', () => {
  interface RankingRow {
    rank: number;
    current_value: number;
    is_me: boolean;
    nickname: string | null;
    ranked_count: number;
  }

  async function ranking(challengeId: string, userId: string, options: { limit?: number; names?: boolean } = {}) {
    const args: Record<string, unknown> = { p_challenge_id: challengeId, p_user_id: userId };
    if (options.limit !== undefined) args.p_limit = options.limit;
    if (options.names !== undefined) args.p_with_names = options.names;
    const { data, error } = await srAdmin.rpc('get_org_challenge_ranking', args);
    if (error) throw new Error(`get_org_challenge_ranking: ${error.code} ${error.message}`);
    return ((data ?? []) as RankingRow[]).map((r) => ({ ...r, current_value: Number(r.current_value) }));
  }

  /** a1=100 (1 位), a2=50 / a3=50 (2 位), a4=25 (4 位), a5=0 (5 位)。a6 は参加したばかりで未集計。former は脱退済み、b1 は他組織 */
  async function seedRanking(): Promise<string> {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    await join(challenge, a1.id, { current_value: 100, rank: 1 });
    await join(challenge, a2.id, { current_value: 50, rank: 2 });
    await join(challenge, a3.id, { current_value: 50, rank: 2 });
    await join(challenge, a4.id, { current_value: 25, rank: 4 });
    await join(challenge, a5.id, { current_value: 0, rank: 5 });
    await join(challenge, a6.id); // 未集計 (rank が NULL)
    await join(challenge, former.id, { current_value: 99, rank: 1 });
    await join(challenge, b1.id, { current_value: 99, rank: 1 });
    return challenge;
  }

  it('参加者には、順位がついている今のメンバーだけの順位表が返る。同点は同順位。本人の行に is_me が付く', async () => {
    const challenge = await seedRanking();

    const rows = await ranking(challenge, a4.id);

    expect(rows.map((r) => [r.rank, r.current_value])).toEqual([
      [1, 100],
      [2, 50],
      [2, 50],
      [4, 25],
      [5, 0],
    ]);
    expect(rows.filter((r) => r.is_me)).toHaveLength(1);
    expect(rows.find((r) => r.is_me)).toMatchObject({ rank: 4, current_value: 25 });
    // 順位がついていない参加者 (a6)・脱退した人・他組織の人は入らない。全員の人数は ranked_count
    expect(new Set(rows.map((r) => Number(r.ranked_count)))).toEqual(new Set([5]));
  });

  it('返す列は 5 列だけ。他人の user_id は含まれない。表示名は p_with_names が true のときだけ入る', async () => {
    const challenge = await seedRanking();

    const hidden = await srAdmin.rpc('get_org_challenge_ranking', { p_challenge_id: challenge, p_user_id: a1.id });
    expect(hidden.error).toBeNull();
    const hiddenRows = hidden.data as Record<string, unknown>[];
    for (const row of hiddenRows) {
      expect(Object.keys(row).sort()).toEqual(['current_value', 'is_me', 'nickname', 'ranked_count', 'rank'].sort());
      expect(row.nickname, '表示名は、指定しなければ入らない').toBeNull();
    }
    const everything = JSON.stringify(hiddenRows);
    for (const user of [a1, a2, a3, a4, a5, a6, former, b1]) expect(everything).not.toContain(user.id);

    const named = await ranking(challenge, a1.id, { names: true });
    expect(named.map((r) => r.nickname).sort()).toEqual(
      ['it1132-a1', 'it1132-a2', 'it1132-a3', 'it1132-a4', 'it1132-a5'].sort(),
    );
  });

  it('上位 p_limit 人に、本人の行が (圏外でも) 付く。ranked_count は全体の人数のまま', async () => {
    const challenge = await seedRanking();

    const outside = await ranking(challenge, a5.id, { limit: 2 });
    expect(outside.map((r) => r.rank)).toEqual([1, 2, 5]); // 上位 2 人 + 本人 (5 位)
    expect(outside[2]).toMatchObject({ is_me: true, current_value: 0 });
    expect(new Set(outside.map((r) => Number(r.ranked_count)))).toEqual(new Set([5]));

    const inside = await ranking(challenge, a1.id, { limit: 2 });
    expect(inside.map((r) => r.rank)).toEqual([1, 2]); // 本人 (1 位) は上位に入っている。重ねて付かない
    expect(inside.filter((r) => r.is_me)).toHaveLength(1);

    // p_limit が 0 以下でも、1 人は返る
    expect(await ranking(challenge, a1.id, { limit: 0 })).toHaveLength(1);
  });

  it('参加していない人 (管理者・同じ組織の非参加者・脱退した人・他組織の人) には 0 行。未集計の参加者には、順位表だけ返る', async () => {
    const challenge = await seedRanking();

    // a7 は、同じ組織の「別のチャレンジ」には参加しているが、このチャレンジには参加していない
    const another = await createChallenge({ type: 'veg_score', start: START, end: END });
    await join(another, a7.id);

    expect(await ranking(challenge, admin.id)).toEqual([]);
    expect(await ranking(challenge, outsider.id)).toEqual([]);
    expect(await ranking(challenge, a7.id)).toEqual([]); // 別のチャレンジに参加していても、このチャレンジの順位表は見られない
    expect(await ranking(challenge, former.id)).toEqual([]); // 参加行はあるが、いまは組織のメンバーではない
    expect(await ranking(challenge, b1.id)).toEqual([]); // 参加行はあるが、別の組織のメンバー

    // a6 は参加している (まだ集計されていない)。順位表は見られるが、本人の行はまだ無い
    const waiting = await ranking(challenge, a6.id);
    expect(waiting).toHaveLength(5);
    expect(waiting.some((r) => r.is_me)).toBe(false);
  });

  it('順位がついた人が 1 人もいないチャレンジでは 0 行', async () => {
    const challenge = await createChallenge({ type: 'breakfast_rate', start: START, end: END });
    await join(challenge, a1.id);

    expect(await ranking(challenge, a1.id)).toEqual([]);
  });
});
