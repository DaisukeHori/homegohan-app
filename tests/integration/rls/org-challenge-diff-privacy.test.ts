/**
 * #1688 組織チャレンジの集計の差分から、やめた人の値を逆算させない守り (supabase/migrations/*_org_challenge_diff_privacy.sql) の回帰テスト
 *
 * 設計: docs/design/org/10-challenge-diff-privacy.md (§4.1 の構造 (a)〜(f)・§13 の節 A〜V)。
 *   (a) 平均は completed への遷移で 1 回だけ確定する (org_challenge_finalize)。開催中は出さない
 *   (b) 参加者数は延べ数 (org_challenge_count_join)。やめる・外れる・退会で減らない
 *   (c) 状態の遷移表と、開始後の期間・種類・部署の不変 (org_challenge_guard_update)。状態は NOT NULL
 *   (d) 順位表は、組織の管理者と、管理者だった印 (org_challenge_mark_admin) のある人に返さない
 *   (e) 同じ種類で期間が重なるチャレンジの平均は、先に確定した 1 本だけ。確定は組織ごとの鍵で 1 本ずつ進み、確定の時刻は鍵の後の時計
 *   (f) 利用者の権限で消せるのは draft と cancelled だけ
 *
 * 後片付けと fixture:
 *   ① afterEach で、その it で作ったチャレンジを service_role で消す (参加行・集計の控え・印は CASCADE で消える。
 *      service_role の DELETE は RESTRICTIVE の削除のポリシーを通らない)。(e) の判定は組織の中のチャレンジすべてを相手にし、
 *      夜の集計は DB 中の開催中のチャレンジを全部処理するので、前の it のチャレンジを残さない。R の場合分けは it を分ける
 *   ② メンバーを外す・抜けさせる・役割を変える it は、finally で service_role で所属と役割を元に戻す
 *   ③ 日付と p_now は過去の年 (2019 年)。今の日付の、他のファイルのチャレンジに夜の集計を当てない
 *   ④ 招待 (I・I2) は it ごとに別の利用者に出す (同じ組織から同じ宛先への招待は 24 時間に 3 本まで)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/org-challenge-diff-privacy.test.ts
 * migration の埋め戻しの節 (N) と並行の確定 (V) は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) で流す。
 * 本番には接続しない。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import ws from 'ws';
import { createLockHolderKit, type Holder } from '../helpers/lock-holder';
import { createPlaceholderOrgOwner, deletePlaceholderOrgOwner } from '../helpers/org-owner';
import { retryIdempotentSetup } from '../helpers/setup-transient-retry';

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

/** ローカルスタックの postgres-meta で SQL を実行する (postgres として 1 つのトランザクション) */
async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${url}/pg/query`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

// ---------------------------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------------------------

/** 集計の最小人数 (#1600。要件書 §6.4 の匿名化集計の最低人数) */
const MIN = 10;
/** 本件の migration の名前の末尾 (N で埋め戻しの節を読む) */
const MIGRATION_SUFFIX = '_org_challenge_diff_privacy.sql';
const BACKFILL_HEADING = '-- 11. 既存のチャレンジの埋め戻し';

// 2019-03-04 (月) 〜 03-07 (木) の 4 日間。過去の年なので、他のファイルのチャレンジに夜の集計が当たらない
const START = '2019-03-04';
const END = '2019-03-07';
/** JST 2019-03-08 12:00。今日 = 03-08 で、終了日 (03-07) を過ぎている */
const NOW_AFTER_END = '2019-03-08T03:00:00Z';
/** JST 2019-03-10 12:00。終了日から 3 日たった (夜の集計が 3 晩止まっていた) */
const NOW_LATE = '2019-03-10T03:00:00Z';
/** 期間が START〜END と重ならない (R-4) / 終了日と開始日が同じ (R-5) */
const LATER_START = '2019-03-08';
const LATER_END = '2019-03-11';

interface TestUser {
  id: string;
  jwt: string | null;
  email: string;
}

const RUN = randomBytes(4).toString('hex');
const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`; // 使い捨てユーザー用。実行のたびに変わる
const createdUserIds: string[] = [];
const createdChallengeIds: string[] = [];

let orgA = '';
let orgB = '';
/** 組織の持ち主 (owner_id は NOT NULL。#1103 項目 10)。どの組織のメンバーでもない。afterAll で組織の後に消す */
let orgOwnerId = '';
let deptA = '';
let owner: TestUser; // 組織 A の owner (招待を出す)
let admin: TestUser; // 組織 A の admin (PostgREST を直接叩く)
let m: TestUser[] = []; // 組織 A の一般メンバー 11 人 (m[0] は JWT あり)
let y1: TestUser; // I: 招待で admin → member と往復する人
let y2: TestUser; // I2: 抜けて入り直す人
let former: TestUser; // どの組織にも所属しない (参加行だけが残る)

