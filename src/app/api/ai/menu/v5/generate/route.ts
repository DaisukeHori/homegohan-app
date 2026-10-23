import { createClient } from '@/lib/supabase/server';
import { getAiQueueWriter } from '@/lib/ai/ai-queue-writer';
import { NextResponse } from 'next/server';
import { getSeasonalIngredientsForRange } from '@/lib/seasonal-ingredients';
import { getEventsForRange } from '@/lib/seasonal-events';
import type {
  TargetSlot,
  ExistingMenuContext,
  FridgeItemContext,
  MenuGenerationConstraints,
  SeasonalContext,
  MealType,
} from '@/types/domain';
import { fromTargetSlots } from '@/lib/converter';
import { resolveExistingTargetSlots } from '@/lib/v4-target-slots';
import { checkRateLimit, rateLimitExceededResponse } from '@/lib/rate-limit';
import { aiDailyLimitResponse, consumeAiUsage, refundAiUsage } from '@/lib/plan/entitlements';
import { isUltimateModeRequested } from '@/lib/ai/ultimate-mode';
import { weeklyMenuRequestWeeklyOriginDataForDates } from '@/lib/ai/weekly-menu-request-origin';
import { addDaysToDate, isCalendarDate, todayLocal } from '@/lib/date-utils';
import { isMealType, isWithinMenuGenerationRange, MEAL_ORDER, MENU_GENERATION_RANGE_MAX_DAYS } from '@homegohan/shared';
import { requireAiConsent } from '@/lib/ai/consent-guard';
import { internalError } from '@/lib/api/errors';
import { rejectNullCharacterBody } from '@/lib/api/reject-null-character';
import { normalizeUuid } from '@/lib/http-params';
import { API_UNAUTHENTICATED_MESSAGE } from '@/lib/api/error-responses';
import { AI_TARGET_SLOTS_REQUIRED_MESSAGE, aiTargetSlotsTooManyMessage, aiTargetSlotNotObjectMessage, aiTargetSlotDateInvalidMessage, aiTargetSlotMealTypeInvalidMessage, aiTargetSlotPlannedMealIdInvalidMessage, aiTargetSlotDuplicateMessage, aiTargetSlotsSpanTooLongMessage, AI_MENU_PLANNED_MEAL_TYPE_MISMATCH_MESSAGE, AI_MENU_PLANNED_MEAL_DATE_MISMATCH_MESSAGE } from '@/lib/ai/ai-api-messages';

// 受け付ける食事の区分 (5 値)。値と並びの正本は @homegohan/shared の MEAL_ORDER (#1631。手書きしない)
const VALID_MEAL_TYPES: readonly MealType[] = MEAL_ORDER;

/** 1 日の主な食事の数 (朝・昼・夕)。slot の上限の計算に使う */
const MAIN_MEALS_PER_DAY = 3;

/** targetSlots の数の上限 (期間の上限 MENU_GENERATION_RANGE_MAX_DAYS 日 × 朝・昼・夕 = 93) */
const MAX_TARGET_SLOTS = MENU_GENERATION_RANGE_MAX_DAYS * MAIN_MEALS_PER_DAY;

