import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { GoogleGenAI, createUserContent } from "@google/genai";
import {
  DEFAULT_MEAL_IMAGE_MODEL,
  MEAL_IMAGE_SKIPPED_ERRORS,
  mealImageJobPlanDecision,
  type MealImageDish,
  type MealImageJobPlanDecision,
} from "../_shared/meal-image.ts";
import {
  buildImageUploadPath,
  extractInlineImageBase64,
  formatDishLeftPendingLastError,
  GeneratedContentPart,
  isOwnJobUploadPath,
  MealDishWriteExhaustedError,
  type MealDishWriteSkipReason,
  type PlannedMealSnapshot,
  writeDishImageFailure,
  writeGeneratedDishImage,
} from "./utils.ts";
import { checkAiConsent, type AiConsentDecision } from "../_shared/ai-consent-guard.ts";
import { aiConsentDeniedPayload } from "../_shared/ai-consent.ts";
import { logMissingEnv, MISSING_ENV_HTTP_STATUS, missingEnvResponseBody } from "../_shared/missing-env.ts";
import { createLogger } from "../_shared/db-logger.ts";
import { requireServiceRole } from "../_shared/auth.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const STORAGE_BUCKET = "fridge-images";
const FUNCTION_NAME = "process-meal-image-jobs";

/** 料理の印を付けられなかったとき・画像を消せなかったときの記録 (app_logs。#1553) */
const logger = createLogger(FUNCTION_NAME);

/**
 * ジョブを取るときにつける貸し出しの長さ (ミリ秒)。この間に終わらなかったジョブ (関数の実行が打ち切られたなど) は、
 * pg_cron のジョブ requeue-stale-meal-image-jobs (public.requeue_stale_meal_image_jobs) が、期限からさらに 5 分過ぎたら取り戻す (#1561)。
 * 長さを変えるときは、migration 20261015180000_meal_image_jobs_pickup_cron.sql の c_stale_grace の説明も確かめる
 * (tests/meal-image-jobs-pickup-cron-contract.test.ts が、貸し出し + 猶予が Edge Function の実行時間の上限より長いことを突き合わせる)
 */
const JOB_LEASE_MS = 2 * 60_000;

/** ジョブの終わりの状態 (finalizeJob が書く status) */
type FinalJobStatus = "completed" | "failed" | "cancelled";

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
    // pg_cron のジョブ process-pending-meal-image-jobs (public.invoke_process_meal_image_jobs) は、Vault の app_cron_secret
    // (JWT でない) を Bearer に付けて呼ぶ (#1561)。Edge Function secrets の CRON_SECRET と照らし合わせる。
    // CRON_SECRET が未設定なら 503 (Service not configured)、合わなければ 401 (requireServiceRole)
    const authError = await requireServiceRole(req);
    if (authError) return authError;
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
  // 同意の判定と同じく、1 回の実行の中では利用者ごとにプランの門の答えを使い回す (billing/03 §8.8)
  const planByUser = new Map<string, Promise<MealImageJobPlanDecision>>();
  for (const job of jobs) {
    const outcome = await processJob(job, consentByUser, planByUser);
    results.push(outcome);
  }
  return results;
}

