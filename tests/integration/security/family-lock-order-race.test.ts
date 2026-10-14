/**
 * #1310 家族の解散・削除と、家族に入る処理 (招待の承諾など) が同時に走ると、
 *       解散済みの家族に active のメンバーが残る / デッドロックする問題の回帰テスト
 *
 * 修正前は、家族を変える RPC が行ロックを取る順番がばらばらだった。
 *   - accept_family_invite          : 招待の行 → 家族の行 (#1213 で家族の行のロックを足したが、招待の行が先のままだった)
 *   - 代表者による家族の削除 (RLS の DELETE ポリシー + CASCADE)
 *                                   : 家族の行 → 招待・メンバー・参加リクエスト・プロフィールの行 (DELETE 文が最初に家族の行を取る)
 *   - operator_force_dissolve_family: メンバー → プロフィール → 家族の行 (家族の行は最後に更新するだけ)
 *   - accept_family_representative_transfer / operator_force_representative_transfer
 *                                   : メンバー → 家族の行 (representative_id の更新が最後)
 *   - accept_child_promotion        : メンバー → 参加リクエスト → プロフィール (家族の行は外部キーの確認で最後に FOR KEY SHARE)
 *   - leave_family / remove_family_member: メンバー → プロフィール
 * その結果、次の 2 つが起きていた。
 *   1. 運営の強制解散と招待の承諾 (子供の追加も同じ) が同時に走ると、解散済みの家族に active のメンバーが残る
 *      (解散側が「承諾の INSERT がまだ見えない」状態でメンバーを left にし、あとから家族の行の更新だけが承諾の完了を待って通る)
 *   2. 代表者による家族の削除と招待の承諾が同時に走ると、お互いの行を待ち合ってデッドロックする (40P01)
 *
 * 修正後 (20261008090100_family_lock_order.sql): 家族に関わる RPC は、すべて「家族の行 → 子の行」の順でロックする。
 *   解散・移譲・脱退・削除・昇格の承諾も、最初に family_groups の行を FOR NO KEY UPDATE でロックする
 *   (外部キーの確認が取る FOR KEY SHARE とは衝突しない強さ。承諾・子供の追加 (FOR UPDATE) とは互いに待ち合う)。
 *   代表者の削除は DELETE 文が最初に家族の行を取るので、もともとこの順番で、コードは変えない。
 *
 * 競合の再現のしかた (タイミングに頼らない。family-member-limit-race.test.ts と同じ考え方):
 *   postgres-meta (/pg/query) で「本人になりすまして先に処理を呼び、そのあと pg_sleep でトランザクションを開いたままにする」
 *   接続を 1 本作り (= ロックを取ったがコミット前の状態)、pg_sleep に入ったのを pg_stat_activity で確かめてから、
 *   もう 1 件を本物の経路 (PostgREST + 本人の JWT) で呼ぶ。
 *   - 解散と承諾など「先の処理の途中に、後の処理が割り込む」競合は、先の処理を開いたままにして後の処理を呼ぶ。
 *   - 代表者の削除は、「家族の行を FOR UPDATE でロックしたまま待ち、そのあと DELETE する」接続で表す
 *     (DELETE 文は先に家族の行を取ってから CASCADE で子の行を消すので、その 2 段階の間に他の処理が割り込む状況の再現)。
 *   - 子の行を先に持つ処理 (同じメールへの再招待・昇格のリクエスト) の途中に、家族の行を先に取る処理が割り込む並び (D1〜D3) は、
 *     家族の行のロックが FOR UPDATE だとデッドロックする。FOR NO KEY UPDATE でなければならないことを、順番を固定して確かめる。
 *   これとは別に、PostgREST で本物の経路を同時に呼ぶ素直な並行テスト (それぞれ 8 回) も置く。
 *   どのテストも、先に来た方が勝つ (どちらが先でも同じ不変条件が成り立つ) ように書いてあり、順番がずれても偽の失敗にならない。
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない (RPC と PostgREST を直接呼ぶ)。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/family-lock-order-race.test.ts
 *
 * 関数定義・権限の確認と、競合の再現用の接続は、ローカルスタックの postgres-meta (/pg/query、service_role キーが必要) を使う。
 * 本番には接続しない。
 */

import { randomBytes } from 'node:crypto';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ローカルスタックの Kong → PostgREST の接続は、しばらく使っていないと PostgREST 側から切られていることがあり、
 * 使い回した最初の 1 回が 502 ("An invalid response was received from the upstream server") になる。
 * この 502 はデータベースの結果ではなく、リクエストが PostgREST に届いていないので、数回だけやり直す
 * (競合そのものの検証は、DB が返したエラーで判定する)。
 */
const GATEWAY_RETRIES = 3;
const fetchRetryingGateway502: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 502 || attempt >= GATEWAY_RETRIES) return res;
    await sleep(150 * (attempt + 1));
  }
};

function client(key: string, accessToken?: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: {
      fetch: fetchRetryingGateway502,
      ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    },
  });
}

const srAdmin = client(serviceKey);
const anon = () => client(anonKey);
const asUser = (jwt: string) => client(anonKey, jwt);

/**
 * ローカルスタックの postgres-meta で SQL を実行する。複数の文は 1 つのトランザクションで実行され、最後の文の行が返る。
 * 502 が 1.5 秒以内に返ったときだけやり直す (上と同じ理由。pg_sleep で待たせた後の応答ではない)
 */
async function pgRequest(query: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    const res = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    if (res.status === 502 && attempt < GATEWAY_RETRIES && Date.now() - startedAt < 1500) {
      await sleep(150 * (attempt + 1));
      continue;
    }
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  }
}

/** カタログの確認や競合の観測に使う (読み取りだけ) */
async function pgQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await pgRequest(query);
  if (!res.ok) throw new Error(`pg/query ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as T[];
}

interface TestUser {
  id: string;
  email: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];
const createdFamilyIds: string[] = [];
const pendingHolders: Array<Promise<unknown>> = [];
const TOKEN_RE = /^[a-f0-9]{64}$/;

async function createUser(label: string, roles?: string[]): Promise<TestUser> {
  const email = `sec-lockorder-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert(
      { id: data.user.id, nickname: `lock-${label}`, age_group: '30s', gender: 'other', ...(roles ? { roles } : {}) },
      { onConflict: 'id' },
    );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await anon().auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, email, jwt: signIn.data.session.access_token };
}

async function createUsers(prefix: string, count: number): Promise<TestUser[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => createUser(`${prefix}-${i + 1}`)));
}

/** 運営 (super_admin)。operator_force_* RPC はこのロールの人だけが実行できる */
let operator: TestUser;

/** 代表者 rep の家族を作る。人数の上限は memberLimit にする (service_role は上限の列を直接変えられる) */
async function createFamily(rep: TestUser, label: string, memberLimit = 8): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_group', {
    p_name: `#1310 ${label} ${TS}`,
    p_plan_key: 'free',
  });
  if (error || !data) throw new Error(`create_family_group ${label}: ${error?.message}`);
  const familyId = (data as { id: string }).id;
  createdFamilyIds.push(familyId);
  const { error: limitError } = await srAdmin.from('family_groups').update({ member_limit: memberLimit }).eq('id', familyId);
  if (limitError) throw new Error(`member_limit: ${limitError.message}`);
  return familyId;
}

async function inviteToken(rep: TestUser, familyId: string, email: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: email });
  if (error || !data) throw new Error(`create_family_invite: ${error?.message}`);
  const token = (data as { token: string }).token;
  expect(token).toMatch(TOKEN_RE);
  return token;
}

interface Fixture {
  rep: TestUser;
  /** 招待を承諾して入った大人 (代表者を除く) */
  adults: TestUser[];
  familyId: string;
}

