require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs/promises');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = String(process.env.SERVICE_ROLE_JWT || process.env.SUPABASE_SERVICE_ROLE_KEY || '').replace(/^"|"$/g, '');
const REPORT_FILE = process.env.BENCHMARK_REPORT_FILE || null;
const SEED_FILE = process.env.BENCHMARK_SEED_FILE || null;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase credentials in .env.local');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SCENARIOS = [
  {
    key: 'one_day',
    label: '1日生成',
    successTarget: 20,
    maxAttempts: 40,
    pollTimeoutMs: 20 * 60 * 1000,
    targetSlots: buildTargetSlots('2026-04-01', 1, ['breakfast', 'lunch', 'dinner']),
  },
  {
    key: 'one_week',
    label: '1週間生成',
    successTarget: 20,
    maxAttempts: 40,
    pollTimeoutMs: 30 * 60 * 1000,
    targetSlots: buildTargetSlots('2026-04-01', 7, ['breakfast', 'lunch', 'dinner']),
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildTargetSlots(startDate, dayCount, mealTypes) {
  const targetSlots = [];
  for (let dayOffset = 0; dayOffset < dayCount; dayOffset++) {
    const date = addDays(startDate, dayOffset);
    for (const mealType of mealTypes) {
      targetSlots.push({ date, mealType });
    }
  }
  return targetSlots;
}

function toDbTargetSlots(targetSlots) {
  return targetSlots.map((slot) => ({
    date: slot.date,
    meal_type: slot.mealType,
    planned_meal_id: null,
  }));
}

function msBetween(start, end) {
  return new Date(end).getTime() - new Date(start).getTime();
}

function round(value) {
  return value == null ? null : Math.round(value);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function min(values) {
  return values.length ? Math.min(...values) : null;
}

function max(values) {
  return values.length ? Math.max(...values) : null;
}

function summarizeNumeric(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  return {
    count: filtered.length,
    avg: round(average(filtered)),
    min: round(min(filtered)),
    max: round(max(filtered)),
  };
}

async function loadSeedRuns(seedFile) {
  if (!seedFile) return {};

  const raw = await fs.readFile(seedFile, 'utf8');
  const parsed = JSON.parse(raw);
  const byScenario = {};

  if (parsed && typeof parsed === 'object' && parsed.runsByScenario && typeof parsed.runsByScenario === 'object') {
    for (const [scenario, runs] of Object.entries(parsed.runsByScenario)) {
      byScenario[scenario] = Array.isArray(runs) ? runs : [];
    }
  }

  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.scenarios)) {
    for (const scenarioEntry of parsed.scenarios) {
      const scenario = scenarioEntry?.scenario;
      const runs = scenarioEntry?.runs;
      if (typeof scenario === 'string' && Array.isArray(runs)) {
        byScenario[scenario] = runs;
      }
    }
  }

  return byScenario;
}

const MEAL_TYPE_ORDER = {
  breakfast: 0,
  lunch: 1,
  dinner: 2,
  snack: 3,
};

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function uniqueNonEmpty(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0))];
}

