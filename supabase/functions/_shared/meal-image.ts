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
  /**
   * いまの献立のカバー (保存する前の planned_meals.image_url。新しく作るときは送られたカバー)。
   * 返す mealCoverImageUrl は、カバーの持ち主の決まり (isMealCoverAutoReplaceable) で決める
   */
  fallbackMealImageUrl?: string | null;
  /**
   * 新しく作る入口 (POST /api/meals・/api/meal-plans/meals) で、送られた料理の image_source が meal_photo / catalog / manual_override なら、
   * その画像と状態を前回の料理と同じく保持する (generated_ai にして画像を消さない。#1487 の整合ゲート)。
   * 前回の料理がある位置では、前回の料理で決める (送られた source は見ない)
   */
  preserveSubmittedDishImages?: boolean | null;
  /**
   * 前回の献立が商品の献立か (保存する前の planned_meals を isCatalogProductMeal で見た結果。#1487 の整合ゲート)。
   * 真なら、前回の商品の料理が画像の項目を持たない古い形でも、商品の料理として扱う (asCatalogMealDish)
   */
  previousMealIsCatalog?: boolean | null;
  /**
   * AI が献立の枠を作り直す保存か (Edge の save-meal の saveMealToDb だけが true を渡す。#1553)。
   * 真で、前回の献立が商品の献立でない (previousMealIsCatalog が偽) とき:
   *   - 中身が変わった料理 (前回の料理と subject_hash が違う) は、前回の写真・手で付けた画像を写さず、AI の画像のジョブを積む
   *   - 料理が変わった (前回と料理の数が違うか、中身が変わった料理がある) なら、利用者のカバー (写真・利用者が付けた画像など、
   *     AI の料理の画像でないカバー) を外し、新しい料理の画像からカバーを選び直す (候補が無ければ空。できた AI の画像が付く)。
   *     あわせて、料理ごとの画像を持たずカバーに頼っていた写真・商品・手の画像の料理 (写真の複数の料理の、中身が同じまま残った料理など)
   *     も、AI の画像の料理 (generated_ai・'pending'・subject_hash 付き) にしてジョブを積む
   *     (カバーが空・ジョブが 0 で、画像の無い写真の印の料理だけが残る献立を作らない)
   * 料理が同じまま (前回と同じ数・同じ中身) の保存し直しでは、今までどおり何も外さない。
   * 商品の献立は、作り直しても商品の料理・商品の画像のまま (商品とのつながりは、この保存では外さないため)
   * どの保存でも、AI の画像のジョブを積むのは献立の主菜の 1 品だけ (最後に autoImageDishIndexOf で絞る。billing/03 Q-16)。
   * 上の「ジョブを積む」「AI の画像の料理にして」は、その 1 品のときだけ。ほかの料理は画像の無い状態になる
   */
  regeneration?: boolean | null;
}

export interface ReconcileDishImagesResult<TDish extends MealImageDish> {
  dishes: TDish[];
  jobs: MealImageJobSeed[];
  mealCoverImageUrl: string | null;
}

export const DEFAULT_MEAL_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

/**
 * 料理画像のジョブを積まずに見送ったときの理由 (#1487・billing/03)。
 *   - ai_limit:   料理画像の安全弁 (DB の ai_unmetered_daily_caps の meal_image_auto) に達した (consumeAiUsage が不許可)
 *   - rate_limit: 画像のレート制限 (checkRateLimit の 'image') に達した、または判定が例外で終わった
 *   - plan:       ご利用中のプランでは自動の料理画像を作らない (ai_plan_feature_caps の meal_image_auto = 0。DB の plan_locked)
 */
export type MealImageSkipReason = 'ai_limit' | 'rate_limit' | 'plan';

/**
 * 見送った料理に書く image_error (#1487)。image_status は既存の 'failed' を使う
 * (新しい状態を足すと、'failed' 以外を「生成中」と出す画面・型の受け口をすべて直す必要があるため。
 *  料理画像の処理 (process-meal-image-jobs) も、同意が無くて送らなかったときは 'failed' + 理由を書く)。
 * 'failed' のまま image_url の無い料理は、同じ料理を保存し直すとジョブを積み直す (reconcileDishImages の needsImageRetry)
 */
export const MEAL_IMAGE_SKIPPED_ERRORS: Readonly<Record<MealImageSkipReason, string>> = Object.freeze({
  ai_limit: 'skipped_ai_limit',
  rate_limit: 'skipped_rate_limit',
  plan: 'skipped_plan',
});

/** image_error が、見送り (MEAL_IMAGE_SKIPPED_ERRORS) を表すか */
export function isMealImageSkippedError(value: unknown): boolean {
  return typeof value === 'string' && Object.values(MEAL_IMAGE_SKIPPED_ERRORS).includes(value);
}

/**
 * consumeAiUsage(user, 'meal_image_auto') の結果から見送りの理由を決める (4 本の route と AI 相談の自動実行が同じ式で使う)。
 * 判定していない (null) か許可されたのに見送るのはレート制限のときだけ
 */
export function mealImageSkipReasonOf(usage: { allowed: boolean; planLocked?: true } | null): MealImageSkipReason {
  if (usage === null || usage.allowed) return 'rate_limit';
  return usage.planLocked === true ? 'plan' : 'ai_limit';
}

/** image_error が、プランで見送った (skipped_plan) ことを表すか (料理の画面が有料プランの案内を出す) */
export function isMealImagePlanSkippedError(value: unknown): boolean {
  return value === MEAL_IMAGE_SKIPPED_ERRORS.plan;
}

/**
 * 料理画像のジョブを AI へ送る前の、プランの門の答え (billing/03 §8.8)。process-meal-image-jobs が、同意の判定のすぐ後に使う。
 * cap は DB の ai_plan_feature_daily_cap(ジョブの持ち主, 'meal_image_auto') の戻り値。
 *   0 → locked (そのプランでは自動の料理画像を作らない。ジョブを取り消し、料理を failed + skipped_plan にする)
 *   null (行なし)・正の数・読めなかった値 → allowed (読めなかったときは止めない。consume_ai_usage の「判定に失敗したときは止めない」と同じ)
 */
export type MealImageJobPlanDecision = 'locked' | 'allowed';
export function mealImageJobPlanDecision(cap: unknown): MealImageJobPlanDecision {
  return cap === 0 ? 'locked' : 'allowed';
}

/**
 * 同じ料理 (subject_hash が同じ) を保存し直したとき、ジョブを積み直すか (#1487)。
 * 画像がまだ無く (image_url なし)、AI が作る画像 (image_source が generated_ai か未設定) で、
 * 前回の状態が待ち・更新待ち・失敗 (または未設定) のとき。
 * 写真 (meal_photo)・手で付けた画像 (manual_override)・商品 (catalog) は積まない
 * (写真から作った複数の料理は 'stale' のまま画像を作らないのが今の扱い)。
 * 待ちのジョブがまだ残っているときは、同じ冪等キーで積もうとして積まれない (enqueueMealImageJobs が重複として数えない)。
 * reconcileDishImages は、これに加えて「AI の画像の料理だと分かる」(isAiImagePipelineDish) ときだけ積み直す
 * (献立のカバーが料理ごとの画像を持たない写真・商品の料理のものなら、積み直さない。isMealCoverHeldByImagelessPreservedDish)
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

/**
 * 冪等キーの一意な索引に当たる (待ち・処理中の) ジョブの状態。meal_image_jobs_idempotency_pending_idx の WHERE と同じ 2 つ (#1561)
 */