/** 代表者 + adultCount 人の大人 (招待 → 承諾で入る) の家族を作る */
async function buildFamily(label: string, adultCount: number, memberLimit = 8): Promise<Fixture> {
  const [rep, ...adults] = await createUsers(label, 1 + adultCount);
  const familyId = await createFamily(rep, label, memberLimit);
  for (const adult of adults) {
    const token = await inviteToken(rep, familyId, adult.email);
    const { error } = await asUser(adult.jwt).rpc('accept_family_invite', { p_token: token });
    if (error) throw new Error(`join ${label}: ${error.message}`);
  }
  return { rep, adults, familyId };
}

/** 子供の枠を 1 つ足し、そのメンバーの id を返す */
async function addChild(rep: TestUser, familyId: string, name: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('add_family_child', {
    p_family_id: familyId,
    p_display_name: name,
    p_child_profile: { age: 8 },
  });
  if (error || !data) throw new Error(`add_family_child: ${error?.message}`);
  return (data as { id: string }).id;
}

/** 子供の枠を大人に昇格させるリクエストを作り、そのトークンを返す */
async function requestPromotion(rep: TestUser, memberId: string, email: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('request_child_promotion', { p_member_id: memberId, p_email: email });
  if (error || !data) throw new Error(`request_child_promotion: ${error?.message}`);
  return (data as { token: string }).token;
}

async function proposeTransfer(rep: TestUser, familyId: string, toUserId: string): Promise<string> {
  const { data, error } = await asUser(rep.jwt).rpc('propose_family_representative_transfer', {
    p_family_id: familyId,
    p_to_user_id: toUserId,
  });
  if (error || !data) throw new Error(`propose_family_representative_transfer: ${error?.message}`);
  return data as string;
}

interface MemberRow {
  id: string;
  user_id: string | null;
  role: string;
  status: string;
  display_name: string | null;
  removed_at: string | null;
}

async function members(familyId: string): Promise<MemberRow[]> {
  const { data, error } = await srAdmin
    .from('family_members')
    .select('id, user_id, role, status, display_name, removed_at')
    .eq('family_id', familyId)
    .order('joined_at', { ascending: true });
  if (error) throw new Error(`family_members: ${error.message}`);
  return (data ?? []) as MemberRow[];
}

async function activeMembers(familyId: string): Promise<MemberRow[]> {
  return (await members(familyId)).filter((m) => m.status === 'active');
}

async function memberOf(familyId: string, userId: string): Promise<MemberRow> {
  const row = (await members(familyId)).find((m) => m.user_id === userId);
  if (!row) throw new Error(`member not found: ${userId}`);
  return row;
}

async function familyRow(familyId: string): Promise<{ status: string; representative_id: string; dissolved_at: string | null } | null> {
  const { data, error } = await srAdmin
    .from('family_groups')
    .select('status, representative_id, dissolved_at')
    .eq('id', familyId)
    .maybeSingle();
  if (error) throw new Error(`family_groups: ${error.message}`);
  return data as { status: string; representative_id: string; dissolved_at: string | null } | null;
}

async function inviteStatus(token: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('family_invites').select('status').eq('token', token).maybeSingle();
  if (error) throw new Error(`family_invites: ${error.message}`);
  return data ? (data as { status: string }).status : null;
}

async function proposalStatus(proposalId: string): Promise<string> {
  const { data, error } = await srAdmin.from('ownership_transfer_proposals').select('status').eq('id', proposalId).single();
  if (error) throw new Error(`ownership_transfer_proposals: ${error.message}`);
  return (data as { status: string }).status;
}

async function profileFamilyId(userId: string): Promise<string | null> {
  const { data, error } = await srAdmin.from('user_profiles').select('family_id').eq('id', userId).maybeSingle();
  if (error) throw new Error(`user_profiles: ${error.message}`);
  return data ? ((data as { family_id: string | null }).family_id ?? null) : null;
}

async function auditCount(familyId: string, action: string): Promise<number> {
  const { count, error } = await srAdmin
    .from('membership_audit')
    .select('id', { count: 'exact', head: true })
    .eq('scope', 'family')
    .eq('scope_id', familyId)
    .eq('action', action);
  if (error) throw new Error(`membership_audit: ${error.message}`);
  return count ?? 0;
}

// ---------------------------------------------------------------------------------------------
// 呼び出し (本物の経路: PostgREST + 本人の JWT)
// ---------------------------------------------------------------------------------------------

/** RPC / DELETE を 1 回呼んだ結果。ok は成功、message はエラーメッセージ、code は SQLSTATE など */
interface Outcome {
  ok: boolean;
  message: string | null;
  code: string | null;
}

function toOutcome(error: { message?: string; code?: string } | null): Outcome {
  return { ok: !error, message: error?.message ?? null, code: error?.code ?? null };
}

/** デッドロック (40P01)、または RPC 内でデッドロックを置き換えた CONFLICT_RETRY */
function isDeadlock(outcome: Outcome): boolean {
  return outcome.code === '40P01' || /deadlock detected|CONFLICT_RETRY/i.test(outcome.message ?? '');
}

function expectNoDeadlock(...outcomes: Array<Outcome | undefined>) {
  for (const outcome of outcomes) {
    if (outcome) expect(isDeadlock(outcome), `デッドロックしました: ${JSON.stringify(outcome)}`).toBe(false);
  }
}

async function acceptViaApi(user: TestUser, token: string): Promise<Outcome> {
  const { error } = await asUser(user.jwt).rpc('accept_family_invite', { p_token: token });
  return toOutcome(error);
}

async function addChildViaApi(rep: TestUser, familyId: string, name: string): Promise<Outcome> {
  const { error } = await asUser(rep.jwt).rpc('add_family_child', {
    p_family_id: familyId,
    p_display_name: name,
    p_child_profile: { note: '#1310' },
  });
  return toOutcome(error);
}

async function dissolveViaApi(familyId: string): Promise<Outcome> {
  const { error } = await asUser(operator.jwt).rpc('operator_force_dissolve_family', {
    p_family_id: familyId,
    p_reason: '#1310 test',
  });
  return toOutcome(error);
}

async function forceTransferViaApi(familyId: string, newRepId: string): Promise<Outcome> {
  const { error } = await asUser(operator.jwt).rpc('operator_force_representative_transfer', {
    p_family_id: familyId,
    p_new_rep_id: newRepId,
    p_reason: '#1310 test',
  });
  return toOutcome(error);
}

async function transferAcceptViaApi(user: TestUser, proposalId: string): Promise<Outcome> {
  const { error } = await asUser(user.jwt).rpc('accept_family_representative_transfer', { p_proposal_id: proposalId });
  return toOutcome(error);
}

async function leaveViaApi(user: TestUser): Promise<Outcome> {
  const { error } = await asUser(user.jwt).rpc('leave_family');
  return toOutcome(error);
}

async function removeViaApi(rep: TestUser, familyId: string, memberId: string): Promise<Outcome> {
  const { error } = await asUser(rep.jwt).rpc('remove_family_member', { p_family_id: familyId, p_member_id: memberId });
  return toOutcome(error);
}

/** 代表者が家族を削除する (RLS の family_groups_delete_representative。メンバー・招待などは CASCADE で消える) */
async function deleteFamilyViaApi(rep: TestUser, familyId: string): Promise<Outcome & { deleted: number }> {
  const { data, error } = await asUser(rep.jwt).from('family_groups').delete().eq('id', familyId).select('id');
  return { ...toOutcome(error), deleted: data?.length ?? 0 };
}

async function acceptPromotionViaApi(user: TestUser, token: string): Promise<Outcome> {
  const { error } = await asUser(user.jwt).rpc('accept_child_promotion', { p_token: token });
  return toOutcome(error);
}