function buildContentInspection({ plannedMeals, dailyMealDateById, targetSlots }) {
  const expectedSlotsByDate = targetSlots.reduce((map, slot) => {
    map[slot.date] = (map[slot.date] || 0) + 1;
    return map;
  }, {});

  const normalizedMeals = plannedMeals
    .map((meal) => ({
      date: dailyMealDateById.get(meal.daily_meal_id) || 'unknown',
      mealType: meal.meal_type,
      dishName: meal.dish_name || '',
      caloriesKcal: toFiniteNumber(meal.calories_kcal),
      proteinG: toFiniteNumber(meal.protein_g),
      fatG: toFiniteNumber(meal.fat_g),
      carbsG: toFiniteNumber(meal.carbs_g),
      sodiumG: toFiniteNumber(meal.sodium_g),
      fiberG: toFiniteNumber(meal.fiber_g),
      dishes: Array.isArray(meal.dishes) ? meal.dishes : [],
    }))
    .sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return (MEAL_TYPE_ORDER[a.mealType] ?? 99) - (MEAL_TYPE_ORDER[b.mealType] ?? 99);
    });

  const warnings = [];
  const warningCodeCounts = {};
  const pushWarning = (code, message) => {
    warnings.push({ code, message });
    warningCodeCounts[code] = (warningCodeCounts[code] || 0) + 1;
  };

  for (const meal of normalizedMeals) {
    if (!meal.dishName.trim()) {
      pushWarning('meal_missing_name', `${meal.date} ${meal.mealType}: dish_name が空です`);
    }
    if ([meal.caloriesKcal, meal.proteinG, meal.fatG, meal.carbsG].some((value) => value == null)) {
      pushWarning('meal_missing_macros', `${meal.date} ${meal.mealType}: 基本栄養素が欠けています`);
    }
    if (meal.caloriesKcal != null && (meal.caloriesKcal < 80 || meal.caloriesKcal > 1800)) {
      pushWarning('meal_calorie_outlier', `${meal.date} ${meal.mealType}: ${meal.caloriesKcal}kcal`);
    }
    if (meal.sodiumG != null && meal.sodiumG > 6) {
      pushWarning('meal_sodium_high', `${meal.date} ${meal.mealType}: 塩分 ${meal.sodiumG}g`);
    }
  }

  const byDate = new Map();
  for (const meal of normalizedMeals) {
    if (!byDate.has(meal.date)) byDate.set(meal.date, []);
    byDate.get(meal.date).push(meal);
  }

  const dayTotals = [];
  for (const [date, meals] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const totalCalories = meals.reduce((sum, meal) => sum + (meal.caloriesKcal || 0), 0);
    const totalProtein = meals.reduce((sum, meal) => sum + (meal.proteinG || 0), 0);
    const totalFat = meals.reduce((sum, meal) => sum + (meal.fatG || 0), 0);
    const totalCarbs = meals.reduce((sum, meal) => sum + (meal.carbsG || 0), 0);
    const totalSodium = meals.reduce((sum, meal) => sum + (meal.sodiumG || 0), 0);
    const mealNames = uniqueNonEmpty(meals.map((meal) => meal.dishName.trim()));

    if ((expectedSlotsByDate[date] || 0) !== meals.length) {
      pushWarning('day_slot_count_mismatch', `${date}: 食事数 ${meals.length}/${expectedSlotsByDate[date] || 0}`);
    }
    if (totalCalories < 900 || totalCalories > 2800) {
      pushWarning('day_calorie_outlier', `${date}: 合計 ${round(totalCalories)}kcal`);
    }
    if (totalSodium > 12) {
      pushWarning('day_sodium_high', `${date}: 塩分合計 ${Math.round(totalSodium * 10) / 10}g`);
    }
    if (mealNames.length !== meals.length) {
      pushWarning('day_duplicate_dish_name', `${date}: 同名献立あり`);
    }

    dayTotals.push({
      date,
      meals: meals.map((meal) => ({
        mealType: meal.mealType,
        dishName: meal.dishName,
        caloriesKcal: meal.caloriesKcal,
        sodiumG: meal.sodiumG,
      })),
      totals: {
        caloriesKcal: round(totalCalories),
        proteinG: round(totalProtein),
        fatG: round(totalFat),
        carbsG: round(totalCarbs),
        sodiumG: Math.round(totalSodium * 10) / 10,
      },
    });
  }

  const preview = dayTotals.slice(0, Math.min(dayTotals.length, 2));

  return {
    warningCount: warnings.length,
    warningCodeCounts,
    warnings,
    dayTotals,
    preview,
  };
}

async function createTempUser(label, attempt) {
  const email = `codex-${label}-${attempt}-${Date.now()}@example.com`;
  const password = `Codex!${Math.random().toString(36).slice(2)}A1`;
  const created = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data?.user?.id) {
    throw created.error || new Error('Failed to create temp user');
  }
  return created.data.user.id;
}

