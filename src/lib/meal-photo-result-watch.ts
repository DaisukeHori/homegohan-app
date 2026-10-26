// 週間献立の「写真から入力」(mealId つきの /api/ai/analyze-meal-photo) の結果が、献立に書かれるまで待つ (#2047)。
//
// mealId の経路では、route は Edge の analyze-meal-photo を呼び、Edge は 200 を返してから背景の処理
// (EdgeRuntime.waitUntil) で解析して planned_meals を書く (10〜20 秒かかる)。以前の画面は「写真解析は同期的に行われる」
// という前提で、route の 200 のすぐあとに 1 回だけ献立を読み直していた。そのときはまだ解析が終わっていないので、
// 解析の前の献立を画面とキャッシュ (weekDataCache) に置き、結果は開き直すまで画面に出なかった。
//
// ここでは、解析の結果が書かれたことが分かるまで、上限つきで献立を読み直す。
//   - 結果が書かれた印: Edge の書き込みは、料理ごとに image_source = 'meal_photo' と、書いた時刻の image_generated_at を置く
//     (supabase/functions/_shared/meal-image.ts の buildPhotoDishList)。解析を頼む前の献立に無かった image_generated_at を持つ
//     'meal_photo' の料理が現れたら、この解析の結果が書かれたとみる。料理が 0 品の結果 (料理を読み取れなかった) は印が無いので、
//     料理が 0 品になり、かつ中身 (料理名・画像・説明・料理) が頼む前から変わったことで見分ける。
//   - updated_at は印に使えない: Edge は解析の前に行に CAS の印を付ける (updated_at を進める。_shared/meal-photo-cas.ts)ので、
//     updated_at は解析の前にも一度変わる。
//   - 解析のあいだに行がほかの書き手に書かれると、Edge は写真の結果を書かずにやめる (#2041 の CAS)。解析そのものが失敗したときも
//     書かれない。どちらも結果の印は現れないので、上限 (回数と全体の時間) で止めて timeout を返す。画面はその旨を出す。

/** 献立を読み直す間隔。週の生成・献立の改善のポーリング (page.tsx の 3 秒) とそろえる */
export const PHOTO_RESULT_POLL_INTERVAL_MS = 3_000;

/**
 * 結果を待つ全体の時間。Edge の背景の解析はふだん 10〜20 秒で終わる。画像の認識 (Gemini) が遅い日でも待てるよう、
 * その数倍をとる。過ぎたら待つのをやめて、その旨を画面に出す (画面が待ち続けないように)
 */
export const PHOTO_RESULT_POLL_TIMEOUT_MS = 120_000;

/** 読み直しの上限の回数 (全体の時間 ÷ 間隔)。時間と回数の両方で止める (読み直しが遅くても、速くても上限がある) */
export const PHOTO_RESULT_MAX_POLLS = Math.ceil(PHOTO_RESULT_POLL_TIMEOUT_MS / PHOTO_RESULT_POLL_INTERVAL_MS);

/** 上限まで待っても結果が書かれなかったときの表示 */
export const PHOTO_RESULT_TIMEOUT_TITLE = '写真の解析の結果をまだ反映できていません';
export const PHOTO_RESULT_TIMEOUT_MESSAGE =
  '解析に時間がかかっているか、解析のあいだに献立が更新されたため、結果をまだ献立に反映できていません。少し待ってから画面を開き直してください。結果が出ないときは、もう一度写真から入力してください。';

/** 待っているあいだに献立が見つからなくなった (削除された) ときの表示 */
export const PHOTO_RESULT_MEAL_MISSING_TITLE = '写真の解析の結果を反映できませんでした';
export const PHOTO_RESULT_MEAL_MISSING_MESSAGE = '解析の対象の献立が見つかりませんでした。削除された可能性があります。';

/** 写真の結果の料理の印 (Edge の buildPhotoDishList が置く image_source) */
const MEAL_PHOTO_IMAGE_SOURCE = 'meal_photo';

/** 印を見る料理の最小の形 (PlannedMeal.dishes の要素 = DishDetail と互換) */
export interface PhotoResultDishLike {
  image_source?: string | null;
  image_generated_at?: string | null;
}

/** 印を見る献立の最小の形 (PlannedMeal と互換) */
export interface PhotoResultMealLike {
  id: string;
  dishName?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  dishes?: ReadonlyArray<PhotoResultDishLike> | null;
}

/** GET /api/meal-plans の本文の、ここで読む部分 */
export interface PhotoResultWeekLike<TMeal extends PhotoResultMealLike = PhotoResultMealLike> {
  dailyMeals?: ReadonlyArray<{ meals?: ReadonlyArray<TMeal> | null }> | null;
}

/** 解析を頼む前の献立の控え (結果が書かれたかを比べる元) */
export interface PhotoResultBaseline {
  /** 頼む前の献立にあった 'meal_photo' の料理の image_generated_at */
  photoMarkers: ReadonlySet<string>;
  /** 頼む前の献立の中身 (料理名・画像・説明・料理) */
  contentSignature: string;
}

