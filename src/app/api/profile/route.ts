import { createClient } from '@/lib/supabase/server'
import { createLogger, generateRequestId } from '@/lib/db-logger'
import { internalError } from '@/lib/api/errors'
import { NextResponse } from 'next/server'
import { fromUserProfile } from '@/lib/converter'
import { calculateNutritionTargets } from '@homegohan/core'
import { buildNutritionCalculatorInput } from '@/lib/build-nutrition-input'
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character'
import { API_INVALID_JSON_MESSAGE, API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses'
import { PROFILE_NAME_PLACEHOLDER } from '@homegohan/shared'
import { USER_PROFILE_POST_FIELDS, UserProfilePostBodySchema, UserProfileUpdateBodySchema } from '@/lib/profile-update-schema'
import { syncProfileCompletenessOfRow } from '@/lib/profile-completeness'
import type { DbUserProfile } from '@/types/database'

/**
 * プロフィールAPI
 * 
 * 栄養目標に影響するフィールドの更新時は自動で再計算を行う
 * （auto_calculate=true のユーザーのみ）
 */

// 栄養目標の再計算をトリガーするフィールド
const NUTRITION_TRIGGER_FIELDS = [
  'age', 'gender', 'height', 'weight',
  'work_style', 'exercise_intensity', 'exercise_frequency', 'exercise_duration_per_session',
  'nutrition_goal', 'weight_change_rate',
  'health_conditions', 'medications', 'pregnancy_status',
];

// 年代 (age_group) の刻み。年齢を 10 年ごとに切り捨てて '30s' のような値にする
const AGE_GROUP_DECADE_YEARS = 10;

/**
 * POST で行がまだ無いときの insert に入れる仮置きの値。nickname・age_group・gender は NOT NULL で列の既定が無いため。
 * 行が既にあるときは入れない (本文に無い欄を上書きしない。#2178 Y1-a)
 */
const USER_PROFILE_INSERT_PLACEHOLDERS = {
  nickname: PROFILE_NAME_PLACEHOLDER,
  age_group: 'unspecified',
  gender: 'unspecified',
} as const;

/** 一意の制約の違反 (同じ id の行を同時に insert したとき。後から来た方は update に回す) */
const PG_UNIQUE_VIOLATION = '23505';

// snake_case → camelCase のマッピング
const FIELD_MAP: Record<string, string> = {
  nutritionGoal: 'nutrition_goal',
  weightChangeRate: 'weight_change_rate',
  exerciseFrequency: 'exercise_frequency',
  exerciseIntensity: 'exercise_intensity',
  exerciseDurationPerSession: 'exercise_duration_per_session',
  workStyle: 'work_style',
  healthConditions: 'health_conditions',
  pregnancyStatus: 'pregnancy_status',
};

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (error) {
      return internalError('GET /api/profile', error, { userId: user.id, table: 'user_profiles' })
    }

    return NextResponse.json(data)
  } catch (error: unknown) {
    return internalError('GET /api/profile', error)
  }
}

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request)
  if (nullCharacterRejection) return nullCharacterRejection
  const requestId = generateRequestId()
  const logger = createLogger('POST /api/profile', requestId)
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    // 本文が JSON として読めない (壊れた JSON・オブジェクトでない) ときは 400。route 全体の catch に流して 500 にしない (#1917)
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 })
    }
    
    // 本文の欄の値が写す先の列の型に合わない (配列の列に文字列・integer の列に文字列や小数など) ときは 400。
    // 検査しないと DB の書き込みで拒まれて internalError の 500 になる (#2178 Y1-a。欄と型は src/lib/profile-update-schema.ts の USER_PROFILE_POST_FIELDS)
    const parsed = UserProfilePostBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 })
    }

    // 本文にある欄だけを列に写す (値が空 (null・空文字・0・false) の欄は今までどおり書かない)
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    for (const [field, { column }] of Object.entries(USER_PROFILE_POST_FIELDS)) {
      const value = parsed.data[field];
      if (value) updates[column] = value;
    }
    // 年齢から年代を入れる (age は上の検査で integer の範囲の整数)
    if (typeof updates.age === 'number') {
      updates.age_group = `${Math.floor(updates.age / AGE_GROUP_DECADE_YEARS) * AGE_GROUP_DECADE_YEARS}s`;
    }

    // 行があれば本文の欄だけを update する。仮置きの値 (USER_PROFILE_INSERT_PLACEHOLDERS) は行が無いときの insert にだけ入れる。
    // 以前は仮置きの値を補ってから upsert していたため、週間献立の画面が { servingsConfig } だけを送ると、既存の行の
    // nickname が 'Guest' に、gender・age_group が 'unspecified' に上書きされていた (#2178 Y1-a)
    const { data, error } = await writeProfileFromPost(supabase, user.id, updates)

    if (error) {
      return internalError('POST /api/profile', error, { userId: user.id, requestId, table: 'user_profiles' })
    }

    // 書いた後の行から完成度を計算し直し、変わっていれば書く (POST も完成度に数える欄 (身長・体重・目標など) を書く。#2201 U4)
    const profileRow = await syncProfileCompletenessOfWrite(supabase, user.id, data, logger)

    // 栄養目標に影響するフィールドが更新された場合、再計算を試みる
    const shouldRecalculate = checkShouldRecalculateNutrition(body);
    if (shouldRecalculate) {
      await recalculateNutritionTargetsIfNeeded(supabase, user.id, profileRow, logger);
    }

    return NextResponse.json(profileRow)
  } catch (error: unknown) {
    return internalError('POST /api/profile', error, { requestId })
  }
}