async function cleanupRun({ requestId, userId }) {
  const steps = [];
  const cleanupTasks = [
    ['meal_image_jobs', async () => {
      const result = await supabase.from('meal_image_jobs').delete().eq('request_id', requestId);
      if (result.error && /Could not find the table 'public\.meal_image_jobs'/.test(result.error.message || '')) {
        return { error: null };
      }
      return result;
    }],
    ['meal_nutrition_debug_logs', () => supabase.from('meal_nutrition_debug_logs').delete().eq('request_id', requestId)],
    ['llm_usage_logs', () => supabase.from('llm_usage_logs').delete().eq('request_id', requestId)],
    ['planned_meals', async () => {
      const dailyMealsRes = await supabase
        .from('user_daily_meals')
        .select('id')
        .eq('user_id', userId);
      if (dailyMealsRes.error) throw dailyMealsRes.error;
      const dailyMealIds = (dailyMealsRes.data || []).map((row) => row.id);
      if (!dailyMealIds.length) return { error: null };
      return supabase.from('planned_meals').delete().in('daily_meal_id', dailyMealIds);
    }],
    ['weekly_menu_requests', () => supabase.from('weekly_menu_requests').delete().eq('id', requestId)],
    ['user_profiles', () => supabase.from('user_profiles').delete().eq('id', userId)],
    ['pantry_items', () => supabase.from('pantry_items').delete().eq('user_id', userId)],
    ['user_daily_meals', () => supabase.from('user_daily_meals').delete().eq('user_id', userId)],
  ];

  for (const [label, fn] of cleanupTasks) {
    try {
      const result = await fn();
      if (result.error) throw result.error;
      steps.push({ label, ok: true });
    } catch (error) {
      steps.push({ label, ok: false, error: error.message || String(error) });
    }
  }

  try {
    const result = await supabase.auth.admin.deleteUser(userId);
    if (result.error) throw result.error;
    steps.push({ label: 'auth_user', ok: true });
  } catch (error) {
    steps.push({ label: 'auth_user', ok: false, error: error.message || String(error) });
  }

  return steps;
}

function getStepTransitionTimes(createdAt, transitions, finalUpdatedAt) {
  const step2At = transitions[2] ?? null;
  const step3At = transitions[3] ?? null;
  return {
    step1_wall_ms: step2At ? msBetween(createdAt, step2At) : null,
    step2_wall_ms: step2At && step3At ? msBetween(step2At, step3At) : null,
    step3_wall_ms: step3At ? msBetween(step3At, finalUpdatedAt) : null,
  };
}

function aggregateUsageRows(rows) {
  const activeRows = rows.filter((row) => !row.is_summary);
  const perSection = {};

  for (const row of activeRows) {
    const section = row.metadata?.section || row.call_type || 'unknown';
    if (!perSection[section]) {
      perSection[section] = {
        calls: 0,
        duration_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      };
    }
    perSection[section].calls += 1;
    perSection[section].duration_ms += Number(row.duration_ms || 0);
    perSection[section].input_tokens += Number(row.input_tokens || 0);
    perSection[section].output_tokens += Number(row.output_tokens || 0);
    perSection[section].total_tokens += Number(row.total_tokens || 0);
  }

  return perSection;
}

function aggregateDebugRows(rows) {
  const uniqueSlots = new Map();

  for (const row of rows) {
    const key = `${row.target_date}:${row.meal_type}`;
    if (uniqueSlots.has(key)) continue;
    uniqueSlots.set(key, row.slot_timing_ms || {});
  }

  const slotTimings = [...uniqueSlots.values()];
  const sumField = (field) => slotTimings.reduce((sum, timing) => sum + Number(timing?.[field] || 0), 0);

  return {
    slot_count: slotTimings.length,
    total_ms: sumField('total_ms'),
    daily_meal_upsert_ms: sumField('daily_meal_upsert_ms'),
    dish_processing_total_ms: sumField('dish_processing_total_ms'),
    planned_meal_lookup_ms: sumField('planned_meal_lookup_ms'),
    planned_meal_write_ms: sumField('planned_meal_write_ms'),
    nutrition_debug_insert_ms: sumField('nutrition_debug_insert_ms'),
  };
}

