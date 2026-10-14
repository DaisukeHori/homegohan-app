import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { GoogleGenAI, createUserContent } from "@google/genai";
import {
  DEFAULT_MEAL_IMAGE_MODEL,
  type MealImageDish,
} from "../_shared/meal-image.ts";
import {
  buildImageUploadPath,
  extractInlineImageBase64,
  GeneratedContentPart,
  type MealDishWriteSkipReason,
  type PlannedMealSnapshot,
  writeDishImageFailure,
  writeGeneratedDishImage,
} from "./utils.ts";
import { checkAiConsent, type AiConsentDecision } from "../_shared/ai-consent-guard.ts";
import { aiConsentDeniedPayload } from "../_shared/ai-consent.ts";
import { logMissingEnv, MISSING_ENV_HTTP_STATUS, missingEnvResponseBody } from "../_shared/missing-env.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const STORAGE_BUCKET = "fridge-images";

/**
 * 環境変数は、モジュールの読み込み時ではなくリクエストの処理の中で確かめる (#1467)。
 * 以前は読み込み時に変数名入りの例外を投げており、関数が起動できないうえ、呼び出し元には実行環境の既定の
 * エラーしか返らなかった。いまは欠けていればログに変数名を残し、本文は固定の文と code の 503 を返す。
 * クライアントは最初のリクエストで作り、以後は使い回す (以前の読み込み時の生成と同じく 1 インスタンス 1 個)。
 */
let supabase: SupabaseClient;
let aiClient: GoogleGenAI;
let initialized = false;

function readServiceConfig(): { url: string; serviceKey: string } | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SERVICE_ROLE_JWT") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) {
    // 足りないものだけを名前で残す (鍵は別名のどちらかがあればよいので、両方の名前を出す)
    logMissingEnv([
      ...(url ? [] : ["SUPABASE_URL"]),
      ...(serviceKey ? [] : ["SERVICE_ROLE_JWT", "SUPABASE_SERVICE_ROLE_KEY"]),
    ]);
    return null;
  }
  return { url, serviceKey };
}

function readGoogleAiKey(): string | null {
  const key = Deno.env.get("GOOGLE_AI_STUDIO_API_KEY") ?? Deno.env.get("GOOGLE_GEN_AI_API_KEY") ?? "";
  if (!key) {
    logMissingEnv(["GOOGLE_AI_STUDIO_API_KEY", "GOOGLE_GEN_AI_API_KEY"]);
    return null;
  }
  return key;
}

function missingEnvResponse(): Response {
  return new Response(JSON.stringify(missingEnvResponseBody()), {
    status: MISSING_ENV_HTTP_STATUS,
    headers: JSON_HEADERS,
  });
}

interface MealImageJobRow {
  id: string;
  /** 献立の持ち主。外国の AI 事業者への提供の同意の判定に使う (T15 / #1154) */
  user_id: string | null;
  planned_meal_id: string;
  dish_index: number;
  subject_hash: string | null;
  prompt: string;
  model: string | null;
  reference_image_urls: string[] | null;
  attempt_count: number | null;
}

/**
 * 料理の画像を書かずにやめたとき (献立が消えた・料理が無い・料理が変わった) の、ジョブの last_error と応答の message。
 * 画像を作る前の確かめと、書くとき (writeGeneratedDishImage が読み直したとき) とで同じ文にする
 */
const SKIPPED_DISH_WRITE: Readonly<Record<MealDishWriteSkipReason, { lastError: string; message: string }>> = {
  meal_deleted: { lastError: "planned meal deleted", message: "meal was deleted" },
  dish_missing: { lastError: "dish index missing", message: "dish missing" },
  dish_changed: { lastError: "dish signature changed", message: "dish schema changed" },
};

interface ProcessResponse {
  jobId: string;
  status: "completed" | "failed" | "cancelled" | "skipped";
  message?: string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: JSON_HEADERS });
  }

  // 認証に service role key を使うので、接続情報は認証より先に確かめる。鍵が空のまま比べると、
  // Authorization の無い要求 (空文字) と一致して通ってしまう
  const serviceConfig = readServiceConfig();
  if (!serviceConfig) return missingEnvResponse();

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const apiKey = req.headers.get("apikey")?.trim() ?? "";
  // 名前は以前のモジュール定数と同じにしておく (tests/ai-usage-contract.test.ts が service role の照合をこの名前で見つける)
  const SUPABASE_SERVICE_KEY = serviceConfig.serviceKey;
  const isInternalCaller = bearerToken === SUPABASE_SERVICE_KEY || apiKey === SUPABASE_SERVICE_KEY;
  if (!isInternalCaller) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  const googleAiKey = readGoogleAiKey();
  if (!googleAiKey) return missingEnvResponse();

  if (!initialized) {
    supabase = createClient(serviceConfig.url, serviceConfig.serviceKey);
    aiClient = new GoogleGenAI({ apiKey: googleAiKey });
    initialized = true;
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
  // 同じ利用者のジョブが続くことが多いので、1 回の実行の中では同意の判定を使い回す
  const consentByUser = new Map<string, Promise<AiConsentDecision>>();
  for (const job of jobs) {
    const outcome = await processJob(job, consentByUser);
    results.push(outcome);
  }
  return results;
}

