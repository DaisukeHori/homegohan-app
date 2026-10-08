/**
 * health_goals (健康目標) の値の検査 (#1229) の回帰テスト
 *
 * 修正前の health_goals (本番スナップショット supabase/baseline/prod_schema.sql):
 *   target_value  numeric(10,2) NOT NULL  ← 桁あふれは防げるが、-50 や 0 が入る
 *   current_value numeric(10,2)           ← 負の値が入る
 *   goal_type     text NOT NULL           ← '' や 'x y'、日本語、長大な文字列でも入る
 *   status        text                    ← 本番には health_goals_status_check がある (リポジトリの旧 migration には無かった)
 * RLS は本人の行だけに絞っているが、アプリ (POST /api/health/goals) の入力検証は PostgREST を直接叩けば迂回できる。
 * このテストは「ログインユーザーが PostgREST で自分の行を直接 INSERT / UPDATE する」経路で、DB の検査が効くことを確かめる。
 *
 * 修正後 (20261008110100_health_goals_value_trigger.sql): 検査トリガー trg_health_goals_validate_values
 *   BEFORE INSERT OR UPDATE OF target_value, current_value, goal_type (FOR EACH ROW)
 *   target_value   > 0
 *   current_value  NULL か >= 0
 *   goal_type      ^[a-z][a-z0-9_-]{0,63}$   ← 列挙ではなく形式だけ
 *   (numeric の NaN は、target_value / current_value では拒否する)
 * 違反は SQLSTATE 23514 (check_violation) で、メッセージに列名 (health_goals.<列>) が入る。PostgREST は HTTP 400 で返す。
 * goal_type を列挙にしないのは、種類を足すたびに migration を要さないため。種類ごとの値の範囲はアプリ層で検証する。
 *
 * CHECK 制約ではなくトリガーにした理由 (このテストの (c)):
 *   CHECK 制約は NOT VALID でも、INSERT / UPDATE のたびに「更新後の行全体」を検査する。本番に違反した行が既にあると、
 *   その行は status や note など別の列を更新しても 23514 で失敗するようになってしまう。
 *   トリガーは「書き込む値」だけを検査する (INSERT は 3 列すべて、UPDATE は値が変わる列だけ)。
 *
 * このテストが確かめること:
 *   (a) 範囲外の書き込みは拒否される (T-1 / C-1 / G-1 / U-1 ほか)
 *   (b) 範囲内の書き込みは通る (T-2 / C-2 / G-2 / U-2)
 *   (c) 違反している既存の行 (本番に既にあるかもしれない行) は、書き換えない列なら今までどおり更新できる (L-1 〜 L-7)
 *       既存の違反行は、検査トリガーを 1 回のトランザクションの中だけ止めて INSERT して再現する
 *       (トランザクションの外からは止まって見えず、COMMIT までに有効へ戻る)。
 *   (d) トリガーと関数の定義 (D-1 〜 D-3)、status の既存の制約が変わっていないこと (S-1 / S-2)
 *
 * 実行 (ローカル Supabase: bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local):
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/health-goals-constraints.test.ts
 *
 * 定義の確認と、違反行を作るための「トリガーを止める」操作は、ローカルスタックの postgres-meta
 * (/pg/query、service_role キーが必要) を使う。本番には接続しない。
 */

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

/** migration が作る検査トリガーと関数の名前 */
const TRIGGER = 'trg_health_goals_validate_values';
const FUNCTION = 'health_goals_validate_values';

