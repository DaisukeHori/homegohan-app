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

/** writeGeneratedDishImage が使う、献立の更新の最小の形 (supabase-js のクライアントの一部。テストで作り物を渡せるように) */
interface PlannedMealUpdateFilter extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: string): PlannedMealUpdateFilter;
  is(column: string, value: null): PlannedMealUpdateFilter;
  select(columns: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export interface PlannedMealWriter {
  from(table: "planned_meals"): {
    update(values: Record<string, unknown>): PlannedMealUpdateFilter;
  };
}

/**
 * できた料理の画像を献立に書く (#1487 の整合ゲート。カバーの持ち主の二重の守り)。
 * nextCover が undefined (カバーを変えない。applyGeneratedDishImage の coverChanged が偽) なら、料理だけを書き、image_url には触れない
 * (読んでから書くまでに利用者が付けたカバーを、古い値で上書きしない)。
 * カバーを変えるときは、読んだときのカバー (currentCover) のままの行にだけ書く。そのあいだにカバーが付け替えられていたら (0 行)、
 * カバーには触れずに料理だけを書く (付け替えたカバーを、古い値から決めたカバーで上書きしない)
 */
export async function writeGeneratedDishImage(
  db: PlannedMealWriter,
  params: {
    mealId: string;
    dishes: unknown[];
    currentCover: string | null;
    nextCover: string | null | undefined;
    updatedAt?: string;
  },
): Promise<void> {
  const updatedAt = params.updatedAt ?? new Date().toISOString();
  if (params.nextCover !== undefined) {
    const guarded = db
      .from("planned_meals")
      .update({ dishes: params.dishes, image_url: params.nextCover, updated_at: updatedAt })
      .eq("id", params.mealId);
    const { data, error } = await (params.currentCover === null
      ? guarded.is("image_url", null)
      : guarded.eq("image_url", params.currentCover)
    ).select("id");
    if (error) throw new Error(`failed to update meal: ${error.message}`);
    if (Array.isArray(data) && data.length > 0) return;
  }

  const { error } = await db
    .from("planned_meals")
    .update({ dishes: params.dishes, updated_at: updatedAt })
    .eq("id", params.mealId);
  if (error) throw new Error(`failed to update meal: ${error.message}`);
}
