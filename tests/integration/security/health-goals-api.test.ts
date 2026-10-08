/**
 * 健康目標 API (POST /api/health/goals、PUT /api/health/goals/[id]) の入力検証 (#1229) の結合テスト
 *
 * 実際の Next ルートと、検査トリガーを持つローカルの DB (20261008110100_health_goals_value_trigger.sql) をつないで確かめる。
 * ルート単体の検証は tests/health-goals-route.test.ts、DB の検査単体は tests/integration/rls/health-goals-constraints.test.ts。
 *
 * 修正前: POST は goal_type も target_value も検証せず、体重の目標 -50 や goal_type "x y" が保存できた
 *   (体重なら user_profiles.target_weight にもコピーされた)。PUT も目標値の符号・範囲を見なかった。
 * 修正後:
 *   - goal_type は weight / body_fat / steps / step_count / sleep_hours だけ。目標値・現在値はその種類の範囲だけ (外れたら 400)
 *   - 現行のモバイルアプリが送る step_count / sleep_hours と、Web が送る steps / weight / body_fat は今までどおり作れる
 *   - プロフィールの体重が異常値でも (開始値にしないだけで) 体重の目標は作れる。DB の検査に当たって 500 にならない
 *   - 本番に既にあるかもしれない「新しい検査に違反した行」も、書き換えない列なら今までどおり更新できる
 *     (DB の検査は CHECK 制約ではなく、書き込む値だけを見るトリガーなので、画面の更新が止まらない)
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh) と Next の開発サーバー。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npm run dev &
 *   npx vitest run --config vitest.integration.config.ts tests/integration/security/health-goals-api.test.ts
 *   (開発サーバーが 3000 番以外なら INTEGRATION_BASE_URL=http://localhost:<port> を付ける)
 */

import { randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

function client(key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

const srAdmin = client(serviceKey);

/** ローカルスタックの postgres-meta で SQL を実行する。複数の文は 1 つのトランザクションで実行され、最後の文の行が返る */
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

interface TestUser {
  id: string;
  jwt: string;
}

const TS = Date.now();
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
const createdUserIds: string[] = [];

/** プロフィール (体重・体脂肪率) 付きのユーザーを作る。目標の開始値はプロフィールから取られる */
async function createUser(label: string, profile: Record<string, unknown>): Promise<TestUser> {
  const email = `sec-health-goals-${label}-${TS}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await srAdmin
    .from('user_profiles')
    .upsert(
      { id: data.user.id, nickname: `goals-${label}`, age_group: '30s', gender: 'other', ...profile },
      { onConflict: 'id' },
    );
  if (profileError) throw new Error(`profile ${label}: ${profileError.message}`);
  // サインインは使い捨てのクライアントで行う (srAdmin でサインインすると service_role でなくなる)
  const signIn = await client(anonKey).auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new Error(`signIn ${label}: ${signIn.error?.message}`);
  return { id: data.user.id, jwt: signIn.data.session.access_token };
}

interface GoalRow {
  id: string;
  user_id: string;
  goal_type: string;
  target_value: number | string;
  target_unit: string;
  start_value: number | string | null;
  current_value: number | string | null;
  progress_percentage: number | string | null;
  status: string;
}

/** service_role で、そのユーザーの目標をすべて読む (RLS の影響を受けない) */
async function goalsOf(userId: string): Promise<GoalRow[]> {
  const { data, error } = await srAdmin.from('health_goals').select('*').eq('user_id', userId).order('created_at');
  if (error) throw new Error(`goalsOf: ${error.message}`);
  return (data ?? []) as GoalRow[];
}

async function profileOf(userId: string): Promise<Record<string, unknown>> {
  const { data, error } = await srAdmin.from('user_profiles').select('*').eq('id', userId).single();
  if (error) throw new Error(`profileOf: ${error.message}`);
  return data as Record<string, unknown>;
}

type GoalResponse = { goal?: GoalRow; error?: string };

const num = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));

let owner: TestUser; // 体重 70kg・体脂肪率 25%
let other: TestUser; // 無関係の別ユーザー
let oddProfile: TestUser; // プロフィールの体重が負 (異常値)

beforeAll(async () => {
  owner = await createUser('owner', { weight: 70, body_fat_percentage: 25 });
  other = await createUser('other', { weight: 60 });
  oddProfile = await createUser('odd-profile', { weight: -5, body_fat_percentage: 0.2 });

  // 開発サーバーは最初のリクエストでルートをコンパイルするため遅い。テスト本体のタイムアウトに入らないよう、
  // 未認証 (401 が返るだけで何も書かない) で先に呼んでおく
  await apiCall('POST', '/api/health/goals', null, {});
  await apiCall('PUT', '/api/health/goals/00000000-0000-0000-0000-000000000000', null, {});
}, 180_000);

afterAll(async () => {
  // 目標の行はユーザー削除 (ON DELETE CASCADE) でも消えるが、先に明示的に消して残っていないことを確かめる
  for (const id of createdUserIds) {
    await srAdmin.from('health_goals').delete().eq('user_id', id);
  }
  for (const id of createdUserIds) {
    const left = await goalsOf(id);
    expect(left).toEqual([]);
    await srAdmin.auth.admin.deleteUser(id);
  }
}, 60_000);

describe('POST /api/health/goals: 受け付ける目標 (Web とモバイルが送る値は今までどおり作れる)', () => {
  it('P-1: Web の体重目標: 作成され、開始値はプロフィールの体重、user_profiles.target_weight にも反映される', async () => {
    const res = await apiCall<GoalResponse>('POST', '/api/health/goals', owner.jwt, {
      goal_type: 'weight',
      target_value: 60,
      target_unit: 'kg',
      target_date: '2026-12-31',
    });
    expect(res.status).toBe(200);
    expect(res.body.goal?.goal_type).toBe('weight');
    expect(num(res.body.goal?.target_value)).toBe(60);
    expect(num(res.body.goal?.start_value)).toBe(70);
    expect(num(res.body.goal?.current_value)).toBe(70);
    expect(res.body.goal?.status).toBe('active');
    expect(res.body.goal?.user_id).toBe(owner.id);
    expect(num((await profileOf(owner.id)).target_weight as number)).toBe(60);
  });

  it('P-2: Web の体脂肪率目標: 作成され、user_profiles.target_body_fat にも反映される', async () => {
    const res = await apiCall<GoalResponse>('POST', '/api/health/goals', owner.jwt, {
      goal_type: 'body_fat',
      target_value: 18.5,
      target_unit: '%',
      target_date: null,
    });
    expect(res.status).toBe(200);
    expect(num(res.body.goal?.start_value)).toBe(25);
    expect(num((await profileOf(owner.id)).target_body_fat as number)).toBe(18.5);
  });

  it.each([
    ['steps', 10000, '歩'], // Web の歩数
    ['step_count', 8000, '歩'], // 現行モバイルの歩数
    ['sleep_hours', 7.5, '時間'], // 現行モバイルの睡眠時間
  ])('P-3: %s の目標は作成され、プロフィールの値は使われない (開始値なし)', async (goalType, value, unit) => {
    const res = await apiCall<GoalResponse>('POST', '/api/health/goals', owner.jwt, {
      goal_type: goalType,
      target_value: value,
      target_unit: unit,
      target_date: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.goal?.goal_type).toBe(goalType);
    expect(num(res.body.goal?.target_value)).toBe(value);
    expect(res.body.goal?.target_unit).toBe(unit);
    expect(res.body.goal?.start_value).toBeNull();
    expect(res.body.goal?.current_value).toBeNull();
  });

  it('P-4: 範囲の端の値 (体重 20 / 300 kg、睡眠 24 時間) は通る', async () => {
    for (const [goalType, value, unit] of [
      ['weight', 20, 'kg'],
      ['weight', 300, 'kg'],
      ['sleep_hours', 24, '時間'],
    ] as const) {
      const res = await apiCall<GoalResponse>('POST', '/api/health/goals', other.jwt, {
        goal_type: goalType,
        target_value: value,
        target_unit: unit,
      });
      expect(res.status, `${goalType} ${value}`).toBe(200);
    }
  });

  it('P-5: プロフィールの体重が異常値 (負) でも体重の目標は作れる (開始値にしないだけ。DB の検査に当たって 500 にならない)', async () => {
    const res = await apiCall<GoalResponse>('POST', '/api/health/goals', oddProfile.jwt, {
      goal_type: 'weight',
      target_value: 55,
      target_unit: 'kg',
    });
    expect(res.status).toBe(200);
    expect(res.body.goal?.start_value).toBeNull();
    expect(res.body.goal?.current_value).toBeNull();
    // 体脂肪率 0.2% (範囲 1〜70 の外) も同様
    const bodyFat = await apiCall<GoalResponse>('POST', '/api/health/goals', oddProfile.jwt, {
      goal_type: 'body_fat',
      target_value: 15,
      target_unit: '%',
    });
    expect(bodyFat.status).toBe(200);
    expect(bodyFat.body.goal?.start_value).toBeNull();
  });
});

describe('POST /api/health/goals: 受け付けない目標は 400 で、何も保存されない', () => {
  it.each([
    ['goal_type が未知 (旧 AI プロンプトの exercise)', { goal_type: 'exercise', target_value: 3, target_unit: '回' }],
    ['goal_type に空白を含む', { goal_type: 'x y', target_value: 3, target_unit: 'kg' }],
    ['goal_type が大文字', { goal_type: 'Weight', target_value: 60, target_unit: 'kg' }],
    ['goal_type が日本語', { goal_type: '体重', target_value: 60, target_unit: 'kg' }],
    ['体重の目標が負 (issue の例: -50)', { goal_type: 'weight', target_value: -50, target_unit: 'kg' }],
    ['体重の目標が 0', { goal_type: 'weight', target_value: 0, target_unit: 'kg' }],
    ['体重の目標が 300kg 超', { goal_type: 'weight', target_value: 500, target_unit: 'kg' }],
    ['体脂肪率の目標が 70% 超', { goal_type: 'body_fat', target_value: 80, target_unit: '%' }],
    ['歩数の目標が 0', { goal_type: 'steps', target_value: 0, target_unit: '歩' }],
    ['歩数 (step_count) の目標が 100000 超', { goal_type: 'step_count', target_value: 100001, target_unit: '歩' }],
    ['睡眠時間の目標が 24 時間超', { goal_type: 'sleep_hours', target_value: 25, target_unit: '時間' }],
    ['numeric(10,2) を超える値', { goal_type: 'weight', target_value: 1e12, target_unit: 'kg' }],
    ['目標値が数値でない', { goal_type: 'weight', target_value: 'abc', target_unit: 'kg' }],
    ['必須項目 (target_unit) が無い', { goal_type: 'weight', target_value: 60 }],
  ])('N-1: %s', async (_label, body) => {
    const before = (await goalsOf(other.id)).length;
    const res = await apiCall<GoalResponse>('POST', '/api/health/goals', other.jwt, body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect((await goalsOf(other.id)).length).toBe(before);
  });

  it('N-2: 範囲外の値を拒否するとき、プロフィールの目標体重は変わらない', async () => {
    const before = (await profileOf(other.id)).target_weight;
    const res = await apiCall<GoalResponse>('POST', '/api/health/goals', other.jwt, {
      goal_type: 'weight',
      target_value: -50,
      target_unit: 'kg',
    });
    expect(res.status).toBe(400);
    expect((await profileOf(other.id)).target_weight).toEqual(before);
  });

  it('N-3: user_id / status / current_value を本文で指定しても無視される', async () => {
    const res = await apiCall<GoalResponse>('POST', '/api/health/goals', other.jwt, {
      goal_type: 'sleep_hours',
      target_value: 8,
      target_unit: '時間',
      user_id: owner.id,
      status: 'achieved',
      current_value: 3,
    });
    expect(res.status).toBe(200);
    expect(res.body.goal?.user_id).toBe(other.id);
    expect(res.body.goal?.status).toBe('active');
    expect(res.body.goal?.current_value).toBeNull();
  });
});

describe('PUT /api/health/goals/[id]: 更新も目標の種類ごとの範囲で検証する', () => {
  let weightGoalId: string;
  let stepCountGoalId: string;
  let sleepGoalId: string;

  beforeAll(async () => {
    const goals = await goalsOf(owner.id);
    weightGoalId = goals.find((g) => g.goal_type === 'weight')!.id;
    stepCountGoalId = goals.find((g) => g.goal_type === 'step_count')!.id;
    sleepGoalId = goals.find((g) => g.goal_type === 'sleep_hours')!.id;
  });

  it('U-1: 体重の現在値を更新すると進捗率が再計算される (開始 70kg・目標 60kg・現在 65kg → 50%)', async () => {
    const res = await apiCall<GoalResponse>('PUT', `/api/health/goals/${weightGoalId}`, owner.jwt, { current_value: 65 });
    expect(res.status).toBe(200);
    expect(num(res.body.goal?.current_value)).toBe(65);
    expect(num(res.body.goal?.progress_percentage)).toBe(50);
    expect(res.body.goal?.status).toBe('active');
  });

  it('U-2: 目標値を範囲内で変えられる (Web の編集モーダル)', async () => {
    const res = await apiCall<GoalResponse>('PUT', `/api/health/goals/${weightGoalId}`, owner.jwt, {
      target_value: 58.5,
      target_date: '2027-01-31',
    });
    expect(res.status).toBe(200);
    expect(num(res.body.goal?.target_value)).toBe(58.5);
  });

  it('U-3: 歩数 (step_count) の現在値 0 と、睡眠 (sleep_hours) の現在値 0 は有効 (モバイルの「最新値で再計算」)', async () => {
    const steps = await apiCall<GoalResponse>('PUT', `/api/health/goals/${stepCountGoalId}`, owner.jwt, { current_value: 0 });
    expect(steps.status).toBe(200);
    expect(num(steps.body.goal?.current_value)).toBe(0);
    const sleep = await apiCall<GoalResponse>('PUT', `/api/health/goals/${sleepGoalId}`, owner.jwt, { current_value: 0 });
    expect(sleep.status).toBe(200);
  });

  it.each([
    ['体重の目標値を負にする', 'weight', { target_value: -50 }],
    ['体重の目標値を 500 にする', 'weight', { target_value: 500 }],
    ['体重の現在値を負にする', 'weight', { current_value: -1 }],
    ['体重の現在値を 0 にする (体重 0kg は計測値にならない)', 'weight', { current_value: 0 }],
    ['歩数の目標値を 0 にする', 'step_count', { target_value: 0 }],
    ['歩数の現在値を負にする', 'step_count', { current_value: -1 }],
    ['睡眠の目標値を 25 時間にする', 'sleep_hours', { target_value: 25 }],
    ['睡眠の現在値を 24.5 時間にする', 'sleep_hours', { current_value: 24.5 }],
  ])('N-4: %s と 400 になり、行は変わらない', async (_label, goalType, body) => {
    const id = { weight: weightGoalId, step_count: stepCountGoalId, sleep_hours: sleepGoalId }[goalType]!;
    const before = (await goalsOf(owner.id)).find((g) => g.id === id);
    const res = await apiCall<GoalResponse>('PUT', `/api/health/goals/${id}`, owner.jwt, body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect((await goalsOf(owner.id)).find((g) => g.id === id)).toEqual(before);
  });

  it('N-5: 他人の目標は 404 で、範囲内の値でも更新できない', async () => {
    const before = (await goalsOf(owner.id)).find((g) => g.id === weightGoalId);
    const res = await apiCall<GoalResponse>('PUT', `/api/health/goals/${weightGoalId}`, other.jwt, { target_value: 50 });
    expect(res.status).toBe(404);
    expect((await goalsOf(owner.id)).find((g) => g.id === weightGoalId)).toEqual(before);
  });

  it('N-6: 未ログインは 401', async () => {
    const post = await apiCall('POST', '/api/health/goals', null, { goal_type: 'weight', target_value: 60, target_unit: 'kg' });
    expect(post.status).toBe(401);
    const put = await apiCall('PUT', `/api/health/goals/${weightGoalId}`, null, { target_value: 60 });
    expect(put.status).toBe(401);
  });
});

describe('保存された目標はどれも DB の検査を満たす', () => {
  it('D-1: テストで作った目標すべてで target_value > 0、current_value は NULL か 0 以上、goal_type は形式どおり', async () => {
    const all = (await Promise.all(createdUserIds.map(goalsOf))).flat();
    expect(all.length).toBeGreaterThan(0);
    for (const g of all) {
      expect(Number(g.target_value), `${g.goal_type} target`).toBeGreaterThan(0);
      if (g.current_value !== null) expect(Number(g.current_value), `${g.goal_type} current`).toBeGreaterThanOrEqual(0);
      expect(g.goal_type).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
    }
  });
});

// 本番に既にあるかもしれない「新しい検査に違反した行」。DB の検査が CHECK 制約だと、この行は
// どの列を更新しても 23514 で失敗し、PUT が 500 になる (画面の更新が止まる)。検査トリガーは書き込む値だけを見る。
// このブロックは D-1 より後に置く (D-1 は、このテストで作った行がすべて検査を満たすことを確かめるため)。
describe('PUT /api/health/goals/[id]: 違反している既存の行 (本番に既にあるかもしれない行)', () => {
  const LEGACY_NOTE = `sec-legacy-${TS}`;
  let legacyUser: TestUser;
  let legacyId: string;

  const readLegacy = async () => (await goalsOf(legacyUser.id)).find((g) => g.id === legacyId)!;

  beforeAll(async () => {
    legacyUser = await createUser('legacy', { weight: 70 });
    // 検査トリガーを同じトランザクションの中だけ止めて、違反した行 (体重の目標 -50・現在値 -3) を入れる。
    // トランザクションの途中は他の接続から見えず、COMMIT の前に有効へ戻す
    const rows = await pgQuery<{ id: string }>(`
      ALTER TABLE public.health_goals DISABLE TRIGGER trg_health_goals_validate_values;
      INSERT INTO public.health_goals (user_id, goal_type, target_value, target_unit, current_value, note)
      VALUES ('${legacyUser.id}', 'weight', -50, 'kg', -3, '${LEGACY_NOTE}');
      ALTER TABLE public.health_goals ENABLE TRIGGER trg_health_goals_validate_values;
      SELECT id FROM public.health_goals WHERE note = '${LEGACY_NOTE}';
    `);
    expect(rows).toHaveLength(1);
    legacyId = rows[0].id;
  }, 60_000);

  it('LG-0: 準備: 目標値 -50・現在値 -3 の体重の目標が入っている', async () => {
    const row = await readLegacy();
    expect(num(row.target_value)).toBe(-50);
    expect(num(row.current_value)).toBe(-3);
  });

  it('LG-1: 目標日・単位・メモだけの更新は 200 で、違反している値は変わらない', async () => {
    for (const body of [{ target_date: '2027-03-31' }, { target_unit: 'kg' }, { note: `${LEGACY_NOTE}-edited` }]) {
      const res = await apiCall<GoalResponse>('PUT', `/api/health/goals/${legacyId}`, legacyUser.jwt, body);
      expect(res.status, JSON.stringify(body)).toBe(200);
    }
    const row = await readLegacy();
    expect(num(row.target_value)).toBe(-50);
    expect(num(row.current_value)).toBe(-3);
  });

  it('LG-2: 現在値を範囲内の値に更新できる (目標値は違反したままでも、書き換えない列は検査されない)', async () => {
    const res = await apiCall<GoalResponse>('PUT', `/api/health/goals/${legacyId}`, legacyUser.jwt, { current_value: 65 });
    expect(res.status).toBe(200);
    const row = await readLegacy();
    expect(num(row.current_value)).toBe(65);
    expect(num(row.target_value)).toBe(-50);
  });

  it('LG-3: 違反した値への変更は、API が先に 400 で返し、行は変わらない', async () => {
    const before = await readLegacy();
    const res = await apiCall<GoalResponse>('PUT', `/api/health/goals/${legacyId}`, legacyUser.jwt, { target_value: -60 });
    expect(res.status).toBe(400);
    expect(await readLegacy()).toEqual(before);
  });

  it('LG-4: 目標値を範囲内の値に直せる', async () => {
    const res = await apiCall<GoalResponse>('PUT', `/api/health/goals/${legacyId}`, legacyUser.jwt, { target_value: 60 });
    expect(res.status).toBe(200);
    expect(num((await readLegacy()).target_value)).toBe(60);
  });
});
