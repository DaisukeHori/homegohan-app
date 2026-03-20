import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI, createUserContent } from "@google/genai";
import {
  DEFAULT_MEAL_IMAGE_MODEL,
  deriveMealCoverImage,
  type MealImageDish,
} from "../_shared/meal-image.ts";
import {
  buildImageUploadPath,
  extractInlineImageBase64,
  GeneratedContentPart,
} from "./utils.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const STORAGE_BUCKET = "fridge-images";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_AI_KEY = Deno.env.get("GOOGLE_AI_STUDIO_API_KEY") ?? Deno.env.get("GOOGLE_GEN_AI_API_KEY") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error("Missing SUPABASE_URL or service role key");
}

if (!GOOGLE_AI_KEY) {
  throw new Error("Missing Google AI key for image generation");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const aiClient = new GoogleGenAI({ apiKey: GOOGLE_AI_KEY });

interface MealImageJobRow {
  id: string;
  planned_meal_id: string;
  dish_index: number;
  subject_hash: string | null;
  prompt: string;
  model: string | null;
  reference_image_urls: string[] | null;
  attempt_count: number | null;
}

interface ProcessResponse {
  jobId: string;
  status: "completed" | "failed" | "cancelled" | "skipped";
  message?: string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: JSON_HEADERS });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const apiKey = req.headers.get("apikey")?.trim() ?? "";
  const isInternalCaller = bearerToken === SUPABASE_SERVICE_KEY || apiKey === SUPABASE_SERVICE_KEY;
  if (!isInternalCaller) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  const body = await req.json().catch(() => ({}));
  const plannedMealId = typeof body.plannedMealId === "string" && body.plannedMealId ? body.plannedMealId : undefined;
  const requestedLimit = typeof body.limit === "number" && body.limit > 0 ? Math.min(20, Math.floor(body.limit)) : 5;

  try {
    const jobs = await fetchPendingJobs(plannedMealId, requestedLimit);
    const backgroundTask = processJobs(jobs);

    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      EdgeRuntime.waitUntil(backgroundTask);
      return new Response(
        JSON.stringify({ accepted: jobs.length, status: "processing" }),
        { status: 202, headers: JSON_HEADERS },
      );
    }

    const results = await backgroundTask;
    return new Response(
      JSON.stringify({ processed: results.filter((r) => r.status === "completed").length, jobs: results }),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (error: any) {
    console.error("process-meal-image-jobs error:", error);
    return new Response(JSON.stringify({ error: error?.message ?? String(error) }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
});

async function processJobs(jobs: MealImageJobRow[]): Promise<ProcessResponse[]> {
  const results: ProcessResponse[] = [];
  for (const job of jobs) {
    const outcome = await processJob(job);
    results.push(outcome);
  }
  return results;
}

async function fetchPendingJobs(plannedMealId: string | undefined, limit: number): Promise<MealImageJobRow[]> {
  const query = supabase
    .from("meal_image_jobs")
    .select("id, planned_meal_id, dish_index, subject_hash, prompt, model, reference_image_urls, attempt_count")
    .eq("status", "pending")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (plannedMealId) {
    query.eq("planned_meal_id", plannedMealId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message || "failed to fetch meal image jobs");
  }

  return data ?? [];
}

async function processJob(job: MealImageJobRow): Promise<ProcessResponse> {
  const now = new Date().toISOString();
  const lockToken = crypto.randomUUID();
  const leasedUntil = new Date(Date.now() + 2 * 60_000).toISOString();

  const { data: locked, error: lockError } = await supabase
    .from("meal_image_jobs")
    .update({
      status: "processing",
      lease_token: lockToken,
      leased_until: leasedUntil,
      updated_at: now,
    })
    .eq("id", job.id)
    .eq("status", "pending")
    .select("*")
    .single();

  if (lockError || !locked) {
    return { jobId: job.id, status: "skipped", message: "failed to acquire lock" };
  }

  const nextAttempt = (locked.attempt_count ?? 0) + 1;
  const jobRow: MealImageJobRow = locked;

  try {
    const { data: meal } = await supabase
      .from("planned_meals")
      .select("id, dishes, image_url")
      .eq("id", jobRow.planned_meal_id)
      .maybeSingle();

    if (!meal) {
      await finalizeJob(jobRow.id, lockToken, "cancelled", nextAttempt, "planned meal deleted");
      return { jobId: jobRow.id, status: "cancelled", message: "meal was deleted" };
    }

    const dishes = Array.isArray(meal.dishes) ? (meal.dishes as MealImageDish[]) : [];
    const targetDish = dishes[jobRow.dish_index];

    if (!targetDish) {
      await finalizeJob(jobRow.id, lockToken, "cancelled", nextAttempt, "dish index missing");
      return { jobId: jobRow.id, status: "cancelled", message: "dish missing" };
    }

    if (targetDish.image_subject_hash !== jobRow.subject_hash) {
      await finalizeJob(jobRow.id, lockToken, "cancelled", nextAttempt, "dish signature changed");
      return { jobId: jobRow.id, status: "cancelled", message: "dish schema changed" };
    }

    const imageBase64 = await generateImage(jobRow);
    const uploadPath = buildImageUploadPath({ plannedMealId: jobRow.planned_meal_id, jobId: jobRow.id });
    const imageBytes = base64ToUint8Array(imageBase64);

    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(uploadPath, imageBytes, { contentType: "image/png", upsert: true });

    if (uploadError) {
      throw new Error(`storage upload failed: ${uploadError.message}`);
    }

    const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(uploadPath);
    const publicUrl = pub?.publicUrl ?? "";
    if (!publicUrl) {
      throw new Error("failed to obtain public URL");
    }

    const { data: latestMeal } = await supabase
      .from("planned_meals")
      .select("id, dishes, image_url")
      .eq("id", meal.id)
      .maybeSingle();

    if (!latestMeal) {
      await finalizeJob(jobRow.id, lockToken, "cancelled", nextAttempt, "planned meal deleted");
      return { jobId: jobRow.id, status: "cancelled", message: "meal was deleted" };
    }

    const latestDishes = Array.isArray(latestMeal.dishes) ? (latestMeal.dishes as MealImageDish[]) : [];
    const latestDish = latestDishes[jobRow.dish_index];
    if (!latestDish) {
      await finalizeJob(jobRow.id, lockToken, "cancelled", nextAttempt, "dish index missing");
      return { jobId: jobRow.id, status: "cancelled", message: "dish missing" };
    }

    if (latestDish.image_subject_hash !== jobRow.subject_hash) {
      await finalizeJob(jobRow.id, lockToken, "cancelled", nextAttempt, "dish signature changed");
      return { jobId: jobRow.id, status: "cancelled", message: "dish schema changed" };
    }

    const updatedDish: MealImageDish = {
      ...latestDish,
      image_url: publicUrl,
      image_status: "ready",
      image_generated_at: new Date().toISOString(),
      image_error: null,
      image_source: "generated_ai",
    };
    const updatedDishes = [...latestDishes];
    updatedDishes[jobRow.dish_index] = updatedDish;
    const cover = deriveMealCoverImage({ dishes: updatedDishes, fallbackMealImageUrl: latestMeal.image_url ?? null });

    const { error: mealUpdateError } = await supabase
      .from("planned_meals")
      .update({ dishes: updatedDishes, image_url: cover, updated_at: new Date().toISOString() })
      .eq("id", meal.id);

    if (mealUpdateError) {
      throw new Error(`failed to update meal: ${mealUpdateError.message}`);
    }

    await finalizeJob(jobRow.id, lockToken, "completed", nextAttempt, null, publicUrl);
    return { jobId: jobRow.id, status: "completed", message: publicUrl };
  } catch (error: any) {
    const reason = error?.message ?? "unknown error";
    const finalized = await finalizeJob(jobRow.id, lockToken, "failed", nextAttempt, reason);
    if (finalized) {
      await markDishFailure(jobRow, reason);
    }
    return { jobId: jobRow.id, status: "failed", message: reason };
  }
}

async function finalizeJob(
  jobId: string,
  leaseToken: string,
  status: "completed" | "failed" | "cancelled",
  attemptCount: number,
  lastError: string | null,
  resultImageUrl?: string,
) {
  const { data, error } = await supabase
    .from("meal_image_jobs")
    .update({
      status,
      attempt_count: attemptCount,
      last_error: lastError,
      result_image_url: resultImageUrl ?? null,
      lease_token: null,
      leased_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "processing")
    .eq("lease_token", leaseToken)
    .select("id");

  if (error) {
    console.warn("Failed to finalize meal image job:", jobId, error);
    return false;
  }

  return Array.isArray(data) ? data.length > 0 : Boolean(data);
}

async function markDishFailure(job: MealImageJobRow, reason: string) {
  const { data: meal } = await supabase
    .from("planned_meals")
    .select("id, dishes")
    .eq("id", job.planned_meal_id)
    .maybeSingle();

  if (!meal || !Array.isArray(meal.dishes)) return;
  const dishes = meal.dishes as MealImageDish[];
  const target = dishes[job.dish_index];
  if (!target || target.image_subject_hash !== job.subject_hash) return;

  const failedDish: MealImageDish = {
    ...target,
    image_status: "failed",
    image_error: reason,
  };
  const updatedDishes = [...dishes];
  updatedDishes[job.dish_index] = failedDish;
  await supabase
    .from("planned_meals")
    .update({ dishes: updatedDishes, updated_at: new Date().toISOString() })
    .eq("id", meal.id);
}

async function generateImage(job: MealImageJobRow): Promise<string> {
  const promptText = job.prompt?.trim() || "Delicious Japanese home-cooked dish";
  const response = await aiClient.models.generateContent({
    model: job.model ?? DEFAULT_MEAL_IMAGE_MODEL,
    contents: createUserContent([promptText as string]),
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "1:1" },
    },
  });

  const parts = (response.candidates?.[0]?.content?.parts as GeneratedContentPart[]) ?? [];
  const inline = extractInlineImageBase64(parts);
  if (!inline) {
    throw new Error("image generation returned no binary data");
  }

  return inline;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer;
}