async function collectRunResult({ scenario, attempt, userId, requestId, finalRow, transitions }) {
  const dailyMealsRes = await supabase
    .from('user_daily_meals')
    .select('id, day_date')
    .eq('user_id', userId)
    .gte('day_date', scenario.targetSlots[0].date)
    .lte('day_date', scenario.targetSlots[scenario.targetSlots.length - 1].date);
  if (dailyMealsRes.error) throw dailyMealsRes.error;
  const dailyMeals = dailyMealsRes.data || [];
  const dailyMealDateById = new Map(dailyMeals.map((row) => [row.id, row.day_date]));

  const dailyMealIds = dailyMeals.map((row) => row.id);
  let plannedMeals = [];
  if (dailyMealIds.length > 0) {
    const plannedMealsRes = await supabase
      .from('planned_meals')
      .select('id, meal_type, dish_name, daily_meal_id, calories_kcal, protein_g, fat_g, carbs_g, sodium_g, fiber_g, dishes')
      .in('daily_meal_id', dailyMealIds);
    if (plannedMealsRes.error) throw plannedMealsRes.error;
    plannedMeals = plannedMealsRes.data || [];
  }

  const usageRes = await supabase
    .from('llm_usage_logs')
    .select('is_summary, provider, model, call_type, duration_ms, input_tokens, output_tokens, total_tokens, metadata')
    .eq('request_id', requestId);
  if (usageRes.error) throw usageRes.error;

  const debugRes = await supabase
    .from('meal_nutrition_debug_logs')
    .select('target_date, meal_type, slot_timing_ms')
    .eq('request_id', requestId);
  if (debugRes.error) throw debugRes.error;

  const stepTimes = getStepTransitionTimes(finalRow.created_at, transitions, finalRow.updated_at);
  const usage = aggregateUsageRows(usageRes.data || []);
  const debug = aggregateDebugRows(debugRes.data || []);
  const generatedData = finalRow.generated_data || {};
  const contentInspection = buildContentInspection({
    plannedMeals,
    dailyMealDateById,
    targetSlots: scenario.targetSlots,
  });

  return {
    scenario: scenario.key,
    attempt,
    requestId,
    success: finalRow.status === 'completed',
    status: finalRow.status,
    currentStep: finalRow.current_step,
    total_duration_ms: msBetween(finalRow.created_at, finalRow.updated_at),
    progress_message: finalRow.progress?.message || null,
    error_message: finalRow.error_message || null,
    step1_wall_ms: stepTimes.step1_wall_ms,
    step2_wall_ms: stepTimes.step2_wall_ms,
    step3_wall_ms: stepTimes.step3_wall_ms,
    planned_meal_count: plannedMeals.length,
    slot_count: scenario.targetSlots.length,
    fixes_detected: Array.isArray(generatedData.step2?.issuesToFix) ? generatedData.step2.issuesToFix.length : 0,
    fixes_applied: Number(generatedData.step2?.fixCursor || 0),
    content: contentInspection,
    usage,
    debug,
  };
}