async function fetchPendingJobs(plannedMealId: string | undefined, limit: number): Promise<MealImageJobRow[]> {
  const query = supabase
    .from("meal_image_jobs")
    .select("id, user_id, planned_meal_id, dish_index, subject_hash, prompt, model, reference_image_urls, attempt_count")
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

async function processJob(
  job: MealImageJobRow,
  consentByUser: Map<string, Promise<AiConsentDecision>>,
): Promise<ProcessResponse> {
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

  // 料理の画像の作成は、献立の料理名などを外国の AI 事業者 (Google) へ送る。
  // 献立の持ち主の同意が無ければ (判定に失敗した場合・持ち主が分からない場合も)、送らずにジョブを取り消す (T15 / #1154。fail-closed)
  const ownerId = typeof jobRow.user_id === "string" ? jobRow.user_id : "";
  let consent = consentByUser.get(ownerId);
  if (!consent) {
    consent = checkAiConsent(supabase, ownerId);
    consentByUser.set(ownerId, consent);
  }
  const decision = await consent;
  if (!decision.allowed) {
    const reason = aiConsentDeniedPayload(decision).body.code;
    const finalized = await finalizeJob(jobRow.id, lockToken, "cancelled", nextAttempt, reason);
    if (finalized) {
      await markDishFailure(jobRow, reason);
    }
    return { jobId: jobRow.id, status: "cancelled", message: reason };
  }

  try {
    const { data: meal } = await supabase
      .from("planned_meals")
      .select("id, dishes, image_url")
      .eq("id", jobRow.planned_meal_id)
      .maybeSingle();

    if (!meal) {
      return await cancelSkippedJob(jobRow.id, lockToken, nextAttempt, "meal_deleted");
    }

    const dishes = Array.isArray(meal.dishes) ? (meal.dishes as MealImageDish[]) : [];
    const targetDish = dishes[jobRow.dish_index];

    if (!targetDish) {
      return await cancelSkippedJob(jobRow.id, lockToken, nextAttempt, "dish_missing");
    }

    if (targetDish.image_subject_hash !== jobRow.subject_hash) {
      return await cancelSkippedJob(jobRow.id, lockToken, nextAttempt, "dish_changed");
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

    // 書くたびに献立を読み直し、最新の料理にこのジョブの料理の画像だけを当てて、読んだときの行のままの場合にだけ書く
    // (楽観的な排他。#1527。読んでから書くまでに別のワーカーや利用者が書いていたら、読み直して当て直す)。
    // カバーはカバーの持ち主の決まり (isMealCoverAutoReplaceable。#1487 の整合ゲート) で決め、変わらないときは image_url を書かない。
    // 写真・商品・利用者の画像のカバーは置き換えない
    const written = await writeGeneratedDishImage(supabase, {
      mealId: meal.id,
      dishIndex: jobRow.dish_index,
      subjectHash: jobRow.subject_hash,
      imageUrl: publicUrl,
      read: () => readMealSnapshot(meal.id),
    });
    if (written.status === "skipped") {
      return await cancelSkippedJob(jobRow.id, lockToken, nextAttempt, written.reason);
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

/** 料理の画像を書かずにやめたジョブを取り消す (料理は書き換えない) */
async function cancelSkippedJob(
  jobId: string,
  leaseToken: string,
  attemptCount: number,
  reason: MealDishWriteSkipReason,
): Promise<ProcessResponse> {
  const skipped = SKIPPED_DISH_WRITE[reason];
  await finalizeJob(jobId, leaseToken, "cancelled", attemptCount, skipped.lastError);
  return { jobId, status: "cancelled", message: skipped.message };
}

/** 献立の行を読む (楽観的な排他の条件の updated_at も)。無ければ null。読めなければ例外 (ジョブを失敗にする) */
async function readMealSnapshot(mealId: string): Promise<PlannedMealSnapshot | null> {
  const { data, error } = await supabase
    .from("planned_meals")
    .select("id, dishes, image_url, updated_at")
    .eq("id", mealId)
    .maybeSingle();
  if (error) throw new Error(`failed to read meal: ${error.message}`);
  return data ?? null;
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

/**
 * ジョブの料理を失敗にする (#1527。読んだ最新の料理のうちジョブの料理だけを変え、読んだときの行のままの場合にだけ書く)。
 * ジョブの後始末なので例外は投げない (書けなければログに残す。ほかのジョブの処理を止めない)
 */
async function markDishFailure(job: MealImageJobRow, reason: string) {
  try {
    await writeDishImageFailure(supabase, {
      mealId: job.planned_meal_id,
      dishIndex: job.dish_index,
      subjectHash: job.subject_hash,
      reason,
      read: () => readMealSnapshot(job.planned_meal_id),
    });
  } catch (error) {
    console.warn("Failed to mark meal image dish as failed:", job.id, error);
  }
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