export const MEAL_IMAGE_JOB_ACTIVE_STATUSES = ['pending', 'processing'] as const;
export type MealImageJobActiveStatus = (typeof MEAL_IMAGE_JOB_ACTIVE_STATUSES)[number];

/** 行ごとの結果 */
export type MealImageJobInsertOutcome =
  | { kind: 'inserted'; dishIndex: number; subjectHash: string }
  | {
      kind: 'duplicate';
      dishIndex: number;
      subjectHash: string;
      /**
       * 重なった同じ料理のジョブの状態 (#1561)。読めなかった (読み方を渡していない・読み取りのエラー・読む前に終わった) ときは null。
       * null は待ちとみなして処理を起こす (起こしても待ちのジョブが無ければ空振りになるだけで、取りこぼすより安全)
       */
      activeStatus: MealImageJobActiveStatus | null;
    }
  | { kind: 'failed'; dishIndex: number; subjectHash: string; code: string | null; message: string };

/** enqueueMealImageJobs の結果 (#1487)。行ごとに数える */
export interface EnqueueMealImageJobsResult {
  /** 新しく積めた行 */
  inserted: number;
  /** 同じ料理の待ち・処理中のジョブがすでにあって積まなかった行 (冪等キーの重複) */
  duplicates: number;
  /**
   * duplicates のうち、重なった同じ料理のジョブが処理中 (processing) だったもの (#1561)。
   * 画像の処理は待ち (pending) のジョブだけを拾うので、これらのために処理を起こしても空振りになる。
   * 処理中のまま止まったジョブは、pg_cron のジョブ requeue-stale-meal-image-jobs が取り戻す
   */
  duplicatesProcessing: number;
  /** 書き込みに失敗した行 (権限・接続・値の不正など) */
  failed: number;
}

/** 1 行も積んでいないときの結果 */
export const EMPTY_ENQUEUE_MEAL_IMAGE_JOBS_RESULT: Readonly<EnqueueMealImageJobsResult> = Object.freeze({
  inserted: 0,
  duplicates: 0,
  duplicatesProcessing: 0,
  failed: 0,
});

/**
 * 積んだ結果から、処理を起こす件数 (#1532)。積めた行と、同じ料理の待ちのジョブ (重複のうち処理中でないもの) の数。
 * 0 (1 行も積めず、待ちのジョブも無い = 書き込みの失敗だけ・積む行が無い・重複がどれも処理中) なら処理を起こさない
 * (空振りの呼び出しを出さない)。
 * 待ちの重複を数えるのは、前の呼び出しが失敗して待ちのまま残ったジョブを、保存し直したときにすぐ処理させるため
 * (Edge の saveMealToDb・積み直しの道具と同じ決まり。待ちのジョブは pg_cron のジョブ process-pending-meal-image-jobs も 5 分ごとに拾う)。
 * 処理中の重複は数えない (画像の処理は待ちのジョブだけを拾うので、起こしても空振りになる。#1561)
 */