function validateTargetSlots(slots: unknown): { valid: boolean; slots: TargetSlot[]; error?: string } {
  if (!Array.isArray(slots) || slots.length === 0) {
    return { valid: false, slots: [], error: AI_TARGET_SLOTS_REQUIRED_MESSAGE };
  }

  if (slots.length > MAX_TARGET_SLOTS) {
    return { valid: false, slots: [], error: aiTargetSlotsTooManyMessage(MAX_TARGET_SLOTS, MENU_GENERATION_RANGE_MAX_DAYS, MAIN_MEALS_PER_DAY) };
  }

  const validated: TargetSlot[] = [];
  const seenKeys = new Set<string>();

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];

    if (!slot || typeof slot !== 'object') {
      return { valid: false, slots: [], error: aiTargetSlotNotObjectMessage(i) };
    }

    const slotObj = slot as Record<string, unknown>;
    const date = slotObj['date'];
    const mealType = slotObj['mealType'];
    const plannedMealId = slotObj['plannedMealId'];

    // YYYY-MM-DD の形で、実在する日付 (isCalendarDate の範囲 0101-01-02〜9998-12-30 の中) だけを通す (#1433)。形だけを見ていると 2026-02-30 のような日付が通り、
    // 後ろの addDaysToDate (前後 7 日の文脈の期間) が RangeError を投げて 500 になる
    if (!isCalendarDate(date)) {
      return { valid: false, slots: [], error: aiTargetSlotDateInvalidMessage(i) };
    }

    if (!mealType || typeof mealType !== 'string' || !isMealType(mealType)) {
      return { valid: false, slots: [], error: aiTargetSlotMealTypeInvalidMessage(i, VALID_MEAL_TYPES) };
    }

    if (plannedMealId !== undefined && plannedMealId !== null) {
      if (typeof plannedMealId !== 'string' || !/^[0-9a-f-]{36}$/i.test(plannedMealId)) {
        return { valid: false, slots: [], error: aiTargetSlotPlannedMealIdInvalidMessage(i) };
      }
    }

    // UUID の形なら小文字にそろえてから使う (#1790)。Postgres の uuid は大文字小文字を区別せずに比べるので、大文字の plannedMealId でも
    // planned_meals の .in('id', ...) は自分の食事に当たるが、DB から読んだ id (小文字) との突き合わせ (foundIds / byId) が外れて
    // plannedMealId が消され、既存の食事を置き換えない生成になる。同じ食事を大文字小文字だけ変えて 2 回送る重複もここで弾く
    const normalizedPlannedMealId = typeof plannedMealId === 'string' ? normalizeUuid(plannedMealId) : undefined;
    const key = normalizedPlannedMealId || `${date}:${mealType}`;
    if (seenKeys.has(key)) {
      return { valid: false, slots: [], error: aiTargetSlotDuplicateMessage(String(date), mealType) };
    }
    seenKeys.add(key);

    validated.push({ date, mealType, plannedMealId: normalizedPlannedMealId });
  }

  // 日付の幅 (最も早い日〜最も遅い日) は、画面 (Web・モバイルの「期間を指定」) と同じ MENU_GENERATION_RANGE_MAX_DAYS 日まで (#1482)。
  // slot の数だけを見ていると、API を直接呼んで遠く離れた 2 日を送れば、行事の検索 (getEventsForRange) が 1 日ずつ数千年分を回りうる
  if (!isWithinMenuGenerationRange(validated.map((s) => s.date))) {
    return {
      valid: false,
      slots: [],
      error: aiTargetSlotsSpanTooLongMessage(MENU_GENERATION_RANGE_MAX_DAYS),
    };
  }

  return { valid: true, slots: validated };
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function toOptionalInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

// 暦日 (YYYY-MM-DD) を days 日ずらす (#1433。v4 のルートと同じ関数にそろえる)
function addDays(dateStr: string, days: number): string {
  return addDaysToDate(dateStr, days);
}

export const maxDuration = 30;

