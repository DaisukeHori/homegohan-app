/**
 * #2025 の続き (#121 の CAS を戻す): 写真の解析 (analyze-meal-photo の mealId の経路) の書き込みの順序の守りを、本物の PostgREST で確かめる。
 *
 * 守り方は supabase/functions/_shared/meal-photo-cas.ts の注:
 *   1. 解析の前に claimPhotoAnalysis で行に印を付ける (updated_at を進める。invokedAt があれば updated_at が invokedAt 以前 / NULL のときだけ)
 *   2. 解析のあと isPhotoAnalysisCurrent で updated_at が印のままかを見る
 *   3. analyze-meal-photo/index.ts の update は .eq('id', mealId).eq('updated_at', 印).select('id') で、0 行なら書かない
 * 単体テスト (tests/analyze-meal-photo-cas.test.ts) は作り物の DB で順序を見る。ここでは作り物では分からないこと
 * (印を付けた update が行を返すこと (PostgREST は or の条件を返す行にも当て直すので、or を使うと書けていても 0 行になる)・
 * timestamptz の文字列の一致・トリガー trg_planned_meals_updated_at が印の update でも updated_at を進めること・NULL の updated_at) を、
 * ローカルの Supabase で見る。3 の update は index.ts と同じ形をここで組む (index.ts が同じ形を使うことは
 * 単体テストの PC-6 が見る)。
 *
 * 確かめること (P-n はこのファイルの it の番号):
 *   - P-1: invokedAt が行の updated_at より後なら印が付き、印は進んだあとの updated_at (DB の時刻) と同じ文字列
 *   - P-2: invokedAt が行の updated_at より前なら印が付かず (superseded)、行は変わらない
 *   - P-3: 2 本の解析 (A のあとに B が印を付けた) は、書く順番によらず B だけが書ける
 *   - P-4: updated_at が NULL の行でも、invokedAt つきで印が付く
 *   - P-5: 印のままなら isPhotoAnalysisCurrent は true、ほかの書き込みのあとは false
 *   - P-6: invokedAt が無いときは、行の updated_at によらず印が付く
 *
 * 前提: ローカル Supabase (scripts/supabase-local.sh)。Next の開発サーバーは要らない。
 *   bash scripts/supabase-local.sh start && bash scripts/supabase-local.sh env .env.local
 *   npx vitest run --config vitest.integration.config.ts tests/integration/rls/planned-meals-photo-analysis-cas.test.ts
 * 本番には接続しない。
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimPhotoAnalysis,
  isPhotoAnalysisCurrent,
  type PhotoAnalysisClaim,
} from '../../../supabase/functions/_shared/meal-photo-cas';
import { adminClient } from '../helpers/supabase';

const srAdmin = adminClient();

const TABLE = 'planned_meals';
/** 献立の日 (どの日でもよい) */
const DAY_DATE = '2026-01-12';
/** 結合テストの準備と後片付けの時間の上限 (ミリ秒) */
const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;
/** invokedAt を行の updated_at の前後にずらす幅 (ミリ秒。1 ミリ秒でも前後が決まる) */
const SHIFT_MS = 1;

const RUN = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const PASSWORD = `${randomBytes(18).toString('base64url')}Aa1!`;
let userId = '';
let dayId = '';
let seq = 0;