async function createUser(label: string, options: { signIn?: boolean } = {}): Promise<TestUser> {
  const email = `it1688-${label}-${RUN}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await retryIdempotentSetup(srAdmin, 'createUser: user_profiles の upsert', (db) =>
    db.from('user_profiles')
      .upsert({ id: data.user.id, nickname: `it1688-${label}`, age_group: '30s', gender: 'other' }, { onConflict: 'id' }));
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  let jwt: string | null = null;
  if (options.signIn) {
    // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
    const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
    if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
    jwt = signIn.data.session.access_token;
  }
  return { id: data.user.id, jwt, email };
}

const jwtOf = (user: TestUser): string => {
  if (!user.jwt) throw new Error('この利用者は JWT を持たない');
  return user.jwt;
};

/** 所属は特権列のため service_role で設定する */
async function setMembership(
  userId: string,
  orgId: string | null,
  orgRole: 'owner' | 'admin' | 'member' = 'member',
  departmentId: string | null = null,
) {
  const { error } = await srAdmin
    .from('user_profiles')
    .update({
      organization_id: orgId,
      org_role: orgId ? orgRole : null,
      is_active_in_org: orgId !== null,
      department_id: departmentId,
    })
    .eq('id', userId);
  if (error) throw new Error(`setMembership: ${error.message}`);
}

interface ChallengeSeed {
  org?: string;
  type?: string;
  status?: string;
  start?: string;
  end?: string;
  departmentId?: string | null;
}

async function createChallenge(seed: ChallengeSeed = {}): Promise<string> {
  const { data, error } = await srAdmin
    .from('organization_challenges')
    .insert({
      organization_id: seed.org ?? orgA,
      title: `it1688-${seed.type ?? 'breakfast_rate'}-${RUN}`,
      challenge_type: seed.type ?? 'breakfast_rate',
      start_date: seed.start ?? START,
      end_date: seed.end ?? END,
      status: seed.status ?? 'active',
      department_id: seed.departmentId ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`organization_challenges: ${error?.message}`);
  createdChallengeIds.push(data.id);
  return data.id as string;
}

/** 参加行を service_role で作る (集計済みの値を入れられる。延べ数のトリガーは service_role の INSERT でも動く) */
async function join(challengeId: string, userId: string, extra: Record<string, unknown> = {}) {
  const { error } = await srAdmin
    .from('organization_challenge_participants')
    .insert({ challenge_id: challengeId, user_id: userId, ...extra });
  if (error) throw new Error(`participant: ${error.message}`);
}

/** 先頭から n 人を、値 10, 20, ... (順位つき) で参加させる */
async function joinRanked(challengeId: string, users: TestUser[]) {
  for (const [i, u] of users.entries()) {
    await join(challengeId, u.id, { current_value: (i + 1) * 10, rank: users.length - i });
  }
}

interface AggregateRow {
  challenge_id: string;
  joined_count: number;
  finalized_at: string | null;
  final_ranked_count: number | null;
  final_average_value: number | null;
}

/** 集計の控えの行 (service_role で読む) */
async function controlRow(challengeId: string): Promise<AggregateRow | null> {
  const { data, error } = await srAdmin
    .from('organization_challenge_aggregates')
    .select('challenge_id, joined_count, finalized_at, final_ranked_count, final_average_value')
    .eq('challenge_id', challengeId)
    .maybeSingle();
  if (error) throw new Error(`organization_challenge_aggregates: ${error.message}`);
  if (!data) return null;
  const row = data as AggregateRow;
  return { ...row, final_average_value: row.final_average_value === null ? null : Number(row.final_average_value) };
}

interface PublicAggregate {
  participant_count: number | null;
  min_participants: number;
  average_value: number | null;
}

/** 管理者に見せる集計 (get_org_challenge_aggregates) */
async function aggregates(orgId: string = orgA): Promise<Map<string, PublicAggregate>> {
  const { data, error } = await srAdmin.rpc('get_org_challenge_aggregates', { p_organization_id: orgId });
  if (error) throw new Error(`get_org_challenge_aggregates: ${error.code} ${error.message}`);
  const rows = (data ?? []) as Array<PublicAggregate & { challenge_id: string }>;
  return new Map(
    rows.map((r) => [
      r.challenge_id,
      {
        participant_count: r.participant_count,
        min_participants: r.min_participants,
        average_value: r.average_value === null ? null : Number(r.average_value),
      },
    ]),
  );
}

async function aggregateOf(challengeId: string): Promise<PublicAggregate> {
  const row = (await aggregates()).get(challengeId);
  if (!row) throw new Error(`集計に ${challengeId} が無い`);
  return row;
}

/** 参加者に見せる順位表 (get_org_challenge_ranking)。返った行数 */
async function rankingRows(challengeId: string, userId: string): Promise<number> {
  const { data, error } = await srAdmin.rpc('get_org_challenge_ranking', { p_challenge_id: challengeId, p_user_id: userId });
  if (error) throw new Error(`get_org_challenge_ranking: ${error.code} ${error.message}`);
  return ((data ?? []) as unknown[]).length;
}

/** 管理者だった印の数 (challengeId を省くと、その人の印すべて) */
async function exclusionCount(userId: string, challengeId?: string): Promise<number> {
  let query = srAdmin
    .from('organization_challenge_ranking_exclusions')
    .select('challenge_id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (challengeId) query = query.eq('challenge_id', challengeId);
  const { count, error } = await query;
  if (error) throw new Error(`organization_challenge_ranking_exclusions: ${error.message}`);
  return count ?? 0;
}

async function challengeRow(challengeId: string) {
  const { data, error } = await srAdmin
    .from('organization_challenges')
    .select('status, start_date, end_date, challenge_type, department_id, organization_id, title')
    .eq('id', challengeId)
    .single();
  if (error || !data) throw new Error(`challenge: ${error?.message}`);
  return data as Record<string, string | null>;
}

/** service_role で completed にする (確定のトリガーが動く) */
async function complete(challengeId: string) {
  const { error } = await srAdmin.from('organization_challenges').update({ status: 'completed' }).eq('id', challengeId);
  if (error) throw new Error(`complete: ${error.code} ${error.message}`);
}

async function runProgress(pNow: string) {
  const { error } = await srAdmin.rpc('update_org_challenge_progress', { p_now: pNow });
  if (error) throw new Error(`update_org_challenge_progress: ${error.code} ${error.message}`);
}

/** 朝食の記録 (完了) を、指定した日付ぶん作る */
async function seedBreakfasts(userId: string, days: string[]) {
  for (const day of days) {
    const { data, error } = await srAdmin
      .from('user_daily_meals')
      .insert({ user_id: userId, day_date: day, is_sandbox: false })
      .select('id')
      .single();
    if (error || !data) throw new Error(`user_daily_meals ${day}: ${error?.message}`);
    const { error: mealError } = await srAdmin
      .from('planned_meals')
      .insert({ daily_meal_id: data.id, meal_type: 'breakfast', dish_name: 'it1688', is_completed: true });
    if (mealError) throw new Error(`planned_meals ${day}: ${mealError.message}`);
  }
}

/** 管理者の JWT で PostgREST の UPDATE。エラーの code と message を返す */
async function adminUpdate(challengeId: string, values: Record<string, unknown>) {
  const { error } = await asUser(jwtOf(admin)).from('organization_challenges').update(values).eq('id', challengeId);
  return error;
}

/** 招待を owner が出し、本人の JWT で承諾する */
async function acceptInvite(user: TestUser, role: 'admin' | 'member') {
  const { data, error } = await asUser(jwtOf(owner)).rpc('create_org_invite', {
    p_organization_id: orgA,
    p_email: user.email,
    p_role: role,
  });
  if (error || !data) throw new Error(`create_org_invite ${role}: ${error?.message}`);
  const accepted = await asUser(jwtOf(user)).rpc('accept_org_invite', { p_token: (data as { token: string }).token });
  if (accepted.error) throw new Error(`accept_org_invite ${role}: ${accepted.error.message}`);
}

async function leaveOrg(user: TestUser) {
  const { error } = await asUser(jwtOf(user)).rpc('leave_org');
  if (error) throw new Error(`leave_org: ${error.message}`);
}

// ---------------------------------------------------------------------------------------------
// 並行の確定 (V)。先の接続は放されるまでトランザクションを開いたままにし、後の確定が鍵の待ちに並んだのを確かめてから
// (または後の確定が済んでから) 放す (tests/integration/helpers/lock-holder.ts。決まった秒数の窓に頼らない。#1917)
// ---------------------------------------------------------------------------------------------

const holders = createLockHolderKit({ pgRequest, markerPrefix: 'it1688' });

/** before を流してから放されるまで開いておき、放されたら after を流してコミットする接続 */
function startHolder(before: string, after: string): Holder {
  return holders.startHolder('先に開いた確定の接続', before, after);
}

/** advisory lock の待ち (pg_stat_activity の wait_event)。同じ組織の確定が鍵で 1 本ずつ進むことを、待ちそのもので確かめる */
const ADVISORY_WAIT_EVENT = 'advisory';

/** 集計の控えの (finalized_at, challenge_id) の順で、先に確定したチャレンジ */
async function firstFinalized(ids: string[]): Promise<string> {
  const rows = await pgQuery<{ challenge_id: string }>(`
    SELECT challenge_id::text FROM public.organization_challenge_aggregates
     WHERE challenge_id IN (${ids.map((id) => `'${id}'::uuid`).join(', ')}) AND finalized_at IS NOT NULL
     ORDER BY finalized_at, challenge_id LIMIT 1`);
  if (!rows[0]) throw new Error('確定したチャレンジが無い');
  return rows[0].challenge_id;
}

// ---------------------------------------------------------------------------------------------
// 準備と後片付け
// ---------------------------------------------------------------------------------------------

beforeAll(async () => {
  orgOwnerId = await createPlaceholderOrgOwner(srAdmin, '1688');
  const { data: orgs, error: orgError } = await srAdmin
    .from('organizations')
    .insert([
      { name: `#1688 Org A ${RUN}`, owner_id: orgOwnerId },
      { name: `#1688 Org B ${RUN}`, owner_id: orgOwnerId },
    ])
    .select('id, name');
  if (orgError || !orgs) throw new Error(`organizations: ${orgError?.message}`);
  orgA = orgs.find((o) => o.name.startsWith('#1688 Org A'))!.id;
  orgB = orgs.find((o) => o.name.startsWith('#1688 Org B'))!.id;

  const { data: dept, error: deptError } = await srAdmin
    .from('departments')
    .insert({ organization_id: orgA, name: `it1688 dept ${RUN}` })
    .select('id')
    .single();
  if (deptError || !dept) throw new Error(`departments: ${deptError?.message}`);
  deptA = dept.id as string;

  owner = await createUser('owner', { signIn: true });
  admin = await createUser('admin', { signIn: true });
  y1 = await createUser('y1', { signIn: true });
  y2 = await createUser('y2', { signIn: true });
  former = await createUser('former');
  m = [await createUser('m0', { signIn: true })];
  for (let i = 1; i <= MIN; i++) m.push(await createUser(`m${i}`));

  // 役割はチャレンジが 1 本も無いうちに設定する (印は管理者になった時点にあったチャレンジにだけ付く)
  await setMembership(owner.id, orgA, 'owner');
  await setMembership(admin.id, orgA, 'admin');
  for (const u of [...m, y1, y2]) await setMembership(u.id, orgA, 'member');
}, 180_000);

