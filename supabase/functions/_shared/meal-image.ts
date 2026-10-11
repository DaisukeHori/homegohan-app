type MealImageSource = 'generated_ai' | 'meal_photo' | 'manual_override' | 'catalog' | 'none';
type MealImageStatus = 'pending' | 'ready' | 'failed' | 'stale';

export interface MealImageDish {
  name?: string | null;
  role?: string | null;
  ingredient?: string | null;
  ingredients?: string[] | null;
  displayOrder?: number | null;
  image_url?: string | null;
  image_source?: MealImageSource | null;
  image_status?: MealImageStatus | null;
  image_prompt?: string | null;
  image_model?: string | null;
  image_subject_hash?: string | null;
  image_generated_at?: string | null;
  image_error?: string | null;
  [key: string]: unknown;
}

export interface MealImageJobSeed {
  dishIndex: number;
  dishName: string;
  subjectHash: string;
  prompt: string;
  model: string;
  triggerSource: string;
  referenceImageUrls: string[];
}

export interface ReconcileDishImagesParams<TDish extends MealImageDish> {
  previousDishes?: TDish[] | null;
  nextDishes?: TDish[] | null;
  model?: string | null;
  triggerSource: string;
  fallbackMealImageUrl?: string | null;
}

export interface ReconcileDishImagesResult<TDish extends MealImageDish> {
  dishes: TDish[];
  jobs: MealImageJobSeed[];
  mealCoverImageUrl: string | null;
}

export const DEFAULT_MEAL_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

/**
 * 料理画像のジョブを積まずに見送ったときの理由 (#1487)。
 *   - ai_limit:   料理画像の安全弁 (DB の ai_unmetered_daily_caps の meal_image_auto) に達した (consumeAiUsage が不許可)
 *   - rate_limit: 画像のレート制限 (checkRateLimit の 'image') に達した、または判定が例外で終わった
 */
export type MealImageSkipReason = 'ai_limit' | 'rate_limit';

/**
 * 見送った料理に書く image_error (#1487)。image_status は既存の 'failed' を使う
 * (新しい状態を足すと、'failed' 以外を「生成中」と出す画面・型の受け口をすべて直す必要があるため。
 *  料理画像の処理 (process-meal-image-jobs) も、同意が無くて送らなかったときは 'failed' + 理由を書く)。
 * 'failed' のまま image_url の無い料理は、同じ料理を保存し直すとジョブを積み直す (reconcileDishImages の needsImageRetry)
 */
export const MEAL_IMAGE_SKIPPED_ERRORS: Readonly<Record<MealImageSkipReason, string>> = Object.freeze({
  ai_limit: 'skipped_ai_limit',
  rate_limit: 'skipped_rate_limit',
});

/** image_error が、見送り (MEAL_IMAGE_SKIPPED_ERRORS) を表すか */
export function isMealImageSkippedError(value: unknown): boolean {
  return typeof value === 'string' && Object.values(MEAL_IMAGE_SKIPPED_ERRORS).includes(value);
}

/**
 * 同じ料理 (subject_hash が同じ) を保存し直したとき、ジョブを積み直すか (#1487)。
 * 画像がまだ無く (image_url なし)、AI が作る画像 (image_source が generated_ai か未設定) で、
 * 前回の状態が待ち・更新待ち・失敗 (または未設定) のとき。
 * 写真 (meal_photo)・手で付けた画像 (manual_override)・商品 (catalog) は積まない
 * (写真から作った複数の料理は 'stale' のまま画像を作らないのが今の扱い)。
 * 待ちのジョブがまだ残っているときは、同じ冪等キーで積もうとして積まれない (enqueueMealImageJobs が重複として数えない)
 */
export function needsImageRetry(dish: MealImageDish): boolean {
  if (dish.image_url) return false;
  const source = dish.image_source ?? null;
  if (source !== null && source !== 'generated_ai') return false;
  const status = dish.image_status ?? null;
  return status === null || status === 'pending' || status === 'stale' || status === 'failed';
}