export function countMealImageJobsToProcess(result: EnqueueMealImageJobsResult): number {
  return result.inserted + result.duplicates - result.duplicatesProcessing;
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
 * 重なった (23505) 同じ料理の待ち・処理中のジョブの状態を読む関数 (#1561)。
 * 冪等キーが同じで、状態が MEAL_IMAGE_JOB_ACTIVE_STATUSES の行を 1 行読む (部分索引があるので多くても 1 行)
 */
export type MealImageJobActiveStatusReader = (
  record: MealImageJobRecord,
) => PromiseLike<{ data: { status?: unknown } | null; error: MealImageJobWriteError | null }>;

function asActiveStatus(value: unknown): MealImageJobActiveStatus | null {
  return MEAL_IMAGE_JOB_ACTIVE_STATUSES.find((status) => status === value) ?? null;
}

/** 重なった同じ料理のジョブの状態。読めなければ null (例外は投げない) */
async function readDuplicateActiveStatus(
  record: MealImageJobRecord,
  readActiveStatus: MealImageJobActiveStatusReader | undefined,
): Promise<MealImageJobActiveStatus | null> {
  if (!readActiveStatus) return null;
  try {
    const { data, error } = await readActiveStatus(record);
    if (error) return null;
    return asActiveStatus(data?.status);
  } catch {
    return null;
  }
}

/**
 * 行ごとに insert し、積めた・重複・失敗を返す。例外は投げない (insertJob の例外も失敗として返す)。
 *
 * 1 回の upsert (onConflict: 'idempotency_key', ignoreDuplicates) にしない理由 (#1487 / #1505):
 * 冪等キーの一意な索引は部分索引 (WHERE status IN ('pending','processing')) なので、PostgREST の on_conflict が作る
 * ON CONFLICT (idempotency_key) は索引を推論できず、42P10 で必ず失敗する (行が 1 つも積まれない)。
 * 部分索引のままにするのは、失敗・取り消し・完了したジョブと同じ料理を、あとで積み直せるようにするため。
 * そのため行ごとに insert し、一意制約の違反 (23505) は「同じ料理のジョブが待ち・処理中」として重複に数える。
 *
 * 重複のときは readActiveStatus で、重なったジョブが待ちか処理中かを読む (#1561。処理中なら処理を起こしても空振りになるので、
 * countMealImageJobsToProcess が数えない)。readActiveStatus を渡さない・読めないときの状態は null (待ちとみなす)
 */
export async function insertMealImageJobRecords(
  records: ReadonlyArray<MealImageJobRecord>,
  insertJob: (record: MealImageJobRecord) => PromiseLike<{ error: MealImageJobWriteError | null }>,
  readActiveStatus?: MealImageJobActiveStatusReader,
): Promise<MealImageJobInsertOutcome[]> {
  return Promise.all(
    records.map(async (record): Promise<MealImageJobInsertOutcome> => {
      const base = { dishIndex: record.dish_index, subjectHash: record.subject_hash };
      let insertError: MealImageJobWriteError | null;
      try {
        ({ error: insertError } = await insertJob(record));
      } catch (error) {
        return { kind: 'failed', ...base, code: null, message: error instanceof Error ? error.message : String(error) };
      }
      if (!insertError) return { kind: 'inserted', ...base };
      if (insertError.code === MEAL_IMAGE_JOB_UNIQUE_VIOLATION_CODE) {
        return { kind: 'duplicate', ...base, activeStatus: await readDuplicateActiveStatus(record, readActiveStatus) };
      }
      return { kind: 'failed', ...base, code: insertError.code ?? null, message: insertError.message ?? 'unknown error' };
    }),
  );
}

/** 行ごとの結果を数える */
export function summarizeMealImageJobOutcomes(outcomes: ReadonlyArray<MealImageJobInsertOutcome>): EnqueueMealImageJobsResult {
  const result: EnqueueMealImageJobsResult = { ...EMPTY_ENQUEUE_MEAL_IMAGE_JOBS_RESULT };
  for (const outcome of outcomes) {
    if (outcome.kind === 'inserted') result.inserted += 1;
    else if (outcome.kind === 'duplicate') {
      result.duplicates += 1;
      if (outcome.activeStatus === 'processing') result.duplicatesProcessing += 1;
    } else result.failed += 1;
  }
  return result;
}

/**
 * ジョブを積めなかった (書き込みの失敗) 料理を 'failed' + MEAL_IMAGE_ENQUEUE_FAILED_ERROR にする (#1505)。
 * 料理は保存したあとなので、'pending' のまま残すと処理するジョブが無く「生成中」のまま残る。
 * 変えるのは、同じ料理 (image_subject_hash が積もうとしたジョブと同じ) で、画像がまだ無く、待ち・更新待ちの、
 * AI の画像の料理 (image_source が generated_ai か未設定) だけ (そのあいだに保存し直された・画像ができた料理は触らない)。
 * 写真・商品・手で付けた画像の料理 (#1487 の整合ゲートで AI の画像のジョブを積まない料理) は、状態も理由も変えない。
 * 商品の献立 (mealIsCatalog) の、画像の項目の無い古い商品の料理 (asCatalogMealDish が商品の料理として読む料理) も変えない。
 * 渡した配列は変えず、新しい配列と、変えたかを返す
 */
export function markDishImagesEnqueueFailed<TDish extends MealImageDish>(
  dishes: TDish[],
  failures: ReadonlyArray<{ dishIndex: number; subjectHash: string }>,
  options: { mealIsCatalog?: boolean | null } = {},
): { dishes: TDish[]; changed: boolean } {
  const subjectByIndex = new Map(failures.map((failure) => [failure.dishIndex, failure.subjectHash]));
  const mealIsCatalog = options.mealIsCatalog === true;
  let changed = false;
  const next = dishes.map((dish, index) => {
    const subjectHash = subjectByIndex.get(index);
    if (subjectHash === undefined) return dish;
    if (dish.image_subject_hash !== subjectHash || dish.image_url) return dish;
    if (dish.image_status !== 'pending' && dish.image_status !== 'stale') return dish;
    const source = dish.image_source ?? null;
    if (source !== null && source !== 'generated_ai') return dish;
    if (asCatalogMealDish(dish, index, mealIsCatalog) !== dish) return dish;
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
 * 献立の料理を書けなかったとき (0 行) に、読み直して書き直す回数の上限 (最初の 1 回を含む。#1527)。
 * 0 行 = 読んでから書くまでのあいだに、ほかの書き手 (同じ献立の別の料理のワーカー・利用者の保存・積めなかった料理の印付け) が先に書いたということ。
 * 1 つの献立に同時に書くのは、料理ごとのワーカー (料理は数品) と利用者の保存くらいなので、続けて負けるのは数回まで。
 * これを超えて負け続けるのは異常なので、書き手はエラーとして扱う
 * (ワーカーはジョブを失敗にし、積めなかった料理の印付け (markEnqueueFailedDishesInMeal) は error を返す。#1532)
 */
export const MEAL_DISH_WRITE_MAX_ATTEMPTS = 5;

/**
 * 献立の料理の書き込みを、MEAL_DISH_WRITE_MAX_ATTEMPTS 回続けて負けて諦めたときの例外 (#1553)。
 * どの回も 0 行 (条件に合う行が無かった) なので、献立には何も書いていないことが確かなときだけ投げる。
 * 書き込みのエラー (書けたかどうかが分からない) とは型で見分ける。画像の処理は、これを受けたときだけ、
 * そのジョブがアップロードした画像を消してよい (料理から参照されていないことが確か)
 */
export class MealDishWriteExhaustedError extends Error {
  constructor() {
    super(`failed to update meal: the meal kept changing while writing (${MEAL_DISH_WRITE_MAX_ATTEMPTS} attempts)`);
    this.name = 'MealDishWriteExhaustedError';
  }
}

/** 献立の書き込みが使う、update の最小の形 (supabase-js のクライアントの一部。テストで作り物を渡せるように) */
export interface PlannedMealUpdateFilter {
  eq(column: string, value: string): PlannedMealUpdateFilter;
  is(column: string, value: null): PlannedMealUpdateFilter;
  select(columns: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export interface PlannedMealWriter {
  from(table: 'planned_meals'): {
    update(values: Record<string, unknown>): PlannedMealUpdateFilter;
  };
}

/** 楽観的な排他で書くために読んだ献立の行の最小の形 (planned_meals の dishes, image_url, updated_at) */
export interface PlannedMealLockSnapshot {
  dishes: unknown;
  image_url: string | null;
  updated_at: string | null;
}

/**
 * 読んだ行から、書く料理とカバーを決めた結果。
 * nextCover が undefined ならカバーを変えない (image_url に触れない)。skip なら書かずにやめる
 */
export type PlannedMealLockedWriteDecision<TSkip extends string> =
  | { kind: 'write'; dishes: unknown[]; nextCover: string | null | undefined }
  | { kind: 'skip'; reason: TSkip };

/** 楽観的な排他で書いた結果。献立が消えていたら meal_deleted */
export type PlannedMealLockedWriteOutcome<TSkip extends string> =
  | { status: 'written' }
  | { status: 'skipped'; reason: TSkip | 'meal_deleted' };

/**
 * 献立の料理を、読んだときの行のままの場合にだけ書く (楽観的な排他。#1527 で process-meal-image-jobs に入れた形を共通にした。#1532)。
 * 読む → decide で料理とカバーを決める → 読んだときの updated_at の行にだけ書く。0 行なら (読んでから書くまでに
 * 別の書き手が書いた)、読み直して、最新の料理に決め直して書き直す。MEAL_DISH_WRITE_MAX_ATTEMPTS 回で書けなければ例外。
 * updated_at は planned_meals の更新のトリガー (trg_planned_meals_updated_at) が更新のたびに now() にするので、
 * どの書き手が書いても変わる (書き手が updated_at を送らなくても)。
 * カバーを変えるときは、読んだときのカバーのままの行にだけ書く条件も重ねる (#1487 の整合ゲートのカバーの持ち主の二重の守り)。
 * read は、無ければ null を返し、読めなければ例外を投げる。書き込みのエラーも例外にする
 */
export async function writePlannedMealDishesWithOptimisticLock<TSnapshot extends PlannedMealLockSnapshot, TSkip extends string>(
  db: PlannedMealWriter,
  params: {
    mealId: string;
    read: () => Promise<TSnapshot | null>;
    decide: (snapshot: TSnapshot) => PlannedMealLockedWriteDecision<TSkip>;
  },
): Promise<PlannedMealLockedWriteOutcome<TSkip>> {
  for (let attempt = 1; attempt <= MEAL_DISH_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await params.read();
    if (!snapshot) return { status: 'skipped', reason: 'meal_deleted' };
    const decision = params.decide(snapshot);
    if (decision.kind === 'skip') return { status: 'skipped', reason: decision.reason };

    const values: Record<string, unknown> = { dishes: decision.dishes, updated_at: new Date().toISOString() };
    if (decision.nextCover !== undefined) values.image_url = decision.nextCover;

    let query = db.from('planned_meals').update(values).eq('id', params.mealId);
    query = snapshot.updated_at === null
      ? query.is('updated_at', null)
      : query.eq('updated_at', snapshot.updated_at);
    if (decision.nextCover !== undefined) {
      query = snapshot.image_url === null
        ? query.is('image_url', null)
        : query.eq('image_url', snapshot.image_url);
    }
    const { data, error } = await query.select('id');
    if (error) throw new Error(`failed to update meal: ${error.message}`);
    if (Array.isArray(data) && data.length > 0) return { status: 'written' };
  }
  throw new MealDishWriteExhaustedError();
}

/** 積めなかった料理の印付けで読む献立の行 (planned_meals の dishes, image_url, updated_at, catalog_product_id, source_type) */
export interface EnqueueFailedMealRow {
  dishes?: unknown;
  image_url?: unknown;
  updated_at?: unknown;
  catalog_product_id?: unknown;
  source_type?: unknown;
}

/** markEnqueueFailedDishesInMeal の loadMeal が select する列 (楽観的な排他の updated_at と、商品の献立かを見る列) */
export const ENQUEUE_FAILED_MEAL_COLUMNS = 'dishes, image_url, updated_at, catalog_product_id, source_type';

/**
 * 積めなかった料理を、保存済みの献立 (planned_meals.dishes) の上で 'failed' にする (#1505)。例外は投げず、結果を返す。
 * db は呼び出し側のクライアント (service role)。loadMeal はそのクライアントで planned_meals を
 * ENQUEUE_FAILED_MEAL_COLUMNS で読む関数 (商品の献立か = isCatalogProductMeal を見るため catalog_product_id・source_type も読む)。
 * 書くのは料理 (dishes) だけで、献立のカバー (image_url) には触れない (カバーの持ち主の決まり isMealCoverAutoReplaceable)。
 * 書くときは読んだときの updated_at の行にだけ書き (楽観的な排他。#1532)、0 行なら (そのあいだにワーカーが料理の画像を書いた・
 * 利用者が保存した) 読み直して当て直す (writePlannedMealDishesWithOptimisticLock)。以前は読んだ料理を条件なしで書いており、
 * そのあいだに書かれたほかの料理の画像を巻き戻しえた
 */
export async function markEnqueueFailedDishesInMeal(params: {
  failures: ReadonlyArray<{ dishIndex: number; subjectHash: string }>;
  mealId: string;
  db: PlannedMealWriter;
  loadMeal: () => PromiseLike<{ data: EnqueueFailedMealRow | null; error: MealImageJobWriteError | null }>;
}): Promise<{ status: 'updated' | 'unchanged' | 'not_found' } | { status: 'error'; message: string }> {
  if (params.failures.length === 0) return { status: 'unchanged' };
  try {
    const outcome = await writePlannedMealDishesWithOptimisticLock(params.db, {
      mealId: params.mealId,
      read: async () => {
        const { data, error } = await params.loadMeal();
        if (error) throw new Error(error.message ?? 'failed to load planned meal');
        if (!data) return null;
        return {
          dishes: data.dishes,
          image_url: typeof data.image_url === 'string' ? data.image_url : null,
          updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
          row: data,
        };
      },
      decide: (snapshot) => {
        const stored: MealImageDish[] = Array.isArray(snapshot.dishes) ? snapshot.dishes : [];
        const marked = markDishImagesEnqueueFailed(stored, params.failures, { mealIsCatalog: isCatalogProductMeal(snapshot.row) });
        if (!marked.changed) return { kind: 'skip', reason: 'unchanged' };
        return { kind: 'write', dishes: marked.dishes, nextCover: undefined };
      },
    });
    if (outcome.status === 'written') return { status: 'updated' };
    return { status: outcome.reason === 'meal_deleted' ? 'not_found' : 'unchanged' };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 前回の料理の画像を、AI の画像で置き換えずにそのまま残すか (#1487 の整合ゲート)。
 *   - image_source が generated_ai 以外 (meal_photo・catalog・manual_override・none): 残す。
 *     subject_hash の有無・料理の中身の変更によらない (写真や商品の料理は subject_hash を持たない)
 *   - image_source が未設定でも image_url があれば残す。AI の画像を書くのは画像の処理 (process-meal-image-jobs) だけで、
 *     そこは必ず image_source: 'generated_ai' を書く。手で付けた画像も buildDishImagePayload が manual_override を書く。
 *     source の無い画像は、この仕組みの外で付いた画像 (古い写真の記録・商品・外から書いた画像) なので、AI の画像とみなさない。
 *     URL の形 (保存先のバケット名など) では判定しない (保存先は経路ごとに違い、source だけで漏れなく決まるため)
 * AI の画像のジョブを積むのは、image_source が generated_ai か未設定 (で画像の無い) 料理だけ。
 * ただし reconcileDishImages は、商品の献立の古い商品の料理を先に商品の料理として読み (asCatalogMealDish)、
 * 献立のカバーが料理ごとの画像を持たない写真・商品の料理のものなら、ほかの料理にも積まない
 */
export function isPreservedDishImage(dish: MealImageDish): boolean {
  const source = dish.image_source ?? null;
  if (source !== null) return source !== 'generated_ai';
  return !!dish.image_url;
}

/**
 * 新しく作る入口で送られた料理が、保持する写真・商品・手の画像の料理か (#1487 の整合ゲート。reconcileDishImages の preserveSubmittedDishImages)。
 * image_source が meal_photo / catalog / manual_override のとき (写真の複数の料理のように、料理ごとの画像が無くても保持する)
 */
function isSubmittedPreservedDishImage(dish: MealImageDish): boolean {
  return isCoverReadySource(dish.image_source ?? null);
}

/**
 * AI の画像の仕組み (reconcileDishImages → 画像の処理) が扱っている料理だと分かるか (#1487 の整合ゲート)。
 * subject_hash を持つ (reconcileDishImages が書いた) か、image_source が generated_ai のとき。
 * どちらも無い料理 (端末から直に保存した料理・この仕組みより前の料理) は、料理を変えずに保存し直しても積み直さない
 * (完了の切り替えのような、料理以外だけを変える保存で、AI の画像を作り始めたり安全弁の 1 回を数えたりしない)
 */
export function isAiImagePipelineDish(dish: MealImageDish): boolean {
  return !!dish.image_subject_hash || dish.image_source === 'generated_ai';
}

/**
 * 自動の料理画像 (料理の保存・更新の 4 本の route・AI 相談の料理の更新・献立の作成 (Edge の save-meal) が積むジョブ) を作る
 * 料理の役割 (billing/03 §8.8・Q-16)。自動で作るのは献立の主菜の 1 品だけ。
 * 料理の役割 (dishes[].role) は、AI が作る献立では 'main' / 'side' / 'soup' / 'rice' / 'other' (_shared/meal-generator.ts)、
 * 利用者が日本語で保存した料理では '主菜' など (packages/shared/src/dish-roles.ts の getDishConfig が 'main' と同じ「主菜」として読む)。
 * 比べるときは前後の空白を除き、英字を小文字にする (normalizeText)
 */
export const AUTO_IMAGE_DISH_ROLES: ReadonlyArray<string> = Object.freeze(['main', '主菜']);

/**
 * 主菜の無い献立 (朝食のご飯と汁物だけ・役割が other だけ・役割の無い料理だけ) で、自動の料理画像を作る料理の位置 (先頭の料理)。
 * 献立のカバーを 1 枚残すため (Q-16 の「見た目は残し」)
 */
export const AUTO_IMAGE_FALLBACK_DISH_INDEX = 0;

/** 料理が 1 品の献立の料理の数 (献立のカバーがその料理の画像と同じになる献立) */
const SINGLE_DISH_MEAL_DISH_COUNT = 1;

/**
 * 献立の料理のうち、自動の料理画像を作る 1 品の位置 (billing/03 §8.8・Q-16)。
 * 役割が主菜 (AUTO_IMAGE_DISH_ROLES) の最初の料理。主菜の無い献立は AUTO_IMAGE_FALLBACK_DISH_INDEX。料理が無ければ null
 */
export function autoImageDishIndexOf(dishes: ReadonlyArray<Pick<MealImageDish, 'role'>>): number | null {
  if (dishes.length === 0) return null;
  const mainIndex = dishes.findIndex((dish) => AUTO_IMAGE_DISH_ROLES.includes(normalizeText(dish.role)));
  return mainIndex >= 0 ? mainIndex : AUTO_IMAGE_FALLBACK_DISH_INDEX;
}

/**
 * 料理の画面で、自分の画像の無い料理に献立のカバー (planned_meals.image_url) を代わりに出してよいか (billing/03 §10.3・Q-16)。
 * 出すのは、料理が 1 品の献立の料理・自動の料理画像を作る料理 (autoImageDishIndexOf の位置。カバーはその料理の画像になる)・
 * カバーに頼る写真・商品・手の画像の料理 (写真の複数の料理など。image_source が meal_photo / catalog / manual_override) だけ。
 * ほかの料理 (主菜でない料理) には出さない (カバーは主菜の画像なので、別の料理の画像を出すことになる)。位置に料理が無ければ false
 */
export function mealCoverRepresentsDish(
  dishes: ReadonlyArray<Pick<MealImageDish, 'role' | 'image_source'>>,
  dishIndex: number,
): boolean {
  const dish = dishes[dishIndex];
  if (!dish) return false;
  if (dishes.length <= SINGLE_DISH_MEAL_DISH_COUNT) return true;
  return dishIndex === autoImageDishIndexOf(dishes) || isCoverReadySource(dish.image_source ?? null);
}

/**
 * 主菜の引き継ぎ (billing/03 §8.8・§7.3・Q-16)。この保存で自動の料理画像を作る位置 (autoImageDishIndexOf) が別の料理へ移り
 * (前の主菜を消した・前の主菜の役割を外した。移った先の料理はもとからその位置にあり、中身・役割・位置を変えていない)、
 * 移った先の料理が画像の無い状態 (N: 画像・source・subject_hash なし。主菜でなかった間に withoutAutoDishImage が外した料理など) なら、その位置を返す。
 * reconcileDishImages はその料理に種を 1 本足す (献立のカバーを 1 枚残す。R26・S38・S42)。それ以外は null。
 *   - 前回の料理が無い (新しい献立): null (新しい料理は reconcileDishImages の for の中で種になる)
 *   - 位置が移っていない (前回と今回の autoImageDishIndexOf が同じ): null。料理を変えずに保存し直した (完了の切り替えなど) ときは
 *     役割と並びが同じなので必ずここに当たり、AI の画像の料理だと分からない料理を変えずに保存し直しても積まない今の決まり
 *     (reconcileDishImages の「前回のまま写し、積まない」。#1487) は変わらない
 *   - 移った先の料理にもう種がある (中身・役割・位置が変わった料理・待ちの料理の積み直し): null (種は 1 本のまま)
 *   - 移った先の料理が画像を持つ・写真・商品・手の画像の料理 (isPreservedDishImage)・AI の画像の料理 (isAiImagePipelineDish): null
 * previousDishes は保存する前の料理 (料理でない値は役割の無い料理として位置を数える)、dishes は reconcileDishImages の for で作った料理、
 * seededDishIndexes はその時点の種の位置
 */
export function autoImageDishHandoverIndexOf(params: {
  previousDishes: ReadonlyArray<MealImageDish | null | undefined>;
  dishes: ReadonlyArray<MealImageDish>;
  seededDishIndexes: ReadonlyArray<number>;
}): number | null {
  if (params.previousDishes.length === 0) return null;
  const autoImageDishIndex = autoImageDishIndexOf(params.dishes);
  if (autoImageDishIndex === null) return null;
  const previousAutoImageDishIndex = autoImageDishIndexOf(
    params.previousDishes.map((dish): MealImageDish => (dish && typeof dish === 'object' ? dish : {})),
  );
  if (previousAutoImageDishIndex === autoImageDishIndex) return null;
  if (params.seededDishIndexes.includes(autoImageDishIndex)) return null;
  const dish = params.dishes[autoImageDishIndex];
  if (!dish || dish.image_url || isPreservedDishImage(dish) || isAiImagePipelineDish(dish)) return null;
  return autoImageDishIndex;
}

/**
 * 自動の料理画像を作らない料理を、画像の無い状態にする (billing/03 §8.8・Q-16)。状態・source・subject_hash・画像を持たない
 * (画面は「生成中」「再生成待ち」を出さず、料理の画面は画像の枠を出さない。subject_hash も source も無いので、次に変えずに
 * 保存し直しても AI の画像の料理とみなさず積み直さない (isAiImagePipelineDish が偽))。プロンプトとモデルは残す。
 * 渡した料理は変えず、新しい料理を返す
 */
function withoutAutoDishImage<TDish extends MealImageDish>(dish: TDish): TDish {
  const cleared: TDish = {
    ...dish,
    image_subject_hash: null,
    image_url: null,
    image_source: null,
    image_status: null,
    image_generated_at: null,
    image_error: null,
  };
  return cleared;
}

/**
 * 商品の献立の planned_meals.source_type (lib/catalog-products.ts の buildCatalogMealFields が書く。
 * 以前は端末の保存 (モバイルの食事の新規作成の画面 apps/mobile/app/meals/new.tsx) も書いていた。画面は届かない画面として消したが (#1598)、
 * その画面が書いた行は残るので、下の「端末の保存」の形も読み続ける)
 */
export const CATALOG_PRODUCT_MEAL_SOURCE_TYPE = 'catalog_product';

/**
 * 商品の献立で、商品の料理がある位置。商品を選ぶ保存 (buildCatalogMealFields・以前の端末の保存) は、料理を商品の料理 1 つだけにする
 */
const CATALOG_MEAL_PRODUCT_DISH_INDEX = 0;

/**
 * 献立 (planned_meals の行) が商品の献立か (#1487 の整合ゲート)。catalog_product_id がある、または source_type が 'catalog_product'。
 * 献立のカバーは商品の画像 (buildCatalogMealFields の image_url)
 */
export function isCatalogProductMeal(
  meal: { catalog_product_id?: unknown; source_type?: unknown } | null | undefined,
): boolean {
  if (!meal) return false;
  return !!meal.catalog_product_id || meal.source_type === CATALOG_PRODUCT_MEAL_SOURCE_TYPE;
}

/**
 * 商品の献立の前回の商品の料理を、商品の料理 (image_source: 'catalog') として読む (#1487 の整合ゲート)。
 * 商品の料理に image_source を付ける前の形 (origin/main の buildCatalogMealFields・端末の保存。料理に画像の項目が無く、画像は献立のカバーだけ) と、
 * その形の料理を以前の reconcileDishImages が「料理が変わった」とみなして書き換えた形 (generated_ai・画像なし。ジョブは積めておらず
 * AI の画像はできていない) は、どちらも source だけでは商品の料理と分からず、保存し直すと AI の画像のジョブを積んでしまう
 * (商品の献立の料理に AI の画像を作り、安全弁の 1 回を数えてしまう。献立のカバーはカバーの持ち主の決まり (isMealCoverAutoReplaceable) が守る)。
 * 対象は商品の料理の位置 (先頭) で、自分の画像 (image_url) を持たず、source が未設定か generated_ai の料理だけ。
 * 自分の画像のある料理・写真・手の画像の料理は変えない
 */
export function asCatalogMealDish<TDish extends MealImageDish>(
  dish: TDish,
  index: number,
  mealIsCatalog: boolean,
): TDish {
  if (!mealIsCatalog || index !== CATALOG_MEAL_PRODUCT_DISH_INDEX || dish.image_url) return dish;
  const source = dish.image_source ?? null;
  if (source !== null && source !== 'generated_ai') return dish;
  // 画像が無い商品の料理は状態を付けない (catalogDishImageFields(null) と同じ。画面に「生成中」「再生成待ち」を出さない)
  return {
    ...dish,
    image_source: 'catalog',
    image_status: null,
    image_error: null,
    image_generated_at: null,
    image_subject_hash: null,
  };
}

/**
 * 献立のカバーが、料理ごとの画像を持たない写真・商品・手の画像の料理のものか (#1487 の整合ゲート)。
 * 写真の複数の料理 (buildPhotoDishList は料理ごとの画像を付けず、写真は献立のカバーだけ) や、画像の項目の無い商品の料理のとき。
 * このときは、ほかの料理にも AI の画像のジョブを積まない (写真・商品の献立の料理には AI の画像を作らない、いまの決まり)。
 * カバーそのものは、カバーの持ち主の決まり (isMealCoverAutoReplaceable) が守る (写真・商品のカバーは AI の料理の画像と一致しないので、
 * 画像の処理も保存し直しも置き換えない)。ジョブを積むかと安全弁の 1 回を数えるかを変えないために、この判定は残している。
 * 待ったままの料理にジョブを積み直す道具 (scripts/lib/meal-image-backfill.ts。#1505) も、同じ判定で献立ごと積まない
 */
export function isMealCoverHeldByImagelessPreservedDish(
  dishes: ReadonlyArray<MealImageDish>,
  mealCoverImageUrl: string | null | undefined,
): boolean {
  if (!mealCoverImageUrl) return false;
  return dishes.some(isImagelessCoverReadyDish);
}

/**
 * 料理ごとの画像を持たず、献立のカバーに頼る写真・商品・手の画像の料理か (写真の複数の料理 (buildPhotoDishList) など)。
 * isMealCoverHeldByImagelessPreservedDish と、AI の作り直しで料理が変わったときに AI の画像へ回す料理 (#1553) の判定
 */
function isImagelessCoverReadyDish(dish: MealImageDish): boolean {
  return isCoverReadySource(dish.image_source ?? null) && !dish.image_url;
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

/** 料理の画像が、AI の画像の処理 (process-meal-image-jobs) が作った画像か (image_source が generated_ai で画像がある) */
function hasGeneratedAiDishImage(dish: MealImageDish, imageUrl: string): boolean {
  return dish.image_source === 'generated_ai' && !!dish.image_url && dish.image_url === imageUrl;
}

/**
 * 献立のカバー (planned_meals.image_url) を、料理の画像から自動で付け替えてよいか (カバーの持ち主。#1487 の整合ゲート)。
 * 付け替えてよいのは、いまのカバーが空か、献立の AI の料理 (image_source が generated_ai) の画像と一致する (AI の料理の画像から来た) ときだけ。
 * 写真・商品・利用者が作った画像・手で付けた画像のカバー (どの AI の料理の画像とも一致しない、空でないカバー) は、
 * 画像の処理 (process-meal-image-jobs)・保存し直し (reconcileDishImages)・AI の作り直し (save-meal) のどこからも置き換えない。
 * カバーを決める全員は、deriveMealCoverImage を通してこの決まりに従う。
 * 例外はカバーを外す 2 つだけ (#1553): AI の作り直し (save-meal) で料理が変わったとき (商品の献立を除く。reconcileDishImages の
 * regeneration) と、料理が 2 品以上の献立の PATCH に image_url: null が来たとき (buildDishImagePayload の clearCover)。
 * 外したあとのカバーも deriveMealCoverImage で料理の画像から選び直す
 *
 * dishLists: いまのカバーの出どころになりうる料理の一覧 (保存する前の料理と、これから保存する料理)。
 * 料理が書き換わる保存し直しでは、前回の料理の AI の画像だったカバーも AI のものとして扱う
 */
export function isMealCoverAutoReplaceable(
  currentCoverImageUrl: string | null | undefined,
  dishLists: ReadonlyArray<ReadonlyArray<MealImageDish> | null | undefined>,
): boolean {
  if (!currentCoverImageUrl) return true;
  return dishLists.some(
    (list) => Array.isArray(list) && list.some((dish) => hasGeneratedAiDishImage(dish, currentCoverImageUrl)),
  );
}

/** 料理の画像からカバーの候補を選ぶ (先頭から、できあがった画像か写真・商品・手の画像) */
function pickDishCoverImage(dishes: ReadonlyArray<MealImageDish>): string | null {
  for (const dish of dishes) {
    const source = dish.image_source ?? null;
    const status = dish.image_status ?? null;
    if (dish.image_url && (isCoverReadyStatus(status) || isCoverReadySource(source))) {
      return dish.image_url;
    }
  }
  return null;
}

/**
 * 献立のカバーを決める (#1487 の整合ゲート。カバーの持ち主は isMealCoverAutoReplaceable)。
 *   - いまのカバー (currentCoverImageUrl) が AI のものでない (写真・商品・利用者の画像など): いまのカバーをそのまま返す
 *   - 空か AI の料理の画像から来たもの: 料理の画像 (先頭から、できあがった画像か写真・商品・手の画像) を選ぶ。
 *     候補が無ければ、いまのカバーがまだ献立の AI の料理の画像なら残し、そうでなければ (料理が変わって画像が無くなった) 空にする
 *     (前の料理の AI の画像をカバーに残すと、どの料理の画像とも一致しなくなり、新しい AI の画像で付け替えられなくなるため)
 * previousDishes: 保存する前の料理 (料理が書き換わる保存し直しで渡す。いまのカバーが前回の AI の料理の画像かを見る)
 */
export function deriveMealCoverImage<TDish extends MealImageDish>(params: {
  dishes?: TDish[] | null;
  currentCoverImageUrl?: string | null;
  previousDishes?: ReadonlyArray<MealImageDish> | null;
}): string | null {
  const dishes = Array.isArray(params.dishes) ? params.dishes : [];
  const currentCover = params.currentCoverImageUrl || null;
  if (!isMealCoverAutoReplaceable(currentCover, [dishes, params.previousDishes])) return currentCover;

  const picked = pickDishCoverImage(dishes);
  if (picked) return picked;
  return currentCover && isMealCoverAutoReplaceable(currentCover, [dishes]) ? currentCover : null;
}

/**
 * 画像の処理 (process-meal-image-jobs) が、できた AI の画像を料理に書くときの、料理とカバーの書き込み (#1487 の整合ゲート)。
 * カバーは deriveMealCoverImage (カバーの持ち主の決まり) で決め、変わるとき (coverChanged) だけ書く。
 * 変わらないときは、画像の処理は献立の image_url を書かない (読んでから書くまでに利用者が付けたカバーを、古い値で上書きしないため)
 */
export function applyGeneratedDishImage<TDish extends MealImageDish>(params: {
  dishes: TDish[];
  dishIndex: number;
  imageUrl: string;
  generatedAt: string;
  currentCoverImageUrl: string | null | undefined;
}): { dishes: TDish[]; coverImageUrl: string | null; coverChanged: boolean } {
  const updatedDishes = [...params.dishes];
  const target = updatedDishes[params.dishIndex];
  if (target) {
    updatedDishes[params.dishIndex] = {
      ...target,
      image_url: params.imageUrl,
      image_status: 'ready',
      image_generated_at: params.generatedAt,
      image_error: null,
      image_source: 'generated_ai',
    };
  }
  const currentCover = params.currentCoverImageUrl || null;
  const coverImageUrl = deriveMealCoverImage({
    dishes: updatedDishes,
    currentCoverImageUrl: currentCover,
    previousDishes: params.dishes,
  });
  return { dishes: updatedDishes, coverImageUrl, coverChanged: coverImageUrl !== currentCover };
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

  const previousMealIsCatalog = params.previousMealIsCatalog === true;
  // AI の作り直しで料理が変わったときに、利用者の画像 (料理の写真・手で付けた画像・献立のカバー) を外すか (#1553)
  const releaseUserImagesOnChange = params.regeneration === true && !previousMealIsCatalog;
  /** 前回と比べて料理が変わったか (料理の数が違う・中身が変わった料理がある)。#1553 の作り直しのカバーの扱いに使う */
  let mealDishesChanged = previousDishes.length !== nextDishes.length;

  const dishes: TDish[] = [];
  let jobs: MealImageJobSeed[] = [];
  const buildDishJobSeed = (dish: MealImageDish, index: number, subjectHash: string, prompt: string): MealImageJobSeed => ({
    dishIndex: index,
    dishName: String(dish.name ?? '').trim() || `dish-${index + 1}`,
    subjectHash,
    prompt,
    model,
    triggerSource: params.triggerSource,
    referenceImageUrls: [],
  });
  /** AI の画像のジョブを積もうとした料理 (献立のカバーを守るために積むのをやめるとき、料理の状態を戻すのに使う) */
  const jobDishes: Array<{ index: number; sameSubject: boolean; previousDish: TDish | undefined }> = [];
  /** 料理ごとの subject_hash とプロンプト (AI の作り直しで、カバーに頼っていた料理を AI の画像へ回すときに使う。#1553) */
  const dishSubjects: Array<{ subjectHash: string; prompt: string }> = [];

  for (let index = 0; index < nextDishes.length; index += 1) {
    const nextDish = nextDishes[index];
    // 商品の献立の、画像の項目の無い古い商品の料理は、商品の料理として読む (#1487 の整合ゲート。asCatalogMealDish)
    const rawPreviousDish: TDish | null | undefined = previousDishes[index];
    const previousDish = rawPreviousDish ? asCatalogMealDish(rawPreviousDish, index, previousMealIsCatalog) : undefined;
    const prompt = buildDishImagePrompt(nextDish);
    const subjectHash = await buildDishImageSubjectHash(nextDish, index);
    // 前回の料理が subject_hash を持たない (写真・商品の料理、端末から直に保存した料理) ときは、前回の料理の中身から求める (#1487 の整合ゲート)。
    // 持たないだけで「料理が変わった」とみなすと、完了の切り替えのような保存し直しでも AI の画像のジョブを積んでしまう
    const previousSubjectHash = previousDish
      ? previousDish.image_subject_hash ?? await buildDishImageSubjectHash(previousDish, index)
      : null;
    const sameSubject = previousSubjectHash === subjectHash;
    if (!sameSubject) mealDishesChanged = true;
    dishSubjects.push({ subjectHash, prompt });
    // AI の作り直しで中身が変わった料理は、前回の写真・手で付けた画像を写さない (#1553。新しい料理の AI の画像を作る)
    const releasePreviousDishImage = releaseUserImagesOnChange && !!previousDish && !sameSubject;

    const reconciledDish: TDish = {
      ...nextDish,
      image_prompt: prompt,
      image_model: model,
      image_subject_hash: subjectHash,
    };

    // 写真・商品・手で付けた画像 (と source の無い画像) は、料理の中身を変えても AI の画像で置き換えない (#1487 の整合ゲート)。
    // ジョブを積まず、前回の画像と状態をそのまま写す。手で付けた画像だけは、料理を変えたら今までどおり 'stale' にする。
    // subject_hash は付けない (画像の処理は、料理の subject_hash とジョブの subject_hash が同じときだけ書くので、
    // 付けなければ同じ料理の待ちのジョブが残っていても、この画像を上書きしない)。
    // 新しく作る入口 (POST) で送られた写真・商品・手の画像の料理も、前回の料理と同じく保持する (preserveSubmittedDishImages)
    const preservedSource: MealImageDish | null = previousDish
      ? (!releasePreviousDishImage && isPreservedDishImage(previousDish) ? previousDish : null)
      : (params.preserveSubmittedDishImages === true && isSubmittedPreservedDishImage(nextDish) ? nextDish : null);
    if (preservedSource) {
      const manualOverrideChanged = preservedSource === previousDish &&
        preservedSource.image_source === 'manual_override' && !!preservedSource.image_url && !sameSubject;
      reconciledDish.image_subject_hash = null;
      reconciledDish.image_url = preservedSource.image_url ?? null;
      reconciledDish.image_source = preservedSource.image_source ?? null;
      reconciledDish.image_status = manualOverrideChanged ? 'stale' : preservedSource.image_status ?? null;
      reconciledDish.image_generated_at = preservedSource.image_generated_at ?? null;
      reconciledDish.image_error = manualOverrideChanged ? null : preservedSource.image_error ?? null;
      dishes.push(reconciledDish);
      continue;
    }

    if (sameSubject && previousDish) {
      if (!isAiImagePipelineDish(previousDish)) {
        // AI の画像の料理だと分からない料理 (subject_hash も source も無い) を変えずに保存し直した: 前回のまま写し、積まない。
        // 状態を 'pending' にすると、処理するジョブが無いので「生成中」のまま残る
        reconciledDish.image_subject_hash = previousDish.image_subject_hash ?? null;
        reconciledDish.image_url = previousDish.image_url ?? null;
        reconciledDish.image_source = previousDish.image_source ?? null;
        reconciledDish.image_status = previousDish.image_status ?? null;
        reconciledDish.image_generated_at = previousDish.image_generated_at ?? null;
        reconciledDish.image_error = previousDish.image_error ?? null;
        dishes.push(reconciledDish);
        continue;
      }
      // 前回と同じ料理でも、画像がまだ無く待ち・失敗のままなら積み直す (#1487。見送った料理・積めなかった料理を、保存し直すと直す)
      if (!needsImageRetry(previousDish)) {
        reconciledDish.image_url = previousDish.image_url ?? null;
        reconciledDish.image_source = previousDish.image_source ?? 'generated_ai';
        reconciledDish.image_status = previousDish.image_status ?? 'pending';
        reconciledDish.image_generated_at = previousDish.image_generated_at ?? null;
        reconciledDish.image_error = previousDish.image_error ?? null;
        dishes.push(reconciledDish);
        continue;
      }
    }

    reconciledDish.image_url = null;
    reconciledDish.image_source = 'generated_ai';
    // 前回と同じ料理の積み直しは 'pending' (前回の画像は無いので、更新待ちの 'stale' ではない)
    reconciledDish.image_status = previousDish && !sameSubject ? 'stale' : 'pending';
    reconciledDish.image_generated_at = null;
    reconciledDish.image_error = null;
    dishes.push(reconciledDish);
    jobDishes.push({ index, sameSubject, previousDish });

    jobs.push(buildDishJobSeed(nextDish, index, subjectHash, prompt));
  }

  // billing/03 §8.8・Q-16: 主菜の引き継ぎ。前の主菜を消した・前の主菜の役割を外したことで、自動の料理画像の位置が、中身・役割・位置の
  // 変わらない画像の無い料理へ移ったら、その料理に種を 1 本足す (for の中では「前回のまま写し、積まない」に当たるため。献立のカバーを 1 枚残す)。
  // 位置が移らない保存し直し (完了の切り替えなど) では足さない (autoImageDishHandoverIndexOf)。足した料理は jobDishes にも入れるので、
  // 下の「献立のカバーが写真・商品の料理のもの」の判定に当たれば前の状態 (画像の無い状態) に戻る
  const handoverDishIndex = autoImageDishHandoverIndexOf({
    previousDishes,
    dishes,
    seededDishIndexes: jobs.map((job) => job.dishIndex),
  });
  if (handoverDishIndex !== null) {
    const unchangedDish = dishes[handoverDishIndex];
    const { subjectHash, prompt } = dishSubjects[handoverDishIndex];
    const handedOver: TDish = {
      ...unchangedDish,
      image_subject_hash: subjectHash,
      image_url: null,
      image_source: 'generated_ai',
      // 前回の画像の無い料理の画像を作るので 'pending' (同じ料理の積み直しと同じ決まり)
      image_status: 'pending',
      image_generated_at: null,
      image_error: null,
    };
    dishes[handoverDishIndex] = handedOver;
    jobDishes.push({ index: handoverDishIndex, sameSubject: true, previousDish: unchangedDish });
    jobs.push(buildDishJobSeed(handedOver, handoverDishIndex, subjectHash, prompt));
    jobs.sort((a, b) => a.dishIndex - b.dishIndex);
  }

  // AI の作り直しで料理が変わったら、利用者のカバー (AI の料理の画像でないカバー) を外す (#1553)。
  // 外したカバーは無いものとして、ジョブを積むか (下の判定) とカバーの選び直し (deriveMealCoverImage) を決める
  const releaseOnRegeneration = releaseUserImagesOnChange && mealDishesChanged;
  const currentCoverImageUrl = params.fallbackMealImageUrl ?? null;
  const releaseUserCover = releaseOnRegeneration &&
    !isMealCoverAutoReplaceable(currentCoverImageUrl, [dishes, previousDishes]);
  const mealCoverForOwnership = releaseUserCover ? null : currentCoverImageUrl;

  // AI の作り直しで料理が変わったら、料理ごとの画像を持たずカバーに頼っていた写真・商品・手の画像の料理
  // (写真の複数の料理の、中身が同じまま残った料理など) も AI の画像の料理にしてジョブを積む (#1553)。
  // 写真のカバーは上で外すので、残すと画像がどこにも無いまま「再生成待ち」の写真の印の料理になり、あとから画像を作る経路も無い
  // (needsImageRetry は写真の料理を積み直さない)。外すカバーが空・AI の画像のときも、その料理に画像が無いのは同じなので回す。
  // 回したあとはカバーに頼る料理が残らないので、下の「ジョブを積まない」判定には当たらない
  // 主菜でない料理に回した種は、最後の絞り込み (billing/03 Q-16) で落ちて画像の無い状態になる
  if (releaseOnRegeneration) {
    for (let index = 0; index < dishes.length; index += 1) {
      if (!isImagelessCoverReadyDish(dishes[index])) continue;
      const { subjectHash, prompt } = dishSubjects[index];
      const released: TDish = {
        ...dishes[index],
        image_subject_hash: subjectHash,
        image_url: null,
        image_source: 'generated_ai',
        // ここに来るのは前回と同じ料理 (中身が変わった料理は、上で前回の写真・手の画像を写さず積んでいる) なので、
        // 前回の画像の無い料理の画像を作る 'pending' (更新待ちの 'stale' ではない。同じ料理の積み直しと同じ決まり)
        image_status: 'pending',
        image_generated_at: null,
        image_error: null,
      };
      dishes[index] = released;
      jobs.push(buildDishJobSeed(released, index, subjectHash, prompt));
    }
    jobs.sort((a, b) => a.dishIndex - b.dishIndex);
  }

  // 献立のカバーが、料理ごとの画像を持たない写真・商品の料理のもの (写真の複数の料理・画像の項目の無い商品の料理) なら、
  // AI の画像のジョブを積まない (#1487 の整合ゲート。写真・商品の献立の料理には AI の画像を作らない、いまの決まり。
  // 料理を足した・写真の料理以外の料理を変えたときも)。カバーそのものはカバーの持ち主の決まり (deriveMealCoverImage) が守る。
  // 積むのをやめた料理は、前回と同じ料理なら前回の状態をそのまま写す ('pending' にすると、処理するジョブが無いので「生成中」のまま残る)。
  // それ以外 (足した料理・中身を変えた料理) は画像の無い状態 (状態なし。画面は「生成中」「再生成待ち」を出さない) にし、
  // subject_hash も付けない (AI の画像の料理とみなさず、次に変えずに保存し直しても積み直さない)
  if (jobs.length > 0 && isMealCoverHeldByImagelessPreservedDish(dishes, mealCoverForOwnership)) {
    for (const { index, sameSubject, previousDish } of jobDishes) {
      const kept: TDish = { ...dishes[index] };
      if (sameSubject && previousDish) {
        kept.image_subject_hash = previousDish.image_subject_hash ?? null;
        kept.image_url = previousDish.image_url ?? null;
        kept.image_source = previousDish.image_source ?? null;
        kept.image_status = previousDish.image_status ?? null;
        kept.image_generated_at = previousDish.image_generated_at ?? null;
        kept.image_error = previousDish.image_error ?? null;
      } else {
        kept.image_subject_hash = null;
        kept.image_url = null;
        kept.image_source = null;
        kept.image_status = null;
        kept.image_generated_at = null;
        kept.image_error = null;
      }
      dishes[index] = kept;
    }
    jobs = [];
  }

  // billing/03 §8.8・Q-16: 自動の料理画像は献立の主菜の 1 品だけに作る (autoImageDishIndexOf)。ほかの料理に積もうとした種は積まず、
  // その料理を画像の無い状態にする ('pending' / 'stale' のまま残すと、処理するジョブが無いので「生成中」に見える)。
  // 前回の画像や状態を写した料理 (種を作らなかった料理) はここで触らないので、段 B の前に作られた画像は消えない
  const autoImageDishIndex = autoImageDishIndexOf(dishes);
  if (jobs.some((job) => job.dishIndex !== autoImageDishIndex)) {
    for (const job of jobs) {
      if (job.dishIndex !== autoImageDishIndex) dishes[job.dishIndex] = withoutAutoDishImage(dishes[job.dishIndex]);
    }
    jobs = jobs.filter((job) => job.dishIndex === autoImageDishIndex);
  }

  return {
    dishes,
    jobs,
    // カバーの持ち主の決まり (isMealCoverAutoReplaceable): いまのカバーが写真・商品・利用者の画像なら、そのまま返す。
    // 前回の AI の料理の画像だったカバーは、料理の画像から選び直す
    // (AI の作り直しで料理が変わったときは、利用者のカバーを外したうえで選び直す。#1553)
    mealCoverImageUrl: deriveMealCoverImage({
      dishes,
      currentCoverImageUrl: mealCoverForOwnership,
      previousDishes,
    }),
  };
}