afterEach(async () => {
  // 並行の確定のトランザクションが終わってから消す (テストが途中で落ちて残った接続は、作った順に放す)
  await holders.releaseOpenHolders();
  await holders.settle();
  if (createdChallengeIds.length > 0) {
    await srAdmin.from('organization_challenges').delete().in('id', createdChallengeIds);
    createdChallengeIds.length = 0;
  }
  await srAdmin.from('user_daily_meals').delete().in('user_id', createdUserIds);
}, 60_000);

afterAll(async () => {
  await holders.settle();
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    await srAdmin.from('organization_challenges').delete().eq('organization_id', orgId);
    await srAdmin.from('organization_invites').delete().eq('organization_id', orgId);
  }
  if (createdUserIds.length > 0) {
    await srAdmin.from('membership_audit').delete().in('actor_id', createdUserIds);
    await srAdmin.from('membership_audit').delete().in('target_user_id', createdUserIds);
    await srAdmin
      .from('user_profiles')
      .update({ organization_id: null, org_role: null, is_active_in_org: false, department_id: null })
      .in('id', createdUserIds);
  }
  if (deptA) await srAdmin.from('departments').delete().eq('id', deptA);
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    await srAdmin.from('organizations').delete().eq('id', orgId);
  }
  // 持ち主は組織を消した後に消す (owner_id → auth.users は ON DELETE RESTRICT)
  if (orgOwnerId) await deletePlaceholderOrgOwner(srAdmin, orgOwnerId);
  for (const id of createdUserIds) {
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 120_000);

const ten = () => m.slice(0, MIN);
const eleven = () => m.slice(0, MIN + 1);

