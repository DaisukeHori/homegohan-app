import { applyGeneratedDishImage, type MealImageDish } from "../_shared/meal-image.ts";

export interface GeneratedContentPart {
  text?: string;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
}

export function buildImageUploadPath(params: {
  plannedMealId: string;
  jobId: string;
  timestamp?: number;
}): string {
  const timestamp = params.timestamp ?? Date.now();
  return `generated/${params.plannedMealId}/${params.jobId}-${timestamp}.png`;
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

/** 献立の書き込みが使う、update の最小の形 (supabase-js のクライアントの一部。テストで作り物を渡せるように) */
interface PlannedMealUpdateFilter {
  eq(column: string, value: string): PlannedMealUpdateFilter;
  is(column: string, value: null): PlannedMealUpdateFilter;
  select(columns: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export interface PlannedMealWriter {
  from(table: "planned_meals"): {
    update(values: Record<string, unknown>): PlannedMealUpdateFilter;
  };
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

/**
 * 献立の料理を書けなかったとき (0 行) に、読み直して書き直す回数の上限 (最初の 1 回を含む。#1527)。
 * 0 行 = 読んでから書くまでのあいだに、ほかの書き手 (同じ献立の別の料理のワーカー・利用者の保存) が先に書いたということ。
 * 1 つの献立に同時に書くのは、料理ごとのワーカー (料理は数品) と利用者の保存くらいなので、続けて負けるのは数回まで。
 * これを超えて負け続けるのは異常なので、エラーにしてジョブを失敗にする (料理は failed になり、作り直しで積み直せる)
 */
export const MEAL_DISH_WRITE_MAX_ATTEMPTS = 5;

/** 書かずにやめた理由: 献立が消えた / 料理が無くなった / 料理が変わった (ジョブの料理の subject_hash と一致しない) */
export type MealDishWriteSkipReason = "meal_deleted" | "dish_missing" | "dish_changed";

export type MealDishWriteOutcome =
  | { status: "written" }
  | { status: "skipped"; reason: MealDishWriteSkipReason };

/**
 * 読んだ行から、書く料理とカバーを決めた結果。
 * nextCover が undefined ならカバーを変えない (image_url に触れない)
 */
export type MealDishWriteDecision =
  | { kind: "write"; dishes: unknown[]; nextCover: string | null | undefined }
  | { kind: "skip"; reason: MealDishWriteSkipReason };

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
  for (let attempt = 1; attempt <= MEAL_DISH_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const snapshot = await params.read();
    if (!snapshot) return { status: "skipped", reason: "meal_deleted" };
    const decision = params.decide(snapshot);
    if (decision.kind === "skip") return { status: "skipped", reason: decision.reason };

    const values: Record<string, unknown> = { dishes: decision.dishes, updated_at: new Date().toISOString() };
    if (decision.nextCover !== undefined) values.image_url = decision.nextCover;

    let query = db.from("planned_meals").update(values).eq("id", params.mealId);
    query = snapshot.updated_at === null
      ? query.is("updated_at", null)
      : query.eq("updated_at", snapshot.updated_at);
    if (decision.nextCover !== undefined) {
      query = snapshot.image_url === null
        ? query.is("image_url", null)
        : query.eq("image_url", snapshot.image_url);
    }
    const { data, error } = await query.select("id");
    if (error) throw new Error(`failed to update meal: ${error.message}`);
    if (Array.isArray(data) && data.length > 0) return { status: "written" };
  }
  throw new Error(
    `failed to update meal: the meal kept changing while writing (${MEAL_DISH_WRITE_MAX_ATTEMPTS} attempts)`,
  );
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