// ---------------------------------------------------------------------------------------------
// 先の処理をコミット前のまま開いておく接続 (postgres-meta)
// ---------------------------------------------------------------------------------------------

interface Holder {
  /** 先の処理が済み、pg_sleep に入った (= ロックを持ったままコミット前の) 状態になると解決する */
  sleeping: Promise<void>;
  /** トランザクションが終わった (コミットされた / 失敗した) ときに解決する */
  done: Promise<Outcome>;
}

/**
 * 別の接続で、actor になりすまして before を実行し、holdSeconds 秒 pg_sleep してから after を実行して、コミットする。
 * before / after は末尾に ; を付けた SQL (空でもよい)。
 * actorId が null のときは、なりすまさず postgres のまま実行する (RLS を通さずに、関数の中と同じ行ロックの取り方を再現するとき)。
 */
function startHolder(actorId: string | null, before: string, after: string, holdSeconds: number): Holder {
  const marker = `lockorder-holder-${randomBytes(6).toString('hex')}`;
  const claims = JSON.stringify({ sub: actorId, role: 'authenticated' });
  const impersonate =
    actorId === null
      ? ''
      : `SELECT set_config('request.jwt.claims', '${claims}', true);
    SET LOCAL ROLE authenticated;`;
  const sql = `/* ${marker} */
    ${impersonate}
    ${before}
    SELECT pg_sleep(${holdSeconds});
    ${after}
    SELECT 'held' AS result;`;

  const state: { outcome: Outcome | null } = { outcome: null };
  const done = pgRequest(sql).then((res): Outcome => {
    const body = res.body as { error?: unknown; code?: unknown } | null;
    const outcome: Outcome = res.ok
      ? { ok: true, message: null, code: null }
      : {
          ok: false,
          message: typeof body?.error === 'string' ? body.error : JSON.stringify(body),
          code: typeof body?.code === 'string' ? body.code : null,
        };
    state.outcome = outcome;
    return outcome;
  });
  pendingHolders.push(done);

  const sleeping = (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (state.outcome) {
        // pg_sleep に入る前に終わった = 先の処理が失敗している (競合の再現にならないので、理由を示して止める)
        throw new Error(`先に呼んだ接続が pg_sleep に入る前に終わりました: ${JSON.stringify(state.outcome)}`);
      }
      const rows = await pgQuery<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      if (rows[0]?.n === 1) return;
      await sleep(50);
    }
    throw new Error('先に呼んだ接続が pg_sleep に入りませんでした (遅すぎます)');
  })();

  return { sleeping, done };
}

/** actor として RPC (SQL の式) を 1 回呼び、そのあと holdSeconds 秒トランザクションを開いたままにする */
function holdCall(actor: TestUser, callSql: string, holdSeconds = 3): Holder {
  return startHolder(actor.id, `SELECT * FROM ${callSql};`, '', holdSeconds);
}

/**
 * 代表者 rep として家族の行を FOR UPDATE でロックしたまま待ち、そのあと家族を DELETE する (RLS の DELETE ポリシー経由)。
 * DELETE 文は最初に家族の行を取り、そのあと CASCADE で子の行 (招待・メンバーなど) を消す。その 2 段階の間に
 * 他の処理が割り込んだ状況 (= 割り込んだ処理が、先に子の行を持ってから家族の行を待つ向きだとデッドロックする) を再現する。
 */
function holdFamilyLockThenDelete(rep: TestUser, familyId: string, holdSeconds = 3): Holder {
  return startHolder(
    rep.id,
    `SELECT 1 FROM public.family_groups WHERE id = '${familyId}'::uuid FOR UPDATE;`,
    `DELETE FROM public.family_groups WHERE id = '${familyId}'::uuid;`,
    holdSeconds,
  );
}

const acceptSql = (token: string) => `public.accept_family_invite('${token}')`;
const dissolveSql = (familyId: string) => `public.operator_force_dissolve_family('${familyId}'::uuid, '#1310 hold')`;
const addChildSql = (familyId: string, name: string) =>
  `public.add_family_child('${familyId}'::uuid, '${name}', '{"note":"#1310"}'::jsonb)`;
const transferAcceptSql = (proposalId: string) => `public.accept_family_representative_transfer('${proposalId}'::uuid)`;

/** 後片付けは 10 件ずつ並列に行う (作る行が多いので、1 件ずつだと長くかかる) */
async function inBatches<T>(items: T[], run: (item: T) => Promise<unknown>, size = 10): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.allSettled(items.slice(i, i + size).map(run));
  }
}

afterAll(async () => {
  await Promise.allSettled(pendingHolders);
  await inBatches(createdFamilyIds, async (id) => {
    await srAdmin.from('membership_audit').delete().eq('scope_id', id);
    // family_members / family_invites / family_promotion_requests は CASCADE。削除済みの家族は何も起きない
    await srAdmin.from('family_groups').delete().eq('id', id);
  });
  await inBatches(createdUserIds, async (id) => {
    await srAdmin.auth.admin.deleteUser(id); // user_profiles は CASCADE
  });
}, 180_000);

beforeAll(async () => {
  operator = await createUser('operator', ['super_admin']);
}, 60_000);

/** 解散後の不変条件: 家族は dissolved で、active のメンバーが 1 人も残らず、全員のプロフィールの family_id も外れている */
async function expectDissolvedWithNoActiveMembers(familyId: string, userIds: string[]) {
  expect((await familyRow(familyId))?.status).toBe('dissolved');
  expect(await activeMembers(familyId)).toEqual([]);
  for (const userId of userIds) expect(await profileFamilyId(userId)).toBeNull();
}

// ---------------------------------------------------------------------------------------------
// 1. 運営の強制解散と、家族に入る処理 (承諾・子供の追加) の競合 — 解散済みの家族に active が残る
// ---------------------------------------------------------------------------------------------

describe('#1310 運営の強制解散と、家族に入る処理が同時に走る (先の処理はコミット前)', () => {
  it('A1: 招待の承諾がコミット前のところへ強制解散が来ても、承諾した人は解散済みの家族に active で残らない', async () => {
    const { rep, familyId } = await buildFamily('a1', 0);
    const invitee = await createUser('a1-invitee');
    const token = await inviteToken(rep, familyId, invitee.email);

    const holder = holdCall(invitee, acceptSql(token));
    await holder.sleeping;
    const dissolve = await dissolveViaApi(familyId);
    const held = await holder.done;

    expect(held.ok).toBe(true); // 承諾は先にロックを取っていたので成功する
    expect(dissolve.message).toBeNull();
    expectNoDeadlock(held, dissolve);
    // 承諾の後に解散が来た扱いになり、承諾した人も left になる (修正前は active のまま残る)
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id, invitee.id]);
    expect((await memberOf(familyId, invitee.id)).status).toBe('left');
  });

  it('A2: 子供の追加がコミット前のところへ強制解散が来ても、追加された子供は解散済みの家族に active で残らない', async () => {
    const { rep, familyId } = await buildFamily('a2', 0);

    const holder = holdCall(rep, addChildSql(familyId, 'a2-child'));
    await holder.sleeping;
    const dissolve = await dissolveViaApi(familyId);
    const held = await holder.done;

    expect(held.ok).toBe(true);
    expect(dissolve.message).toBeNull();
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id]);
    expect((await members(familyId)).filter((m) => m.role === 'child').map((m) => m.status)).toEqual(['left']);
  });

  it('A3: 強制解散がコミット前のところへ招待の承諾が来ると、承諾は FAMILY_NOT_FOUND で何も残さない', async () => {
    const { rep, familyId } = await buildFamily('a3', 0);
    const invitee = await createUser('a3-invitee');
    const token = await inviteToken(rep, familyId, invitee.email);

    const holder = holdCall(operator, dissolveSql(familyId));
    await holder.sleeping;
    const accept = await acceptViaApi(invitee, token);
    expect((await holder.done).ok).toBe(true);

    expect(accept.ok).toBe(false);
    expect(accept.message).toBe('FAMILY_NOT_FOUND');
    expect(await inviteStatus(token)).toBe('pending');
    expect(await profileFamilyId(invitee.id)).toBeNull();
    expect(await auditCount(familyId, 'invite_accepted')).toBe(0);
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id, invitee.id]);
  });

  it('A4: 強制解散がコミット前のところへ子供の追加が来ると、FAMILY_NOT_FOUND か NOT_FAMILY_ADULT で何も残さない', async () => {
    const { rep, familyId } = await buildFamily('a4', 0);

    const holder = holdCall(operator, dissolveSql(familyId));
    await holder.sleeping;
    const child = await addChildViaApi(rep, familyId, 'a4-child');
    expect((await holder.done).ok).toBe(true);

    expect(child.ok).toBe(false);
    expect(child.message).toMatch(/FAMILY_NOT_FOUND|NOT_FAMILY_ADULT/);
    expect(await auditCount(familyId, 'child_added')).toBe(0);
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id]);
  });
});

