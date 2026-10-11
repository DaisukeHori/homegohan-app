import {
  buildMealImageJobRecords,
  insertMealImageJobRecords,
  markEnqueueFailedDishesInMeal,
  summarizeMealImageJobOutcomes,
  type EnqueueMealImageJobsResult,
  type MealImageJobSeed,
} from "./meal-image.ts";

export type { EnqueueMealImageJobsResult } from "./meal-image.ts";

export interface EnqueueMealImageJobsParams {
  /** service role のクライアント。meal_image_jobs は利用者 (authenticated) から書けない (#1465) */
  supabase: any;
  plannedMealId: string;
  userId: string;
  jobs: MealImageJobSeed[];
  requestId?: string | null;
}

/**
 * 料理画像のジョブを積む (service role)。行ごとに insert し、積めた・重複・失敗を数えて返す。例外は投げない (#1505)。
 * 積み方は Next.js の lib/meal-image-jobs.ts と同じ (共通の部分は ./meal-image.ts の insertMealImageJobRecords)。
 * 以前は 1 回の upsert (onConflict: 'idempotency_key') で、冪等キーの一意な索引が部分索引のため 42P10 で必ず失敗し、
 * エラーも見ていなかったので、献立の生成 (generate-menu-v4 / v5 の saveMealToDb) の料理画像のジョブが 1 行も積まれていなかった。
 *
 * 書き込みに失敗した料理は、保存済みの献立の上で 'failed' + 'enqueue_failed' にする ('pending' のまま「生成中」に残さない)。
 * 重複 (同じ料理のジョブが待ち・処理中) の料理は 'pending' のまま (そのジョブが画像を作る)。
 * 呼び出し側は、積めた・重複の行があるときに triggerMealImageJobProcessing で処理を起こす
 */
export async function enqueueMealImageJobs(params: EnqueueMealImageJobsParams): Promise<EnqueueMealImageJobsResult> {
  if (!params.jobs.length) {
    return { inserted: 0, duplicates: 0, failed: 0 };
  }

  const records = await buildMealImageJobRecords({
    plannedMealId: params.plannedMealId,
    userId: params.userId,
    seeds: params.jobs,
    requestId: params.requestId ?? null,
  });
  const outcomes = await insertMealImageJobRecords(
    records,
    (record) => params.supabase.from("meal_image_jobs").insert(record),
  );

  const failures: Array<{ dishIndex: number; subjectHash: string }> = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== "failed") continue;
    failures.push({ dishIndex: outcome.dishIndex, subjectHash: outcome.subjectHash });
    console.warn("[meal-image-jobs] Failed to enqueue meal image job", {
      plannedMealId: params.plannedMealId,
      dishIndex: outcome.dishIndex,
      code: outcome.code,
      error: outcome.message,
    });
  }

  if (failures.length > 0) {
    const marked = await markEnqueueFailedDishesInMeal({
      failures,
      loadMeal: () =>
        params.supabase.from("planned_meals").select("dishes").eq("id", params.plannedMealId).maybeSingle(),
      saveDishes: (dishes) =>
        params.supabase
          .from("planned_meals")
          .update({ dishes, updated_at: new Date().toISOString() })
          .eq("id", params.plannedMealId),
    });
    if (marked.status === "error") {
      console.warn("[meal-image-jobs] Failed to mark dishes whose jobs were not enqueued", {
        plannedMealId: params.plannedMealId,
        error: marked.message,
      });
    }
  }

  return summarizeMealImageJobOutcomes(outcomes);
}

/**
 * 献立の待ち・処理中の画像のジョブを取り消す。
 * supabase は service role のクライアント。meal_image_jobs は利用者 (authenticated) から書けない (#1465)。
 * RLS が効かないので、userId (本人) の行に絞る
 */
export async function cancelPendingMealImageJobs(params: {
  supabase: any;
  userId: string;
  plannedMealId: string;
  reason?: string;
}): Promise<void> {
  await params.supabase
    .from("meal_image_jobs")
    .update({
      status: "cancelled",
      last_error: params.reason ?? "Cancelled for photo overwrite",
      lease_token: null,
      leased_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("planned_meal_id", params.plannedMealId)
    .eq("user_id", params.userId)
    .in("status", ["pending", "processing"]);
}

export async function triggerMealImageJobProcessing(params: {
  supabaseUrl: string;
  serviceRoleKey: string;
  plannedMealId?: string | null;
  limit?: number | null;
}): Promise<void> {
  if (!params.supabaseUrl || !params.serviceRoleKey) {
    console.warn("Skipping meal image worker trigger: missing Supabase env");
    return;
  }

  try {
    const response = await fetch(`${params.supabaseUrl}/functions/v1/process-meal-image-jobs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${params.serviceRoleKey}`,
        "apikey": params.serviceRoleKey,
      },
      body: JSON.stringify({
        plannedMealId: params.plannedMealId ?? null,
        limit: params.limit ?? null,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.warn("Meal image worker trigger failed:", response.status, errorText);
    }
  } catch (error) {
    console.warn("Meal image worker trigger errored:", error);
  }
}