async function seedMeal(label: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await srAdmin
    .from(TABLE)
    .insert({ daily_meal_id: dayId, meal_type: 'dinner', dish_name: `photo-cas-${label}-${++seq}`, ...extra })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed ${TABLE} ${label}: ${error?.message}`);
  return data.id as string;
}

async function mealRow(id: string): Promise<{ dish_name: string; updated_at: string | null }> {
  const { data, error } = await srAdmin.from(TABLE).select('dish_name, updated_at').eq('id', id).single();
  if (error || !data) throw new Error(`read ${TABLE}: ${error?.message}`);
  return data as { dish_name: string; updated_at: string | null };
}

/** 行の updated_at から ms だけずらした時刻 (invokedAt の代わり) */
function shifted(updatedAt: string | null, ms: number): string {
  if (updatedAt === null) throw new Error('updated_at が NULL');
  return new Date(Date.parse(updatedAt) + ms).toISOString();
}

function tokenOf(claim: PhotoAnalysisClaim): string {
  if (claim.status !== 'claimed') throw new Error('印が付かなかった');
  return claim.token;
}

/** analyze-meal-photo/index.ts の写真の結果の書き込みと同じ形 (updated_at が印のままの行にだけ書く) */
async function writePhotoResult(mealId: string, token: string, dishName: string): Promise<number> {
  const { data, error } = await srAdmin
    .from(TABLE)
    .update({ dish_name: dishName, updated_at: new Date().toISOString() })
    .eq('id', mealId)
    .eq('updated_at', token)
    .select('id');
  if (error) throw new Error(`write ${TABLE}: ${error.message}`);
  return (data ?? []).length;
}

beforeAll(async () => {
  const email = `photo-cas-${RUN}@homegohan.test`;
  const { data, error } = await srAdmin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;
  const day = await srAdmin.from('user_daily_meals').insert({ user_id: userId, day_date: DAY_DATE }).select('id').single();
  if (day.error || !day.data) throw new Error(`seed user_daily_meals: ${day.error?.message}`);
  dayId = day.data.id as string;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  if (!userId) return;
  await srAdmin.from('user_daily_meals').delete().eq('user_id', userId);
  await srAdmin.auth.admin.deleteUser(userId);
}, SETUP_TIMEOUT_MS);

describe('写真の解析の書き込みの順序の守り (#121 の CAS・#2025 の続き)', () => {
  it('P-1: invokedAt が updated_at より後なら印が付き、印は進んだあとの updated_at と同じ', async () => {
    const mealId = await seedMeal('p1');
    const before = await mealRow(mealId);
    const claim = await claimPhotoAnalysis(srAdmin, { mealId, invokedAt: shifted(before.updated_at, SHIFT_MS) });
    const token = tokenOf(claim);
    const after = await mealRow(mealId);
    expect(token).toBe(after.updated_at);
    expect(Date.parse(token)).toBeGreaterThan(Date.parse(String(before.updated_at)));
    expect(after.dish_name).toBe(before.dish_name);
  }, TEST_TIMEOUT_MS);

  it('P-2: invokedAt が updated_at より前なら印が付かず、行は変わらない', async () => {
    const mealId = await seedMeal('p2');
    const before = await mealRow(mealId);
    const claim = await claimPhotoAnalysis(srAdmin, { mealId, invokedAt: shifted(before.updated_at, -SHIFT_MS) });
    expect(claim).toEqual({ status: 'superseded' });
    expect(await mealRow(mealId)).toEqual(before);
  }, TEST_TIMEOUT_MS);

  it.each([
    ['先に送った A が先に書こうとする', ['A', 'B']],
    ['後に送った B が先に書く', ['B', 'A']],
  ] as const)('P-3: 2 本の解析は、書く順番によらず後に印を付けた B だけが書ける (%s)', async (_label, order) => {
    const mealId = await seedMeal(`p3-${order.join('')}`);
    const initial = await mealRow(mealId);
    const tokenA = tokenOf(await claimPhotoAnalysis(srAdmin, { mealId, invokedAt: shifted(initial.updated_at, SHIFT_MS) }));
    const tokenB = tokenOf(await claimPhotoAnalysis(srAdmin, { mealId, invokedAt: shifted(tokenA, SHIFT_MS) }));
    const tokens = { A: tokenA, B: tokenB };
    const written: Record<string, number> = {};
    for (const who of order) written[who] = await writePhotoResult(mealId, tokens[who], `photo-${who}`);
    expect(written).toEqual({ A: 0, B: 1 });
    expect((await mealRow(mealId)).dish_name).toBe('photo-B');
  }, TEST_TIMEOUT_MS);

  it('P-4: updated_at が NULL の行でも、invokedAt つきで印が付く', async () => {
    const mealId = await seedMeal('p4', { updated_at: null });
    expect((await mealRow(mealId)).updated_at).toBeNull();
    const token = tokenOf(await claimPhotoAnalysis(srAdmin, { mealId, invokedAt: new Date().toISOString() }));
    expect((await mealRow(mealId)).updated_at).toBe(token);
    expect(await writePhotoResult(mealId, token, 'photo-null')).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('P-5: 印のままなら isPhotoAnalysisCurrent は true、ほかの書き込みのあとは false', async () => {
    const mealId = await seedMeal('p5');
    const before = await mealRow(mealId);
    const token = tokenOf(await claimPhotoAnalysis(srAdmin, { mealId, invokedAt: shifted(before.updated_at, SHIFT_MS) }));
    expect(await isPhotoAnalysisCurrent(srAdmin, { mealId, token })).toBe(true);
    // ほかの書き手 (画面の編集など)。トリガーが updated_at を進める
    const other = await srAdmin.from(TABLE).update({ memo: 'edited' }).eq('id', mealId);
    expect(other.error).toBeNull();
    expect(await isPhotoAnalysisCurrent(srAdmin, { mealId, token })).toBe(false);
    expect(await writePhotoResult(mealId, token, 'photo-late')).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('P-6: invokedAt が無ければ、行の updated_at によらず印が付く', async () => {
    const mealId = await seedMeal('p6');
    const before = await mealRow(mealId);
    const token = tokenOf(await claimPhotoAnalysis(srAdmin, { mealId, invokedAt: null }));
    expect(Date.parse(token)).toBeGreaterThan(Date.parse(String(before.updated_at)));
  }, TEST_TIMEOUT_MS);
});