describe('#1310 運営の強制解散と、家族に入る処理を本物の経路で同時に呼ぶ (8 回ずつ)', () => {
  const ITERATIONS = 8;

  it('N1: 招待の承諾と強制解散を同時に呼んでも、解散済みの家族に active が残らず、デッドロックしない', async () => {
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [rep, invitee] = await createUsers(`n1-${i}`, 2);
      const familyId = await createFamily(rep, `n1-${i}`);
      const token = await inviteToken(rep, familyId, invitee.email);

      const [accept, dissolve] = await Promise.all([acceptViaApi(invitee, token), dissolveViaApi(familyId)]);

      if (isDeadlock(accept) || isDeadlock(dissolve)) problems.push(`#${i} デッドロック: ${JSON.stringify({ accept, dissolve })}`);
      if (!dissolve.ok) problems.push(`#${i} 解散が失敗: ${JSON.stringify(dissolve)}`);
      if (!accept.ok && !/FAMILY_NOT_FOUND/.test(accept.message ?? '')) problems.push(`#${i} 承諾が想定外の失敗: ${JSON.stringify(accept)}`);
      const active = await activeMembers(familyId);
      if (active.length > 0) problems.push(`#${i} 解散済みの家族に active が残った (accept: ${accept.ok ? '成功' : accept.message}): ${active.length} 人`);
      if ((await profileFamilyId(invitee.id)) !== null) problems.push(`#${i} 承諾した人のプロフィールに family_id が残った`);
    }
    expect(problems).toEqual([]);
  }, 180_000);

  it('N2: 子供の追加と強制解散を同時に呼んでも、解散済みの家族に active が残らず、デッドロックしない', async () => {
    const problems: string[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const [rep] = await createUsers(`n2-${i}`, 1);
      const familyId = await createFamily(rep, `n2-${i}`);

      const [child, dissolve] = await Promise.all([addChildViaApi(rep, familyId, `n2-child-${i}`), dissolveViaApi(familyId)]);

      if (isDeadlock(child) || isDeadlock(dissolve)) problems.push(`#${i} デッドロック: ${JSON.stringify({ child, dissolve })}`);
      if (!dissolve.ok) problems.push(`#${i} 解散が失敗: ${JSON.stringify(dissolve)}`);
      const active = await activeMembers(familyId);
      if (active.length > 0) problems.push(`#${i} 解散済みの家族に active が残った (child: ${child.ok ? '成功' : child.message}): ${active.length} 人`);
    }
    expect(problems).toEqual([]);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
// 2. 代表者による家族の削除 (DELETE + CASCADE) と、各 RPC の競合 — デッドロック
// ---------------------------------------------------------------------------------------------

describe('#1310 代表者による家族の削除 (家族の行を先に取る) の途中に、各 RPC が割り込む', () => {
  it('B1: 招待の承諾が割り込んでもデッドロックしない (承諾は INVITE_NOT_FOUND / FAMILY_NOT_FOUND になり、削除は成功する)', async () => {
    const { rep, familyId } = await buildFamily('b1', 0);
    const invitee = await createUser('b1-invitee');
    const token = await inviteToken(rep, familyId, invitee.email);

    const holder = holdFamilyLockThenDelete(rep, familyId);
    await holder.sleeping;
    const accept = await acceptViaApi(invitee, token);
    const deletion = await holder.done;

    expectNoDeadlock(accept, deletion);
    expect(deletion.ok).toBe(true);
    expect(accept.ok).toBe(false);
    expect(accept.message).toMatch(/INVITE_NOT_FOUND|FAMILY_NOT_FOUND/);
    expect(await familyRow(familyId)).toBeNull();
    expect(await members(familyId)).toEqual([]);
    expect(await profileFamilyId(invitee.id)).toBeNull();
  });

  it('B2: 運営の強制解散が割り込んでもデッドロックしない', async () => {
    const { rep, familyId } = await buildFamily('b2', 1);

    const holder = holdFamilyLockThenDelete(rep, familyId);
    await holder.sleeping;
    const dissolve = await dissolveViaApi(familyId);
    const deletion = await holder.done;

    expectNoDeadlock(dissolve, deletion);
    expect(deletion.ok).toBe(true);
    expect(await familyRow(familyId)).toBeNull();
  });

  it('B3: 代表者の移譲の承諾が割り込んでもデッドロックしない (承諾は TRANSFER_ACCEPTOR_NOT_IN_FAMILY になる)', async () => {
    const { rep, adults, familyId } = await buildFamily('b3', 1);
    const [adult] = adults;
    const proposalId = await proposeTransfer(rep, familyId, adult.id);

    const holder = holdFamilyLockThenDelete(rep, familyId);
    await holder.sleeping;
    const accept = await transferAcceptViaApi(adult, proposalId);
    const deletion = await holder.done;

    expectNoDeadlock(accept, deletion);
    expect(deletion.ok).toBe(true);
    expect(accept.message).toContain('TRANSFER_ACCEPTOR_NOT_IN_FAMILY');
    expect(await familyRow(familyId)).toBeNull();
  });

  it('B4: 運営の強制譲渡が割り込んでもデッドロックしない (譲渡は TARGET_NOT_IN_FAMILY になる)', async () => {
    const { rep, adults, familyId } = await buildFamily('b4', 1);
    const [adult] = adults;

    const holder = holdFamilyLockThenDelete(rep, familyId);
    await holder.sleeping;
    const transfer = await forceTransferViaApi(familyId, adult.id);
    const deletion = await holder.done;

    expectNoDeadlock(transfer, deletion);
    expect(deletion.ok).toBe(true);
    expect(transfer.message).toContain('TARGET_NOT_IN_FAMILY');
    expect(await familyRow(familyId)).toBeNull();
  });

  it('B5: 子供の昇格の承諾が割り込んでもデッドロックしない (承諾は PROMOTION_MEMBER_UNAVAILABLE などになる)', async () => {
    const { rep, familyId } = await buildFamily('b5', 0);
    const target = await createUser('b5-target');
    const childId = await addChild(rep, familyId, 'b5-child');
    const promotionToken = await requestPromotion(rep, childId, target.email);

    const holder = holdFamilyLockThenDelete(rep, familyId);
    await holder.sleeping;
    const accept = await acceptPromotionViaApi(target, promotionToken);
    const deletion = await holder.done;

    expectNoDeadlock(accept, deletion);
    expect(deletion.ok).toBe(true);
    expect(accept.ok).toBe(false);
    expect(accept.message).toMatch(/PROMOTION_MEMBER_UNAVAILABLE|PROMOTION_REQUEST_NOT_FOUND/);
    expect(await familyRow(familyId)).toBeNull();
    expect(await profileFamilyId(target.id)).toBeNull();
  });

  it('B6: 脱退が割り込んでもデッドロックしない (脱退は NOT_IN_FAMILY になる)', async () => {
    const { rep, adults, familyId } = await buildFamily('b6', 1);
    const [adult] = adults;

    const holder = holdFamilyLockThenDelete(rep, familyId);
    await holder.sleeping;
    const leave = await leaveViaApi(adult);
    const deletion = await holder.done;

    expectNoDeadlock(leave, deletion);
    expect(deletion.ok).toBe(true);
    expect(leave.ok).toBe(false);
    expect(leave.message).toContain('NOT_IN_FAMILY');
    expect(await familyRow(familyId)).toBeNull();
    expect(await auditCount(familyId, 'member_left')).toBe(0);
  });

  it('B7: メンバーの削除が割り込んでもデッドロックしない (除名は NOT_FAMILY_ADULT になる)', async () => {
    const { rep, adults, familyId } = await buildFamily('b7', 1);
    const target = await memberOf(familyId, adults[0].id);

    const holder = holdFamilyLockThenDelete(rep, familyId);
    await holder.sleeping;
    const removal = await removeViaApi(rep, familyId, target.id);
    const deletion = await holder.done;

    expectNoDeadlock(removal, deletion);
    expect(deletion.ok).toBe(true);
    expect(removal.ok).toBe(false);
    expect(removal.message).toContain('NOT_FAMILY_ADULT');
    expect(await familyRow(familyId)).toBeNull();
    expect(await auditCount(familyId, 'member_removed')).toBe(0);
  });
});

describe('#1310 代表者による家族の削除と招待の承諾を本物の経路で同時に呼ぶ (8 回)', () => {
  it('N3: 削除と承諾を同時に呼んでも、デッドロックせず、削除が成功して何も残らない', async () => {
    const problems: string[] = [];
    for (let i = 0; i < 8; i++) {
      const [rep, invitee] = await createUsers(`n3-${i}`, 2);
      const familyId = await createFamily(rep, `n3-${i}`);
      const token = await inviteToken(rep, familyId, invitee.email);

      const [accept, deletion] = await Promise.all([acceptViaApi(invitee, token), deleteFamilyViaApi(rep, familyId)]);

      if (isDeadlock(accept) || isDeadlock(deletion)) problems.push(`#${i} デッドロック: ${JSON.stringify({ accept, deletion })}`);
      if (!deletion.ok || deletion.deleted !== 1) problems.push(`#${i} 削除が成功しなかった: ${JSON.stringify(deletion)}`);
      if (!accept.ok && !/INVITE_NOT_FOUND|FAMILY_NOT_FOUND/.test(accept.message ?? '')) {
        problems.push(`#${i} 承諾が想定外の失敗: ${JSON.stringify(accept)}`);
      }
      if ((await familyRow(familyId)) !== null) problems.push(`#${i} 家族が残った`);
      if ((await members(familyId)).length > 0) problems.push(`#${i} メンバーが残った`);
      if ((await profileFamilyId(invitee.id)) !== null) problems.push(`#${i} プロフィールに family_id が残った`);
    }
    expect(problems).toEqual([]);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------
// 3. 運営の強制解散の途中に、移譲・脱退・削除が割り込む — 解散済みの家族を書き換えない
// ---------------------------------------------------------------------------------------------

describe('#1310 運営の強制解散 (コミット前) に、移譲・脱退・削除が割り込む', () => {
  it('C1: 代表者の移譲の承諾は TRANSFER_ACCEPTOR_NOT_IN_FAMILY になり、解散済みの家族の representative_id を書き換えない', async () => {
    const { rep, adults, familyId } = await buildFamily('c1', 1);
    const [adult] = adults;
    const proposalId = await proposeTransfer(rep, familyId, adult.id);

    const holder = holdCall(operator, dissolveSql(familyId));
    await holder.sleeping;
    const accept = await transferAcceptViaApi(adult, proposalId);
    expect((await holder.done).ok).toBe(true);

    expect(accept.ok).toBe(false);
    expect(accept.message).toContain('TRANSFER_ACCEPTOR_NOT_IN_FAMILY');
    // 修正前は承諾が成功し、解散済みの家族の representative_id が書き換わって、提案も accepted になる
    expect((await familyRow(familyId))?.representative_id).toBe(rep.id);
    expect(await proposalStatus(proposalId)).toBe('pending');
    expect(await auditCount(familyId, 'representative_transferred')).toBe(0);
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id, adult.id]);
  });

  it('C2: 運営の強制譲渡は TARGET_NOT_IN_FAMILY になり、解散済みの家族の representative_id を書き換えない', async () => {
    const { rep, adults, familyId } = await buildFamily('c2', 1);
    const [adult] = adults;

    const holder = holdCall(operator, dissolveSql(familyId));
    await holder.sleeping;
    const transfer = await forceTransferViaApi(familyId, adult.id);
    expect((await holder.done).ok).toBe(true);

    expect(transfer.ok).toBe(false);
    expect(transfer.message).toContain('TARGET_NOT_IN_FAMILY');
    expect((await familyRow(familyId))?.representative_id).toBe(rep.id);
    expect(await auditCount(familyId, 'operator_force_representative_transfer')).toBe(0);
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id, adult.id]);
  });

  it('C3: 脱退は NOT_IN_FAMILY になり、解散済みの家族に member_left の記録を足さない', async () => {
    const { rep, adults, familyId } = await buildFamily('c3', 1);
    const [adult] = adults;

    const holder = holdCall(operator, dissolveSql(familyId));
    await holder.sleeping;
    const leave = await leaveViaApi(adult);
    expect((await holder.done).ok).toBe(true);

    expect(leave.ok).toBe(false);
    expect(leave.message).toContain('NOT_IN_FAMILY');
    expect(await auditCount(familyId, 'member_left')).toBe(0);
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id, adult.id]);
  });

  it('C4: メンバーの削除は NOT_FAMILY_ADULT になり、解散で left にした人を removed に書き換えない', async () => {
    const { rep, adults, familyId } = await buildFamily('c4', 1);
    const [adult] = adults;
    const target = await memberOf(familyId, adult.id);

    const holder = holdCall(operator, dissolveSql(familyId));
    await holder.sleeping;
    const removal = await removeViaApi(rep, familyId, target.id);
    expect((await holder.done).ok).toBe(true);

    expect(removal.ok).toBe(false);
    expect(removal.message).toContain('NOT_FAMILY_ADULT');
    expect((await memberOf(familyId, adult.id)).status).toBe('left');
    expect(await auditCount(familyId, 'member_removed')).toBe(0);
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id, adult.id]);
  });

  it('C5: 運営の強制解散がコミット前のところへ、もう一度強制解散が来ても、デッドロックせず解散済みのまま', async () => {
    const { rep, adults, familyId } = await buildFamily('c5', 1);
    const [adult] = adults;

    const holder = holdCall(operator, dissolveSql(familyId));
    await holder.sleeping;
    const second = await dissolveViaApi(familyId);
    const first = await holder.done;

    expectNoDeadlock(first, second);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id, adult.id]);
  });
});