async function fetchPendingJobs(plannedMealId: string | undefined, limit: number): Promise<MealImageJobRow[]> {
  const query = supabase
    .from("meal_image_jobs")
    .select("id, user_id, planned_meal_id, dish_index, subject_hash, prompt, model, reference_image_urls, attempt_count")
    .eq("status", "pending")
    // 同じ優先度・同じ作成時刻のジョブ (1 回の保存でまとめて積んだ料理) のどれを先に取るかを決めるため、
    // 最後に主キー id の昇順を重ねる (Deno なので LIST_ORDERS は使えない。cross/04 §6.2.1)
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
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

/**
 * 料理画像のプランの門 (billing/03 §8.8): ジョブの持ち主のいまのプランの ai_plan_feature_caps の meal_image_auto の値を読む。
 * 献立の作成 (save-meal) が積んだジョブは数えていない (F22) ので、無料の利用者の献立の作成の画像を止めるのはここだけ
 */
async function readMealImageJobPlanDecision(ownerId: string): Promise<MealImageJobPlanDecision> {
  try {
    const { data, error } = await supabase.rpc("ai_plan_feature_daily_cap", { p_user_id: ownerId, p_feature: "meal_image_auto" });
    if (error) {
      // 読めなかったときは止めない (mealImageJobPlanDecision の注)。生のエラーは app_logs にだけ残す
      logger.warn("料理画像のプランの門を読めなかったため、止めずに処理します", { ownerId, code: error.code ?? null });
      return "allowed";
    }
    return mealImageJobPlanDecision(data);
  } catch (cause: unknown) {
    // RPC が投げた (接続の失敗など) ときも止めない。processJob の try より前で呼ぶので、ここで投げるとジョブが貸し出し中のまま残り、
    // 同じ実行の残りのジョブも処理されない (processJobs に try が無い)。生のエラーは残さず名前だけ
    logger.warn("料理画像のプランの門を読めなかったため、止めずに処理します", { ownerId, code: cause instanceof Error ? cause.name : null });
    return "allowed";
  }
}

async function processJob(
  job: MealImageJobRow,
  consentByUser: Map<string, Promise<AiConsentDecision>>,
  planByUser: Map<string, Promise<MealImageJobPlanDecision>>,
): Promise<ProcessResponse> {
  const now = new Date().toISOString();
  const lockToken = crypto.randomUUID();
  const leasedUntil = new Date(Date.now() + JOB_LEASE_MS).toISOString();

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
      await markDishFailure(jobRow, { status: "cancelled", attemptCount: nextAttempt, reason });
    }
    return { jobId: jobRow.id, status: "cancelled", message: reason };
  }

  // billing/03 §8.8: 同意のあとに、ジョブの持ち主のプランの門を見る。ご利用中のプランで自動の料理画像を作らない
  // (ai_plan_feature_caps の meal_image_auto = 0) なら、AI へ送らずにジョブを取り消し、料理を failed + skipped_plan にする
  let plan = planByUser.get(ownerId);
  if (!plan) {
    plan = readMealImageJobPlanDecision(ownerId);
    planByUser.set(ownerId, plan);
  }
  if ((await plan) === "locked") {
    const reason = MEAL_IMAGE_SKIPPED_ERRORS.plan;
    const finalized = await finalizeJob(jobRow.id, lockToken, "cancelled", nextAttempt, reason);
    if (finalized) {
      await markDishFailure(jobRow, { status: "cancelled", attemptCount: nextAttempt, reason });
    }
    return { jobId: jobRow.id, status: "cancelled", message: reason };
  }

  try {
    // 書くときの読み直しと同じ読み方にする (#1553)。行が無いときだけ meal_deleted で取り消し、
    // 読めなかった (エラー) ときは例外にして、下の catch でジョブを失敗にする (以前はエラーも「献立が消えた」として取り消していた)
    const meal = await readMealSnapshot(jobRow.planned_meal_id);

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
    let written: Awaited<ReturnType<typeof writeGeneratedDishImage>>;
    try {
      written = await writeGeneratedDishImage(supabase, {
        mealId: meal.id,
        dishIndex: jobRow.dish_index,
        subjectHash: jobRow.subject_hash,
        imageUrl: publicUrl,
        read: () => readMealSnapshot(meal.id),
      });
    } catch (writeError: unknown) {
      // 書き込みを諦めた (どの回も 0 行で、献立には書いていない) ときだけ、アップロードした画像を消す (#1553)。
      // 書き込みのエラー・読み取りのエラーでは消さない (書けたかどうかが分からない画像を、料理から参照させたまま消さない)
      if (writeError instanceof MealDishWriteExhaustedError) {
        await removeJobUploadedImage(jobRow, uploadPath, "write_exhausted");
      }
      throw writeError;
    }
    if (written.status === "skipped") {
      // 書かずにやめた (献立が消えた・料理が変わった) ので、アップロードした画像はどこからも参照されない (#1553)
      await removeJobUploadedImage(jobRow, uploadPath, written.reason);
      return await cancelSkippedJob(jobRow.id, lockToken, nextAttempt, written.reason);
    }

    await finalizeJob(jobRow.id, lockToken, "completed", nextAttempt, null, publicUrl);
    return { jobId: jobRow.id, status: "completed", message: publicUrl };
  } catch (error: any) {
    const reason = error?.message ?? "unknown error";
    const finalized = await finalizeJob(jobRow.id, lockToken, "failed", nextAttempt, reason);
    if (finalized) {
      await markDishFailure(jobRow, { status: "failed", attemptCount: nextAttempt, reason });
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
  status: FinalJobStatus,
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
 * ジョブの後始末なので例外は投げない (ほかのジョブの処理を止めない)。
 * 書けなかった (MEAL_DISH_WRITE_MAX_ATTEMPTS 回負けた・読めなかった) ときは、料理が生成中 (pending) のまま残る。
 * 料理の側を条件なしで書き直すことはせず (#1527 の排他を壊さない)、app_logs に error で残し、
 * ジョブの last_error に目印 (DISH_LEFT_PENDING_LAST_ERROR_MARKER) を足して、ジョブの側から追えるようにする (#1553)
 */
async function markDishFailure(
  job: MealImageJobRow,
  finalized: { status: Exclude<FinalJobStatus, "completed">; attemptCount: number; reason: string },
) {
  try {
    await writeDishImageFailure(supabase, {
      mealId: job.planned_meal_id,
      dishIndex: job.dish_index,
      subjectHash: job.subject_hash,
      reason: finalized.reason,
      read: () => readMealSnapshot(job.planned_meal_id),
    });
  } catch (error: unknown) {
    logger.error("料理を失敗の印にできず、生成中 (pending) のまま残りました", error, {
      jobId: job.id,
      plannedMealId: job.planned_meal_id,
      dishIndex: job.dish_index,
      jobStatus: finalized.status,
    });
    await recordDishLeftPending(job, finalized, error);
  }
}

/**
 * 料理が生成中のまま残ったことを、終えたジョブの last_error に書き足す (#1553)。
 * finalizeJob が書いたときの行 (同じ status・attempt_count・貸し出しなし) のままの場合にだけ書く。書けなくても例外は投げない
 */
async function recordDishLeftPending(
  job: MealImageJobRow,
  finalized: { status: Exclude<FinalJobStatus, "completed">; attemptCount: number; reason: string },
  cause: unknown,
) {
  try {
    const { data, error } = await supabase
      .from("meal_image_jobs")
      .update({
        last_error: formatDishLeftPendingLastError(finalized.reason, cause),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", finalized.status)
      .eq("attempt_count", finalized.attemptCount)
      .is("lease_token", null)
      .select("id");
    if (error) throw new Error(`failed to update meal image job: ${error.message}`);
    // 0 行 = finalizeJob のあとにジョブの行が変わった (積み直しなど)。新しい状態を上書きしない
    if (!Array.isArray(data) || data.length === 0) throw new Error("the finalized job row was changed afterwards");
  } catch (error: unknown) {
    logger.error("料理が生成中のまま残ったことを、ジョブの last_error に書けませんでした", error, {
      jobId: job.id,
      plannedMealId: job.planned_meal_id,
      dishIndex: job.dish_index,
    });
  }
}

/**
 * 書かずにやめた・書き込みを諦めたジョブが、自分でアップロードした画像を Storage から消す (#1553。best effort)。
 * 消すのは、このジョブの buildImageUploadPath のパス (isOwnJobUploadPath) の 1 ファイルだけ。ほかのジョブ・利用者の画像は消さない。
 * 消せなくてもジョブの結果は変えない (ログに残すだけ)
 */
async function removeJobUploadedImage(
  job: MealImageJobRow,
  uploadPath: string,
  why: MealDishWriteSkipReason | "write_exhausted",
): Promise<void> {
  const context = { jobId: job.id, plannedMealId: job.planned_meal_id, uploadPath, why };
  if (!isOwnJobUploadPath(uploadPath, { plannedMealId: job.planned_meal_id, jobId: job.id })) {
    logger.warn("ジョブの画像のパスではないので、Storage から消しませんでした", context);
    return;
  }
  try {
    const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([uploadPath]);
    if (error) {
      logger.warn("書かなかった料理の画像を Storage から消せませんでした", { ...context, error: error.message });
    }
  } catch (error: unknown) {
    logger.warn("書かなかった料理の画像を Storage から消せませんでした", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
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