/**
 * ジョブを積まないと決まった料理 (jobs の dishIndex) を、見送りの状態 ('failed' + 理由) にする (#1487)。
 * 料理を保存する前に呼ぶ ('pending' のまま保存すると、処理するジョブが無いので「生成中」のまま残る)。
 * 渡した配列は変えず、新しい配列を返す
 */
export function markDishImagesSkipped<TDish extends MealImageDish>(
  dishes: TDish[],
  jobs: ReadonlyArray<Pick<MealImageJobSeed, 'dishIndex'>>,
  reason: MealImageSkipReason,
): TDish[] {
  const targets = new Set(jobs.map((job) => job.dishIndex));
  return dishes.map((dish, index) => {
    if (!targets.has(index)) return dish;
    const skipped: TDish = {
      ...dish,
      image_status: 'failed',
      image_error: MEAL_IMAGE_SKIPPED_ERRORS[reason],
      image_generated_at: null,
    };
    return skipped;
  });
}

// ---------------------------------------------------------------------------
// 料理画像のジョブの積み方 (#1487 / #1505)。Next.js (lib/meal-image-jobs.ts) と Edge Function (./meal-image-jobs.ts) で共用する。
// このファイルは Next.js からも読まれる (lib/meal-image.ts) ので、ここには import を足さない (拡張子 .ts 付きの import は Next.js の型検査が通らない)。
// ---------------------------------------------------------------------------

/**
 * 一意制約の違反 (PostgreSQL の SQLSTATE)。meal_image_jobs の冪等キーの一意な索引
 * (meal_image_jobs_idempotency_pending_idx) は、待ち・処理中 (status が pending / processing) の行だけが対象の部分索引
 */
export const MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE = '23505';

/**
 * ジョブを積めなかった (書き込みの失敗) 料理に書く image_error (#1505)。image_status は 'failed'。
 * 画面は見送り (MEAL_IMAGE_SKIPPED_ERRORS) ではない失敗として「画像生成に失敗しました」と出す。
 * 'failed' のまま image_url の無い料理は、同じ料理を保存し直すとジョブを積み直す (needsImageRetry)
 */
export const MEAL_IMAGE_ENQUEUE_FAILED_ERROR = 'enqueue_failed';

/** meal_image_jobs に insert する 1 行。priority・created_at・updated_at は列の既定値 (100・now()) に任せる */
export interface MealImageJobRecord {
  planned_meal_id: string;
  user_id: string;
  dish_index: number;
  job_kind: 'dish';
  subject_hash: string;
  idempotency_key: string;
  prompt: string;
  model: string;
  reference_image_urls: string[];
  trigger_source: string;
  request_id: string | null;
  status: 'pending';
}

/** 書き込みのエラー (PostgREST のエラーのうち、ここで見るもの) */
export interface MealImageJobWriteError {
  code?: string | null;
  message?: string | null;
}

/** 行ごとの結果 */
export type MealImageJobInsertOutcome =
  | { kind: 'inserted'; dishIndex: number; subjectHash: string }
  | { kind: 'duplicate'; dishIndex: number; subjectHash: string }
  | { kind: 'failed'; dishIndex: number; subjectHash: string; code: string | null; message: string };

/** enqueueMealImageJobs の結果 (#1487)。行ごとに数える */
export interface EnqueueMealImageJobsResult {
  /** 新しく積めた行 */
  inserted: number;
  /** 同じ料理の待ち・処理中のジョブがすでにあって積まなかった行 (冪等キーの重複) */
  duplicates: number;
  /** 書き込みに失敗した行 (権限・接続・値の不正など) */
  failed: number;
}

/**
 * 積む行を作る。trigger_source は triggerSource を渡せばそれを、無ければジョブの triggerSource を使う
 */