// ================================================================
// A〜F. 延べ数と確定
// ================================================================
describe('#1688 A〜F. 参加者数は延べ数・平均は終了時に 1 回だけ確定', () => {
  it('A: joined_count は参加で +1 し、やめても・組織から外れても (remove_org_member)・退会しても減らない。再参加は 2 と数える', async () => {
    const challenge = await createChallenge();
    const leaving = await createUser('a-leaving');
    await setMembership(leaving.id, orgA, 'member');
    await join(challenge, m[0].id);
    await join(challenge, m[1].id);
    await join(challenge, leaving.id);
    expect((await controlRow(challenge))!.joined_count).toBe(3);

    try {
      // 本人がやめる (利用者の JWT の DELETE)
      const left = await asUser(jwtOf(m[0])).from('organization_challenge_participants').delete().eq('challenge_id', challenge);
      expect(left.error).toBeNull();
      // 管理者が組織から外す
      const removed = await asUser(jwtOf(admin)).rpc('remove_org_member', { p_organization_id: orgA, p_user_id: m[1].id });
      expect(removed.error).toBeNull();
      // 退会 (所属を外してからアカウントを消す。参加行は外部キーの CASCADE で消える)
      expect((await srAdmin.rpc('release_user_membership', { p_user_id: leaving.id })).error).toBeNull();
      expect((await srAdmin.auth.admin.deleteUser(leaving.id)).error).toBeNull();
      createdUserIds.splice(createdUserIds.indexOf(leaving.id), 1);

      expect((await controlRow(challenge))!.joined_count).toBe(3);

      // やめた人がもう一度参加すると、延べで 4
      await join(challenge, m[0].id);
      expect((await controlRow(challenge))!.joined_count).toBe(4);
    } finally {
      await setMembership(m[1].id, orgA, 'member');
    }
  });

  it('B: 開催中は順位がついた人が 10 人いても average_value は NULL。participant_count は延べ数で 9 なら NULL・10 で出る', async () => {
    const challenge = await createChallenge();
    await joinRanked(challenge, m.slice(0, MIN - 1));
    expect(await aggregateOf(challenge)).toEqual({ participant_count: null, min_participants: MIN, average_value: null });

    await join(challenge, m[MIN - 1].id, { current_value: 100, rank: 1 });
    expect(await aggregateOf(challenge)).toEqual({ participant_count: MIN, min_participants: MIN, average_value: null });
    expect((await controlRow(challenge))!.finalized_at).toBeNull();
  });

  it('C: 終了日を過ぎた夜の集計で completed になると、その時点の順位がついた今のメンバーの平均 (小数第 1 位) と人数が確定する', async () => {
    const challenge = await createChallenge();
    const days = ['2019-03-04', '2019-03-05', '2019-03-06', '2019-03-07'];
    // 10 人の朝食の日数は 1, 2, 3, 4, 0, 1, 2, 3, 4, 0 日 → 25, 50, 75, 100, 0, ... (平均 50)
    for (const [i, u] of ten().entries()) {
      await join(challenge, u.id);
      await seedBreakfasts(u.id, days.slice(0, (i + 1) % (days.length + 1)));
    }
    // 組織に所属しない人の参加行 (毎日の朝食あり) は、延べ数には入るが、値も平均も計算しない
    await join(challenge, former.id);
    await seedBreakfasts(former.id, days);

    await runProgress(NOW_AFTER_END);

    expect((await challengeRow(challenge)).status).toBe('completed');
    const control = (await controlRow(challenge))!;
    expect(control.finalized_at).not.toBeNull();
    expect(control.final_ranked_count).toBe(MIN);
    expect(control.final_average_value).toBe(50);
    expect(await aggregateOf(challenge)).toEqual({ participant_count: MIN + 1, min_participants: MIN, average_value: 50 });
  });

  it('D: 確定後に参加をやめる・組織から外れる・service_role で値や順位を書き換えても average_value は変わらない', async () => {
    const challenge = await createChallenge();
    await joinRanked(challenge, ten()); // 10〜100 → 平均 55
    await complete(challenge);
    expect((await aggregateOf(challenge)).average_value).toBe(55);

    try {
      await asUser(jwtOf(m[0])).from('organization_challenge_participants').delete().eq('challenge_id', challenge);
      const removed = await asUser(jwtOf(admin)).rpc('remove_org_member', { p_organization_id: orgA, p_user_id: m[1].id });
      expect(removed.error).toBeNull();
      await srAdmin.from('organization_challenge_participants').update({ current_value: 0, rank: 1 }).eq('challenge_id', challenge);

      expect(await aggregateOf(challenge)).toEqual({ participant_count: MIN, min_participants: MIN, average_value: 55 });
      expect((await controlRow(challenge))!.final_ranked_count).toBe(MIN);
    } finally {
      await setMembership(m[1].id, orgA, 'member');
    }
  });

  it('E: 確定は 1 回だけ。completed のまま値を変えて、状態の同じ値の上書き・夜の集計を流しても final_* は変わらない', async () => {
    const challenge = await createChallenge();
    await joinRanked(challenge, ten());
    await complete(challenge);
    const first = (await controlRow(challenge))!;

    await srAdmin.from('organization_challenge_participants').update({ current_value: 1, rank: 1 }).eq('challenge_id', challenge);
    await complete(challenge); // completed → completed (遷移ではないので確定のトリガーは動かない)
    await srAdmin.from('organization_challenges').update({ title: `it1688-renamed-${RUN}` }).eq('id', challenge);
    await runProgress(NOW_AFTER_END);

    expect(await controlRow(challenge)).toEqual(first);
  });

  it('F: 確定時点の順位がついた人が 9 人なら NULL、10 人なら出る', async () => {
    const nine = await createChallenge({ type: 'breakfast_rate' });
    const full = await createChallenge({ type: 'veg_score' });
    await joinRanked(nine, m.slice(0, MIN - 1));
    await join(nine, m[MIN - 1].id); // 未集計 (順位なし)
    await joinRanked(full, ten());
    await complete(nine);
    await complete(full);

    expect(await aggregateOf(nine)).toEqual({ participant_count: MIN, min_participants: MIN, average_value: null });
    expect((await controlRow(nine))!.final_ranked_count).toBe(MIN - 1);
    expect(await aggregateOf(full)).toEqual({ participant_count: MIN, min_participants: MIN, average_value: 55 });
  });
});

// ================================================================
// G・H・T・U. 状態の遷移と、開始後の不変
// ================================================================
describe('#1688 G・H・T・U. 状態の遷移表と、開始後の期間・種類・部署の不変', () => {
  it('G: 管理者の JWT で PostgREST を直接叩いても、遷移表の外へは変えられない (P0001 CHALLENGE_STATUS_LOCKED)。遷移表の 5 本は通る', async () => {
    const allowed: Array<[string, string]> = [
      ['draft', 'active'],
      ['draft', 'completed'],
      ['draft', 'cancelled'],
      ['active', 'completed'],
      ['active', 'cancelled'],
    ];
    for (const [from, to] of allowed) {
      const id = await createChallenge({ status: from });
      expect(await adminUpdate(id, { status: to }), `${from} → ${to}`).toBeNull();
      expect((await challengeRow(id)).status).toBe(to);
    }

    const locked: Array<[string, string | null]> = [
      ['completed', 'active'],
      ['completed', 'draft'],
      ['completed', 'cancelled'],
      ['cancelled', 'active'],
      ['cancelled', 'draft'],
      ['cancelled', 'completed'],
      ['active', 'draft'],
      ['active', null],
      ['draft', null],
    ];
    for (const [from, to] of locked) {
      const id = await createChallenge({ status: from });
      const error = await adminUpdate(id, { status: to });
      expect(error?.code, `${from} → ${to}`).toBe('P0001');
      expect(error?.message).toContain('CHALLENGE_STATUS_LOCKED');
      expect((await challengeRow(id)).status).toBe(from);
    }

    // NULL にできなかったので、開催中のまま期間も書き換えられない
    const active = await createChallenge({ status: 'active' });
    expect((await adminUpdate(active, { status: null }))?.message).toContain('CHALLENGE_STATUS_LOCKED');
    const period = await adminUpdate(active, { start_date: '2019-03-01' });
    expect(period?.code).toBe('P0001');
    expect(period?.message).toContain('CHALLENGE_PERIOD_LOCKED');
    expect(await challengeRow(active)).toMatchObject({ status: 'active', start_date: START });
  });

  it('H: active・completed・cancelled の期間・種類・部署と、どの状態でも organization_id は変えられない (CHALLENGE_PERIOD_LOCKED)。draft なら期間を変えられる。title は終了後も変えられる', async () => {
    const changes: Array<Record<string, unknown>> = [
      { start_date: '2019-03-01' },
      { end_date: '2019-03-20' },
      { challenge_type: 'veg_score' },
      { department_id: deptA },
    ];
    for (const status of ['active', 'completed', 'cancelled']) {
      const id = await createChallenge({ status });
      for (const change of changes) {
        const error = await adminUpdate(id, change);
        expect(error?.code, `${status} ${JSON.stringify(change)}`).toBe('P0001');
        expect(error?.message).toContain('CHALLENGE_PERIOD_LOCKED');
      }
      expect(await challengeRow(id)).toMatchObject({ start_date: START, end_date: END, challenge_type: 'breakfast_rate', department_id: null });
    }

    for (const status of ['draft', 'active', 'completed', 'cancelled']) {
      const id = await createChallenge({ status });
      // service_role でも止まる (RLS を通らない経路。ガードのトリガーは行ごとに動く)
      const { error } = await srAdmin.from('organization_challenges').update({ organization_id: orgB }).eq('id', id);
      expect(error?.code, status).toBe('P0001');
      expect(error?.message).toContain('CHALLENGE_PERIOD_LOCKED');
      expect((await challengeRow(id)).organization_id).toBe(orgA);
    }

    const draft = await createChallenge({ status: 'draft' });
    expect(await adminUpdate(draft, { start_date: '2019-03-01', end_date: '2019-03-20', challenge_type: 'veg_score' })).toBeNull();
    expect(await challengeRow(draft)).toMatchObject({ start_date: '2019-03-01', end_date: '2019-03-20', challenge_type: 'veg_score' });

    const done = await createChallenge({ status: 'completed' });
    expect(await adminUpdate(done, { title: `it1688-after-${RUN}` })).toBeNull();
    expect((await challengeRow(done)).title).toBe(`it1688-after-${RUN}`);
  });

  it('T [S-24]: service_role で status を NULL にする INSERT は 23502。管理者の JWT で status を NULL にする UPDATE は P0001 CHALLENGE_STATUS_LOCKED', async () => {
    const { error: insertError } = await srAdmin.from('organization_challenges').insert({
      organization_id: orgA,
      title: `it1688-null-${RUN}`,
      challenge_type: 'breakfast_rate',
      start_date: START,
      end_date: END,
      status: null,
    });
    expect(insertError?.code).toBe('23502');

    const id = await createChallenge({ status: 'draft' });
    const error = await adminUpdate(id, { status: null });
    expect(error?.code).toBe('P0001');
    expect(error?.message).toContain('CHALLENGE_STATUS_LOCKED');
    expect((await challengeRow(id)).status).toBe('draft');
  });

  it('U [S-11]: 中止は確定しない。そのあと夜の集計を流しても確定しない。中止からは状態も期間も変えられない', async () => {
    const challenge = await createChallenge();
    await joinRanked(challenge, ten());
    expect(await adminUpdate(challenge, { status: 'cancelled' })).toBeNull();

    const control = (await controlRow(challenge))!;
    expect(control).toMatchObject({ finalized_at: null, final_ranked_count: null, final_average_value: null });
    expect((await aggregateOf(challenge)).average_value).toBeNull();

    await runProgress(NOW_AFTER_END);
    expect((await challengeRow(challenge)).status).toBe('cancelled');
    expect((await controlRow(challenge))!.finalized_at).toBeNull();

    for (const to of ['active', 'completed', 'draft']) {
      const error = await adminUpdate(challenge, { status: to });
      expect(error?.code, to).toBe('P0001');
      expect(error?.message).toContain('CHALLENGE_STATUS_LOCKED');
    }
    const period = await adminUpdate(challenge, { start_date: '2019-03-01' });
    expect(period?.code).toBe('P0001');
    expect(period?.message).toContain('CHALLENGE_PERIOD_LOCKED');
    expect(await challengeRow(challenge)).toMatchObject({ status: 'cancelled', start_date: START });
    expect((await controlRow(challenge))!.finalized_at).toBeNull();
  });
});

