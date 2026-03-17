import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import crypto from "node:crypto";

function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  const text = readFileSync(".env.local", "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = `codex-v4-smoke-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@example.com`;
const password = `P@ss-${crypto.randomUUID()}!`;
const benchmarkDate = "2026-04-01";

let userId = null;
let requestId = null;

async function cleanup() {
  if (userId) {
    const { data: dailyMeals } = await supabase
      .from("user_daily_meals")
      .select("id")
      .eq("user_id", userId);

    const dailyMealIds = (dailyMeals ?? []).map((row) => row.id);
    if (dailyMealIds.length > 0) {
      await supabase.from("planned_meals").delete().in("daily_meal_id", dailyMealIds);
      await supabase.from("user_daily_meals").delete().in("id", dailyMealIds);
    }

    await supabase.from("weekly_menu_requests").delete().eq("user_id", userId);
    await supabase.from("llm_usage_logs").delete().eq("user_id", userId);
    await supabase.from("meal_nutrition_debug_logs").delete().eq("user_id", userId);
    await supabase.from("nutrition_goals").delete().eq("user_id", userId);
    await supabase.from("pantry_items").delete().eq("user_id", userId);
    await supabase.from("user_profiles").delete().eq("id", userId);
    await supabase.auth.admin.deleteUser(userId);
  }
}

try {
  const { data: createdUser, error: createUserError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: "Codex V4 Smoke" },
  });
  if (createUserError || !createdUser.user) {
    throw new Error(`Failed to create auth user: ${createUserError?.message}`);
  }
  userId = createdUser.user.id;

  const { error: profileError } = await supabase.from("user_profiles").upsert({
    id: userId,
    nickname: "Codex Smoke",
    gender: "unspecified",
    age_group: "unspecified",
    family_size: 2,
    week_start_day: "monday",
    weekday_cooking_minutes: 20,
    weekend_cooking_minutes: 30,
    nutrition_goal: "maintain",
    cooking_experience: "intermediate",
    cuisine_preferences: { japanese: 5, western: 2 },
    diet_flags: { allergies: [], dislikes: [] },
  });
  if (profileError) {
    throw new Error(`Failed to create user profile: ${profileError.message}`);
  }

  const targetSlots = [
    { date: benchmarkDate, mealType: "breakfast" },
    { date: benchmarkDate, mealType: "lunch" },
    { date: benchmarkDate, mealType: "dinner" },
    { date: benchmarkDate, mealType: "snack" },
  ];

  const { data: insertedRequest, error: requestError } = await supabase
    .from("weekly_menu_requests")
    .insert({
      user_id: userId,
      start_date: benchmarkDate,
      mode: "v4",
      status: "processing",
      current_step: 1,
      prompt: "時短、減塩、和食寄り",
      constraints: { healthy: true, quickMeals: true, japaneseStyle: true },
      target_slots: targetSlots,
      progress: {
        currentStep: 0,
        totalSteps: targetSlots.length,
        message: "smoke test",
      },
    })
    .select("id")
    .single();

  if (requestError || !insertedRequest) {
    throw new Error(`Failed to create request: ${requestError?.message}`);
  }
  requestId = insertedRequest.id;

  const invokeRes = await fetch(`${supabaseUrl}/functions/v1/generate-menu-v4`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
    body: JSON.stringify({
      userId,
      requestId,
      targetSlots,
      note: "時短、減塩、和食寄り",
      constraints: { healthy: true, quickMeals: true, japaneseStyle: true },
    }),
  });

  if (!invokeRes.ok) {
    throw new Error(`Function invoke failed: ${invokeRes.status} ${await invokeRes.text()}`);
  }

  const startedAt = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  let requestRow = null;

  while (Date.now() - startedAt < timeoutMs) {
    const { data, error } = await supabase
      .from("weekly_menu_requests")
      .select("status, current_step, error_message, progress")
      .eq("id", requestId)
      .single();

    if (error) {
      throw new Error(`Failed to poll request: ${error.message}`);
    }

    requestRow = data;
    if (data.status === "completed" || data.status === "failed") {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  if (!requestRow) {
    throw new Error("No request row returned during polling");
  }

  const { data: llmLogs, error: logError } = await supabase
    .from("llm_usage_logs")
    .select("provider, model, duration_ms, metadata, function_name, success")
    .eq("request_id", requestId)
    .order("created_at", { ascending: true });

  if (logError) {
    throw new Error(`Failed to fetch llm usage logs: ${logError.message}`);
  }

  console.log(JSON.stringify({
    requestId,
    status: requestRow.status,
    currentStep: requestRow.current_step,
    errorMessage: requestRow.error_message,
    progress: requestRow.progress,
    llmLogs: llmLogs ?? [],
  }, null, 2));

  if (requestRow.status !== "completed") {
    throw new Error(`Smoke test did not complete successfully: ${requestRow.status} ${requestRow.error_message ?? ""}`);
  }
} finally {
  await cleanup();
}
