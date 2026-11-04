"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo, useReducer } from "react";
import {
  weekViewReducer, initialWeekViewState, plannedMealFieldsOf,
  modalReducer, initialModalState,
  aiGenerationReducer, initialAiGenerationState, photoAnalyzeStateForSession, useAiConsentGenerationFailure,
  nutritionReducer, initialNutritionState,
  recipeReducer, initialRecipeState,
  uiFlagReducer, initialUiFlagState,
  useServingsConfigStore,
  usePantryStore,
  useShoppingStore,
  useFormDraftStore,
  convertV4ProgressToUIFormat,
  resumePendingGenerationAction,
  japaneseHolidaysUrl,
  createWeekDataCache,
  type WeekDataCacheWriter,
  type GenerationProgress,
  type LegacyDishDetail,
} from './_state';
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
// #1031: PantryItem/ShoppingList は store selector 経由の型推論に一本化したため import 不要になった
import type { DailyMeal, PlannedMeal, ShoppingList, ShoppingListItem, MealMode, MealDishes, DishDetail, TargetSlot, MenuGenerationConstraints, ServingsConfig, DayOfWeek, MealServings, WeekStartDay } from "@/types/domain";
import type { CatalogProductSummary } from "@/types/catalog";
import ReactMarkdown from "react-markdown";
import { useV4MenuGeneration } from "@/hooks/useV4MenuGeneration";
import { useAiConsultationReceiver, type AiConsultationPlaceResult, type AiConsultationRead } from "@/hooks/useAiConsultationReceiver";
import { BASE_MEAL_TYPES, EXTRA_MEAL_TYPES } from "@/lib/slot-builder";
import { useNutritionFeedbackWatch } from "@/hooks/useNutritionFeedbackWatch";
import { notifyMenuGenerated } from "@/lib/local-notification";
import { DEFAULT_RADAR_NUTRIENTS, getNutrientDefinition, calculateDriPercentage, NUTRIENT_DEFINITIONS, NUTRIENT_BY_CATEGORY, CATEGORY_LABELS, THEME_LABELS_REQUEST, AI_CONDITIONS, getDishConfig as getDishConfigShared, type DishConfig, MEAL_LABELS, MEAL_ORDER as MEAL_ORDER_SHARED, type MealType, PROGRESS_PHASES, ULTIMATE_PROGRESS_PHASES, SHOPPING_LIST_PHASES, type PhaseDefinition, MODE_CONFIG as MODE_CONFIG_SHARED, formatLocalDate, todayLocal, parseLocalDate, addDays, formatExpiry, formatDateJa, isUltimateModeWeeklyMenuRequest, PANTRY_EXPIRING_SOON_DAYS } from "@homegohan/shared";
// isUltimateModeWeeklyMenuRequest (究極モードの生成かの判定) は、Web とモバイルで同じ基準にするため @homegohan/shared に置く (#1609)
import { MOCK_MENU_RESPONSE, HANDSON_TOUR_CONSTANTS } from "@homegohan/handson-tour-shared";
import remarkGfm from "remark-gfm";
// #fix/e2e-profile-reminder-banner-chunk: chunk 404 防止のため静的 import に変更
// ProfileReminderBanner は "use client" + isVisible:false 初期値のため SSR でも安全
import { ProfileReminderBanner } from "@/components/ProfileReminderBanner";
import { ProgressTodoCard } from "./_components/ProgressTodoCard";
import { CancelGenerationConfirmModal } from "./_components/CancelGenerationConfirmModal";
import { GenerationResultDialogContent } from "./_components/GenerationResultDialogContent";
import { colors } from "./_components/colors";
import { FamilyViewSwitcher } from "@/components/membership/FamilyViewSwitcher";
import { useFamilyView } from "@/hooks/useFamilyView";
import type { FamilyMember } from "@/schemas/membership";
// #1584 の 1: 週間献立の家族の表示 (設計書 docs/design/family/10-family-menu-view.md §16)
import { useFamilyMenu } from "@/hooks/useFamilyMenu";
import { FamilyMenuMealRows, FamilyMenuDayNotes } from "@/components/membership/FamilyMenuRows";
import { familyMenuMealsOf, partitionFamilyMenuMembers, visibleOtherMemberIdsOf } from "@/lib/membership/family-menu";
import {
  applyFamilyMemberNames,
  fetchFamilyMemberNamesResult,
} from "@/lib/membership/family-member-names";
import { FridgeModal } from "./_components/modals/FridgeModal";
import { AddFridgeModal } from "./_components/modals/AddFridgeModal";
import { ShoppingModal } from "./_components/modals/ShoppingModal";
import { AddShoppingModal } from "./_components/modals/AddShoppingModal";
import { ShoppingRangeModal } from "./_components/modals/ShoppingRangeModal";
import { RecipeModal } from "./_components/modals/RecipeModal";
import { AddMealModal } from "./_components/modals/AddMealModal";
import { ManualEditModal } from "./_components/modals/ManualEditModal";
import { EditMealModal } from "./_components/modals/EditMealModal";
import { AiAssistantModal } from "./_components/modals/AiAssistantModal";
import { StatsModal } from "./_components/modals/StatsModal";
import { ServingsModal } from "./_components/modals/ServingsModal";
import { AddMealSlotModal } from "./_components/modals/AddMealSlotModal";
import { ConfirmDeleteModal } from "@/components/common/ConfirmDeleteModal";
import { useAiConsent } from "@/hooks/useAiConsent";
import { AiConsentRequiredError, aiFetch, handleStoredAiConsentFailure, isAiConsentRequiredResponse } from "@/lib/ai/consent-required";
import { aiDailyLimitMessageOfResponse } from "@/lib/ai/daily-limit-client";
import { mealCoverRepresentsDish } from "@/lib/meal-image";
import {
  PHOTO_RESULT_MEAL_MISSING_MESSAGE,
  PHOTO_RESULT_MEAL_MISSING_TITLE,
  PHOTO_RESULT_TIMEOUT_MESSAGE,
  PHOTO_RESULT_TIMEOUT_TITLE,
  findMealInWeek,
  photoResultBaseline,
  waitForMealPhotoResult,
} from "@/lib/meal-photo-result-watch";
import { AI_CONSENT_COPY } from "@/lib/ai/consent-config";
import { weeklyMenuRequestErrorMessageForDisplay } from "@/lib/weekly-menu-request-error";
import { shoppingListRequestErrorMessageForDisplay } from "@/lib/shopping-list-request-error";
import { AiMealModal } from "./_components/modals/AiMealModal";
import { RegenerateMealModal } from "./_components/modals/RegenerateMealModal";
import { ImageGenerateModal } from "./_components/modals/ImageGenerateModal";
import { PhotoEditModal } from "./_components/modals/PhotoEditModal";
import { NutritionDetailModal } from "./_components/modals/NutritionDetailModal";
import { ImproveMealModal } from "./_components/modals/ImproveMealModal";
import { dishSnapshotFromMenuDish } from '@/modules/dish-favorites/core';
import {
  addRecipeIngredientsToShoppingList,
  RECIPE_SHOPPING_ADDED_TITLE,
  RECIPE_SHOPPING_NO_INGREDIENTS_MESSAGE,
  RECIPE_SHOPPING_NO_INGREDIENTS_TITLE,
  recipeShoppingAddedMessage,
} from './_state/recipeShoppingList';

// #182/#322: dynamic import で初期バンドルを削減 (LCP 改善)
const V4GenerateModal = dynamic(
  () => import("@/components/ai-assistant").then(m => ({ default: m.V4GenerateModal })),
  { ssr: false }
);
const NutritionRadarChart = dynamic(
  () => import("@/components/NutritionRadarChart").then(m => ({ default: m.NutritionRadarChart })),
  { ssr: false }
);
import {
  ChefHat, Store, UtensilsCrossed, FastForward,
  Sparkles, Zap, Plus, Check, Calendar,
  Flame, Refrigerator, Trash2, AlertTriangle,
  BarChart3, ShoppingCart, ChevronDown, ChevronRight, ChevronLeft, ChevronUp,
  Clock, Users, BookOpen, Heart, RefreshCw, Send, Package,
  Camera, Pencil, Image as ImageIcon, GripVertical, ArrowUp, ArrowDown
} from 'lucide-react';

// ============================================
// Utilities
// ============================================

/**
 * QuotaExceededError-safe localStorage.setItem (#141).
 * On quota failure, clears stale generation-tracker keys and retries once.
 * If it still fails, logs a warning — the UI state is already set in React,
 * so omitting persistence is acceptable.
 */
function safeLocalStorageSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      // 旧い生成中状態キーを削除して再試行
      const staleKeys = ['weeklyMenuGenerating', 'singleMealGenerating', 'shoppingListRegenerating', 'v4MenuGenerating'];
      for (const k of staleKeys) {
        if (k !== key) localStorage.removeItem(k);
      }
      try {
        localStorage.setItem(key, value);
      } catch {
        console.warn('[weekly] localStorage quota exceeded: 生成状態を永続化できませんでした', key);
      }
    } else {
      console.warn('[weekly] localStorage.setItem failed:', key, e);
    }
  }
}

// ============================================
// Types & Constants (Reference UI Style)
// ============================================

// MealType (食事の区分 5 値) は @homegohan/shared が正本 (#1446)
type ModalType = 'ai' | 'aiPreview' | 'aiMeal' | 'fridge' | 'shopping' | 'stats' | 'recipe' | 'add' | 'addFridge' | 'addShopping' | 'editMeal' | 'regenerateMeal' | 'manualEdit' | 'photoEdit' | 'imageGenerate' | 'addMealSlot' | 'confirmDelete' | 'shoppingRange' | null;

// 日付ベースモデル用のローカル型定義
interface MealPlanDay {
  id: string;
  dayDate: string;
  theme?: string | null;
  nutritionalFocus?: string | null;
  isCheatDay?: boolean;
  meals?: PlannedMeal[];
}

interface WeekPlan {
  days: MealPlanDay[];
}

/** 週のキャッシュ (weekDataCache) に置く 1 週分 (書いた時刻はキャッシュが付ける) */
interface WeekCacheData {
  plan: WeekPlan | null;
  shoppingList: ShoppingListItem[];
}

/** GET /api/meal-plans (週の範囲) の本文の、写真の解析の結果を待つときに読む部分 (#2047) */
interface MealPlansWeekResponse {
  dailyMeals?: MealPlanDay[] | null;
  shoppingList?: { items?: ShoppingListItem[] } | null;
}

// 買い物リスト範囲選択の型は #1031 で shoppingStore (_state/shoppingStore.ts) に一本化

// LegacyDishDetail は _state/types.ts (Issue #1031 Step 0 で移設、formDraftStore と共有)

// Reference UI Color Palette
// #1050 レビュー残ポリッシュ: この配色定義が正本。GenerationResultDialogContent.tsx 等の
// 独自コピーによる乖離を防ぐため ./_components/colors.ts に切り出し、import して使う。

// アイコンマッピング (Lucide) — MODE_CONFIG の iconKey を解決するため WEB 専用で保持
const MODE_ICON_MAP: Record<string, typeof ChefHat> = {
  'chef-hat': ChefHat,
  'zap': Zap,
  'store': Store,
  'utensils-crossed': UtensilsCrossed,
  'fast-forward': FastForward,
  'sparkles': Sparkles,
};

// @homegohan/shared の MODE_CONFIG_SHARED を WEB 用に変換（アイコン・実色値付き）
const MODE_CONFIG = Object.fromEntries(
  Object.entries(MODE_CONFIG_SHARED).map(([key, cfg]) => [
    key,
    {
      icon: MODE_ICON_MAP[cfg.iconKey] ?? ChefHat,
      label: cfg.label,
      color: colors[cfg.colorKey],
      bg: colors[cfg.bgColorKey],
    },
  ])
) as Record<string, { icon: typeof ChefHat; label: string; color: string; bg: string }>;

// モード設定を安全に取得するヘルパー（未知のモードでもエラーにならない）
const getModeConfig = (mode?: string) => MODE_CONFIG[mode || 'cook'] || MODE_CONFIG.cook;

// getDishConfig — @homegohan/shared の定義を WEB colors で解決するラッパー
const getDishConfig = (role?: string): { label: string; color: string; bg: string } => {
  const cfg = getDishConfigShared(role);
  const colorKey = cfg.colorKey as keyof typeof colors;
  const bgKey = (cfg.colorKey + 'Light') as keyof typeof colors;
  return {
    label: cfg.label,
    color: colors[colorKey] ?? colors.textMuted,
    bg: colorKey === 'textMuted' ? colors.bg : (colors[bgKey] ?? colors.bg),
  };
};

// MEAL_LABELS は @homegohan/shared からインポート (MealType の型付き Record)

/** 家族の献立を取る範囲の最終日 = 週の始まりの日 + 6 日 (自分の献立の /api/meal-plans と同じ 7 日の範囲。#1584 の 1) */
const FAMILY_MENU_WEEK_LAST_DAY_OFFSET = 6;

// AIが自動生成する基本の3食 (BASE_MEAL_TYPES) と追加可能な食事タイプ (EXTRA_MEAL_TYPES) は lib/slot-builder から。
// EXTRA_MEAL_TYPES は食事の区分の正本 MEAL_ORDER から基本の 3 食を除いて作る (#1631。ここで手書きしない)

// 栄養素の値をフォーマット（浮動小数点誤差を修正）
const formatNutrition = (value: number | null | undefined, decimals = 1): string => {
  if (value === null || value === undefined) return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  
  // 丸め処理
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(num * factor) / factor;
  
  // 丸めた結果が0なら空文字を返す（表示しない）
  if (rounded === 0) return '';
  
  // 整数として表示する場合（decimals=0）：そのまま整数文字列に変換
  // 例: 100 → "100", 5.6 → "6"
  if (decimals === 0) {
    return String(Math.round(num));
  }
  
  // 小数点以下の表示がある場合
  const fixed = rounded.toFixed(decimals);
  
  // 小数部分が全て0の場合は整数として返す（例: "100.0" → "100"）
  if (fixed.endsWith('.0') || fixed.endsWith('.00')) {
    return String(Math.round(rounded));
  }
  
  // 末尾の余分な0だけを削除（例: "1.50" → "1.5"）
  // 整数部分の0は削除しない
  return fixed.replace(/(\.\d*[1-9])0+$/, '$1');
};

// 栄養素を表示すべきかどうか（丸めた結果が0より大きい場合のみ true）
const shouldShowNutrition = (value: number | null | undefined, decimals = 1): boolean => {
  if (value === null || value === undefined) return false;
  const num = Number(value);
  if (!Number.isFinite(num)) return false;
  // 丸めた結果が0より大きいかチェック
  const rounded = Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
  return rounded !== 0;
};

// 栄養素表示コンポーネント（値が有効な場合のみ表示）
const NutritionItem = ({ label, value, unit, decimals = 1, textColor }: { 
  label: string; 
  value: number | null | undefined; 
  unit: string; 
  decimals?: number;
  textColor?: string;
}) => {
  if (!shouldShowNutrition(value, decimals)) return null;
  const formatted = formatNutrition(value, decimals);
  if (!formatted) return null; // 追加の安全チェック
  return (
    <div className="flex justify-between gap-1">
      <span style={{ color: textColor }}>{label}</span>
      <span className="font-medium">{formatted}{unit}</span>
    </div>
  );
};

// PROGRESS_PHASES / ULTIMATE_PROGRESS_PHASES / SHOPPING_LIST_PHASES / PhaseDefinition は @homegohan/shared からインポート

// 材料テキストをパースして配列に変換
const parseIngredientsText = (text: string): { name: string; amount: string }[] => {
  const results: { name: string; amount: string }[] = [];
  
  // ヘッダー部分を除去 (「材料1人分使用量買い物量 (目安)」など)
  let cleaned = text.replace(/^材料\d*人分使用量買い物量\s*\(目安\)/g, '');
  // 注釈を除去
  cleaned = cleaned.replace(/※.+$/g, '');
  
  // パターン: 材料名 + 分量 (例: "キャベツ80 g" or "卵（Mサイズ）50 g" or "小さじ1/2 (2 g)")
  // 分量の後で区切る
  const regex = /([ぁ-んァ-ヶー一-龯a-zA-ZＡ-Ｚａ-ｚ（）\(\)・]+)(\d+\.?\d*\s*[gGmlMLm㎖㎗ℓ]|\d*[小大]さじ[\d\/]+[強弱]?\s*(?:\([^)]+\))?|少々|適量|\d+個|\d+枚|\d+本|\d+束|\d+袋|\d+缶|\d+丁|\d+片|\d+切れ|\d+合)/g;
  
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    const name = match[1].trim();
    const amount = match[2].trim();
    // 「A」「調味料」などの見出しをスキップ
    if (name.length > 0 && !['A', '調味料', '合わせ調味料'].includes(name)) {
      results.push({ name, amount });
    }
  }
  
  return results;
};

// 材料をマークダウンテーブルに変換
const formatIngredientsToMarkdown = (ingredientsText: string | null | undefined, ingredients: string[] | null | undefined): string => {
  // 配列の最初の要素が長いテキストの場合、パースを試みる
  if (ingredients && ingredients.length > 0) {
    const firstItem = ingredients[0];
    
    // 長いテキスト（100文字以上）の場合はパースが必要
    if (firstItem.length > 100) {
      const parsed = parseIngredientsText(firstItem);
      if (parsed.length > 0) {
        let md = "| 材料 | 分量 |\n|------|------|\n";
        // 重複を除去（使用量と買い物量で同じ材料が2回出る）
        const seen = new Set<string>();
        for (const p of parsed) {
          const key = `${p.name}-${p.amount}`;
          if (!seen.has(key)) {
            seen.add(key);
            md += `| ${p.name} | ${p.amount} |\n`;
          }
        }
        return md;
      }
    }
    
    // 既にパースされた配列の場合
    let md = "| 材料 | 分量 |\n|------|------|\n";
    for (const ing of ingredients) {
      if (ing.length < 100) {
        md += `| ${ing} |  |\n`;
      }
    }
    return md;
  }
  
  return '';
};

// 作り方をマークダウンに変換
const formatRecipeStepsToMarkdown = (recipeStepsText: string | null | undefined, recipeSteps: string[] | null | undefined): string => {
  // 配列がある場合は優先して使う（Edge Functionでパース済み）
  if (recipeSteps && recipeSteps.length > 0) {
    return recipeSteps.map((step, i) => `${i + 1}. ${step.replace(/^\d+\.\s*/, '')}`).join('\n\n');
  }
  return '';
};
// AI_CONDITIONS は @homegohan/shared からインポート

// Helper functions
// formatLocalDate は @homegohan/shared からインポート済み

const getWeekDates = (startDate: Date): { date: Date; dayOfWeek: string; dateStr: string }[] => {
  const days = [];
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    days.push({ date: d, dayOfWeek: dayNames[d.getDay()], dateStr: formatLocalDate(d) });
  }
  return days;
};

// Get week start date based on weekStartDay setting
const getWeekStart = (date: Date, weekStartDay: WeekStartDay = 'monday'): Date => {
  const d = new Date(date);
  const currentDay = d.getDay(); // 0 = Sunday, 6 = Saturday
  const targetDay = weekStartDay === 'sunday' ? 0 : 1; // Sunday = 0, Monday = 1

  let diff = currentDay - targetDay;
  if (diff < 0) diff += 7;

  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

// Get day labels based on week start day
const getDayLabels = (weekStartDay: WeekStartDay = 'monday'): string[] => {
  return weekStartDay === 'sunday'
    ? ['日', '月', '火', '水', '木', '金', '土']
    : ['月', '火', '水', '木', '金', '土', '日'];
};

const getDaysUntil = (dateStr: string | null | undefined): number | null => {
  if (!dateStr) return null;
  const target = parseLocalDate(dateStr);
  const now = parseLocalDate(todayLocal());
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
};

// Get calendar grid days for a month
const getCalendarDays = (month: Date, weekStartDay: WeekStartDay = 'monday'): Date[] => {
  const year = month.getFullYear();
  const m = month.getMonth();
  const firstDay = new Date(year, m, 1);
  const lastDay = new Date(year, m + 1, 0);

  // Calculate start padding based on week start day
  const firstDayOfWeek = firstDay.getDay(); // 0 = Sunday
  const startOffset = weekStartDay === 'sunday' ? 0 : 1;
  let startPadding = firstDayOfWeek - startOffset;
  if (startPadding < 0) startPadding += 7;

  const days: Date[] = [];

  // Previous month padding
  for (let i = startPadding - 1; i >= 0; i--) {
    days.push(new Date(year, m, -i));
  }
  // Current month
  for (let i = 1; i <= lastDay.getDate(); i++) {
    days.push(new Date(year, m, i));
  }
  // Next month padding (fill to complete weeks)
  while (days.length % 7 !== 0) {
    days.push(new Date(year, m + 1, days.length - lastDay.getDate() - startPadding + 1));
  }
  return days;
};

// Japanese holidays cache (year -> { dateStr: holidayName })
// 月カレンダーの前月・次月のボタンが表示月を動かす量 (月の数。shiftDisplayMonth に渡す)
const PREVIOUS_MONTH = -1;
const NEXT_MONTH = 1;

const holidaysCache = new Map<number, Record<string, string>>();

// Fetch Japanese holidays from holidays-jp API (#1769: URL は CSP の connect-src と同じ定数から作る)
const fetchJapaneseHolidays = async (year: number): Promise<Record<string, string>> => {
  if (holidaysCache.has(year)) {
    return holidaysCache.get(year)!;
  }

  try {
    const response = await fetch(japaneseHolidaysUrl(year));
    if (!response.ok) throw new Error('Failed to fetch holidays');
    const data = await response.json();
    holidaysCache.set(year, data);
    return data;
  } catch (error) {
    console.warn('Failed to fetch Japanese holidays:', error);
    return {};
  }
};

// Check if date is in the selected week
const isDateInWeek = (date: Date, weekStartDate: Date): boolean => {
  const weekEnd = new Date(weekStartDate);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  const dateStart = new Date(date);
  dateStart.setHours(0, 0, 0, 0);
  return dateStart >= weekStartDate && dateStart <= weekEnd;
};

// UX2-10 / #1597: V4進捗をUI形式に変換するヘルパー関数 (convertV4ProgressToUIFormat) は ./_state/v4ProgressUi.ts。
// 究極モードの段か通常の段かは、呼び出し側が生成の印 (ultimateMode) を渡して決める (totalSteps では見分けない)

// ============================================
// Main Component
// ============================================

// ============================================
// AI 相談の成功の取り直しの受け手 (#2206 G1。設計書 docs/design/cross/26-ai-consultation-refetch-receivers.md §7.4・§9 #16)
// ============================================

/** 置き場所の鍵 (#2206 G1)。対象を替えて出すものは対象を含める */
const planKey = (weekStartKey: string) => `plan:${weekStartKey}`;
const mealDatesKey = (monthKey: string) => `mealDates:${monthKey}`; // monthKey = 'YYYY-MM'
const KEY_SHOPPING_LIST = "shoppingList";
/**
 * 今使っている買い物リスト (activeShoppingList。品目の追加・レシピの材料の追加の送り先の id) の鍵 (#2206 G1 R5)。置くのは
 * 買い物リストの再生成の完了の読み直し (readRegeneratedShoppingList) だけ。品目の鍵 KEY_SHOPPING_LIST と分ける: 同じ鍵にすると、
 * 完了の読み直しより新しい読み取り (取り直し・週の読み込み) が品目を先に置いたときに、送り先の一覧が置かれなくなる
 * (週の応答から activeShoppingList を置く経路は今も無い)
 */
const KEY_ACTIVE_SHOPPING_LIST = "activeShoppingList";
const KEY_PANTRY = "pantry";
const KEY_SETTINGS = "settings";
const KEY_FAMILY = "family";
/**
 * 全画面のスピナーの鍵 (読み込み中だけの鍵。§6.4)。fetchPlan が立て、最後の fetchPlan の読み取りの終わりで下りる。
 * 表示中の週の献立を置いた読み取り (取り直し・生成の完了の読み直し・書き込みのあとの読み直しを含む) も、
 * releaseWeekLoadingIfShown で何もしない apply で置いて下ろす (前の refreshMealPlan の place の中の setLoading(false)。S-22)
 */
const KEY_WEEK_LOADING = "weekLoading";
/** 食事の完了の切り替えを送るまでの待ち (ミリ秒)。連打を 1 回にまとめる (#322 の 250ms をそのまま名前に) */
const MEAL_TOGGLE_DEBOUNCE_MS = 250;
/** 週の控え (weekDataCache) を使ってよい時間 (ミリ秒。今の 5 分をそのまま名前に。運用で変える値ではない) */
const CACHE_TTL = 5 * 60 * 1000;
/** 1 週の献立を読む範囲の最終日 = 週の初日 + 6 日 (GET /api/meal-plans の 7 日の範囲) */
const MEAL_PLANS_WEEK_LAST_DAY_OFFSET = 6;
/** 前後の週の先読みの、週の初日どうしの間の日数 (1 週) */
const ADJACENT_WEEK_OFFSET_DAYS = 7;

/** GET /api/meal-plans の応答。失敗 (非 ok) は null (控えに書かず・画面にも置かない) */
const fetchWeekData = async (weekStartKey: string): Promise<MealPlansWeekResponse | null> => {
  const res = await fetch(`/api/meal-plans?startDate=${weekStartKey}&endDate=${addDaysStr(weekStartKey, MEAL_PLANS_WEEK_LAST_DAY_OFFSET)}`);
  if (!res.ok) return null;
  return (await res.json()) as MealPlansWeekResponse;
};

/** 週の応答を控え (weekDataCache) に書く形にする (献立 0 件は plan: null。買い物リストは応答のまま) */
const weekCacheDataOf = (week: MealPlansWeekResponse): WeekCacheData => {
  const dailyMeals: MealPlanDay[] = week.dailyMeals ?? [];
  return { plan: dailyMeals.length > 0 ? { days: dailyMeals } : null, shoppingList: week.shoppingList?.items ?? [] };
};

/**
 * 週の応答の置き方の、呼び出し元ごとの違い (#2206 G1 R3)。今の呼び出し元ごとの置き方をそのまま名前にした (§7.4 の置き方の表)。
 * 1 つの補助 applyWeekResponse に寄せても、呼び出し元ごとの置き方は変えない (変えるのは §6.7 の 5 点だけ)
 */
interface WeekPlacement {
  /** 献立 0 件の応答: 'null' = 空の週として置く / 'keep' = 何も置かない (献立・控え・買い物リスト・カレンダーの印のどれも) */
  readonly emptyPlan: "null" | "keep";
  /** 買い物リスト: 'always' = 空でも置く / 'nonEmpty' = 品目があるときだけ置く / 'none' = 置かない */
  readonly shoppingList: "always" | "nonEmpty" | "none";
  /**
   * 月のカレンダーの印: 'none' = 触らない / 'merge' = 献立のある日を足す (updateCalendarMealDatesFromDailyMeals) /
   * 'sync' = 読んだ行のうち献立のある日を足し、献立の無い行の日を消す (syncCalendarMealDatesFromDailyMeals)
   */
  readonly calendar: "none" | "merge" | "sync";
  /** 直近の食事の自動展開 (autoExpandNextMeal) を呼ぶか */
  readonly expandNextMeal: boolean;
}
/** 週の読み込み (fetchPlan の控えミス)。買い物リストの「空でも置く」だけが今からの変更 (§6.7) */
const WEEK_PLACEMENT_WEEK_READ: WeekPlacement = { emptyPlan: "null", shoppingList: "always", calendar: "none", expandNextMeal: true };
/** 取り直し・refreshMealPlan の 6 か所 (今の refreshMealPlan と同じ) */
const WEEK_PLACEMENT_REREAD: WeekPlacement = { emptyPlan: "null", shoppingList: "always", calendar: "merge", expandNextMeal: false };
/** 生成の完了 (ポーリング・Realtime・再生成・改善) と写真の解析の結果 (今の直接の setCurrentPlan と同じ) */
const WEEK_PLACEMENT_COMPLETION: WeekPlacement = { emptyPlan: "keep", shoppingList: "nonEmpty", calendar: "merge", expandNextMeal: false };
/** 食事の追加のあとの読み直し (handleAddMealWithMode) */
const WEEK_PLACEMENT_AFTER_ADD: WeekPlacement = { emptyPlan: "keep", shoppingList: "none", calendar: "merge", expandNextMeal: false };
/** 削除・手入力の保存のあとの読み直し (confirmDeleteMeal・saveManualEdit。献立の無くなった日の印を消す。S-26) */
const WEEK_PLACEMENT_AFTER_REMOVE: WeekPlacement = { emptyPlan: "null", shoppingList: "none", calendar: "sync", expandNextMeal: false };
/** 並べ替えのあとの読み直し (reorderMeal) */
const WEEK_PLACEMENT_AFTER_REORDER: WeekPlacement = { emptyPlan: "keep", shoppingList: "none", calendar: "none", expandNextMeal: false };

/** 週の応答から食事を id で取る (追加した食事を手入力の編集 (命名) で開く。UX2-32) */
const plannedMealOf = (week: MealPlansWeekResponse | null, mealId: string): PlannedMeal | undefined =>
  (week?.dailyMeals ?? []).flatMap((day) => day.meals ?? []).find((meal) => meal.id === mealId);

/** 月のカレンダーの印を読む範囲 (#2206 G1。今の 2 つの effect の数をそのまま名前にした。運用で変える値ではない) */
/** 週の窓: 表示中の週の初日の何日前から (今の「前後 2 週間」の -14) */
const CALENDAR_MEAL_DATES_DAYS_BEFORE_WEEK = 14;
/** 週の窓: 表示中の週の初日の何日後まで (今の +28。表示中の週を含めて 4 週) */
const CALENDAR_MEAL_DATES_DAYS_AFTER_WEEK = 28;
/** 月の窓: 表示月の初日の前・末日の後に足す日数 (今の ±7) */
const CALENDAR_MEAL_DATES_MONTH_PADDING_DAYS = 7;

const shiftDays = (base: Date, days: number): Date => {
  const shifted = new Date(base);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
};
/** 週の窓 [始まり, 終わり] (今の「週が変わるタイミングで前後 2 週間をプリフェッチ」の effect と同じ範囲) */
const weekWindowOf = (weekStart: Date): [Date, Date] => [
  shiftDays(weekStart, -CALENDAR_MEAL_DATES_DAYS_BEFORE_WEEK),
  shiftDays(weekStart, CALENDAR_MEAL_DATES_DAYS_AFTER_WEEK),
];
/** 月の窓 [始まり, 終わり] (今の「displayMonth が変わったときも追加でフェッチ」の effect と同じ範囲) */
const monthWindowOf = (displayMonth: Date): [Date, Date] => {
  const firstDay = new Date(displayMonth.getFullYear(), displayMonth.getMonth(), 1);
  const lastDay = new Date(displayMonth.getFullYear(), displayMonth.getMonth() + 1, 0); // 翌月の 0 日 = 今月の末日
  return [shiftDays(firstDay, -CALENDAR_MEAL_DATES_MONTH_PADDING_DAYS), shiftDays(lastDay, CALENDAR_MEAL_DATES_MONTH_PADDING_DAYS)];
};
/** その日の月の鍵 ('YYYY-MM') */
const monthKeyOf = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
/** 範囲 [startDate, endDate] にかかる月の鍵 ('YYYY-MM') を古い順に */
const monthKeysBetween = (startDate: Date, endDate: Date): string[] => {
  const keys: string[] = [];
  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const lastMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  while (cursor <= lastMonth) {
    keys.push(monthKeyOf(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return keys;
};
/** 月の鍵 ('YYYY-MM') の初日と末日 (YYYY-MM-DD) */
const monthRangeOf = (monthKey: string): { first: string; last: string } => {
  const [year, month] = monthKey.split('-').map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0); // 翌月の 0 日 = 今月の末日
  return { first: formatLocalDate(firstDay), last: formatLocalDate(lastDay) };
};
/** 読んだ行のうち、献立のある日 */
const mealDatesOf = (dailyMeals: MealPlanDay[] | null | undefined): Set<string> => {
  const dates = new Set<string>();
  for (const day of dailyMeals ?? []) {
    if (day.meals && day.meals.length > 0) dates.add(day.dayDate);
  }
  return dates;
};

export default function WeeklyMenuPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 外国の AI 事業者へのデータ提供の同意画面 (T15 / #1154)。写真の解析・献立の生成・再生成・改善など、
  // 利用者が AI にデータを送る操作の直前に、未同意なら出す。「同意しない」なら操作をやめる (未同意のまま送っても、サーバーが 403 AI_CONSENT_REQUIRED で止める)。
  // V4GenerateModal (V4 生成) は、コンポーネントの中で同じ確認をする
  const { ensureAiConsent, consentModal } = useAiConsent();

  // ハンズオンツアー sandbox モード: ?tour=1 クエリで V4GenerateModal を sandbox モードで開く
  const tourMode = searchParams.get('tour') === '1';

  // -------------------------------------------------------
  // Phase B-2: useReducer 群
  // -------------------------------------------------------
  const [weekView, dispatchWeekView] = useReducer(weekViewReducer, initialWeekViewState);
  const [modal, dispatchModal] = useReducer(modalReducer, initialModalState);
  const [aiGen, dispatchAiGen] = useReducer(aiGenerationReducer, initialAiGenerationState);
  const [nutrition, dispatchNutrition] = useReducer(nutritionReducer, initialNutritionState);
  const [recipe, dispatchRecipe] = useReducer(recipeReducer, initialRecipeState);
  const [uiFlag, dispatchUiFlag] = useReducer(uiFlagReducer, initialUiFlagState);

  // -------------------------------------------------------
  // weekViewReducer から分解（後方互換エイリアス）
  // -------------------------------------------------------
  const currentPlan = weekView.currentPlan;
  // #1663: 値だけ受ける (関数形 (prev) => … は受けない)。関数形は、この setter を握った描画の時点の weekView.currentPlan で
  // 解決されるため、非同期の処理の closure (古い setter を握る) から呼ぶと今の献立を古い値で上書きしうる (#1644 と同じ型)。
  // 関数形で呼んでいる箇所は無い (使用箇所ごとに展開済み)
  const setCurrentPlan = useCallback((plan: WeekPlan | null) => {
    dispatchWeekView({ type: 'PLAN_SET', payload: plan });
  }, []);
  // 今の献立の 1 つの食事にだけ updates を当てる (楽観的な更新と、その巻き戻し。#2201 U2)。描画の時点の献立の写しから週全体を
  // 作り直して setCurrentPlan で置くと、その描画のあとに置いた献立 (完了の切り替えの待ちの間に届いた AI 相談の成功の取り直しの応答など)
  // を写しの古い献立で戻してしまう
  const updatePlanMeal = useCallback((dayId: string, mealId: string, updates: Partial<PlannedMeal>) => {
    dispatchWeekView({ type: 'PLAN_MEAL_UPDATE', payload: { dayId, mealId, updates } });
  }, []);

  const weekStart = weekView.weekStart;
  // 表示中の週の初日 (YYYY-MM-DD)。献立の取得の応答を置く前に、応答を待つあいだに週を移っていないかを見る (#2201 U1)
  const weekStartKeyRef = useRef(formatLocalDate(weekStart));
  weekStartKeyRef.current = formatLocalDate(weekStart);
  // 表示中の週の初日 (取り直しの月のカレンダーの週の窓 weekWindowOf を、読み始めた時点の週で決める。#2206 G1)
  const weekStartRef = useRef(weekStart);
  weekStartRef.current = weekStart;
  const setWeekStart = useCallback((d: Date) => dispatchWeekView({ type: 'WEEK_SET_START', payload: d }), []);
  // UX2-24: 前週/次週ボタン専用。selectedDayIndex をリセットしない WEEK_NAVIGATE_* を dispatch する
  const navigateWeekPrev = useCallback((d: Date) => dispatchWeekView({ type: 'WEEK_NAVIGATE_PREV', payload: d }), []);
  const navigateWeekNext = useCallback((d: Date) => dispatchWeekView({ type: 'WEEK_NAVIGATE_NEXT', payload: d }), []);

  const selectedDayIndex = weekView.selectedDayIndex;
  const setSelectedDayIndex = useCallback((idx: number) => dispatchWeekView({ type: 'DAY_SELECT', payload: idx }), []);

  const isCalendarExpanded = weekView.isCalendarExpanded;
  const setIsCalendarExpanded = useCallback((_v: boolean | ((prev: boolean) => boolean)) => dispatchWeekView({ type: 'CALENDAR_TOGGLE' }), []);

  const displayMonth = weekView.displayMonth;
  // #1663: 値だけ受ける (関数形を握った描画の時点の値で解決しない。#1644 と同じ型の芽を消す)。
  // 前月・次月への移動は、今の表示月からの相対の移動なので shiftDisplayMonth (DISPLAY_MONTH_SHIFT・reducer が今の状態で解決) を使う
  const setDisplayMonth = useCallback((d: Date) => {
    dispatchWeekView({ type: 'DISPLAY_MONTH_SET', payload: d });
  }, []);
  const shiftDisplayMonth = useCallback((months: number) => {
    dispatchWeekView({ type: 'DISPLAY_MONTH_SHIFT', payload: months });
  }, []);

  const weekStartDay = weekView.weekStartDay;
  const setWeekStartDay = useCallback((day: WeekStartDay) => {
    // WEEK_START_DAY_LOADED action を使用するため個別には不要 (fetchWeekStartDay 内でまとめて dispatch)
    // compat 用に残す（使用なし）
    void day;
  }, []);
  const weekStartDayLoaded = weekView.weekStartDayLoaded;
  const setWeekStartDayLoaded = useCallback((_v: boolean) => {
    // WEEK_START_DAY_LOADED に統合済み。個別 setter は互換用
    void _v;
  }, []);
  const holidays = weekView.holidays;
  // #1663: 値だけ受ける (関数形を握った描画の時点の値で解決しない。#1644 と同じ型の芽を消す)。
  // HOLIDAYS_SET は reducer の中で今の祝日に足し合わせる (上書きしない) ので、呼び出し側は取ってきた分だけを渡す
  const setHolidays = useCallback((v: Record<string, string>) => {
    dispatchWeekView({ type: 'HOLIDAYS_SET', payload: v });
  }, []);

  const calendarMealDates = weekView.calendarMealDates;
  // #1663: 値だけ受ける (関数形を握った描画の時点の値で解決しない。#1644 と同じ型の芽を消す)。
  // 今の集合に足すときは CALENDAR_MEAL_DATES_MERGE (reducer が今の状態で足す) を使う
  const setCalendarMealDates = useCallback((v: Set<string>) => {
    dispatchWeekView({ type: 'CALENDAR_MEAL_DATES_SET', payload: v });
  }, []);

  const expandedMealId = weekView.expandedMealId;
  const setExpandedMealId = useCallback((id: string | null) => dispatchWeekView({ type: 'MEAL_EXPAND', payload: id }), []);

  const hasAutoExpanded = weekView.hasAutoExpanded;
  // F1b-05: true 化は AUTO_EXPAND_SUPPRESS に委譲（自動展開の抑止フラグを正しく立てる）。
  // false 化は WEEK_SET_START/WEEK_NAVIGATE_* action が既にリセットするため no-op のまま。
  const setHasAutoExpanded = useCallback((v: boolean) => {
    if (v) dispatchWeekView({ type: 'AUTO_EXPAND_SUPPRESS' });
  }, []);

  const isDayNutritionExpanded = weekView.isDayNutritionExpanded;
  // F1b-04: 無条件 TOGGLE ではなく渡された真偽値を反映する。
  // #1663: 値だけ受ける (関数形を握った描画の時点の値で解決しない。#1644 と同じ型の芽を消す)。
  // 今の値を反転するときは DAY_NUTRITION_TOGGLE (reducer が今の状態で反転) を送る
  const setIsDayNutritionExpanded = useCallback((v: boolean) => {
    dispatchWeekView({ type: 'DAY_NUTRITION_SET', payload: v });
  }, []);
  const toggleDayNutritionExpanded = useCallback(() => {
    dispatchWeekView({ type: 'DAY_NUTRITION_TOGGLE' });
  }, []);

  const isTodayExpanded = weekView.isTodayExpanded;
  const setIsTodayExpanded = useCallback((_v: boolean | ((prev: boolean) => boolean)) => dispatchWeekView({ type: 'TODAY_TOGGLE' }), []);

  // -------------------------------------------------------
  // modalReducer から分解
  // -------------------------------------------------------
  const activeModal = modal.activeModal;
  const setActiveModal = useCallback((m: ModalType) => dispatchModal({ type: 'MODAL_OPEN', payload: m }), []);

  const showV4Modal = modal.showV4Modal;
  const setShowV4Modal = useCallback((v: boolean) => {
    if (v) dispatchModal({ type: 'V4_MODAL_OPEN' });
    else dispatchModal({ type: 'V4_MODAL_CLOSE' });
  }, []);

  const editingMeal = modal.editingMeal;
  const setEditingMeal = useCallback((m: PlannedMeal | null) => dispatchModal({ type: 'MODAL_SET_EDITING_MEAL', payload: m }), []);

  const regeneratingMeal = modal.regeneratingMeal;
  const setRegeneratingMeal = useCallback((m: PlannedMeal | null) => dispatchModal({ type: 'MODAL_SET_REGENERATING_MEAL', payload: m }), []);

  const regeneratingMealId = modal.regeneratingMealId;
  const setRegeneratingMealId = useCallback((id: string | null) => dispatchModal({ type: 'MODAL_SET_REGENERATING_MEAL_ID', payload: id }), []);

  const manualEditMeal = modal.manualEditMeal;
  const setManualEditMeal = useCallback((m: PlannedMeal | null) => dispatchModal({ type: 'MODAL_SET_MANUAL_EDIT_MEAL', payload: m }), []);

  const deletingMeal = modal.deletingMeal;
  const setDeletingMeal = useCallback((m: PlannedMeal | null) => dispatchModal({ type: 'MODAL_SET_DELETING_MEAL', payload: m }), []);

  const photoEditMeal = modal.photoEditMeal;
  const setPhotoEditMeal = useCallback((m: PlannedMeal | null) => dispatchModal({ type: 'MODAL_SET_PHOTO_EDIT_MEAL', payload: m }), []);
  // 写真から入力のモーダルを開いた回の番号 (#2047。modalReducer の photoEditSession)
  const photoEditSession = modal.photoEditSession;

  const imageGenerateMeal = modal.imageGenerateMeal;
  const setImageGenerateMeal = useCallback((m: PlannedMeal | null) => dispatchModal({ type: 'MODAL_SET_IMAGE_GENERATE_MEAL', payload: m }), []);

  const improveMealTargets = modal.improveMealTargets;
  const setImproveMealTargets = useCallback((targets: MealType[]) => dispatchModal({ type: 'IMPROVE_TARGETS_SET', payload: targets }), []);

  const showWeeklySummaryModal = modal.showWeeklySummaryModal;
  const setShowWeeklySummaryModal = useCallback((v: boolean) => {
    if (v) dispatchModal({ type: 'WEEKLY_SUMMARY_MODAL_OPEN' });
    else dispatchModal({ type: 'WEEKLY_SUMMARY_MODAL_CLOSE' });
  }, []);

  const showServingsModal = modal.showServingsModal;
  const setShowServingsModal = useCallback((v: boolean) => {
    if (v) dispatchModal({ type: 'SERVINGS_MODAL_OPEN' });
    else dispatchModal({ type: 'SERVINGS_MODAL_CLOSE' });
  }, []);

  const showImproveMealModal = modal.showImproveMealModal;
  const setShowImproveMealModal = useCallback((v: boolean) => {
    if (v) dispatchModal({ type: 'IMPROVE_MEAL_MODAL_OPEN' });
    else dispatchModal({ type: 'IMPROVE_MEAL_MODAL_CLOSE' });
  }, []);

  const showNutritionDetailModal = modal.showNutritionDetailModal;
  const setShowNutritionDetailModal = useCallback((v: boolean) => {
    if (v) dispatchModal({ type: 'NUTRITION_DETAIL_MODAL_OPEN' });
    else dispatchModal({ type: 'NUTRITION_DETAIL_MODAL_CLOSE' });
  }, []);

  const showConfirmDeleteAllShopping = modal.showConfirmDeleteAllShopping;
  const setShowConfirmDeleteAllShopping = useCallback((v: boolean) => {
    if (v) dispatchModal({ type: 'CONFIRM_DELETE_ALL_SHOPPING_OPEN' });
    else dispatchModal({ type: 'CONFIRM_DELETE_ALL_SHOPPING_CLOSE' });
  }, []);

  // UX2-11: AI生成の中止確認（window.confirm は使わず #1053 と同じ styled モーダルに統一）
  const showConfirmCancelGeneration = modal.showConfirmCancelGeneration;
  const setShowConfirmCancelGeneration = useCallback((v: boolean) => {
    if (v) dispatchModal({ type: 'CONFIRM_CANCEL_GENERATION_OPEN' });
    else dispatchModal({ type: 'CONFIRM_CANCEL_GENERATION_CLOSE' });
  }, []);

  const isDeleting = modal.isDeleting;
  const setIsDeleting = useCallback((v: boolean) => dispatchModal({ type: 'IS_DELETING_SET', payload: v }), []);

  // -------------------------------------------------------
  // aiGenerationReducer から分解
  // -------------------------------------------------------
  const isGenerating = aiGen.isGenerating;
  // UX2-12: 週間生成の対象スロット（`${date}::${mealType}`）。既知の場合のみ EmptySlot の
  // 「AIが考え中」表示をこの集合でスコープする。不明な生成経路（復元等）では null のままとし、
  // 従来どおり「今日以降の全スロット」表示にフォールバックする（過剰表示 > 誤って非表示、を優先）。
  const [genTargetSlotKeys, setGenTargetSlotKeysState] = useState<Set<string> | null>(null);
  const setGenTargetSlotKeys = useCallback((slots: TargetSlot[] | null) => {
    setGenTargetSlotKeysState(slots ? new Set(slots.map(s => `${s.date}::${s.mealType}`)) : null);
  }, []);
  const setIsGenerating = useCallback((v: boolean) => {
    if (v) {
      // UX2-11: 新しい生成が始まったら「中止済み」ガードをリセットする
      generationCancelledRef.current = false;
      dispatchAiGen({ type: 'GEN_START' });
    } else {
      dispatchAiGen({ type: 'GEN_SUCCESS' });
      // UX2-12: 生成終了時は対象スロット情報もクリアする
      setGenTargetSlotKeysState(null);
    }
  }, []);
  // #1629: 画面に入り直して生成中の行 (GET /api/ai/menu/weekly/pending) を見つけたときの復元 (fetchPlan・checkPendingRequests)。
  // setIsGenerating(true) (GEN_START) は進捗を null に戻すので使わない。生成中にし、進捗がまだ無いときだけ
  // 空の進捗 (段の印だけ) を置く。すでに生成中で進捗があるとき (生成中のリロードで restoreGeneration が先に DB の進捗を置いた・
  // キャッシュが切れたあとに同じ週へ戻った) は残す (以前は最初のポーリングが返るまでの 1 往復だけ見出しが既定の文に戻っていた)。
  // 見分けは reducer の中で今の状態に対して行う (fetchPlan は前の描画の setGenerationProgress を握っているので、
  // prev => prev ?? ... の形でもそこでは古い値を見て上書きしてしまう)
  const resumePendingGeneration = useCallback((ultimateMode: boolean) => {
    // UX2-11: 生成中にするときは setIsGenerating(true) と同じく「中止済み」ガードをリセットする
    generationCancelledRef.current = false;
    dispatchAiGen(resumePendingGenerationAction(ultimateMode));
  }, []);

  const generatingMeal = aiGen.generatingMeal;
  const setGeneratingMeal = useCallback((m: { dayIndex: number; mealType: MealType } | null) => dispatchAiGen({ type: 'GENERATING_MEAL_SET', payload: m }), []);

  const generationProgress = aiGen.generationProgress;
  // F1b-03: null は GEN_SUCCESS ではなく GEN_PROGRESS_CLEAR（isGenerating/generatingMeal を巻き込まない）。
  // #1644: 関数形 (prev) => … は受け取らない。関数形は、この setter を握った描画の時点の aiGen.generationProgress で
  // 解決されるため、ポーリングの closure (古い setter を握る) からは今の進捗を古い値 (null) で上書きしていた。
  const setGenerationProgress = useCallback((v: GenerationProgress | null) => {
    if (v === null) {
      dispatchAiGen({ type: 'GEN_PROGRESS_CLEAR' });
    } else {
      dispatchAiGen({ type: 'GEN_PROGRESS', payload: v });
    }
  }, []);
  // #1663: ポーリング (V4 の生成・献立の改善) が DB から読んだ進捗を置く。生成中のときだけ GEN_PROGRESS と同じに置く
  // (割合は Math.max で戻らない。Realtime も同じ GEN_PROGRESS なので、届くときは Realtime が先に進む)。
  // 生成中かは reducer の中で今の状態で判定する (GEN_PROGRESS_WHILE_GENERATING)。完了・失敗・中止のあとに着いた応答では何も置かない。
  // 前の生成の応答 (別の生成の開始のあと) は、呼び出し側の監視の印 (#1657) で止める。
  // (#1644 の setGenerationProgressIfEmpty (今が null のときだけ置く) は、生成の開始で初期の進捗 (3% / 5%) を置いたあとは
  // 一度も DB の進捗を置かず、Realtime が不通だと完了まで初期の進捗のまま止まって見えたので、ポーリングでは使わない。
  // 「今が null のときだけ置く」が要る経路はもう無いので、setter ごと外した)
  const setGenerationProgressWhileGenerating = useCallback((v: GenerationProgress) => {
    dispatchAiGen({ type: 'GEN_PROGRESS_WHILE_GENERATING', payload: v });
  }, []);

  // T15 (#1154): 生成の失敗の文が「同意が無くてサーバーが止めた」ものなら、同意画面を出して失敗をクリアし、失敗パネルには出さない
  // (失敗を出す経路 = onError・復元・Realtime・ポーリングはどれも GEN_FAIL でここに入るので、ここ 1 か所で見分ける)
  const generationFailedError = useAiConsentGenerationFailure(aiGen.generationFailedError, dispatchAiGen);
  const generationFailedRequestId = aiGen.generationFailedRequestId;
  // F1b-02: error/requestId は必ず単一 GEN_FAIL dispatch でセット・単一 GEN_FAILED_CLEAR で解除する。
  // 個別 setter は二重 dispatch (片方が null で上書き) を招くため廃止し、呼び出し元で直接 dispatch する。

  const isRegenerating = aiGen.isRegenerating;
  const setIsRegenerating = useCallback((v: boolean) => {
    if (v) dispatchAiGen({ type: 'REGEN_START' });
    else dispatchAiGen({ type: 'REGEN_END' });
  }, []);

  const isImprovingMeal = aiGen.isImprovingMeal;
  const setIsImprovingMeal = useCallback((v: boolean) => {
    if (v) dispatchAiGen({ type: 'IMPROVE_MEAL_START' });
    else dispatchAiGen({ type: 'IMPROVE_MEAL_END' });
  }, []);

  const improveNextDay = aiGen.improveNextDay;
  const setImproveNextDay = useCallback((v: boolean) => dispatchAiGen({ type: 'IMPROVE_NEXT_DAY_SET', payload: v }), []);

  const isAnalyzingPhoto = aiGen.isAnalyzingPhoto;
  // 写真の解析を始める: 解析している写真を送ったモーダルの回 (photoEditSession) を控える (#2047)
  const startPhotoAnalyze = useCallback((session: number) => dispatchAiGen({ type: 'PHOTO_ANALYZE_START', payload: { session } }), []);
  const endPhotoAnalyze = useCallback(() => dispatchAiGen({ type: 'PHOTO_ANALYZE_END' }), []);
  // いま開いている写真から入力のモーダル (回) から見た写真の解析の状態 (#2047)。
  // 'own' = このモーダルで送った写真を解析中 / 'other' = 前のモーダルで送った写真の結果を待っている / 'idle' = 解析していない
  const photoEditAnalyzeState = photoAnalyzeStateForSession(aiGen, photoEditSession);

  const isGeneratingMealImage = aiGen.isGeneratingMealImage;
  const setIsGeneratingMealImage = useCallback((v: boolean) => {
    if (v) dispatchAiGen({ type: 'IMAGE_GEN_START' });
    else dispatchAiGen({ type: 'IMAGE_GEN_END' });
  }, []);

  // -------------------------------------------------------
  // nutritionReducer から分解
  // -------------------------------------------------------
  const radarChartNutrients = nutrition.radarChartNutrients;
  const setRadarChartNutrients = useCallback((v: string[]) => dispatchNutrition({ type: 'RADAR_NUTRIENTS_SET', payload: v }), []);

  const nutritionFeedback = nutrition.nutritionFeedback;
  const setNutritionFeedback = useCallback((v: string | null) => dispatchNutrition({ type: 'NUTRITION_FEEDBACK_SET', payload: v }), []);

  const praiseComment = nutrition.praiseComment;
  const setPraiseComment = useCallback((v: string | null) => dispatchNutrition({ type: 'PRAISE_COMMENT_SET', payload: v }), []);

  const nutritionTip = nutrition.nutritionTip;
  const setNutritionTip = useCallback((v: string | null) => dispatchNutrition({ type: 'NUTRITION_TIP_SET', payload: v }), []);

  const isLoadingFeedback = nutrition.isLoadingFeedback;
  const setIsLoadingFeedback = useCallback((v: boolean) => {
    if (v) dispatchNutrition({ type: 'FEEDBACK_LOADING_START' });
    else dispatchNutrition({ type: 'FEEDBACK_LOADING_END' });
  }, []);

  const isEditingRadarNutrients = nutrition.isEditingRadarNutrients;
  const setIsEditingRadarNutrients = useCallback((v: boolean) => {
    if (v) dispatchNutrition({ type: 'RADAR_EDIT_START' });
    else dispatchNutrition({ type: 'RADAR_EDIT_CANCEL' });
  }, []);

  const tempRadarNutrients = nutrition.tempRadarNutrients;
  const setTempRadarNutrients = useCallback((v: string[]) => dispatchNutrition({ type: 'TEMP_RADAR_NUTRIENTS_SET', payload: v }), []);

  const isSavingRadarNutrients = nutrition.isSavingRadarNutrients;
  const setIsSavingRadarNutrients = useCallback((_v: boolean) => {
    // RADAR_SAVING_START/END を使う。個別 setter は互換用
    if (_v) dispatchNutrition({ type: 'RADAR_SAVING_START' });
    // end は payload(saved nutrients) が必要なため RADAR_SAVING_END は別途呼ぶ
  }, []);

  const lastFeedbackDate = nutrition.lastFeedbackDate;
  const setLastFeedbackDate = useCallback((v: string | null) => dispatchNutrition({ type: 'LAST_FEEDBACK_DATE_SET', payload: v }), []);

  const feedbackCacheId = nutrition.feedbackCacheId;
  const setFeedbackCacheId = useCallback((v: string | null) => dispatchNutrition({ type: 'FEEDBACK_CACHE_ID_SET', payload: v }), []);

  const weeklySummaryTab = nutrition.weeklySummaryTab;
  const setWeeklySummaryTab = useCallback((v: 'today' | 'week') => dispatchNutrition({ type: 'WEEKLY_SUMMARY_TAB_SET', payload: v }), []);

  const weeklyNutritionFeedback = nutrition.weeklyNutritionFeedback;
  const setWeeklyNutritionFeedback = useCallback((v: string | null) => dispatchNutrition({ type: 'WEEKLY_NUTRITION_FEEDBACK_SET', payload: v }), []);

  const isLoadingWeeklyFeedback = nutrition.isLoadingWeeklyFeedback;
  const setIsLoadingWeeklyFeedback = useCallback((v: boolean) => {
    if (v) dispatchNutrition({ type: 'WEEKLY_FEEDBACK_LOADING_START' });
    else dispatchNutrition({ type: 'WEEKLY_FEEDBACK_LOADING_END' });
  }, []);

  // -------------------------------------------------------
  // recipeReducer から分解
  // -------------------------------------------------------
  const selectedRecipe = recipe.selectedRecipe;
  const setSelectedRecipe = useCallback((v: string | null) => dispatchRecipe({ type: 'RECIPE_SELECT', payload: v }), []);

  const selectedRecipeData = recipe.selectedRecipeData as Record<string, unknown> | null;
  const setSelectedRecipeData = useCallback((v: unknown) => dispatchRecipe({ type: 'RECIPE_DATA_SET', payload: v }), []);

  const isFavorite = recipe.isFavorite;
  const setIsFavorite = useCallback((v: boolean) => dispatchRecipe({ type: 'FAVORITE_SET', payload: v }), []);

  const isFavoriteLoading = recipe.isFavoriteLoading;
  const setIsFavoriteLoading = useCallback((v: boolean) => dispatchRecipe({ type: 'FAVORITE_LOADING_SET', payload: v }), []);

  const favoriteId = recipe.favoriteId;
  const setFavoriteId = useCallback((v: string | null) => dispatchRecipe({ type: 'FAVORITE_ID_SET', payload: v }), []);
  /**
   * 料理のモーダルの回 (#2011)。モーダルが開く・閉じる・別の料理になるたびに status の effect が 1 つ進める。
   * status・POST・DELETE の応答は、送った時点の回と今の回が同じときだけ ♥ の印・favoriteId・取得中の印に入れる
   * (押したあとに閉じて別の料理を開くと、前の料理の応答が今の料理の印と id を書き換えるため)
   */
  const favoriteSessionRef = useRef(0);
  /** 料理のモーダルが開いているか (買い物リストの追加は activeModal だけを閉じ selectedRecipe を残す) */
  const isRecipeModalOpen = activeModal === 'recipe' && selectedRecipe !== null;

  const aiSuggestions = recipe.aiSuggestions;
  const setAiSuggestions = useCallback((v: unknown[]) => dispatchRecipe({ type: 'AI_SUGGESTIONS_SET', payload: v }), []);

  const aiHint = recipe.aiHint;
  const setAiHint = useCallback((v: string) => dispatchRecipe({ type: 'AI_HINT_SET', payload: v }), []);

  const isLoadingHint = recipe.isLoadingHint;
  const setIsLoadingHint = useCallback((v: boolean) => {
    if (v) dispatchRecipe({ type: 'HINT_LOADING_START' });
    else dispatchRecipe({ type: 'HINT_LOADING_END' });
  }, []);

  // -------------------------------------------------------
  // uiFlagReducer から分解
  // -------------------------------------------------------
  // 週の読み込み中の表示 (uiFlag.loading) は、AI 相談の取り直しの受け手 (receiver.isLoading(KEY_WEEK_LOADING)) が持つ (#2206 G1。下の receiver の宣言のあと)

  const successMessage = uiFlag.successMessage;
  const setSuccessMessage = useCallback((v: typeof uiFlag.successMessage) => {
    if (v === null) dispatchUiFlag({ type: 'SUCCESS_DISMISS' });
    else dispatchUiFlag({ type: 'SUCCESS_SHOW', payload: v });
  }, []);

  const shouldRestoreSubscription = uiFlag.shouldRestoreSubscription;
  const setShouldRestoreSubscription = useCallback((v: boolean) => dispatchUiFlag({ type: 'SUBSCRIPTION_RESTORE_SET', payload: v }), []);

  // -------------------------------------------------------
  // Phase B-2: weekView 導出値
  // -------------------------------------------------------
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);
  // 表示中の週の 7 日 (依存の少ない useCallback の読み取り・生成中の依頼の確認から、今の週の日付を読む。#2206 G1)
  const weekDatesRef = useRef(weekDates);
  weekDatesRef.current = weekDates;
  // 表示中の月 (取り直しの月のカレンダーの月の窓 monthWindowOf を、読み始めた時点の月で決める。#2206 G1)
  const displayMonthRef = useRef(weekView.displayMonth);
  displayMonthRef.current = weekView.displayMonth;

  // ハンズオンツアー: ?tour=1 クエリで V4GenerateModal を自動オープン
  useEffect(() => {
    if (tourMode) {
      setShowV4Modal(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourMode]);

  // Week start day setting & holidays (fetch)

  // Fetch user's weekStartDay setting
  useEffect(() => {
    const fetchWeekStartDay = async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        dispatchWeekView({
          type: 'WEEK_START_DAY_LOADED',
          payload: { weekStartDay: 'monday', weekStart: weekView.weekStart },
        });
        return;
      }
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('week_start_day')
        .eq('id', user.id)
        .single();
      if (profile?.week_start_day) {
        const newWeekStartDay = profile.week_start_day as WeekStartDay;
        dispatchWeekView({
          type: 'WEEK_START_DAY_LOADED',
          payload: {
            weekStartDay: newWeekStartDay,
            weekStart: getWeekStart(new Date(), newWeekStartDay),
          },
        });
      } else {
        dispatchWeekView({
          type: 'WEEK_START_DAY_LOADED',
          payload: { weekStartDay: 'monday', weekStart: weekView.weekStart },
        });
      }
    };
    fetchWeekStartDay();
  }, []);

  // UX2-16/UX2-31: meals/new・meals/[id] からの遷移（?date=&mealType=&saved=1 / ?date=&meal=）を
  // 初回レンダリング時にスナップショット。後段の router.replace でクエリが消えても参照できるようにする。
  const initialQueryParamsRef = useRef({
    date: searchParams.get('date'),
    saved: searchParams.get('saved') === '1',
    mealType: searchParams.get('mealType'),
    mealId: searchParams.get('meal'),
  });

  // UX2-16: ?date= があれば対象日を含む週・曜日を初期選択する
  useEffect(() => {
    const { date } = initialQueryParamsRef.current;
    if (!date || !weekStartDayLoaded) return;
    const target = parseLocalDate(date);
    if (Number.isNaN(target.getTime())) return;
    setWeekStart(getWeekStart(target, weekStartDay));
    const dayOfWeekRaw = target.getDay();
    const startOffset = weekStartDay === 'sunday' ? 0 : 1;
    let dayIndex = dayOfWeekRaw - startOffset;
    if (dayIndex < 0) dayIndex += 7;
    setSelectedDayIndex(dayIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartDayLoaded, weekStartDay]);

  // UX2-16: ?saved=1 なら保存成功のフィードバックを表示し、URL からクエリを除去する（多重表示防止）
  useEffect(() => {
    const { date, saved, mealType } = initialQueryParamsRef.current;
    if (!saved) return;
    const mealLabel = mealType && (mealType in MEAL_LABELS) ? MEAL_LABELS[mealType as MealType] : '食事';
    setSuccessMessage({
      title: '保存しました',
      message: date ? `${formatDateJa(date)}の${mealLabel}に保存しました` : `${mealLabel}を保存しました`,
    });
    router.replace('/menus/weekly', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // UX2-31: ?meal= があれば、該当献立を展開して編集モーダルを直接開く（従来は献立表トップに飛ぶだけだった）。
  // openManualEdit はファイル後方で定義されるため前方参照になるが、useEffect は render 完了後に実行されるため問題ない
  // （本ファイルの subscribeToRequestStatus 等と同じ確立済みパターン）。
  const appliedMealParamRef = useRef(false);
  useEffect(() => {
    const { mealId } = initialQueryParamsRef.current;
    if (!mealId || appliedMealParamRef.current || !currentPlan) return;
    const found = currentPlan.days?.flatMap(d => d.meals || []).find(m => m.id === mealId);
    if (found) {
      appliedMealParamRef.current = true;
      setExpandedMealId(found.id);
      openManualEdit(found);
      router.replace('/menus/weekly', { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPlan]);

  // Fetch holidays for displayed year
  useEffect(() => {
    const fetchHolidays = async () => {
      const year = displayMonth.getFullYear();
      const data = await fetchJapaneseHolidays(year);
      setHolidays(data);
      // Also fetch adjacent year if near year boundary
      const month = displayMonth.getMonth();
      if (month === 0) {
        const prevYearData = await fetchJapaneseHolidays(year - 1);
        setHolidays(prevYearData);
      } else if (month === 11) {
        const nextYearData = await fetchJapaneseHolidays(year + 1);
        setHolidays(nextYearData);
      }
    };
    fetchHolidays();
    // setHolidays は値だけ受け、今の値を握らない (deps が空の useCallback) ので、deps に入れても再実行は起きない (#1663)
  }, [displayMonth, setHolidays]);

  // Sync displayMonth when weekStart changes
  useEffect(() => {
    setDisplayMonth(weekStart);
  }, [weekStart]);

  // Calendar meal dates - 月カレンダー用の献立存在日マップ（weekViewReducer 管理）
  // 月のカレンダーの印。範囲を月に割り、月ごとに読む (鍵は月。重なる範囲の古い応答が AI の足した印を消さない。#2206 G1)。
  // 読んだ月は fetchedMonthsRef に覚え、次に同じ月を出すときは読まない (取り直しは捨ててから読み直す)
  const fetchedMonthsRef = useRef<Set<string>>(new Set());
  const fetchAndCacheMealDates = useCallback(async (read: AiConsultationRead, startDate: Date, endDate: Date) => {
    for (const monthKey of monthKeysBetween(startDate, endDate)) {
      if (fetchedMonthsRef.current.has(monthKey)) continue;
      fetchedMonthsRef.current.add(monthKey);
      const { first, last } = monthRangeOf(monthKey);
      try {
        const res = await fetch(`/api/meal-plans?startDate=${first}&endDate=${last}`);
        if (!res.ok) { fetchedMonthsRef.current.delete(monthKey); continue; }
        const { dailyMeals } = await res.json();
        // 読んだ月の中だけを答えに置き換える (月の外の日 = 他の月の印はそのまま)。
        // 足すだけ (MERGE) だと、月の中で献立が無くなった日 (AI 相談で消した食事の日など) の印が残る (#2195 V1)
        const placed = read.place(mealDatesKey(monthKey), () => {
          dispatchWeekView({ type: "CALENDAR_MEAL_DATES_REPLACE_RANGE", payload: { startDate: first, endDate: last, dates: mealDatesOf(dailyMeals) } });
        });
        // 置かない取り直しの応答: 月を取得済みにしない (止めた取り直しが、外れたときにもう一度読む)
        if (placed === "deferred") fetchedMonthsRef.current.delete(monthKey);
      } catch (error) {
        console.error("Failed to fetch calendar meal dates:", error);
        // エラー時は取得済みから外して再試行可能に
        fetchedMonthsRef.current.delete(monthKey);
      }
    }
  }, []);

  // dailyMeals から献立存在日を calendarMealDates に追加
  const updateCalendarMealDatesFromDailyMeals = useCallback((dailyMeals: any[]) => {
    if (!dailyMeals || dailyMeals.length === 0) return;

    const newDates = new Set<string>();
    dailyMeals.forEach((day: any) => {
      if (day.meals && day.meals.length > 0) {
        newDates.add(day.dayDate);
      }
    });

    if (newDates.size > 0) {
      dispatchWeekView({ type: 'CALENDAR_MEAL_DATES_MERGE', payload: newDates });
    }
  }, []);

  // dailyMeals から献立存在日を同期（献立がない日は削除）。
  // 読んだ行のうち献立のある日を足し、献立の無い行の日を消す (前と同じ結果。読んでいない日はそのまま)。描画の閉包の
  // weekView.calendarMealDates から集合を作って SET すると古い集合で戻すので、reducer に足す・消すを頼む (依存が無いので
  // applyWeekResponse の参照も変わらない。#2206 G1 R3)
  const syncCalendarMealDatesFromDailyMeals = useCallback((dailyMeals: MealPlanDay[]) => {
    const withMeals = new Set<string>();
    for (const day of dailyMeals) {
      if (day.meals && day.meals.length > 0) withMeals.add(day.dayDate);
      else dispatchWeekView({ type: "CALENDAR_MEAL_DATES_REPLACE_RANGE", payload: { startDate: day.dayDate, endDate: day.dayDate, dates: new Set<string>() } });
    }
    if (withMeals.size > 0) dispatchWeekView({ type: "CALENDAR_MEAL_DATES_MERGE", payload: withMeals });
  }, []);

  // 月のカレンダーの印を週・月の変化で読む 2 つの effect は、receiver の宣言のあと (依存の配列に receiver を書く。#2206 G1)

  // Expanded Meal State - weekViewReducer 管理（同じタイプの複数食事に対応）

  // 直近の食事を自動展開する関数
  const autoExpandNextMeal = (plan: WeekPlan | null, dates: { dateStr: string }[]) => {
    if (!plan || !plan.days || hasAutoExpanded) return;
    
    const now = new Date();
    const todayStr = formatLocalDate(now);
    const currentHour = now.getHours();
    
    // 時間帯に応じた食事タイプの優先順位
    const getMealPriority = (hour: number): MealType[] => {
      if (hour < 10) return ['breakfast', 'lunch', 'dinner'];
      if (hour < 14) return ['lunch', 'dinner', 'breakfast'];
      if (hour < 20) return ['dinner', 'lunch', 'breakfast'];
      return ['dinner', 'midnight_snack', 'snack'];
    };
    
    const mealPriority = getMealPriority(currentHour);
    
    // 今日の日付インデックスを探す
    const todayIndex = dates.findIndex(d => d.dateStr === todayStr);
    
    // 検索する日付の順序を決定（今日から順番に）
    const searchOrder: number[] = [];
    if (todayIndex >= 0) {
      // 今日から週末まで
      for (let i = todayIndex; i < dates.length; i++) {
        searchOrder.push(i);
      }
    } else {
      // 今日が範囲外の場合は最初から
      for (let i = 0; i < dates.length; i++) {
        searchOrder.push(i);
      }
    }
    
    // 直近の未完了食事を探す
    for (const dayIdx of searchOrder) {
      const dayDate = dates[dayIdx].dateStr;
      const day = plan.days.find(d => d.dayDate === dayDate);
      if (!day || !day.meals) continue;
      
      // 今日の場合は時間帯優先、それ以外は朝食から (並びは @homegohan/shared の MEAL_ORDER が正本 #1446)
      const priorities = dayIdx === todayIndex ? mealPriority : MEAL_ORDER_SHARED;
      
      for (const mealType of priorities) {
        const meal = day.meals.find((m: any) => m.mealType === mealType && !m.isCompleted);
        if (meal) {
          dispatchWeekView({ type: 'MEAL_AUTO_EXPANDED', payload: { mealId: meal.id, dayIndex: dayIdx } });
          return;
        }
      }
    }

    // 未完了がない場合は今日（または最初の日）の最初の食事を展開
    const fallbackDayIdx = todayIndex >= 0 ? todayIndex : 0;
    const fallbackDay = plan.days.find((d: any) => d.dayDate === dates[fallbackDayIdx]?.dateStr);
    if (fallbackDay?.meals?.[0]) {
      dispatchWeekView({ type: 'MEAL_AUTO_EXPANDED', payload: { mealId: fallbackDay.meals[0].id, dayIndex: fallbackDayIdx } });
    }
  };

  /**
   * 直近の食事の自動展開 (autoExpandNextMeal。中身は変えない) を、描画のたびに写す ref (#2206 G1 R2)。
   * fetchPlan・applyWeekResponse は依存の少ない useCallback なので、関数を直に呼ぶと最初の描画の閉包の hasAutoExpanded
   * (false) を読み、週を移るたびに展開し直す。前の fetchPlan は週が変わるたびに effect の中で作り直したので、その描画の値を読んでいた
   */
  const autoExpandNextMealRef = useRef(autoExpandNextMeal);
  autoExpandNextMealRef.current = autoExpandNextMeal;

  /**
   * 表示中の週の献立を置いたら、全画面のスピナー (KEY_WEEK_LOADING) も下ろす (#2206 G1 R2。S-22)。
   * placed はその週の鍵 (planKey(weekStartKey)) の place の結果。置けて、いまもその週を出しているときだけ
   * KEY_WEEK_LOADING を何もしない apply で置く (置いた鍵の読み込み中の印は立て主を問わず下りる。§6.4)。
   * 前の refreshMealPlan が place の中で setLoading(false) を呼んだのと同じ: 開いたときの週の読み込みの応答待ちに取り直しが
   * 先に置いたら、遅い読み込みの応答を待たずにスピナーを下ろし、置いた献立をスピナーの下に隠さない
   */
  const releaseWeekLoadingIfShown = useCallback(
    (read: AiConsultationRead, weekStartKey: string, placed: AiConsultationPlaceResult) => {
      if (placed !== "placed" || weekStartKeyRef.current !== weekStartKey) return;
      read.place(KEY_WEEK_LOADING, () => undefined);
    },
    [],
  );

  /**
   * 週の応答を画面と控えに置く (#2206 G1)。週の読み込み・取り直し・refreshMealPlan・生成の完了・再生成・写真・改善・手入力・削除・追加・
   * 並べ替えのあとの読み直しが全部これを通る (読み直した週を直接 setCurrentPlan に置く経路を残さない。番兵 P1)。
   * writeWeekCache は読み始める前に取った控えの書き込み口 (createWeekDataCache)。
   * placement は呼び出し元ごとの置き方 (WEEK_PLACEMENT_*。設計書 §7.4 の置き方の表)。
   * 買い物リストは週に関係なく使っている 1 つなので、週の確認の外で自分の鍵に置く。カレンダーの印は月ごとの印なので、週の確認の前に置く
   * (いまその週を出していなくても、その週の日の印は応答のとおり)
   */
  const applyWeekResponse = useCallback(
    (
      read: AiConsultationRead,
      weekStartKey: string,
      week: MealPlansWeekResponse,
      writeWeekCache: WeekDataCacheWriter<WeekCacheData>,
      placement: WeekPlacement,
    ): void => {
      const dailyMeals: MealPlanDay[] = week.dailyMeals ?? [];
      const plan = dailyMeals.length > 0 ? { days: dailyMeals } : null;
      // 献立 0 件を置かない呼び出し元 (生成の完了・写真・追加・並べ替え): 前と同じく何も置かない
      if (plan === null && placement.emptyPlan === "keep") return;
      const items: ShoppingListItem[] = week.shoppingList?.items ?? [];
      if (placement.shoppingList === "always" || (placement.shoppingList === "nonEmpty" && items.length > 0)) {
        read.place(KEY_SHOPPING_LIST, () => setShoppingList(items));
      }
      const placed = read.place(planKey(weekStartKey), () => {
        writeWeekCache({ plan, shoppingList: items });
        if (placement.calendar === "merge") updateCalendarMealDatesFromDailyMeals(dailyMeals);
        else if (placement.calendar === "sync") syncCalendarMealDatesFromDailyMeals(dailyMeals);
        // いまもこの週を出しているときだけ画面に置く (順序ではない。別の週へ移ったあとに届いた応答を新しい週の見出しの下に出さない)
        if (weekStartKeyRef.current !== weekStartKey) return;
        setCurrentPlan(plan);
        if (plan && placement.expandNextMeal) autoExpandNextMealRef.current(plan, weekDatesRef.current);
      });
      releaseWeekLoadingIfShown(read, weekStartKey, placed);
    },
    // setShoppingList・setCurrentPlan は値だけ受ける store / reducer の setter (参照は変わらない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateCalendarMealDatesFromDailyMeals, syncCalendarMealDatesFromDailyMeals, releaseWeekLoadingIfShown],
  );

  /**
   * 週の読み込み (fetchPlan) の失敗で、その週の献立を空にする (#2206 G1)。呼ぶのは fetchPlan だけ (取り直し・生成の完了・
   * 書き込みのあとの読み直しの失敗は、前の refreshMealPlan と同じく何も置かない = 今の表示を残す)。
   * いまもその週を出しているときだけ置く (別の週へ移ったあとに届いた失敗で、新しい週の献立を消さない。S-21。applyWeekResponse と同じ確かめ)
   */
  const placeWeekReadFailure = useCallback((read: AiConsultationRead, weekStartKey: string) => {
    if (read.mode !== "mount") return;
    const placed = read.place(planKey(weekStartKey), () => {
      if (weekStartKeyRef.current !== weekStartKey) return;
      setCurrentPlan(null);
    });
    releaseWeekLoadingIfShown(read, weekStartKey, placed);
  }, [releaseWeekLoadingIfShown, setCurrentPlan]);

  /**
   * 表示中の週を読んで置く (週の読み込み・取り直し・refreshMealPlan・追加・削除・手入力の保存・並べ替えのあとの読み直し)。
   * 読んだ週の応答を返す (追加のあとに作った食事を取る。UX2-32)。失敗 (非 ok・通信の失敗) は null で、何も置かない
   * (fetchPlan だけが placeWeekReadFailure で空を置く)。読み込み中の印は呼ぶ側が loadingKeys で立てる
   */
  const readDisplayedWeek = useCallback(
    async (read: AiConsultationRead, placement: WeekPlacement): Promise<MealPlansWeekResponse | null> => {
      const weekStartKey = weekStartKeyRef.current;
      const writeWeekCache = weekDataCache.current.beginWrite(weekStartKey);
      try {
        const week = await fetchWeekData(weekStartKey);
        if (week === null) return null;
        applyWeekResponse(read, weekStartKey, week, writeWeekCache, placement);
        return week;
      } catch (e) {
        console.error("Failed to read meal plan", e);
        return null;
      }
    },
    [applyWeekResponse],
  );

  // -------------------------------------------------------
  // Membership: Family view switcher state
  // -------------------------------------------------------
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const { viewState, setView } = useFamilyView(familyId);

  // 家族情報ロード (家族に所属している場合のみ switcher 表示)。
  // 開いたときと、切り替えの適用のときに読む (#1584 の 1・設計書 family/10 §16.1)。名前は GET /api/family/members/names の値を当てる
  // (名前の API の失敗は空の Map = display_name のまま)。family_id が無くなっていたら一覧を空にする (家族から外れたことを反映する)
  // AI 相談の成功のあと (refetchAfterAiConsultation) にも読む: 名前の API は、display_name の無いメンバー (自分を含む) に
  // プロフィールの名前 (user_profiles.nickname) を返し、AI 相談 (update_profile_preferences) は自分の nickname を書く (#2195 V1)。
  // メンバーの一覧の data が null なのは読み取りの失敗のときだけ (0 人なら [])。一覧の読み取りの失敗では今の一覧を残す
  // (名前の API の失敗は上のとおり display_name のまま。開いたときと同じ)
  // 自分のプロフィール (family_id) の読み取りの失敗では、家族から外れたとみなさずに今の切り替えを残す (#2201 U1。以前は error を見ずに
  // 一覧を空にしていたので、取り直しの通信の失敗で家族の切り替えが消えていた)。
  // 全部を読んでから 1 つの apply で置く (途中の段で setCurrentUserId・setFamilyId を置かない。#2206 G1 R4・設計書 §6.2)。
  // 取り直し ('refetch') は、プロフィール・家族の一覧・名前の API のどれか 1 つでも読めなければ何も置かない
  // (家族の切り替えと名前を残す)。ページの読み取り ('mount') の失敗は前と同じ:
  // プロフィールを読めなければ何も置かない・家族の一覧を読めなければ自分の id と family_id だけを置く・名前の API を読めなければ display_name のまま
  const loadFamilyData = useCallback(async (read: AiConsultationRead) => {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('family_id')
      .eq('id', user.id)
      .maybeSingle();
    if (profileError) return;
    const familyIdRead = profile?.family_id ?? null;
    if (familyIdRead === null) {
      read.place(KEY_FAMILY, () => {
        setCurrentUserId(user.id);
        setFamilyId(null);
        setFamilyMembers([]);
      });
      return;
    }

    const { data: members, error: membersError } = await supabase
      .from('family_members')
      .select('id, family_id, user_id, role, display_name, relationship, tags, share_meals, share_health, share_menu, child_profile, avatar_color, status, joined_at, removed_at')
      .eq('family_id', familyIdRead)
      .eq('status', 'active');
    if (membersError || !members) {
      // 家族の一覧を読めなかった: 取り直しは何も置かない。ページの読み取りは前と同じく自分の id と family_id だけを置く (一覧は置かない)
      if (read.mode === 'mount') {
        read.place(KEY_FAMILY, () => {
          setCurrentUserId(user.id);
          setFamilyId(familyIdRead);
        });
      }
      return;
    }
    const namesResult = await fetchFamilyMemberNamesResult();
    // 取り直しで名前の API を読めなかった: 何も置かない (出ている名前を「名前未設定」に落とさない。#2201 U1 をこの形で守る)
    if (!namesResult.ok && read.mode === 'refetch') return;
    const rows = members as FamilyMember[];
    read.place(KEY_FAMILY, () => {
      setCurrentUserId(user.id);
      setFamilyId(familyIdRead);
      setFamilyMembers(applyFamilyMemberNames(rows, namesResult.ok ? namesResult.names : new Map()));
    });
  }, []);
  // 開いたときに読む effect は receiver の宣言のあと (依存の配列に receiver を書く。#2206 G1)

  // 家族の献立 (#1584 の 1・設計書 family/10 §16.1)。自分以外で描くメンバー (others) が居るときだけ取る。状態は hook の中 (useState を足さない)
  const otherIds = useMemo(
    () => (currentUserId ? visibleOtherMemberIdsOf(viewState, familyMembers, currentUserId) : []),
    [viewState, familyMembers, currentUserId],
  );
  const familyMenuStartDate = formatLocalDate(weekStart);
  const familyMenu = useFamilyMenu({
    startDate: familyMenuStartDate,
    endDate: addDaysStr(familyMenuStartDate, FAMILY_MENU_WEEK_LAST_DAY_OFFSET),
    enabled: familyId !== null && otherIds.length > 0,
  });
  const familyMenuPartition = partitionFamilyMenuMembers(otherIds, familyMembers, familyMenu.data);
  /** その日・その区分の、行を描く家族の献立の数 (EXTRA の区分を描くかの判定) */
  const familyMealsCountOf = (dayDate: string, mealType: MealType): number =>
    familyMenuPartition.shown.reduce(
      (count, id) => count + familyMenuMealsOf(familyMenu.data?.members.find((m) => m.member_id === id), dayDate, mealType).length,
      0,
    );

  // Form States (#1031: formDraftStore に一本化。
  // aiChatInput/addMealKey/addMealDayIndex/selectedConditions はハンドラ内でのみ読むため
  // 各ハンドラ冒頭で useFormDraftStore.getState() から都度読む (§2 方針)。
  // setter だけはここで selector 購読して呼び出し側を変更せずに済ませる。
  const setAiChatInput = useFormDraftStore((s) => s.setAiChatInput);
  const setAddMealKey = useFormDraftStore((s) => s.setAddMealKey);
  const setAddMealDayIndex = useFormDraftStore((s) => s.setAddMealDayIndex);
  const setSelectedConditions = useFormDraftStore((s) => s.setSelectedConditions);
  // isGenerating / generatingMeal / generationProgress / generationFailedError / generationFailedRequestId
  // → aiGenerationReducer 管理 (Phase B-2 で移行済み)

  // 表示中の週の読み直し (refreshMealPlan) は receiver の宣言のあと (receiver.read で読む。#2206 G1。下の useV4MenuGeneration と
  // restoreGeneration の effect は、描画のあとに走る関数の中で呼ぶだけなので、宣言が後ろでもよい)

  // V4 Menu Generation Hook
  const v4Generation = useV4MenuGeneration({
    onGenerationStart: (reqId) => {
      console.log('V4 generation started:', reqId);
      setIsGenerating(true);
    },
    onGenerationComplete: () => {
      console.log('V4 generation completed');
      setIsGenerating(false);
      setGenerationProgress(null);  // 進捗表示をクリア
      refreshMealPlan();
      setSuccessMessage({ title: '献立が完成しました！', message: 'AIが献立を作成しました。', refreshOnDismiss: true });
      notifyMenuGenerated();
    },
    onError: (error) => {
      console.error('V4 generation error:', error);
      setIsGenerating(false);
      setGenerationProgress(null);  // 進捗表示をクリア
      // UX2-11: ユーザーが「中止する」を押した後に届く遅延イベントでは alert を出さない
      if (generationCancelledRef.current) {
        generationCancelledRef.current = false;
        return;
      }
      // UX2-02: alert() ではなく既存のリトライ付き失敗パネル(generationFailedError)に集約する
      dispatchAiGen({ type: 'GEN_FAIL', payload: { error, requestId: null } });
    },
  });

  // ページリロード時に進行中の生成を復元
  useEffect(() => {
    const restoreGeneration = async () => {
      const stored = localStorage.getItem('v4MenuGenerating');
      if (!stored) return;

      try {
        const { requestId, timestamp, totalSlots, ultimateMode: storedUltimateMode } = JSON.parse(stored);
        // 究極モードで始めた生成か (#1597)。生成を始めたときに useV4MenuGeneration が保存した要求で決める
        // (真偽値の true のときだけ究極モード。保存していない古い形の値は通常の生成として扱う)
        const restoredUltimateMode = isUltimateModeWeeklyMenuRequest(storedUltimateMode);
        // 30分以上経過していたら古いデータとして削除
        if (Date.now() - timestamp > 30 * 60 * 1000) {
          localStorage.removeItem('v4MenuGenerating');
          return;
        }

        console.log('[restore] Restoring V4 generation progress for requestId:', requestId);

        // まずステータスAPIで現在の状態を取得（リロード中に完了していた場合に対応）
        // Supabase クライアント直接参照ではなく API 経由とすることで E2E モックが機能する
        const statusRes = await fetch(`/api/ai/menu/weekly/status?requestId=${requestId}`);
        const currentStatus = statusRes.ok ? await statusRes.json() : null;
        console.log('[restore] Current status from API:', currentStatus);

        // すでに完了している場合
        if (currentStatus?.status === 'completed') {
          console.log('[restore] Generation already completed');
          localStorage.removeItem('v4MenuGenerating');
          refreshMealPlan();
          setSuccessMessage({ title: '献立が完成しました！', message: 'AIが献立を作成しました。', refreshOnDismiss: true });
          return;
        }

        // 失敗している場合
        if (currentStatus?.status === 'failed') {
          console.log('[restore] Generation failed');
          localStorage.removeItem('v4MenuGenerating');
          // UX2-02: alert() ではなく既存のリトライ付き失敗パネル(generationFailedError)に集約する
          dispatchAiGen({
            type: 'GEN_FAIL',
            payload: { error: weeklyMenuRequestErrorMessageForDisplay(currentStatus.errorMessage) || '生成に失敗しました', requestId },
          });
          return;
        }

        // まだ進行中の場合、UI状態を復元して進捗追跡を再開
        setIsGenerating(true);

        // 現在の進捗をDBの値から復元（UX2-10: 変換ロジックはconvertV4ProgressToUIFormatに一本化）
        const dbProgress = currentStatus?.progress || { totalSlots };
        setGenerationProgress(convertV4ProgressToUIFormat(dbProgress, restoredUltimateMode));

        // 進捗追跡を再開
        v4Generation.subscribeToProgress(requestId, (progress) => {
          // 完了/失敗判定
          if (progress.status === 'completed') {
            setIsGenerating(false);
            setGenerationProgress(null);
            localStorage.removeItem('v4MenuGenerating');
            refreshMealPlan();
            setSuccessMessage({ title: '献立が完成しました！', message: 'AIが献立を作成しました。', refreshOnDismiss: true });
            return;
          }
          if (progress.status === 'failed') {
            localStorage.removeItem('v4MenuGenerating');
            // UX2-11: ユーザーが「中止する」を押した後に届く遅延イベントでは alert を出さない
            if (generationCancelledRef.current) {
              generationCancelledRef.current = false;
              setIsGenerating(false);
              setGenerationProgress(null);
              return;
            }
            // UX2-02: alert() ではなく既存のリトライ付き失敗パネル(generationFailedError)に集約する
            // (GEN_FAIL が isGenerating/generationProgress のクリアも兼ねる)
            dispatchAiGen({
              type: 'GEN_FAIL',
              payload: { error: weeklyMenuRequestErrorMessageForDisplay(progress.errorMessage) || '生成に失敗しました', requestId },
            });
            return;
          }

          setGenerationProgress(convertV4ProgressToUIFormat(progress, restoredUltimateMode));
        });
      } catch (e) {
        console.error('[restore] Failed to restore V4 generation:', e);
        localStorage.removeItem('v4MenuGenerating');
      }
    };

    restoreGeneration().finally(() => {
      // #120: restoreGeneration 完了後に checkPendingRequests を許可
      isRestoringRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // マウント時のみ実行。refreshMealPlan / v4Generation は mount 後に安定するが deps に入れると再実行されるため個別 disable

  // V4 生成ハンドラー
  const handleV4Generate = async (params: {
    targetSlots: TargetSlot[];
    constraints: MenuGenerationConstraints;
    note: string;
    ultimateMode?: boolean;
  }) => {
    try {
      const result = await v4Generation.generate({
        ...params,
        ultimateMode: params.ultimateMode ?? false,
      });
      setShowV4Modal(false);
      // UX2-12: この生成の対象スロットを記録し、EmptySlot の「考え中」表示を対象外の日・スロットに出さない
      setGenTargetSlotKeys(params.targetSlots);

      // 究極モードで始めた生成か (#1597)。この生成の進捗の段 (究極 / 通常) は、生成を始めたときの要求で決める
      // (モバイルの requestedUltimateRef と同じ考え方。progress.totalSteps は行を作った時点では枠の数で、究極モードかを表さない)
      const requestedUltimateMode = params.ultimateMode === true;

      // 初期進捗を設定（totalSlotsを含める）
      const initialTotalSlots = result?.totalSlots || params.targetSlots.length;
      setGenerationProgress({
        phase: 'user_context',
        message: 'ユーザー情報を取得中...',
        percentage: 3,
        totalSlots: initialTotalSlots,
        completedSlots: 0,
        isUltimateMode: requestedUltimateMode,
      });
      
      // Subscribe to progress updates
      if (result?.requestId) {
        const v4RequestId = result.requestId;

        // Bug-3対策: Realtimeが切断しても進捗バーが消えないようにポーリングフォールバックを開始
        // Realtimeが完了を拾えなかった場合に5秒ごとにサーバステータスを確認する
        if (v4PollingIntervalRef.current) {
          clearInterval(v4PollingIntervalRef.current);
        }
        // Realtime側で解決済みかどうかを共有するフラグ（setInterval closure内からも更新できるようrefを使う）
        const v4ResolvedRef = { current: false };
        // この生成の監視の印 (#1657)。次の生成の開始・中止 (handleCancelGeneration)・アンマウントで active が false になる。
        // 前の生成のポーリングの、fetch を待っていた tick が、戻ってからこの生成の表示 (進捗・完了・失敗) を書き換えたり、
        // この生成のポーリング (v4PollingIntervalRef) を止めたりしないように、前の生成の印をここで下ろす
        const v4Watch = { active: true };
        if (v4PollWatchRef.current) v4PollWatchRef.current.active = false;
        v4PollWatchRef.current = v4Watch;
        v4PollingIntervalRef.current = setInterval(async () => {
          // 印が下りた監視の tick は何もしない (v4PollingIntervalRef はもう次の生成のものなので触らない)
          if (!v4Watch.active) return;
          if (v4ResolvedRef.current) {
            clearInterval(v4PollingIntervalRef.current!);
            v4PollingIntervalRef.current = null;
            return;
          }
          try {
            const statusRes = await fetch(`/api/ai/menu/weekly/status?requestId=${v4RequestId}`);
            if (!statusRes.ok) return;
            const { status, progress: dbProgress } = await statusRes.json();
            if (v4ResolvedRef.current) return; // Realtimeが先に完了を処理した
            // fetch を待つ間に、次の生成の開始・中止・アンマウントで印が下りていたら、届いた応答では何も置かない (#1657)
            if (!v4Watch.active) return;
            if (status === 'completed') {
              v4ResolvedRef.current = true;
              clearInterval(v4PollingIntervalRef.current!);
              v4PollingIntervalRef.current = null;
              // Realtimeが完了を拾えなかった場合のフォールバック処理
              setIsGenerating(false);
              setGenerationProgress(null);
              refreshMealPlan();
              setSuccessMessage({ title: '献立が完成しました！', message: 'AIが献立を作成しました。', refreshOnDismiss: true });
              localStorage.removeItem('v4MenuGenerating');
            } else if (status === 'failed' || status === 'not_found') {
              // not_found = 本人の行が無い (消えた)。以前は completed とも failed とも扱わず、5 秒ごとの確認を続けていた。
              // 失敗と同じく止めて、既定の失敗の文を出す (#1657)
              v4ResolvedRef.current = true;
              clearInterval(v4PollingIntervalRef.current!);
              v4PollingIntervalRef.current = null;
              localStorage.removeItem('v4MenuGenerating');
              // UX2-02: alert() ではなく既存のリトライ付き失敗パネル(generationFailedError)に集約する
              // (GEN_FAIL が isGenerating/generationProgress のクリアも兼ねる)
              dispatchAiGen({
                type: 'GEN_FAIL',
                payload: { error: '献立の生成に失敗しました。もう一度お試しください。', requestId: v4RequestId },
              });
            } else if (dbProgress) {
              // Realtime が届いていない間も、DB の進捗で表示を進める (#1663)。割合は Math.max で戻らないので、
              // Realtime が先に進めていても遅れて着いたこの応答で割合は戻らない。生成中でなければ (完了・失敗・中止のあと) 何も置かない
              setGenerationProgressWhileGenerating(convertV4ProgressToUIFormat(dbProgress, requestedUltimateMode));
            }
          } catch {
            // ポーリングエラーは無視して継続
          }
        }, 5000);

        v4Generation.subscribeToProgress(v4RequestId, (progress) => {
          // 次の生成の開始・中止・アンマウントで印が下りたあとに届いた進捗では、表示を書き換えない (#1657)
          if (!v4Watch.active) return;
          // Realtimeが端末ステータスを受信したらポーリングを停止する
          if (progress.status === 'completed' || progress.status === 'failed') {
            v4ResolvedRef.current = true;
            if (v4PollingIntervalRef.current) {
              clearInterval(v4PollingIntervalRef.current);
              v4PollingIntervalRef.current = null;
            }
          }
          // UX2-10: 変換ロジックはconvertV4ProgressToUIFormatに一本化（重複実装の解消）
          setGenerationProgress(convertV4ProgressToUIFormat(progress, requestedUltimateMode));
        });
      }
    } catch (error) {
      // Error already handled in hook
      // 同意が必要で止められた (T15 / #1154): 同意画面 (AiConsentRequiredHost) が案内するので、生成の画面を閉じる
      if (error instanceof AiConsentRequiredError) setShowV4Modal(false);
    }
  };

  // Supabase Realtime チャンネルを保持（クリーンアップ用）
  const realtimeChannelRef = useRef<RealtimeChannel | null>(null);
  // subscribeToRequestStatus の監視 1 回分の印 (#1622)。完了・失敗・中止で cleanupRealtime が active を false にする。
  // Realtime の接続の失敗 (TIMED_OUT / CLOSED / CHANNEL_ERROR) と 5 秒後の確認からのポーリングの開始は、印が active のときだけ行う。
  // 以前は、終わった生成でも (removeChannel が出す CLOSED や、残っていた 5 秒のタイマーから) ポーリングをやり直し、
  // 終わった要求の状態をもう一度読んで、失敗の表示を出し直したり、別の週に切り替えたあとに古い週の献立を読み直したりしていた
  const requestWatchRef = useRef<{ active: boolean } | null>(null);
  const supabaseRef = useRef(createClient());
  
  // 生成中状態のチェックが進行中かどうかを追跡（重複API呼び出し防止）
  const isCheckingPendingRef = useRef(false);

  // #120: restoreGeneration が完了するまで checkPendingRequests をブロックするフラグ
  const isRestoringRef = useRef(true);
  
  // Realtime サブスクリプションをクリーンアップする関数
  const cleanupRealtime = useCallback(() => {
    // removeChannel が同期で CLOSED を通知しても、ポーリングをやり直さないよう、チャンネルを外す前に印を下ろす (#1622)
    if (requestWatchRef.current) {
      requestWatchRef.current.active = false;
      requestWatchRef.current = null;
    }
    if (realtimeChannelRef.current) {
      supabaseRef.current.removeChannel(realtimeChannelRef.current);
      realtimeChannelRef.current = null;
    }
  }, []);
  
  // コンポーネントアンマウント時にクリーンアップ（Realtimeのみ）
  useEffect(() => {
    return () => {
      cleanupRealtime();
      if (v4PollingIntervalRef.current) {
        clearInterval(v4PollingIntervalRef.current);
        v4PollingIntervalRef.current = null;
      }
      // fetch を待っているポーリングの tick が、戻ってから何も置かないように、V4 の生成・再生成・献立の改善の監視の印も下ろす (#1657)
      if (v4PollWatchRef.current) {
        v4PollWatchRef.current.active = false;
        v4PollWatchRef.current = null;
      }
      if (regenerateWatchRef.current) {
        regenerateWatchRef.current.active = false;
        regenerateWatchRef.current = null;
      }
      if (improveWatchRef.current) {
        improveWatchRef.current.active = false;
        improveWatchRef.current = null;
      }
      // 写真の解析の結果を待つ読み直しも、アンマウントのあとに何も置かないように印を下ろす (#2047)
      if (photoResultWatchRef.current) {
        photoResultWatchRef.current.active = false;
        photoResultWatchRef.current = null;
      }
      // 再生成の Realtime は週の生成と別のチャンネルで持つ (#1657)
      if (regenerateChannelRef.current) {
        supabaseRef.current.removeChannel(regenerateChannelRef.current);
        regenerateChannelRef.current = null;
      }
      // #1033 F1b-06: 再生成/献立改善のフォールバックポーリング・タイムアウトも解放
      if (regeneratePollingIntervalRef.current) {
        clearInterval(regeneratePollingIntervalRef.current);
        regeneratePollingIntervalRef.current = null;
      }
      if (regenerateTimeoutRef.current) {
        clearTimeout(regenerateTimeoutRef.current);
        regenerateTimeoutRef.current = null;
      }
      if (improvePollingIntervalRef.current) {
        clearInterval(improvePollingIntervalRef.current);
        improvePollingIntervalRef.current = null;
      }
      if (improveTimeoutRef.current) {
        clearTimeout(improveTimeoutRef.current);
        improveTimeoutRef.current = null;
      }
    };
  }, [cleanupRealtime]);

  // #322: debounce timer cleanup on unmount (メモリリーク防止)
  useEffect(() => {
    const timers = toggleDebounceTimerRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);
  
  // 生成中の依頼の確認 (checkPendingRequests) とその effect は、取り直し (refetchAfterAiConsultation) の直前 (#2206 G1)
  
  
  // 復元用フラグ（購読開始時に使用）→ uiFlagReducer 管理

  // 買い物リスト再生成の復元（リロード時）
  useEffect(() => {
    const restoreShoppingListRegeneration = async () => {
      const stored = localStorage.getItem('shoppingListRegenerating');
      if (!stored) return;
      
      try {
        const { requestId, timestamp } = JSON.parse(stored);
        const elapsed = Date.now() - timestamp;
        
        // 5分以内のみ復元
        if (elapsed > 5 * 60 * 1000) {
          localStorage.removeItem('shoppingListRegenerating');
          return;
        }
        
        // ステータス確認
        const statusRes = await fetch(`/api/shopping-list/regenerate/status?requestId=${requestId}`);
        if (!statusRes.ok) {
          localStorage.removeItem('shoppingListRegenerating');
          return;
        }
        
        const data = await statusRes.json();
        
        if (data.status === 'processing') {
          console.log('📦 買い物リスト再生成を復元:', requestId);
          setIsRegeneratingShoppingList(true);
          setShoppingListRequestId(requestId);
          setShouldRestoreSubscription(true);
          if (data.progress) {
            setShoppingListProgress(data.progress);
          }
        } else {
          // completed または failed の場合はクリア
          localStorage.removeItem('shoppingListRegenerating');
        }
      } catch {
        localStorage.removeItem('shoppingListRegenerating');
      }
    };
    
    restoreShoppingListRegeneration();
  }, []);
  
  // Edit meal state (editingMeal → modalReducer, editMealName/Mode → #1031 formDraftStore に一本化)
  const setEditMealName = useFormDraftStore((s) => s.setEditMealName);
  const setEditMealMode = useFormDraftStore((s) => s.setEditMealMode);

  // Pantry & Shopping (#1031: pantryStore/shoppingStore に一本化。page は selector 購読のみ)
  const fridgeItems = usePantryStore((s) => s.fridgeItems);
  const shoppingList = useShoppingStore((s) => s.shoppingList);
  // setShoppingList はストアの素の setter (関数型更新非対応)。
  // prev => の呼び出し箇所は getState().shoppingList を都度読んで機械展開する (#1031 §2)。
  const setShoppingList = useShoppingStore((s) => s.setShoppingList);
  const activeShoppingList = useShoppingStore((s) => s.activeShoppingList);
  const setActiveShoppingList = useShoppingStore((s) => s.setActiveShoppingList);
  const isRegeneratingShoppingList = useShoppingStore((s) => s.isRegeneratingShoppingList);
  const setIsRegeneratingShoppingList = useShoppingStore((s) => s.setIsRegeneratingShoppingList);
  const shoppingListProgress = useShoppingStore((s) => s.shoppingListProgress);
  const setShoppingListProgress = useShoppingStore((s) => s.setShoppingListProgress);
  const shoppingListRequestId = useShoppingStore((s) => s.shoppingListRequestId);
  const setShoppingListRequestId = useShoppingStore((s) => s.setShoppingListRequestId);
  const shoppingListTotalServings = useShoppingStore((s) => s.shoppingListTotalServings);
  const setShoppingListTotalServings = useShoppingStore((s) => s.setShoppingListTotalServings);

  // 曜日別人数設定 (#1031: servingsConfigStore に一本化)
  const servingsConfig = useServingsConfigStore((s) => s.servingsConfig);
  const setServingsConfig = useServingsConfigStore((s) => s.setServingsConfig);
  const setIsLoadingServingsConfig = useServingsConfigStore((s) => s.setIsLoadingServingsConfig);

  // AI栄養士フィードバックの結果待ち (Realtime + ポーリング) の持ち主 (#1206)。
  // アンマウント・モーダルを閉じる・別の取得の開始のどれでも、購読/ポーリングを必ず解除する。
  // (nutrition 系の state は nutritionReducer 管理)
  const feedbackWatch = useNutritionFeedbackWatch({
    supabase: supabaseRef.current,
    // フィードバックを見せているのは栄養詳細モーダルとサマリー(stats)モーダルの 2 つ。どちらかが開いている間は待ち続ける。
    // サマリー → 栄養詳細への切り替えは同じ更新で起きるので、この値は true のまま変わらず購読は引き継がれる
    isViewing: showNutritionDetailModal || activeModal === 'stats',
    isLoading: isLoadingFeedback,
    // 結果待ちのまま閉じられたら、スピナーを戻して、次に開いたとき取得し直せるようにする
    onAbandoned: () => {
      setIsLoadingFeedback(false);
      setLastFeedbackDate(null);
    },
  });

  // 買い物リスト範囲選択 (#1031: shoppingStore に一本化)
  const shoppingRange = useShoppingStore((s) => s.shoppingRange);
  const setShoppingRangeStep = useShoppingStore((s) => s.setShoppingRangeStep);

  // スーパーの動線に合わせたカテゴリ順序
  const CATEGORY_ORDER = [
    '青果（野菜・果物）',
    '精肉',
    '鮮魚',
    '乳製品・卵',
    '豆腐・練り物',
    '米・パン・麺',
    '調味料',
    '油・香辛料',
    '乾物・缶詰',
    '冷凍食品',
    '飲料',
    // 旧カテゴリとの互換性
    '野菜',
    '肉',
    '魚',
    '乳製品',
    '卵',
    '豆腐・大豆',
    '麺・米',
    '乾物',
    '食材',
    'その他',
  ];

  // カテゴリでグループ化・ソート
  const groupedShoppingList = useMemo(() => {
    const groups = new Map<string, ShoppingListItem[]>();
    shoppingList.forEach(item => {
      const category = item.category || 'その他';
      const existing = groups.get(category) || [];
      existing.push(item);
      groups.set(category, existing);
    });
    
    // カテゴリ順序でソート
    const sortedEntries = Array.from(groups.entries()).sort((a, b) => {
      const indexA = CATEGORY_ORDER.indexOf(a[0]);
      const indexB = CATEGORY_ORDER.indexOf(b[0]);
      const orderA = indexA === -1 ? 999 : indexA;
      const orderB = indexB === -1 ? 999 : indexB;
      return orderA - orderB;
    });
    
    return sortedEntries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shoppingList]);  // CATEGORY_ORDER はコンポーネント内定数配列のため deps に含めるとメモ化が無効になる。本来はモジュールスコープに移動すべきだが挙動変更を避けるため個別 disable
  
  // Add fridge/shopping form (#1031: formDraftStore に一本化。ハンドラ内でのみ読む)
  const setNewFridgeName = useFormDraftStore((s) => s.setNewFridgeName);
  const setNewFridgeAmount = useFormDraftStore((s) => s.setNewFridgeAmount);
  const setNewFridgeExpiry = useFormDraftStore((s) => s.setNewFridgeExpiry);
  // UX2-18: 冷蔵庫アイテムの編集モード切り替え
  const setEditingFridgeItemId = useFormDraftStore((s) => s.setEditingFridgeItemId);
  const setNewShoppingName = useFormDraftStore((s) => s.setNewShoppingName);
  const setNewShoppingAmount = useFormDraftStore((s) => s.setNewShoppingAmount);
  const setNewShoppingCategory = useFormDraftStore((s) => s.setNewShoppingCategory);

  // Recipe / AI / manualEdit / photo / imageGenerate → reducers 管理 (Phase B-2 移行済み)
  // formDraft 系 (#1031: formDraftStore に一本化)
  // manualDishes/manualMode はハンドラ内でのみ読むため useFormDraftStore.getState() を都度参照
  const setManualDishes = useFormDraftStore((s) => s.setManualDishes);
  const setManualMode = useFormDraftStore((s) => s.setManualMode);
  // catalogQuery は検索 effect の deps で参照するため selector 購読が必要
  const catalogQuery = useFormDraftStore((s) => s.catalogQuery);
  const setCatalogQuery = useFormDraftStore((s) => s.setCatalogQuery);
  const setCatalogResults = useFormDraftStore((s) => s.setCatalogResults);
  const setSelectedCatalogProduct = useFormDraftStore((s) => s.setSelectedCatalogProduct);
  const setIsCatalogSearching = useFormDraftStore((s) => s.setIsCatalogSearching);
  const setCatalogSearchError = useFormDraftStore((s) => s.setCatalogSearchError);

  // Photo edit files (#1031: formDraftStore に一本化。photoFiles はハンドラ内でのみ読む)
  const setPhotoFiles = useFormDraftStore((s) => s.setPhotoFiles);
  const setPhotoPreviews = useFormDraftStore((s) => s.setPhotoPreviews);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Image generation files (#1031: formDraftStore に一本化。ハンドラ内でのみ読む)
  const setImageGenerationPrompt = useFormDraftStore((s) => s.setImageGenerationPrompt);
  const setImageReferenceFiles = useFormDraftStore((s) => s.setImageReferenceFiles);
  const setImageReferencePreviews = useFormDraftStore((s) => s.setImageReferencePreviews);
  const imageGenerateInputRef = useRef<HTMLInputElement>(null);

  // ♥ の状態を dish_favorites から名前で引く。モーダルが開くたびに引き直す。取得中は ♥ を disabled にする (#2011)
  useEffect(() => {
    favoriteSessionRef.current += 1;
    const session = favoriteSessionRef.current;
    if (!isRecipeModalOpen || !selectedRecipe) {
      // 閉じた: 前の回の取得・押下の応答は捨てられるので、取得中の印をここで下ろす
      setIsFavoriteLoading(false);
      return;
    }
    setIsFavoriteLoading(true);
    fetch(`/api/favorites/status?name=${encodeURIComponent(selectedRecipe)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { favorited?: boolean; id?: string | null } | null) => {
        if (favoriteSessionRef.current !== session || !data) return;
        setIsFavorite(data.favorited === true);
        setFavoriteId(typeof data.id === 'string' ? data.id : null);
      })
      .catch(() => {/* 取得失敗は無視 (印は今の値のまま) */})
      .finally(() => { if (favoriteSessionRef.current === session) setIsFavoriteLoading(false); });
  }, [selectedRecipe, isRecipeModalOpen]);

  const openAddMealModal = (mealType: MealType, dayIndex: number) => {
    setAddMealKey(mealType);
    setAddMealDayIndex(dayIndex);
    setSelectedCatalogProduct(null);
    setCatalogQuery('');
    setCatalogResults([]);
    setCatalogSearchError('');
    setActiveModal('add');
  };

  useEffect(() => {
    if (activeModal !== 'manualEdit' && activeModal !== 'add') return;

    const query = catalogQuery.trim();
    if (query.length < 2) {
      setCatalogResults([]);
      setCatalogSearchError('');
      setIsCatalogSearching(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsCatalogSearching(true);
      setCatalogSearchError('');

      try {
        const response = await fetch(`/api/catalog/products?q=${encodeURIComponent(query)}&limit=8`);
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || '商品検索に失敗しました');
        }

        if (!cancelled) {
          setCatalogResults(Array.isArray(payload.products) ? payload.products : []);
        }
      } catch (error) {
        if (!cancelled) {
          setCatalogResults([]);
          setCatalogSearchError(error instanceof Error ? error.message : '商品検索に失敗しました');
        }
      } finally {
        if (!cancelled) {
          setIsCatalogSearching(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeModal, catalogQuery]);

  // 週の読み込み (fetchPlan) とその effect は receiver の宣言のあと (receiver.read で読む。#2206 G1)
  
  // Fetch servings config and radar chart nutrients from user profile
  // (AI 相談の成功のあと (refetchAfterAiConsultation) にも呼ぶ。AI 相談で家族の人数 (family_size) が変わると、
  // 人数の設定 (servings_config) の無い人の既定の人数が変わるため。#2195 V1)
  // 応答を置くのは、もう置いたどの読み取りよりあとに始めた読み取りだけ (KEY_SETTINGS の place。開いたときの読み込みと取り直しの応答が
  // 逆の順に届いても、続けて来た取り直しの応答が逆の順に届いても、古い人数で新しい人数を戻さない。#2201 U1・#2206 G1)。
  // 取り直しの応答を待つあいだに人数の設定のモーダル・書き込みが始まっていたら置かない (place が番兵・書き込みの印を見る。#2201 U2)。
  // 読み込み中の印 (servingsConfigStore の isLoadingServingsConfig) は receiver.isLoading(KEY_SETTINGS) から写す
  // (開いたときの読み込みが立て、人数を置いたとき・最後に立てた読み込みが終わったときに下りる。取り直しは立てない)
  const fetchUserSettings = useCallback(async (read: AiConsultationRead) => {
    try {
      const res = await fetch('/api/profile');
      if (res.ok) {
        const profile = await res.json();
        read.place(KEY_SETTINGS, () => {
          // Servings config
          if (profile.servings_config) {
            setServingsConfig(profile.servings_config);
          } else if (profile.family_size) {
            // servings_configがない場合はfamily_sizeからデフォルト作成
            const defaultConfig: ServingsConfig = {
              default: profile.family_size,
              byDayMeal: {}
            };
            setServingsConfig(defaultConfig);
          } else {
            // どちらも無い (AI 相談で家族の人数を空にした): 前の人数を残さない (取り直しのとき。読み込み直したときと同じ。#2195 V1)
            setServingsConfig(null);
          }
          // Radar chart nutrients
          if (profile.radar_chart_nutrients && Array.isArray(profile.radar_chart_nutrients)) {
            setRadarChartNutrients(profile.radar_chart_nutrients);
          }
        });
      }
    } catch (e) {
      console.error('Failed to fetch user settings:', e);
    }
  }, [setServingsConfig, setRadarChartNutrients]);
  // 開いたときに読む effect は receiver の宣言のあと (依存の配列に receiver を書く。#2206 G1)
  
  // フォールバックポーリング用の参照
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // #1033 F1b-06: 単品再生成のRealtimeが切断した場合のフォールバックポーリング/タイムアウト用の参照
  const regeneratePollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const regenerateTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // 単品再生成の Realtime のチャンネル (#1657)。週の生成の監視 (realtimeChannelRef・requestWatchRef) とは別に持つ。
  // 以前は realtimeChannelRef を共用し、再生成の開始・終わりの cleanupRealtime が、動いている週の生成の監視の印まで下ろしていた
  const regenerateChannelRef = useRef<RealtimeChannel | null>(null);
  // 単品再生成の監視 1 回分の印 (#1657)。次の再生成の監視の開始・アンマウントで active が false になる
  const regenerateWatchRef = useRef<{ active: boolean } | null>(null);

  // #1033 F1b-06: 献立改善(onImprove)のRealtimeが切断した場合のフォールバックポーリング/タイムアウト用の参照
  const improvePollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const improveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // 献立改善の監視 1 回分の印 (#1657)。次の改善の開始・中止 (handleCancelGeneration)・アンマウントで active が false になる
  const improveWatchRef = useRef<{ active: boolean } | null>(null);
  // 写真の解析 (写真から入力) の結果を待つ監視 1 回分の印 (#2047)。アンマウントで active が false になる
  // (次の解析の開始でも下ろすが、解析は一度に 1 つ (analyzePhotoWithAI の先頭で止める) なので、待っているあいだに次の解析は始まらない)
  const photoResultWatchRef = useRef<{ active: boolean } | null>(null);

  // V4生成のRealtimeが切断した場合のフォールバックポーリング用の参照
  const v4PollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // V4 の生成の監視 1 回分の印 (#1657)。次の生成の開始・中止 (handleCancelGeneration)・アンマウントで active が false になる
  const v4PollWatchRef = useRef<{ active: boolean } | null>(null);

  // UX2-11: ユーザーが「中止する」を押した後に届く遅延イベント（失敗コールバック等）で
  // 生の error_message がそのまま alert 表示されないようにするガード
  const generationCancelledRef = useRef(false);

  // 週データキャッシュ（前後の週をプリフェッチして高速化）
  // 書くのは、その週を読み始める前に取った書き込み口 (beginWrite) だけ。AI 相談の成功の取り直しが捨てた (discard) あと・その週を
  // あとから読み始めたあとは、先に読み始めた応答を書かない (#2201 U1。古い応答をキャッシュに戻し、その週へ戻ったときに出さない)
  const weekDataCache = useRef(createWeekDataCache<WeekCacheData>());
  
  // ポーリングをクリーンアップする関数
  const cleanupPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  // UX2-11: AI 生成の「中止する」ハンドラ。
  // weekly_menu_requests.status に 'cancelled' 値は無い（CHECK 制約、migration 追加はスコープ外）ため
  // 最低限「クライアント側の追跡を止めて明示する」を必須要件とし、可能なら status=failed（中止相当）も
  // サーバーに反映する（ベストエフォート。失敗しても画面の状態は既に止めている）。
  const handleCancelGeneration = useCallback(async () => {
    generationCancelledRef.current = true;
    // 確認モーダルは中止確定と同時に閉じる（この後 setSuccessMessage で結果を表示する）
    setShowConfirmCancelGeneration(false);

    // アクティブな requestId を localStorage から探す（v4 / weekly / single meal の順）
    let cancelRequestId: string | null = null;
    for (const key of ['v4MenuGenerating', 'weeklyMenuGenerating', 'singleMealGenerating']) {
      const stored = localStorage.getItem(key);
      if (!stored) continue;
      try {
        const parsed = JSON.parse(stored);
        if (parsed?.requestId) {
          cancelRequestId = parsed.requestId;
          break;
        }
      } catch {
        // 破損データは無視
      }
    }

    // クライアント側の追跡を即座に停止（Realtime/ポーリング/フォールバックタイマー）
    cleanupRealtime();
    cleanupPolling();
    if (v4PollingIntervalRef.current) {
      clearInterval(v4PollingIntervalRef.current);
      v4PollingIntervalRef.current = null;
    }
    // fetch を待っているポーリングの tick が、中止のあとに進捗・完了・失敗を置かないように、印も下ろす (#1657)
    if (v4PollWatchRef.current) {
      v4PollWatchRef.current.active = false;
      v4PollWatchRef.current = null;
    }
    if (improveWatchRef.current) {
      improveWatchRef.current.active = false;
      improveWatchRef.current = null;
    }
    if (improvePollingIntervalRef.current) {
      clearInterval(improvePollingIntervalRef.current);
      improvePollingIntervalRef.current = null;
    }
    if (improveTimeoutRef.current) {
      clearTimeout(improveTimeoutRef.current);
      improveTimeoutRef.current = null;
    }

    localStorage.removeItem('v4MenuGenerating');
    localStorage.removeItem('weeklyMenuGenerating');
    localStorage.removeItem('singleMealGenerating');

    setIsGenerating(false);
    setGenerationProgress(null);
    setGeneratingMeal(null);

    setSuccessMessage({
      title: '生成の追跡を中止しました',
      message: 'この画面での進捗表示を停止しました。バックグラウンドの処理が完了している場合、後で献立に反映されることがあります。',
    });

    // サーバー側にも中止を通知（ベストエフォート）。送信の間は書き込みの窓を開ける (#2206 G1。W-32)
    if (cancelRequestId) {
      const endWrite = receiver.beginWrite();
      try {
        await fetch('/api/ai/menu/weekly/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: cancelRequestId }),
        });
      } catch (e) {
        console.error('Failed to notify server of cancellation:', e);
      } finally {
        endWrite();
      }
    }
    // receiver (AI 相談の取り直しの受け手) は下で宣言する。参照は受け手の一生で変わらないので依存に入れない (宣言の前に依存の配列で読まない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupRealtime, cleanupPolling, setIsGenerating, setGenerationProgress, setGeneratingMeal, setSuccessMessage, setShowConfirmCancelGeneration]);

  // ポーリングで進捗を取得
  // ultimateMode: 監視する生成が究極モードか (#1597)。進捗の段 (究極 / 通常) をこれで決める (totalSteps では見分けない)。
  // 呼び出し元の subscribeToRequestStatus が受け取った値をそのまま渡す
  // watch: 呼び出し元の subscribeToRequestStatus が立てた、この監視の印 (#1622・requestWatchRef)。
  // 完了・失敗・中止 (cleanupRealtime) や次の監視の開始で active が false になる。
  // tick は await (fetch・json) のたびに印を確かめ、下りていれば何も置かない (#1657。以前は印を見ず、
  // Realtime の完了や次の監視の開始のときに fetch を待っていた tick が、戻ってから進捗を置いたり、古い週の献立を置いたりしえた)
  const startPolling = useCallback((targetDate: string, requestId: string, ultimateMode: boolean, watch: { active: boolean }) => {
    console.log('⏱️ Starting fallback polling for requestId:', requestId);
    cleanupPolling();
    
    const poll = async () => {
      if (!watch.active) return;
      try {
        const res = await fetch(`/api/ai/menu/weekly/status?requestId=${requestId}`);
        // fetch を待つ間に監視が終わっていたら、届いた応答では何も置かない (進捗・献立・失敗の表示・ログインへの移動。#1657)
        if (!watch.active) return;
        // #142: 401 はセッション切れ → ポーリング停止して /login にリダイレクト
        if (res.status === 401) {
          console.warn('[poll] Session expired (401). Stopping polling and redirecting to /login.');
          cleanupPolling();
          cleanupRealtime();
          setIsGenerating(false);
          setGeneratingMeal(null);
          setGenerationProgress(null);
          localStorage.removeItem('weeklyMenuGenerating');
          localStorage.removeItem('singleMealGenerating');
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- セッション切れ (401)。ページごと移り、middleware に Cookie とログインの状態を判定し直させる (#142)
          window.location.href = '/login';
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (!watch.active) return;
        
        if (data.progress) {
          const uiProgress = convertV4ProgressToUIFormat(data.progress, ultimateMode);
          setGenerationProgress(uiProgress);
        }
        
        if (data.status === 'completed') {
          console.log('✅ Polling: Generation completed');
          // 生成した週を読み直して置く (ページの読み取りの place。#2206 G1。読む間に監視が終わっていたら置かない)
          await reloadWeekAfterCompletion(targetDate, () => watch.active);
          // 献立を読む間に監視が終わっていたら (Realtime が同じ完了を先に処理した・次の監視が始まった)、何も置かない (#1657)
          if (!watch.active) return;
          setIsGenerating(false);
          setGeneratingMeal(null);
          setGenerationProgress(null);
          localStorage.removeItem('weeklyMenuGenerating');
          localStorage.removeItem('singleMealGenerating');
          cleanupPolling();
          cleanupRealtime();
        } else if (data.status === 'failed' || data.status === 'not_found') {
          // not_found = 本人の行が無い (消えた・他の利用者の requestId)。以前は completed とも failed とも扱わず、
          // 3 秒ごとの確認を続けていた (#780 から)。失敗と同じく止めて、生成中の表示を片づけ、既定の失敗の文を出す (#1657。
          // not_found の応答に error_message は無いので、失敗の文は既定の文になる)
          console.log('❌ Polling: Generation failed');
          setIsGenerating(false);
          setGeneratingMeal(null);
          setGenerationProgress(null);
          localStorage.removeItem('weeklyMenuGenerating');
          localStorage.removeItem('singleMealGenerating');
          cleanupPolling();
          cleanupRealtime();
          dispatchAiGen({
            type: 'GEN_FAIL',
            payload: { error: weeklyMenuRequestErrorMessageForDisplay(data.error_message) || '献立の生成に失敗しました。もう一度お試しください。', requestId },
          });
        }
      } catch (e) {
        console.error('Polling error:', e);
      }
    };
    
    // 即座に1回実行
    poll();
    // 3秒ごとにポーリング
    pollingIntervalRef.current = setInterval(poll, 3000);
    // reloadWeekAfterCompletion は receiver の宣言のあとで定義する (受け手の読み取り。参照するものは描画をまたいで変わらない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupPolling, cleanupRealtime]);

  // Realtime で生成完了を監視（常にポーリングも並行実行）
  // ultimateMode: 監視する生成が究極モードか (#1597)。進捗の段 (究極 / 通常) をこれで決める。呼び出し元が次のどれかを渡す:
  //   - 画面に入り直したとき: 生成中の行の確認 (GET /api/ai/menu/weekly/pending) の ultimateMode (行の generated_data.ultimateMode の判定)
  //   - 究極モードの無い生成 (旧来の週の生成 /api/ai/menu/weekly/request・1 食の生成): false
  const subscribeToRequestStatus = useCallback((targetDate: string, requestId: string, ultimateMode: boolean) => {
    // 既存のサブスクリプションをクリーンアップ
    cleanupRealtime();
    cleanupPolling();

    // この監視の印 (#1622)。完了・失敗・中止 (どれも cleanupRealtime を呼ぶ) か、次の監視の開始で active が false になる
    const watch = { active: true };
    requestWatchRef.current = watch;

    console.log('📡 Subscribing to Realtime for requestId:', requestId);

    // 常にポーリングも開始（Realtimeの信頼性が低いため）
    startPolling(targetDate, requestId, ultimateMode, watch);

    let realtimeConnected = false;
    
    const channel = supabaseRef.current
      .channel(`menu-request-${requestId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'weekly_menu_requests',
          filter: `id=eq.${requestId}`,
        },
        async (payload) => {
          // この監視が終わったあと (完了・失敗・中止・次の監視の開始) に届いた更新では何も置かない (#1657)
          if (!watch.active) return;
          try {
            console.log('📡 Realtime update received:', payload.new);
            const newData = payload.new as {
              status: string;
              mode?: string;
              error_message?: string | null;
              progress?: {
                phase?: string;
                message?: string;
                percentage?: number;
                // V4形式のフィールド
                currentStep?: number;
                totalSteps?: number;
                completedSlots?: number;
                totalSlots?: number;
              }
            };
            const newStatus = newData?.status;
            
            // 進捗情報を更新（V4形式をUI形式に変換）
            if (newData?.progress) {
              console.log('📊 Progress update:', newData.progress);
              const uiProgress = convertV4ProgressToUIFormat(newData.progress, ultimateMode);
              setGenerationProgress(uiProgress);
            }
            
            if (newStatus === 'completed') {
              // 完了したら献立を再取得 (生成した週を読み直して置く。ページの読み取りの place。#2206 G1)
              console.log('✅ Generation completed, fetching meal plan...');
              try {
                await reloadWeekAfterCompletion(targetDate, () => watch.active);
                // 献立を読む間に、ポーリングが同じ完了を先に処理した (印を下ろした)・次の監視が始まったときは、何も置かない (#1657)
                if (!watch.active) return;
              } catch (fetchErr) {
                console.error('❌ Failed to fetch meal plan:', fetchErr);
              }
              if (!watch.active) return;
              setIsGenerating(false);
              setGeneratingMeal(null);
              setGenerationProgress(null);
              localStorage.removeItem('weeklyMenuGenerating');
              localStorage.removeItem('singleMealGenerating');
              cleanupRealtime();
              // Realtime で終わりを受け取ったら、並行しているポーリングも止める (#1622)。
              // 献立を読む (await) 間は、ポーリングも同じ完了を処理しうる。先に終えた側が印を下ろし (cleanupRealtime)、
              // あとの側は await のあとで印を見て何も置かない (#1657。ここの await のあとの確かめと、startPolling の tick の確かめ)
              cleanupPolling();
            } else if (newStatus === 'failed') {
              console.log('❌ Generation failed');
              setIsGenerating(false);
              setGeneratingMeal(null);
              setGenerationProgress(null);
              localStorage.removeItem('weeklyMenuGenerating');
              localStorage.removeItem('singleMealGenerating');
              cleanupRealtime();
              // Realtime で失敗を受け取ったら、並行しているポーリングも止める (#1622。失敗の表示を二重に出さないように)
              cleanupPolling();
              // 行の error_message は、こちらで書いた定型の文だけをそのまま出し、それ以外は汎用の文に寄せる
              // (useV4MenuGeneration と同じ絞り込み。進まなくなった行の英語の印は日本語の文にする。#1478・#1576)
              dispatchAiGen({
                type: 'GEN_FAIL',
                payload: { error: weeklyMenuRequestErrorMessageForDisplay(newData.error_message) || '献立の生成に失敗しました。もう一度お試しください。', requestId },
              });
            }
            // status === 'queued' / 'pending' / 'processing' の場合は継続して監視
          } catch (err) {
            console.error('❌ Realtime handler error:', err);
          }
        }
      )
      .subscribe((status) => {
        console.log('📡 Realtime subscription status:', status);
        if (status === 'SUBSCRIBED') {
          realtimeConnected = true;
        } else if (status === 'TIMED_OUT' || status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          // Realtimeが失敗したらポーリングにフォールバック
          // (この監視が終わったあと (完了・失敗・中止で removeChannel したときの CLOSED) はやり直さない。#1622)
          if (!realtimeConnected && watch.active) {
            console.warn('📡 Realtime failed, falling back to polling');
            startPolling(targetDate, requestId, ultimateMode, watch);
          }
        }
      });
    
    realtimeChannelRef.current = channel;
    
    // 5秒後にRealtimeが接続できていなければポーリング開始
    // (この監視が 5 秒のうちに終わっていたらやり直さない。#1622)
    setTimeout(() => {
      if (!realtimeConnected && !pollingIntervalRef.current && watch.active) {
        console.warn('📡 Realtime not connected after 5s, starting polling');
        startPolling(targetDate, requestId, ultimateMode, watch);
      }
    }, 5000);
    // reloadWeekAfterCompletion は receiver の宣言のあとで定義する (受け手の読み取り。参照するものは描画をまたいで変わらない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupRealtime, cleanupPolling, startPolling]);

  // ポーリングのクリーンアップ（アンマウント時）
  useEffect(() => {
    return () => {
      cleanupPolling();
    };
  }, [cleanupPolling]);
  
  // Fetch Pantry
  // 応答を置くのは、もう置いたどの読み取りよりあとに始めた読み取りだけ (KEY_PANTRY の place。開いたときの読み込みと取り直しの応答が
  // 逆の順に届いても、続けて来た取り直しの応答が逆の順に届いても、古い一覧で新しい一覧を戻さない。#2201 U1・#2206 G1)。
  // 取り直しの応答を待つあいだに冷蔵庫の書き込み・モーダルが始まっていたら置かない (place が番兵・書き込みの印を見る。
  // 削除した食材を戻す・足した食材を消すことをしない。#2201 U2)
  const fetchPantry = useCallback(async (read: AiConsultationRead) => {
    try {
      const res = await fetch('/api/pantry');
      if (res.ok) {
        const data = await res.json();
        read.place(KEY_PANTRY, () => usePantryStore.getState().setFridgeItems(data.items || []));
      }
    } catch (e) {
      console.error("Failed to fetch pantry:", e);
    }
  }, []);

  // 生成中状態をDBから復元し、ポーリングを再開
  /**
   * 生成中の依頼の確認 (前の effect の中の同名の関数を useCallback に出したもの。中身は前の字面のまま。#2206 G1)。
   * 生成の監視の入口で、読み取りの経路の外 (番兵 P1 の境 B-1)。先頭の 4 つのガードは前の effect の先頭と同じ字面。
   * 週が変わったとき・生成中の印が変わったとき (下の effect) と、AI 相談の成功の取り直し (refetchAfterAiConsultation。AI 相談が
   * 始めた献立の生成を見つけて監視する。#2195 V1) から呼ぶ。取り直しの番兵を見ない (進み具合の表示を止めない。§6.6)
   */
  const checkPendingRequests = useCallback(async (targetDate: string) => {
    // 既にポーリング中なら何もしない (再生成の監視は別のチャンネルで持つので、そちらも見る。#1657)
    if (realtimeChannelRef.current || regenerateChannelRef.current) return;
    // 既に生成中状態なら何もしない（重複防止）
    if (isGenerating || generatingMeal) return;
    // 既にチェック中なら何もしない（重複API呼び出し防止）
    if (isCheckingPendingRef.current) return;
    // #120: restoreGeneration が完了するまで待機（二重起動防止）
    if (isRestoringRef.current) return;

    // チェック開始をマーク
    isCheckingPendingRef.current = true;
    
    try {
      console.log('🔍 checkPendingRequests called with targetDate:', targetDate);
      
      // 0. まずスタックしたリクエストを自動クリーンアップ（生存信号から 20 分進んでいない processing/pending。queued は cron の順番待ちなので触らない。#1494）
      try {
        const cleanupRes = await fetch('/api/ai/menu/weekly/cleanup', { method: 'POST' });
        if (cleanupRes.ok) {
          const cleanupData = await cleanupRes.json();
          if (cleanupData.cleaned > 0) {
            console.log('🧹 自動クリーンアップ完了:', cleanupData.cleaned, '件のスタックしたリクエストを停止');
          }
        } else if (!cleanupRes.ok) {
          // #77: 5xx エラー時もユーザーに通知
          console.error('自動クリーンアップ API エラー:', cleanupRes.status);
          if (cleanupRes.status >= 500) {
            setSuccessMessage({ title: 'エラー', message: 'サーバーに一時的な問題が発生しました。しばらく待ってから再読み込みしてください。', type: 'error' });
          }
        }
      } catch (e) {
        console.warn('自動クリーンアップに失敗:', e);
      }
      
      // 1. 週間献立の生成中リクエストをDBで確認
      try {
        const weeklyRes = await fetch(`/api/ai/menu/weekly/pending?date=${targetDate}`);
        console.log('🔍 weeklyRes status:', weeklyRes.status);
        // #77: pending API 5xx をユーザー可視エラーに昇格
        if (weeklyRes.status >= 500) {
          console.error('weekly pending API エラー:', weeklyRes.status);
          setSuccessMessage({ title: 'エラー', message: '献立生成状況の確認中にエラーが発生しました。ページを再読み込みしてください。', type: 'error' });
        }
        if (weeklyRes.ok) {
          const data = await weeklyRes.json();
          console.log('🔍 weeklyRes data:', data);
          const { hasPending, requestId, status, startDate: pendingStartDate, ultimateMode: pendingUltimateMode } = data;
          if (hasPending && requestId) {
            console.log('📦 週間献立の生成中リクエストを復元:', requestId, status, 'startDate:', pendingStartDate);

            // 週は切り替えない。生成中の行の確認 (pending/route.ts) は、行の start_date が date (表示中の週の初日 = targetDate) と
            // 違うときは hasPending: false を返す (他の週の生成中は復元しない)。ここに来るのは start_date が targetDate と同じ行か、
            // start_date の無い行だけなので、表示中の週 (targetDate) で監視する
            // (#1609。以前は start_date が違えば週を切り替える分岐があったが、サーバーがその行を返さないので通らなかった)
            // 究極モードの生成かは、pending の ultimateMode (行の generated_data.ultimateMode の判定) で決める (#1597)。
            // 真偽値の true のときだけ究極モード (印の無い古い行・値の無い応答は通常の生成)
            const pendingIsUltimateMode = isUltimateModeWeeklyMenuRequest(pendingUltimateMode);
            // 生成中にし、最初の進捗が届くまでの間も段 (究極 / 通常) を合わせる (#1609。進捗が null だとカードが一瞬通常の段になる)。
            // すでに進捗があるときは上書きしない (#1629)
            resumePendingGeneration(pendingIsUltimateMode);
            subscribeToRequestStatus(targetDate, requestId, pendingIsUltimateMode);
            return; // 週間生成中なら他はスキップ
          } else {
            console.log('🔍 No pending weekly request found');
          }
        }
      } catch (e) {
        console.error('Failed to check pending weekly requests:', e);
      }
      
      // 2. 単一食事の生成中リクエストをDBで確認
      try {
        const singleRes = await fetch(`/api/ai/menu/meal/pending?date=${targetDate}`);
        if (singleRes.ok) {
          const { hasPending, requests } = await singleRes.json();
          if (hasPending && requests.length > 0) {
            const latestRequest = requests[0];
            // 日付から dayIndex を計算
            const targetDayDate = latestRequest.targetDate;
            const dayIdx = weekDatesRef.current.findIndex(d => d.dateStr === targetDayDate);
            
            if (dayIdx !== -1) {
              // mode === 'regenerate' の場合は既存食事の再生成
              if (latestRequest.mode === 'regenerate' && latestRequest.targetMealId) {
                setRegeneratingMealId(latestRequest.targetMealId);
                setIsRegenerating(true);
                setSelectedDayIndex(dayIdx);
                subscribeToRegenerateStatus(latestRequest.requestId, targetDate);
              } else {
                // mode === 'single' の場合は新規追加
                setGeneratingMeal({ dayIndex: dayIdx, mealType: latestRequest.targetMealType as MealType });
                setSelectedDayIndex(dayIdx);
                // 1 食の生成 (mode='single') に究極モードは無い (#1597)
                subscribeToRequestStatus(targetDate, latestRequest.requestId, false);
              }
              return; // DBで見つかったらlocalStorageはスキップ
            }
          }
        }
      } catch (e) {
        console.error('Failed to check pending single meal requests:', e);
      }
      
      // 3. localStorageからも復元を試みる（後方互換性のため、DBで見つからなかった場合のみ）
      // ただし、requestIdがある場合はまずステータスを確認してから復元する
      const storedWeekly = localStorage.getItem('weeklyMenuGenerating');
      if (storedWeekly) {
        try {
          const { weekStartDate, timestamp, requestId } = JSON.parse(storedWeekly);
          const elapsed = Date.now() - timestamp;
          // 5分以内かつ同じ週の場合のみ
          if (elapsed < 5 * 60 * 1000 && weekStartDate === targetDate) {
            if (requestId) {
              // ステータスAPIで確認してから復元
              const statusRes = await fetch(`/api/ai/menu/weekly/status?requestId=${requestId}`);
              if (statusRes.ok) {
                const { status, error_message } = await statusRes.json();
                if (status === 'queued' || status === 'pending' || status === 'processing') {
                  console.log('📦 週間献立をlocalStorageから復元:', requestId, 'status:', status);
                  setIsGenerating(true);
                  // weeklyMenuGenerating は旧来の週の生成 (/api/ai/menu/weekly/request) の印で、究極モードは無い (#1597)
                  subscribeToRequestStatus(targetDate, requestId, false);
                  return;
                } else if (status === 'failed') {
                  // 失敗の場合はエラーモーダルを表示してlocalStorageをクリア
                  console.log('❌ 週間献立の生成失敗を復元:', requestId);
                  localStorage.removeItem('weeklyMenuGenerating');
                  dispatchAiGen({
                    type: 'GEN_FAIL',
                    payload: { error: weeklyMenuRequestErrorMessageForDisplay(error_message) || '献立の生成に失敗しました。もう一度お試しください。', requestId },
                  });
                } else {
                  // completed の場合はlocalStorageをクリア
                  console.log('🗑️ 週間献立のlocalStorageをクリア（status:', status, ')');
                  localStorage.removeItem('weeklyMenuGenerating');
                }
              } else {
                localStorage.removeItem('weeklyMenuGenerating');
              }
            } else {
              localStorage.removeItem('weeklyMenuGenerating');
            }
          } else {
            localStorage.removeItem('weeklyMenuGenerating');
          }
        } catch {
          localStorage.removeItem('weeklyMenuGenerating');
        }
      }
      
      const storedSingle = localStorage.getItem('singleMealGenerating');
      if (storedSingle) {
        try {
          const { dayIndex, mealType, dayDate, initialCount, timestamp, requestId } = JSON.parse(storedSingle);
          const elapsed = Date.now() - timestamp;
          // 2分以内なら確認
          if (elapsed < 2 * 60 * 1000) {
            if (requestId) {
              // ステータスAPIで確認してから復元
              const statusRes = await fetch(`/api/ai/menu/weekly/status?requestId=${requestId}`);
              if (statusRes.ok) {
                const { status } = await statusRes.json();
                if (status === 'pending' || status === 'processing') {
                  console.log('📦 単一食事をlocalStorageから復元:', requestId, 'status:', status);
                  setGeneratingMeal({ dayIndex, mealType });
                  setSelectedDayIndex(dayIndex);
                  // 1 食の生成に究極モードは無い (#1597)
                  subscribeToRequestStatus(targetDate, requestId, false);
                } else {
                  // completed または failed の場合はlocalStorageをクリア
                  console.log('🗑️ 単一食事のlocalStorageをクリア（status:', status, ')');
                  localStorage.removeItem('singleMealGenerating');
                }
              } else {
                localStorage.removeItem('singleMealGenerating');
              }
            } else {
              // requestIdがない場合は旧方式でポーリング（古いコードの互換性）
              setGeneratingMeal({ dayIndex, mealType });
              setSelectedDayIndex(dayIndex);
              // レガシーポーリングは廃止（requestIdがある場合のみRealtime監視）
              console.warn('No requestId found in localStorage, skipping...');
            }
          } else {
            localStorage.removeItem('singleMealGenerating');
          }
        } catch {
          localStorage.removeItem('singleMealGenerating');
        }
      }
    } finally {
      // チェック完了をマーク（どのパスを通っても必ず実行）
      isCheckingPendingRef.current = false;
    }
    // subscribeToRequestStatus / subscribeToRegenerateStatus はファイル後方で定義されるため、前の effect と同じく依存に入れない (前方参照)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGenerating, generatingMeal]);
  useEffect(() => {
    void checkPendingRequests(formatLocalDate(weekStart));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, weekDates, isGenerating, generatingMeal]);  // 前の依存から aiConsultationRefetchRound を外したもの。checkPendingRequests は isGenerating・generatingMeal で作り直す

  // AI 相談の提案の実行で献立・買い物リスト・冷蔵庫・家族の人数・自分の名前が変わったら、ページを開いたときに読むもののうち
  // AI 相談で変わりうるものを取り直す (#2195 V1)。データは全部同じ read (取り直しの読み取り) で読む (#2206 G1)。
  //   - 表示中の週の献立と買い物リスト (readDisplayedWeek)・冷蔵庫 (fetchPantry)・人数の設定 (fetchUserSettings)
  //   - 月のカレンダーの献立のある日: 取得済みの月を捨ててから、表示中の週の前後 (weekWindowOf) と表示中の月 (monthWindowOf) に
  //     かかる月を読み直す (読んだ月は答えで置き換える。ほかの月は次にその週・月を開いたときに読み直す)
  //   - 生成中の依頼: 生成中の依頼の確認 (checkPendingRequests) をもう一度走らせる (読み取りではない。番兵で止めない)。AI 相談が始めた
  //     献立の生成 (generate_day_menu・generate_week_menu・generate_single_meal) は依頼を受けた時点 (status: processing) で
  //     成功を知らせるので、ここで取り直してもまだ献立は無い。生成が終わったときの取り直しは、開始日に関係なく、
  //     useAiConsultationReceiver がその依頼 (通知の result.requestId) を終わるまで見張り、終わったらこの関数をもう一度呼ぶ
  //     (src/lib/ai/consultation-generation-watch.ts)。生成中の表示 (進捗の帯) を出すのは今までどおり checkPendingRequests が
  //     見つけた依頼だけ (GET /api/ai/menu/weekly/pending が返すのは、開始日が表示中の週の初日の依頼。#1609)
  //   - 家族の一覧と名前 (loadFamilyData): 家族の切り替えに出す名前は、display_name の無いメンバー (自分を含む) なら
  //     プロフィールの名前で、AI 相談は自分の名前 (user_profiles.nickname) を書く
  //     (家族の献立 (useFamilyMenu。自分以外のメンバーの献立) は取り直さない。理由は
  //     src/lib/ai/consultation-refetch-coverage.ts の '/menus/weekly' の mountReadsNotRefetched の familyMenu)
  // 別の週の献立も変わりうる (1 週間の献立の作成など) ので、週のキャッシュは捨てて、次にその週を開いたときに取り直させる
  // (捨てる前に読み始めた週の読み込み・前後の週の先読みの応答は、あとから届いてもキャッシュに書かない。weekDataCache の discard)。
  // モーダル・入力の部品が出ている間・献立・買い物リストの書き込み (receiver.beginWrite の窓) の間に来た成功は捨てずに、外れたあとに
  // 1 回取り直す。応答を置く直前にも番兵・書き込みの印を見て、当たれば置かずに 1 回取り直す (receiver の place。#2201 U2)
  const refetchAfterAiConsultation = useCallback(async (read: AiConsultationRead) => {
    weekDataCache.current.discard();
    fetchedMonthsRef.current.clear();
    // AI 相談が始めた生成を見つけて進み具合を出す (読み取りではない。番兵で止めない。§6.6)
    void checkPendingRequests(weekStartKeyRef.current);
    await Promise.all([
      readDisplayedWeek(read, WEEK_PLACEMENT_REREAD),
      fetchPantry(read),
      fetchUserSettings(read),
      loadFamilyData(read),
      fetchAndCacheMealDates(read, ...weekWindowOf(weekStartRef.current)),
      fetchAndCacheMealDates(read, ...monthWindowOf(displayMonthRef.current)),
    ]);
  }, [readDisplayedWeek, fetchPantry, fetchUserSettings, loadFamilyData, fetchAndCacheMealDates, checkPendingRequests]);
  // 最初の描画から全画面のスピナー (前の initialUiFlagState.loading の true。表示中の週の献立が置かれるか、最初の fetchPlan が終わるまで)
  const receiver = useAiConsultationReceiver(refetchAfterAiConsultation, { initialLoadingKeys: [KEY_WEEK_LOADING] });
  const loading = receiver.isLoading(KEY_WEEK_LOADING); // uiFlag.loading の週の読み込みの用途を置き換える

  // 開いたときの 3 つの読み込み (人数の設定・冷蔵庫・家族)。receiver は一生同じ参照なので、開いたときに 1 回だけ走る
  useEffect(() => {
    void receiver.read({ loadingKeys: [KEY_SETTINGS] }, fetchUserSettings);
  }, [receiver, fetchUserSettings]);
  useEffect(() => {
    void receiver.read({}, fetchPantry);
  }, [receiver, fetchPantry]);
  useEffect(() => {
    void receiver.read({}, loadFamilyData);
  }, [receiver, loadFamilyData]);
  // 人数の設定の読み込み中の印は store (servingsConfigStore の isLoadingServingsConfig) に写す (人数の設定のモーダルが読む)
  const isLoadingSettings = receiver.isLoading(KEY_SETTINGS);
  useEffect(() => {
    setIsLoadingServingsConfig(isLoadingSettings);
  }, [isLoadingSettings, setIsLoadingServingsConfig]);

  // 週が変わるタイミングで前後2週間 (週の窓) の月のカレンダーの印を読む (取得済みの月は読まない)
  useEffect(() => {
    void receiver.read({}, (read) => fetchAndCacheMealDates(read, ...weekWindowOf(weekStart)));
  }, [receiver, weekStart, fetchAndCacheMealDates]);
  // displayMonth が変わったときも追加で読む（月移動時。表示月の前後 1 週間を含む月の窓）
  useEffect(() => {
    void receiver.read({}, (read) => fetchAndCacheMealDates(read, ...monthWindowOf(displayMonth)));
  }, [receiver, displayMonth, fetchAndCacheMealDates]);

  /**
   * 表示中の週を読み直す (#2206 G1 R2)。前の refreshMealPlan (流れの begin(札, 週) と place の中の setLoading(false)) の置き換えで、
   * 名前と 6 か所の呼び出しの字面 (`refreshMealPlan();`) は変えない:
   *   1. v4 の生成の完了 (useV4MenuGeneration の onGenerationComplete)
   *   2. restoreGeneration の「すでに完了している場合」(status API が completed)
   *   3. restoreGeneration の進捗の追跡 (v4Generation.subscribeToProgress) の completed
   *   4. v4 のポーリングの完了 (handleV4Generate の setInterval の completed。v4Watch の確かめのあと)
   *   5. 生成完了のダイアログの背景の onClick (refreshOnDismiss)
   *   6. 生成完了のダイアログの onDismiss (GenerationResultDialogContent。onRetry が無く refreshOnDismiss のとき)
   * 取り直しの経路からは呼ばない (refetchAfterAiConsultation は readDisplayedWeek(read, WEEK_PLACEMENT_REREAD) を直に呼ぶ)。
   * ページの読み取り ('mount') なので番兵を見ず、始めた時点のどの読み取りより新しい世代で plan:<週> に置く (R-7: 先に始めた読み込み・
   * 取り直しの古い応答で戻されず、より新しい読み取りの応答は戻さない)。週は読み始めた時点の表示中の週 (weekStartKeyRef) で、mount だけの
   * effect (restoreGeneration) の古い閉包から呼ばれても今の週を読む。失敗では何も置かない (前の refreshMealPlan と同じ)。
   * 表示中の週の献立を置けば全画面のスピナーも下ろす (releaseWeekLoadingIfShown。前の place の中の setLoading(false))。
   * 監視の印 (isActive) は取らない (前の refreshMealPlan も取らない。印を持つ監視の完了は reloadWeekAfterCompletion)
   */
  const refreshMealPlan = useCallback(
    () => receiver.read({}, (read) => readDisplayedWeek(read, WEEK_PLACEMENT_REREAD)),
    [receiver, readDisplayedWeek],
  );

  /**
   * 前後の週をバックグラウンドで先読みして控え (weekDataCache) に書く (画面には置かない)。
   * 控えには、読み始める前に取った書き込み口で書く (#2201 U1。読み始めたあとに AI 相談の取り直しが控えを捨てた・その週を
   * あとから読み直したときは書かない: 捨てる前に読んだ献立を控えに戻すと、その週へ移ったときに AI 相談の前の献立を出す)。
   * 読めなかった (非 ok) 週は控えに書かない (#2206 G1。空の週として控えると、その週へ移ったときに献立を出さない。S-18)
   */
  const prefetchAdjacentWeeks = useCallback((currentWeekStartKey: string) => {
    const now = Date.now();
    for (const weekStartKey of [
      addDaysStr(currentWeekStartKey, -ADJACENT_WEEK_OFFSET_DAYS),
      addDaysStr(currentWeekStartKey, ADJACENT_WEEK_OFFSET_DAYS),
    ]) {
      const cached = weekDataCache.current.get(weekStartKey);
      if (cached && now - cached.fetchedAt <= CACHE_TTL) continue;
      const writeAdjacentWeekCache = weekDataCache.current.beginWrite(weekStartKey);
      fetchWeekData(weekStartKey).then((week) => {
        if (week !== null) writeAdjacentWeekCache(weekCacheDataOf(week));
      }).catch(() => {});
    }
  }, []);

  /**
   * 週の読み込み (weekStart が変わったとき)。控えに当たれば同期で置く。全画面のスピナー (KEY_WEEK_LOADING) は、表示中の週の
   * 献立を置いたとき (releaseWeekLoadingIfShown) か、この読み取りの終わりで下りる (控えに当たったときは同期で置いて下ろす。S-18)
   */
  const fetchPlan = useCallback(async () => {
    const weekStartKey = weekStartKeyRef.current;
    await receiver.read({ loadingKeys: [KEY_WEEK_LOADING] }, async (read) => {
      const cached = weekDataCache.current.get(weekStartKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
        // キャッシュヒット - 即座に反映 (控えは、この週で最後に書き込み口を取った読み取り・書き込みのもの: あとから書き込み口を
        // 取ったら、そのときに控えを捨てている。createWeekDataCache)
        const placed = read.place(planKey(weekStartKey), () => {
          if (weekStartKeyRef.current !== weekStartKey) return;
          setCurrentPlan(cached.plan);
          // 買い物リストは控えから置かない (#2206 G1 R2。控えの買い物リストは先読み・読み込みの時点の写しで、そのあとの
          // 追加・チェック・削除は控えに書かないので、置くと今の一覧を古い一覧で戻す。置くのは GET の応答 (applyWeekResponse) と
          // 書き込みの関数だけ。S-23)
          if (cached.plan) autoExpandNextMealRef.current(cached.plan, weekDatesRef.current);
        });
        releaseWeekLoadingIfShown(read, weekStartKey, placed);
      } else {
        // キャッシュミス - APIから取得。読めなければ (非 ok・通信の失敗) この週の献立を空にする (開いたとき・週を移ったとき)
        if ((await readDisplayedWeek(read, WEEK_PLACEMENT_WEEK_READ)) === null) placeWeekReadFailure(read, weekStartKey);
        // 応答を待つあいだに週を移った: 前の週の生成中の行を確かめず、先読みもしない (前と同じ。移った先の週の読み込みが受け持つ)
        if (weekStartKeyRef.current !== weekStartKey) return;
        // DBで生成中のリクエストがあるか確認 (入り直しの経路 2 つの 1 つ。#1629。checkPendingRequests は呼ばない)。
        // resumePendingGeneration・subscribeToRequestStatus は生成の監視の入口なので place に通さない (§6.6。番兵 P1 の境 B-2・B-3)
        try {
          const pendingRes = await fetch(`/api/ai/menu/weekly/pending?date=${weekStartKey}`);
          if (pendingRes.ok) {
            const { hasPending, requestId, ultimateMode: pendingUltimateMode } = await pendingRes.json();
            if (hasPending && requestId) {
              // 生成中状態を復元してポーリング開始
              // 究極モードの生成かは、pending の ultimateMode (行の generated_data.ultimateMode の判定) で決める (#1597)
              const pendingIsUltimateMode = isUltimateModeWeeklyMenuRequest(pendingUltimateMode);
              // 生成中にし、最初の進捗が届くまでの間も段 (究極 / 通常) を合わせる (#1609。進捗が null だとカードが一瞬通常の段になる)。
              // すでに進捗があるとき (生成中のリロード・キャッシュが切れたあとに同じ週へ戻ったとき) は上書きしない (#1629)
              resumePendingGeneration(pendingIsUltimateMode);
              subscribeToRequestStatus(weekStartKey, requestId, pendingIsUltimateMode);
            }
          }
        } catch (e) {
          console.error("Failed to check pending weekly request", e);
        }
      }
      // バックグラウンドで前後の週をプリフェッチ (先読みは fetchWeekData が null を返したら控えに書かない)
      prefetchAdjacentWeeks(weekStartKey);
    });
  }, [receiver, readDisplayedWeek, placeWeekReadFailure, releaseWeekLoadingIfShown, prefetchAdjacentWeeks, resumePendingGeneration, subscribeToRequestStatus, setCurrentPlan]);
  // Fetch Plan & Check for pending generation requests
  useEffect(() => {
    // weekStartDay の設定が確定するまで待機（二重フェッチ防止）
    if (!weekStartDayLoaded) return;
    void fetchPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, weekStartDayLoaded]);  // fetchPlan は読み始めた時点の週 (weekStartKeyRef) を読む。依存に入れると、参照が変わるたびに読み直す

  /**
   * 生成の完了 (ポーリング startPolling・Realtime subscribeToRequestStatus・再生成 finishRegenerate・改善 finishImprove) のあとの置き換え:
   * ページの読み取りで生成した週を読み、applyWeekResponse で置く (WEEK_PLACEMENT_COMPLETION)。weekStartKey は生成した週 (targetDate・
   * weekStartDate・改善の weekDates[0])。写真の解析の結果は待ちが明けてから別に置く (analyzePhotoWithAI)。
   * 通信の失敗は投げる (呼ぶ側の今の catch が受ける)
   */
  const reloadWeekAfterCompletion = useCallback(
    (weekStartKey: string, isActive: () => boolean) =>
      receiver.read({}, async (read) => {
        const writeWeekCache = weekDataCache.current.beginWrite(weekStartKey);
        const week = await fetchWeekData(weekStartKey);
        if (!isActive() || week === null) return; // 監視が終わっていたら置かない (#1657 の印はそのまま)
        applyWeekResponse(read, weekStartKey, week, writeWeekCache, WEEK_PLACEMENT_COMPLETION);
      }),
    [receiver, applyWeekResponse],
  );

  /** 今の献立の写し (完了の切り替えの待ちが明けたときに、押した描画でなく今の献立から値を決める。#2206 G1) */
  const currentPlanRef = useRef(currentPlan);
  currentPlanRef.current = currentPlan;

  // Initialize selected day to today
  useEffect(() => {
    const todayStr = formatLocalDate(new Date());
    const idx = weekDates.findIndex(d => d.dateStr === todayStr);
    if (idx !== -1) setSelectedDayIndex(idx);
  }, [weekStart, weekDates]);

  // Bug-5 (#21): Publish currently displayed date so the AI chat bubble's
  // "1日献立変更" modal can default to it instead of always defaulting to today
  // (which risks overwriting today's existing menu when the user actually
  // wanted to regenerate a future day).
  useEffect(() => {
    const dateStr = weekDates[selectedDayIndex]?.dateStr;
    if (typeof window !== 'undefined' && dateStr) {
      window.__weeklyCurrentDate = dateStr;
    }
    return () => {
      if (typeof window !== 'undefined') {
        try { delete window.__weeklyCurrentDate; } catch { /* noop */ }
      }
    };
  }, [selectedDayIndex, weekDates]);

  // Fetch AI hint when stats change
  useEffect(() => {
    if (currentPlan?.days && currentPlan.days.length > 0) {
      fetchAiHint();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPlan?.days?.length]);  // fetchAiHint は通常関数のため deps に含めると無限ループになる可能性があるため個別 disable
  
  const fetchAiHint = async () => {
    setIsLoadingHint(true);
    try {
      const res = await fetch('/api/ai/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cookRate: stats.cookRate,
          avgCal: stats.avgCal,
          cookCount: stats.cookCount,
          buyCount: stats.buyCount,
          outCount: stats.outCount,
          expiringItems: expiringItems.map(i => i.name)
        })
      });
      if (res.ok) {
        const { hint } = await res.json();
        setAiHint(hint);
      }
    } catch (e) {
      console.error('Failed to fetch AI hint:', e);
    } finally {
      setIsLoadingHint(false);
    }
  };

  // AI栄養士フィードバックを取得する関数（Realtime + ポーリングのハイブリッド方式）
  const fetchNutritionFeedback = async (dateStr: string, forceRefresh = false) => {
    setNutritionFeedback(null);
    setPraiseComment(null);
    setNutritionTip(null);
    setIsLoadingFeedback(true);
    setFeedbackCacheId(null);
    
    // 既存の購読/ポーリングを解除し、この取得を「現役の取得」にする (#1206)。
    // アンマウント・モーダルを閉じる・別の取得の開始のどれかで request.isCurrent() が false になる
    const request = feedbackWatch.startRequest();
    
    const targetDay = currentPlan?.days?.find(d => d.dayDate === dateStr);
    const mealCount = targetDay?.meals?.filter(m => m.dishName)?.length || 0;
    const dayNutrition = getDayTotalNutrition(targetDay);
    
    try {
      const res = await fetch('/api/ai/nutrition/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateStr,
          nutrition: dayNutrition,
          mealCount,
          forceRefresh,
          weekData: currentPlan?.days?.map(d => ({
            date: d.dayDate,
            meals: d.meals?.map(m => ({ 
              title: m.dishName, 
              calories: m.caloriesKcal,
              dishes: m.dishes?.map(dish => dish.name) || []
            })) || []
          })) || [],
        })
      });
      // 応答を待つ間にアンマウント/モーダルが閉じられた/別の取得が始まった場合は、
      // 購読を張らず state も触らずに終わる (#1206)
      if (!request.isCurrent()) return;

      // 同意が無いため AI に送らなかった (403 AI_CONSENT_REQUIRED。T15 / #1154)。
      // 栄養の詳細を開くと自動で頼む処理なので、同意画面は出さず、案内の一文だけを出す
      if (await isAiConsentRequiredResponse(res)) {
        if (!request.isCurrent()) return;
        setNutritionFeedback(AI_CONSENT_COPY.automaticLockedNote);
        setIsLoadingFeedback(false);
        return;
      }
      // 今日の AI の利用回数の上限に達した (429 AI_DAILY_LIMIT。#1149)。「再分析」(forceRefresh) は 1 日の上限 (プランごと) に数え、
      // 画面を開いたときの自動の取得は上限に数えないが、自動の分だけの安全弁 (既定は 1 日 30 回) に達したときもここに来る
      const dailyLimitMessage = await aiDailyLimitMessageOfResponse(res);
      if (dailyLimitMessage) {
        if (!request.isCurrent()) return;
        setNutritionFeedback(dailyLimitMessage);
        setIsLoadingFeedback(false);
        return;
      }
      
      if (res.ok) {
        const data = await res.json();
        if (!request.isCurrent()) return;
        
        // キャッシュから即座に取得できた場合
        if (data.cached && (data.feedback || data.praiseComment)) {
          setNutritionFeedback(data.advice || data.feedback || '');
          setPraiseComment(data.praiseComment || null);
          setNutritionTip(data.nutritionTip || null);
          setIsLoadingFeedback(false);
          console.log('Nutrition feedback loaded from cache');
          return;
        }
        
        // 生成中の場合はRealtime + ポーリングで更新を待つ
        if (data.status === 'generating' && data.cacheId) {
          const cacheId = data.cacheId;
          setFeedbackCacheId(cacheId);
          console.log('Nutrition feedback generating, setting up Realtime + polling...');
          
          // 生成が終わる (成功 / 失敗 / タイムアウト) か、アンマウント・モーダルを閉じると、
          // ポーリングの停止も Realtime チャンネルの除去も watch 側で必ず行われる (#1206)
          request.watch(cacheId, {
            onResolved: (content) => {
              setNutritionFeedback(content.advice);
              setPraiseComment(content.praiseComment);
              setNutritionTip(content.nutritionTip);
              setIsLoadingFeedback(false);
            },
            onFailed: (message) => {
              setNutritionFeedback(message);
              setPraiseComment(null);
              setNutritionTip(null);
              setIsLoadingFeedback(false);
            },
          });
        } else {
          // UX2-03: 「キャッシュ済み」でも「生成中」でもない想定外のレスポンス形状
          // (例: cached=true だが feedback/praiseComment が空、status が想定外の値等) に
          // フォールスルーすると setIsLoadingFeedback(false) が一度も呼ばれず
          // 読み込み中 (「分析しています...」) のスピナーが永久に止まらなかった。
          // 他の失敗経路 (!res.ok / catch) と同じ文言・挙動に揃えて解除する
          // （これにより既存の「再分析」ボタンが再試行導線として機能する）。
          setNutritionFeedback('分析結果を取得できませんでした。');
          setIsLoadingFeedback(false);
        }
      } else {
        setNutritionFeedback('分析結果を取得できませんでした。');
        setIsLoadingFeedback(false);
      }
    } catch (e) {
      // 現役でなくなった取得 (離脱で中断された fetch など) のエラーは、画面にも state にも出さない (#1206)
      if (!request.isCurrent()) return;
      console.error('Failed to get nutrition feedback:', e);
      setNutritionFeedback('分析中にエラーが発生しました。');
      setIsLoadingFeedback(false);
    }
  };

  // AI栄養士フィードバックを自動取得（モーダルを開いた瞬間に開始）
  useEffect(() => {
    const currentDateStr = weekDates[selectedDayIndex]?.dateStr;
    
    // モーダルが開いていて、かつ日付が変わった場合に取得
    if (showNutritionDetailModal && currentDateStr && currentDateStr !== lastFeedbackDate) {
      setLastFeedbackDate(currentDateStr);
      fetchNutritionFeedback(currentDateStr);
    }
    
    // 購読/ポーリングの解除（モーダルを閉じたとき・アンマウント時）は useNutritionFeedbackWatch が行う。
    // ここの cleanup で state (showNutritionDetailModal) を見て解除すると、effect 作成時点の古い値を掴み、
    // モーダルを開いたまま離脱したときに解除されない (#1206)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNutritionDetailModal, selectedDayIndex, weekDates, lastFeedbackDate]);  // fetchNutritionFeedback は通常関数のため deps に含めると毎回再実行されるため個別 disable
  
  // サマリーモーダルを開いた時も今日のフィードバックを取得
  useEffect(() => {
    if (activeModal === 'stats' && weeklySummaryTab === 'today') {
      const todayStr = formatLocalDate(new Date());
      // まだ取得していない場合のみ取得
      if (todayStr !== lastFeedbackDate) {
        setLastFeedbackDate(todayStr);
        fetchNutritionFeedback(todayStr);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal, weeklySummaryTab, lastFeedbackDate]);  // fetchNutritionFeedback は通常関数のため deps に含めると毎回再実行されるため個別 disable
  
  // Week Navigation
  // UX2-24: 週送りしても選択中の曜日位置（dayIndex）は維持する（従来は常に週頭にリセットされていた）
  const goToPreviousWeek = () => {
    const newStart = new Date(weekStart);
    newStart.setDate(weekStart.getDate() - 7);
    navigateWeekPrev(newStart);
    setExpandedMealId(null);
    setIsDayNutritionExpanded(false);
  };

  const goToNextWeek = () => {
    const newStart = new Date(weekStart);
    newStart.setDate(weekStart.getDate() + 7);
    navigateWeekNext(newStart);
    setExpandedMealId(null);
    setIsDayNutritionExpanded(false);
  };

  // Calendar Navigation
  const goToPreviousMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    shiftDisplayMonth(PREVIOUS_MONTH);
  };

  const goToNextMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    shiftDisplayMonth(NEXT_MONTH);
  };

  const handleCalendarDateClick = (date: Date) => {
    const newWeekStart = getWeekStart(date, weekStartDay);

    // 同一週かどうかを日付文字列で比較（Date オブジェクト参照比較による不要な再フェッチを防止）
    const currentWeekStartStr = formatLocalDate(weekStart);
    const newWeekStartStr = formatLocalDate(newWeekStart);

    if (currentWeekStartStr !== newWeekStartStr) {
      // 異なる週の場合のみ weekStart を更新（fetchPlan がトリガーされる）
      setWeekStart(newWeekStart);
    }

    // selectedDayIndex は常に更新（同一週内でも日付切り替え）
    const dayOfWeekRaw = date.getDay();
    const startOffset = weekStartDay === 'sunday' ? 0 : 1;
    let dayIndex = dayOfWeekRaw - startOffset;
    if (dayIndex < 0) dayIndex += 7;
    setSelectedDayIndex(dayIndex);

    setIsCalendarExpanded(false);
    setIsDayNutritionExpanded(false);
    setExpandedMealId(null);
    // ユーザーが明示的に日付を選択した場合は autoExpandNextMeal をスキップ
    setHasAutoExpanded(true);
  };

  // Calendar memos
  const calendarDays = useMemo(() => getCalendarDays(displayMonth, weekStartDay), [displayMonth, weekStartDay]);
  const dayLabels = useMemo(() => getDayLabels(weekStartDay), [weekStartDay]);

  const mealExistenceMap = useMemo(() => {
    const map = new Map<string, boolean>();
    // 現在の週のデータ
    currentPlan?.days?.forEach(day => {
      if (day.meals && day.meals.length > 0) {
        map.set(day.dayDate, true);
      }
    });
    // カレンダー月全体のデータ（他の週も含む）
    calendarMealDates.forEach(dateStr => {
      map.set(dateStr, true);
    });
    return map;
  }, [currentPlan, calendarMealDates]);

  // #91: 今週に献立データが存在するか（買い物リスト生成ボタンの disabled 判定に使用）
  const hasAnyMealsThisWeek = useMemo(() => {
    if (!currentPlan) return false;
    return currentPlan.days.some(d => d.meals && d.meals.length > 0);
  }, [currentPlan]);

  // --- Handlers ---
  
  const handleUpdateMeal = async (dayId: string, mealId: string | null, updates: Partial<PlannedMeal>) => {
    if (!currentPlanRef.current || !mealId) return;
    // 楽観的UI更新（失敗時にロールバックするため、変える項目の元の値を保持）。今の献立のこの食事にだけ当てる (#2201 U2。
    // 完了の切り替えは 250ms 待ってからここに来るので、その間に置いた取り直しの応答を、この描画の献立の写しで戻さない)。
    // 元の値は呼ばれた時点の今の献立 (currentPlanRef) から取る (#2206 G1。押した描画の写しでなく、待ちの間に置いた献立の値)
    const previousMeal = currentPlanRef.current.days?.find(day => day.id === dayId)?.meals?.find(meal => meal.id === mealId);
    const endWrite = receiver.beginWrite();
    updatePlanMeal(dayId, mealId, updates);
    try {
      const res = await fetch(`/api/meal-plans/meals/${mealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (!res.ok) throw new Error('Update failed');
    } catch (e) {
      console.error('Failed to update meal:', e);
      // 失敗したら、この食事の変えた項目だけを元に戻す (書き込みの間に置いたほかの値は戻さない)
      if (previousMeal) updatePlanMeal(dayId, mealId, plannedMealFieldsOf(previousMeal, updates));
      alert('更新に失敗しました');
    } finally {
      endWrite();
    }
  };
  
  // #322: meal toggle debounce timer (メモリリーク防止のため cleanup は下の useEffect で実施)
  const toggleDebounceTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingToggleWeeklyRef = useRef<Set<string>>(new Set());

  // Toggle completion (can check and uncheck) — debounce 250ms (#322)
  const toggleMealCompletion = async (dayId: string, meal: PlannedMeal) => {
    const mealId = meal.id ?? '';
    // 既存タイマーをキャンセル
    const existing = toggleDebounceTimerRef.current.get(mealId);
    if (existing) {
      clearTimeout(existing);
      toggleDebounceTimerRef.current.delete(mealId);
    }
    // PATCH が進行中なら無視
    if (pendingToggleWeeklyRef.current.has(mealId)) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        toggleDebounceTimerRef.current.delete(mealId);
        resolve();
      }, MEAL_TOGGLE_DEBOUNCE_MS);
      toggleDebounceTimerRef.current.set(mealId, timer);
    });

    if (pendingToggleWeeklyRef.current.has(mealId)) return;
    // 送る値は、待ちが明けた時点の今の献立 (currentPlanRef) のこの食事から決める (#2206 G1。待ちの間に AI 相談の取り直しが
    // 同じ食事の完了を変えて置いていたら、その値から反転する。押した描画の写しの値から決めない。S-12)
    const currentMeal = currentPlanRef.current?.days?.find((d) => d.id === dayId)?.meals?.find((m) => m.id === mealId);
    if (!currentMeal) return;
    pendingToggleWeeklyRef.current.add(mealId);
    const newCompleted = !currentMeal.isCompleted;
    await handleUpdateMeal(dayId, currentMeal.id, { isCompleted: newCompleted });
    pendingToggleWeeklyRef.current.delete(mealId);
  };

  // UX2-18: 保存中フラグ（追加・編集・写真解析の共通ローディング表示に使用）
  const [isSavingFridgeItem, setIsSavingFridgeItem] = useState(false);
  const [isAnalyzingFridgePhoto, setIsAnalyzingFridgePhoto] = useState(false);

  // Add or update pantry item (UX2-18: editingFridgeItemId があれば PATCH、無ければ POST)
  const addPantryItem = async () => {
    const { newFridgeName, newFridgeAmount, newFridgeExpiry, editingFridgeItemId } = useFormDraftStore.getState();
    if (!newFridgeName) return;
    setIsSavingFridgeItem(true);
    // 冷蔵庫の書き込み (#2201 U2。書き込みの前に読んだ取り直しの応答で、足した・変えた食材を戻さない)
    const endWrite = receiver.beginWrite();
    try {
      if (editingFridgeItemId) {
        const res = await fetch(`/api/pantry/${editingFridgeItemId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newFridgeName,
            amount: newFridgeAmount,
            expirationDate: newFridgeExpiry || null,
          })
        });
        if (res.ok) {
          const { item } = await res.json();
          usePantryStore.getState().updateFridgeItem(editingFridgeItemId, item);
          useFormDraftStore.getState().resetFridgeForm();
          setActiveModal('fridge');
        } else {
          alert('更新に失敗しました');
        }
      } else {
        const res = await fetch('/api/pantry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newFridgeName,
            amount: newFridgeAmount,
            category: "other",
            expirationDate: newFridgeExpiry || null
          })
        });
        if (res.ok) {
          const { item } = await res.json();
          usePantryStore.getState().addFridgeItem(item);
          useFormDraftStore.getState().resetFridgeForm();
          setActiveModal('fridge');
        } else {
          alert('追加に失敗しました');
        }
      }
    } catch (e) {
      alert(useFormDraftStore.getState().editingFridgeItemId ? '更新に失敗しました' : '追加に失敗しました');
    } finally {
      setIsSavingFridgeItem(false);
      endWrite();
    }
  };

  const deletePantryItem = async (id: string) => {
    // 冷蔵庫の書き込み (#2201 U2。削除の前に読んだ取り直しの応答で、削除した食材を戻さない)
    const endWrite = receiver.beginWrite();
    try {
      await fetch(`/api/pantry/${id}`, { method: 'DELETE' });
      usePantryStore.getState().removeFridgeItem(id);
    } catch (e) {
      alert("削除に失敗しました");
    } finally {
      endWrite();
    }
  };

  // UX2-18: 一覧の食材タップで編集フォームを開く（/pantry ページとの機能非対称解消の一環）
  const startEditFridgeItem = (item: { id: string; name: string; amount: string | null; expirationDate: string | null }) => {
    setNewFridgeName(item.name);
    setNewFridgeAmount(item.amount || '');
    setNewFridgeExpiry(item.expirationDate || '');
    setEditingFridgeItemId(item.id);
    setActiveModal('addFridge');
  };

  // UX2-18: /pantry ページと同じ「写真で追加」を FridgeModal からも実行できるようにする
  const handleFridgePhotoSelected = async (file: File) => {
    setIsAnalyzingFridgePhoto(true);
    // 冷蔵庫の書き込み (#2201 U2。保存の前に読んだ取り直しの応答で、写真から足した食材を消さない)
    const endWrite = receiver.beginWrite();
    try {
      // 「同意しない」なら写真を AI に送らない
      if ((await ensureAiConsent()) === "declined") return;
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((acc, byte) => acc + String.fromCharCode(byte), "")
      );
      const analyzeRes = await aiFetch('/api/ai/analyze-fridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType: file.type || 'image/jpeg' }),
      });
      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内するので、エラーは出さない
      if (await isAiConsentRequiredResponse(analyzeRes)) return;
      if (!analyzeRes.ok) {
        const data = await analyzeRes.json().catch(() => ({}));
        throw new Error(data.error || '解析に失敗しました');
      }
      const analyzed = await analyzeRes.json();
      const ingredients = (analyzed.detailedIngredients || []).map((it: { name: string; quantity?: string; category?: string; freshness?: string; daysRemaining?: number }) => ({
        name: it.name,
        amount: it.quantity || null,
        category: it.category || undefined,
        daysRemaining: it.daysRemaining,
        freshness: it.freshness,
      }));
      if (ingredients.length === 0) {
        alert('食材を検出できませんでした');
        return;
      }
      const saveRes = await fetch('/api/pantry/from-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ingredients, mode: 'append' }),
      });
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        throw new Error(data.error || '保存に失敗しました');
      }
      // from-photo のレスポンスは snake_case のため、camelCase の一覧を取り直す。ページの読み取りで読み、KEY_PANTRY に置く
      // (開いたときの冷蔵庫の読み込みなど、保存の前に始めた読み取りの古い応答で、足した食材を消さない。#2206 G1。S-32)。非 ok は何も置かない・
      // 通信の失敗は投げて外側の catch の知らせへ (前と同じ。fetchPantry は失敗を握るので使わない)
      await receiver.read({}, async (read) => {
        const listRes = await fetch('/api/pantry');
        if (!listRes.ok) return;
        const { items } = await listRes.json();
        read.place(KEY_PANTRY, () => usePantryStore.getState().setFridgeItems(items || []));
      });
    } catch (e: any) {
      alert(e?.message || '写真からの追加に失敗しました');
    } finally {
      setIsAnalyzingFridgePhoto(false);
      endWrite();
    }
  };

  // Add shopping item
  const addShoppingItem = async () => {
    const { newShoppingName, newShoppingAmount, newShoppingCategory } = useFormDraftStore.getState();
    if (!newShoppingName || !currentPlan) return;
    // 買い物リストの書き込み (#2201 U2。追加の前に読んだ取り直しの応答で、足した品目を消さない)
    const endWrite = receiver.beginWrite();
    try {
      const res = await fetch('/api/shopping-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shoppingListId: activeShoppingList?.id,
          itemName: newShoppingName,
          quantity: newShoppingAmount,
          category: newShoppingCategory
        })
      });
      if (res.ok) {
        const { item } = await res.json();
        setShoppingList([...useShoppingStore.getState().shoppingList, item]);
        setNewShoppingName("");
        setNewShoppingAmount(""); 
        setNewShoppingCategory("食材");
        setActiveModal('shopping');
      }
    } catch (e) {
      alert("追加に失敗しました");
    } finally {
      endWrite();
    }
  };

  // チェックボックスのトグル（楽観的更新）
  const toggleShoppingItem = (id: string, currentChecked: boolean) => {
    const endWrite = receiver.beginWrite();
    // 即座にUIを更新
    setShoppingList(useShoppingStore.getState().shoppingList.map(i => i.id === id ? { ...i, isChecked: !currentChecked } : i));

    // 裏でAPI呼び出し（永続化）- レスポンスを待たない
    fetch(`/api/shopping-list/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isChecked: !currentChecked })
    }).then(res => {
      if (!res.ok) throw new Error('Update failed');
    }).catch(e => {
      console.error('Failed to save check state:', e);
      // エラー時はロールバック
      setShoppingList(useShoppingStore.getState().shoppingList.map(i => i.id === id ? { ...i, isChecked: currentChecked } : i));
      alert('更新に失敗しました');
    }).finally(() => {
      endWrite();
    });
  };

  const deleteShoppingItem = async (id: string) => {
    // 楽観的UI更新
    const previousList = useShoppingStore.getState().shoppingList;
    const endWrite = receiver.beginWrite();
    setShoppingList(previousList.filter(i => i.id !== id));
    try {
      const res = await fetch(`/api/shopping-list/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
    } catch (e) {
      // 失敗したら元に戻す
      setShoppingList(previousList);
    } finally {
      endWrite();
    }
  };

  // 買い物リスト全削除の確認モーダルを開く（#1053: window.confirm 廃止、styled モーダルに統一）
  const requestDeleteAllShopping = () => {
    if (shoppingList.length === 0) return;
    setShowConfirmDeleteAllShopping(true);
  };

  // 買い物リスト全削除
  const deleteAllShoppingItems = async () => {
    const previousList = shoppingList;
    const itemIds = shoppingList.map(i => i.id);

    // 楽観的UI更新
    const endWrite = receiver.beginWrite();
    setShoppingList([]);
    setShowConfirmDeleteAllShopping(false);

    try {
      const res = await fetch('/api/shopping-list', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds })
      });
      if (!res.ok) throw new Error('Delete all failed');
    } catch (e) {
      // 失敗したら元に戻す
      setShoppingList(previousList);
      alert('削除に失敗しました');
    } finally {
      endWrite();
    }
  };

  // 買い物リスト再生成の進捗購読（Realtime + ポーリング）
  const shoppingListChannelRef = useRef<any>(null);
  const shoppingListPollingRef = useRef<NodeJS.Timeout | null>(null);
  // 買い物リストの再生成の監視 1 回分の印 (#1657)。cleanupShoppingListSubscription (終わり・次の監視の開始・アンマウント) で active が false になる
  const shoppingListWatchRef = useRef<{ active: boolean } | null>(null);
  
  const cleanupShoppingListSubscription = useCallback(() => {
    // fetch を待っているポーリングの tick・Realtime の処理が、戻ってから何も置かないように、印を下ろす (#1657)
    if (shoppingListWatchRef.current) {
      shoppingListWatchRef.current.active = false;
      shoppingListWatchRef.current = null;
    }
    if (shoppingListChannelRef.current) {
      shoppingListChannelRef.current.unsubscribe();
      shoppingListChannelRef.current = null;
    }
    if (shoppingListPollingRef.current) {
      clearInterval(shoppingListPollingRef.current);
      shoppingListPollingRef.current = null;
    }
  }, []);

  /**
   * 買い物リストの再生成の完了のあとの読み直し (#2206 G1 R5)。前の subscribeToShoppingListRequest のポーリングと Realtime の完了の
   * GET /api/shopping-list と setShoppingList・setActiveShoppingList の置き換えを、ページの読み取りの place に通す
   * (再生成を待つあいだに始まった取り直しの古い応答 (再生成の前の一覧) が、完了のあとに届いても置かれない。S-31)。
   * isActive は監視の印 (shoppingListWatch.active。#1657)。読んだあとに監視が終わっていたら置かない (前と同じ)。
   * 非 ok・一覧が無い応答 (shoppingList か items が無い) は何も置かない (前と同じ)。通信の失敗・本文の読み出しの失敗は投げる
   * (receiver.read がそのまま返し、呼ぶ側の catch が受ける: ポーリングは次の tick で読み直し、Realtime は console.error のあと
   * 完了の知らせへ進む。前と同じ)
   */
  const readRegeneratedShoppingList = useCallback(
    async (read: AiConsultationRead, isActive: () => boolean): Promise<void> => {
      const listRes = await fetch(`/api/shopping-list`);
      if (!isActive() || !listRes.ok) return;
      const body = (await listRes.json()) as { shoppingList?: ShoppingList | null };
      if (!isActive()) return;
      const list = body.shoppingList;
      if (!list?.items) return;
      const items: ShoppingListItem[] = list.items;
      read.place(KEY_ACTIVE_SHOPPING_LIST, () => setActiveShoppingList(list));
      read.place(KEY_SHOPPING_LIST, () => setShoppingList(items));
    },
    [setShoppingList, setActiveShoppingList],
  );

  const subscribeToShoppingListRequest = useCallback((requestId: string) => {
    cleanupShoppingListSubscription();
    // この監視の印 (#1657)。前の監視の、fetch を待っていた tick が、戻ってからこの監視を片づけたり表示を書き換えたりしないように
    const shoppingListWatch = { active: true };
    shoppingListWatchRef.current = shoppingListWatch;
    
    console.log('📡 Subscribing to shopping list request:', requestId);
    
    // タイムアウト処理（2分で強制終了）
    const TIMEOUT_MS = 120000;
    const startTime = Date.now();

    // T15 (#1154): 失敗の文 (result.error) が「同意が無くてサーバーが止めた」ものなら、同意画面を出し、
    // 失敗の表示は出さずに進み具合を閉じて true を返す (Realtime・ポーリングのどちらで失敗を受けても通る)
    const closeShoppingListIfAiConsentRequired = (stored: string | undefined): boolean => {
      if (!handleStoredAiConsentFailure(stored)) return false;
      setIsRegeneratingShoppingList(false);
      setShoppingListProgress(null);
      setShoppingListRequestId(null);
      localStorage.removeItem('shoppingListRegenerating');
      cleanupShoppingListSubscription();
      return true;
    };
    
    // ポーリングも並行開始（Realtimeのバックアップ）
    const poll = async () => {
      if (!shoppingListWatch.active) return;
      // タイムアウトチェック
      if (Date.now() - startTime > TIMEOUT_MS) {
        console.log('⏰ Shopping list regeneration timed out');
        setShoppingListProgress({ phase: 'failed', message: '処理がタイムアウトしました。もう一度お試しください。', percentage: 0 });
        setTimeout(() => {
          setIsRegeneratingShoppingList(false);
          setShoppingListProgress(null);
          setShoppingListRequestId(null);
        }, 5000);
        localStorage.removeItem('shoppingListRegenerating');
        cleanupShoppingListSubscription();
        return;
      }
      try {
        const res = await fetch(`/api/shopping-list/regenerate/status?requestId=${requestId}`);
        if (!res.ok) return;
        const data = await res.json();
        // fetch を待つ間に監視が終わっていたら (Realtime が終わりを先に処理した・次の監視が始まった)、何も置かない (#1657)
        if (!shoppingListWatch.active) return;
        
        if (data.progress) {
          setShoppingListProgress(data.progress);
        }
        
        if (data.status === 'completed') {
          console.log('✅ Shopping list regeneration completed (polling)');
          // 一覧の読み直しはページの読み取りの place で置く (#2206 G1 R5。S-31)
          await receiver.read({}, (read) => readRegeneratedShoppingList(read, () => shoppingListWatch.active));
          if (!shoppingListWatch.active) return;
          setSuccessMessage({
            title: '買い物リストを更新しました ✓',
            message: data.result?.stats
              ? (() => {
                  const stats = data.result.stats;
                  const inputCount = (stats as { inputCount?: number }).inputCount ?? stats.outputCount + stats.mergedCount;
                  return `${inputCount}件の材料を ${stats.outputCount}件にまとめました（重複 ${stats.mergedCount}件を統合）`;
                })()
              : '買い物リストを再生成しました'
          });
          setIsRegeneratingShoppingList(false);
          setShoppingListProgress(null);
          setShoppingListRequestId(null);
          localStorage.removeItem('shoppingListRegenerating');
          cleanupShoppingListSubscription();
        } else if (data.status === 'failed') {
          console.log('❌ Shopping list regeneration failed (polling)');
          if (closeShoppingListIfAiConsentRequired(data.result?.error)) return;
          const errorMsg = shoppingListRequestErrorMessageForDisplay(data.result?.error) || '再生成に失敗しました';
          setShoppingListProgress({ phase: 'failed', message: errorMsg, percentage: 0 });
          // 5秒後に自動で閉じる
          setTimeout(() => {
            setIsRegeneratingShoppingList(false);
            setShoppingListProgress(null);
            setShoppingListRequestId(null);
          }, 5000);
          localStorage.removeItem('shoppingListRegenerating');
          cleanupShoppingListSubscription();
        }
      } catch (e) {
        console.error('Shopping list polling error:', e);
      }
    };
    
    poll(); // 即座に1回実行
    shoppingListPollingRef.current = setInterval(poll, 2000);
    
    // Realtime購読
    const channel = supabaseRef.current
      .channel(`shopping-list-request-${requestId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'shopping_list_requests',
          filter: `id=eq.${requestId}`,
        },
        async (payload) => {
          // 監視が終わったあとに届いた更新では何も置かない (#1657)
          if (!shoppingListWatch.active) return;
          console.log('📡 Shopping list progress update:', payload.new);
          const newData = payload.new as { 
            status: string; 
            progress?: { phase: string; message: string; percentage: number };
            result?: { stats?: { inputCount: number; outputCount: number; mergedCount: number; totalServings?: number }; error?: string };
          };
          
          if (newData?.progress) {
            setShoppingListProgress(newData.progress);
          }
          
          if (newData.status === 'completed') {
            console.log('✅ Shopping list regeneration completed (realtime)');
            // totalServingsを保存
            if (newData.result?.stats?.totalServings !== undefined) {
              setShoppingListTotalServings(newData.result.stats.totalServings);
            }
            try {
              // 一覧の読み直しはページの読み取りの place で置く (#2206 G1 R5。S-31)
              await receiver.read({}, (read) => readRegeneratedShoppingList(read, () => shoppingListWatch.active));
              // 一覧を読む間に、ポーリングが同じ終わりを先に処理した (印を下ろした)・次の監視が始まったときは、何も置かない (#1657)
              if (!shoppingListWatch.active) return;
            } catch (fetchErr) {
              console.error('❌ Failed to fetch shopping list:', fetchErr);
            }
            if (!shoppingListWatch.active) return;
            const servingsDisplay = newData.result?.stats?.totalServings
              ? `・合計 ${newData.result.stats.totalServings}食分`
              : '';
            setSuccessMessage({
              title: '買い物リストを更新しました ✓',
              message: newData.result?.stats
                ? (() => {
                    const stats = newData.result!.stats!;
                    const inputCount = stats.inputCount ?? stats.outputCount + stats.mergedCount;
                    return `${inputCount}件の材料を ${stats.outputCount}件にまとめました（重複 ${stats.mergedCount}件を統合${servingsDisplay}）`;
                  })()
                : '買い物リストを再生成しました'
            });
            setIsRegeneratingShoppingList(false);
            setShoppingListProgress(null);
            setShoppingListRequestId(null);
            localStorage.removeItem('shoppingListRegenerating');
            cleanupShoppingListSubscription();
          } else if (newData.status === 'failed') {
            console.log('❌ Shopping list regeneration failed (realtime)');
            if (closeShoppingListIfAiConsentRequired(newData.result?.error)) return;
            // 行の result.error は、こちらで書いた文 (定型の失敗の文・同意・上限) だけをそのまま出す (#1576)
            const errorMsg = shoppingListRequestErrorMessageForDisplay(newData.result?.error) || '再生成に失敗しました';
            setShoppingListProgress({ phase: 'failed', message: errorMsg, percentage: 0 });
            // 5秒後に自動で閉じる
            setTimeout(() => {
              setIsRegeneratingShoppingList(false);
              setShoppingListProgress(null);
              setShoppingListRequestId(null);
            }, 5000);
            localStorage.removeItem('shoppingListRegenerating');
            cleanupShoppingListSubscription();
          }
        }
      )
      .subscribe((status) => {
        console.log('📡 Shopping list subscription status:', status);
        if (status === 'SUBSCRIBED') {
          // Realtime接続成功したらポーリング停止
          if (shoppingListPollingRef.current) {
            clearInterval(shoppingListPollingRef.current);
            shoppingListPollingRef.current = null;
          }
        }
      });
    
    shoppingListChannelRef.current = channel;
  }, [cleanupShoppingListSubscription, setShoppingList, setSuccessMessage, receiver, readRegeneratedShoppingList]);

  // 復元後に購読を開始
  useEffect(() => {
    if (shoppingListRequestId && shouldRestoreSubscription && isRegeneratingShoppingList) {
      console.log('📡 復元された買い物リスト再生成の購読を開始:', shoppingListRequestId);
      subscribeToShoppingListRequest(shoppingListRequestId);
      setShouldRestoreSubscription(false); // 一度だけ実行
    }
  }, [shoppingListRequestId, shouldRestoreSubscription, isRegeneratingShoppingList, subscribeToShoppingListRequest]);

  // クリーンアップ（アンマウント時）
  useEffect(() => {
    return () => {
      cleanupShoppingListSubscription();
    };
  }, [cleanupShoppingListSubscription]);

  // 買い物範囲から日付範囲を計算
  const calculateDateRange = useCallback(() => {
    const today = new Date();
    const todayStr = formatLocalDate(today);
    
    switch (shoppingRange.type) {
      case 'today':
        return {
          startDate: todayStr,
          endDate: todayStr,
          mealTypes: shoppingRange.todayMeals,
        };
      case 'tomorrow': {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return {
          startDate: formatLocalDate(tomorrow),
          endDate: formatLocalDate(tomorrow),
          mealTypes: ['breakfast', 'lunch', 'dinner'] as const,
        };
      }
      case 'dayAfterTomorrow': {
        const dayAfter = new Date(today);
        dayAfter.setDate(dayAfter.getDate() + 2);
        return {
          startDate: formatLocalDate(dayAfter),
          endDate: formatLocalDate(dayAfter),
          mealTypes: ['breakfast', 'lunch', 'dinner'] as const,
        };
      }
      case 'week': {
        const weekEnd = new Date(today);
        weekEnd.setDate(weekEnd.getDate() + 6);
        return {
          startDate: todayStr,
          endDate: formatLocalDate(weekEnd),
          mealTypes: ['breakfast', 'lunch', 'dinner'] as const,
        };
      }
      case 'days': {
        const endDay = new Date(today);
        endDay.setDate(endDay.getDate() + shoppingRange.daysCount - 1);
        return {
          startDate: todayStr,
          endDate: formatLocalDate(endDay),
          mealTypes: ['breakfast', 'lunch', 'dinner'] as const,
        };
      }
      // UX2-09: 「表示中の週」= カレンダーで現在開いている週（今日起点の1週間分とは独立）
      case 'currentWeek': {
        const currentWeekEnd = new Date(weekStart);
        currentWeekEnd.setDate(currentWeekEnd.getDate() + 6);
        return {
          startDate: formatLocalDate(weekStart),
          endDate: formatLocalDate(currentWeekEnd),
          mealTypes: ['breakfast', 'lunch', 'dinner'] as const,
        };
      }
      default:
        return {
          startDate: todayStr,
          endDate: todayStr,
          mealTypes: ['breakfast', 'lunch', 'dinner'] as const,
        };
    }
  }, [shoppingRange, weekStart]);

  // Regenerate shopping list from menu (非同期版)
  const regenerateShoppingList = async () => {
    if (isRegeneratingShoppingList) return;
    // #73 #91: 献立データが存在しない場合はサイレント失敗を防ぎ、メッセージを表示して終了
    if (!currentPlan || currentPlan.days.every(d => !d.meals?.length)) {
      setSuccessMessage({
        title: '献立がありません',
        message: 'この週には献立データがありません。先に献立を生成してください。',
        // #1050 round-2 (E, cheap): 成功でも失敗でもない案内のため type:'info' 化（UX2-01 の設計整合）
        type: 'info',
      });
      setActiveModal(null);
      return;
    }
    // 買い物リストの作成は、献立の料理名・食材を AI に送って整理する。未同意なら同意画面を出し、「同意しない」なら作らない
    if ((await ensureAiConsent()) === "declined") return;
    setIsRegeneratingShoppingList(true);
    setShoppingListProgress({ phase: 'starting', message: '開始中...', percentage: 0 });

    // 範囲を計算
    const dateRange = calculateDateRange();

    // #91: 選択した日付範囲に献立データがあるか確認
    const hasMenuInRange = currentPlan.days.some(d => {
      if (!d.meals?.length) return false;
      return d.dayDate >= dateRange.startDate && d.dayDate <= dateRange.endDate;
    });
    if (!hasMenuInRange) {
      setSuccessMessage({
        title: '献立がありません',
        message: 'この期間には献立データがありません。先に献立を生成してください。',
        // #1050 round-2 (E, cheap): 成功でも失敗でもない案内のため type:'info' 化（UX2-01 の設計整合）
        type: 'info',
      });
      setIsRegeneratingShoppingList(false);
      setShoppingListProgress(null);
      setActiveModal(null);
      return;
    }
    
    // 送信の間は書き込みの窓を開ける (#2206 G1。W-45。完了の待ちは窓の外の監視 subscribeToShoppingListRequest)
    const endWrite = receiver.beginWrite();
    try {
      const res = await aiFetch(`/api/shopping-list/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          mealTypes: dateRange.mealTypes,
        })
      });

      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内するので、エラーの画面は出さない
      if (await isAiConsentRequiredResponse(res)) {
        setIsRegeneratingShoppingList(false);
        setShoppingListProgress(null);
        return;
      }
      
      if (res.ok) {
        const { requestId } = await res.json();
        setShoppingListRequestId(requestId);
        
        // localStorageに保存（リロード時復元用）
        safeLocalStorageSetItem('shoppingListRegenerating', JSON.stringify({
          requestId,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          timestamp: Date.now(),
        }));
        
        // 購読開始
        subscribeToShoppingListRequest(requestId);
      } else {
        const err = await res.json();
        throw new Error(err.error || '再生成に失敗しました');
      }
    } catch (e: any) {
      // #1050 round-2 (UX2-02残): alert() ではなく完了モーダル(type:'error')に集約し、
      // 直前の呼び出しをそのまま再実行できる「もう一度試す」を付ける
      // （calculateDateRange/currentPlan は関数内で毎回読み直すため再実行は安全）。
      setSuccessMessage({
        title: '買い物リストの再生成に失敗しました',
        message: e.message || '再生成に失敗しました。もう一度お試しください。',
        type: 'error',
        onRetry: () => regenerateShoppingList(),
      });
      setIsRegeneratingShoppingList(false);
      setShoppingListProgress(null);
      localStorage.removeItem('shoppingListRegenerating');
    } finally {
      endWrite();
    }
  };

  // Toggle shopping item variant (tap to switch display unit)
  // 楽観的更新: 即座にUIを更新し、裏でAPI呼び出し
  const toggleShoppingVariant = (itemId: string, item: ShoppingListItem) => {
    if (!item.quantityVariants || item.quantityVariants.length <= 1) return;
    
    const nextIndex = (item.selectedVariantIndex + 1) % item.quantityVariants.length;
    const newQuantity = item.quantityVariants[nextIndex]?.display || item.quantity;
    
    // 即座にUIを更新（楽観的更新）
    const endWrite = receiver.beginWrite();
    setShoppingList(useShoppingStore.getState().shoppingList.map(i =>
      i.id === itemId
        ? { ...i, selectedVariantIndex: nextIndex, quantity: newQuantity }
        : i
    ));

    // 裏でAPIを呼び出し（永続化）- レスポンスを待たない
    fetch(`/api/shopping-list/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedVariantIndex: nextIndex })
    }).then(res => {
      if (!res.ok) throw new Error('Update failed');
    }).catch(e => {
      console.error('Failed to save variant change:', e);
      // エラー時はロールバック
      setShoppingList(useShoppingStore.getState().shoppingList.map(i =>
        i.id === itemId
          ? { ...i, selectedVariantIndex: item.selectedVariantIndex, quantity: item.quantity }
          : i
      ));
      alert('更新に失敗しました');
    }).finally(() => {
      endWrite();
    });
  };

  // お気に入りトグル (楽観的更新 + 失敗時ロールバック)。保存は料理の写しを POST、解除は id で DELETE (#2011)。
  // 応答は押した時点のモーダルの回がまだ続いているときだけ反映する (閉じた・別の料理を開いたあとの応答は捨てる。alert も出さない)
  const handleToggleFavorite = async () => {
    if (!selectedRecipe || isFavoriteLoading) return;
    const session = favoriteSessionRef.current;
    const isCurrentSession = () => favoriteSessionRef.current === session;
    const prev = isFavorite;
    setIsFavorite(!prev);
    setIsFavoriteLoading(true);
    // ♥ の DELETE・POST は書き込みの窓の中 (#2206 G1。W-47・W-48。窓は押した時点の楽観的な表示のあと、finally の最後に閉じる)
    const endWrite = receiver.beginWrite();
    try {
      if (prev) {
        if (!favoriteId) { setIsFavorite(prev); return; }
        const res = await fetch(`/api/favorites/${encodeURIComponent(favoriteId)}`, { method: 'DELETE' });
        if (!isCurrentSession()) return;
        // 404 = もう消えている。どちらも「未保存」が正しい状態
        if (res.ok || res.status === 404) { setFavoriteId(null); } else { setIsFavorite(prev); }
        return;
      }
      const dish = (selectedRecipeData?.dishes as unknown[] | undefined)?.[0];
      const body = {
        dish: dishSnapshotFromMenuDish(dish && typeof dish === 'object' ? (dish as Record<string, unknown>) : {}, selectedRecipe),
        source_planned_meal_id: typeof selectedRecipeData?.plannedMealId === 'string' ? selectedRecipeData.plannedMealId : null,
      };
      const res = await fetch('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!isCurrentSession()) return;
      if (res.ok) {
        const data = (await res.json()) as { favorite?: { id?: string } };
        if (!isCurrentSession()) return;
        setFavoriteId(typeof data.favorite?.id === 'string' ? data.favorite.id : null);
      } else {
        setIsFavorite(prev);
        // 409 (上限) と 400 (内容) は理由の文を見せる (本文の error は日本語の固定の文)
        if (res.status === 409 || res.status === 400) {
          const err = (await res.json().catch(() => null)) as { error?: string } | null;
          if (isCurrentSession() && err?.error) alert(err.error);
        }
      }
    } catch {
      if (isCurrentSession()) setIsFavorite(prev);
    } finally {
      if (isCurrentSession()) setIsFavoriteLoading(false);
      endWrite();
    }
  };

  // 料理の材料を買い物リストに追加する (#2023)。材料の集め方 (dishes の各料理 + 直下の ingredients・重複の除去) と
  // 名前と分量への分け方 (1 行の文字列と構造の形の両方。ingredientInputsOf) は _state/recipeShoppingList.ts
  const addRecipeToShoppingList = async () => {
    if (!selectedRecipeData || !currentPlan) return;
    // 買い物リストの書き込み (#2201 U2。追加の前に読んだ取り直しの応答で、足した品目を消さない)。終わったら (失敗でも) 印を下ろす
    const endWrite = receiver.beginWrite();
    const result = await addRecipeIngredientsToShoppingList({
      recipeData: selectedRecipeData,
      shoppingListId: activeShoppingList?.id,
    }).finally(endWrite);
    if (result.kind === 'no-ingredients') {
      setSuccessMessage({ title: RECIPE_SHOPPING_NO_INGREDIENTS_TITLE, message: RECIPE_SHOPPING_NO_INGREDIENTS_MESSAGE });
      return;
    }
    if (result.kind === 'failed') {
      alert(result.alertMessage);
      return;
    }
    setShoppingList([...useShoppingStore.getState().shoppingList, ...result.items]);
    setActiveModal(null);
    setSuccessMessage({ title: RECIPE_SHOPPING_ADDED_TITLE, message: recipeShoppingAddedMessage(result.count) });
  };

  // Generate weekly menu with AI
  const handleGenerateWeekly = async () => {
    // 「同意しない」なら献立の生成を依頼しない (好み・アレルギーなどを AI に送らない)
    if ((await ensureAiConsent()) === "declined") return;
    const weekStartDate = formatLocalDate(weekStart);
    // 書き込みの窓はモーダルを閉じる前に開け、依頼 (POST) の応答まで閉じない (#2206 G1。W-49。モバイルの読み込み直しが、
    // モーダルを閉じた瞬間に読み込み直して送ったばかりの POST を取り消さない)
    const endWrite = receiver.beginWrite();
    setIsGenerating(true);
    setActiveModal(null); // モーダルを閉じて一覧画面に戻る

    try {
      const { aiChatInput, selectedConditions } = useFormDraftStore.getState();
      const preferences = {
        useFridgeFirst: selectedConditions.includes('冷蔵庫の食材を優先'),
        quickMeals: selectedConditions.includes('時短メニュー中心'),
        japaneseStyle: selectedConditions.includes('和食多め'),
        healthy: selectedConditions.includes('ヘルシーに'),
      };

      const response = await aiFetch("/api/ai/menu/weekly/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: weekDates[0]?.dateStr,
          note: aiChatInput + (selectedConditions.length > 0 ? `\n【条件】${selectedConditions.join('、')}` : ''),
          preferences,
        }),
      });
      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内するので、エラーは出さない
      if (await isAiConsentRequiredResponse(response)) {
        setIsGenerating(false);
        return;
      }
      if (!response.ok) throw new Error("生成リクエストに失敗しました");
      
      const { requestId } = await response.json();
      
      // localStorageに生成中状態を保存（画面遷移しても維持するため）
      safeLocalStorageSetItem('weeklyMenuGenerating', JSON.stringify({
        weekStartDate,
        timestamp: Date.now(),
        requestId,
      }));
      
      setSelectedConditions([]);
      setAiChatInput("");
      
      // DBベースのポーリングを開始
      // 旧来の週の生成 (/api/ai/menu/weekly/request) に究極モードは無い (#1597)
      if (requestId) {
        subscribeToRequestStatus(weekStartDate, requestId, false);
      } else {
        // requestIdがない場合は旧方式でポーリング
        // レガシーポーリングは廃止（requestIdがある場合のみRealtime監視）
        console.warn('No requestId returned, cannot subscribe to Realtime');
      }
      
    } catch (error: any) {
      alert(error.message || "エラーが発生しました");
      setIsGenerating(false);
      localStorage.removeItem('weeklyMenuGenerating');
    } finally {
      endWrite();
    }
  };
  

  // Generate single meal with AI
  const handleGenerateSingleMeal = async () => {
    const { addMealKey, addMealDayIndex, selectedConditions, aiChatInput } = useFormDraftStore.getState();
    if (!addMealKey) return;

    // 「同意しない」なら生成を依頼しない
    if ((await ensureAiConsent()) === "declined") return;

    const dayDate = weekDates[addMealDayIndex]?.dateStr;

    // 生成開始前の該当食事タイプの数を記録
    const currentDay = currentPlan?.days?.find((d: any) => d.dayDate === dayDate);
    const initialMealCount = currentDay?.meals?.filter((m: any) => m.mealType === addMealKey).length || 0;

    setGeneratingMeal({ dayIndex: addMealDayIndex, mealType: addMealKey });
    setActiveModal(null);

    try {
      const preferences: Record<string, boolean> = {};
      selectedConditions.forEach((c: string) => {
        if (c === '冷蔵庫の食材を優先') preferences.useFridgeFirst = true;
        if (c === '時短メニュー中心') preferences.quickMeals = true;
        if (c === '和食多め') preferences.japaneseStyle = true;
        if (c === 'ヘルシーに') preferences.healthy = true;
      });
      
      // 送信の間だけ書き込みの窓を開ける (#2206 G1。W-50。生成の待ち・監視は窓の外)
      const endWrite = receiver.beginWrite();
      let res: Response;
      try {
        res = await aiFetch('/api/ai/menu/meal/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dayDate,
            mealType: addMealKey,
            preferences,
            note: aiChatInput
          })
        });
      } finally {
        endWrite();
      }

      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内するので、エラーは出さない
      if (await isAiConsentRequiredResponse(res)) {
        setGeneratingMeal(null);
        return;
      }

      if (res.ok) {
        const { requestId } = await res.json();
        
        // localStorageに生成中状態を保存（リロードしても維持するため）
        safeLocalStorageSetItem('singleMealGenerating', JSON.stringify({
          dayIndex: addMealDayIndex,
          mealType: addMealKey,
          dayDate,
          initialCount: initialMealCount,
          timestamp: Date.now(),
          requestId // DBのリクエストIDを保存
        }));
        
        setSelectedConditions([]);
        setAiChatInput("");
        setSelectedDayIndex(addMealDayIndex);
        
        // DBベースのポーリングを開始
        // 1 食の生成 (/api/ai/menu/meal/generate) に究極モードは無い (#1597)
        if (requestId) {
          subscribeToRequestStatus(formatLocalDate(weekStart), requestId, false);
        } else {
          // requestIdがない場合はRealtime監視できない
          console.warn('No requestId returned, cannot subscribe to Realtime');
        }
      } else {
        const err = await res.json();
        // #1050 round-2 (UX2-02残): alert() ではなく完了モーダル(type:'error')に集約。
        // addMealKey/addMealDayIndex/selectedConditions/aiChatInput は失敗時にクリアされないため
        // handleGenerateSingleMeal を再実行するだけで安全にリトライできる。
        setSuccessMessage({
          title: '食事の生成に失敗しました',
          message: err.error || '生成に失敗しました。もう一度お試しください。',
          type: 'error',
          onRetry: () => handleGenerateSingleMeal(),
        });
        setGeneratingMeal(null);
        localStorage.removeItem('singleMealGenerating');
      }
    } catch (error) {
      console.error('Meal generation error:', error);
      setSuccessMessage({
        title: '食事の生成に失敗しました',
        message: 'エラーが発生しました。もう一度お試しください。',
        type: 'error',
        onRetry: () => handleGenerateSingleMeal(),
      });
      setGeneratingMeal(null);
      localStorage.removeItem('singleMealGenerating');
    }
  };

  // Add meal with specific mode
  const handleAddMealWithMode = async (mode: MealMode) => {
    const { addMealKey, addMealDayIndex, selectedCatalogProduct } = useFormDraftStore.getState();
    if (!addMealKey) return;

    const dayDate = weekDates[addMealDayIndex]?.dateStr;
    const defaultNames: Record<MealMode, string> = {
      cook: '自炊メニュー',
      quick: '時短メニュー',
      buy: 'コンビニ・惣菜',
      out: '外食',
      skip: 'スキップ',
      ai_creative: 'AI献立',
    };
    const catalogProduct = mode === 'buy' || mode === 'out' ? selectedCatalogProduct : null;
    // 献立の書き込み (#2201 U2。追加の前に読んだ取り直しの応答で、足した食事を消さない)
    const endWrite = receiver.beginWrite();
    
    try {
      const res = await fetch('/api/meal-plans/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dayDate,
          mealType: addMealKey,
          mode,
          dishName: catalogProduct?.name || defaultNames[mode],
          isSimple: true,
          catalogProductId: catalogProduct?.id ?? null,
          sourceType: catalogProduct ? 'catalog_product' : 'manual',
        })
      });
      
      if (res.ok) {
        const created = await res.json().catch(() => null);
        const newMealId: string | undefined = created?.meal?.id;

        // Refresh data: 表示中の週をページの読み取りで読み直して置く (#2206 G1。先に始めた読み込み・取り直しの古い応答で戻されない)
        /** 追加のあとに読み直した週 (読めなければ null)。作った食事はこの応答から取る (UX2-32) */
        let addedWeek: MealPlansWeekResponse | null = null;
        await receiver.read({}, async (read) => {
          addedWeek = await readDisplayedWeek(read, WEEK_PLACEMENT_AFTER_ADD);
        });
        const createdMeal = newMealId ? plannedMealOf(addedWeek, newMealId) : undefined;
        setSelectedCatalogProduct(null);
        setCatalogQuery('');
        setCatalogResults([]);
        setCatalogSearchError('');

        // UX2-32: 自炊追加は「自炊メニュー」のダミー名のまま確定してしまうため、
        // 追加直後に手動編集（命名）ステップを開く
        if (mode === 'cook' && createdMeal) {
          openManualEdit(createdMeal);
        } else {
          setActiveModal(null);
        }
      }
    } catch (e) {
      alert('追加に失敗しました');
    } finally {
      endWrite();
    }
  };

  // Edit meal (change button) - now opens regenerate modal
  const openRegenerateMeal = (meal: PlannedMeal) => {
    setRegeneratingMeal(meal);
    setSelectedConditions([]);
    setAiChatInput("");
    setActiveModal('regenerateMeal');
  };

  // Regenerate meal with AI
  const handleRegenerateMeal = async () => {
    if (!regeneratingMeal || !currentPlan) return;

    // 「同意しない」なら再生成を依頼しない
    if ((await ensureAiConsent()) === "declined") return;
    
    setIsRegenerating(true);
    setRegeneratingMealId(regeneratingMeal.id);

    try {
      const { selectedConditions, aiChatInput } = useFormDraftStore.getState();
      const preferences: Record<string, boolean> = {};
      selectedConditions.forEach((c: string) => {
        if (c === '冷蔵庫の食材を優先') preferences.useFridgeFirst = true;
        if (c === '時短メニュー中心') preferences.quickMeals = true;
        if (c === '和食多め') preferences.japaneseStyle = true;
        if (c === 'ヘルシーに') preferences.healthy = true;
      });
      
      // Find the day for this meal
      const day = currentPlan.days?.find(d => 
        d.meals?.some(m => m.id === regeneratingMeal.id)
      );
      
      if (!day) {
        alert('日付が見つかりません');
        setIsRegenerating(false);
        setRegeneratingMealId(null);
        return;
      }
      
      // 送信の間だけ書き込みの窓を開ける (#2206 G1。W-52。再生成の待ち・監視は窓の外)
      const endWrite = receiver.beginWrite();
      let res: Response;
      try {
        res = await aiFetch('/api/ai/menu/meal/regenerate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mealId: regeneratingMeal.id,
            dayDate: day.dayDate,
            mealType: regeneratingMeal.mealType,
            preferences,
            note: aiChatInput
          })
        });
      } finally {
        endWrite();
      }

      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内するので、エラーは出さない
      if (await isAiConsentRequiredResponse(res)) {
        setIsRegenerating(false);
        setRegeneratingMealId(null);
        return;
      }
      
      if (res.ok) {
        const { requestId } = await res.json();
        
        setActiveModal(null);
        setRegeneratingMeal(null);
        
        // DBベースのポーリングを開始
        if (requestId) {
          subscribeToRegenerateStatus(requestId, formatLocalDate(weekStart));
        } else {
          // requestIdがない場合はRealtime監視できない
          console.warn('No requestId returned for regeneration');
        }
      } else {
        const err = await res.json();
        // #1050 round-2 (UX2-02残): alert() ではなく完了モーダル(type:'error')に集約。
        // この時点では regeneratingMeal はまだクリアされておらず（クリアは成功時のみ）、
        // モーダルも開いたままのため handleRegenerateMeal を再実行するだけで安全にリトライできる。
        setSuccessMessage({
          title: '食事の再生成に失敗しました',
          message: err.error || '再生成に失敗しました。もう一度お試しください。',
          type: 'error',
          onRetry: () => handleRegenerateMeal(),
        });
        setIsRegenerating(false);
        setRegeneratingMealId(null);
      }
    } catch (error) {
      console.error('Regenerate error:', error);
      setSuccessMessage({
        title: '食事の再生成に失敗しました',
        message: 'エラーが発生しました。もう一度お試しください。',
        type: 'error',
        onRetry: () => handleRegenerateMeal(),
      });
      setIsRegenerating(false);
      setRegeneratingMealId(null);
    }
  };
  
  // 再生成の Realtime のチャンネルを外す (#1657)。週の生成の監視 (realtimeChannelRef・requestWatchRef) には触らない
  const cleanupRegenerateRealtime = useCallback(() => {
    if (regenerateChannelRef.current) {
      supabaseRef.current.removeChannel(regenerateChannelRef.current);
      regenerateChannelRef.current = null;
    }
  }, []);

  // 再生成のRealtime監視
  // #1033 F1b-06: 週間生成側 subscribeToRequestStatus と同様に、Realtime切断時のフォールバックとして
  // 3秒ポーリング + 5分の上限タイムアウトを併用する（Realtime単独だとスピナーが取り残される）
  const subscribeToRegenerateStatus = useCallback((requestId: string, weekStartDate: string) => {
    // 既存のサブスクリプション/ポーリング/タイムアウトをクリーンアップ
    // (再生成のチャンネルだけを外す。週の生成の監視 (cleanupRealtime) には触らない。#1657)
    cleanupRegenerateRealtime();
    // 前の再生成の監視の印を下ろし、この監視の印を立てる (#1657)。前の監視のポーリングの、fetch を待っていた tick が、
    // 戻ってからこの監視のポーリング・タイムアウトを止めたり、前の週の献立を置いたりしないように
    if (regenerateWatchRef.current) regenerateWatchRef.current.active = false;
    const regenerateWatch = { active: true };
    regenerateWatchRef.current = regenerateWatch;
    if (regeneratePollingIntervalRef.current) {
      clearInterval(regeneratePollingIntervalRef.current);
      regeneratePollingIntervalRef.current = null;
    }
    if (regenerateTimeoutRef.current) {
      clearTimeout(regenerateTimeoutRef.current);
      regenerateTimeoutRef.current = null;
    }

    console.log('📡 Subscribing to Realtime for regenerate requestId:', requestId);

    // Realtime/ポーリング/タイムアウトのいずれかが先に解決したら他を止めるための共有フラグ
    const resolvedRef = { current: false };

    const finishRegenerate = async (status: 'completed' | 'failed', errorMessage?: string) => {
      // 次の再生成の監視が始まったあと (印が下りたあと) は、この監視の終わりを処理しない (#1657)
      if (!regenerateWatch.active) return;
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      cleanupRegenerateRealtime();
      if (regeneratePollingIntervalRef.current) {
        clearInterval(regeneratePollingIntervalRef.current);
        regeneratePollingIntervalRef.current = null;
      }
      if (regenerateTimeoutRef.current) {
        clearTimeout(regenerateTimeoutRef.current);
        regenerateTimeoutRef.current = null;
      }

      if (status === 'completed') {
        // 完了したら献立を再取得
        console.log('✅ Regeneration completed, fetching meal plan...');
        try {
          // 再生成した週を読み直して置く (ページの読み取りの place。#2206 G1。読む間に監視が終わっていたら置かない)
          await reloadWeekAfterCompletion(weekStartDate, () => regenerateWatch.active);
          // 献立を読む間に次の再生成の監視が始まっていたら、この監視の結果 (再生成中の表示の片づけ) は置かない (#1657)
          if (!regenerateWatch.active) return;
        } catch (e) {
          console.error('❌ Failed to fetch meal plan after regenerate:', e);
        }
        if (!regenerateWatch.active) return;
        setIsRegenerating(false);
        setRegeneratingMealId(null);
      } else {
        console.log('❌ Regeneration failed');
        setIsRegenerating(false);
        setRegeneratingMealId(null);
        // T15 (#1154): サーバーが同意の判定で止めた (未同意) なら同意画面を出し、失敗のモーダルは出さない
        if (handleStoredAiConsentFailure(errorMessage)) return;
        // #1050 round-2 (UX2-02残): alert() ではなく完了モーダル(type:'error')に集約。
        // ここは Realtime/ポーリングで非同期に検知した失敗で、対象の regeneratingMeal は
        // 初回リクエスト成功時点で既にクリア済みのため、直前の呼び出しをそのまま安全に
        // 再実行する手段が無い。onRetry は付けず、対象の食事を再度タップして
        // 「再操作」できることが伝わる明確な文言にする（#1050 のリトライ方針の代替条項）。
        setSuccessMessage({
          title: '食事の再生成に失敗しました',
          message: errorMessage || '献立の再生成に失敗しました。対象の食事をもう一度タップしてお試しください。',
          type: 'error',
        });
      }
    };

    // 常にポーリングも開始（Realtimeの信頼性が低いため。既存の /status エンドポイントは
    // weekly_menu_requests を requestId で汎用的に参照するため regenerate リクエストにも使える）
    const pollRegenerate = async () => {
      if (!regenerateWatch.active) return;
      if (resolvedRef.current) return;
      try {
        const res = await fetch(`/api/ai/menu/weekly/status?requestId=${requestId}`);
        // fetch を待つ間に次の再生成の監視が始まっていたら、届いた応答では何もしない (#1657)
        if (!regenerateWatch.active) return;
        if (res.status === 401) {
          console.warn('[regenerate poll] Session expired (401). Stopping.');
          resolvedRef.current = true;
          cleanupRegenerateRealtime();
          if (regeneratePollingIntervalRef.current) {
            clearInterval(regeneratePollingIntervalRef.current);
            regeneratePollingIntervalRef.current = null;
          }
          if (regenerateTimeoutRef.current) {
            clearTimeout(regenerateTimeoutRef.current);
            regenerateTimeoutRef.current = null;
          }
          setIsRegenerating(false);
          setRegeneratingMealId(null);
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- セッション切れ (401)。ページごと移り、middleware に Cookie とログインの状態を判定し直させる (#142)
          window.location.href = '/login';
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (!regenerateWatch.active) return;
        if (resolvedRef.current) return;
        // not_found = 本人の行が無い (消えた)。以前は 5 分のタイムアウトまで確認を続けていた。失敗として止め、既定の失敗の文を出す (#1657)
        if (data.status === 'not_found') {
          await finishRegenerate('failed');
          return;
        }
        if (data.status === 'completed') {
          await finishRegenerate('completed');
        } else if (data.status === 'failed') {
          await finishRegenerate('failed', weeklyMenuRequestErrorMessageForDisplay(data.errorMessage || data.error_message) ?? undefined);
        }
      } catch (e) {
        console.error('Regenerate polling error:', e);
      }
    };
    pollRegenerate();
    regeneratePollingIntervalRef.current = setInterval(pollRegenerate, 3000);

    // 5分間 completed/failed を受信できなければタイムアウトとしてエラー表示（受入基準: 5分無応答でエラー表示）
    regenerateTimeoutRef.current = setTimeout(() => {
      if (!resolvedRef.current) {
        console.warn('⏱️ Regenerate timed out after 5 minutes with no response');
        finishRegenerate('failed', '献立の再生成がタイムアウトしました。もう一度お試しください。');
      }
    }, 5 * 60 * 1000);

    const channel = supabaseRef.current
      .channel(`regenerate-request-${requestId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'weekly_menu_requests',
          filter: `id=eq.${requestId}`,
        },
        async (payload) => {
          console.log('📡 Realtime regenerate update received:', payload.new);
          const newData = payload.new as { status: string; error_message?: string | null };
          const newStatus = newData.status;

          if (newStatus === 'completed') {
            await finishRegenerate('completed');
          } else if (newStatus === 'failed') {
            // 行の error_message は、こちらで書いた定型の文だけをそのまま出す (useV4MenuGeneration と同じ絞り込み。#1576)
            await finishRegenerate('failed', weeklyMenuRequestErrorMessageForDisplay(newData.error_message) ?? undefined);
          }
        }
      )
      .subscribe((status) => {
        console.log('📡 Realtime regenerate subscription status:', status);
      });

    regenerateChannelRef.current = channel;
  }, [cleanupRegenerateRealtime, reloadWeekAfterCompletion]);

  // Edit meal (legacy - keep for simple edits)
  const openEditMeal = (meal: PlannedMeal) => {
    setEditingMeal(meal);
    setEditMealName(meal.dishName);
    setEditMealMode(meal.mode || 'cook');
    setActiveModal('editMeal');
  };

  const saveEditMeal = async () => {
    if (!editingMeal || !currentPlan) return;

    const { editMealName, editMealMode } = useFormDraftStore.getState();
    const editingMealId = editingMeal.id;

    // 楽観的UI更新（失敗時にロールバックするため元の状態を保持）
    const previousPlan = currentPlan;
    const updatedDays = currentPlan.days?.map(day => ({
      ...day,
      meals: day.meals?.map(m =>
        m.id === editingMealId
          ? { ...m, dishName: editMealName, mode: editMealMode }
          : m
      )
    }));
    const endWrite = receiver.beginWrite();
    setCurrentPlan({ ...currentPlan, days: updatedDays });
    setActiveModal(null);
    setEditingMeal(null);

    try {
      const res = await fetch(`/api/meal-plans/meals/${editingMealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dishName: editMealName,
          mode: editMealMode
        })
      });
      if (!res.ok) throw new Error('Update failed');
    } catch (e) {
      // 失敗したら元に戻す
      setCurrentPlan(previousPlan);
      alert('更新に失敗しました');
    } finally {
      endWrite();
    }
  };

  // Open manual edit modal
  const openManualEdit = (meal: PlannedMeal) => {
    setManualEditMeal(meal);
    // dishes配列形式に変換
    const existingDishes: DishDetail[] = Array.isArray(meal.dishes)
      ? meal.dishes
      : meal.dishes
        ? Object.values(meal.dishes).filter(Boolean) as DishDetail[]
        : [{ name: meal.dishName || '', calories_kcal: meal.caloriesKcal || 0, role: 'main' }];
    setManualDishes(existingDishes.length > 0 ? existingDishes : [{ name: '', calories_kcal: 0, role: 'main' }]);
    setManualMode(meal.mode || 'cook');
    setSelectedCatalogProduct(meal.catalogProduct || null);
    setCatalogQuery(meal.catalogProduct?.name || '');
    setCatalogResults([]);
    setCatalogSearchError('');
    setActiveModal('manualEdit');
  };

  // Open delete confirmation modal
  const openDeleteConfirm = (meal: PlannedMeal) => {
    setDeletingMeal(meal);
    setActiveModal('confirmDelete');
  };

  // Delete meal
  const confirmDeleteMeal = async () => {
    if (!deletingMeal) return;
    
    setIsDeleting(true);
    // 献立の書き込み (#2201 U2。削除の前に読んだ取り直しの応答で、消した食事・月のカレンダーの印を戻さない)
    const endWrite = receiver.beginWrite();
    try {
      const res = await fetch(`/api/meal-plans/meals/${deletingMeal.id}`, {
        method: 'DELETE',
      });
      
      if (res.ok) {
        // UIを更新
        setExpandedMealId(null);
        setActiveModal(null);
        setDeletingMeal(null);
        // データを再取得 (ページの読み取り。献立の無くなった日の月のカレンダーの印も消す。#2206 G1。S-26)
        await receiver.read({}, (read) => readDisplayedWeek(read, WEEK_PLACEMENT_AFTER_REMOVE));
      } else {
        alert('削除に失敗しました');
      }
    } catch (error) {
      console.error('Delete meal error:', error);
      alert('削除に失敗しました');
    } finally {
      setIsDeleting(false);
      endWrite();
    }
  };

  // Add dish to manual edit
  const addManualDish = () => {
    setSelectedCatalogProduct(null);
    setManualDishes([...useFormDraftStore.getState().manualDishes, { name: '', calories_kcal: 0, role: 'side' }]);
  };

  // Remove dish from manual edit
  const removeManualDish = (index: number) => {
    setSelectedCatalogProduct(null);
    setManualDishes(useFormDraftStore.getState().manualDishes.filter((_, i) => i !== index));
  };

  // Update dish in manual edit
  const updateManualDish = (index: number, field: keyof DishDetail, value: string | number) => {
    setSelectedCatalogProduct(null);
    setManualDishes(useFormDraftStore.getState().manualDishes.map((dish, i) =>
      i === index ? { ...dish, [field]: value } : dish
    ));
  };

  const applyCatalogProductToManualEdit = (product: CatalogProductSummary) => {
    setSelectedCatalogProduct(product);
    const prevManualMode = useFormDraftStore.getState().manualMode;
    setManualMode(prevManualMode === 'out' ? 'out' : 'buy');
    setCatalogQuery(product.name);
    setManualDishes([
      {
        name: product.name,
        role: 'main',
        calories_kcal: product.caloriesKcal ?? 0,
        protein_g: product.proteinG ?? undefined,
        fat_g: product.fatG ?? undefined,
        carbs_g: product.carbsG ?? undefined,
        sodium_g: product.sodiumG ?? undefined,
        fiber_g: product.fiberG ?? undefined,
        sugar_g: product.sugarG ?? undefined,
      },
    ]);
  };

  // Save manual edit
  const saveManualEdit = async () => {
    if (!manualEditMeal || !currentPlan) return;

    const { manualDishes, manualMode, selectedCatalogProduct } = useFormDraftStore.getState();
    const validDishes = manualDishes.filter(d => d.name.trim());
    if (validDishes.length === 0) {
      alert('少なくとも1つの料理名を入力してください');
      return;
    }

    const totalCal = validDishes.reduce((sum, d) => sum + (d.calories_kcal ?? d.cal ?? 0), 0);
    const dishName = validDishes.map(d => d.name).join('、');
    // 献立の書き込み (#2201 U2。変更の前に読んだ取り直しの応答で、変えた食事を戻さない)
    const endWrite = receiver.beginWrite();

    try {
      const patchRes = await fetch(`/api/meal-plans/meals/${manualEditMeal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dishName,
          mode: manualMode,
          dishes: validDishes,
          isSimple: validDishes.length === 1,
          caloriesKcal: totalCal > 0 ? totalCal : null,
          catalogProductId: selectedCatalogProduct?.id ?? null,
          sourceType: selectedCatalogProduct ? 'catalog_product' : 'manual',
        })
      });
      // #1205: API が入力を拒否した（合計 kcal が範囲外など）ときは、保存できたように閉じずにメッセージを出す
      if (!patchRes.ok) {
        const payload = await patchRes.json().catch(() => null);
        alert(typeof payload?.error === 'string' ? payload.error : '更新に失敗しました');
        return;
      }

      // 表示中の週をページの読み取りで読み直して置く (#2206 G1。献立の無くなった日の月のカレンダーの印も消す)
      await receiver.read({}, (read) => readDisplayedWeek(read, WEEK_PLACEMENT_AFTER_REMOVE));

      setActiveModal(null);
      setManualEditMeal(null);
      setSelectedCatalogProduct(null);
      setCatalogQuery('');
      setCatalogResults([]);
    } catch (e) {
      alert('更新に失敗しました');
    } finally {
      endWrite();
    }
  };

  // Open photo edit modal
  // 開くたびに新しい回 (photoEditSession) にし、写真を空にする。手で変更のモーダルからの「写真から入力」もここを通る (#2047:
  // 解析の結果を待つあいだに開き直したモーダルを、待ち始めたときのモーダルと見分け、送った写真を新しい回に持ち越さない)
  const openPhotoEdit = (meal: PlannedMeal) => {
    dispatchModal({ type: 'MODAL_OPEN_PHOTO_EDIT', payload: meal });
    setPhotoFiles([]);
    setPhotoPreviews([]);
  };

  // Handle photo selection（複数枚対応）
  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const newFiles = Array.from(files);
      setPhotoFiles([...useFormDraftStore.getState().photoFiles, ...newFiles]);

      // プレビュー画像を生成
      newFiles.forEach(file => {
        const reader = new FileReader();
        reader.onloadend = () => {
          setPhotoPreviews([...useFormDraftStore.getState().photoPreviews, reader.result as string]);
        };
        reader.readAsDataURL(file);
      });
    }
  };

  // 写真を削除
  const removePhoto = (index: number) => {
    setPhotoFiles(useFormDraftStore.getState().photoFiles.filter((_, i) => i !== index));
    setPhotoPreviews(useFormDraftStore.getState().photoPreviews.filter((_, i) => i !== index));
  };

  // Analyze photo with AI（複数枚対応）
  const analyzePhotoWithAI = async () => {
    const { photoFiles } = useFormDraftStore.getState();
    if (photoFiles.length === 0 || !photoEditMeal || !currentPlan) return;
    // 写真の解析は一度に 1 つ (#2047)。前のモーダルで送った写真の結果を待っているあいだは始めない
    // (モーダルの解析のボタンも押せない。PhotoEditModal の isOtherPhotoAnalyzing)
    if (isAnalyzingPhoto) return;

    // 解析を頼むモーダルの回。待ち終えたとき、モーダルがまだこの回なら閉じる (開き直したモーダルは閉じない)
    const session = photoEditSession;
    startPhotoAnalyze(session);
    const mealId = photoEditMeal.id;
    const targetDate = formatLocalDate(weekStart);
    const endDate = addDaysStr(targetDate, 6);
    /**
     * 読んだ週の献立 → その読み取りのキャッシュの書き込み口 (読み始める前に取る。#2201 U1。weekDataCache)。結果を待つ読み直しの
     * 応答のうち、待ち終えたときの応答 (outcome.week) を、その応答の読み取りの書き込み口でキャッシュに書く
     */
    const weekCacheWriters = new WeakMap<MealPlansWeekResponse, WeekDataCacheWriter<WeekCacheData>>();
    /** 解析を頼んだ週の献立を読む。読めなければ null */
    const fetchTargetWeek = async (): Promise<MealPlansWeekResponse | null> => {
      const writeWeekCache = weekDataCache.current.beginWrite(targetDate);
      const weekRes = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
      if (!weekRes.ok) return null;
      const week: MealPlansWeekResponse = await weekRes.json();
      weekCacheWriters.set(week, writeWeekCache);
      return week;
    };

    try {
      // 「同意しない」なら写真を AI に送らない
      if ((await ensureAiConsent()) === "declined") {
        endPhotoAnalyze();
        return;
      }
      // 複数枚の写真をBase64に変換して送信
      const imageDataArray = await Promise.all(photoFiles.map(async (file) => {
        return new Promise<{ base64: string; mimeType: string }>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            resolve({
              base64: result.split(',')[1],
              mimeType: file.type
            });
          };
          reader.readAsDataURL(file);
        });
      }));
      
      // 解析を頼む前の献立を控える (結果が書かれたかを比べる元。#2047)。画面の献立は古いことがある (前の解析の結果が、
      // 待つのをやめたあとに書かれた など) ので、サーバーから読み直したものを使う。読めなければ画面の献立を使う
      const baselineWeek = await fetchTargetWeek().catch(() => null);
      const baseline = photoResultBaseline(findMealInWeek(baselineWeek, mealId) ?? photoEditMeal);

      // 書き込みの窓は解析を頼む POST の間だけ (#2206 G1。W-56。結果の待ち waitForMealPhotoResult は窓の外)
      const endWrite = receiver.beginWrite();
      let res: Response;
      try {
        res = await aiFetch('/api/ai/analyze-meal-photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            images: imageDataArray,
            mealId,
            mealType: photoEditMeal.mealType,
          })
        });
      } finally {
        endWrite();
      }

      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内するので、エラーは出さない (写真は残す)
      if (await isAiConsentRequiredResponse(res)) {
        endPhotoAnalyze();
        return;
      }
      
      if (res.ok) {
        // mealId つきの解析は非同期 (#2047): route の 200 は「Edge が背景で解析を始めた」で、解析 (10〜20 秒) はまだ終わっていない。
        // 結果が献立に書かれたことが分かるまで、上限つきで読み直す (src/lib/meal-photo-result-watch.ts)。
        // 待っているあいだは、写真から入力のモーダルを開いたまま「AIが解析中...」を出す (食事の記録の画面などの写真の入力と同じく、
        // 解析が終わるまでその場で待つ)。利用者がモーダルを閉じても読み直しは続け、結果が書かれたら献立に置く。
        // 閉じたあとに開いた写真から入力のモーダル (別の献立・同じ献立の開き直し) は別の回なので「AIが解析中...」を出さず、
        // 写真は選べるが解析のボタンは待ち終えるまで押せない (解析は一度に 1 つ。photoEditAnalyzeState === 'other')
        if (photoResultWatchRef.current) photoResultWatchRef.current.active = false;
        const photoResultWatch = { active: true };
        photoResultWatchRef.current = photoResultWatch;

        const outcome = await waitForMealPhotoResult({
          mealId,
          baseline,
          fetchWeek: fetchTargetWeek,
          isActive: () => photoResultWatch.active,
        });
        // アンマウントで印が下りていたら、何も置かない
        if (outcome.status === 'cancelled' || !photoResultWatch.active) return;
        photoResultWatchRef.current = null;

        const week = outcome.week;
        const writeWeekCache = week ? weekCacheWriters.get(week) : undefined;
        if (week && writeWeekCache) {
          // 待ちが明けてから読み取りを始める (待っている間の取り直しが置いた献立より新しい世代で置く。待ちを読み取りに含めると、
          // 待ちの間の取り直しに追い越されて結果を置けない。#2206 G1。S-27)。キャッシュは解析を頼んだ週に、画面はいまもその週を
          // 出しているときだけ (applyWeekResponse)
          await receiver.read({}, (read) => {
            applyWeekResponse(read, targetDate, week, writeWeekCache, WEEK_PLACEMENT_COMPLETION);
          });
        }

        // 写真から入力のモーダルが、まだ解析を頼んだ回のものなら閉じる (開き直したモーダルは、同じ献立でも閉じない)。
        // 選んだ写真は、いまも送った写真のままのときだけ消す (解析中はそのモーダルの中で写真を足す・消すことができない (PhotoEditModal)。
        // 写真が変わっているのは、待っているあいだに利用者がモーダルを閉じた (onClose が消す)・開き直した (openPhotoEdit が消してから
        // 選ぶ) ときで、開き直したモーダルの写真は消さない)
        dispatchModal({ type: 'MODAL_CLOSE_PHOTO_EDIT_SESSION', payload: session });
        if (useFormDraftStore.getState().photoFiles === photoFiles) {
          setPhotoFiles([]);
          setPhotoPreviews([]);
        }
        endPhotoAnalyze();

        // 上限まで待っても結果が書かれなかった (解析が長い・失敗した・解析のあいだに献立が書かれて結果を捨てた #2041 の CAS) なら、
        // 黙って終えずにその旨を出す。閉じたら献立を読み直す (そのあいだに書かれていれば出る)
        if (outcome.status === 'timeout') {
          setSuccessMessage({
            title: PHOTO_RESULT_TIMEOUT_TITLE,
            message: PHOTO_RESULT_TIMEOUT_MESSAGE,
            type: 'info',
            refreshOnDismiss: true,
          });
        } else if (outcome.status === 'meal_missing') {
          setSuccessMessage({
            title: PHOTO_RESULT_MEAL_MISSING_TITLE,
            message: PHOTO_RESULT_MEAL_MISSING_MESSAGE,
            type: 'error',
          });
        }
      } else {
        const err = await res.json();
        // #1050 round-2 (UX2-02残): alert() ではなく完了モーダル(type:'error')に集約。
        // photoFiles/photoEditMeal は失敗時にクリアされず、写真編集モーダルも開いたままのため
        // analyzePhotoWithAI を再実行するだけで安全にリトライできる。
        setSuccessMessage({
          title: '写真解析に失敗しました',
          message: err.error || '解析に失敗しました。もう一度お試しください。',
          type: 'error',
          onRetry: () => analyzePhotoWithAI(),
        });
        endPhotoAnalyze();
      }
    } catch (error) {
      console.error('Photo analysis error:', error);
      setSuccessMessage({
        title: '写真解析に失敗しました',
        message: 'エラーが発生しました。もう一度お試しください。',
        type: 'error',
        onRetry: () => analyzePhotoWithAI(),
      });
      endPhotoAnalyze();
    }
  };

  const closeImageGenerateModal = (returnToManualEdit = true) => {
    setImageGenerateMeal(null);
    setImageGenerationPrompt('');
    setImageReferenceFiles([]);
    setImageReferencePreviews([]);
    if (imageGenerateInputRef.current) {
      imageGenerateInputRef.current.value = '';
    }
    setActiveModal(returnToManualEdit && manualEditMeal ? 'manualEdit' : null);
  };

  const openImageGenerate = () => {
    if (!manualEditMeal) return;

    const promptSource = useFormDraftStore.getState().manualDishes
      .map((dish) => dish.name.trim())
      .filter(Boolean)
      .join('、');

    setImageGenerateMeal(manualEditMeal);
    setImageGenerationPrompt(promptSource || manualEditMeal.dishName || `${MEAL_LABELS[manualEditMeal.mealType]}の料理`);
    setImageReferenceFiles([]);
    setImageReferencePreviews([]);
    if (imageGenerateInputRef.current) {
      imageGenerateInputRef.current.value = '';
    }
    setActiveModal('imageGenerate');
  };

  const handleImageReferenceSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newFiles = Array.from(files);
    setImageReferenceFiles([...useFormDraftStore.getState().imageReferenceFiles, ...newFiles]);

    newFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImageReferencePreviews([...useFormDraftStore.getState().imageReferencePreviews, reader.result as string]);
      };
      reader.readAsDataURL(file);
    });

    e.target.value = '';
  };

  const removeImageReference = (index: number) => {
    setImageReferenceFiles(useFormDraftStore.getState().imageReferenceFiles.filter((_, i) => i !== index));
    setImageReferencePreviews(useFormDraftStore.getState().imageReferencePreviews.filter((_, i) => i !== index));
  };

  const generateMealImage = async () => {
    if (!imageGenerateMeal || !currentPlan) return;

    const { imageGenerationPrompt, imageReferenceFiles } = useFormDraftStore.getState();
    const prompt = imageGenerationPrompt.trim();
    if (!prompt) {
      alert('生成したい料理の説明を入力してください');
      return;
    }

    setIsGeneratingMealImage(true);
    // 献立の書き込み (#2201 U2。画像の保存の前に読んだ取り直しの応答で、保存した画像を戻さない)
    const endWrite = receiver.beginWrite();

    try {
      // 説明文と参考画像を Google の画像生成に送る前に、未同意なら同意画面を出す (「同意しない」なら生成しない)
      if ((await ensureAiConsent()) === "declined") return;

      const referenceImages = await Promise.all(
        imageReferenceFiles.map(async (file) => new Promise<{ base64: string; mimeType: string }>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = reader.result as string;
            resolve({
              base64: result.split(',')[1],
              mimeType: file.type || 'image/png',
            });
          };
          reader.readAsDataURL(file);
        }))
      );

      const generateResponse = await aiFetch('/api/ai/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          images: referenceImages,
        }),
      });
      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内するので、エラーは出さない
      if (await isAiConsentRequiredResponse(generateResponse)) return;

      const generatePayload = await generateResponse.json();
      if (!generateResponse.ok) {
        throw new Error(generatePayload.error || '画像生成に失敗しました');
      }

      if (!generatePayload.imageUrl) {
        throw new Error('画像URLを取得できませんでした');
      }

      const saveResponse = await fetch(`/api/meal-plans/meals/${imageGenerateMeal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: generatePayload.imageUrl,
        }),
      });

      const savePayload = await saveResponse.json();
      if (!saveResponse.ok) {
        throw new Error(savePayload.error || '画像の保存に失敗しました');
      }

      const updatedDays = currentPlan.days.map((day) => ({
        ...day,
        meals: day.meals?.map((meal) =>
          meal.id === imageGenerateMeal.id
            ? { ...meal, imageUrl: generatePayload.imageUrl }
            : meal
        ),
      }));
      const updatedPlan = { ...currentPlan, days: updatedDays };
      const targetDate = formatLocalDate(weekStart);

      setCurrentPlan(updatedPlan);
      // 置くのは読み取りの応答ではなく、今の献立に保存した画像を当てたもの: 書き込み口はここで取って書く (#2201 U1。weekDataCache)。
      // この書き込みの間 (receiver.beginWrite の窓) は AI 相談の取り直しがキャッシュを捨てない。始める前に始まった取り直しは、応答を置かずに
      // 書き込みのあとに取り直す (キャッシュも捨て直す)
      weekDataCache.current.beginWrite(targetDate)({ plan: updatedPlan, shoppingList });
      setManualEditMeal(
        manualEditMeal && manualEditMeal.id === imageGenerateMeal.id
          ? { ...manualEditMeal, imageUrl: generatePayload.imageUrl }
          : manualEditMeal,
      );

      closeImageGenerateModal(true);
      setSuccessMessage({
        title: '画像を生成しました',
        message: referenceImages.length > 0
          ? '参照画像を反映して料理画像を更新しました。'
          : '料理画像を更新しました。',
      });
    } catch (error) {
      console.error('Meal image generation error:', error);
      // #1050 round-2 (UX2-02残): alert() ではなく完了モーダル(type:'error')に集約。
      // imageGenerateMeal/プロンプト/参照画像は失敗時にクリアされず、画像生成モーダルも
      // 開いたままのため generateMealImage を再実行するだけで安全にリトライできる。
      setSuccessMessage({
        title: '画像生成に失敗しました',
        message: error instanceof Error ? error.message : '画像生成に失敗しました。もう一度お試しください。',
        type: 'error',
        onRetry: () => generateMealImage(),
      });
    } finally {
      setIsGeneratingMealImage(false);
      endWrite();
    }
  };

  // 献立改善（AI栄養士の提案を反映）
  // #1050 round-2 (UX2-02残): 以前は ImproveMealModal の onImprove に匿名関数として
  // 直接渡していたため、失敗時の「もう一度試す」から自分自身を再実行できなかった。
  // 名前付き関数として切り出し、失敗ハンドラから handleImprove を再度呼べるようにする。
  const handleImprove = async () => {
    if (improveMealTargets.length === 0) {
      alert('改善する食事を選択してください');
      return;
    }

    // 「同意しない」なら改善を依頼しない
    if ((await ensureAiConsent()) === "declined") return;

    setIsImprovingMeal(true);

    try {
      const targetDateStr = improveNextDay
        ? weekDates[selectedDayIndex + 1]?.dateStr
        : weekDates[selectedDayIndex]?.dateStr;

      if (!targetDateStr) {
        alert('対象日が見つかりません');
        setIsImprovingMeal(false);
        return;
      }

      const analysisDate = weekDates[selectedDayIndex]?.dateStr;
      const userComment = nutritionFeedback
        ? `${analysisDate}の栄養分析に基づくAI栄養士の提案を参考に改善してください：\n${nutritionFeedback}`
        : undefined;

      const targetSlots = improveMealTargets.map(mealType => ({
        date: targetDateStr,
        mealType,
      }));

      // 送信の間だけ書き込みの窓を開ける (#2206 G1。W-59。改善の待ち・監視は窓の外)
      const endWrite = receiver.beginWrite();
      let requestRes: Response;
      try {
        requestRes = await aiFetch('/api/ai/menu/v4/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetSlots,
            resolveExistingMeals: true,
            note: userComment,
            constraints: {},
          }),
        });
      } finally {
        endWrite();
      }

      // 同意が必要で止められた: 同意画面 (AiConsentRequiredHost) が案内するので、エラーは出さない
      if (await isAiConsentRequiredResponse(requestRes)) {
        setIsImprovingMeal(false);
        return;
      }

      if (!requestRes.ok) {
        const errorData = await requestRes.json().catch(() => ({}));
        throw new Error(errorData.error || 'リクエストの作成に失敗しました');
      }

      const requestData = await requestRes.json();

      setShowImproveMealModal(false);
      setShowNutritionDetailModal(false);

      const totalSlotsCount = targetSlots.length;
      setIsGenerating(true);
      // UX2-12: 改善対象スロットのみを「考え中」表示の対象にする
      setGenTargetSlotKeys(targetSlots);
      setGenerationProgress({
        phase: 'analyzing',
        message: 'AI栄養士の提案を反映中...',
        percentage: 5,
        totalSlots: totalSlotsCount,
        completedSlots: 0,
      });

      if (requestData.requestId) {
        const improveRequestId = requestData.requestId;
        // #1033 F1b-06: onImprove も Realtime 単独だとスピナーが取り残されるため、
        // subscribeToRegenerateStatus と同様に 3秒ポーリング + 5分の上限タイムアウトを併用する
        if (improvePollingIntervalRef.current) {
          clearInterval(improvePollingIntervalRef.current);
          improvePollingIntervalRef.current = null;
        }
        if (improveTimeoutRef.current) {
          clearTimeout(improveTimeoutRef.current);
          improveTimeoutRef.current = null;
        }

        const improveResolvedRef = { current: false };
        // この改善の監視の印 (#1657)。次の改善の開始・中止 (handleCancelGeneration)・アンマウントで active が false になる。
        // 前の改善のポーリングの、fetch を待っていた tick (や Realtime) が、戻ってからこの改善のポーリング・タイムアウトを止めたり、
        // 表示 (進捗・完了・失敗) を書き換えたりしないように、前の改善の印をここで下ろす
        if (improveWatchRef.current) improveWatchRef.current.active = false;
        const improveWatch = { active: true };
        improveWatchRef.current = improveWatch;

        const finishImprove = async (status: 'completed' | 'failed', errorMessage?: string) => {
          if (!improveWatch.active) return;
          if (improveResolvedRef.current) return;
          improveResolvedRef.current = true;
          if (improvePollingIntervalRef.current) {
            clearInterval(improvePollingIntervalRef.current);
            improvePollingIntervalRef.current = null;
          }
          if (improveTimeoutRef.current) {
            clearTimeout(improveTimeoutRef.current);
            improveTimeoutRef.current = null;
          }
          setIsGenerating(false);
          setGenerationProgress(null);

          if (status === 'failed') {
            // T15 (#1154): サーバーが同意の判定で止めた (未同意) なら同意画面を出し、失敗のモーダルは出さない
            if (handleStoredAiConsentFailure(errorMessage)) return;
            // #1050 round-2 (UX2-02残): alert() ではなく完了モーダル(type:'error')に集約。
            // improveMealTargets/improveNextDay/selectedDayIndex はこの非同期失敗検知時点でも
            // クリアされていないため、改善対象選択モーダルを再度開けばそのままリトライできる。
            setSuccessMessage({
              title: '献立の改善に失敗しました',
              message: errorMessage || '献立の改善に失敗しました。もう一度お試しください。',
              type: 'error',
              onRetry: () => setShowImproveMealModal(true),
            });
            return;
          }

          const startStr = weekDates[0]?.dateStr;
          if (startStr) {
            try {
              // 改善した週を読み直して置く (ページの読み取りの place。#2206 G1。GET /api/meal-plans を読む。前は無い route の
              // GET /api/meal-plans/weekly を読んで 404 になり、改善した献立を置けていなかった)
              await reloadWeekAfterCompletion(startStr, () => improveWatch.active);
              // 献立を読む間に次の改善の開始・中止で印が下りていたら、この改善の週の献立は置かない (#1657)
              if (!improveWatch.active) return;
            } catch (e) {
              console.error('❌ Failed to fetch meal plan after improve:', e);
            }
          }
        };

        v4Generation.subscribeToProgress(
          improveRequestId,
          async (progress: any) => {
            // 次の改善の開始・中止・アンマウントで印が下りたあとに届いた進捗では、表示を書き換えない (#1657)
            if (!improveWatch.active) return;
            // 献立の改善は究極モードで始めない (v4 の生成に ultimateMode を送らない。#1597)
            const uiProgress = convertV4ProgressToUIFormat(progress, false);
            setGenerationProgress(uiProgress);

            if (progress.status === 'completed' || progress.status === 'failed') {
              await finishImprove(progress.status, weeklyMenuRequestErrorMessageForDisplay(progress.errorMessage) ?? undefined);
            }
          }
        );

        // 常にポーリングも開始（Realtimeの信頼性が低いため）
        const pollImprove = async () => {
          if (!improveWatch.active) return;
          if (improveResolvedRef.current) return;
          try {
            const statusRes = await fetch(`/api/ai/menu/weekly/status?requestId=${improveRequestId}`);
            if (!statusRes.ok) return;
            const { status, errorMessage, error_message: errorMessageSnake, progress: dbProgress } = await statusRes.json();
            if (improveResolvedRef.current) return;
            // fetch を待つ間に次の改善の開始・中止・アンマウントで印が下りていたら、届いた応答では何も置かない (#1657)
            if (!improveWatch.active) return;
            // not_found = 本人の行が無い (消えた)。以前は 5 分のタイムアウトまで確認を続けていた。失敗として止め、既定の失敗の文を出す (#1657)
            if (status === 'not_found') {
              await finishImprove('failed');
              return;
            }
            if (status === 'completed') {
              await finishImprove('completed');
            } else if (status === 'failed') {
              await finishImprove('failed', weeklyMenuRequestErrorMessageForDisplay(errorMessage || errorMessageSnake) ?? undefined);
            } else if (dbProgress) {
              // Realtime が届いていない間も、DB の進捗で表示を進める (#1663)。割合は Math.max で戻らないので、
              // Realtime が先に進めていても遅れて着いたこの応答で割合は戻らない。生成中でなければ (完了・失敗・中止のあと) 何も置かない
              setGenerationProgressWhileGenerating(convertV4ProgressToUIFormat(dbProgress, false));
            }
          } catch (e) {
            console.error('Improve polling error:', e);
          }
        };
        pollImprove();
        improvePollingIntervalRef.current = setInterval(pollImprove, 3000);

        // 5分間 completed/failed を受信できなければタイムアウトとしてエラー表示
        improveTimeoutRef.current = setTimeout(() => {
          if (!improveResolvedRef.current) {
            console.warn('⏱️ Improve meal timed out after 5 minutes with no response');
            finishImprove('failed', '献立の改善がタイムアウトしました。もう一度お試しください。');
          }
        }, 5 * 60 * 1000);
      }
    } catch (error) {
      console.error('Failed to improve meals:', error);
      // #1050 round-2 (UX2-02残): alert() ではなく完了モーダル(type:'error')に集約。
      // ここはモーダルがまだ開いたままの初回リクエスト失敗のため、handleImprove を
      // そのまま再実行するだけで安全にリトライできる。
      setSuccessMessage({
        title: '献立の改善に失敗しました',
        message: '献立の改善に失敗しました。もう一度お試しください。',
        type: 'error',
        onRetry: () => handleImprove(),
      });
    } finally {
      setIsImprovingMeal(false);
    }
  };

  // --- Computed ---
  const currentDay = currentPlan?.days?.find(d => d.dayDate === weekDates[selectedDayIndex]?.dateStr);
  // 単一の食事を取得（AI生成用、空欄チェック用）
  const getMeal = (day: MealPlanDay | undefined, type: MealType) => day?.meals?.find(m => m.mealType === type);
  // 同じタイプの食事を全て取得（複数回の食事対応）- displayOrder順にソート
  const getMeals = (day: MealPlanDay | undefined, type: MealType) => 
    (day?.meals?.filter(m => m.mealType === type) || []).sort((a, b) => a.displayOrder - b.displayOrder);
  
  // 食事の順序変更
  const reorderMeal = async (mealId: string, direction: 'up' | 'down') => {
    if (!currentDay) return;
    // 献立の書き込み (#2201 U2。並べ替えの前に読んだ取り直しの応答で、並べ替えた順を戻さない)
    const endWrite = receiver.beginWrite();
    
    try {
      const res = await fetch('/api/meal-plans/meals/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mealId,
          direction,
          dayId: currentDay.id,
        }),
      });
      
      const data = await res.json();
      
      if (res.ok && data.success) {
        // 献立を再取得 (ページの読み取り。#2206 G1)
        await receiver.read({}, (read) => readDisplayedWeek(read, WEEK_PLACEMENT_AFTER_REORDER));
      } else if (data.message) {
        // 移動できない場合のメッセージ（静かに無視）
        console.log(data.message);
      }
    } catch (error) {
      console.error('Reorder error:', error);
    } finally {
      endWrite();
    }
  };
  
  // 食事が上に移動可能かどうかを判定
  const canMoveUp = (meal: PlannedMeal, allMeals: PlannedMeal[]): boolean => {
    if (!allMeals || allMeals.length <= 1) return false;
    
    const currentIndex = allMeals.findIndex(m => m.id === meal.id);
    if (currentIndex <= 0) return false;
    
    const isSnack = meal.mealType === 'snack';
    
    if (isSnack) {
      // おやつはどこにでも移動可能
      return true;
    } else {
      // 同じmeal_typeの食事が上にあるかチェック
      const sameMealTypeMeals = allMeals.filter(m => m.mealType === meal.mealType);
      const positionInType = sameMealTypeMeals.findIndex(m => m.id === meal.id);
      
      // 上の食事がおやつか、同じタイプなら移動可能
      const prevMeal = allMeals[currentIndex - 1];
      return positionInType > 0 || prevMeal.mealType === 'snack';
    }
  };
  
  // 食事が下に移動可能かどうかを判定
  const canMoveDown = (meal: PlannedMeal, allMeals: PlannedMeal[]): boolean => {
    if (!allMeals || allMeals.length <= 1) return false;
    
    const currentIndex = allMeals.findIndex(m => m.id === meal.id);
    if (currentIndex < 0 || currentIndex >= allMeals.length - 1) return false;
    
    const isSnack = meal.mealType === 'snack';
    
    if (isSnack) {
      // おやつはどこにでも移動可能
      return true;
    } else {
      // 同じmeal_typeの食事が下にあるかチェック
      const sameMealTypeMeals = allMeals.filter(m => m.mealType === meal.mealType);
      const positionInType = sameMealTypeMeals.findIndex(m => m.id === meal.id);
      
      // 下の食事がおやつか、同じタイプなら移動可能
      const nextMeal = allMeals[currentIndex + 1];
      return positionInType < sameMealTypeMeals.length - 1 || nextMeal.mealType === 'snack';
    }
  };
  
  // 期限切れと期限間近 (今日から PANTRY_EXPIRING_SOON_DAYS 日後の期限まで。全画面共通の日数 #1602) の食材
  const expiringItems = fridgeItems.filter(i => {
    const days = getDaysUntil(i.expirationDate);
    return days !== null && days <= PANTRY_EXPIRING_SOON_DAYS;
  }).sort((a, b) => (getDaysUntil(a.expirationDate) || 0) - (getDaysUntil(b.expirationDate) || 0));

  const countEmptySlots = () => {
    const todayStr = formatLocalDate(new Date());
    let count = 0;
    
    // weekDatesを使って表示中の週の空欄をカウント
    weekDates.forEach(({ dateStr }) => {
      // 今日以降の日付のみカウント
      if (dateStr >= todayStr) {
        const day = currentPlan?.days?.find(d => d.dayDate === dateStr);
        BASE_MEAL_TYPES.forEach(type => {
          if (!getMeal(day, type)) count++;
        });
      }
    });
    
    return count;
  };
  
  // これからの献立数をカウント（空欄 + 既存の献立）
  const countFutureMeals = () => {
    const todayStr = formatLocalDate(new Date());
    let count = 0;
    
    weekDates.forEach(({ dateStr }) => {
      if (dateStr >= todayStr) {
        count += 3; // 朝・昼・夕の3食
      }
    });
    
    return count;
  };
  
  // 既存の献立があるかどうか
  const hasFutureMeals = () => {
    const todayStr = formatLocalDate(new Date());
    return weekDates.some(({ dateStr }) => {
      if (dateStr >= todayStr) {
        const day = currentPlan?.days?.find(d => d.dayDate === dateStr);
        return BASE_MEAL_TYPES.some(type => getMeal(day, type));
      }
      return false;
    });
  };

  const getWeekStats = () => {
    if (!currentPlan?.days) return { cookRate: 0, avgCal: 0, cookCount: 0, buyCount: 0, outCount: 0 };
    let cookCount = 0, buyCount = 0, outCount = 0, totalCal = 0, mealCount = 0;
    currentPlan.days.forEach(day => {
      day.meals?.forEach(meal => {
        const mode = meal.mode || 'cook';
        // 自炊系: cook, quick, ai_creative（AI生成も自炊としてカウント）
        if (mode === 'cook' || mode === 'quick' || mode === 'ai_creative' || mode.startsWith('ai')) cookCount++;
        else if (mode === 'buy') buyCount++;
        else if (mode === 'out') outCount++;
        else cookCount++; // デフォルトは自炊扱い
        totalCal += meal.caloriesKcal || 0;
        mealCount++;
      });
    });
    const total = cookCount + buyCount + outCount;
    return {
      cookRate: total > 0 ? Math.round((cookCount / total) * 100) : 0,
      avgCal: currentPlan.days.length > 0 ? Math.round(totalCal / currentPlan.days.length) : 0,
      cookCount, buyCount, outCount
    };
  };

  const stats = getWeekStats();
  const emptySlotCount = countEmptySlots();
  const futureMealCount = countFutureMeals();
  const todayStr = formatLocalDate(new Date());

  const getDayTotalCal = (day: MealPlanDay | undefined) => {
    if (!day?.meals) return 0;
    return day.meals.reduce((sum, m) => sum + (m.caloriesKcal || 0), 0);
  };

  // 1日の全栄養素を合計
  const getDayTotalNutrition = (day: MealPlanDay | undefined) => {
    const totals = {
      caloriesKcal: 0,
      proteinG: 0,
      fatG: 0,
      carbsG: 0,
      sodiumG: 0,
      sugarG: 0,
      fiberG: 0,
      potassiumMg: 0,
      calciumMg: 0,
      phosphorusMg: 0,
      magnesiumMg: 0,
      ironMg: 0,
      zincMg: 0,
      iodineUg: 0,
      cholesterolMg: 0,
      vitaminAUg: 0,
      vitaminB1Mg: 0,
      vitaminB2Mg: 0,
      vitaminB6Mg: 0,
      vitaminB12Ug: 0,
      vitaminCMg: 0,
      vitaminDUg: 0,
      vitaminEMg: 0,
      vitaminKUg: 0,
      folicAcidUg: 0,
      saturatedFatG: 0,
    };
    if (!day?.meals) return totals;
    
    for (const m of day.meals) {
      totals.caloriesKcal += m.caloriesKcal || 0;
      totals.proteinG += m.proteinG || 0;
      totals.fatG += m.fatG || 0;
      totals.carbsG += m.carbsG || 0;
      totals.sodiumG += m.sodiumG || 0;
      totals.sugarG += m.sugarG || 0;
      totals.fiberG += m.fiberG || 0;
      totals.potassiumMg += m.potassiumMg || 0;
      totals.calciumMg += m.calciumMg || 0;
      totals.phosphorusMg += m.phosphorusMg || 0;
      totals.magnesiumMg += m.magnesiumMg || 0;
      totals.ironMg += m.ironMg || 0;
      totals.zincMg += m.zincMg || 0;
      totals.iodineUg += m.iodineUg || 0;
      totals.cholesterolMg += m.cholesterolMg || 0;
      totals.vitaminAUg += m.vitaminAUg || 0;
      totals.vitaminB1Mg += m.vitaminB1Mg || 0;
      totals.vitaminB2Mg += m.vitaminB2Mg || 0;
      totals.vitaminB6Mg += m.vitaminB6Mg || 0;
      totals.vitaminB12Ug += m.vitaminB12Ug || 0;
      totals.vitaminCMg += m.vitaminCMg || 0;
      totals.vitaminDUg += m.vitaminDUg || 0;
      totals.vitaminEMg += m.vitaminEMg || 0;
      totals.vitaminKUg += m.vitaminKUg || 0;
      totals.folicAcidUg += m.folicAcidUg || 0;
      totals.saturatedFatG += m.saturatedFatG || 0;
    }
    return totals;
  };
  
  // 週間の全栄養素を合計（日数で割って1日平均を算出）
  const getWeekTotalNutrition = () => {
    const totals = {
      caloriesKcal: 0,
      proteinG: 0,
      fatG: 0,
      carbsG: 0,
      sodiumG: 0,
      sugarG: 0,
      fiberG: 0,
      potassiumMg: 0,
      calciumMg: 0,
      phosphorusMg: 0,
      magnesiumMg: 0,
      ironMg: 0,
      zincMg: 0,
      iodineUg: 0,
      cholesterolMg: 0,
      vitaminAUg: 0,
      vitaminB1Mg: 0,
      vitaminB2Mg: 0,
      vitaminB6Mg: 0,
      vitaminB12Ug: 0,
      vitaminCMg: 0,
      vitaminDUg: 0,
      vitaminEMg: 0,
      vitaminKUg: 0,
      folicAcidUg: 0,
      saturatedFatG: 0,
    };
    
    if (!currentPlan?.days) return { totals, daysWithMeals: 0, averages: totals };
    
    let daysWithMeals = 0;
    
    for (const day of currentPlan.days) {
      if (day.meals && day.meals.length > 0) {
        daysWithMeals++;
        const dayNutrition = getDayTotalNutrition(day);
        for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
          totals[key] += dayNutrition[key] || 0;
        }
      }
    }
    
    // 1日平均
    const averages = { ...totals };
    if (daysWithMeals > 0) {
      for (const key of Object.keys(averages) as (keyof typeof averages)[]) {
        averages[key] = Math.round((averages[key] / daysWithMeals) * 10) / 10;
      }
    }
    
    return { totals, daysWithMeals, averages };
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: colors.bg }}>
        <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
      </div>
    );
  }

  // ============================================
  // Render Components
  // ============================================

  const EmptySlot = ({ mealKey, dayIndex }: { mealKey: MealType; dayIndex: number }) => {
    // 単一食事の追加生成中かどうか
    const isGeneratingThis = generatingMeal?.dayIndex === dayIndex && generatingMeal?.mealType === mealKey;
    // 週間献立生成中で、このスロットが生成対象かどうか
    // UX2-12: 対象スロットが判明している場合はそれだけを対象にし、生成対象でない日・スロットまで
    // 「AIが考え中」を出さないようにする。不明な場合（復元経路等）は従来どおり今日以降で表示。
    const dayDate = weekDates[dayIndex]?.dateStr;
    const isWeeklyGeneratingThis = Boolean(
      isGenerating && dayDate && (
        genTargetSlotKeys
          ? genTargetSlotKeys.has(`${dayDate}::${mealKey}`)
          : dayDate >= todayStr
      )
    );
    
    if (isGeneratingThis || isWeeklyGeneratingThis) {
      return (
        <div
          className="w-full rounded-[14px] p-5 mb-2 overflow-hidden relative"
          style={{ background: `linear-gradient(135deg, ${colors.accentLight} 0%, ${colors.card} 100%)`, border: `2px solid ${colors.accent}` }}
        >
          <div className="relative z-10 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.accent }}>
              <Sparkles size={20} color="#fff" className="animate-pulse" />
            </div>
            <div className="flex-1">
              <p style={{ fontSize: 14, fontWeight: 600, color: colors.accent }}>
                AIが{MEAL_LABELS[mealKey]}を考え中...
              </p>
              <p style={{ fontSize: 11, color: colors.textMuted }}>
                {isWeeklyGeneratingThis ? '週間献立を生成しています' : '数秒〜数十秒かかります'}
              </p>
            </div>
            <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
          </div>
        </div>
      );
    }
    
    return (
      <button
        onClick={() => openAddMealModal(mealKey, dayIndex)}
        className="w-full flex items-center justify-center gap-2 rounded-[14px] p-5 mb-2 cursor-pointer transition-all hover:border-[#E07A5F]"
        style={{ background: colors.card, border: `2px dashed ${colors.border}` }}
      >
        <Plus size={18} color={colors.textMuted} />
        <span style={{ fontSize: 14, color: colors.textMuted }}>{MEAL_LABELS[mealKey]}を追加</span>
      </button>
    );
  };

  const CollapsedMealCard = ({ mealKey, meal, isPast, mealIndex = 0 }: { mealKey: MealType; meal: PlannedMeal; isPast: boolean; mealIndex?: number }) => {
    const mode = getModeConfig(meal.mode);
    const ModeIcon = mode.icon;
    const isToday = weekDates[selectedDayIndex]?.dateStr === todayStr;
    const isRegeneratingThis = regeneratingMealId === meal.id;

    // 再生成中かどうか（ポーリングで状態を監視）
    // プレースホルダーは使用しないので、meal.isGenerating は参照しない
    // 新規生成中はEmptySlotコンポーネントで表示

    // dishes配列から主菜と他の品数を取得
    // LegacyDishDetail にキャスト：旧形式(cal/protein等)と新形式(calories_kcal/protein_g等)の両方に対応
    const dishesArray: LegacyDishDetail[] = Array.isArray(meal.dishes)
      ? meal.dishes as LegacyDishDetail[]
      : meal.dishes
        ? Object.values(meal.dishes).filter(Boolean) as LegacyDishDetail[]
        : [];
    
    // 複数回目の食事の場合はラベルに番号を追加
    const mealLabel = mealIndex > 0 ? `${MEAL_LABELS[mealKey]}${mealIndex + 1}` : MEAL_LABELS[mealKey];
    // 主菜を探す（英語・日本語両方対応）
    const mainDish = dishesArray.find(d => 
      d.role === 'main' || d.role === '主菜' || d.role === '主食'
    ) || dishesArray[0];
    const otherCount = dishesArray.length > 1 ? dishesArray.length - 1 : 0;
    
    // 表示名を決定（主菜名 + 他○品）
    const displayName = meal.isSimple || dishesArray.length === 0 
      ? meal.dishName 
      : mainDish 
        ? `${mainDish.name}${otherCount > 0 ? ` 他${otherCount}品` : ''}`
        : meal.dishName;
    
    // 順序変更の可否を判定
    const allMeals = currentDay?.meals || [];
    const showReorderButtons = allMeals.length > 1;
    const canUp = showReorderButtons && canMoveUp(meal, allMeals);
    const canDown = showReorderButtons && canMoveDown(meal, allMeals);

    // この食事が個別再生成中の場合
    if (isRegeneratingThis) {
      return (
        <div className="flex items-center gap-2 mb-2">
          <div
            className="flex-1 flex items-center justify-between rounded-[14px] p-3"
            style={{ background: colors.accentLight }}
          >
            <div className="flex items-center gap-2.5">
              <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, width: 28 }}>
                {MEAL_LABELS[mealKey].slice(0, 1)}
              </span>
              <div className="w-4 h-4 border-2 rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
              <span style={{ fontSize: 13, color: colors.accent }}>
                AIが考え中...
              </span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center gap-1.5 mb-2">
        {/* 順序変更ボタン（複数の食事がある場合のみ表示） */}
        {showReorderButtons && (
          // #1052 (タップ領域 / Warning C, 敵対レビュー統合修正で再検討・据え置き):
          // 元は w-5 h-5 (20px) で 44px 基準未達だった。上下ボタンが隣接しているため、
          // ± カウンタ(Critical B)と同じ「負マージンで不可視に拡大」する手も検討したが、
          // このボタンは canUp/canDown=true のとき background: colors.bg を持つ「見える」
          // ボタンであり、± カウンタ(常に背景透明)と違って min-height を拡大すると
          // ヒット領域だけでなく塗り面まで大きく見えてしまう。かつ本リストは各食事の行が
          // mb-2 (8px) しか離れておらず、上/下ボタンをそれぞれ外向き(互いに向き合わない側)
          // にのみ負マージンで拡大しても、44px相当に届かせるには前後の食事行の塗り面に
          // まで侵食する負マージン量が必要になり、Critical B で潰したのと同種の誤タップ
          // （隣の食事行のボタンを誤って押す）を再導入しかねない。
          // そのため「捏造の44px化」はせず、視覚サイズは w-6 h-6 (24px) のまま据え置き、
          // 上下ボタン間の余白のみ gap-0.5→gap-1 に広げて誤タップの実効リスクを下げる
          // （aria-label は既存どおり付与）。
          <div className="flex flex-col gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); canUp && reorderMeal(meal.id, 'up'); }}
              aria-label="この食事を1つ上に移動"
              className="w-6 h-6 rounded flex items-center justify-center transition-colors"
              style={{
                background: canUp ? colors.bg : 'transparent',
                opacity: canUp ? 1 : 0.3,
                cursor: canUp ? 'pointer' : 'default',
              }}
              disabled={!canUp}
            >
              <ArrowUp size={12} color={canUp ? colors.textLight : colors.textMuted} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); canDown && reorderMeal(meal.id, 'down'); }}
              aria-label="この食事を1つ下に移動"
              className="w-6 h-6 rounded flex items-center justify-center transition-colors"
              style={{
                background: canDown ? colors.bg : 'transparent',
                opacity: canDown ? 1 : 0.3,
                cursor: canDown ? 'pointer' : 'default',
              }}
              disabled={!canDown}
            >
              <ArrowDown size={12} color={canDown ? colors.textLight : colors.textMuted} />
            </button>
          </div>
        )}

        {/* 今日または過去の献立でチェックボックスを表示 */}
        {(isToday || isPast) && (
          <button
            onClick={() => currentDay && toggleMealCompletion(currentDay.id, meal)}
            className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 transition-colors cursor-pointer"
            style={{
              border: meal.isCompleted ? 'none' : `2px solid ${colors.border}`,
              background: meal.isCompleted ? colors.success : 'transparent',
            }}
          >
            {meal.isCompleted && <Check size={14} color="#fff" />}
          </button>
        )}
        
        <button
          onClick={() => setExpandedMealId(meal.id)}
          className="flex-1 flex items-center justify-between rounded-[14px] p-3 text-left transition-all"
          style={{
            background: colors.card,
            opacity: isPast ? 0.7 : (meal.isCompleted ? 0.7 : 1),
          }}
        >
          <div className="flex items-center gap-2.5">
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.text, minWidth: 28 }}>
              {mealIndex > 0 ? `${MEAL_LABELS[mealKey].slice(0, 1)}${mealIndex + 1}` : MEAL_LABELS[mealKey].slice(0, 1)}
            </span>
            <div className="flex items-center gap-1 px-2 py-1 rounded-md" style={{ background: mode.bg }}>
              <ModeIcon size={12} color={mode.color} />
            </div>
            <span style={{ 
              fontSize: 13, 
              color: isPast ? colors.textMuted : colors.textLight,
              textDecoration: meal.isCompleted ? 'line-through' : 'none',
            }}>
              {displayName}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span style={{ fontSize: 12, color: colors.textMuted }}>{meal.caloriesKcal || '-'}kcal</span>
            <ChevronDown size={14} color={colors.textMuted} />
          </div>
        </button>
      </div>
    );
  };

  const ExpandedMealCard = ({ mealKey, meal, isPast = false, mealIndex = 0 }: { mealKey: MealType; meal: PlannedMeal; isPast?: boolean; mealIndex?: number }) => {
    const mode = getModeConfig(meal.mode);
    const ModeIcon = mode.icon;
    const isToday = weekDates[selectedDayIndex]?.dateStr === todayStr;
    const mealLabel = mealIndex > 0 ? `${MEAL_LABELS[mealKey]}${mealIndex + 1}` : MEAL_LABELS[mealKey];
    const isRegeneratingThis = regeneratingMealId === meal.id;
    
    // 再生成中かどうか（ポーリングで状態を監視）
    // プレースホルダーは使用しないので、meal.isGenerating は参照しない
    
    // dishes は配列形式に対応（可変数）
    // LegacyDishDetail にキャスト：旧形式(cal/protein等)と新形式(calories_kcal/protein_g等)の両方に対応
    const dishesArray: LegacyDishDetail[] = Array.isArray(meal.dishes)
      ? meal.dishes as LegacyDishDetail[]
      : meal.dishes
        ? Object.values(meal.dishes).filter(Boolean) as LegacyDishDetail[]
        : [];
    const hasDishes = dishesArray.length > 0;
    
    // グリッドのカラム数を動的に決定
    const gridCols = dishesArray.length === 1 ? 'grid-cols-1' 
                   : dishesArray.length === 2 ? 'grid-cols-2'
                   : dishesArray.length === 3 ? 'grid-cols-3'
                   : 'grid-cols-2';
    
    // 順序変更の可否を判定
    const allMeals = currentDay?.meals || [];
    const showReorderButtons = allMeals.length > 1;
    const canUp = showReorderButtons && canMoveUp(meal, allMeals);
    const canDown = showReorderButtons && canMoveDown(meal, allMeals);

    // この食事が個別再生成中の場合はローディング表示
    if (isRegeneratingThis) {
      return (
        <div className="rounded-[20px] p-4 mb-2 flex flex-col" style={{ background: colors.card }}>
          <div className="flex justify-between items-center mb-3">
            <span style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>{mealLabel}</span>
          </div>
          <div className="flex items-center justify-center rounded-[14px] p-8" style={{ background: colors.accentLight }}>
            <div className="text-center">
              <div className="w-10 h-10 border-3 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-3" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
              <p style={{ fontSize: 14, fontWeight: 500, color: colors.accent, margin: 0 }}>AIが新しい献立を考え中...</p>
              <p style={{ fontSize: 11, color: colors.textMuted, margin: '4px 0 0' }}>少々お待ちください</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-[20px] p-4 mb-2 flex flex-col" style={{ background: colors.card }}>
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-2.5">
            {/* 順序変更ボタン */}
            {showReorderButtons && (
              // #1052 (タップ領域 / Warning C, 敵対レビュー統合修正で再検討・据え置き):
              // 上下ボタンが隣接し、かつ canUp/canDown=true 時は背景色を持つ「見える」
              // ボタンのため、± カウンタ(Critical B)と同じ負マージンでの不可視拡大は
              // 塗り面の肥大化や隣接する食事行への侵食（B と同種の誤タップ）を招く恐れが
              // あり不採用。「捏造の44px化」はせず視覚サイズは w-6 h-6 (24px) のまま据え置き、
              // 上下ボタン間の余白のみ gap-0.5→gap-1 に広げる + aria-label 付与。
              <div className="flex flex-col gap-1 mr-1">
                <button
                  onClick={(e) => { e.stopPropagation(); canUp && reorderMeal(meal.id, 'up'); }}
                  aria-label="この食事を1つ上に移動"
                  className="w-6 h-6 rounded flex items-center justify-center transition-colors"
                  style={{
                    background: canUp ? colors.bg : 'transparent',
                    opacity: canUp ? 1 : 0.3,
                    cursor: canUp ? 'pointer' : 'default',
                  }}
                  disabled={!canUp}
                >
                  <ArrowUp size={12} color={canUp ? colors.textLight : colors.textMuted} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); canDown && reorderMeal(meal.id, 'down'); }}
                  aria-label="この食事を1つ下に移動"
                  className="w-6 h-6 rounded flex items-center justify-center transition-colors"
                  style={{
                    background: canDown ? colors.bg : 'transparent',
                    opacity: canDown ? 1 : 0.3,
                    cursor: canDown ? 'pointer' : 'default',
                  }}
                  disabled={!canDown}
                >
                  <ArrowDown size={12} color={canDown ? colors.textLight : colors.textMuted} />
                </button>
              </div>
            )}
            
            {isToday && (
              <button
                onClick={() => currentDay && toggleMealCompletion(currentDay.id, meal)}
                className="w-7 h-7 rounded-full flex items-center justify-center transition-colors cursor-pointer"
                style={{
                  border: meal.isCompleted ? 'none' : `2px solid ${colors.border}`,
                  background: meal.isCompleted ? colors.success : 'transparent',
                }}
              >
                {meal.isCompleted && <Check size={14} color="#fff" />}
              </button>
            )}
            <span style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>{mealLabel}</span>
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-lg" style={{ background: mode.bg }}>
              <ModeIcon size={14} color={mode.color} />
              <span style={{ fontSize: 11, fontWeight: 600, color: mode.color }}>{mode.label}</span>
            </div>
          </div>
          <span style={{ fontSize: 14, color: colors.textMuted }}>{meal.caloriesKcal || '-'} kcal</span>
        </div>

        {hasDishes ? (
          <div className={`grid ${gridCols} gap-2`}>
            {dishesArray.map((dish, idx) => {
              const config = getDishConfig(dish.role);
              return (
                <button
                  key={idx}
                  onClick={() => {
                    // タップした料理だけを表示
                    setSelectedRecipe(dish.name);
                    // 古い形式(cal, protein等)と新しい形式(calories_kcal, protein_g等)の両方に対応
                    const d = dish as LegacyDishDetail;
                    const normalizedDish = {
                      ...dish,
                      // 新しい形式を優先、なければ古い形式からマッピング
                      calories_kcal: dish.calories_kcal ?? d.cal ?? null,
                      protein_g: dish.protein_g ?? d.protein ?? null,
                      fat_g: dish.fat_g ?? d.fat ?? null,
                      carbs_g: dish.carbs_g ?? d.carbs ?? null,
                      fiber_g: dish.fiber_g ?? d.fiber ?? null,
                      sugar_g: dish.sugar_g ?? d.sugar ?? null,
                      sodium_g: dish.sodium_g ?? d.sodium ?? null,
                      potassium_mg: dish.potassium_mg ?? d.potassium ?? null,
                      calcium_mg: dish.calcium_mg ?? d.calcium ?? null,
                      phosphorus_mg: dish.phosphorus_mg ?? d.phosphorus ?? null,
                      iron_mg: dish.iron_mg ?? d.iron ?? null,
                      zinc_mg: dish.zinc_mg ?? d.zinc ?? null,
                      cholesterol_mg: dish.cholesterol_mg ?? d.cholesterol ?? null,
                      vitamin_a_ug: dish.vitamin_a_ug ?? d.vitaminA ?? null,
                      vitamin_b1_mg: dish.vitamin_b1_mg ?? d.vitaminB1 ?? null,
                      vitamin_b2_mg: dish.vitamin_b2_mg ?? d.vitaminB2 ?? null,
                      vitamin_b6_mg: dish.vitamin_b6_mg ?? d.vitaminB6 ?? null,
                      vitamin_b12_ug: dish.vitamin_b12_ug ?? d.vitaminB12 ?? null,
                      vitamin_c_mg: dish.vitamin_c_mg ?? d.vitaminC ?? null,
                      vitamin_d_ug: dish.vitamin_d_ug ?? d.vitaminD ?? null,
                      vitamin_e_mg: dish.vitamin_e_mg ?? d.vitaminE ?? null,
                      vitamin_k_ug: dish.vitamin_k_ug ?? d.vitaminK ?? null,
                      folic_acid_ug: dish.folic_acid_ug ?? d.folicAcid ?? null,
                    };
                    setSelectedRecipeData({
                      ...normalizedDish,
                      // 自分の画像の無い料理に献立のカバーを出すのは、カバーがその料理を表すときだけ (1 品の献立・主菜・写真や商品の料理。billing/03 §10.3・Q-16)
                      imageUrl: dish.image_url ?? (mealCoverRepresentsDish(dishesArray, idx) ? meal.imageUrl : null) ?? null,
                      // この料理だけを配列に入れる（UIの互換性のため）
                      dishes: [normalizedDish],
                      // 全料理の材料（買い物リスト用）
                      allIngredients: dishesArray.flatMap(dd => dd.ingredients || []),
                      // お気に入りの写しの source_planned_meal_id (#2011。参照だけ)
                      plannedMealId: meal.id,
                    });
                    setActiveModal('recipe');
                  }}
                  className="text-left flex flex-col min-h-[85px] rounded-xl p-3"
                  style={{ background: config.bg }}
                >
                  {/* #1119: 3 品の並びは 360px 幅で 1 枚の内側が約 72px しかない。
                      役割名 (11px) と kcal (12px) が収まらない組み合わせ (例: 「デザート」+「250kcal」) は、
                      はみ出さずに kcal を次の行へ折り返す */}
                  <div className="flex flex-wrap gap-x-1 mb-1">
                    <span style={{ fontSize: 11, fontWeight: 700, color: config.color }}>{config.label}</span>
                    <span className="ml-auto" style={{ fontSize: 12, color: colors.textMuted }}>{dish.calories_kcal ?? dish.cal ?? '-'}kcal</span>
                  </div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: colors.text, margin: 0 }}>{dish.name}</p>
                  {/* 栄養素（P/F/C）- 新旧形式両対応。12px にすると 3 品の並びでは 1 行に収まらないため折り返す */}
                  {(dish.protein_g || dish.fat_g || dish.carbs_g || dish.protein || dish.fat || dish.carbs) && (
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1 text-xs" style={{ color: colors.textMuted }}>
                      {((dish.protein_g ?? dish.protein) ?? 0) > 0 && <span>P:{dish.protein_g ?? dish.protein}g</span>}
                      {((dish.fat_g ?? dish.fat) ?? 0) > 0 && <span>F:{dish.fat_g ?? dish.fat}g</span>}
                      {((dish.carbs_g ?? dish.carbs) ?? 0) > 0 && <span>C:{dish.carbs_g ?? dish.carbs}g</span>}
                    </div>
                  )}
                  {/* 「レシピを見る」は E2E がこの文言で探すため変えない。折り返すと「レシピを見」「る」と
                      1 文字だけ落ちるので 1 行にする (文字だけで約 66px)。
                      3 品の並び (360px 幅で内側約 72px) ではアイコン込みの約 79px が入らず、アイコンだけが
                      縮んで点のようになるため、380px 以下の画面の 3 品のときだけアイコンを外す */}
                  <span className="inline-flex items-center gap-0.5 mt-auto text-[11px] whitespace-nowrap" style={{ color: colors.blue }}>
                    <BookOpen size={11} aria-hidden="true" className={`flex-shrink-0${dishesArray.length === 3 ? ' max-[380px]:hidden' : ''}`} /> レシピを見る
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center justify-center rounded-[14px] p-6" style={{ background: colors.bg }}>
            <div className="text-center">
              <ModeIcon size={24} color={mode.color} className="mx-auto mb-1.5" />
              <p style={{ fontSize: 15, fontWeight: 500, color: colors.text, margin: 0 }}>{meal.dishName || '未設定'}</p>
            </div>
          </div>
        )}

        {/* 栄養素一覧セクション */}
        {(meal.caloriesKcal || meal.proteinG || meal.fatG || meal.carbsG) && (
          <div className="mt-3 rounded-xl p-3" style={{ background: colors.bg }}>
            <div className="flex items-center gap-1.5 mb-2">
              <BarChart3 size={12} color={colors.textMuted} />
              <span style={{ fontSize: 11, fontWeight: 600, color: colors.textMuted }}>この食事の栄養素</span>
            </div>
            {/* #1119: 栄養値 (主要情報) は 12px。3 列だと 360px 幅で 1 列が約 85px しかなく
                「エネルギー」+「250kcal」(約 102px) も収まらないため、狭い画面は 2 列 (1 列約 134px) にする */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 text-xs" style={{ color: colors.text }}>
              {/* 基本栄養素 */}
              <NutritionItem label="エネルギー" value={meal.caloriesKcal} unit="kcal" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="タンパク質" value={meal.proteinG} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="脂質" value={meal.fatG} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="炭水化物" value={meal.carbsG} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="食物繊維" value={meal.fiberG} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="糖質" value={meal.sugarG} unit="g" textColor={colors.textMuted} />
              {/* ミネラル */}
              <NutritionItem label="塩分" value={meal.sodiumG} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="カリウム" value={meal.potassiumMg} unit="mg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="カルシウム" value={meal.calciumMg} unit="mg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="リン" value={meal.phosphorusMg} unit="mg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="鉄分" value={meal.ironMg} unit="mg" textColor={colors.textMuted} />
              <NutritionItem label="亜鉛" value={meal.zincMg} unit="mg" textColor={colors.textMuted} />
              <NutritionItem label="ヨウ素" value={meal.iodineUg} unit="µg" decimals={0} textColor={colors.textMuted} />
              {/* 脂質詳細 */}
              <NutritionItem label="飽和脂肪酸" value={meal.saturatedFatG} unit="g" textColor={colors.textMuted} />
              <NutritionItem label="コレステロール" value={meal.cholesterolMg} unit="mg" decimals={0} textColor={colors.textMuted} />
              {/* ビタミン類 */}
              <NutritionItem label="ビタミンA" value={meal.vitaminAUg} unit="µg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンB1" value={meal.vitaminB1Mg} unit="mg" decimals={2} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンB2" value={meal.vitaminB2Mg} unit="mg" decimals={2} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンB6" value={meal.vitaminB6Mg} unit="mg" decimals={2} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンB12" value={meal.vitaminB12Ug} unit="µg" textColor={colors.textMuted} />
              <NutritionItem label="ビタミンC" value={meal.vitaminCMg} unit="mg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="ビタミンD" value={meal.vitaminDUg} unit="µg" textColor={colors.textMuted} />
              <NutritionItem label="ビタミンE" value={meal.vitaminEMg} unit="mg" textColor={colors.textMuted} />
              <NutritionItem label="ビタミンK" value={meal.vitaminKUg} unit="µg" decimals={0} textColor={colors.textMuted} />
              <NutritionItem label="葉酸" value={meal.folicAcidUg} unit="µg" decimals={0} textColor={colors.textMuted} />
            </div>
          </div>
        )}

        {/* 変更ボタン群 */}
        {(() => {
          // 基本の3食（朝・昼・夕）は最低1つ残す
          const isBaseMealType = BASE_MEAL_TYPES.includes(mealKey);
          const sameMealsCount = getMeals(currentDay, mealKey).length;
          const canDelete = !isBaseMealType || sameMealsCount > 1;
          
          return (
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                aria-label="AIで再生成"
                data-testid="meal-regenerate-button"
                onClick={() => openRegenerateMeal(meal)}
                className="flex-1 p-2.5 rounded-[10px] flex items-center justify-center gap-1.5"
                style={{ background: colors.accentLight, border: `1px solid ${colors.accent}` }}
              >
                <Sparkles size={13} color={colors.accent} />
                <span style={{ fontSize: 12, fontWeight: 500, color: colors.accent }}>AIで変更</span>
              </button>
              <button
                type="button"
                onClick={() => openManualEdit(meal)}
                className="flex-1 p-2.5 rounded-[10px] flex items-center justify-center gap-1.5"
                style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
              >
                <Pencil size={13} color={colors.textLight} />
                <span style={{ fontSize: 12, fontWeight: 500, color: colors.textLight }}>手動で修正</span>
              </button>
              {canDelete && (
                <button
                  type="button"
                  aria-label="食事を削除"
                  data-testid="meal-delete-button"
                  onClick={() => openDeleteConfirm(meal)}
                  className="p-2.5 rounded-[10px] flex items-center justify-center"
                  style={{ background: colors.dangerLight, border: `1px solid ${colors.danger}` }}
                >
                  <Trash2 size={13} color={colors.danger} />
                </button>
              )}
            </div>
          );
        })()}
      </div>
    );
  };

  // ============================================
  // Main Render
  // ============================================

  return (
    <div className="min-h-screen flex flex-col pb-20" style={{ background: colors.bg, fontFamily: '-apple-system, BlinkMacSystemFont, "Noto Sans JP", sans-serif' }}>
      
      {/* === Header === */}
      <div className="pt-4 px-4 pb-2 sticky top-0 z-20" style={{ background: colors.card }}>
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Calendar size={18} color={colors.accent} />
            <div>
              <h1 style={{ fontSize: 16, fontWeight: 600, color: colors.text, margin: 0 }}>献立表</h1>
              <p style={{ fontSize: 12, color: colors.textMuted, margin: 0 }}>
                {weekDates[0]?.date.getMonth() + 1}/{weekDates[0]?.date.getDate()} - {weekDates[6]?.date.getMonth() + 1}/{weekDates[6]?.date.getDate()}
              </p>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setActiveModal('stats')}
              aria-label="栄養分析を見る"
              className="w-[34px] h-[34px] rounded-full flex items-center justify-center"
              style={{ background: colors.bg }}
            >
              <BarChart3 size={16} color={colors.textLight} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setActiveModal('fridge')}
              aria-label="冷蔵庫を確認"
              className="w-[34px] h-[34px] rounded-full flex items-center justify-center relative"
              style={{ background: expiringItems.some(i => getDaysUntil(i.expirationDate)! <= 1) ? colors.dangerLight : colors.bg }}
            >
              <Refrigerator size={16} color={expiringItems.some(i => getDaysUntil(i.expirationDate)! <= 1) ? colors.danger : colors.textLight} aria-hidden="true" />
              {/* #1119: 件数バッジの数字は 11px。2 桁でも丸からはみ出さないよう、固定の 16px 円ではなく最小 18px の丸み付き枠にする */}
              {expiringItems.length > 0 && (
                <div className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center" style={{ background: colors.warning }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', lineHeight: 1 }}>{expiringItems.length}</span>
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveModal('shopping')}
              aria-label="買い物リストを開く"
              className="w-[34px] h-[34px] rounded-full flex items-center justify-center relative"
              style={{ background: colors.bg }}
            >
              <ShoppingCart size={16} color={colors.textLight} aria-hidden="true" />
              {shoppingList.filter(i => !i.isChecked).length > 0 && (
                <div className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center" style={{ background: colors.accent }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', lineHeight: 1 }}>{shoppingList.filter(i => !i.isChecked).length}</span>
                </div>
              )}
            </button>
          </div>
        </div>

        {/* Week Stats Mini */}
        <div className="flex gap-3 mt-2.5 py-2">
          <div className="flex items-center gap-1">
            <ChefHat size={12} color={colors.success} />
            <span style={{ fontSize: 11, color: colors.textLight }}>自炊率 {stats.cookRate}%</span>
          </div>
          <div className="flex items-center gap-1">
            <Flame size={12} color={colors.accent} />
            <span style={{ fontSize: 11, color: colors.textLight }}>平均 {stats.avgCal}kcal/日</span>
          </div>
        </div>

        {/* Month Bar (tap to expand calendar) */}
        <div
          className="flex items-center justify-between px-2 py-2 cursor-pointer rounded-lg mt-1"
          style={{ background: colors.bg }}
          onClick={() => setIsCalendarExpanded(!isCalendarExpanded)}
        >
          <div className="flex items-center gap-1.5">
            {isCalendarExpanded ? <ChevronUp size={14} color={colors.textMuted} /> : <ChevronDown size={14} color={colors.textMuted} />}
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
              {displayMonth.getFullYear()}年{displayMonth.getMonth() + 1}月
            </span>
          </div>
          {isCalendarExpanded && (
            <div className="flex gap-2">
              <button
                onClick={goToPreviousMonth}
                className="p-1 rounded hover:bg-gray-200 transition-colors"
              >
                <ChevronLeft size={14} color={colors.textMuted} />
              </button>
              <button
                onClick={goToNextMonth}
                className="p-1 rounded hover:bg-gray-200 transition-colors"
              >
                <ChevronRight size={14} color={colors.textMuted} />
              </button>
            </div>
          )}
        </div>

        {/* Calendar Grid (expandable) */}
        <AnimatePresence>
          {isCalendarExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              <div className="px-2 pb-3 pt-1">
                {/* Day headers */}
                <div className="grid grid-cols-7 mb-1">
                  {dayLabels.map((dayName, i) => {
                    // Weekend columns depend on weekStartDay
                    const isWeekendColumn = weekStartDay === 'sunday'
                      ? (i === 0 || i === 6) // Sun=0, Sat=6
                      : (i === 5 || i === 6); // Sat=5, Sun=6 for monday-start
                    return (
                      <div
                        key={dayName}
                        className="text-center py-1"
                        style={{
                          fontSize: 12,
                          color: isWeekendColumn ? colors.accent : colors.textMuted
                        }}
                      >
                        {dayName}
                      </div>
                    );
                  })}
                </div>

                {/* Date grid */}
                <div className="grid grid-cols-7 gap-y-0.5">
                  {calendarDays.map((day, i) => {
                    const dateStr = formatLocalDate(day);
                    const isCurrentMonth = day.getMonth() === displayMonth.getMonth();
                    const isSelected = dateStr === weekDates[selectedDayIndex]?.dateStr;
                    const isInSelectedWeek = isDateInWeek(day, weekStart);
                    const isToday = dateStr === todayStr;
                    const hasMeal = mealExistenceMap.get(dateStr);
                    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                    const holidayName = holidays[dateStr];
                    const isHoliday = !!holidayName;

                    return (
                      <button
                        key={i}
                        onClick={() => handleCalendarDateClick(day)}
                        className="flex flex-col items-center py-1.5 rounded-lg transition-colors"
                        style={{
                          background: isSelected
                            ? colors.accent
                            : isInSelectedWeek
                              ? colors.accentLight
                              : 'transparent',
                          opacity: isCurrentMonth ? 1 : 0.3,
                        }}
                        title={holidayName}
                      >
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: isToday ? 700 : 400,
                            color: isSelected
                              ? '#fff'
                              : isHoliday
                                ? '#F44336'
                                : isToday
                                  ? colors.accent
                                  : isWeekend
                                    ? colors.accent
                                    : colors.text
                          }}
                        >
                          {day.getDate()}
                        </span>
                        {hasMeal && (
                          <div
                            className="w-1 h-1 rounded-full mt-0.5"
                            style={{ background: isSelected ? '#fff' : colors.success }}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Day Tabs with Week Navigation */}
        <div className="flex items-center py-0 pb-2.5" style={{ borderBottom: `1px solid ${colors.border}` }}>
          {/* 前の週ボタン */}
          <button
            type="button"
            onClick={goToPreviousWeek}
            aria-label="前の週"
            className="flex flex-col items-center justify-center px-1.5 py-1 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <ChevronLeft size={16} color={colors.textMuted} aria-hidden="true" />
            <span style={{ fontSize: 11, color: colors.textMuted, whiteSpace: 'nowrap' }}>前の週</span>
          </button>
          
          {/* 日付タブ */}
          <div className="flex flex-1">
            {weekDates.map((day, idx) => {
              const isSelected = idx === selectedDayIndex;
              const isToday = day.dateStr === todayStr;
              const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
              const isPast = day.dateStr < todayStr;
              return (
                <button
                  type="button"
                  key={day.dateStr}
                  onClick={() => {
                    setSelectedDayIndex(idx);
                    setIsDayNutritionExpanded(false);
                  }}
                  aria-label={`${formatDateJa(day.dateStr)} ${day.dayOfWeek}`}
                  aria-pressed={isSelected}
                  className="flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-[10px] transition-all relative"
                  style={{
                    background: isSelected
                      ? (isPast ? colors.textMuted : colors.accent)
                      : (isPast ? 'rgba(0,0,0,0.03)' : 'transparent'),
                    border: isToday && !isSelected ? `2px solid ${colors.accent}` : 'none',
                  }}
                >
                  <span style={{ fontSize: 11, color: isSelected ? 'rgba(255,255,255,0.7)' : colors.textMuted }}>{day.date.getDate()}</span>
                  <span style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: isSelected ? '#fff' : isPast ? colors.textMuted : isWeekend ? colors.accent : colors.text
                  }}>{day.dayOfWeek}</span>
                </button>
              );
            })}
          </div>
          
          {/* 翌週ボタン */}
          <button
            type="button"
            onClick={goToNextWeek}
            aria-label="翌週"
            className="flex flex-col items-center justify-center px-1.5 py-1 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <ChevronRight size={16} color={colors.textMuted} aria-hidden="true" />
            <span style={{ fontSize: 11, color: colors.textMuted, whiteSpace: 'nowrap' }}>翌週</span>
          </button>
        </div>
      </div>

      {/* === Profile Reminder Banner === */}
      <ProfileReminderBanner />

      {/* === Family View Switcher (家族所属時のみ表示) === */}
      {familyMembers.length > 0 && currentUserId && (
        <div className="mx-3 mt-2">
          <FamilyViewSwitcher
            familyMembers={familyMembers}
            currentUserId={currentUserId}
            value={viewState}
            onChange={(next) => {
              // 適用: 表示を変え、全ての週の家族の献立の cache を捨てて取り直し、家族の一覧 (共有の印・退出した人) も読み直す (T-2・T-25)
              setView(next);
              familyMenu.reload();
              void receiver.read({}, loadFamilyData);
            }}
          />
        </div>
      )}

      {/* === 生成失敗エラーモーダル === */}
      {generationFailedError && (
        <div
          data-testid="generation-failed-modal"
          className="mx-3 mt-2 px-3.5 py-3 rounded-xl flex flex-col gap-2"
          style={{ background: colors.card, border: `1px solid ${colors.border}` }}
        >
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>献立生成に失敗しました</span>
          </div>
          <p style={{ fontSize: 12, color: colors.textMuted }}>{generationFailedError}</p>
          <div className="flex gap-2 mt-1">
            <button
              data-testid="generation-retry-button"
              onClick={() => {
                dispatchAiGen({ type: 'GEN_FAILED_CLEAR' });
                setShowV4Modal(true);
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold"
              style={{ background: colors.accent, color: '#fff' }}
            >
              もう一度試す
            </button>
            <button
              onClick={() => {
                dispatchAiGen({ type: 'GEN_FAILED_CLEAR' });
              }}
              className="px-3 py-1.5 rounded-lg text-xs"
              style={{ background: colors.border, color: colors.text }}
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* === AI Banner === */}
      {isGenerating ? (
        <ProgressTodoCard
          progress={generationProgress}
          colors={colors}
          phases={generationProgress?.isUltimateMode ? ULTIMATE_PROGRESS_PHASES : PROGRESS_PHASES}
          onCancel={() => setShowConfirmCancelGeneration(true)}
          testId="generation-progress"
        />
      ) : (
        <button
          data-testid="ai-assistant-banner-button"
          onClick={() => setShowV4Modal(true)}
          className="mx-3 mt-2 px-3.5 py-2.5 rounded-xl flex items-center justify-between"
          style={{ background: colors.accent }}
        >
          <div className="flex items-center gap-2">
            <Sparkles size={16} color="#fff" />
            <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>
              {emptySlotCount > 0
                ? `空欄${emptySlotCount}件 → AIに埋めてもらう`
                : `AI献立アシスタント`}
            </span>
          </div>
          <ChevronRight size={16} color="rgba(255,255,255,0.7)" />
        </button>
      )}

      {/* Expiring Items Alert */}
      {expiringItems.filter(i => getDaysUntil(i.expirationDate)! <= 2).length > 0 && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-[10px] flex items-center gap-2" style={{ background: colors.warningLight }}>
          <AlertTriangle size={14} color={colors.warning} />
          <span style={{ fontSize: 11, color: colors.text }}>
            <strong>早めに使い切り:</strong> {expiringItems.filter(i => getDaysUntil(i.expirationDate)! <= 2).map(i => `${i.name}(${formatExpiry(getDaysUntil(i.expirationDate))})`).join(', ')}
          </span>
        </div>
      )}

      {/* === Main Content === */}
      <main className="flex-1 p-3 pb-24 overflow-y-auto">
        {/* 日付ヘッダー（タップで1日の栄養を展開） */}
        <div 
          className="mb-2 px-3 py-2 rounded-xl cursor-pointer transition-all duration-200"
          style={{ 
            background: isDayNutritionExpanded ? colors.card : 'transparent',
            border: isDayNutritionExpanded ? `1px solid ${colors.border}` : '1px solid transparent',
          }}
          onClick={toggleDayNutritionExpanded}
        >
          <div className="flex justify-between items-center">
          <div className="flex items-center gap-1.5">
            <span style={{ fontSize: 16, fontWeight: 600, color: weekDates[selectedDayIndex]?.dateStr < todayStr ? colors.textMuted : colors.text }}>
              {weekDates[selectedDayIndex]?.dateStr && formatDateJa(weekDates[selectedDayIndex].dateStr)}（{weekDates[selectedDayIndex]?.dayOfWeek}）
            </span>
            {weekDates[selectedDayIndex]?.dateStr === todayStr && (
              <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold" style={{ background: colors.accent, color: '#fff' }}>今日</span>
            )}
            {weekDates[selectedDayIndex]?.dateStr < todayStr && (
              <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold" style={{ background: colors.textMuted, color: '#fff' }}>過去</span>
            )}
          </div>
            <div className="flex items-center gap-1">
          <span style={{ fontSize: 12, color: colors.textMuted }}>{getDayTotalCal(currentDay)} kcal</span>
              {isDayNutritionExpanded ? (
                <ChevronUp size={14} color={colors.textMuted} />
              ) : (
                <ChevronDown size={14} color={colors.textMuted} />
              )}
            </div>
          </div>
          
          {/* 展開時：レーダーチャート＋栄養サマリー */}
          <AnimatePresence>
            {isDayNutritionExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                {(() => {
                  const dayNutrition = getDayTotalNutrition(currentDay);
                  const mealCount = currentDay?.meals?.length || 0;
                  return (
                    <div className="mt-3 pt-3" style={{ borderTop: `1px solid ${colors.border}` }}>
                      {/* レーダーチャート＋主要栄養素 */}
                      <div className="flex items-start gap-3">
                        {/* レーダーチャート（タップで詳細モーダル） */}
                        <div 
                          className="flex-shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowNutritionDetailModal(true);
                          }}
                        >
                          <NutritionRadarChart
                            nutrition={dayNutrition}
                            selectedNutrients={radarChartNutrients}
                            size={140}
                            showLabels={false}
                            onTap={() => setShowNutritionDetailModal(true)}
                          />
                          <p className="text-center text-[11px] mt-1" style={{ color: colors.textMuted }}>
                            タップで詳細
                          </p>
                        </div>

                        {/* 主要栄養素サマリー */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-2">
                            <BarChart3 size={12} color={colors.accent} />
                            <span style={{ fontSize: 11, fontWeight: 600, color: colors.accent }}>
                              {mealCount}食分の栄養
                            </span>
                          </div>
                          <div className="space-y-1">
                            {radarChartNutrients.slice(0, 6).map(key => {
                              const def = getNutrientDefinition(key);
                              const value = (dayNutrition as Record<string, number>)[key] ?? 0;
                              const percentage = calculateDriPercentage(key, value);
                              const isGood = percentage >= 80 && percentage <= 120;
                              const isLow = percentage < 50;
                              const isHigh = percentage > 150;
                              // #1119: 達成率 (主要情報) を 12px にする。この列は 360px 幅で約 160px しかなく、
                              // 「栄養名 | 棒 | 達成率」を 1 行に並べると棒が約 40px まで細くなり、
                              // 長い栄養名 (例: コレステロール) も省略されてしまうため、
                              // 1 行目に栄養名と達成率、2 行目に棒の 2 段にする
                              return (
                                <div key={key}>
                                  <div className="flex items-baseline justify-between gap-2">
                                    <span className="text-[11px] truncate" style={{ color: colors.textMuted }}>
                                      {def?.label}
                                    </span>
                                    <span
                                      className="text-xs flex-shrink-0 font-medium"
                                      style={{ color: isGood ? colors.success : isLow ? colors.warning : isHigh ? colors.accent : colors.textMuted }}
                                    >
                                      {percentage}%
                                    </span>
                                  </div>
                                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: colors.bg }}>
                                    <div
                                      className="h-full rounded-full transition-all"
                                      style={{
                                        width: `${Math.min(percentage, 100)}%`,
                                        background: isGood ? colors.success : isLow ? colors.warning : isHigh ? colors.accent : colors.textMuted,
                                      }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Meal Cards - 基本の3食（複数対応） */}
        {BASE_MEAL_TYPES.map(type => {
          const meals = getMeals(currentDay, type);
          const isPast = weekDates[selectedDayIndex]?.dateStr < todayStr;
          const hasAnyMeal = meals.length > 0;
          // この食事タイプでAI生成中かどうか（ポーリングで状態を監視）
          const isGeneratingThisType = generatingMeal?.dayIndex === selectedDayIndex && generatingMeal?.mealType === type;

          return (
            <div key={type}>
              {/* 空欄の場合 */}
              {!hasAnyMeal && !isGeneratingThisType && <EmptySlot mealKey={type} dayIndex={selectedDayIndex} />}
              
              {/* 登録済みの食事（複数可） */}
              {meals.map((meal, idx) => {
                const isExpanded = expandedMealId === meal.id;
                return isExpanded ? (
                  <ExpandedMealCard key={meal.id} mealKey={type} meal={meal} isPast={isPast} mealIndex={idx} />
                ) : (
                  <CollapsedMealCard key={meal.id} mealKey={type} meal={meal} isPast={isPast} mealIndex={idx} />
                );
              })}

              {/* 家族の献立 (読み取り専用。#1584 の 1) */}
              <FamilyMenuMealRows
                mealType={type}
                dayDate={weekDates[selectedDayIndex]?.dateStr ?? ''}
                members={familyMembers}
                shownIds={familyMenuPartition.shown}
                menu={familyMenu.data}
              />
              
              {/* AI生成中の追加カード（generatingMealステートがある場合のみ） */}
              {isGeneratingThisType && (
                <div
                  className="w-full rounded-[14px] p-5 mb-2 overflow-hidden relative"
                  style={{ background: `linear-gradient(135deg, ${colors.accentLight} 0%, ${colors.card} 100%)`, border: `2px solid ${colors.accent}` }}
                >
                  <div className="relative z-10 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.accent }}>
                      <Sparkles size={20} color="#fff" className="animate-pulse" />
                    </div>
                    <div className="flex-1">
                      <p style={{ fontSize: 14, fontWeight: 600, color: colors.accent }}>
                        {meals.length > 0 ? `${MEAL_LABELS[type]}${meals.length + 1}` : MEAL_LABELS[type]} AIが考え中...
                      </p>
                      <p style={{ fontSize: 11, color: colors.textMuted }}>
                        数秒〜数十秒かかります
                      </p>
                    </div>
                    <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Extra Meals - おやつ・夜食（複数対応） */}
        {EXTRA_MEAL_TYPES.map(type => {
          const meals = getMeals(currentDay, type);
          const isPast = weekDates[selectedDayIndex]?.dateStr < todayStr;
          // この食事タイプでAI生成中かどうか（ポーリングで状態を監視）
          const isGeneratingThisType = generatingMeal?.dayIndex === selectedDayIndex && generatingMeal?.mealType === type;
          const familyMealsCount = familyMealsCountOf(weekDates[selectedDayIndex]?.dateStr ?? '', type);

          // 自分の献立も家族の献立も無い区分は描かない (#1584 の 1)
          if (meals.length === 0 && familyMealsCount === 0 && !isGeneratingThisType) return null;

          return (
            <div key={type}>
              {meals.map((meal, idx) => {
                const isExpanded = expandedMealId === meal.id;
                return isExpanded ? (
                  <ExpandedMealCard key={meal.id} mealKey={type} meal={meal} isPast={isPast} mealIndex={idx} />
                ) : (
                  <CollapsedMealCard key={meal.id} mealKey={type} meal={meal} isPast={isPast} mealIndex={idx} />
                );
              })}

              {/* 家族の献立 (読み取り専用。#1584 の 1) */}
              <FamilyMenuMealRows
                mealType={type}
                dayDate={weekDates[selectedDayIndex]?.dateStr ?? ''}
                members={familyMembers}
                shownIds={familyMenuPartition.shown}
                menu={familyMenu.data}
              />
              
              {/* AI生成中の追加カード（generatingMealステートがある場合のみ） */}
              {isGeneratingThisType && (
                <div
                  className="w-full rounded-[14px] p-5 mb-2 overflow-hidden relative"
                  style={{ background: `linear-gradient(135deg, ${colors.accentLight} 0%, ${colors.card} 100%)`, border: `2px solid ${colors.accent}` }}
                >
                  <div className="relative z-10 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: colors.accent }}>
                      <Sparkles size={20} color="#fff" className="animate-pulse" />
                    </div>
                    <div className="flex-1">
                      <p style={{ fontSize: 14, fontWeight: 600, color: colors.accent }}>
                        {meals.length > 0 ? `${MEAL_LABELS[type]}${meals.length + 1}` : MEAL_LABELS[type]} AIが考え中...
                      </p>
                      <p style={{ fontSize: 11, color: colors.textMuted }}>
                        数秒〜数十秒かかります
                      </p>
                    </div>
                    <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* 家族の献立の注記 (共有していない・子供・この日は無い・読み込み中・読み込めなかった。#1584 の 1) */}
        <FamilyMenuDayNotes
          dayDate={weekDates[selectedDayIndex]?.dateStr ?? ''}
          members={familyMembers}
          partition={familyMenuPartition}
          menu={familyMenu.data}
          status={familyMenu.status}
          onReload={familyMenu.reload}
        />

        {/* 食事を追加ボタン */}
        <button
          onClick={() => setActiveModal('addMealSlot')}
          className="w-full flex items-center justify-center gap-2 rounded-xl p-4 mt-2 transition-colors"
          style={{ 
            background: colors.card, 
            border: `1px dashed ${colors.border}`,
          }}
        >
          <Plus size={18} color={colors.textMuted} />
          <span style={{ fontSize: 14, color: colors.textMuted }}>食事を追加</span>
        </button>
      </main>

      {/* ============================================ */}
      {/* === MODALS === */}
      {/* ============================================ */}
      <AnimatePresence>
        {activeModal && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setActiveModal(null)}
              className="fixed inset-0 z-[200]"
              style={{ background: 'rgba(0,0,0,0.5)' }}
            />
            
            {/* AI Assistant Modal */}
            {activeModal === 'ai' && (
              <AiAssistantModal
                isGenerating={isGenerating}
                emptySlotCount={emptySlotCount}
                onClose={() => setActiveModal(null)}
                onGenerateWeekly={handleGenerateWeekly}
              />
            )}

            {/* Stats Modal */}
            {activeModal === 'stats' && (
              <StatsModal
                stats={stats}
                weekDates={weekDates}
                weeklySummaryTab={weeklySummaryTab}
                radarChartNutrients={radarChartNutrients}
                todayNutrition={getDayTotalNutrition(currentPlan?.days?.find(d => d.dayDate === formatLocalDate(new Date())))}
                todayMealCount={currentPlan?.days?.find(d => d.dayDate === formatLocalDate(new Date()))?.meals?.length || 0}
                weekNutrition={getWeekTotalNutrition()}
                isLoadingFeedback={isLoadingFeedback}
                isLoadingHint={isLoadingHint}
                praiseComment={praiseComment}
                nutritionFeedback={nutritionFeedback}
                nutritionTip={nutritionTip}
                aiHint={aiHint}
                onClose={() => setActiveModal(null)}
                onChangeTab={setWeeklySummaryTab}
                onOpenNutritionDetail={() => {
                  setActiveModal(null);
                  const todayIdx = weekDates.findIndex(d => d.dateStr === formatLocalDate(new Date()));
                  if (todayIdx >= 0) {
                    setSelectedDayIndex(todayIdx);
                  }
                  setShowNutritionDetailModal(true);
                }}
              />
            )}

            {/* Fridge Modal */}
            {activeModal === 'fridge' && (
              <FridgeModal
                onClose={() => setActiveModal(null)}
                onOpenAddFridge={() => { useFormDraftStore.getState().resetFridgeForm(); setActiveModal('addFridge'); }}
                onDeleteItem={deletePantryItem}
                onEditItem={startEditFridgeItem}
                onPhotoSelected={handleFridgePhotoSelected}
                isAnalyzingPhoto={isAnalyzingFridgePhoto}
              />
            )}

            {/* Add/Edit Fridge Item Modal */}
            {activeModal === 'addFridge' && (
              <AddFridgeModal
                onAdd={addPantryItem}
                onClose={() => { useFormDraftStore.getState().resetFridgeForm(); setActiveModal('fridge'); }}
                submitting={isSavingFridgeItem}
              />
            )}

            {/* Shopping List Modal */}
            {activeModal === 'shopping' && (
              <ShoppingModal
                groupedShoppingList={groupedShoppingList}
                hasAnyMealsThisWeek={hasAnyMealsThisWeek}
                onClose={() => setActiveModal(null)}
                onOpenAddShopping={() => setActiveModal('addShopping')}
                onOpenShoppingRange={() => setActiveModal('shoppingRange')}
                onToggleItem={toggleShoppingItem}
                onDeleteItem={deleteShoppingItem}
                onDeleteAll={requestDeleteAllShopping}
                onToggleVariant={toggleShoppingVariant}
                onOpenServingsModal={() => setShowServingsModal(true)}
                onDismissProgress={() => { setIsRegeneratingShoppingList(false); setShoppingListProgress(null); setShoppingListRequestId(null); }}
                onSetSuccessMessage={setSuccessMessage}
              />
            )}

            {/* Add Shopping Item Modal */}
            {activeModal === 'addShopping' && (
              <AddShoppingModal
                onAdd={addShoppingItem}
                onClose={() => setActiveModal('shopping')}
              />
            )}

            {/* Shopping Range Selection Modal (2-step) */}
            {activeModal === 'shoppingRange' && (
              <ShoppingRangeModal
                isTodayExpanded={isTodayExpanded}
                currentWeekStart={weekStart}
                onClose={() => { setActiveModal('shopping'); setShoppingRangeStep('range'); }}
                onToggleTodayExpanded={setIsTodayExpanded}
                onGenerate={async (cfg) => {
                  if (cfg) {
                    // 人数の設定の書き込み (#2201 U2。保存の前に読んだ取り直しの応答で、保存した人数を戻さない)
                    const endWrite = receiver.beginWrite();
                    try {
                      await fetch('/api/profile', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ servingsConfig: cfg })
                      });
                    } catch (e) {
                      console.error('Failed to save servings config:', e);
                    } finally {
                      endWrite();
                    }
                  }
                  setActiveModal('shopping');
                  setShoppingRangeStep('range');
                  regenerateShoppingList();
                }}
              />
            )}

                        {/* Recipe Modal */}
            {activeModal === 'recipe' && selectedRecipe && (
              <RecipeModal
                selectedRecipe={selectedRecipe}
                selectedRecipeData={selectedRecipeData}
                isFavorite={isFavorite}
                isFavoriteLoading={isFavoriteLoading}
                onClose={() => { setActiveModal(null); setSelectedRecipe(null); }}
                onToggleFavorite={handleToggleFavorite}
                onAddToShoppingList={addRecipeToShoppingList}
              />
            )}

            {/* Servings Config Modal */}
            {showServingsModal && (
              <ServingsModal
                onClose={() => setShowServingsModal(false)}
                onSave={async () => {
                  const currentServingsConfig = useServingsConfigStore.getState().servingsConfig;
                  if (!currentServingsConfig) return;
                  // 人数の設定の書き込み (#2201 U2。保存の前に読んだ取り直しの応答で、保存した人数を戻さない)
                  const endWrite = receiver.beginWrite();
                  try {
                    const res = await fetch('/api/profile', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ servingsConfig: currentServingsConfig })
                    });
                    if (res.ok) {
                      setSuccessMessage({ title: '保存しました', message: '人数設定を更新しました' });
                      setShowServingsModal(false);
                    }
                  } catch (e) {
                    console.error('Failed to save servings config:', e);
                  } finally {
                    endWrite();
                  }
                }}
              />
            )}

            {/* Add Meal Modal */}
            {activeModal === 'add' && (
              <AddMealModal
                modeConfig={MODE_CONFIG}
                onClose={() => setActiveModal(null)}
                onOpenAiMeal={() => setActiveModal('aiMeal')}
                onAddMealWithMode={handleAddMealWithMode}
              />
            )}

            {/* Add Meal Slot Modal - 食事を追加 */}
            {activeModal === 'addMealSlot' && (
              <AddMealSlotModal
                selectedDayIndex={selectedDayIndex}
                weekDates={weekDates}
                onClose={() => setActiveModal(null)}
                onSelectMealType={(type, dayIndex) => openAddMealModal(type, dayIndex)}
              />
            )}

            {/* Delete Confirmation Modal */}
            {/* #1050 round-2 (E, Sonnet5 Suggestion): この ConfirmDeleteModal は
                {activeModal && (...)} の共有バックドロップ（直上の motion.div, z-[200]）の
                内側で使われているため、BottomSheet 自身の背景も表示すると二重に暗くなる。
                hideOverlayBackground で自前の背景を出さないようにする。 */}
            {activeModal === 'confirmDelete' && deletingMeal && (
              <ConfirmDeleteModal
                title="この食事を削除しますか？"
                message={
                  <>
                    「{deletingMeal.dishName || MEAL_LABELS[deletingMeal.mealType as keyof typeof MEAL_LABELS]}」を削除します。<br />
                    この操作は取り消せません。
                  </>
                }
                isDeleting={isDeleting}
                onCancel={() => { setActiveModal(null); setDeletingMeal(null); }}
                onConfirm={confirmDeleteMeal}
                hideOverlayBackground
              />
            )}

            {/* 買い物リスト全削除の確認モーダル（#1053: window.confirm 廃止） */}
            {/* #1050 round-2 (E): 同上の理由で hideOverlayBackground を指定 */}
            {showConfirmDeleteAllShopping && (
              <ConfirmDeleteModal
                title="買い物リストをすべて削除しますか？"
                message={
                  <>
                    {shoppingList.length}件のアイテムをすべて削除します。<br />
                    この操作は取り消せません。
                  </>
                }
                isDeleting={isDeleting}
                onCancel={() => setShowConfirmDeleteAllShopping(false)}
                onConfirm={deleteAllShoppingItems}
                hideOverlayBackground
              />
            )}

            {/* AI Single Meal Modal */}
            {activeModal === 'aiMeal' && (
              <AiMealModal
                weekDates={weekDates}
                onClose={() => setActiveModal(null)}
                onGenerateSingleMeal={handleGenerateSingleMeal}
              />
            )}

            {/* Edit Meal Modal */}
            {activeModal === 'editMeal' && editingMeal && (
              <EditMealModal
                modeConfig={MODE_CONFIG}
                onClose={() => { setActiveModal(null); setEditingMeal(null); }}
                onSave={saveEditMeal}
              />
            )}

            {/* AI Regenerate Meal Modal */}
            {activeModal === 'regenerateMeal' && regeneratingMeal && (
              <RegenerateMealModal
                regeneratingMeal={regeneratingMeal}
                isRegenerating={isRegenerating}
                onClose={() => { setActiveModal(null); setRegeneratingMeal(null); }}
                onRegenerateMeal={handleRegenerateMeal}
              />
            )}

            {/* Manual Edit Modal */}
            {activeModal === 'manualEdit' && manualEditMeal && (
              <ManualEditModal
                manualEditMeal={manualEditMeal}
                modeConfig={MODE_CONFIG}
                onClose={() => { setActiveModal(null); setManualEditMeal(null); }}
                onApplyCatalogProduct={applyCatalogProductToManualEdit}
                onAddDish={addManualDish}
                onRemoveDish={removeManualDish}
                onUpdateDish={updateManualDish}
                onOpenPhotoEdit={() => openPhotoEdit(manualEditMeal)}
                onOpenImageGenerate={openImageGenerate}
                onSave={saveManualEdit}
              />
            )}

            {/* Image Generate Modal */}
            {activeModal === 'imageGenerate' && imageGenerateMeal && (
              <ImageGenerateModal
                imageGenerateMeal={{ ...imageGenerateMeal, imageUrl: imageGenerateMeal.imageUrl ?? undefined }}
                isGeneratingMealImage={isGeneratingMealImage}
                onClose={() => closeImageGenerateModal(true)}
                onAddReferenceImages={(files: FileList) => {
                  const newFiles = Array.from(files);
                  setImageReferenceFiles([...useFormDraftStore.getState().imageReferenceFiles, ...newFiles]);
                  newFiles.forEach(file => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                      if (e.target?.result) {
                        setImageReferencePreviews([...useFormDraftStore.getState().imageReferencePreviews, e.target!.result as string]);
                      }
                    };
                    reader.readAsDataURL(file);
                  });
                }}
                onRemoveReferenceImage={removeImageReference}
                onGenerate={generateMealImage}
              />
            )}

            {/* Photo Edit Modal */}
            {activeModal === 'photoEdit' && photoEditMeal && (
              <PhotoEditModal
                isAnalyzingPhoto={photoEditAnalyzeState === 'own'}
                isOtherPhotoAnalyzing={photoEditAnalyzeState === 'other'}
                onClose={() => { setActiveModal(null); setPhotoEditMeal(null); setPhotoFiles([]); setPhotoPreviews([]); }}
                onPhotoSelect={(files: FileList) => {
                  const newFiles = Array.from(files);
                  setPhotoFiles([...useFormDraftStore.getState().photoFiles, ...newFiles]);
                  newFiles.forEach(file => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                      if (e.target?.result) {
                        setPhotoPreviews([...useFormDraftStore.getState().photoPreviews, e.target!.result as string]);
                      }
                    };
                    reader.readAsDataURL(file);
                  });
                }}
                onRemovePhoto={removePhoto}
                onAnalyze={analyzePhotoWithAI}
              />
            )}
          </>
        )}
      </AnimatePresence>

      {/* UX2-11: AI献立生成の中止確認モーダル（window.confirm は使わず styled モーダルに統一）。
          #1050 round-2: 生成中は setActiveModal(null) でモーダル一覧を閉じているため、
          {activeModal && ...} ゲート内にネストしていると生成中に到達不能だった。
          独立コンポーネント化し、activeModal の状態に関係なく描画される
          独立した <AnimatePresence> の直下に置く（型シグネチャに activeModal が無いことで
          再度 activeModal 依存へ戻ることをコンパイル時に防ぐ意図もある）。 */}
      <AnimatePresence>
        <CancelGenerationConfirmModal
          show={showConfirmCancelGeneration}
          onCancel={() => setShowConfirmCancelGeneration(false)}
          onConfirm={handleCancelGeneration}
        />
      </AnimatePresence>

      {/* 完了モーダル */}
      <AnimatePresence>
        {successMessage && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                if (successMessage?.refreshOnDismiss) refreshMealPlan();
                setSuccessMessage(null);
              }}
              className="fixed inset-0 z-[300]"
              style={{ background: 'rgba(0,0,0,0.5)' }}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="fixed inset-0 z-[301] flex items-center justify-center p-4"
            >
              <GenerationResultDialogContent
                message={successMessage}
                onDismiss={() => {
                  // Bug-4対策: 生成完了モーダルを閉じる際に献立データを再取得してキャッシュ不整合を防ぐ
                  // （onRetry 分岐の「閉じる」ボタンでは retry 操作自体が最新化を担うため対象外）
                  if (!successMessage.onRetry && successMessage?.refreshOnDismiss) {
                    refreshMealPlan();
                  }
                  setSuccessMessage(null);
                }}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* V4 AI Generation Modal */}
      {tourMode ? (
        <V4GenerateModal
          mode="sandbox"
          isOpen={showV4Modal}
          onClose={() => { setShowV4Modal(false); }}
          prefilled={MOCK_MENU_RESPONSE}
          loadingDurationMs={HANDSON_TOUR_CONSTANTS.STEP2_LOADING_DURATION_MS}
          apiOptions={{ source: 'handson_tour', sandbox: true }}
          onSandboxComplete={() => { setShowV4Modal(false); }}
          onSandboxError={(err) => { console.error('[tour] sandbox error:', err); setShowV4Modal(false); }}
        />
      ) : (
        <V4GenerateModal
          isOpen={showV4Modal}
          onClose={() => setShowV4Modal(false)}
          mealPlanDays={currentPlan?.days || []}
          weekStartDate={weekDates[0]?.dateStr || formatLocalDate(weekStart)}
          weekEndDate={weekDates[6]?.dateStr || addDaysStr(formatLocalDate(weekStart), 6)}
          onGenerate={handleV4Generate}
          isGenerating={isGenerating}
        />
      )}

      {/* 栄養詳細モーダル */}
      <NutritionDetailModal
        showNutritionDetailModal={showNutritionDetailModal}
        selectedDayIndex={selectedDayIndex}
        weekDates={weekDates}
        dayNutrition={getDayTotalNutrition(currentDay)}
        mealCount={currentDay?.meals?.length || 0}
        radarChartNutrients={radarChartNutrients}
        isEditingRadarNutrients={isEditingRadarNutrients}
        tempRadarNutrients={tempRadarNutrients}
        isSavingRadarNutrients={isSavingRadarNutrients}
        isLoadingFeedback={isLoadingFeedback}
        praiseComment={praiseComment}
        nutritionFeedback={nutritionFeedback}
        nutritionTip={nutritionTip}
        onClose={() => setShowNutritionDetailModal(false)}
        onOpenImprove={() => {
          setShowImproveMealModal(true);
          setImproveNextDay(false);
          const mealsForDay = currentDay?.meals?.map((m: PlannedMeal) => m.mealType) || [];
          const uniqueMeals = [...new Set(mealsForDay)] as MealType[];
          setImproveMealTargets(uniqueMeals.length > 0 ? uniqueMeals : ['breakfast', 'lunch', 'dinner']);
        }}
        onRefetchFeedback={(dateStr) => fetchNutritionFeedback(dateStr, true)}
        onStartEditRadar={() => { dispatchNutrition({ type: 'RADAR_EDIT_START' }); }}
        onCancelEditRadar={() => { dispatchNutrition({ type: 'RADAR_EDIT_CANCEL' }); }}
        onToggleRadarNutrient={(key) => {
          if (tempRadarNutrients.includes(key)) {
            setTempRadarNutrients(tempRadarNutrients.filter(k => k !== key));
          } else if (tempRadarNutrients.length < 8) {
            setTempRadarNutrients([...tempRadarNutrients, key]);
          }
        }}
        onSaveRadarNutrients={async () => {
          if (tempRadarNutrients.length < 3) {
            alert('3個以上選択してください');
            return;
          }
          dispatchNutrition({ type: 'RADAR_SAVING_START' });
          // レーダーの栄養素の書き込み (#2201 U2。保存の前に読んだ取り直しの応答で、保存した栄養素を戻さない)
          const endWrite = receiver.beginWrite();
          try {
            const res = await fetch('/api/profile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ radarChartNutrients: tempRadarNutrients })
            });
            if (res.ok) {
              dispatchNutrition({ type: 'RADAR_SAVING_END', payload: tempRadarNutrients });
            } else {
              dispatchNutrition({ type: 'RADAR_SAVING_CANCEL' });
            }
          } catch (e) {
            console.error('Failed to save radar chart nutrients:', e);
            dispatchNutrition({ type: 'RADAR_SAVING_CANCEL' });
          } finally {
            endWrite();
          }
        }}
      />

      {/* 献立改善の食事選択モーダル */}
      <ImproveMealModal
        showImproveMealModal={showImproveMealModal}
        isImprovingMeal={isImprovingMeal}
        selectedDayIndex={selectedDayIndex}
        weekDates={weekDates}
        improveMealTargets={improveMealTargets}
        improveNextDay={improveNextDay}
        nutritionFeedback={nutritionFeedback}
        currentPlanDays={currentPlan?.days || []}
        onClose={() => setShowImproveMealModal(false)}
        onToggleMealTarget={(type) => {
          if (improveMealTargets.includes(type)) {
            setImproveMealTargets(improveMealTargets.filter(t => t !== type));
          } else {
            setImproveMealTargets([...improveMealTargets, type]);
          }
        }}
        onSelectAllDay={() => {
          setImproveNextDay(false);
          if (improveMealTargets.length === 3) {
            setImproveMealTargets([]);
          } else {
            setImproveMealTargets(['breakfast', 'lunch', 'dinner']);
          }
        }}
        onSelectNextDay={() => {
          const nextIndex = Math.min(selectedDayIndex + 1, weekDates.length - 1);
          if (nextIndex !== selectedDayIndex) {
            setSelectedDayIndex(nextIndex);
            setShowImproveMealModal(false);
            setTimeout(() => {
              setImproveMealTargets(['breakfast', 'lunch', 'dinner']);
              setShowImproveMealModal(true);
            }, 100);
          } else {
            setImproveNextDay(true);
            setImproveMealTargets(['breakfast', 'lunch', 'dinner']);
          }
        }}
        onImprove={handleImprove}
      />

      {/* 外国の AI 事業者へのデータ提供の同意画面 (T15)。未同意なら出る */}
      {consentModal}
    </div>
  );
}

// V4用の日付加算ヘルパー
// #1035残: 旧実装は `new Date(dateStr)`(UTC深夜0時解釈)→ローカル getDate/setDate→toISOString(UTC)
// という parse/format のタイムゾーン不一致があり、非JST(特に西経)クライアントで週境界が1日ズレていた。
// parseLocalDate/addDays（ホストのローカル暦フィールドのみで完結する純粋関数）で解析・加算し、
// 同じくホストのローカル暦フィールド(getFullYear/getMonth/getDate)でそのまま文字列化することで、
// 実行環境のタイムゾーンに関わらず常に同じカレンダー演算結果になるようにする。
function addDaysStr(dateStr: string, days: number): string {
  const date = addDays(parseLocalDate(dateStr), days);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
