import {
  applyGeneratedDishImage,
  MEAL_DISH_WRITE_MAX_ATTEMPTS,
  MealDishWriteExhaustedError,
  type MealImageDish,
  type PlannedMealLockedWriteDecision,
  type PlannedMealLockedWriteOutcome,
  type PlannedMealWriter,
  writePlannedMealDishesWithOptimisticLock,
} from "../_shared/meal-image.ts";

// 楽観的な排他の書き込み (#1527) は、積めなかった料理の印付け (markEnqueueFailedDishesInMeal) と共通にした (#1532)。
// ここからも同じ名前で使えるように出し直す
export { MEAL_DISH_WRITE_MAX_ATTEMPTS, MealDishWriteExhaustedError, type PlannedMealWriter };

export interface GeneratedContentPart {
  text?: string;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
}

/** buildImageUploadPath が組み立てるパスの頭 (fridge-images バケットの中の、AI の料理の画像の置き場) */
const GENERATED_IMAGE_PATH_PREFIX = "generated/";
/** buildImageUploadPath が組み立てるファイル名の終わり (<jobId>-<timestamp> の後ろ) */
const GENERATED_IMAGE_PATH_SUFFIX = ".png";
/** buildImageUploadPath の <timestamp> の部分 (Date.now() のミリ秒。数字だけ) */
const GENERATED_IMAGE_TIMESTAMP_PATTERN = /^[0-9]+$/;