// ================================================================
// I. 順位表を管理者と管理者だった人に見せない
// ================================================================
describe('#1688 I. 順位表は組織の管理者と、管理者だった印のある人には 0 行', () => {
  it('I [S-8・S-20]: owner / admin には 0 行。member には従来どおり。同じ組織の招待では役割を変えられない (#1799)。member が admin に上がると印が付き 0 行、member に戻っても 0 行', async () => {
    const challenge = await createChallenge();
    await joinRanked(challenge, [...m.slice(0, 3), owner, admin, y1]);

    expect(await rankingRows(challenge, owner.id)).toBe(0);
    expect(await rankingRows(challenge, admin.id)).toBe(0);
    // 今の役割で伏せている (印は無い。役割の設定はチャレンジを作る前)
    expect(await exclusionCount(admin.id, challenge)).toBe(0);
    expect(await rankingRows(challenge, m[0].id)).toBeGreaterThan(0);
    expect(await rankingRows(challenge, y1.id)).toBeGreaterThan(0);

    try {
      // #1799: 同じ組織の在籍者には招待を作れない (承諾で org_role を招待の役割に上書きする経路は閉じた)。役割も印も変わらない
      await expect(acceptInvite(y1, 'admin')).rejects.toThrow(/ALREADY_IN_ORG/);
      const { data: unchanged } = await srAdmin.from('user_profiles').select('org_role').eq('id', y1.id).single();
      expect(unchanged?.org_role).toBe('member');
      expect(await exclusionCount(y1.id, challenge)).toBe(0);
      expect(await rankingRows(challenge, y1.id)).toBeGreaterThan(0);

      // 役割の往復は、残る経路 (所有者の譲渡・運営の操作と同じ service_role の UPDATE) で確かめる
      await setMembership(y1.id, orgA, 'admin');
      expect(await exclusionCount(y1.id, challenge)).toBe(1);
      expect(await rankingRows(challenge, y1.id)).toBe(0);

      await setMembership(y1.id, orgA, 'member');
      const { data: profile } = await srAdmin.from('user_profiles').select('org_role').eq('id', y1.id).single();
      expect(profile?.org_role).toBe('member');
      expect(await rankingRows(challenge, y1.id)).toBe(0);
    } finally {
      await setMembership(y1.id, orgA, 'member');
    }
  });

  it('I2 [S-25]: leave_org → admin の招待で入り直す → leave_org → member の招待で入り直しても 0 行。印のあるチャレンジで参加をやめて参加し直しても 0 行', async () => {
    const challenge = await createChallenge();
    await joinRanked(challenge, [...m.slice(0, 3), y2]);
    expect(await rankingRows(challenge, y2.id)).toBeGreaterThan(0);

    try {
      await leaveOrg(y2);
      expect(await exclusionCount(y2.id, challenge)).toBe(0); // 抜けただけでは付かない
      await acceptInvite(y2, 'admin');
      expect(await exclusionCount(y2.id, challenge)).toBe(1);
      await leaveOrg(y2);
      await acceptInvite(y2, 'member');
      expect(await rankingRows(challenge, y2.id)).toBe(0);

      // 参加をやめて参加し直しても、印は参加行と別の表にあるので残る
      const left = await asUser(jwtOf(y2)).from('organization_challenge_participants').delete().eq('challenge_id', challenge);
      expect(left.error).toBeNull();
      await join(challenge, y2.id, { current_value: 10, rank: 4 });
      expect(await exclusionCount(y2.id, challenge)).toBe(1);
      expect(await rankingRows(challenge, y2.id)).toBe(0);
    } finally {
      await setMembership(y2.id, orgA, 'member');
    }
  });

  it('I3: service_role で参加者の org_role を owner にしても (所有者の譲渡・運営の操作と同じ UPDATE) 印が付き、member に戻しても 0 行', async () => {
    const challenge = await createChallenge();
    await joinRanked(challenge, m.slice(0, 3));
    expect(await rankingRows(challenge, m[1].id)).toBeGreaterThan(0);

    try {
      await setMembership(m[1].id, orgA, 'owner');
      expect(await exclusionCount(m[1].id, challenge)).toBe(1);
      await setMembership(m[1].id, orgA, 'member');
      expect(await rankingRows(challenge, m[1].id)).toBe(0);
    } finally {
      await setMembership(m[1].id, orgA, 'member');
    }
  });

  it('I4: 管理者だった間に無かったチャレンジの順位表は返る。役割も組織も変わらない UPDATE (nickname・同じ役割の上書き) では印が増えない', async () => {
    const before = await createChallenge();
    try {
      await setMembership(m[2].id, orgA, 'admin');
      await setMembership(m[2].id, orgA, 'member');
      expect(await exclusionCount(m[2].id, before)).toBe(1);

      // member に戻ったあとに作られたチャレンジ
      const after = await createChallenge();
      await joinRanked(after, m.slice(0, 3));
      expect(await exclusionCount(m[2].id, after)).toBe(0);
      expect(await rankingRows(after, m[2].id)).toBeGreaterThan(0);

      // 管理者のまま、ほかの列や同じ役割を上書きしても、その後にできたチャレンジに印は付かない
      await setMembership(m[3].id, orgA, 'admin');
      const later = await createChallenge();
      await srAdmin.from('user_profiles').update({ nickname: `it1688-renamed-${RUN}` }).eq('id', m[3].id);
      await srAdmin.from('user_profiles').update({ org_role: 'admin' }).eq('id', m[3].id);
      expect(await exclusionCount(m[3].id, later)).toBe(0);
      expect(await exclusionCount(m[3].id, before)).toBe(1);
    } finally {
      await setMembership(m[2].id, orgA, 'member');
      await setMembership(m[3].id, orgA, 'member');
    }
  });
});