export async function buildMealImageJobRecords(params: {
  plannedMealId: string;
  userId: string;
  seeds: ReadonlyArray<MealImageJobSeed>;
  triggerSource?: string | null;
  requestId?: string | null;
}): Promise<MealImageJobRecord[]> {
  return Promise.all(
    params.seeds.map(async (seed): Promise<MealImageJobRecord> => ({
      planned_meal_id: params.plannedMealId,
      user_id: params.userId,
      dish_index: seed.dishIndex,
      job_kind: 'dish',
      subject_hash: seed.subjectHash,
      idempotency_key: await buildMealImageIdempotencyKey({
        plannedMealId: params.plannedMealId,
        dishIndex: seed.dishIndex,
        subjectHash: seed.subjectHash,
      }),
      prompt: seed.prompt,
      model: seed.model,
      reference_image_urls: seed.referenceImageUrls ?? [],
      trigger_source: params.triggerSource ?? seed.triggerSource,
      request_id: params.requestId ?? null,
      status: 'pending',
    })),
  );
}

/**
 * 行ごとに insert し、積めた・重複・失敗を返す。例外は投げない (insertJob の例外も失敗として返す)。
 *
 * 1 回の upsert (onConflict: 'idempotency_key', ignoreDuplicates) にしない理由 (#1487 / #1505):
 * 冪等キーの一意な索引は部分索引 (WHERE status IN ('pending','processing')) なので、PostgREST の on_conflict が作る
 * ON CONFLICT (idempotency_key) は索引を推論できず、42P10 で必ず失敗する (行が 1 つも積まれない)。
 * 部分索引のままにするのは、失敗・取り消し・完了したジョブと同じ料理を、あとで積み直せるようにするため。
 * そのため行ごとに insert し、一意制約の違反 (23505) は「同じ料理のジョブが待ち・処理中」として重複に数える。
 */
