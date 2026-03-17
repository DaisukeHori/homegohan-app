import { buildMealImageIdempotencyKey, type MealImageJobSeed } from "./meal-image.ts";

export interface EnqueueMealImageJobsParams {
  supabase: any;
  plannedMealId: string;
  userId: string;
  jobs: MealImageJobSeed[];
  requestId?: string | null;
}

export async function enqueueMealImageJobs(params: EnqueueMealImageJobsParams): Promise<void> {
  if (!params.jobs.length) {
    return;
  }

  const rows = [];
  for (const job of params.jobs) {
    const idempotencyKey = await buildMealImageIdempotencyKey({
      plannedMealId: params.plannedMealId,
      dishIndex: job.dishIndex,
      subjectHash: job.subjectHash,
    });

    rows.push({
      planned_meal_id: params.plannedMealId,
      user_id: params.userId,
      dish_index: job.dishIndex,
      job_kind: "dish",
      subject_hash: job.subjectHash,
      idempotency_key: idempotencyKey,
      prompt: job.prompt,
      model: job.model,
      reference_image_urls: job.referenceImageUrls ?? [],
      status: "pending",
      priority: 100,
      request_id: params.requestId ?? null,
      trigger_source: job.triggerSource,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  await params.supabase
    .from("meal_image_jobs")
    .upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true });
}

export async function cancelPendingMealImageJobs(params: {
  supabase: any;
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