export async function PUT(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request)
  if (nullCharacterRejection) return nullCharacterRejection
  const requestId = generateRequestId()
  const logger = createLogger('PUT /api/profile', requestId)
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 })
    }

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    // JSON としては読めてもオブジェクトでない本文 (null・配列・数・文字列) も 400 (#1917 の続き。null は下の body.age の読み出しで
    // 例外になり 500 に、配列は項目の無い更新になっていた)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }
    // 更新できる欄の値が写す先の列の型に合わない (boolean の列に文字列・integer の列に小数・NOT NULL の列に null など) ときも 400。
    // 検査しないと DB の書き込みで拒まれて internalError の 500 になる (#2166 X7。欄と型は src/lib/profile-update-schema.ts)
    if (!UserProfileUpdateBodySchema.safeParse(body).success) {
      return NextResponse.json({ error: API_INVALID_JSON_MESSAGE }, { status: 400 });
    }

    // fromUserProfile を使用して camelCase -> snake_case 変換
    const updates = fromUserProfile(body);

    // 年齢から年代を自動計算 (age は上の検査で integer の範囲の整数か null)
    const age = body.age;
    if (typeof age === 'number' && age !== 0 && !body.ageGroup) {
      updates.age_group = `${Math.floor(age / AGE_GROUP_DECADE_YEARS) * AGE_GROUP_DECADE_YEARS}s`;
    }
    
    // プロフィールの完成度は本文ではなく書いた後の行から数える (下の syncProfileCompletenessOfRow。#2201 U4)。
    // 本文から数えると、目標の体重だけを送る栄養の目標の画面 (NutritionTargetPlanner) の PUT で、ほかの欄が埋まっていても
    // 完成度が目標の体重の分 (5) だけになり、ほかの経路が書いた後の行から直した値を上書きしていた。
    // 本文の profileCompleteness (画面が GET の値を送り返したもの) は書かない (サーバーが計算する欄)
    delete updates.profile_completeness;
    updates.last_profile_update = new Date().toISOString();

    const { data, error } = await supabase
      .from('user_profiles')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)
      .select()
      .single()

    if (error) {
      return internalError('PUT /api/profile', error, { userId: user.id, requestId, table: 'user_profiles' })
    }

    // 書いた後の行から完成度を計算し直し、変わっていれば書く (POST・health の records / quick / goals・AI 相談と同じ。#2201 U4)
    const profileRow = await syncProfileCompletenessOfWrite(supabase, user.id, data, logger)

    // 栄養目標に影響するフィールドが更新された場合、再計算を試みる
    const shouldRecalculate = checkShouldRecalculateNutrition(body);
    if (shouldRecalculate) {
      await recalculateNutritionTargetsIfNeeded(supabase, user.id, profileRow, logger);
    }

    return NextResponse.json(profileRow)
  } catch (error: unknown) {
    return internalError('PUT /api/profile', error, { requestId })
  }
}