async function runScenarioAttempt(scenario, attempt) {
  let userId = null;
  let requestId = null;
  let finalRow = null;
  const transitions = {};

  try {
    userId = await createTempUser(scenario.key, attempt);

    const requestInsert = await supabase
      .from('weekly_menu_requests')
      .insert({
        user_id: userId,
        start_date: scenario.targetSlots[0].date,
        mode: 'v4',
        status: 'processing',
        current_step: 1,
        prompt: `Codex benchmark ${scenario.key} attempt ${attempt}`,
        constraints: {},
        target_slots: toDbTargetSlots(scenario.targetSlots),
        progress: {
          currentStep: 0,
          totalSteps: scenario.targetSlots.length,
          message: `${scenario.label} benchmark start`,
        },
      })
      .select('id')
      .single();
    if (requestInsert.error || !requestInsert.data?.id) {
      throw requestInsert.error || new Error('Failed to create weekly_menu_request');
    }
    requestId = requestInsert.data.id;

    const invokeResponse = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/generate-menu-v4`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        apikey: SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({
        userId,
        requestId,
        targetSlots: scenario.targetSlots,
        constraints: {},
        note: `Codex benchmark ${scenario.key} attempt ${attempt}`,
        familySize: 1,
        ultimateMode: false,
      }),
    });

    const invokeBody = await invokeResponse.text();
    if (!invokeResponse.ok) {
      throw new Error(`Initial invoke failed: ${invokeResponse.status} ${invokeBody}`);
    }

    const pollStartedAt = Date.now();
    while (Date.now() - pollStartedAt < scenario.pollTimeoutMs) {
      const rowRes = await supabase
        .from('weekly_menu_requests')
        .select('status,current_step,progress,error_message,generated_data,created_at,updated_at')
        .eq('id', requestId)
        .single();
      if (rowRes.error) throw rowRes.error;
      finalRow = rowRes.data;
      if (finalRow.current_step && !transitions[finalRow.current_step]) {
        transitions[finalRow.current_step] = finalRow.updated_at;
      }
      if (finalRow.status === 'completed' || finalRow.status === 'failed') {
        break;
      }
      await sleep(4000);
    }

    if (!finalRow || (finalRow.status !== 'completed' && finalRow.status !== 'failed')) {
      throw new Error(`Poll timeout after ${Math.round(scenario.pollTimeoutMs / 1000)}s`);
    }

    return await collectRunResult({ scenario, attempt, userId, requestId, finalRow, transitions });
  } finally {
    if (requestId && userId) {
      const cleanup = await cleanupRun({ requestId, userId });
      const cleanupErrors = cleanup.filter((step) => !step.ok);
      if (cleanupErrors.length > 0) {
        console.warn('[cleanup-warning]', JSON.stringify({ scenario: scenario.key, attempt, cleanupErrors }));
      }
    }
  }
}

function mergeSectionKeys(results) {
  const keys = new Set();
  for (const result of results) {
    for (const key of Object.keys(result.usage || {})) keys.add(key);
  }
  return [...keys].sort();
}

function summarizeScenario(results) {
  const successful = results.filter((result) => result.success);
  const summary = {
    attempts: results.length,
    completed: successful.length,
    failed: results.length - successful.length,
    total_duration_ms: summarizeNumeric(successful.map((result) => result.total_duration_ms)),
    step1_wall_ms: summarizeNumeric(successful.map((result) => result.step1_wall_ms)),
    step2_wall_ms: summarizeNumeric(successful.map((result) => result.step2_wall_ms)),
    step3_wall_ms: summarizeNumeric(successful.map((result) => result.step3_wall_ms)),
    planned_meal_count: summarizeNumeric(successful.map((result) => result.planned_meal_count)),
    fixes_detected: summarizeNumeric(successful.map((result) => result.fixes_detected)),
    fixes_applied: summarizeNumeric(successful.map((result) => result.fixes_applied)),
    content: {
      warning_count: summarizeNumeric(successful.map((result) => result.content.warningCount)),
      warning_codes: {},
    },
    debug: {
      total_ms: summarizeNumeric(successful.map((result) => result.debug.total_ms)),
      slot_count: summarizeNumeric(successful.map((result) => result.debug.slot_count)),
      daily_meal_upsert_ms: summarizeNumeric(successful.map((result) => result.debug.daily_meal_upsert_ms)),
      dish_processing_total_ms: summarizeNumeric(successful.map((result) => result.debug.dish_processing_total_ms)),
      planned_meal_lookup_ms: summarizeNumeric(successful.map((result) => result.debug.planned_meal_lookup_ms)),
      planned_meal_write_ms: summarizeNumeric(successful.map((result) => result.debug.planned_meal_write_ms)),
    },
    usage: {},
    failures: results.filter((result) => !result.success).map((result) => ({
      attempt: result.attempt,
      status: result.status,
      currentStep: result.currentStep,
      errorMessage: result.error_message,
      progressMessage: result.progress_message,
    })),
  };

  for (const section of mergeSectionKeys(successful)) {
    summary.usage[section] = {
      calls: summarizeNumeric(successful.map((result) => result.usage[section]?.calls || 0)),
      duration_ms: summarizeNumeric(successful.map((result) => result.usage[section]?.duration_ms || 0)),
      input_tokens: summarizeNumeric(successful.map((result) => result.usage[section]?.input_tokens || 0)),
      output_tokens: summarizeNumeric(successful.map((result) => result.usage[section]?.output_tokens || 0)),
      total_tokens: summarizeNumeric(successful.map((result) => result.usage[section]?.total_tokens || 0)),
    };
  }

  const allWarningCodes = new Set();
  for (const result of successful) {
    for (const code of Object.keys(result.content.warningCodeCounts || {})) {
      allWarningCodes.add(code);
    }
  }
  for (const code of [...allWarningCodes].sort()) {
    summary.content.warning_codes[code] = summarizeNumeric(
      successful.map((result) => result.content.warningCodeCounts?.[code] || 0),
    );
  }

  return summary;
}

async function benchmarkScenario(scenario, seededRuns = []) {
  const results = [...seededRuns];
  let attempt = results.reduce((maxAttempt, result) => Math.max(maxAttempt, Number(result?.attempt || 0)), 0);
  const seededSuccesses = results.filter((result) => result.success).length;
  console.log(`[scenario-start] ${scenario.key} target=${scenario.successTarget} seeded_runs=${results.length} seeded_successes=${seededSuccesses}`);

  while (results.filter((result) => result.success).length < scenario.successTarget && attempt < scenario.maxAttempts) {
    attempt += 1;
    const runStartedAt = Date.now();
    try {
      const result = await runScenarioAttempt(scenario, attempt);
      results.push(result);
      console.log('[run-result]', JSON.stringify({
        scenario: scenario.key,
        attempt,
        success: result.success,
        status: result.status,
        total_duration_ms: result.total_duration_ms,
        step1_wall_ms: result.step1_wall_ms,
        step2_wall_ms: result.step2_wall_ms,
        step3_wall_ms: result.step3_wall_ms,
        planned_meal_count: result.planned_meal_count,
        fixes_detected: result.fixes_detected,
        fixes_applied: result.fixes_applied,
        content_warning_count: result.content.warningCount,
        content_warning_codes: Object.keys(result.content.warningCodeCounts),
        content_preview: result.content.preview,
        elapsed_wall_ms: Date.now() - runStartedAt,
      }));
    } catch (error) {
      results.push({
        scenario: scenario.key,
        attempt,
        success: false,
        status: 'failed',
        currentStep: null,
        total_duration_ms: null,
        progress_message: null,
        error_message: error.message || String(error),
        step1_wall_ms: null,
        step2_wall_ms: null,
        step3_wall_ms: null,
        planned_meal_count: 0,
        slot_count: scenario.targetSlots.length,
        fixes_detected: 0,
        fixes_applied: 0,
        content: {
          warningCount: 0,
          warningCodeCounts: {},
          warnings: [],
          dayTotals: [],
          preview: [],
        },
        usage: {},
        debug: {
          total_ms: 0,
          slot_count: 0,
          daily_meal_upsert_ms: 0,
          dish_processing_total_ms: 0,
          planned_meal_lookup_ms: 0,
          planned_meal_write_ms: 0,
          nutrition_debug_insert_ms: 0,
        },
      });
      console.log('[run-result]', JSON.stringify({
        scenario: scenario.key,
        attempt,
        success: false,
        error: error.message || String(error),
      }));
    }

    await sleep(2000);
  }

  const summary = summarizeScenario(results);
  console.log('[scenario-summary]', JSON.stringify({ scenario: scenario.key, summary }, null, 2));
  if (summary.completed < scenario.successTarget) {
    throw new Error(`Scenario ${scenario.key} completed only ${summary.completed}/${scenario.successTarget} successful runs within ${scenario.maxAttempts} attempts`);
  }
  return { scenario: scenario.key, summary, runs: results };
}

(async () => {
  const startedAt = new Date().toISOString();
  const seedRunsByScenario = await loadSeedRuns(SEED_FILE);
  const scenarioResults = [];
  for (const scenario of SCENARIOS) {
    scenarioResults.push(await benchmarkScenario(scenario, seedRunsByScenario[scenario.key] || []));
  }
  const finalReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    resumedFrom: SEED_FILE,
    scenarios: scenarioResults.map((result) => ({
      scenario: result.scenario,
      summary: result.summary,
      runs: result.runs,
    })),
  };
  if (REPORT_FILE) {
    await fs.writeFile(REPORT_FILE, JSON.stringify(finalReport, null, 2));
    console.log(`[benchmark-report] ${REPORT_FILE}`);
  }
  console.log('[benchmark-complete]', JSON.stringify({
    startedAt: finalReport.startedAt,
    finishedAt: finalReport.finishedAt,
    scenarios: finalReport.scenarios.map((result) => ({
      scenario: result.scenario,
      summary: result.summary,
    })),
  }, null, 2));
})().catch((error) => {
  console.error('[benchmark-fatal]', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