export async function insertMealImageJobRecords(
  records: ReadonlyArray<MealImageJobRecord>,
  insertJob: (record: MealImageJobRecord) => PromiseLike<{ error: MealImageJobWriteError | null }>,
): Promise<MealImageJobInsertOutcome[]> {
  return Promise.all(
    records.map(async (record): Promise<MealImageJobInsertOutcome> => {
      const base = { dishIndex: record.dish_index, subjectHash: record.subject_hash };
      try {
        const { error } = await insertJob(record);
        if (!error) return { kind: 'inserted', ...base };
        if (error.code === MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE) return { kind: 'duplicate', ...base };
        return { kind: 'failed', ...base, code: error.code ?? null, message: error.message ?? 'unknown error' };
      } catch (error) {
        return { kind: 'failed', ...base, code: null, message: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

/** 行ごとの結果を数える */
export function summarizeMealImageJobOutcomes(outcomes: ReadonlyArray<MealImageJobInsertOutcome>): EnqueueMealImageJobsResult {
  const result: EnqueueMealImageJobsResult = { inserted: 0, duplicates: 0, failed: 0 };
  for (const outcome of outcomes) {
    if (outcome.kind === 'inserted') result.inserted += 1;
    else if (outcome.kind === 'duplicate') result.duplicates += 1;
    else result.failed += 1;
  }
  return result;
}

/**
 * ジョブを積めなかった (書き込みの失敗) 料理を 'failed' + MEAL_IMAGE_ENQUEUE_FAILED_ERROR にする (#1505)。
 * 料理は保存したあとなので、'pending' のまま残すと処理するジョブが無く「生成中」のまま残る。
 * 変えるのは、同じ料理 (image_subject_hash が積もうとしたジョブと同じ) で、画像がまだ無く、待ち・更新待ちの料理だけ
 * (そのあいだに保存し直された・画像ができた料理は触らない)。渡した配列は変えず、新しい配列と、変えたかを返す
 */
export function markDishImagesEnqueueFailed<TDish extends MealImageDish>(
  dishes: TDish[],
  failures: ReadonlyArray<{ dishIndex: number; subjectHash: string }>,
): { dishes: TDish[]; changed: boolean } {
  const subjectByIndex = new Map(failures.map((failure) => [failure.dishIndex, failure.subjectHash]));
  let changed = false;
  const next = dishes.map((dish, index) => {
    const subjectHash = subjectByIndex.get(index);
    if (subjectHash === undefined) return dish;
    if (dish.image_subject_hash !== subjectHash || dish.image_url) return dish;
    if (dish.image_status !== 'pending' && dish.image_status !== 'stale') return dish;
    changed = true;
    const failed: TDish = {
      ...dish,
      image_status: 'failed',
      image_error: MEAL_IMAGE_ENQUEUE_FAILED_ERROR,
      image_generated_at: null,
    };
    return failed;
  });
  return { dishes: next, changed };
}

/**
 * 積めなかった料理を、保存済みの献立 (planned_meals.dishes) の上で 'failed' にする (#1505)。例外は投げず、結果を返す。
 * loadMeal / saveDishes は呼び出し側のクライアント (service role) で planned_meals を読む・書く関数
 */
export async function markEnqueueFailedDishesInMeal(params: {
  failures: ReadonlyArray<{ dishIndex: number; subjectHash: string }>;
  loadMeal: () => PromiseLike<{ data: { dishes?: unknown } | null; error: MealImageJobWriteError | null }>;
  saveDishes: (dishes: MealImageDish[]) => PromiseLike<{ error: MealImageJobWriteError | null }>;
}): Promise<{ status: 'updated' | 'unchanged' | 'not_found' } | { status: 'error'; message: string }> {
  if (params.failures.length === 0) return { status: 'unchanged' };
  try {
    const { data, error } = await params.loadMeal();
    if (error) return { status: 'error', message: error.message ?? 'failed to load planned meal' };
    if (!data) return { status: 'not_found' };
    const stored: MealImageDish[] = Array.isArray(data.dishes) ? data.dishes : [];
    const marked = markDishImagesEnqueueFailed(stored, params.failures);
    if (!marked.changed) return { status: 'unchanged' };
    const { error: saveError } = await params.saveDishes(marked.dishes);
    if (saveError) return { status: 'error', message: saveError.message ?? 'failed to update planned meal' };
    return { status: 'updated' };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeText(value: unknown): string {
  return normalizeWhitespace(String(value ?? '').toLowerCase());
}

function normalizeIngredients(dish: MealImageDish): string[] {
  const raw = Array.isArray(dish.ingredients) && dish.ingredients.length > 0
    ? dish.ingredients
    : typeof dish.ingredient === 'string' && dish.ingredient.trim()
      ? dish.ingredient.split(/[、,]/)
      : [];

  return raw
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .sort();
}

function isCoverReadyStatus(status: MealImageStatus | null | undefined): boolean {
  return status === 'ready';
}

function isCoverReadySource(source: MealImageSource | null | undefined): boolean {
  return source === 'meal_photo' || source === 'manual_override' || source === 'catalog';
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function buildDishImagePrompt(dish: MealImageDish): string {
  const name = normalizeWhitespace(String(dish.name ?? '料理'));
  const role = normalizeWhitespace(String(dish.role ?? 'dish'));
  const ingredients = normalizeIngredients(dish).slice(0, 5).join('、');

  return [
    `Japanese home-cooked ${role} dish: ${name}.`,
    ingredients ? `Key ingredients: ${ingredients}.` : null,
    'Professional food photography, natural light, plated meal, appetizing, realistic, close-up.',
  ]
    .filter(Boolean)
    .join(' ');
}

export async function buildDishImageSubjectHash(dish: MealImageDish, dishIndex: number): Promise<string> {
  const subjectDescriptor = JSON.stringify({
    name: normalizeText(dish.name),
    role: normalizeText(dish.role),
    ingredients: normalizeIngredients(dish),
    displayOrder: dish.displayOrder ?? dishIndex,
    dishIndex,
  });

  return sha256Hex(subjectDescriptor);
}

export async function buildMealImageIdempotencyKey(params: {
  plannedMealId: string;
  dishIndex: number;
  subjectHash: string;
  jobKind?: string;
}): Promise<string> {
  const jobKind = params.jobKind ?? 'dish';
  return sha256Hex(`${jobKind}:${params.plannedMealId}:${params.dishIndex}:${params.subjectHash}`);
}

export function deriveMealCoverImage<TDish extends MealImageDish>(params: {
  dishes?: TDish[] | null;
  fallbackMealImageUrl?: string | null;
}): string | null {
  const dishes = Array.isArray(params.dishes) ? params.dishes : [];
  if (dishes.length === 0) return params.fallbackMealImageUrl ?? null;

  if (dishes.length === 1) {
    const dish = dishes[0];
    const source = dish.image_source ?? null;
    const status = dish.image_status ?? null;
    if (dish.image_url && (isCoverReadyStatus(status) || isCoverReadySource(source))) {
      return dish.image_url;
    }
  }

  for (const dish of dishes) {
    const source = dish.image_source ?? null;
    const status = dish.image_status ?? null;
    if (dish.image_url && (isCoverReadyStatus(status) || isCoverReadySource(source))) {
      return dish.image_url;
    }
  }

  return params.fallbackMealImageUrl ?? null;
}

export function buildPhotoDishList(dishes: MealImageDish[], imageUrl: string | null): MealImageDish[] {
  const isSingle = dishes.length <= 1;
  return dishes.map((dish, index) => ({
    ...dish,
    image_url: isSingle && imageUrl ? imageUrl : null,
    image_source: 'meal_photo',
    image_status: isSingle ? 'ready' : 'stale',
    image_generated_at: new Date().toISOString(),
  }));
}

export async function reconcileDishImages<TDish extends MealImageDish>(
  params: ReconcileDishImagesParams<TDish>,
): Promise<ReconcileDishImagesResult<TDish>> {
  const previousDishes = Array.isArray(params.previousDishes) ? params.previousDishes : [];
  const nextDishes = Array.isArray(params.nextDishes) ? params.nextDishes : [];
  const model = params.model?.trim() || DEFAULT_MEAL_IMAGE_MODEL;

  const dishes: TDish[] = [];
  const jobs: MealImageJobSeed[] = [];

  for (let index = 0; index < nextDishes.length; index += 1) {
    const nextDish = nextDishes[index];
    const previousDish = previousDishes[index];
    const prompt = buildDishImagePrompt(nextDish);
    const subjectHash = await buildDishImageSubjectHash(nextDish, index);
    const manualOverride = previousDish?.image_source === 'manual_override' && !!previousDish?.image_url;
    const sameSubject = previousDish?.image_subject_hash === subjectHash;

    const reconciledDish: TDish = {
      ...nextDish,
      image_prompt: prompt,
      image_model: model,
      image_subject_hash: subjectHash,
    };

    // 前回と同じ料理でも、画像がまだ無く待ち・失敗のままなら積み直す (#1487。見送った料理・積めなかった料理を、保存し直すと直す)
    if (sameSubject && previousDish && !needsImageRetry(previousDish)) {
      reconciledDish.image_url = previousDish.image_url ?? null;
      reconciledDish.image_source = previousDish.image_source ?? 'generated_ai';
      reconciledDish.image_status = previousDish.image_status ?? 'pending';
      reconciledDish.image_generated_at = previousDish.image_generated_at ?? null;
      reconciledDish.image_error = previousDish.image_error ?? null;
      dishes.push(reconciledDish);
      continue;
    }

    if (manualOverride && previousDish) {
      reconciledDish.image_url = previousDish.image_url ?? null;
      reconciledDish.image_source = 'manual_override';
      reconciledDish.image_status = 'stale';
      reconciledDish.image_generated_at = previousDish.image_generated_at ?? null;
      reconciledDish.image_error = null;
      dishes.push(reconciledDish);
      continue;
    }

    reconciledDish.image_url = null;
    reconciledDish.image_source = 'generated_ai';
    // 前回と同じ料理の積み直しは 'pending' (前回の画像は無いので、更新待ちの 'stale' ではない)
    reconciledDish.image_status = previousDish && !sameSubject ? 'stale' : 'pending';
    reconciledDish.image_generated_at = null;
    reconciledDish.image_error = null;
    dishes.push(reconciledDish);

    jobs.push({
      dishIndex: index,
      dishName: String(nextDish.name ?? '').trim() || `dish-${index + 1}`,
      subjectHash,
      prompt,
      model,
      triggerSource: params.triggerSource,
      referenceImageUrls: [],
    });
  }

  return {
    dishes,
    jobs,
    mealCoverImageUrl: deriveMealCoverImage({
      dishes,
      fallbackMealImageUrl: params.fallbackMealImageUrl,
    }),
  };
}