// ---------------------------------------------------------------
// クライアントファクトリ (health-recipes-own-policies.test.ts と同型)
// ---------------------------------------------------------------
function anonClient(): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function serviceRoleClient(): SupabaseClient {
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

function authedClient(accessToken: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

const srAdmin = serviceRoleClient();

/** ローカルスタックの postgres-meta で SQL を実行する。複数の文は 1 つのトランザクションで実行され、最後の文の行が返る */
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

/** 検査トリガーの状態 ('O' = 有効、'D' = 無効)。トリガーが無ければ null */
async function triggerState(): Promise<string | null> {
  const rows = await pgQuery<{ tgenabled: string }>(
    `SELECT tgenabled FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.health_goals'::regclass AND tgname = '${TRIGGER}' AND NOT tgisinternal`,
  );
  return rows[0]?.tgenabled ?? null;
}

// ---------------------------------------------------------------
// テストユーザー (使い捨て。ローカル専用のパスワード)
//   health_goals の user_id は auth.users への外部キーなので、プロフィール行は要らない。
// ---------------------------------------------------------------
interface TestUser {
  userId: string;
  jwt: string;
}

const TS = Date.now();
/** note に入れる印。後片付けと「行が残っていないこと」の確認で、このテストが入れた行だけを特定する */
const MARK = `gc-${TS}`;

async function createTestUser(label: string): Promise<TestUser> {
  const email = `rls-health-goals-${label}-${TS}@homegohan.test`;
  const password = 'TestPass!2026-rls';

  const { data: authData, error: authError } = await srAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError || !authData.user) {
    throw new Error(`Failed to create auth user ${email}: ${authError?.message}`);
  }
  const userId = authData.user.id;

  // サインインは使い捨ての anon クライアントで行う (srAdmin でサインインすると以後 service_role でなくなる)
  const signInResult = await anonClient().auth.signInWithPassword({ email, password });
  if (signInResult.error || !signInResult.data.session) {
    await srAdmin.auth.admin.deleteUser(userId);
    throw new Error(`Failed to sign in ${email}: ${signInResult.error?.message}`);
  }
  return { userId, jwt: signInResult.data.session.access_token };
}

let owner: TestUser;

beforeAll(async () => {
  owner = await createTestUser('owner');
}, 60_000);

afterAll(async () => {
  // service role で、このテストが入れた行だけを消す (DELETE は検査の対象外)
  await srAdmin.from('health_goals').delete().like('note', `${MARK}%`);
  const { data: left } = await srAdmin.from('health_goals').select('id').like('note', `${MARK}%`);
  const state = await triggerState();

  // ユーザーを消すと、user_id の外部キー (ON DELETE CASCADE) でそのユーザーの行も消える。
  // 確認で失敗しても使い捨てのユーザーが残らないよう、確認より先に消す
  if (owner?.userId) await srAdmin.auth.admin.deleteUser(owner.userId);

  // 後片付けの確認 (残っていれば失敗させる)
  expect(left ?? []).toEqual([]);
  // 違反行を作るために止めたトリガーが、有効に戻っていること
  expect(state).toBe('O');
}, 30_000);

// ---------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------
/** 本人の JWT で自分の行を INSERT する (RLS は通る。DB の検査だけを確かめる) */
async function insertGoal(overrides: Record<string, unknown> = {}) {
  return authedClient(owner.jwt)
    .from('health_goals')
    .insert({
      user_id: owner.userId,
      goal_type: 'weight',
      target_value: 60,
      target_unit: 'kg',
      note: MARK,
      ...overrides,
    })
    .select('id, goal_type, target_value, current_value, status')
    .single();
}

/** service role で、このテストが入れた行の件数を数える (拒否された INSERT が行を残していないことの確認) */
async function countMarked(): Promise<number> {
  const { count, error } = await srAdmin
    .from('health_goals')
    .select('id', { count: 'exact', head: true })
    .like('note', `${MARK}%`);
  if (error) throw new Error(`countMarked: ${error.message}`);
  return count ?? 0;
}

/** 検査トリガーによる check_violation (23514) で、メッセージに列名 (health_goals.<列>) が入っていること */
function expectCheckViolation(
  error: { code?: string; message?: string } | null,
  column: 'target_value' | 'current_value' | 'goal_type',
) {
  expect(error).not.toBeNull();
  expect(error!.code).toBe('23514');
  expect(error!.message).toContain(`health_goals.${column}`);
}

// ---------------------------------------------------------------
// target_value: 正の数だけ
// ---------------------------------------------------------------
describe('health_goals.target_value', () => {
  it.each([
    ['負の値 (-50)', -50],
    ['0', 0],
    ['numeric(10,2) で 0.00 に丸まる値 (0.004)', 0.004],
    ['NaN (数値として使えない)', 'NaN'],
  ])('T-1: %s の INSERT は拒否される (23514・HTTP 400・行は残らない)', async (_label, value) => {
    const before = await countMarked();
    const { error, status } = await insertGoal({ target_value: value });
    expectCheckViolation(error, 'target_value');
    expect(status).toBe(400);
    expect(await countMarked()).toBe(before);
  });

  it('T-2: 正の値 (0.01 / 60 / 100000) は INSERT できる', async () => {
    for (const value of [0.01, 60, 100000]) {
      const { data, error } = await insertGoal({ target_value: value });
      expect(error).toBeNull();
      expect(Number(data?.target_value)).toBe(value);
    }
  });

  it('T-3: service_role (RLS を通らない経路) の INSERT にも同じ検査が効く', async () => {
    const before = await countMarked();
    const { error } = await srAdmin
      .from('health_goals')
      .insert({ user_id: owner.userId, goal_type: 'weight', target_value: -50, target_unit: 'kg', note: MARK });
    expectCheckViolation(error, 'target_value');
    expect(await countMarked()).toBe(before);
  });
});

// ---------------------------------------------------------------
// current_value: NULL か 0 以上
// ---------------------------------------------------------------
describe('health_goals.current_value', () => {
  it.each([
    ['負の値 (-0.01)', -0.01],
    ['NaN (数値として使えない)', 'NaN'],
  ])('C-1: %s の INSERT は拒否される (23514・行は残らない)', async (_label, value) => {
    const before = await countMarked();
    const { error } = await insertGoal({ current_value: value });
    expectCheckViolation(error, 'current_value');
    expect(await countMarked()).toBe(before);
  });

  it('C-2: 0 (例: 今日の歩数 0 歩) と NULL (未計測) と正の値は INSERT できる', async () => {
    for (const value of [0, null, 61.2]) {
      const { data, error } = await insertGoal({ goal_type: 'steps', target_unit: '歩', target_value: 8000, current_value: value });
      expect(error).toBeNull();
      expect(data?.current_value === null ? null : Number(data?.current_value)).toBe(value);
    }
  });
});

// ---------------------------------------------------------------
// goal_type: 形式だけ (列挙にはしない)
// ---------------------------------------------------------------
describe('health_goals.goal_type', () => {
  it.each([
    ['空文字', ''],
    ['大文字を含む', 'Weight'],
    ['日本語', '体重'],
    ['数字で始まる', '1weight'],
    ['空白を含む', 'weight loss'],
    ['記号を含む', "weight';drop"],
    ['ハイフンで始まる', '-weight'],
    ['アンダースコアで始まる', '_weight'],
    ['末尾に改行', 'weight\n'],
    ['65 文字', 'a'.repeat(65)],
  ])('G-1: %s の goal_type の INSERT は拒否される (23514・行は残らない)', async (_label, goalType) => {
    const before = await countMarked();
    const { error } = await insertGoal({ goal_type: goalType });
    expectCheckViolation(error, 'goal_type');
    expect(await countMarked()).toBe(before);
  });

  it('G-1b: 拒否のメッセージに、送られた goal_type の値は載らない (長大な文字列をそのまま返さない)', async () => {
    const { error } = await insertGoal({ goal_type: `Bad-${'x'.repeat(200)}` });
    expectCheckViolation(error, 'goal_type');
    expect(error!.message).not.toContain('xxxxxxxxxx');
  });

  it.each([
    // アプリが受け付ける種類 (Web は weight / body_fat / steps、現行モバイルは step_count / sleep_hours も送る)
    'weight',
    'body_fat',
    'steps',
    'step_count',
    'sleep_hours',
    // 形式に合えば、DB はまだ知らない種類も通す (種類を足すたびに migration を要さないため)
    'a',
    'muscle-mass_2',
    'a'.repeat(64),
    `rls-drift-${TS}-1`,
  ])('G-2: goal_type %s は INSERT できる', async (goalType) => {
    const { data, error } = await insertGoal({ goal_type: goalType });
    expect(error).toBeNull();
    expect(data?.goal_type).toBe(goalType);
  });
});

// ---------------------------------------------------------------
// UPDATE でも検査が効く (本人が自分の行を PostgREST で書き換える経路)
// ---------------------------------------------------------------
describe('health_goals の UPDATE', () => {
  let rowId: string;

  /** service role で行を読む (RLS の影響を受けない) */
  async function readRow() {
    const { data, error } = await srAdmin
      .from('health_goals')
      .select('goal_type, target_value, current_value, status, note')
      .eq('id', rowId)
      .single();
    if (error) throw new Error(`readRow: ${error.message}`);
    return data;
  }

  it('U-0: 準備: 正常な行を作る', async () => {
    const { data, error } = await insertGoal({ target_value: 60, current_value: 65 });
    expect(error).toBeNull();
    rowId = data!.id as string;
  });

  it.each([
    ['target_value を負にする', { target_value: -1 }, 'target_value'],
    ['target_value を 0 にする', { target_value: 0 }, 'target_value'],
    ['target_value を 0.00 に丸まる値 (0.004) にする', { target_value: 0.004 }, 'target_value'],
    ['target_value を NaN にする', { target_value: 'NaN' }, 'target_value'],
    ['current_value を負にする', { current_value: -5 }, 'current_value'],
    ['current_value を NaN にする', { current_value: 'NaN' }, 'current_value'],
    ['goal_type を形式に合わない値にする', { goal_type: 'Bad Type' }, 'goal_type'],
  ] as const)('U-1: %s UPDATE は拒否される (23514・値は変わらない)', async (_label, patch, column) => {
    const before = await readRow();
    const { error, status } = await authedClient(owner.jwt).from('health_goals').update(patch).eq('id', rowId);
    expectCheckViolation(error, column);
    expect(status).toBe(400);
    expect(await readRow()).toEqual(before);
  });

  it('U-2: 正常な値への UPDATE は通る (current_value を 0 や NULL に戻すことも、範囲内の target_value への変更も)', async () => {
    const client = authedClient(owner.jwt);
    for (const patch of [{ target_value: 58.5 }, { current_value: 0 }, { current_value: null }, { note: MARK }]) {
      const { data, error } = await client.from('health_goals').update(patch).eq('id', rowId).select('id');
      expect(error).toBeNull();
      expect((data ?? []).map((r) => r.id)).toEqual([rowId]);
    }
    const row = await readRow();
    expect(Number(row.target_value)).toBe(58.5);
    expect(row.current_value).toBeNull();
  });
});

// ---------------------------------------------------------------
// (c) 違反している既存の行 (本番に既にあるかもしれない行) の扱い
//   CHECK 制約 (NOT VALID でも) なら、どの列の UPDATE も 23514 で失敗する行。
//   検査トリガーは書き込む値だけを検査するので、書き換えない列の更新は今までどおり通る。
// ---------------------------------------------------------------
describe('違反している既存の行は、書き換えない列なら今までどおり更新できる', () => {
  const LEGACY_NOTE = `${MARK}-legacy`;
  let rowId: string;

  /**
   * 3 列とも新しい検査に違反した行 (target_value -50 / current_value -3 / goal_type 'Weight Loss') を作る。
   * 検査トリガーを同じトランザクションの中だけ止めて INSERT し、COMMIT の前に有効へ戻す
   * (トランザクションの途中の状態は他の接続から見えないので、ほかの書き込みの検査は止まらない)。
   */
  async function insertLegacyGoal(): Promise<string> {
    const rows = await pgQuery<{ id: string }>(`
      ALTER TABLE public.health_goals DISABLE TRIGGER ${TRIGGER};
      INSERT INTO public.health_goals (user_id, goal_type, target_value, target_unit, current_value, note)
      VALUES ('${owner.userId}', 'Weight Loss', -50, 'kg', -3, '${LEGACY_NOTE}');
      ALTER TABLE public.health_goals ENABLE TRIGGER ${TRIGGER};
      SELECT id FROM public.health_goals WHERE note = '${LEGACY_NOTE}';
    `);
    expect(rows).toHaveLength(1);
    return rows[0].id;
  }

  /** service role で行を読む (RLS の影響を受けない) */
  async function readLegacy() {
    const { data, error } = await srAdmin
      .from('health_goals')
      .select('goal_type, target_value, current_value, status, note, target_unit, target_date, progress_percentage, achieved_at, updated_at')
      .eq('id', rowId)
      .single();
    if (error) throw new Error(`readLegacy: ${error.message}`);
    return data;
  }

  /** 本人の JWT で自分の行を UPDATE する */
  const updateLegacy = (patch: Record<string, unknown>) =>
    authedClient(owner.jwt).from('health_goals').update(patch).eq('id', rowId).select('id');

  it('L-0: 準備: 3 列とも違反した行を、検査トリガーを止めて入れる (入れたあとはトリガーが有効に戻る)', async () => {
    rowId = await insertLegacyGoal();
    const row = await readLegacy();
    expect(row.goal_type).toBe('Weight Loss');
    expect(Number(row.target_value)).toBe(-50);
    expect(Number(row.current_value)).toBe(-3);
    expect(await triggerState()).toBe('O');
    // 有効に戻っているので、ふつうの違反した INSERT は拒否される
    const { error } = await insertGoal({ target_value: -1 });
    expectCheckViolation(error, 'target_value');
  });

  it('L-1: 値の列以外の更新は通る (status / achieved_at / note / target_unit / target_date / progress_percentage / milestones)', async () => {
    const achievedAt = new Date().toISOString();
    const { data, error } = await updateLegacy({
      status: 'achieved',
      achieved_at: achievedAt,
      note: `${LEGACY_NOTE}-edited`,
      target_unit: 'lb',
      target_date: '2027-01-31',
      progress_percentage: 12.5,
      milestones: [{ value: 1, achieved_at: achievedAt }],
      last_updated_at: achievedAt,
    });
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toEqual([rowId]);
    const row = await readLegacy();
    expect(row.status).toBe('achieved');
    expect(row.note).toBe(`${LEGACY_NOTE}-edited`);
    expect(row.target_unit).toBe('lb');
    expect(row.target_date).toBe('2027-01-31');
    expect(Number(row.progress_percentage)).toBe(12.5);
    // 違反している 3 列は、そのまま
    expect(row.goal_type).toBe('Weight Loss');
    expect(Number(row.target_value)).toBe(-50);
    expect(Number(row.current_value)).toBe(-3);
  });

  it('L-2: updated_at を更新しても通る (既存の updated_at トリガーが時刻を進める)', async () => {
    const before = await readLegacy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { error } = await updateLegacy({ updated_at: new Date().toISOString() });
    expect(error).toBeNull();
    const after = await readLegacy();
    expect(new Date(after.updated_at as string).getTime()).toBeGreaterThan(new Date(before.updated_at as string).getTime());
  });

  it('L-3: 違反している列に「今と同じ値」を書き直す UPDATE も通る (全項目を送る保存でも、触っていない列が弾かれない)', async () => {
    const { error } = await updateLegacy({
      goal_type: 'Weight Loss',
      target_value: -50,
      current_value: -3,
      note: `${LEGACY_NOTE}-same`,
    });
    expect(error).toBeNull();
    const row = await readLegacy();
    expect(row.note).toBe(`${LEGACY_NOTE}-same`);
    expect(Number(row.target_value)).toBe(-50);
  });

  it.each([
    ['target_value を別の違反した値 (-60) にする', { target_value: -60 }, 'target_value'],
    ['target_value を 0 にする', { target_value: 0 }, 'target_value'],
    ['current_value を別の違反した値 (-4) にする', { current_value: -4 }, 'current_value'],
    ['goal_type を別の違反した値にする', { goal_type: 'Bad Type' }, 'goal_type'],
  ] as const)('L-4: %s UPDATE は拒否される (列名入り・行は変わらない)', async (_label, patch, column) => {
    const before = await readLegacy();
    const { error } = await updateLegacy(patch);
    expectCheckViolation(error, column);
    expect(await readLegacy()).toEqual(before);
  });

  it('L-5: 他の列と一緒の UPDATE でも、変わる列が違反なら全体が拒否される (他の列も変わらない)', async () => {
    const before = await readLegacy();
    const { error } = await updateLegacy({ note: `${LEGACY_NOTE}-must-not-stick`, status: 'paused', target_value: -1 });
    expectCheckViolation(error, 'target_value');
    expect(await readLegacy()).toEqual(before);
  });

  it('L-6: 違反している列を正しい値に直す UPDATE は通る (ほかの違反している列を一緒に直さなくてよい)', async () => {
    const { error } = await updateLegacy({ target_value: 60 });
    expect(error).toBeNull();
    const row = await readLegacy();
    expect(Number(row.target_value)).toBe(60);
    // 直していない列は違反したまま、更新はそのまま通る
    expect(row.goal_type).toBe('Weight Loss');
    expect(Number(row.current_value)).toBe(-3);
    const next = await updateLegacy({ note: `${LEGACY_NOTE}-after-fix` });
    expect(next.error).toBeNull();
  });

  it('L-7: 残りの列も直すと普通の行と同じになる (そのあとは違反した値には変えられない)', async () => {
    const fix = await updateLegacy({ current_value: 65, goal_type: 'weight' });
    expect(fix.error).toBeNull();
    const row = await readLegacy();
    expect(row.goal_type).toBe('weight');
    expect(Number(row.current_value)).toBe(65);
    const { error } = await updateLegacy({ current_value: -1 });
    expectCheckViolation(error, 'current_value');
  });
});

// ---------------------------------------------------------------
// (d) トリガーと関数の定義
// ---------------------------------------------------------------
describe('検査トリガーと関数の定義', () => {
  it('D-1: トリガーは BEFORE INSERT OR UPDATE OF target_value, current_value, goal_type の行ごとで、有効', async () => {
    const rows = await pgQuery<{ tgenabled: string; def: string }>(
      `SELECT tgenabled, pg_get_triggerdef(oid) AS def FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.health_goals'::regclass AND tgname = '${TRIGGER}' AND NOT tgisinternal`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tgenabled).toBe('O');
    expect(rows[0].def).toMatch(
      /BEFORE INSERT OR UPDATE OF target_value, current_value, goal_type ON (public\.)?health_goals FOR EACH ROW/,
    );
    expect(rows[0].def).toMatch(new RegExp(`EXECUTE FUNCTION (public\\.)?${FUNCTION}\\(\\)`));
  });

  it('D-2: 関数は SECURITY INVOKER・search_path が空・plpgsql で、トリガーを返す', async () => {
    const rows = await pgQuery<{ prosecdef: boolean; proconfig: string[] | null; lang: string; result: string }>(
      `SELECT p.prosecdef, p.proconfig, l.lanname AS lang, pg_get_function_result(p.oid) AS result
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_language l ON l.oid = p.prolang
       WHERE n.nspname = 'public' AND p.proname = '${FUNCTION}'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prosecdef).toBe(false);
    expect(rows[0].proconfig).toEqual(['search_path=""']);
    expect(rows[0].lang).toBe('plpgsql');
    expect(rows[0].result).toBe('trigger');
  });

  it('D-3: 旧版の CHECK 制約 3 本は無く、status の既存の制約は残っている', async () => {
    const rows = await pgQuery<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.health_goals'::regclass AND contype = 'c'`,
    );
    const names = rows.map((r) => r.conname);
    expect(names).not.toContain('health_goals_target_value_positive');
    expect(names).not.toContain('health_goals_current_value_nonnegative');
    expect(names).not.toContain('health_goals_goal_type_format');
    expect(rows.find((r) => r.conname === 'health_goals_status_check')?.convalidated).toBe(true);
  });
});

// ---------------------------------------------------------------
// status: 本番には元からある制約。この変更では触らない (挙動は修正前から変わらない)
// ---------------------------------------------------------------
describe('health_goals.status', () => {
  it('S-1: 想定外の status の INSERT は拒否される (23514・health_goals_status_check)', async () => {
    const before = await countMarked();
    const { error } = await insertGoal({ status: 'bogus' });
    expect(error).not.toBeNull();
    expect(error!.code).toBe('23514');
    expect(error!.message).toContain('"health_goals_status_check"');
    expect(await countMarked()).toBe(before);
  });

  it.each(['active', 'achieved', 'paused', 'cancelled'])('S-2: status %s は INSERT できる', async (status) => {
    const { data, error } = await insertGoal({ status });
    expect(error).toBeNull();
    expect(data?.status).toBe(status);
  });
});
