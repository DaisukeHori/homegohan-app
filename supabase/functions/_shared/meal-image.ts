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
 * 待ちのジョブがまだ残っているときは、同じ冪等キーで積もうとして積まれない (enqueueMealImageJobs が重複として数えない)。
 * reconcileDishImages は、これに加えて「AI の画像の料理だと分かる」(isAiImagePipelineDish) ときだけ積み直す
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

/**
 * 前回の料理の画像を、AI の画像で置き換えずにそのまま残すか (#1487 の整合ゲート)。
 *   - image_source が generated_ai 以外 (meal_photo・catalog・manual_override・none): 残す。
 *     subject_hash の有無・料理の中身の変更によらない (写真や商品の料理は subject_hash を持たない)
 *   - image_source が未設定でも image_url があれば残す。AI の画像を書くのは画像の処理 (process-meal-image-jobs) だけで、
 *     そこは必ず image_source: 'generated_ai' を書く。手で付けた画像も buildDishImagePayload が manual_override を書く。
 *     source の無い画像は、この仕組みの外で付いた画像 (古い写真の記録・商品・外から書いた画像) なので、AI の画像とみなさない。
 *     URL の形 (保存先のバケット名など) では判定しない (保存先は経路ごとに違い、source だけで漏れなく決まるため)
 * AI の画像のジョブを積むのは、image_source が generated_ai か未設定 (で画像の無い) 料理だけ
 */
export function isPreservedDishImage(dish: MealImageDish): boolean {
  const source = dish.image_source ?? null;
  if (source !== null) return source !== 'generated_ai';
  return !!dish.image_url;
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
    // 前回の料理が subject_hash を持たない (写真・商品の料理、端末から直に保存した料理) ときは、前回の料理の中身から求める (#1487 の整合ゲート)。
    // 持たないだけで「料理が変わった」とみなすと、完了の切り替えのような保存し直しでも AI の画像のジョブを積んでしまう
    const previousSubjectHash = previousDish
      ? previousDish.image_subject_hash ?? await buildDishImageSubjectHash(previousDish, index)
      : null;
    const sameSubject = previousSubjectHash === subjectHash;

    const reconciledDish: TDish = {
      ...nextDish,
      image_prompt: prompt,
      image_model: model,
      image_subject_hash: subjectHash,
    };

    // 写真・商品・手で付けた画像 (と source の無い画像) は、料理の中身を変えても AI の画像で置き換えない (#1487 の整合ゲート)。
    // ジョブを積まず、前回の画像と状態をそのまま写す。手で付けた画像だけは、料理を変えたら今までどおり 'stale' にする。
    // subject_hash は付けない (画像の処理は、料理の subject_hash とジョブの subject_hash が同じときだけ書くので、
    // 付けなければ同じ料理の待ちのジョブが残っていても、この画像を上書きしない)
    if (previousDish && isPreservedDishImage(previousDish)) {
      const manualOverrideChanged = previousDish.image_source === 'manual_override' && !!previousDish.image_url && !sameSubject;
      reconciledDish.image_subject_hash = null;
      reconciledDish.image_url = previousDish.image_url ?? null;
      reconciledDish.image_source = previousDish.image_source ?? null;
      reconciledDish.image_status = manualOverrideChanged ? 'stale' : previousDish.image_status ?? null;
      reconciledDish.image_generated_at = previousDish.image_generated_at ?? null;
      reconciledDish.image_error = manualOverrideChanged ? null : previousDish.image_error ?? null;
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
