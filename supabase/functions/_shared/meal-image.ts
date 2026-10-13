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
 * 商品の献立の planned_meals.source_type (lib/catalog-products.ts の buildCatalogMealFields・端末の保存 (apps/mobile/app/meals/new.tsx) が書く)
 */
export const CATALOG_PRODUCT_MEAL_SOURCE_TYPE = 'catalog_product';

/**
 * 商品の献立で、商品の料理がある位置。商品を選ぶ保存 (buildCatalogMealFields・端末の保存) は、料理を商品の料理 1 つだけにする
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
 * 画像の処理も保存し直しも置き換えない)。ジョブを積むかと安全弁の 1 回を数えるかを変えないために、この判定は残している
 */
function isMealCoverHeldByImagelessPreservedDish(
  dishes: ReadonlyArray<MealImageDish>,
  mealCoverImageUrl: string | null | undefined,
): boolean {
  if (!mealCoverImageUrl) return false;
  return dishes.some((dish) => isCoverReadySource(dish.image_source ?? null) && !dish.image_url);
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

  const dishes: TDish[] = [];
  let jobs: MealImageJobSeed[] = [];
  /** AI の画像のジョブを積もうとした料理 (献立のカバーを守るために積むのをやめるとき、料理の状態を戻すのに使う) */
  const jobDishes: Array<{ index: number; sameSubject: boolean; previousDish: TDish | undefined }> = [];

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
      ? (isPreservedDishImage(previousDish) ? previousDish : null)
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

  // 献立のカバーが、料理ごとの画像を持たない写真・商品の料理のもの (写真の複数の料理・画像の項目の無い商品の料理) なら、
  // AI の画像のジョブを積まない (#1487 の整合ゲート。写真・商品の献立の料理には AI の画像を作らない、いまの決まり。
  // 料理を足した・写真の料理以外の料理を変えたときも)。カバーそのものはカバーの持ち主の決まり (deriveMealCoverImage) が守る。
  // 積むのをやめた料理は、前回と同じ料理なら前回の状態をそのまま写す ('pending' にすると、処理するジョブが無いので「生成中」のまま残る)。
  // それ以外 (足した料理・中身を変えた料理) は画像の無い状態 (状態なし。画面は「生成中」「再生成待ち」を出さない) にし、
  // subject_hash も付けない (AI の画像の料理とみなさず、次に変えずに保存し直しても積み直さない)
  if (jobs.length > 0 && isMealCoverHeldByImagelessPreservedDish(dishes, params.fallbackMealImageUrl)) {
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

  return {
    dishes,
    jobs,
    // カバーの持ち主の決まり (isMealCoverAutoReplaceable): いまのカバーが写真・商品・利用者の画像なら、そのまま返す。
    // 前回の AI の料理の画像だったカバーは、料理の画像から選び直す
    mealCoverImageUrl: deriveMealCoverImage({
      dishes,
      currentCoverImageUrl: params.fallbackMealImageUrl,
      previousDishes,
    }),
  };
}