export async function POST(request: Request) {
  // 本文の文字列に NULL 文字 (U+0000) があると、DB (text / jsonb) に届いたところで拒まれて 500 になる。本文を読む handler はどれも、認証・DB に触れる前に 400 で断る (#1657。一覧と例外は src/__tests__/api/null-character-routes.test.ts)
  const nullCharacterRejection = await rejectNullCharacterBody(request);
  if (nullCharacterRejection) return nullCharacterRejection;
  const supabase = await createClient();
  let _userId: string | undefined;

  try {
    const body = await request.json().catch(() => ({}));
    const { valid, slots: validatedSlots, error: validationError } = validateTargetSlots(body?.targetSlots);
    if (!valid) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: API_UNAUTHENTICATED_MESSAGE }, { status: 401 });
    }
    _userId = user.id;

    // 外国の AI 事業者への提供の同意が無ければ、生成をキューに積まずに止める (T15 / #1154。403 AI_CONSENT_REQUIRED。cron の側でも止める)
    const aiConsentDenied = await requireAiConsent(supabase, user.id);
    if (aiConsentDenied) return aiConsentDenied;

    const rateLimitResult = await checkRateLimit(user.id, 'generation');
    if (!rateLimitResult.success) return rateLimitExceededResponse(rateLimitResult);

    const targetSlots = body?.resolveExistingMeals
      ? await resolveExistingTargetSlots({
          supabase,
          userId: user.id,
          targetSlots: validatedSlots,
        })
      : validatedSlots;

    const dates = targetSlots.map((slot) => slot.date).sort();
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];

    const plannedSlots = targetSlots.filter((slot) => slot.plannedMealId);
    if (plannedSlots.length > 0) {
      const plannedMealIds = Array.from(new Set(plannedSlots.map((slot) => slot.plannedMealId!).filter(Boolean)));
      const { data: plannedMeals, error: plannedMealsError } = await supabase
        .from('planned_meals')
        .select(`
          id,
          meal_type,
          daily_meal_id,
          user_daily_meals!inner(
            day_date,
            user_id
          )
        `)
        .in('id', plannedMealIds)
        .eq('user_daily_meals.user_id', user.id);

      if (plannedMealsError) {
        return internalError('POST /api/ai/menu/v5/generate', plannedMealsError, { userId: user.id });
      }

      const foundIds = new Set((plannedMeals || []).map((meal) => meal.id));
      const missing = plannedMealIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        console.warn(`[v5/generate] ${missing.length} plannedMealId(s) not found, clearing: ${missing.join(', ')}`);
        for (const slot of plannedSlots) {
          if (slot.plannedMealId && missing.includes(slot.plannedMealId)) {
            slot.plannedMealId = undefined;
          }
        }
      }

      const byId = new Map((plannedMeals || []).map((meal) => [meal.id, meal]));
      for (const slot of plannedSlots) {
        if (!slot.plannedMealId) continue;
        const stored = byId.get(slot.plannedMealId);
        if (!stored) {
          slot.plannedMealId = undefined;
          continue;
        }
        const day = Array.isArray(stored.user_daily_meals)
          ? stored.user_daily_meals[0] || {}
          : stored.user_daily_meals || {};
        if (String(stored.meal_type) !== slot.mealType) {
          return NextResponse.json({ error: AI_MENU_PLANNED_MEAL_TYPE_MISMATCH_MESSAGE }, { status: 400 });
        }
        if (String(day.day_date) !== slot.date) {
          return NextResponse.json({ error: AI_MENU_PLANNED_MEAL_DATE_MISMATCH_MESSAGE }, { status: 400 });
        }
      }
    }

    const contextStartDate = addDays(startDate, -7);
    const contextEndDate = addDays(endDate, 7);
    const todayStr = todayLocal();

    const [existingMealsResult, pantryResult, profileResult] = await Promise.all([
      supabase
        .from('user_daily_meals')
        .select(`
          day_date,
          planned_meals (
            id,
            meal_type,
            dish_name,
            is_completed,
            mode
          )
        `)
        .eq('user_id', user.id)
        .gte('day_date', contextStartDate)
        .lte('day_date', contextEndDate),
      supabase
        .from('pantry_items')
        .select('name, amount, expiration_date')
        .eq('user_id', user.id)
        .gte('expiration_date', todayStr)
        .order('expiration_date', { ascending: true }),
      supabase
        .from('user_profiles')
        .select('*')
        .eq('id', user.id)
        .single(),
    ]);

    const existingMeals = existingMealsResult.data || [];
    const existingMenus: ExistingMenuContext[] = [];
    const fridgeItems: FridgeItemContext[] = (pantryResult.data || []).map((item) => ({
      name: item.name,
      quantity: item.amount || undefined,
      expirationDate: item.expiration_date || undefined,
    }));
    const userProfile = profileResult.data || {};

    for (const day of existingMeals) {
      const dayDate = day.day_date;
      const meals = day.planned_meals || [];
      for (const meal of meals) {
        if (!meal.dish_name) continue;
        const status = meal.is_completed ? 'completed' : meal.mode?.startsWith('ai') ? 'ai' : 'manual';
        existingMenus.push({
          date: dayDate,
          mealType: meal.meal_type,
          dishName: meal.dish_name,
          status,
          isPast: dayDate < todayStr,
        });
      }
    }

    const seasonalContext: SeasonalContext = {
      month: new Date(startDate).getUTCMonth() + 1,
      seasonalIngredients: getSeasonalIngredientsForRange(startDate, endDate),
      events: getEventsForRange(startDate, endDate),
    };

    const constraints: MenuGenerationConstraints = isPlainObject(body?.constraints)
      ? (body.constraints as MenuGenerationConstraints)
      : {};

    // キューへ書くクライアント (service role)。必須の環境変数が欠けていれば MissingEnvError で汎用の 500 にする。
    // 数える前に作る (欠けていて積めないのに、回数だけが減らないように)
    const queueDb = getAiQueueWriter();

    // #1149 AI の利用回数の上限の判定と記録 (#1177)。キューに積む時点 (入力の検証・同意などの判定のあと) で、操作 1 回につき 1 回数える
    // (究極モードも 1 回)。上限に達していれば、数えずに積まずに 429 AI_DAILY_LIMIT (判定に失敗したときは止めない)。
    // ここでキューに積み、AI へ送るのは cron (process-menu-queue) なので、送る側では数えない。
    // キューの行 (weekly_menu_requests) は利用者 (authenticated) から書けない (#1465) ので、キューに積めるのは
    // この判定を通った route だけ (service role で書く)
    // 究極モード (#1142) は 'menu_generation_ultimate' で数える (1 日の上限に 1 回 + 究極モードの 1 日の上限 (既定 1 回) に 1 回)。
    // 究極モードかどうかは本文の ultimateMode が true のときだけ。キューに積む値も同じ判定の結果にする (数え方と生成を食い違わせない)
    const ultimateMode = isUltimateModeRequested(body?.ultimateMode);
    const usageFeature = ultimateMode ? 'menu_generation_ultimate' : 'menu_generation';
    const aiUsage = ultimateMode
      ? await consumeAiUsage(user.id, 'menu_generation_ultimate')
      : await consumeAiUsage(user.id, 'menu_generation');
    if (!aiUsage.allowed) return aiDailyLimitResponse(aiUsage);

    // バックグラウンドジョブとしてキューに追加し、即座に requestId を返す
    const params = {
      userId: user.id,
      requestId: null as string | null, // INSERT 後に取得
      targetSlots,
      existingMenus,
      fridgeItems,
      userProfile,
      seasonalContext,
      constraints,
      note: body?.note || null,
      familySize: toOptionalInt(body?.familySize) ?? userProfile.family_size ?? 1,
      ultimateMode,
    };

    // #1867: 対象の枠が複数の日 (異なる日付が 2 日以上。1 週間に満たない週の途中の残りも) にわたる生成なら、印 (weeklyRequest: true) を generated_data に書く。
    // 行が completed になった時点で DB のトリガー (weekly_menu_requests_award_planner) がこの印を見て planner を付ける
    // (保険として状態の確認 GET /api/ai/menu/weekly/status とバッジの一覧 GET /api/badges も。src/lib/ai/weekly-menu-request-origin.ts)。下の requestId を埋め込む更新も generated_data を丸ごと
    // 書き直すので、両方に入れる (片方だけだと、更新で印が消える)
    const weeklyOrigin = weeklyMenuRequestWeeklyOriginDataForDates(dates);

    const { data: requestData, error: insertError } = await queueDb
      .from('weekly_menu_requests')
      .insert({
        user_id: user.id,
        start_date: startDate,
        mode: 'v5',
        status: 'queued',
        current_step: 1,
        prompt: body?.note || '',
        constraints,
        target_slots: fromTargetSlots(targetSlots),
        progress: {
          currentStep: 0,
          totalSteps: targetSlots.length,
          message: '生成キューに追加しました',
        },
        generated_data: { ...params, requestId: undefined, ...weeklyOrigin },
      })
      .select('id')
      .single();

    if (insertError || !requestData?.id) {
      // 生成を始める前に止まった (AI へは何も送っていない) ので、数えた 1 回を戻す (#1149)
      await refundAiUsage(user.id, usageFeature, aiUsage);
      return internalError('POST /api/ai/menu/v5/generate', insertError, { userId: user.id });
    }

    // generated_data に requestId を埋め込む
    await queueDb
      .from('weekly_menu_requests')
      .update({ generated_data: { ...params, requestId: requestData.id, ...weeklyOrigin } })
      .eq('id', requestData.id)
      .eq('user_id', user.id);

    return NextResponse.json(
      {
        status: 'queued',
        message: '献立生成をキューに追加しました',
        requestId: requestData.id,
        totalSlots: targetSlots.length,
      },
      { status: 202 },
    );
  } catch (error: any) {
    return internalError('POST /api/ai/menu/v5/generate', error, { userId: _userId });
  }
}