function dishesOf(meal: PhotoResultMealLike): ReadonlyArray<PhotoResultDishLike> {
  return Array.isArray(meal.dishes) ? meal.dishes : [];
}

function photoMarkersOf(meal: PhotoResultMealLike): string[] {
  return dishesOf(meal)
    .filter((dish) => dish?.image_source === MEAL_PHOTO_IMAGE_SOURCE && typeof dish.image_generated_at === 'string')
    .map((dish) => dish.image_generated_at as string);
}

function contentSignatureOf(meal: PhotoResultMealLike): string {
  return JSON.stringify({
    dishName: meal.dishName ?? null,
    imageUrl: meal.imageUrl ?? null,
    description: meal.description ?? null,
    dishes: dishesOf(meal),
  });
}

/** 解析を頼む前の献立から、比べる元の控えを作る */
export function photoResultBaseline(meal: PhotoResultMealLike): PhotoResultBaseline {
  return { photoMarkers: new Set(photoMarkersOf(meal)), contentSignature: contentSignatureOf(meal) };
}

/** 週の献立から mealId の献立を探す。無ければ null */
export function findMealInWeek<TMeal extends PhotoResultMealLike>(
  week: PhotoResultWeekLike<TMeal> | null | undefined,
  mealId: string,
): TMeal | null {
  for (const day of week?.dailyMeals ?? []) {
    for (const meal of day?.meals ?? []) {
      if (meal?.id === mealId) return meal;
    }
  }
  return null;
}

/** この献立に、頼んだあとの写真の解析の結果が書かれているか */
export function isPhotoResultWritten(meal: PhotoResultMealLike, baseline: PhotoResultBaseline): boolean {
  if (photoMarkersOf(meal).some((marker) => !baseline.photoMarkers.has(marker))) return true;
  // 料理が 0 品の結果 (料理を読み取れなかった) は料理の印が無い。0 品になって中身が変わったことで見分ける
  return dishesOf(meal).length === 0 && contentSignatureOf(meal) !== baseline.contentSignature;
}

export type PhotoResultWatchOutcome<TWeek> =
  /** 結果が書かれた。week はそれを読んだ週の献立 */
  | { status: 'written'; week: TWeek }
  /** 待っているあいだに献立が見つからなくなった。week はそれを読んだ週の献立 */
  | { status: 'meal_missing'; week: TWeek }
  /** 上限まで待っても結果が書かれなかった。week は最後に読めた週の献立 (1 度も読めなければ null) */
  | { status: 'timeout'; week: TWeek | null }
  /** 呼び出し側が待つのをやめた (アンマウントなど)。何も置かないこと */
  | { status: 'cancelled' };

export interface WaitForMealPhotoResultOptions<TWeek> {
  mealId: string;
  baseline: PhotoResultBaseline;
  /** 週の献立を読む。読めなければ null を返すか投げる (どちらも 1 回の読み直しとして数え、次を待つ) */
  fetchWeek: () => Promise<TWeek | null>;
  /** false を返したら待つのをやめる (cancelled) */
  isActive: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxPolls?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 写真の解析の結果が献立に書かれるまで、間隔をあけて週の献立を読み直す。
 * 回数 (maxPolls) と全体の時間 (timeoutMs) のどちらかの上限で止まり、timeout を返す (待ち続けない)。
 * 読むたびに isActive を確かめ、false なら何も返さずに cancelled を返す。
 */
export async function waitForMealPhotoResult<TWeek extends PhotoResultWeekLike>(
  options: WaitForMealPhotoResultOptions<TWeek>,
): Promise<PhotoResultWatchOutcome<TWeek>> {
  const {
    mealId,
    baseline,
    fetchWeek,
    isActive,
    sleep = defaultSleep,
    now = Date.now,
    pollIntervalMs = PHOTO_RESULT_POLL_INTERVAL_MS,
    timeoutMs = PHOTO_RESULT_POLL_TIMEOUT_MS,
    maxPolls = PHOTO_RESULT_MAX_POLLS,
  } = options;

  const startedAt = now();
  let lastWeek: TWeek | null = null;

  for (let poll = 0; poll < maxPolls; poll++) {
    // 解析は route の 200 のあとに背景で始まるので、読む前に待つ
    await sleep(pollIntervalMs);
    if (!isActive()) return { status: 'cancelled' };
    if (now() - startedAt > timeoutMs) break;

    let week: TWeek | null = null;
    try {
      week = await fetchWeek();
    } catch (error) {
      console.warn('Photo analysis result poll failed:', error);
    }
    if (!isActive()) return { status: 'cancelled' };
    if (week === null) continue;

    lastWeek = week;
    const meal = findMealInWeek(week, mealId);
    if (meal === null) return { status: 'meal_missing', week };
    if (isPhotoResultWritten(meal, baseline)) return { status: 'written', week };
  }

  return { status: 'timeout', week: lastWeek };
}