/** パスの 1 つの区切りに使ってよい ID か (空・区切り文字・相対の指定を含むものは使わない) */
function isSafePathSegment(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

export function buildImageUploadPath(params: {
  plannedMealId: string;
  jobId: string;
  timestamp?: number;
}): string {
  const timestamp = params.timestamp ?? Date.now();
  return `${GENERATED_IMAGE_PATH_PREFIX}${params.plannedMealId}/${params.jobId}-${timestamp}${GENERATED_IMAGE_PATH_SUFFIX}`;
}

/**
 * パスが、そのジョブ (plannedMealId・jobId) が buildImageUploadPath で組み立てた画像のものか (#1553)。
 * 書かずにやめたジョブの画像を Storage から消す前に確かめる。ほかのジョブの画像 (<jobId> が違う・
 * 前の部分が一致するだけの別の ID)・ほかの献立の画像・利用者の画像のパスは偽にする
 */
export function isOwnJobUploadPath(
  path: string,
  params: { plannedMealId: string; jobId: string },
): boolean {
  if (!isSafePathSegment(params.plannedMealId) || !isSafePathSegment(params.jobId)) return false;
  const head = `${GENERATED_IMAGE_PATH_PREFIX}${params.plannedMealId}/${params.jobId}-`;
  if (!path.startsWith(head) || !path.endsWith(GENERATED_IMAGE_PATH_SUFFIX)) return false;
  const timestamp = path.slice(head.length, path.length - GENERATED_IMAGE_PATH_SUFFIX.length);
  return GENERATED_IMAGE_TIMESTAMP_PATTERN.test(timestamp);
}

/**
 * ジョブの料理を失敗の印 (image_status: failed) にできず、料理が生成中 (pending) のまま残ったことを示す、
 * meal_image_jobs.last_error の目印 (#1553)。運用では last_error にこの文字列を含むジョブを探す
 * (docs/operations/meal-image-pipeline.md)
 */
export const DISH_LEFT_PENDING_LAST_ERROR_MARKER = "dish left pending";

/** 料理が生成中のまま残ったときの last_error (ジョブの元の理由のあとに、目印と、印を付けられなかった理由を足す) */
export function formatDishLeftPendingLastError(jobReason: string, cause: unknown): string {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  return `${jobReason} | ${DISH_LEFT_PENDING_LAST_ERROR_MARKER}: ${causeMessage}`;
}

export function extractInlineImageBase64(parts: GeneratedContentPart[] | null | undefined): string | null {
  if (!Array.isArray(parts)) return null;

  for (const part of parts) {
    const mimeType = part?.inlineData?.mimeType;
    const data = part?.inlineData?.data;
    if (mimeType?.startsWith('image/') && data) {
      return data;
    }
  }

  return null;
}

/** 献立の行を読んだときの状態 (planned_meals の id, dishes, image_url, updated_at)。updated_at は楽観的な排他の条件に使う */
export interface PlannedMealSnapshot {
  id: string;
  dishes: unknown;
  image_url: string | null;
  updated_at: string | null;
}

/** 献立の行を読む関数 (無ければ null。読めなければ例外)。書けなかったとき (0 行) に読み直すのにも使う */
export type PlannedMealReader = () => Promise<PlannedMealSnapshot | null>;

/** 書かずにやめた理由: 献立が消えた / 料理が無くなった / 料理が変わった (ジョブの料理の subject_hash と一致しない) */
export type MealDishWriteSkipReason = "meal_deleted" | "dish_missing" | "dish_changed";

export type MealDishWriteOutcome = PlannedMealLockedWriteOutcome<MealDishWriteSkipReason>;

/**
 * 読んだ行から、書く料理とカバーを決めた結果。
 * nextCover が undefined ならカバーを変えない (image_url に触れない)
 */
export type MealDishWriteDecision = PlannedMealLockedWriteDecision<MealDishWriteSkipReason>;

/**
 * 献立の料理を、読んだときの行のままの場合にだけ書く (楽観的な排他。#1527)。
 * 読む → decide で料理とカバーを決める → 読んだときの updated_at の行にだけ書く。0 行なら (読んでから書くまでに
 * 別のワーカー・利用者が書いた)、読み直して、最新の料理に決め直して書き直す。MEAL_DISH_WRITE_MAX_ATTEMPTS 回で書けなければ例外。
 * 以前は 0 行のときに、読んだときの古い料理を条件なしで書いており、別のワーカーが先に書いた料理の画像や、
 * 利用者が付けた料理の画像を巻き戻していた。
 * updated_at は planned_meals の更新のトリガー (trg_planned_meals_updated_at) が更新のたびに now() にするので、
 * どの書き手が書いても変わる (書き手が updated_at を送らなくても)。
 * カバーを変えるときは、読んだときのカバーのままの行にだけ書く条件も重ねる (#1487 の整合ゲートのカバーの持ち主の二重の守り)
 */
export async function writeMealDishesWithOptimisticLock(
  db: PlannedMealWriter,
  params: {
    mealId: string;
    read: PlannedMealReader;
    decide: (snapshot: PlannedMealSnapshot) => MealDishWriteDecision;
  },
): Promise<MealDishWriteOutcome> {
  return await writePlannedMealDishesWithOptimisticLock(db, params);
}

/** 読んだ行の料理の配列と、ジョブの料理 (dishIndex の料理が無い・subject_hash が違うなら、書かずにやめる理由) */
function findJobDish(
  snapshot: PlannedMealSnapshot,
  dishIndex: number,
  subjectHash: string | null,
): { dishes: MealImageDish[]; target: MealImageDish } | { skip: MealDishWriteSkipReason } {
  const dishes = Array.isArray(snapshot.dishes) ? (snapshot.dishes as MealImageDish[]) : [];
  const target = dishes[dishIndex];
  if (!target) return { skip: "dish_missing" };
  if (target.image_subject_hash !== subjectHash) return { skip: "dish_changed" };
  return { dishes, target };
}

/**
 * できた料理の画像を献立に書く (#1487 の整合ゲート・#1527)。
 * 書くたびに読んだ最新の料理に、ジョブの料理の画像だけを当てて書く (ほかの料理は読んだときのまま。楽観的な排他で、
 * 読んでから書くまでにほかの書き手が書いていたら、読み直して当て直す)。
 * カバーはカバーの持ち主の決まり (applyGeneratedDishImage → isMealCoverAutoReplaceable) で決め、変わらないとき
 * (coverChanged が偽) は image_url に触れない (利用者が付けたカバーを、古い値で上書きしない)。
 * ジョブの料理が無い・変わった・献立が消えたなら、書かずに skipped を返す (呼び出し元はジョブを取り消す)
 */
export async function writeGeneratedDishImage(
  db: PlannedMealWriter,
  params: {
    mealId: string;
    dishIndex: number;
    subjectHash: string | null;
    imageUrl: string;
    read: PlannedMealReader;
  },
): Promise<MealDishWriteOutcome> {
  return await writeMealDishesWithOptimisticLock(db, {
    mealId: params.mealId,
    read: params.read,
    decide: (snapshot) => {
      const found = findJobDish(snapshot, params.dishIndex, params.subjectHash);
      if ("skip" in found) return { kind: "skip", reason: found.skip };
      const applied = applyGeneratedDishImage({
        dishes: found.dishes,
        dishIndex: params.dishIndex,
        imageUrl: params.imageUrl,
        generatedAt: new Date().toISOString(),
        currentCoverImageUrl: snapshot.image_url,
      });
      return {
        kind: "write",
        dishes: applied.dishes,
        nextCover: applied.coverChanged ? applied.coverImageUrl : undefined,
      };
    },
  });
}

/**
 * ジョブの料理を失敗 (image_status: failed + 理由) にする (#1527)。
 * 画像を書くときと同じく、書くたびに読んだ最新の料理のうちジョブの料理だけを変える (楽観的な排他)。
 * 以前は読んだ料理を条件なしで書いており、そのあいだに別のワーカーが書いたほかの料理の画像を巻き戻していた。
 * ジョブの料理が無い・変わった・献立が消えたなら書かない。カバー (image_url) には触れない
 */
export async function writeDishImageFailure(
  db: PlannedMealWriter,
  params: {
    mealId: string;
    dishIndex: number;
    subjectHash: string | null;
    reason: string;
    read: PlannedMealReader;
  },
): Promise<MealDishWriteOutcome> {
  return await writeMealDishesWithOptimisticLock(db, {
    mealId: params.mealId,
    read: params.read,
    decide: (snapshot) => {
      const found = findJobDish(snapshot, params.dishIndex, params.subjectHash);
      if ("skip" in found) return { kind: "skip", reason: found.skip };
      const dishes = [...found.dishes];
      dishes[params.dishIndex] = { ...found.target, image_status: "failed", image_error: params.reason };
      return { kind: "write", dishes, nextCover: undefined };
    },
  });
}