describe('#1310 代表者の移譲の承諾 (コミット前) に、強制解散が割り込む', () => {
  it('C6: 解散は移譲の完了を待ってから全員を left にする。デッドロックせず、active が残らない', async () => {
    const { rep, adults, familyId } = await buildFamily('c6', 1);
    const [adult] = adults;
    const proposalId = await proposeTransfer(rep, familyId, adult.id);

    const holder = holdCall(adult, transferAcceptSql(proposalId));
    await holder.sleeping;
    const dissolve = await dissolveViaApi(familyId);
    const transfer = await holder.done;

    expectNoDeadlock(dissolve, transfer);
    expect(transfer.ok).toBe(true);
    expect(dissolve.ok).toBe(true);
    expect(await proposalStatus(proposalId)).toBe('accepted');
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id, adult.id]);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. 複数の処理を同時に呼ぶ (混成。8 回)
// ---------------------------------------------------------------------------------------------

describe('#1310 承諾・移譲・脱退・子供の追加・強制解散を同時に呼ぶ (8 回)', () => {
  it('N4: デッドロックせず、全部終わったあと解散済みの家族に active が 1 人も残らない', async () => {
    const problems: string[] = [];
    for (let i = 0; i < 8; i++) {
      const { rep, adults, familyId } = await buildFamily(`n4-${i}`, 2);
      const [heir, leaver] = adults;
      const invitee = await createUser(`n4-${i}-invitee`);
      const token = await inviteToken(rep, familyId, invitee.email);
      const proposalId = await proposeTransfer(rep, familyId, heir.id);

      const outcomes = await Promise.all([
        acceptViaApi(invitee, token),
        transferAcceptViaApi(heir, proposalId),
        leaveViaApi(leaver),
        addChildViaApi(rep, familyId, `n4-child-${i}`),
        dissolveViaApi(familyId),
      ]);

      const labels = ['accept', 'transfer', 'leave', 'child', 'dissolve'];
      outcomes.forEach((outcome, index) => {
        if (isDeadlock(outcome)) problems.push(`#${i} ${labels[index]} がデッドロック: ${JSON.stringify(outcome)}`);
      });
      if (!outcomes[4].ok) problems.push(`#${i} 解散が失敗: ${JSON.stringify(outcomes[4])}`);
      if ((await familyRow(familyId))?.status !== 'dissolved') problems.push(`#${i} 家族が dissolved になっていない`);
      const active = await activeMembers(familyId);
      if (active.length > 0) problems.push(`#${i} 解散済みの家族に active が残った: ${active.map((m) => m.role).join(',')}`);
    }
    expect(problems).toEqual([]);
  }, 240_000);
});

describe('#1310 家族の行のロックは外部キーの確認と衝突しない強さ (FOR NO KEY UPDATE): 子の行を先に持つ関数と同時に呼んでもデッドロックしない (8 回ずつ)', () => {
  it('N5: 同じメールへの再招待 (既存の招待を revoke → 新しい招待を INSERT) と、古い招待の承諾を同時に呼んでも、デッドロックしない', async () => {
    const problems: string[] = [];
    for (let i = 0; i < 8; i++) {
      const [rep, invitee] = await createUsers(`n5-${i}`, 2);
      const familyId = await createFamily(rep, `n5-${i}`);
      const token = await inviteToken(rep, familyId, invitee.email);

      const reinvite = async (): Promise<Outcome> => {
        const { error } = await asUser(rep.jwt).rpc('create_family_invite', { p_family_id: familyId, p_email: invitee.email });
        return toOutcome(error);
      };
      const [accept, again] = await Promise.all([acceptViaApi(invitee, token), reinvite()]);

      if (isDeadlock(accept) || isDeadlock(again)) problems.push(`#${i} デッドロック: ${JSON.stringify({ accept, again })}`);
      if (!again.ok) problems.push(`#${i} 再招待が失敗: ${JSON.stringify(again)}`);
      // 承諾が先なら成功。再招待が先なら、古い招待は revoke 済みなので INVITE_ALREADY_USED
      if (!accept.ok && !/INVITE_ALREADY_USED/.test(accept.message ?? '')) problems.push(`#${i} 承諾が想定外の失敗: ${JSON.stringify(accept)}`);
    }
    expect(problems).toEqual([]);
  }, 180_000);

  it('N6: 子供の昇格のリクエスト (メンバーの行 → 参加リクエストの INSERT) と強制解散を同時に呼んでも、デッドロックしない', async () => {
    const problems: string[] = [];
    for (let i = 0; i < 8; i++) {
      const [rep, target] = await createUsers(`n6-${i}`, 2);
      const familyId = await createFamily(rep, `n6-${i}`);
      const childId = await addChild(rep, familyId, `n6-child-${i}`);

      const requestViaApi = async (): Promise<Outcome> => {
        const { error } = await asUser(rep.jwt).rpc('request_child_promotion', { p_member_id: childId, p_email: target.email });
        return toOutcome(error);
      };
      const [request, dissolve] = await Promise.all([requestViaApi(), dissolveViaApi(familyId)]);

      if (isDeadlock(request) || isDeadlock(dissolve)) problems.push(`#${i} デッドロック: ${JSON.stringify({ request, dissolve })}`);
      if (!dissolve.ok) problems.push(`#${i} 解散が失敗: ${JSON.stringify(dissolve)}`);
      // 昇格のリクエストが先なら成功。解散が先なら、呼び出し者はもう家族の大人ではない
      if (!request.ok && !/NOT_FAMILY_ADULT|PROMOTION_MEMBER_UNAVAILABLE/.test(request.message ?? '')) {
        problems.push(`#${i} 昇格のリクエストが想定外の失敗: ${JSON.stringify(request)}`);
      }
      if ((await activeMembers(familyId)).length > 0) problems.push(`#${i} 解散済みの家族に active が残った`);
    }
    expect(problems).toEqual([]);
  }, 180_000);
});

describe('#1310 家族の行を FOR UPDATE にすると詰まる並びを、順番を固定して再現する (家族の行のロックは FOR NO KEY UPDATE でなければならない)', () => {
  // N5 / N6 は 8 回呼んでも、ロックを取る瞬間が重なる確率は低い。ここでは、子の行を持った接続を pg_sleep で止めてから、
  // 家族の行を先に取る処理を呼ぶ。止めた接続は、起きたあとで家族の行に外部キーの確認 (FOR KEY SHARE) を取りに行く。
  // 家族の行のロックが FOR UPDATE だと、この FOR KEY SHARE が待たされて、子の行を待つ側と待ち合ってデッドロックする。

  /** create_family_invite と同じ順番でロックを取る: 既存の招待の行を revoke (行ロック) → 新しい招待を INSERT (家族の行に FOR KEY SHARE) */
  function holdReinvite(rep: TestUser, familyId: string, oldToken: string, email: string, newToken: string): Holder {
    return startHolder(
      null,
      `UPDATE public.family_invites SET status = 'revoked', revoked_at = now(), revoked_by = '${rep.id}'::uuid
         WHERE token = '${oldToken}';`,
      `INSERT INTO public.family_invites (family_id, email, token, invited_role, status, expires_at, invited_by)
         VALUES ('${familyId}'::uuid, '${email}', '${newToken}', 'adult', 'pending', now() + interval '14 days', '${rep.id}'::uuid);`,
      3,
    );
  }

  /**
   * request_child_promotion と同じ順番でロックを取る: 子供のメンバーの行を FOR UPDATE → 既存の参加リクエストを revoke →
   * 新しい参加リクエストを INSERT (家族の行に FOR KEY SHARE)
   */
  function holdPromotionRequest(rep: TestUser, familyId: string, childId: string, email: string, newToken: string): Holder {
    return startHolder(
      null,
      `SELECT 1 FROM public.family_members WHERE id = '${childId}'::uuid FOR UPDATE;
       UPDATE public.family_promotion_requests SET status = 'revoked', resolved_at = now(), resolved_by = '${rep.id}'::uuid
         WHERE member_id = '${childId}'::uuid AND status = 'pending';`,
      `INSERT INTO public.family_promotion_requests (family_id, member_id, email, token, status, requested_by, expires_at)
         VALUES ('${familyId}'::uuid, '${childId}'::uuid, '${email}', '${newToken}', 'pending', '${rep.id}'::uuid, now() + interval '14 days');`,
      3,
    );
  }

  it('D1: 再招待が招待の行を持っている間に、古い招待の承諾が来ても、デッドロックしない (承諾は INVITE_ALREADY_USED)', async () => {
    const { rep, familyId } = await buildFamily('d1', 0);
    const invitee = await createUser('d1-invitee');
    const oldToken = await inviteToken(rep, familyId, invitee.email);
    const newToken = randomBytes(32).toString('hex');

    const holder = holdReinvite(rep, familyId, oldToken, invitee.email, newToken);
    await holder.sleeping;
    const accept = await acceptViaApi(invitee, oldToken);
    const held = await holder.done;

    expectNoDeadlock(accept, held);
    expect(held.ok).toBe(true);
    expect(accept.ok).toBe(false);
    expect(accept.message).toBe('INVITE_ALREADY_USED');
    expect(await inviteStatus(newToken)).toBe('pending');
    expect(await activeMembers(familyId)).toHaveLength(1); // 代表者だけ
    expect(await profileFamilyId(invitee.id)).toBeNull();
  });

  it('D2: 昇格のリクエストが子供のメンバーの行を持っている間に、古い昇格の承諾が来ても、デッドロックしない (承諾は PROMOTION_REQUEST_ALREADY_USED)', async () => {
    const { rep, familyId } = await buildFamily('d2', 0);
    const target = await createUser('d2-target');
    const childId = await addChild(rep, familyId, 'd2-child');
    const oldToken = await requestPromotion(rep, childId, target.email);
    const newToken = randomBytes(32).toString('hex');

    const holder = holdPromotionRequest(rep, familyId, childId, target.email, newToken);
    await holder.sleeping;
    const accept = await acceptPromotionViaApi(target, oldToken);
    const held = await holder.done;

    expectNoDeadlock(accept, held);
    expect(held.ok).toBe(true);
    expect(accept.ok).toBe(false);
    expect(accept.message).toBe('PROMOTION_REQUEST_ALREADY_USED');
    expect(await profileFamilyId(target.id)).toBeNull();
    expect((await members(familyId)).filter((m) => m.role === 'child')).toHaveLength(1);
  });

  it('D3: 昇格のリクエストが子供のメンバーの行を持っている間に、強制解散が来ても、デッドロックせず、解散は完了する', async () => {
    const { rep, familyId } = await buildFamily('d3', 0);
    const target = await createUser('d3-target');
    const childId = await addChild(rep, familyId, 'd3-child');
    await requestPromotion(rep, childId, target.email);
    const newToken = randomBytes(32).toString('hex');

    const holder = holdPromotionRequest(rep, familyId, childId, target.email, newToken);
    await holder.sleeping;
    const dissolve = await dissolveViaApi(familyId);
    const held = await holder.done;

    expectNoDeadlock(dissolve, held);
    expect(held.ok).toBe(true);
    expect(dissolve.message).toBeNull();
    await expectDissolvedWithNoActiveMembers(familyId, [rep.id]);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. 通常の流れ (回帰) と、関数の属性・権限
// ---------------------------------------------------------------------------------------------

describe('#1310 通常の流れ (順番に呼ぶ) は従来どおり動く', () => {
  it('R1: 参加 → 移譲 → 脱退 → 削除 → 運営の強制譲渡 → 子供の昇格 → 強制解散', async () => {
    const [rep, b, c, d, e] = await createUsers('r1', 5);
    const familyId = await createFamily(rep, 'r1');
    const api = (user: TestUser) => asUser(user.jwt);

    // 参加 (招待の承諾): メンバーに入り、プロフィールの所属が入り、招待は accepted になる
    for (const user of [b, c, d]) {
      const token = await inviteToken(rep, familyId, user.email);
      const accepted = await api(user).rpc('accept_family_invite', { p_token: token });
      expect(accepted.error).toBeNull();
      expect(accepted.data).toMatchObject({ family_id: familyId, user_id: user.id, role: 'adult', status: 'active' });
      expect(await profileFamilyId(user.id)).toBe(familyId);
      expect(await inviteStatus(token)).toBe('accepted');
    }
    expect(await auditCount(familyId, 'invite_accepted')).toBe(3);

    // 代表者の移譲 (rep → b)
    const proposalId = await proposeTransfer(rep, familyId, b.id);
    const transferred = await api(b).rpc('accept_family_representative_transfer', { p_proposal_id: proposalId });
    expect(transferred.error).toBeNull();
    expect(transferred.data).toMatchObject({ id: familyId, representative_id: b.id });
    expect((await memberOf(familyId, b.id)).role).toBe('representative');
    expect((await memberOf(familyId, rep.id)).role).toBe('adult');
    expect(await proposalStatus(proposalId)).toBe('accepted');
    expect(await auditCount(familyId, 'representative_transferred')).toBe(1);

    // 脱退: 代表者は脱退できず、大人は脱退できる
    const repLeave = await api(b).rpc('leave_family');
    expect(repLeave.error?.message).toBe('IS_FAMILY_REPRESENTATIVE');
    const left = await api(c).rpc('leave_family');
    expect(left.error).toBeNull();
    expect(left.data).toMatchObject({ user_id: c.id, status: 'left' });
    expect((left.data as { removed_at: string | null }).removed_at).not.toBeNull();
    expect(await profileFamilyId(c.id)).toBeNull();
    expect(await auditCount(familyId, 'member_left')).toBe(1);
    const notIn = await api(c).rpc('leave_family');
    expect(notIn.error?.message).toBe('NOT_IN_FAMILY');

    // メンバーの削除 (新しい代表者 b が、元の代表者 rep を外す)。家族の外の人・代表者本人は対象外
    const outsiderRemoval = await api(c).rpc('remove_family_member', {
      p_family_id: familyId,
      p_member_id: (await memberOf(familyId, d.id)).id,
    });
    expect(outsiderRemoval.error?.message).toBe('NOT_FAMILY_ADULT');
    const repRemoval = await api(d).rpc('remove_family_member', {
      p_family_id: familyId,
      p_member_id: (await memberOf(familyId, b.id)).id,
    });
    expect(repRemoval.error?.message).toBe('IS_FAMILY_REPRESENTATIVE');
    const removed = await api(b).rpc('remove_family_member', {
      p_family_id: familyId,
      p_member_id: (await memberOf(familyId, rep.id)).id,
    });
    expect(removed.error).toBeNull();
    expect(removed.data).toMatchObject({ user_id: rep.id, status: 'removed' });
    expect(await profileFamilyId(rep.id)).toBeNull();
    expect(await auditCount(familyId, 'member_removed')).toBe(1);

    // 運営の強制譲渡 (b → d)。家族の外の人 (脱退した c) は対象にできない
    const badTarget = await asUser(operator.jwt).rpc('operator_force_representative_transfer', {
      p_family_id: familyId,
      p_new_rep_id: c.id,
      p_reason: '#1310 r1',
    });
    expect(badTarget.error?.message).toBe('TARGET_NOT_IN_FAMILY');
    const forced = await asUser(operator.jwt).rpc('operator_force_representative_transfer', {
      p_family_id: familyId,
      p_new_rep_id: d.id,
      p_reason: '#1310 r1',
    });
    expect(forced.error).toBeNull();
    expect(forced.data).toMatchObject({ id: familyId, representative_id: d.id });
    expect((await memberOf(familyId, d.id)).role).toBe('representative');
    expect((await memberOf(familyId, b.id)).role).toBe('adult');
    expect(await auditCount(familyId, 'operator_force_representative_transfer')).toBe(1);

    // 子供の枠 → 昇格のリクエスト → 本人 (e) の承認で、その枠が e の大人メンバーになる
    const child = await api(d).rpc('add_family_child', {
      p_family_id: familyId,
      p_display_name: 'r1-child',
      p_child_profile: { age: 9 },
    });
    expect(child.error).toBeNull();
    const request = await api(d).rpc('request_child_promotion', {
      p_member_id: (child.data as { id: string }).id,
      p_email: e.email,
    });
    expect(request.error).toBeNull();
    const promoted = await api(e).rpc('accept_child_promotion', { p_token: (request.data as { token: string }).token });
    expect(promoted.error).toBeNull();
    expect(promoted.data).toMatchObject({ family_id: familyId, user_id: e.id, role: 'adult', status: 'active' });
    expect(await profileFamilyId(e.id)).toBe(familyId);
    expect(await auditCount(familyId, 'child_promoted')).toBe(1);

    // 運営の強制解散: 全員が left になり、プロフィールの所属が外れ、家族は dissolved になる
    const dissolved = await asUser(operator.jwt).rpc('operator_force_dissolve_family', {
      p_family_id: familyId,
      p_reason: '#1310 r1',
    });
    expect(dissolved.error).toBeNull();
    expect(dissolved.data).toMatchObject({ id: familyId, status: 'dissolved' });
    expect((dissolved.data as { dissolved_at: string | null }).dissolved_at).not.toBeNull();
    await expectDissolvedWithNoActiveMembers(familyId, [b.id, d.id, e.id]);
    expect(await auditCount(familyId, 'operator_force_dissolve')).toBe(1);
  }, 120_000);

  it('R2: 運営でない人は強制解散・強制譲渡できず、家族は何も変わらない', async () => {
    const { rep, adults, familyId } = await buildFamily('r2', 1);
    const [adult] = adults;

    const dissolve = await asUser(rep.jwt).rpc('operator_force_dissolve_family', { p_family_id: familyId, p_reason: 'x' });
    expect(dissolve.error?.message).toBe('NOT_OPERATOR');
    const transfer = await asUser(rep.jwt).rpc('operator_force_representative_transfer', {
      p_family_id: familyId,
      p_new_rep_id: adult.id,
      p_reason: 'x',
    });
    expect(transfer.error?.message).toBe('NOT_OPERATOR');
    expect((await familyRow(familyId))?.status).toBe('active');
    expect((await familyRow(familyId))?.representative_id).toBe(rep.id);
    expect(await activeMembers(familyId)).toHaveLength(2);
  });

  it('R3: 期限切れ・使用済みの招待と、別の家族に入っている人の承諾は、従来どおりのエラーで何も変えない', async () => {
    const { rep, familyId } = await buildFamily('r3', 0);
    const [expired, used, mismatch] = await createUsers('r3-x', 3);
    const expiredToken = await inviteToken(rep, familyId, expired.email);
    const usedToken = await inviteToken(rep, familyId, used.email);
    const mismatchToken = await inviteToken(rep, familyId, 'someone-else-r3@homegohan.test');

    await srAdmin
      .from('family_invites')
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq('token', expiredToken);
    expect((await acceptViaApi(expired, expiredToken)).message).toBe('INVITE_EXPIRED');

    expect((await acceptViaApi(used, usedToken)).ok).toBe(true);
    expect((await acceptViaApi(used, usedToken)).message).toBe('INVITE_ALREADY_USED');

    expect((await acceptViaApi(mismatch, mismatchToken)).message).toBe('INVITE_EMAIL_MISMATCH');
    expect((await acceptViaApi(mismatch, randomBytes(32).toString('hex'))).message).toBe('INVITE_NOT_FOUND');

    // すでに別の家族に入っている人は、別の家族の招待を承諾できない
    const other = await buildFamily('r3-other', 0);
    const alreadyToken = await inviteToken(other.rep, other.familyId, used.email);
    expect((await acceptViaApi(used, alreadyToken)).message).toBe('ALREADY_IN_FAMILY');

    expect(await activeMembers(familyId)).toHaveLength(2); // 代表者 + used
  });
});

describe('#1310 置き換えた関数の属性と権限は変わらない', () => {
  const EXPECTED = [
    { sig: 'accept_child_promotion(text,boolean,boolean,boolean)', serviceRole: false },
    { sig: 'accept_family_invite(text,boolean,boolean,boolean)', serviceRole: true },
    { sig: 'accept_family_representative_transfer(uuid)', serviceRole: true },
    { sig: 'leave_family()', serviceRole: true },
    { sig: 'operator_force_dissolve_family(uuid,text)', serviceRole: true },
    { sig: 'operator_force_representative_transfer(uuid,uuid,text)', serviceRole: true },
    { sig: 'remove_family_member(uuid,uuid)', serviceRole: true },
  ];

  async function definitions() {
    return pgQuery<{
      sig: string;
      secdef: boolean;
      config: string[] | null;
      owner: string;
      anon_exec: boolean;
      auth_exec: boolean;
      sr_exec: boolean;
      public_exec: boolean;
      def: string;
    }>(`
      SELECT p.oid::regprocedure::text AS sig,
             p.prosecdef AS secdef,
             p.proconfig AS config,
             pg_get_userbyid(p.proowner) AS owner,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS sr_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0
             ) AS public_exec,
             pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (${[
        'accept_child_promotion',
        'accept_family_invite',
        'accept_family_representative_transfer',
        'leave_family',
        'operator_force_dissolve_family',
        'operator_force_representative_transfer',
        'remove_family_member',
      ]
        .map((name) => `'${name}'`)
        .join(', ')})
      ORDER BY 1
    `);
  }

  it('P1: SECURITY DEFINER・search_path 固定・所有者 postgres。anon・PUBLIC は実行できず、authenticated は実行できる', async () => {
    const rows = await definitions();
    expect(rows.map((r) => r.sig)).toEqual(EXPECTED.map((e) => e.sig));
    for (const row of rows) {
      const expected = EXPECTED.find((e) => e.sig === row.sig)!;
      expect(row.secdef, row.sig).toBe(true);
      expect(row.config, row.sig).toContain('search_path=public');
      expect(row.owner, row.sig).toBe('postgres');
      expect(row.anon_exec, row.sig).toBe(false);
      expect(row.public_exec, row.sig).toBe(false);
      expect(row.auth_exec, row.sig).toBe(true);
      expect(row.sr_exec, row.sig).toBe(expected.serviceRole);
    }
  });

  it('P2: どの関数も、子の行 (招待・メンバー・参加リクエスト) を取る前に family_groups の行を FOR NO KEY UPDATE でロックしている', async () => {
    const rows = await definitions();
    const lockPattern = /FROM family_groups\s+WHERE id = [\w.]+\s+FOR NO KEY UPDATE/;
    for (const row of rows) {
      expect(row.def, `${row.sig} に family_groups の FOR NO KEY UPDATE が無い`).toMatch(lockPattern);
    }
    // accept_family_invite は、招待の行の FOR UPDATE より前に家族の行を取る (修正前は逆で、削除と同時だとデッドロックした)
    const accept = rows.find((r) => r.sig.startsWith('accept_family_invite'))!;
    const familyLock = accept.def.search(lockPattern);
    const inviteLock = accept.def.search(/FROM family_invites WHERE token = p_token FOR UPDATE/);
    expect(familyLock).toBeGreaterThan(-1);
    expect(inviteLock).toBeGreaterThan(-1);
    expect(familyLock).toBeLessThan(inviteLock);
  });

  it('P3: anon は運営用の RPC を呼べない', async () => {
    const dissolve = await anon().rpc('operator_force_dissolve_family', {
      p_family_id: '00000000-0000-4000-8000-000000001310',
      p_reason: 'x',
    });
    expect(dissolve.error?.code).toBe('42501');
    const transfer = await anon().rpc('operator_force_representative_transfer', {
      p_family_id: '00000000-0000-4000-8000-000000001310',
      p_new_rep_id: '00000000-0000-4000-8000-000000001311',
      p_reason: 'x',
    });
    expect(transfer.error?.code).toBe('42501');
  });
});