type ProfileWriteResult = { data: Partial<DbUserProfile> | null; error: { code?: string } | null };

/**
 * PUT・POST の書き込みが返した行 (書いた後の行) から完成度を計算し直し、変わっていれば profile_completeness を書く (#2201 U4)。
 * 返すのは応答に返す行 (書けたときは新しい完成度を入れた行)。行が無いとき・一度も書けずに失敗したときは、渡した行のまま返す。
 * 一度書けた後に失敗したときは、完成度を最後に分かった DB の値にした行を返す (syncProfileCompletenessOfRow。#2227 H4)。
 * 欄の書き込みそのものは成功として扱い、失敗はログに残す (完成度は次の書き込みで直る)
 */
async function syncProfileCompletenessOfWrite(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  row: Partial<DbUserProfile> | null,
  logger: ReturnType<typeof createLogger>,
): Promise<Partial<DbUserProfile> | null> {
  if (!row) return row
  const { row: syncedRow, outcome } = await syncProfileCompletenessOfRow(supabase, userId, row)
  if (outcome.status === 'error') logger.error('Profile completeness sync error', outcome.error)
  return syncedRow
}

/**
 * POST の書き込み。行があれば本文の欄だけを update し、無ければ仮置きの値を補って insert する。
 * 行の有無を読んでから insert するまでの間に別のリクエストが行を作った (一意の制約の違反) ときは update に回す
 */
async function writeProfileFromPost(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  updates: Record<string, unknown>,
): Promise<ProfileWriteResult> {
  const updateExisting = async (): Promise<ProfileWriteResult> =>
    await supabase.from('user_profiles').update(updates).eq('id', userId).select().single();

  const { data: existing, error: readError } = await supabase
    .from('user_profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (readError) return { data: null, error: readError };
  if (existing) return updateExisting();

  const inserted: ProfileWriteResult = await supabase
    .from('user_profiles')
    .insert({ ...USER_PROFILE_INSERT_PLACEHOLDERS, ...updates, id: userId })
    .select()
    .single();
  if (inserted.error?.code === PG_UNIQUE_VIOLATION) return updateExisting();
  return inserted;
}

/**
 * リクエストボディに栄養目標に影響するフィールドが含まれているかチェック
 */
function checkShouldRecalculateNutrition(body: Record<string, unknown>): boolean {
  for (const key of Object.keys(body)) {
    const snakeKey = FIELD_MAP[key] || key;
    if (NUTRITION_TRIGGER_FIELDS.includes(snakeKey)) {
      return true;
    }
  }
  return false;
}

/**
 * 栄養目標を再計算する（auto_calculate=true の場合のみ）
 */
async function recalculateNutritionTargetsIfNeeded(
  supabase: any,
  userId: string,
  profile: any,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    // 現在の栄養目標を取得
    const { data: targets } = await supabase
      .from('nutrition_targets')
      .select('auto_calculate')
      .eq('user_id', userId)
      .single();

    // auto_calculate=false（手動編集）の場合はスキップ
    if (targets && targets.auto_calculate === false) {
      return;
    }

    // 共通ヘルパーで入力を組み立て（4ルート一致保証）
    const calculatorInput = buildNutritionCalculatorInput(profile, userId);
    const { targetData } = calculateNutritionTargets(calculatorInput);

    // 既存レコードがあるか確認
    const { data: existing } = await supabase
      .from('nutrition_targets')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (existing) {
      await supabase
        .from('nutrition_targets')
        .update(targetData)
        .eq('user_id', userId);
    } else {
      await supabase
        .from('nutrition_targets')
        .insert(targetData);
    }
  } catch (error) {
    // エラーはログのみ（プロフィール更新自体は成功させる）
    logger.error('Nutrition targets recalculation error', error);
  }
}