// ================================================================
// J・K・L. 権限・退会・カタログ
// ================================================================
describe('#1688 J・K・L. 新しい表の権限・退会・トリガー', () => {
  it('J: 集計の表と印の表は利用者の JWT では読めない・書けない。service_role は読める', async () => {
    const challenge = await createChallenge();
    await join(challenge, m[0].id);
    const writes: Record<string, Record<string, unknown>> = {
      organization_challenge_aggregates: { challenge_id: challenge, joined_count: 1 },
      organization_challenge_ranking_exclusions: { challenge_id: challenge, user_id: m[0].id },
    };
    for (const [table, row] of Object.entries(writes)) {
      for (const jwt of [jwtOf(m[0]), jwtOf(admin)]) {
        const read = await asUser(jwt).from(table).select('*');
        expect(read.error?.code, `${table} の SELECT`).toBe('42501');
        const write = await asUser(jwt).from(table).insert(row);
        expect(write.error?.code, `${table} の INSERT`).toBe('42501');
      }
      const service = await srAdmin.from(table).select('challenge_id').eq('challenge_id', challenge);
      expect(service.error, table).toBeNull();
    }
    expect((await controlRow(challenge))!.joined_count).toBe(1);
  });

  it('K: 退会 (auth.users の削除) で参加行と印が消えても joined_count と確定値は変わらない', async () => {
    const challenge = await createChallenge();
    const leaving = await createUser('k-leaving');
    await setMembership(leaving.id, orgA, 'admin'); // 印を付ける
    await setMembership(leaving.id, orgA, 'member');
    await joinRanked(challenge, ten());
    await join(challenge, leaving.id, { current_value: 0, rank: MIN + 1 });
    expect(await exclusionCount(leaving.id, challenge)).toBe(1);
    await complete(challenge);
    const finalized = (await controlRow(challenge))!;
    expect(finalized).toMatchObject({ joined_count: MIN + 1, final_ranked_count: MIN + 1, final_average_value: 50 });

    expect((await srAdmin.rpc('release_user_membership', { p_user_id: leaving.id })).error).toBeNull();
    expect((await srAdmin.auth.admin.deleteUser(leaving.id)).error).toBeNull();
    createdUserIds.splice(createdUserIds.indexOf(leaving.id), 1);

    const { count: rows } = await srAdmin
      .from('organization_challenge_participants')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', leaving.id);
    expect(rows).toBe(0);
    expect(await exclusionCount(leaving.id)).toBe(0);
    expect(await controlRow(challenge)).toEqual(finalized);
  });

  it('L: トリガー関数 4 本の EXECUTE は PUBLIC・anon・authenticated・service_role に無い。トリガー 4 本が付いている', async () => {
    const functions = ['org_challenge_count_join', 'org_challenge_guard_update', 'org_challenge_finalize', 'org_challenge_mark_admin'];
    const procs = await pgQuery<{ proname: string; acl: string | null; anon: boolean; auth: boolean; service: boolean }>(`
      SELECT p.proname,
             p.proacl::text AS acl,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
        FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN (${functions.map((f) => `'${f}'`).join(', ')})`);
    expect(procs.map((p) => p.proname).sort()).toEqual([...functions].sort());
    for (const p of procs) {
      expect(p, p.proname).toMatchObject({ anon: false, auth: false, service: false });
      // PUBLIC への付与 (=X/...) が無い
      expect(p.acl ?? '', p.proname).not.toMatch(/(^|[{,])=X/);
    }

    const triggers = await pgQuery<{ tgname: string; relname: string }>(`
      SELECT t.tgname, c.relname FROM pg_trigger AS t JOIN pg_class AS c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal AND t.tgname IN ('trg_org_challenge_count_join', 'trg_org_challenge_guard_update',
                                                 'trg_org_challenge_finalize', 'trg_org_challenge_mark_admin')`);
    expect(triggers.map((t) => `${t.relname}.${t.tgname}`).sort()).toEqual(
      [
        'organization_challenge_participants.trg_org_challenge_count_join',
        'organization_challenges.trg_org_challenge_guard_update',
        'organization_challenges.trg_org_challenge_finalize',
        'user_profiles.trg_org_challenge_mark_admin',
      ].sort(),
    );
  });
});

// ================================================================
// M・N・O・P. 手動の終了・埋め戻し・夜の集計の止まり・部署の変更
// ================================================================
describe('#1688 M・N・O・P. 確定の経路と、母集団の外の変更', () => {
  it('M [S-10]: 管理者の JWT で active を completed にすると、その時点の参加行の平均と人数で確定する。そのあと夜の集計が走っても変わらない', async () => {
    const challenge = await createChallenge();
    await joinRanked(challenge, ten());
    await join(challenge, former.id, { current_value: 1000, rank: 1 }); // 組織に所属しない人は入らない
    expect(await adminUpdate(challenge, { status: 'completed' })).toBeNull();

    const finalized = (await controlRow(challenge))!;
    expect(finalized).toMatchObject({ final_ranked_count: MIN, final_average_value: 55 });

    await runProgress(NOW_AFTER_END);
    expect(await controlRow(challenge)).toEqual(finalized);
  });

  it('N [S-15]: migration の埋め戻しの節は、active を未確定・completed を順位がついた今のメンバーで確定し、確定済みは上書きしない。2 回流しても同じ', async () => {
    const files = fs.readdirSync(path.join(process.cwd(), 'supabase/migrations')).filter((f) => f.endsWith(MIGRATION_SUFFIX));
    expect(files).toHaveLength(1);
    const migration = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations', files[0]), 'utf-8');
    const at = migration.indexOf(BACKFILL_HEADING);
    expect(at).toBeGreaterThan(0);
    const backfill = migration.slice(at);

    const active = await createChallenge({ status: 'active' });
    const completed = await createChallenge({ status: 'completed', type: 'veg_score' }); // INSERT なので確定のトリガーは動かない
    const already = await createChallenge({ status: 'active', type: 'cooking_rate' });
    await joinRanked(active, ten());
    await joinRanked(completed, ten());
    await join(completed, m[MIN].id); // 順位なし (平均に入らない)
    await join(completed, former.id, { current_value: 1000, rank: 1 }); // 今のメンバーでない
    await joinRanked(already, ten());
    await complete(already);
    const alreadyFinal = (await controlRow(already))!;
    // 確定のあとに値を変えておく (埋め戻しが上書きすれば変わる)
    await srAdmin.from('organization_challenge_participants').update({ current_value: 0 }).eq('challenge_id', already);

    // fixture の控えの行を消してから、埋め戻しの節だけを流す
    await srAdmin.from('organization_challenge_aggregates').delete().in('challenge_id', [active, completed]);
    await pgQuery(backfill);

    const activeRow = (await controlRow(active))!;
    const completedRow = (await controlRow(completed))!;
    expect(activeRow).toMatchObject({ joined_count: MIN, finalized_at: null, final_ranked_count: null, final_average_value: null });
    expect(completedRow).toMatchObject({ joined_count: MIN + 2, final_ranked_count: MIN, final_average_value: 55 });
    expect(completedRow.finalized_at).not.toBeNull();
    expect(await controlRow(already)).toEqual(alreadyFinal);

    await pgQuery(backfill);
    expect(await controlRow(active)).toEqual(activeRow);
    expect(await controlRow(completed)).toEqual(completedRow);
    expect(await controlRow(already)).toEqual(alreadyFinal);
  });

  it('O [S-17]: 夜の集計が 3 晩止まったあとの 1 回の呼び出しで、計算し直し・completed・確定が行われ、確定値は呼び出しの後の参加行の平均と一致する', async () => {
    const challenge = await createChallenge();
    const days = ['2019-03-04', '2019-03-05', '2019-03-06', '2019-03-07'];
    for (const [i, u] of ten().entries()) {
      await join(challenge, u.id, { current_value: 99, rank: 1 }); // 古い値 (計算し直しで変わる)
      await seedBreakfasts(u.id, days.slice(0, i % (days.length + 1)));
    }

    await runProgress(NOW_LATE);

    expect((await challengeRow(challenge)).status).toBe('completed');
    const { data } = await srAdmin
      .from('organization_challenge_participants')
      .select('current_value, rank')
      .eq('challenge_id', challenge);
    const ranked = ((data ?? []) as Array<{ current_value: number | string; rank: number | null }>).filter((r) => r.rank !== null);
    const expected = Math.round((ranked.reduce((sum, r) => sum + Number(r.current_value), 0) / ranked.length) * 10) / 10;
    const control = (await controlRow(challenge))!;
    expect(ranked).toHaveLength(MIN);
    expect(control.final_ranked_count).toBe(MIN);
    expect(control.final_average_value).toBe(expected);
    expect(control.final_average_value).not.toBe(99);

    // 控えの表の時刻の列は finalized_at と updated_at だけ (計算日を別に持たない)
    const { data: full } = await srAdmin.from('organization_challenge_aggregates').select('*').eq('challenge_id', challenge).single();
    expect(Object.keys(full ?? {}).sort()).toEqual(
      ['challenge_id', 'final_average_value', 'final_ranked_count', 'finalized_at', 'joined_count', 'updated_at'].sort(),
    );
  });

  it('P [S-19]: service_role で参加者の department_id を変えても、順位表と確定の人数に残り joined_count も変わらない。利用者の JWT では変えられない', async () => {
    const challenge = await createChallenge();
    await joinRanked(challenge, ten());
    const before = (await controlRow(challenge))!.joined_count;

    try {
      const { error } = await srAdmin.from('user_profiles').update({ department_id: deptA }).eq('id', m[4].id);
      expect(error).toBeNull();

      const { data: ranking } = await srAdmin.rpc('get_org_challenge_ranking', { p_challenge_id: challenge, p_user_id: m[0].id });
      expect((ranking as Array<{ ranked_count: number }>)[0].ranked_count).toBe(MIN);
      expect((await controlRow(challenge))!.joined_count).toBe(before);
      await complete(challenge);
      expect((await controlRow(challenge))!.final_ranked_count).toBe(MIN);

      const own = await asUser(jwtOf(m[0])).from('user_profiles').update({ department_id: deptA }).eq('id', m[0].id);
      expect(own.error?.message).toContain('CANNOT_MODIFY_PRIVILEGED_COLUMN');
    } finally {
      await setMembership(m[4].id, orgA, 'member');
    }
  });
});

// ================================================================
// Q・R. 同じ種類で期間が重なるチャレンジの平均は 1 本だけ
// ================================================================
describe('#1688 Q・R. 同じ種類で期間が重なるチャレンジの平均は、先に確定した 1 本だけ', () => {
  it('Q [S-21]: 同じ種類・同じ期間の A・B を 1 つの UPDATE で同時に completed にすると、(finalized_at, challenge_id) が小さい方の平均だけが出る', async () => {
    const a = await createChallenge();
    const b = await createChallenge();
    await joinRanked(a, eleven());
    await joinRanked(b, eleven());
    const x = eleven()[0];
    await srAdmin.from('organization_challenge_participants').delete().eq('challenge_id', b).eq('user_id', x.id);

    await pgQuery(`UPDATE public.organization_challenges SET status = 'completed' WHERE id IN ('${a}'::uuid, '${b}'::uuid)`);

    const first = await firstFinalized([a, b]);
    const second = first === a ? b : a;
    const view = await aggregates();
    expect(view.get(first)!.average_value).not.toBeNull();
    expect(view.get(second)!.average_value).toBeNull();
    expect(view.get(a)!.participant_count).toBe(MIN + 1);
    expect(view.get(b)!.participant_count).toBe(MIN + 1);
  });

  it('R-1 [S-22]: A を completed (11 人) → X を外す → B を completed (10 人) とすると B の平均は NULL', async () => {
    const a = await createChallenge();
    const b = await createChallenge();
    await joinRanked(a, eleven());
    await joinRanked(b, eleven());
    const x = eleven()[MIN];
    try {
      expect(await adminUpdate(a, { status: 'completed' })).toBeNull();
      const removed = await asUser(jwtOf(admin)).rpc('remove_org_member', { p_organization_id: orgA, p_user_id: x.id });
      expect(removed.error).toBeNull();
      expect(await adminUpdate(b, { status: 'completed' })).toBeNull();

      expect((await controlRow(a))!.final_ranked_count).toBe(MIN + 1);
      expect((await controlRow(b))!.final_ranked_count).toBe(MIN);
      expect((await aggregateOf(a)).average_value).not.toBeNull();
      expect((await aggregateOf(b)).average_value).toBeNull();
    } finally {
      await setMembership(x.id, orgA, 'member');
    }
  });

  it('R-2: A の確定が 9 人 (平均が出ない) なら、後の B は 10 人で平均が出る', async () => {
    const a = await createChallenge();
    const b = await createChallenge();
    await joinRanked(a, m.slice(0, MIN - 1));
    await joinRanked(b, ten());
    await complete(a);
    await complete(b);

    expect((await aggregateOf(a)).average_value).toBeNull();
    expect((await aggregateOf(b)).average_value).toBe(55);
  });

  it('R-3: 種類が違えば両方出る', async () => {
    const a = await createChallenge({ type: 'breakfast_rate' });
    const b = await createChallenge({ type: 'cooking_rate' });
    await joinRanked(a, ten());
    await joinRanked(b, ten());
    await complete(a);
    await complete(b);

    expect((await aggregateOf(a)).average_value).toBe(55);
    expect((await aggregateOf(b)).average_value).toBe(55);
  });

  it('R-4: 同じ種類で期間が重ならなければ両方出る', async () => {
    const a = await createChallenge({ start: START, end: END });
    const b = await createChallenge({ start: LATER_START, end: LATER_END });
    await joinRanked(a, ten());
    await joinRanked(b, ten());
    await complete(a);
    await complete(b);

    expect((await aggregateOf(a)).average_value).toBe(55);
    expect((await aggregateOf(b)).average_value).toBe(55);
  });

  it('R-5: 終了日と開始日が同じ日 (両端を含む重なり) なら後の方は NULL', async () => {
    const a = await createChallenge({ start: START, end: END });
    const b = await createChallenge({ start: END, end: LATER_END });
    await joinRanked(a, ten());
    await joinRanked(b, ten());
    await complete(a);
    await complete(b);

    expect((await aggregateOf(a)).average_value).toBe(55);
    expect((await aggregateOf(b)).average_value).toBeNull();
  });
});

// ================================================================
// S. 削除の制限
// ================================================================
describe('#1688 S. 利用者の権限で消せるのは draft と cancelled だけ', () => {
  it('S [S-23]: 管理者の JWT の DELETE で active と completed は消えない (0 行・エラーなし)。draft と cancelled は消える。service_role と組織の削除では消える', async () => {
    for (const status of ['active', 'completed']) {
      const id = await createChallenge({ status });
      const { data, error } = await asUser(jwtOf(admin)).from('organization_challenges').delete().eq('id', id).select('id');
      expect(error, status).toBeNull();
      expect(data ?? [], status).toEqual([]);
      expect((await challengeRow(id)).status).toBe(status);
    }
    for (const status of ['draft', 'cancelled']) {
      const id = await createChallenge({ status });
      await join(id, m[0].id);
      const { data, error } = await asUser(jwtOf(admin)).from('organization_challenges').delete().eq('id', id).select('id');
      expect(error, status).toBeNull();
      expect((data ?? []).map((r) => r.id), status).toEqual([id]);
      expect(await controlRow(id), '集計の控えも CASCADE で消える').toBeNull();
    }

    const byService = await createChallenge({ status: 'completed' });
    const { data: serviceDeleted } = await srAdmin.from('organization_challenges').delete().eq('id', byService).select('id');
    expect((serviceDeleted ?? []).map((r) => r.id)).toEqual([byService]);

    // 組織の削除 (CASCADE) でも消える
    const { data: tempOrg, error: orgError } = await srAdmin
      .from('organizations')
      .insert({ name: `#1688 Org temp ${RUN}`, owner_id: orgOwnerId })
      .select('id')
      .single();
    if (orgError || !tempOrg) throw new Error(`organizations: ${orgError?.message}`);
    const inTemp = await createChallenge({ org: tempOrg.id, status: 'completed' });
    expect((await srAdmin.from('organizations').delete().eq('id', tempOrg.id)).error).toBeNull();
    const { data: gone } = await srAdmin.from('organization_challenges').select('id').eq('id', inTemp);
    expect(gone ?? []).toEqual([]);
  });
});

// ================================================================
// V. 並行の確定 (組織ごとの鍵と、確定の時刻)
// ================================================================
describe('#1688 V. 並行の確定: 確定の時刻の順はコミットの順', () => {
  it('V-1 [S-26]: 先に始まって後にコミットした確定は、すでに出ている平均を消さない', async () => {
    const a = await createChallenge();
    const b = await createChallenge();
    await joinRanked(a, eleven());
    await joinRanked(b, eleven());

    // 先にトランザクションを開き (now() はこの時刻)、B を確定させてから放して A を completed にする
    const holder = startHolder('', `UPDATE public.organization_challenges SET status = 'completed' WHERE id = '${a}'::uuid;`);
    const [held, shownB] = await holders.whileHolding(holder, async () => {
      expect(await adminUpdate(b, { status: 'completed' })).toBeNull();
      const shown = (await aggregateOf(b)).average_value;
      expect(shown).not.toBeNull();
      expect((await aggregateOf(a)).average_value).toBeNull();
      return shown;
    });

    expect(held.ok, JSON.stringify(held.body)).toBe(true);
    expect((await aggregateOf(b)).average_value).toBe(shownB);
    expect((await aggregateOf(a)).average_value).toBeNull();
    expect(await firstFinalized([a, b])).toBe(b);
  });

  it('V-2: 同じ組織の確定は鍵で 1 本ずつ進む (後の確定は advisory の鍵を待つ)', async () => {
    const a = await createChallenge();
    const b = await createChallenge();
    await joinRanked(a, eleven());
    await joinRanked(b, eleven());

    const holder = startHolder(`UPDATE public.organization_challenges SET status = 'completed' WHERE id = '${a}'::uuid;`, '');
    // 後の確定 (B) が先の確定 (A) の鍵 (advisory) を待つのを確かめてから A を放す
    const [held, errorB] = await holders.runBehindHolder(holder, {
      fn: 'organization_challenges',
      waitEvent: ADVISORY_WAIT_EVENT,
      call: () => adminUpdate(b, { status: 'completed' }),
    });
    expect(held.ok, JSON.stringify(held.body)).toBe(true);
    expect(errorB).toBeNull();
    expect(await firstFinalized([a, b])).toBe(a);
    expect((await aggregateOf(a)).average_value).not.toBeNull();
    expect((await aggregateOf(b)).average_value).toBeNull();
  });

  it('V-3: 別の組織の確定は待たない', async () => {
    const a = await createChallenge();
    const other = await createChallenge({ org: orgB });
    await joinRanked(a, eleven());

    const holder = startHolder(`UPDATE public.organization_challenges SET status = 'completed' WHERE id = '${a}'::uuid;`, '');
    // 別の組織の確定は、保持している接続を放す前に終わる (待たされるなら放されるまで返らず、先の接続は上限で終わって下の確かめが落ちる)
    const [held] = await holders.whileHolding(holder, async () => {
      const { error } = await srAdmin.from('organization_challenges').update({ status: 'completed' }).eq('id', other);
      expect(error).toBeNull();
      expect(holder.finished(), '別の組織の確定は、保持している接続が終わる前に終わる').toBe(false);
      expect((await controlRow(other))!.finalized_at).not.toBeNull();
    });

    expect(held.ok, JSON.stringify(held.body)).toBe(true);
  });
});
