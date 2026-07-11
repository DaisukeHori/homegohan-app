"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo, useReducer } from "react";
import {
  weekViewReducer, initialWeekViewState,
  modalReducer, initialModalState,
  aiGenerationReducer, initialAiGenerationState,
  nutritionReducer, initialNutritionState,
  recipeReducer, initialRecipeState,
  uiFlagReducer, initialUiFlagState,
  useServingsConfigStore,
  usePantryStore,
  useShoppingStore,
  useFormDraftStore,
  type LegacyDishDetail,
} from './_state';
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
// #1031: PantryItem/ShoppingList は store selector 経由の型推論に一本化したため import 不要になった
import type { DailyMeal, PlannedMeal, ShoppingListItem, MealMode, MealDishes, DishDetail, TargetSlot, MenuGenerationConstraints, ServingsConfig, DayOfWeek, MealServings, WeekStartDay } from "@/types/domain";
import type { CatalogProductSummary } from "@/types/catalog";
import ReactMarkdown from "react-markdown";
import { useV4MenuGeneration } from "@/hooks/useV4MenuGeneration";
import { notifyMenuGenerated } from "@/lib/local-notification";
import { DEFAULT_RADAR_NUTRIENTS, getNutrientDefinition, calculateDriPercentage, NUTRIENT_DEFINITIONS, NUTRIENT_BY_CATEGORY, CATEGORY_LABELS, THEME_LABELS_REQUEST, AI_CONDITIONS, getDishConfig as getDishConfigShared, type DishConfig, MEAL_LABELS, MEAL_ORDER as MEAL_ORDER_SHARED, PROGRESS_PHASES, ULTIMATE_PROGRESS_PHASES, SHOPPING_LIST_PHASES, type PhaseDefinition, MODE_CONFIG as MODE_CONFIG_SHARED, formatLocalDate, todayLocal, parseLocalDate, addDays, formatExpiry, formatDateJa } from "@homegohan/shared";
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
import { AiMealModal } from "./_components/modals/AiMealModal";
import { RegenerateMealModal } from "./_components/modals/RegenerateMealModal";
import { ImageGenerateModal } from "./_components/modals/ImageGenerateModal";
import { PhotoEditModal } from "./_components/modals/PhotoEditModal";
import { NutritionDetailModal } from "./_components/modals/NutritionDetailModal";
import { ImproveMealModal } from "./_components/modals/ImproveMealModal";

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

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';
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

// 買い物リスト範囲選択の型は #1031 で shoppingStore (_state/shoppingStore.ts) に一本化

// 全ての食事タイプ
const ALL_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'];

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

// AIが自動生成する基本の3食
const BASE_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner'];
// 追加可能な食事タイプ
const EXTRA_MEAL_TYPES: MealType[] = ['snack', 'midnight_snack'];

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
    <div className="flex justify-between">
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
const holidaysCache = new Map<number, Record<string, string>>();

// Fetch Japanese holidays from holidays-jp API
const fetchJapaneseHolidays = async (year: number): Promise<Record<string, string>> => {
  if (holidaysCache.has(year)) {
    return holidaysCache.get(year)!;
  }

  try {
    const response = await fetch(`https://holidays-jp.github.io/api/v1/${year}/date.json`);
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

// UX2-10: V4進捗をUI形式に変換するヘルパー関数。
// モジュールスコープの純関数として定義し、生成進捗の変換ロジックをこの1箇所に統一する
// （以前は復元/handleV4Generate/ポーリング等4箇所に類似ロジックが重複し、計算式が不一致だった）。
// 単調増加ガードは呼び出し側の aiGenerationReducer(GEN_PROGRESS) で行う。
const convertV4ProgressToUIFormat = (progress: {
  phase?: string;
  message?: string;
  percentage?: number;
  currentStep?: number;
  totalSteps?: number;
  completedSlots?: number;
  totalSlots?: number;
}) => {
  const completedSlots = progress.completedSlots || 0;
  const totalSlots = progress.totalSlots || 0;

  // 既にUI形式の場合はそのまま返す（totalSlotsを追加）
  if (progress.phase && progress.percentage !== undefined) {
    return {
      phase: progress.phase,
      message: progress.message || '',
      percentage: progress.percentage,
      totalSlots,
      completedSlots,
    };
  }

  // V4形式の場合はUI形式に変換
  if (progress.currentStep !== undefined && progress.totalSteps !== undefined) {
    const message = progress.message || 'AIが献立を生成中...';
    const currentStep = progress.currentStep;
    const isUltimateMode = progress.totalSteps === 6;

    let phase = 'generating';
    let percentage = 0;

    if (isUltimateMode) {
      // 究極モード（6ステップ）
      // Step 1 (0-25%): 生成フェーズ
      if (currentStep === 1 || currentStep === 0) {
        if (message.includes('ユーザー情報') || message.includes('取得中')) {
          phase = 'user_context';
          percentage = 3;
        } else if (message.includes('参考') || message.includes('検索中')) {
          phase = 'search_references';
          percentage = 6;
        } else if (message.includes('生成完了')) {
          phase = 'step1_complete';
          percentage = 25;
        } else {
          phase = 'generating';
          percentage = 8 + Math.round((completedSlots / Math.max(totalSlots, 1)) * 15);
        }
      }
      // Step 2 (25-38%): レビューフェーズ
      else if (currentStep === 2) {
        if (message.includes('バランス') || message.includes('チェック中') || message.includes('重複')) {
          phase = 'reviewing';
          percentage = 28;
        } else if (message.includes('改善中')) {
          phase = 'fixing';
          percentage = 32;
        } else if (message.includes('レビュー完了')) {
          phase = 'step2_complete';
          percentage = 38;
        } else {
          phase = 'reviewing';
          percentage = 30;
        }
      }
      // Step 3 (38-48%): 栄養計算フェーズ（究極モードでは保存しない）
      else if (currentStep === 3) {
        if (message.includes('栄養計算') || message.includes('栄養')) {
          phase = 'calculating';
          percentage = 42;
        } else if (message.includes('完了')) {
          phase = 'step3_complete';
          percentage = 48;
        } else {
          phase = 'calculating';
          percentage = 45;
        }
      }
      // Step 4 (48-62%): 栄養バランス詳細分析
      else if (currentStep === 4) {
        phase = 'nutrition_analyzing';
        const match = message.match(/(\d+)\/(\d+)/);
        if (match) {
          const current = parseInt(match[1]);
          const total = parseInt(match[2]);
          percentage = 50 + Math.round((current / Math.max(total, 1)) * 12);
        } else {
          percentage = 55;
        }
      }
      // Step 5 (62-82%): 献立改善
      else if (currentStep === 5) {
        phase = 'improving';
        const match = message.match(/(\d+)\/(\d+)/);
        if (match) {
          const current = parseInt(match[1]);
          const total = parseInt(match[2]);
          percentage = 65 + Math.round((current / Math.max(total, 1)) * 17);
        } else {
          percentage = 70;
        }
      }
      // Step 6 (82-100%): 最終保存
      else if (currentStep === 6) {
        if (message.includes('完了') || message.includes('完成')) {
          phase = 'completed';
          percentage = 100;
        } else {
          phase = 'final_saving';
          const match = message.match(/(\d+)\/(\d+)/);
          if (match) {
            const current = parseInt(match[1]);
            const total = parseInt(match[2]);
            percentage = 85 + Math.round((current / Math.max(total, 1)) * 13);
          } else {
            percentage = 90;
          }
        }
      }
    } else {
      // 通常モード（3ステップ）
      // Step 1 (0-40%): 生成フェーズ
      if (currentStep === 1 || currentStep === 0) {
        if (message.includes('ユーザー情報') || message.includes('取得中')) {
          phase = 'user_context';
          percentage = 5;
        } else if (message.includes('参考') || message.includes('検索中')) {
          phase = 'search_references';
          percentage = 10;
        } else {
          phase = 'generating';
          percentage = 12 + Math.round((completedSlots / Math.max(totalSlots, 1)) * 28);
        }
      }
      // Step 2 (40-75%): レビューフェーズ
      else if (currentStep === 2) {
        if (message.includes('バランス') || message.includes('チェック中') || message.includes('重複')) {
          phase = 'reviewing';
          percentage = 47;
        } else if (message.includes('改善中')) {
          phase = 'fixing';
          const match = message.match(/(\d+)\/(\d+)/);
          if (match) {
            const current = parseInt(match[1]);
            const total = parseInt(match[2]);
            percentage = 58 + Math.round((current / Math.max(total, 1)) * 12);
          } else {
            percentage = 60;
          }
        } else if (message.includes('問題なし')) {
          phase = 'no_issues';
          percentage = 72;
        } else if (message.includes('レビュー完了')) {
          phase = 'step2_complete';
          percentage = 75;
        } else {
          phase = 'reviewing';
          percentage = 50;
        }
      }
      // Step 3 (75-100%): 保存フェーズ
      else if (currentStep === 3) {
        if (message.includes('栄養計算') || message.includes('栄養')) {
          phase = 'calculating';
          percentage = 80;
        } else if (message.includes('保存中')) {
          phase = 'saving';
          const match = message.match(/(\d+)\/(\d+)/);
          if (match) {
            const current = parseInt(match[1]);
            const total = parseInt(match[2]);
            percentage = 88 + Math.round((current / Math.max(total, 1)) * 10);
          } else {
            percentage = 90;
          }
        } else if (message.includes('完了') || message.includes('保存しました')) {
          phase = 'completed';
          percentage = 100;
        } else {
          phase = 'saving';
          percentage = 88;
        }
      }
    }

    return {
      phase,
      message,
      percentage: Math.round(percentage),
      totalSlots,
      completedSlots,
      isUltimateMode,
    };
  }

  // フォールバック
  return {
    phase: 'generating',
    message: progress.message || 'AIが献立を生成中...',
    percentage: 0,
    totalSlots,
    completedSlots,
  };
};

// ============================================
// Main Component
// ============================================

export default function WeeklyMenuPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

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
  const setCurrentPlan = useCallback((plan: WeekPlan | null | ((prev: WeekPlan | null) => WeekPlan | null)) => {
    if (typeof plan === 'function') {
      // functional update: 現在の state を取得して適用 (この箇所では直接呼べないため dispatch 経由)
      // NOTE: functional update は使用箇所ごとに展開済み
      dispatchWeekView({ type: 'PLAN_SET', payload: plan(weekView.currentPlan) });
    } else {
      dispatchWeekView({ type: 'PLAN_SET', payload: plan });
    }
  }, [weekView.currentPlan]);

  const weekStart = weekView.weekStart;
  const setWeekStart = useCallback((d: Date) => dispatchWeekView({ type: 'WEEK_SET_START', payload: d }), []);
  // UX2-24: 前週/次週ボタン専用。selectedDayIndex をリセットしない WEEK_NAVIGATE_* を dispatch する
  const navigateWeekPrev = useCallback((d: Date) => dispatchWeekView({ type: 'WEEK_NAVIGATE_PREV', payload: d }), []);
  const navigateWeekNext = useCallback((d: Date) => dispatchWeekView({ type: 'WEEK_NAVIGATE_NEXT', payload: d }), []);

  const selectedDayIndex = weekView.selectedDayIndex;
  const setSelectedDayIndex = useCallback((idx: number) => dispatchWeekView({ type: 'DAY_SELECT', payload: idx }), []);

  const isCalendarExpanded = weekView.isCalendarExpanded;
  const setIsCalendarExpanded = useCallback((_v: boolean | ((prev: boolean) => boolean)) => dispatchWeekView({ type: 'CALENDAR_TOGGLE' }), []);

  const displayMonth = weekView.displayMonth;
  const setDisplayMonth = useCallback((d: Date | ((prev: Date) => Date)) => {
    const next = typeof d === 'function' ? d(weekView.displayMonth) : d;
    dispatchWeekView({ type: 'DISPLAY_MONTH_SET', payload: next });
  }, [weekView.displayMonth]);

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
  const setHolidays = useCallback((v: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => {
    const next = typeof v === 'function' ? v(weekView.holidays) : v;
    dispatchWeekView({ type: 'HOLIDAYS_SET', payload: next });
  }, [weekView.holidays]);

  const calendarMealDates = weekView.calendarMealDates;
  const setCalendarMealDates = useCallback((v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    if (typeof v === 'function') {
      dispatchWeekView({ type: 'CALENDAR_MEAL_DATES_SET', payload: v(weekView.calendarMealDates) });
    } else {
      dispatchWeekView({ type: 'CALENDAR_MEAL_DATES_SET', payload: v });
    }
  }, [weekView.calendarMealDates]);

  const expandedMealId = weekView.expandedMealId;
  const setExpandedMealId = useCallback((id: string | null) => dispatchWeekView({ type: 'MEAL_EXPAND', payload: id }), []);

  const hasAutoExpanded = weekView.hasAutoExpanded;
  // F1b-05: true 化は AUTO_EXPAND_SUPPRESS に委譲（自動展開の抑止フラグを正しく立てる）。
  // false 化は WEEK_SET_START/WEEK_NAVIGATE_* action が既にリセットするため no-op のまま。
  const setHasAutoExpanded = useCallback((v: boolean) => {
    if (v) dispatchWeekView({ type: 'AUTO_EXPAND_SUPPRESS' });
  }, []);

  const isDayNutritionExpanded = weekView.isDayNutritionExpanded;
  // F1b-04: 無条件 TOGGLE ではなく渡された真偽値（関数の場合は現在値から解決）を反映する
  const setIsDayNutritionExpanded = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(weekView.isDayNutritionExpanded) : v;
    dispatchWeekView({ type: 'DAY_NUTRITION_SET', payload: next });
  }, [weekView.isDayNutritionExpanded]);

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

  const generatingMeal = aiGen.generatingMeal;
  const setGeneratingMeal = useCallback((m: { dayIndex: number; mealType: MealType } | null) => dispatchAiGen({ type: 'GENERATING_MEAL_SET', payload: m }), []);

  const generationProgress = aiGen.generationProgress;
  // F1b-03: functional update を正しく現在値から解決してから dispatch する。
  // null 解決時は GEN_SUCCESS ではなく GEN_PROGRESS_CLEAR（isGenerating/generatingMeal を巻き込まない）。
  const setGenerationProgress = useCallback((v: typeof aiGen.generationProgress | ((prev: typeof aiGen.generationProgress) => typeof aiGen.generationProgress)) => {
    const next = typeof v === 'function' ? v(aiGen.generationProgress) : v;
    if (next === null) {
      dispatchAiGen({ type: 'GEN_PROGRESS_CLEAR' });
    } else {
      dispatchAiGen({ type: 'GEN_PROGRESS', payload: next });
    }
  }, [aiGen.generationProgress]);

  const generationFailedError = aiGen.generationFailedError;
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
  const setIsAnalyzingPhoto = useCallback((v: boolean) => {
    if (v) dispatchAiGen({ type: 'PHOTO_ANALYZE_START' });
    else dispatchAiGen({ type: 'PHOTO_ANALYZE_END' });
  }, []);

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
  const loading = uiFlag.loading;
  const setLoading = useCallback((v: boolean) => dispatchUiFlag({ type: 'LOADING_SET', payload: v }), []);

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
      setHolidays(prev => ({ ...prev, ...data }));
      // Also fetch adjacent year if near year boundary
      const month = displayMonth.getMonth();
      if (month === 0) {
        const prevYearData = await fetchJapaneseHolidays(year - 1);
        setHolidays(prev => ({ ...prev, ...prevYearData }));
      } else if (month === 11) {
        const nextYearData = await fetchJapaneseHolidays(year + 1);
        setHolidays(prev => ({ ...prev, ...nextYearData }));
      }
    };
    fetchHolidays();
  }, [displayMonth]);

  // Sync displayMonth when weekStart changes
  useEffect(() => {
    setDisplayMonth(weekStart);
  }, [weekStart]);

  // Calendar meal dates - 月カレンダー用の献立存在日マップ（weekViewReducer 管理）
  const fetchedRangesRef = useRef<Set<string>>(new Set()); // 既にフェッチした範囲を記録

  // Fetch meal dates for a range and accumulate (helper function)
  const fetchAndCacheMealDates = useCallback(async (startDate: Date, endDate: Date) => {
    const rangeKey = `${formatLocalDate(startDate)}_${formatLocalDate(endDate)}`;

    // 既にフェッチ済みの範囲はスキップ
    if (fetchedRangesRef.current.has(rangeKey)) return;
    fetchedRangesRef.current.add(rangeKey);

    try {
      const res = await fetch(`/api/meal-plans?startDate=${formatLocalDate(startDate)}&endDate=${formatLocalDate(endDate)}`);
      if (res.ok) {
        const { dailyMeals } = await res.json();
        const newDates = new Set<string>();
        dailyMeals?.forEach((day: any) => {
          if (day.meals && day.meals.length > 0) {
            newDates.add(day.dayDate);
          }
        });
        // 既存のデータに追加（置き換えではなく累積）
        dispatchWeekView({ type: 'CALENDAR_MEAL_DATES_MERGE', payload: newDates });
      }
    } catch (error) {
      console.error('Failed to fetch calendar meal dates:', error);
      // エラー時はキャッシュをクリアして再試行可能に
      fetchedRangesRef.current.delete(rangeKey);
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

  // dailyMeals から献立存在日を同期（献立がない日は削除）
  const syncCalendarMealDatesFromDailyMeals = useCallback((dailyMeals: any[]) => {
    if (!dailyMeals) return;

    const updated = new Set(weekView.calendarMealDates);
    dailyMeals.forEach((day: any) => {
      if (day.meals && day.meals.length > 0) {
        updated.add(day.dayDate);
      } else {
        updated.delete(day.dayDate);
      }
    });
    dispatchWeekView({ type: 'CALENDAR_MEAL_DATES_SET', payload: updated });
  }, [weekView.calendarMealDates]);

  // 週が変わるタイミングで前後2週間をプリフェッチ
  useEffect(() => {
    const prefetchAdjacentWeeks = async () => {
      const currentWeekStart = new Date(weekStart);

      // 前後2週間 = 合計5週間分をフェッチ
      const startDate = new Date(currentWeekStart);
      startDate.setDate(startDate.getDate() - 14); // 2週間前
      const endDate = new Date(currentWeekStart);
      endDate.setDate(endDate.getDate() + 28); // 4週間後（現在週含む）

      await fetchAndCacheMealDates(startDate, endDate);
    };

    prefetchAdjacentWeeks();
  }, [weekStart, fetchAndCacheMealDates]);

  // displayMonth が変わったときも追加でフェッチ（月移動時）
  useEffect(() => {
    const fetchMonthMealDates = async () => {
      const year = displayMonth.getFullYear();
      const month = displayMonth.getMonth();
      // 表示月の前後1週間を含む範囲
      const firstDay = new Date(year, month, 1);
      const lastDay = new Date(year, month + 1, 0);
      const startDate = new Date(firstDay);
      startDate.setDate(startDate.getDate() - 7);
      const endDate = new Date(lastDay);
      endDate.setDate(endDate.getDate() + 7);

      await fetchAndCacheMealDates(startDate, endDate);
    };

    fetchMonthMealDates();
  }, [displayMonth, fetchAndCacheMealDates]);

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
      
      // 今日の場合は時間帯優先、それ以外は朝食から
      const priorities = dayIdx === todayIndex ? mealPriority : ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'];
      
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

  // -------------------------------------------------------
  // Membership: Family view switcher state
  // -------------------------------------------------------
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [familyId, setFamilyId] = useState<string | null>(null);
  const { viewState, setView } = useFamilyView(familyId);

  // 家族情報ロード (家族に所属している場合のみ switcher 表示)
  useEffect(() => {
    const loadFamilyData = async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setCurrentUserId(user.id);

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('family_id')
        .eq('id', user.id)
        .maybeSingle();
      if (!profile?.family_id) return;
      setFamilyId(profile.family_id);

      const { data: members } = await supabase
        .from('family_members')
        .select('id, family_id, user_id, role, display_name, relationship, tags, share_meals, share_health, share_menu, child_profile, avatar_color, status, joined_at, removed_at')
        .eq('family_id', profile.family_id)
        .eq('status', 'active');
      if (members) {
        setFamilyMembers(members as FamilyMember[]);
      }
    };
    loadFamilyData();
  }, []);

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

  // Meal Plan再取得関数（キャッシュも更新）
  const refreshMealPlan = useCallback(async () => {
    const targetDate = formatLocalDate(weekStart);
    const endDate = addDaysStr(targetDate, 6);
    try {
      const res = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
      if (res.ok) {
        const { dailyMeals, shoppingList: shoppingListData } = await res.json();
        if (dailyMeals && dailyMeals.length > 0) {
          const newPlan = { days: dailyMeals };
          const newShoppingList = shoppingListData?.items || [];
          setCurrentPlan(newPlan);
          if (newShoppingList.length > 0) setShoppingList(newShoppingList);
          updateCalendarMealDatesFromDailyMeals(dailyMeals);
          // キャッシュも更新
          weekDataCache.current.set(targetDate, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
        } else {
          setCurrentPlan(null);
          // 空の場合もキャッシュを更新
          weekDataCache.current.set(targetDate, { plan: null, shoppingList: [], fetchedAt: Date.now() });
        }
      }
    } catch (e) {
      console.error('Failed to refresh meal plan:', e);
    }
  }, [weekStart, updateCalendarMealDatesFromDailyMeals]);

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
        const { requestId, timestamp, totalSlots } = JSON.parse(stored);
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
            payload: { error: currentStatus.errorMessage || '生成に失敗しました', requestId },
          });
          return;
        }

        // まだ進行中の場合、UI状態を復元して進捗追跡を再開
        setIsGenerating(true);

        // 現在の進捗をDBの値から復元（UX2-10: 変換ロジックはconvertV4ProgressToUIFormatに一本化）
        const dbProgress = currentStatus?.progress || { totalSlots };
        setGenerationProgress(convertV4ProgressToUIFormat(dbProgress));

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
              payload: { error: progress.errorMessage || '生成に失敗しました', requestId },
            });
            return;
          }

          setGenerationProgress(convertV4ProgressToUIFormat(progress));
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

      // 初期進捗を設定（totalSlotsを含める）
      const initialTotalSlots = result?.totalSlots || params.targetSlots.length;
      setGenerationProgress({
        phase: 'user_context',
        message: 'ユーザー情報を取得中...',
        percentage: 3,
        totalSlots: initialTotalSlots,
        completedSlots: 0,
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
        v4PollingIntervalRef.current = setInterval(async () => {
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
            } else if (status === 'failed') {
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
              // Realtimeが届いていない間も進捗表示を維持（nullの場合のみ上書き）
              setGenerationProgress((prev) => prev ?? convertV4ProgressToUIFormat(dbProgress));
            }
          } catch {
            // ポーリングエラーは無視して継続
          }
        }, 5000);

        v4Generation.subscribeToProgress(v4RequestId, (progress) => {
          // Realtimeが端末ステータスを受信したらポーリングを停止する
          if (progress.status === 'completed' || progress.status === 'failed') {
            v4ResolvedRef.current = true;
            if (v4PollingIntervalRef.current) {
              clearInterval(v4PollingIntervalRef.current);
              v4PollingIntervalRef.current = null;
            }
          }
          // UX2-10: 変換ロジックはconvertV4ProgressToUIFormatに一本化（重複実装の解消）
          setGenerationProgress(convertV4ProgressToUIFormat(progress));
        });
      }
    } catch (error) {
      // Error already handled in hook
    }
  };

  // Supabase Realtime チャンネルを保持（クリーンアップ用）
  const realtimeChannelRef = useRef<RealtimeChannel | null>(null);
  const supabaseRef = useRef(createClient());
  
  // 生成中状態のチェックが進行中かどうかを追跡（重複API呼び出し防止）
  const isCheckingPendingRef = useRef(false);

  // #120: restoreGeneration が完了するまで checkPendingRequests をブロックするフラグ
  const isRestoringRef = useRef(true);
  
  // Realtime サブスクリプションをクリーンアップする関数
  const cleanupRealtime = useCallback(() => {
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
  
  // 生成中状態をDBから復元し、ポーリングを再開
  useEffect(() => {
    // 既にポーリング中なら何もしない
    if (realtimeChannelRef.current) return;
    // 既に生成中状態なら何もしない（重複防止）
    if (isGenerating || generatingMeal) return;
    // 既にチェック中なら何もしない（重複API呼び出し防止）
    if (isCheckingPendingRef.current) return;
    // #120: restoreGeneration が完了するまで待機（二重起動防止）
    if (isRestoringRef.current) return;

    const checkPendingRequests = async () => {
      // チェック開始をマーク
      isCheckingPendingRef.current = true;
      
      try {
        const targetDate = formatLocalDate(weekStart);
        console.log('🔍 checkPendingRequests called with targetDate:', targetDate);
        
        // 0. まずスタックしたリクエストを自動クリーンアップ（5分以上前のprocessing/pending）
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
            const { hasPending, requestId, status, startDate: pendingStartDate } = data;
            if (hasPending && requestId) {
              console.log('📦 週間献立の生成中リクエストを復元:', requestId, status, 'startDate:', pendingStartDate);
              
              // もし生成中のリクエストの週が現在表示中の週と異なる場合、その週に遷移
              if (pendingStartDate && pendingStartDate !== targetDate) {
                console.log('🔄 週を切り替え:', targetDate, '->', pendingStartDate);
                setWeekStart(new Date(pendingStartDate));
              }
              
              setIsGenerating(true);
              subscribeToRequestStatus(pendingStartDate || targetDate, requestId);
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
              const dayIdx = weekDates.findIndex(d => d.dateStr === targetDayDate);
              
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
                  subscribeToRequestStatus(targetDate, latestRequest.requestId);
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
                    subscribeToRequestStatus(targetDate, requestId);
                    return;
                  } else if (status === 'failed') {
                    // 失敗の場合はエラーモーダルを表示してlocalStorageをクリア
                    console.log('❌ 週間献立の生成失敗を復元:', requestId);
                    localStorage.removeItem('weeklyMenuGenerating');
                    dispatchAiGen({
                      type: 'GEN_FAIL',
                      payload: { error: error_message || '献立の生成に失敗しました。もう一度お試しください。', requestId },
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
                    subscribeToRequestStatus(targetDate, requestId);
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
    };
    
    checkPendingRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, weekDates, isGenerating, generatingMeal]);  // subscribeToRequestStatus / subscribeToRegenerateStatus はファイル後方で定義されるため前方参照エラーになる。両関数は useCallback で安定参照のため再実行は発生しない
  
  
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

  // feedbackChannelRef (nutrition 系は nutritionReducer 管理)
  // RealtimeChannel か、ポーリング用のカスタムクリーンアップオブジェクトのどちらかを保持する
  const feedbackChannelRef = useRef<RealtimeChannel | { unsubscribe: () => void } | null>(null);

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

  // レシピモーダルが開いたとき、お気に入り状態を取得
  useEffect(() => {
    if (!selectedRecipe) {
      setIsFavorite(false);
      return;
    }
    const encodedId = encodeURIComponent(selectedRecipe);
    fetch(`/api/recipes/${encodedId}/like`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setIsFavorite(data.liked); })
      .catch(() => {/* 取得失敗は無視 */});
  }, [selectedRecipe]);

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

  // Fetch Plan & Check for pending generation requests
  useEffect(() => {
    // weekStartDay の設定が確定するまで待機（二重フェッチ防止）
    if (!weekStartDayLoaded) return;

    const CACHE_TTL = 5 * 60 * 1000; // 5分間キャッシュ有効

    // 週データを取得する共通関数
    const fetchWeekData = async (weekStartDate: Date): Promise<{ plan: WeekPlan | null; shoppingList: ShoppingListItem[] }> => {
      const targetDate = formatLocalDate(weekStartDate);
      const endDate = addDaysStr(targetDate, 6);
      const res = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
      if (res.ok) {
        const { dailyMeals, shoppingList: shoppingListData } = await res.json();
        if (dailyMeals && dailyMeals.length > 0) {
          return { plan: { days: dailyMeals }, shoppingList: shoppingListData?.items || [] };
        }
      }
      return { plan: null, shoppingList: [] };
    };

    // 前後の週をバックグラウンドでプリフェッチ
    const prefetchAdjacentWeeks = async (currentWeekStart: Date) => {
      const prevWeekStart = new Date(currentWeekStart);
      prevWeekStart.setDate(currentWeekStart.getDate() - 7);
      const nextWeekStart = new Date(currentWeekStart);
      nextWeekStart.setDate(currentWeekStart.getDate() + 7);

      const prevKey = formatLocalDate(prevWeekStart);
      const nextKey = formatLocalDate(nextWeekStart);
      const now = Date.now();

      // 前の週をプリフェッチ
      const prevCache = weekDataCache.current.get(prevKey);
      if (!prevCache || (now - prevCache.fetchedAt > CACHE_TTL)) {
        fetchWeekData(prevWeekStart).then(data => {
          weekDataCache.current.set(prevKey, { ...data, fetchedAt: Date.now() });
        }).catch(() => {});
      }

      // 次の週をプリフェッチ
      const nextCache = weekDataCache.current.get(nextKey);
      if (!nextCache || (now - nextCache.fetchedAt > CACHE_TTL)) {
        fetchWeekData(nextWeekStart).then(data => {
          weekDataCache.current.set(nextKey, { ...data, fetchedAt: Date.now() });
        }).catch(() => {});
      }
    };

    const fetchPlan = async () => {
      const targetDateStr = formatLocalDate(weekStart);
      const now = Date.now();

      // キャッシュをチェック
      const cached = weekDataCache.current.get(targetDateStr);
      if (cached && (now - cached.fetchedAt < CACHE_TTL)) {
        // キャッシュヒット - 即座に反映
        setCurrentPlan(cached.plan);
        if (cached.shoppingList.length > 0) setShoppingList(cached.shoppingList);
        if (cached.plan) autoExpandNextMeal(cached.plan, weekDates);
        // バックグラウンドで前後の週をプリフェッチ
        prefetchAdjacentWeeks(weekStart);
        return;
      }

      // キャッシュミス - APIから取得
      setLoading(true);
      try {
        const data = await fetchWeekData(weekStart);
        // キャッシュに保存
        weekDataCache.current.set(targetDateStr, { ...data, fetchedAt: Date.now() });

        setCurrentPlan(data.plan);
        if (data.shoppingList.length > 0) setShoppingList(data.shoppingList);
        if (data.plan) autoExpandNextMeal(data.plan, weekDates);

        // DBで生成中のリクエストがあるか確認
        const pendingRes = await fetch(`/api/ai/menu/weekly/pending?date=${targetDateStr}`);
        if (pendingRes.ok) {
          const { hasPending, requestId } = await pendingRes.json();
          if (hasPending && requestId) {
            // 生成中状態を復元してポーリング開始
            setIsGenerating(true);
            subscribeToRequestStatus(targetDateStr, requestId);
          }
        }

        // バックグラウンドで前後の週をプリフェッチ
        prefetchAdjacentWeeks(weekStart);
      } catch (e) {
        console.error("Failed to fetch meal plan", e);
        setCurrentPlan(null);
      } finally {
        setLoading(false);
      }
    };
    fetchPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, weekStartDayLoaded]);  // autoExpandNextMeal / weekDates / subscribeToRequestStatus を除外: 追加すると不要な再フェッチが発生するため
  
  // Fetch servings config and radar chart nutrients from user profile
  useEffect(() => {
    const fetchUserSettings = async () => {
      setIsLoadingServingsConfig(true);
      try {
        const res = await fetch('/api/profile');
        if (res.ok) {
          const profile = await res.json();
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
          }
          // Radar chart nutrients
          if (profile.radar_chart_nutrients && Array.isArray(profile.radar_chart_nutrients)) {
            setRadarChartNutrients(profile.radar_chart_nutrients);
          }
        }
      } catch (e) {
        console.error('Failed to fetch user settings:', e);
      } finally {
        setIsLoadingServingsConfig(false);
      }
    };
    fetchUserSettings();
  }, []);
  
  // フォールバックポーリング用の参照
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // #1033 F1b-06: 単品再生成のRealtimeが切断した場合のフォールバックポーリング/タイムアウト用の参照
  const regeneratePollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const regenerateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // #1033 F1b-06: 献立改善(onImprove)のRealtimeが切断した場合のフォールバックポーリング/タイムアウト用の参照
  const improvePollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const improveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // V4生成のRealtimeが切断した場合のフォールバックポーリング用の参照
  const v4PollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // UX2-11: ユーザーが「中止する」を押した後に届く遅延イベント（失敗コールバック等）で
  // 生の error_message がそのまま alert 表示されないようにするガード
  const generationCancelledRef = useRef(false);

  // 週データキャッシュ（前後の週をプリフェッチして高速化）
  const weekDataCache = useRef<Map<string, { plan: WeekPlan | null; shoppingList: ShoppingListItem[]; fetchedAt: number }>>(new Map());
  
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

    // サーバー側にも中止を通知（ベストエフォート）
    if (cancelRequestId) {
      try {
        await fetch('/api/ai/menu/weekly/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: cancelRequestId }),
        });
      } catch (e) {
        console.error('Failed to notify server of cancellation:', e);
      }
    }
  }, [cleanupRealtime, cleanupPolling, setIsGenerating, setGenerationProgress, setGeneratingMeal, setSuccessMessage, setShowConfirmCancelGeneration]);

  // ポーリングで進捗を取得
  const startPolling = useCallback((targetDate: string, requestId: string) => {
    console.log('⏱️ Starting fallback polling for requestId:', requestId);
    cleanupPolling();
    
    const poll = async () => {
      try {
        const res = await fetch(`/api/ai/menu/weekly/status?requestId=${requestId}`);
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
          window.location.href = '/login';
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        
        if (data.progress) {
          const uiProgress = convertV4ProgressToUIFormat(data.progress);
          setGenerationProgress(uiProgress);
        }
        
        if (data.status === 'completed') {
          console.log('✅ Polling: Generation completed');
          const endDate = addDaysStr(targetDate, 6);
          const planRes = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
          if (planRes.ok) {
            const { dailyMeals, shoppingList: shoppingListData } = await planRes.json();
            if (dailyMeals && dailyMeals.length > 0) {
              const newPlan = { days: dailyMeals };
              const newShoppingList = shoppingListData?.items || [];
              setCurrentPlan(newPlan);
              if (newShoppingList.length > 0) setShoppingList(newShoppingList);
              updateCalendarMealDatesFromDailyMeals(dailyMeals);
              // キャッシュも更新
              weekDataCache.current.set(targetDate, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
            }
          }
          setIsGenerating(false);
          setGeneratingMeal(null);
          setGenerationProgress(null);
          localStorage.removeItem('weeklyMenuGenerating');
          localStorage.removeItem('singleMealGenerating');
          cleanupPolling();
          cleanupRealtime();
        } else if (data.status === 'failed') {
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
            payload: { error: data.error_message || '献立の生成に失敗しました。もう一度お試しください。', requestId },
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
  }, [cleanupPolling, cleanupRealtime, updateCalendarMealDatesFromDailyMeals]);

  // Realtime で生成完了を監視（常にポーリングも並行実行）
  const subscribeToRequestStatus = useCallback((targetDate: string, requestId: string) => {
    // 既存のサブスクリプションをクリーンアップ
    cleanupRealtime();
    cleanupPolling();
    
    console.log('📡 Subscribing to Realtime for requestId:', requestId);
    
    // 常にポーリングも開始（Realtimeの信頼性が低いため）
    startPolling(targetDate, requestId);
    
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
              const uiProgress = convertV4ProgressToUIFormat(newData.progress);
              setGenerationProgress(uiProgress);
            }
            
            if (newStatus === 'completed') {
              // 完了したら献立を再取得
              console.log('✅ Generation completed, fetching meal plan...');
              try {
                const endDate = addDaysStr(targetDate, 6);
                const planRes = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
                if (planRes.ok) {
                  const { dailyMeals, shoppingList: shoppingListData } = await planRes.json();
                  if (dailyMeals && dailyMeals.length > 0) {
                    const newPlan = { days: dailyMeals };
                    const newShoppingList = shoppingListData?.items || [];
                    setCurrentPlan(newPlan);
                    if (newShoppingList.length > 0) setShoppingList(newShoppingList);
                    updateCalendarMealDatesFromDailyMeals(dailyMeals);
                    // キャッシュも更新（リアルタイム反映）
                    weekDataCache.current.set(targetDate, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
                  }
                }
              } catch (fetchErr) {
                console.error('❌ Failed to fetch meal plan:', fetchErr);
              }
              setIsGenerating(false);
              setGeneratingMeal(null);
              setGenerationProgress(null);
              localStorage.removeItem('weeklyMenuGenerating');
              localStorage.removeItem('singleMealGenerating');
              cleanupRealtime();
            } else if (newStatus === 'failed') {
              console.log('❌ Generation failed');
              setIsGenerating(false);
              setGeneratingMeal(null);
              setGenerationProgress(null);
              localStorage.removeItem('weeklyMenuGenerating');
              localStorage.removeItem('singleMealGenerating');
              cleanupRealtime();
              dispatchAiGen({
                type: 'GEN_FAIL',
                payload: { error: newData.error_message || '献立の生成に失敗しました。もう一度お試しください。', requestId },
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
          if (!realtimeConnected) {
            console.warn('📡 Realtime failed, falling back to polling');
            startPolling(targetDate, requestId);
          }
        }
      });
    
    realtimeChannelRef.current = channel;
    
    // 5秒後にRealtimeが接続できていなければポーリング開始
    setTimeout(() => {
      if (!realtimeConnected && !pollingIntervalRef.current) {
        console.warn('📡 Realtime not connected after 5s, starting polling');
        startPolling(targetDate, requestId);
      }
    }, 5000);
  }, [cleanupRealtime, cleanupPolling, startPolling, updateCalendarMealDatesFromDailyMeals]);

  // ポーリングのクリーンアップ（アンマウント時）
  useEffect(() => {
    return () => {
      cleanupPolling();
    };
  }, [cleanupPolling]);
  
  // Fetch Pantry
  useEffect(() => {
    const fetchPantry = async () => {
      try {
        const res = await fetch('/api/pantry');
        if (res.ok) {
          const data = await res.json();
          usePantryStore.getState().setFridgeItems(data.items || []);
        }
      } catch (e) {
        console.error("Failed to fetch pantry:", e);
      }
    };
    fetchPantry();
  }, []);

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
    
    const supabase = supabaseRef.current;
    
    // 既存の購読/ポーリングをクリーンアップ
    if (feedbackChannelRef.current) {
      if ('unsubscribe' in feedbackChannelRef.current) {
        feedbackChannelRef.current.unsubscribe();
      } else {
        supabase.removeChannel(feedbackChannelRef.current);
      }
      feedbackChannelRef.current = null;
    }
    
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
      
      if (res.ok) {
        const data = await res.json();
        
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
          
          let isResolved = false;
          
          // ポーリングを設定（フォールバック用、2秒間隔）
          let pollCount = 0;
          const maxPolls = 20; // 40秒
          
          const pollInterval = setInterval(async () => {
            if (isResolved) {
              clearInterval(pollInterval);
              return;
            }
            
            pollCount++;
            
            try {
              const pollRes = await fetch(`/api/ai/nutrition/feedback?cacheId=${cacheId}`);
              if (pollRes.ok) {
                const pollData = await pollRes.json();
                
                if (pollData.status === 'completed' && (pollData.feedback || pollData.praiseComment)) {
                  if (!isResolved) {
                    isResolved = true;
                    setNutritionFeedback(pollData.advice || pollData.feedback || '');
                    setPraiseComment(pollData.praiseComment || null);
                    setNutritionTip(pollData.nutritionTip || null);
                    setIsLoadingFeedback(false);
                    clearInterval(pollInterval);
                    console.log('Nutrition feedback received via polling');
                  }
                } else if (pollData.status === 'error') {
                  if (!isResolved) {
                    isResolved = true;
                    setNutritionFeedback(pollData.advice || pollData.feedback || '分析中にエラーが発生しました。');
                    setPraiseComment(null);
                    setNutritionTip(null);
                    setIsLoadingFeedback(false);
                    clearInterval(pollInterval);
                  }
                }
              }
            } catch (e) {
              console.error('Polling error:', e);
            }
            
            // タイムアウト
            if (pollCount >= maxPolls && !isResolved) {
              isResolved = true;
              clearInterval(pollInterval);
              setNutritionFeedback('分析がタイムアウトしました。再分析をお試しください。');
              setIsLoadingFeedback(false);
            }
          }, 2000);
          
          // Realtimeも設定（より高速な通知のため）
          const channel = supabase
            .channel(`nutrition_feedback_${cacheId}`)
            .on(
              'postgres_changes',
              {
                event: 'UPDATE',
                schema: 'public',
                table: 'nutrition_feedback_cache',
                filter: `id=eq.${cacheId}`,
              },
              (payload: any) => {
                if (isResolved) return;

                const newRecord = payload.new;
                console.log('Realtime update received:', newRecord.status);

                if (newRecord.status === 'completed' && newRecord.feedback) {
                  isResolved = true;
                  // DBから直接取得したJSONをパース
                  let feedbackData;
                  try {
                    feedbackData = JSON.parse(newRecord.feedback);
                  } catch {
                    feedbackData = { praiseComment: '', advice: newRecord.feedback, nutritionTip: '' };
                  }
                  setNutritionFeedback(feedbackData.advice || newRecord.feedback);
                  setPraiseComment(feedbackData.praiseComment || null);
                  setNutritionTip(feedbackData.nutritionTip || null);
                  setIsLoadingFeedback(false);
                  clearInterval(pollInterval);
                  console.log('Nutrition feedback received via Realtime');
                } else if (newRecord.status === 'error') {
                  isResolved = true;
                  let feedbackData;
                  try {
                    feedbackData = JSON.parse(newRecord.feedback);
                  } catch {
                    feedbackData = { advice: newRecord.feedback };
                  }
                  setNutritionFeedback(feedbackData.advice || newRecord.feedback || '分析中にエラーが発生しました。');
                  setPraiseComment(null);
                  setNutritionTip(null);
                  setIsLoadingFeedback(false);
                  clearInterval(pollInterval);
                }
              }
            )
            .subscribe((status) => {
              console.log('Realtime subscription status:', status);
            });
          
          // クリーンアップ用に保存
          feedbackChannelRef.current = {
            unsubscribe: () => {
              clearInterval(pollInterval);
              supabase.removeChannel(channel);
            }
          };
        } else {
          // UX2-03: 「キャッシュ済み」でも「生成中」でもない想定外のレスポンス形状
          // (例: cached=true だが feedback/praiseComment が空、status が想定外の値等) に
          // フォールスルーすると setIsLoadingFeedback(false) が一度も呼ばれず
          // 「分析を準備中...」のスピナーが永久に止まらなかった。
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
    
    // クリーンアップ：モーダルが閉じたら購読/ポーリングを停止
    return () => {
      if (!showNutritionDetailModal && feedbackChannelRef.current) {
        feedbackChannelRef.current.unsubscribe?.();
        feedbackChannelRef.current = null;
      }
    };
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
    setDisplayMonth(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  };

  const goToNextMonth = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDisplayMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
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
    if (!currentPlan || !mealId) return;
    // 楽観的UI更新（失敗時にロールバックするため元の状態を保持）
    const previousPlan = currentPlan;
    const updatedDays = currentPlan.days?.map(day => {
      if (day.id !== dayId) return day;
      return { ...day, meals: day.meals?.map(meal => meal.id === mealId ? { ...meal, ...updates } : meal) };
    });
    setCurrentPlan({ ...currentPlan, days: updatedDays });
    try {
      const res = await fetch(`/api/meal-plans/meals/${mealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (!res.ok) throw new Error('Update failed');
    } catch (e) {
      console.error('Failed to update meal:', e);
      // 失敗したら元に戻す
      setCurrentPlan(previousPlan);
      alert('更新に失敗しました');
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
      }, 250);
      toggleDebounceTimerRef.current.set(mealId, timer);
    });

    if (pendingToggleWeeklyRef.current.has(mealId)) return;
    pendingToggleWeeklyRef.current.add(mealId);
    const newCompleted = !meal.isCompleted;
    await handleUpdateMeal(dayId, meal.id, { isCompleted: newCompleted });
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
    }
  };

  const deletePantryItem = async (id: string) => {
    try {
      await fetch(`/api/pantry/${id}`, { method: 'DELETE' });
      usePantryStore.getState().removeFridgeItem(id);
    } catch (e) { alert("削除に失敗しました"); }
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
    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((acc, byte) => acc + String.fromCharCode(byte), "")
      );
      const analyzeRes = await fetch('/api/ai/analyze-fridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType: file.type || 'image/jpeg' }),
      });
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
      // from-photo のレスポンスは snake_case のため、camelCase の一覧を取り直す
      const listRes = await fetch('/api/pantry');
      if (listRes.ok) {
        const { items } = await listRes.json();
        usePantryStore.getState().setFridgeItems(items || []);
      }
    } catch (e: any) {
      alert(e?.message || '写真からの追加に失敗しました');
    } finally {
      setIsAnalyzingFridgePhoto(false);
    }
  };

  // Add shopping item
  const addShoppingItem = async () => {
    const { newShoppingName, newShoppingAmount, newShoppingCategory } = useFormDraftStore.getState();
    if (!newShoppingName || !currentPlan) return;
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
    } catch (e) { alert("追加に失敗しました"); }
  };

  // チェックボックスのトグル（楽観的更新）
  const toggleShoppingItem = (id: string, currentChecked: boolean) => {
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
    });
  };

  const deleteShoppingItem = async (id: string) => {
    // 楽観的UI更新
    const previousList = useShoppingStore.getState().shoppingList;
    setShoppingList(previousList.filter(i => i.id !== id));
    try {
      const res = await fetch(`/api/shopping-list/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
    } catch (e) {
      // 失敗したら元に戻す
      setShoppingList(previousList);
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
    }
  };

  // 買い物リスト再生成の進捗購読（Realtime + ポーリング）
  const shoppingListChannelRef = useRef<any>(null);
  const shoppingListPollingRef = useRef<NodeJS.Timeout | null>(null);
  
  const cleanupShoppingListSubscription = useCallback(() => {
    if (shoppingListChannelRef.current) {
      shoppingListChannelRef.current.unsubscribe();
      shoppingListChannelRef.current = null;
    }
    if (shoppingListPollingRef.current) {
      clearInterval(shoppingListPollingRef.current);
      shoppingListPollingRef.current = null;
    }
  }, []);

  const subscribeToShoppingListRequest = useCallback((requestId: string) => {
    cleanupShoppingListSubscription();
    
    console.log('📡 Subscribing to shopping list request:', requestId);
    
    // タイムアウト処理（2分で強制終了）
    const TIMEOUT_MS = 120000;
    const startTime = Date.now();
    
    // ポーリングも並行開始（Realtimeのバックアップ）
    const poll = async () => {
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
        
        if (data.progress) {
          setShoppingListProgress(data.progress);
        }
        
        if (data.status === 'completed') {
          console.log('✅ Shopping list regeneration completed (polling)');
          const listRes = await fetch(`/api/shopping-list`);
          if (listRes.ok) {
            const { shoppingList: sl } = await listRes.json();
            if (sl?.items) {
              setShoppingList(sl.items);
              setActiveShoppingList(sl);
            }
          }
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
          const errorMsg = data.result?.error || '再生成に失敗しました';
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
              const listRes = await fetch(`/api/shopping-list`);
              if (listRes.ok) {
                const { shoppingList: sl } = await listRes.json();
                if (sl?.items) {
                  setShoppingList(sl.items);
                  setActiveShoppingList(sl);
                }
              }
            } catch (fetchErr) {
              console.error('❌ Failed to fetch shopping list:', fetchErr);
            }
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
            const errorMsg = newData.result?.error || '再生成に失敗しました';
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
  }, [cleanupShoppingListSubscription, setShoppingList, setSuccessMessage]);

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
    
    try {
      const res = await fetch(`/api/shopping-list/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          mealTypes: dateRange.mealTypes,
        })
      });
      
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
    }
  };

  // Toggle shopping item variant (tap to switch display unit)
  // 楽観的更新: 即座にUIを更新し、裏でAPI呼び出し
  const toggleShoppingVariant = (itemId: string, item: ShoppingListItem) => {
    if (!item.quantityVariants || item.quantityVariants.length <= 1) return;
    
    const nextIndex = (item.selectedVariantIndex + 1) % item.quantityVariants.length;
    const newQuantity = item.quantityVariants[nextIndex]?.display || item.quantity;
    
    // 即座にUIを更新（楽観的更新）
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
    });
  };

  // お気に入りトグル (楽観的更新 + 失敗時ロールバック)
  const handleToggleFavorite = async () => {
    if (!selectedRecipe || isFavoriteLoading) return;
    const prev = isFavorite;
    setIsFavorite(!prev);
    setIsFavoriteLoading(true);
    try {
      const encodedId = encodeURIComponent(selectedRecipe);
      const method = prev ? 'DELETE' : 'POST';
      const res = await fetch(`/api/recipes/${encodedId}/like`, { method });
      if (!res.ok) {
        // rollback
        setIsFavorite(prev);
      }
    } catch {
      setIsFavorite(prev);
    } finally {
      setIsFavoriteLoading(false);
    }
  };

  // Add recipe ingredients to shopping list
  const addRecipeToShoppingList = async () => {
    if (!selectedRecipeData || !currentPlan) return;
    try {
      // 材料を収集：dishes内の各料理の材料 + 旧形式のingredientsを統合
      let allIngredients: string[] = [];
      
      // dishes配列から材料を収集
      if (selectedRecipeData.dishes && Array.isArray(selectedRecipeData.dishes)) {
        selectedRecipeData.dishes.forEach((dish: any) => {
          if (dish.ingredients && Array.isArray(dish.ingredients)) {
            allIngredients = [...allIngredients, ...dish.ingredients];
          }
        });
      }
      
      // 旧形式の材料も追加（フォールバック）
      if (selectedRecipeData.ingredients && Array.isArray(selectedRecipeData.ingredients)) {
        allIngredients = [...allIngredients, ...selectedRecipeData.ingredients];
      }
      
      // 重複を除去
      allIngredients = [...new Set(allIngredients)];
      
      if (allIngredients.length === 0) {
        setSuccessMessage({ title: '材料なし', message: '材料情報がありません。「AIで変更」で再生成してください。' });
        return;
      }
      
      // 文字列形式 "鶏むね肉 200g" を {name, amount} 形式にパース
      const parsedIngredients = allIngredients.map((ing: string) => {
        // 最後のスペースで分割して分量を抽出（例: "鶏むね肉 200g" → name: "鶏むね肉", amount: "200g"）
        const match = ing.match(/^(.+?)\s+(\d+.*|少々|適量|適宜)$/);
        if (match) {
          return { name: match[1], amount: match[2] };
        }
        return { name: ing, amount: null };
      });
      
      const res = await fetch('/api/shopping-list/add-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          shoppingListId: activeShoppingList?.id,
          ingredients: parsedIngredients 
        })
      });
      if (res.ok) {
        const { items } = await res.json();
        setShoppingList([...useShoppingStore.getState().shoppingList, ...items]);
        setActiveModal(null);
        setSuccessMessage({ 
          title: '買い物リストに追加しました ✓', 
          message: `${parsedIngredients.length}件の材料を追加しました` 
        });
      } else {
        const err = await res.json();
        alert(`エラー: ${err.error || '追加に失敗しました'}`);
      }
    } catch (e) { 
      console.error('Add to shopping list error:', e);
      alert("追加に失敗しました"); 
    }
  };

  // Generate weekly menu with AI
  const handleGenerateWeekly = async () => {
    const weekStartDate = formatLocalDate(weekStart);
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

      const response = await fetch("/api/ai/menu/weekly/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startDate: weekDates[0]?.dateStr,
          note: aiChatInput + (selectedConditions.length > 0 ? `\n【条件】${selectedConditions.join('、')}` : ''),
          preferences,
        }),
      });
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
      if (requestId) {
        subscribeToRequestStatus(weekStartDate, requestId);
      } else {
        // requestIdがない場合は旧方式でポーリング
        // レガシーポーリングは廃止（requestIdがある場合のみRealtime監視）
        console.warn('No requestId returned, cannot subscribe to Realtime');
      }
      
    } catch (error: any) {
      alert(error.message || "エラーが発生しました");
      setIsGenerating(false);
      localStorage.removeItem('weeklyMenuGenerating');
    }
  };
  

  // Generate single meal with AI
  const handleGenerateSingleMeal = async () => {
    const { addMealKey, addMealDayIndex, selectedConditions, aiChatInput } = useFormDraftStore.getState();
    if (!addMealKey) return;

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
      
      const res = await fetch('/api/ai/menu/meal/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dayDate,
          mealType: addMealKey,
          preferences,
          note: aiChatInput
        })
      });

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
        if (requestId) {
          subscribeToRequestStatus(formatLocalDate(weekStart), requestId);
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

        // Refresh data
        const targetDate = formatLocalDate(weekStart);
        const endDate = addDaysStr(targetDate, 6);
        const refreshRes = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
        let createdMeal: PlannedMeal | undefined;
        if (refreshRes.ok) {
          const { dailyMeals, shoppingList: shoppingListData } = await refreshRes.json();
          if (dailyMeals && dailyMeals.length > 0) {
            const newPlan = { days: dailyMeals };
            const newShoppingList = shoppingListData?.items || [];
            setCurrentPlan(newPlan);
            updateCalendarMealDatesFromDailyMeals(dailyMeals);
            // キャッシュも更新
            weekDataCache.current.set(targetDate, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
            if (newMealId) {
              createdMeal = newPlan.days
                .flatMap((d: { meals?: PlannedMeal[] }) => d.meals || [])
                .find((m: PlannedMeal) => m.id === newMealId);
            }
          }
        }
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
      
      const res = await fetch('/api/ai/menu/meal/regenerate', {
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
  
  // 再生成のRealtime監視
  // #1033 F1b-06: 週間生成側 subscribeToRequestStatus と同様に、Realtime切断時のフォールバックとして
  // 3秒ポーリング + 5分の上限タイムアウトを併用する（Realtime単独だとスピナーが取り残される）
  const subscribeToRegenerateStatus = useCallback((requestId: string, weekStartDate: string) => {
    // 既存のサブスクリプション/ポーリング/タイムアウトをクリーンアップ
    cleanupRealtime();
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
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      cleanupRealtime();
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
          const weekEndDate = addDaysStr(weekStartDate, 6);
          const planRes = await fetch(`/api/meal-plans?startDate=${weekStartDate}&endDate=${weekEndDate}`);
          if (planRes.ok) {
            const { dailyMeals, shoppingList: shoppingListData } = await planRes.json();
            if (dailyMeals && dailyMeals.length > 0) {
              const newPlan = { days: dailyMeals };
              const newShoppingList = shoppingListData?.items || [];
              setCurrentPlan(newPlan);
              if (newShoppingList.length > 0) setShoppingList(newShoppingList);
              updateCalendarMealDatesFromDailyMeals(dailyMeals);
              // キャッシュも更新
              weekDataCache.current.set(weekStartDate, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
            }
          }
        } catch (e) {
          console.error('❌ Failed to fetch meal plan after regenerate:', e);
        }
        setIsRegenerating(false);
        setRegeneratingMealId(null);
      } else {
        console.log('❌ Regeneration failed');
        setIsRegenerating(false);
        setRegeneratingMealId(null);
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
      if (resolvedRef.current) return;
      try {
        const res = await fetch(`/api/ai/menu/weekly/status?requestId=${requestId}`);
        if (res.status === 401) {
          console.warn('[regenerate poll] Session expired (401). Stopping.');
          resolvedRef.current = true;
          cleanupRealtime();
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
          window.location.href = '/login';
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (resolvedRef.current) return;
        if (data.status === 'completed') {
          await finishRegenerate('completed');
        } else if (data.status === 'failed') {
          await finishRegenerate('failed', data.errorMessage || data.error_message);
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
            await finishRegenerate('failed', newData.error_message || undefined);
          }
        }
      )
      .subscribe((status) => {
        console.log('📡 Realtime regenerate subscription status:', status);
      });

    realtimeChannelRef.current = channel;
  }, [cleanupRealtime, updateCalendarMealDatesFromDailyMeals]);

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
    try {
      const res = await fetch(`/api/meal-plans/meals/${deletingMeal.id}`, {
        method: 'DELETE',
      });
      
      if (res.ok) {
        // UIを更新
        setExpandedMealId(null);
        setActiveModal(null);
        setDeletingMeal(null);
        // データを再取得
        const targetDate = formatLocalDate(weekStart);
        const endDate = addDaysStr(targetDate, 6);
        const refreshRes = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
        if (refreshRes.ok) {
          const { dailyMeals, shoppingList: shoppingListData } = await refreshRes.json();
          const newPlan = dailyMeals && dailyMeals.length > 0 ? { days: dailyMeals } : null;
          const newShoppingList = shoppingListData?.items || [];
          setCurrentPlan(newPlan);
          if (dailyMeals && dailyMeals.length > 0) {
            syncCalendarMealDatesFromDailyMeals(dailyMeals);
          }
          // キャッシュも更新
          weekDataCache.current.set(targetDate, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
        }
      } else {
        alert('削除に失敗しました');
      }
    } catch (error) {
      console.error('Delete meal error:', error);
      alert('削除に失敗しました');
    } finally {
      setIsDeleting(false);
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

    try {
      await fetch(`/api/meal-plans/meals/${manualEditMeal.id}`, {
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

      const targetDate = formatLocalDate(weekStart);
      const endDate = addDaysStr(targetDate, 6);
      const refreshRes = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
      if (refreshRes.ok) {
        const { dailyMeals, shoppingList: shoppingListData } = await refreshRes.json();
        const newPlan = dailyMeals && dailyMeals.length > 0 ? { days: dailyMeals } : null;
        const newShoppingList = shoppingListData?.items || [];
        setCurrentPlan(newPlan);
        if (dailyMeals && dailyMeals.length > 0) {
          syncCalendarMealDatesFromDailyMeals(dailyMeals);
        }
        weekDataCache.current.set(targetDate, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
      }

      setActiveModal(null);
      setManualEditMeal(null);
      setSelectedCatalogProduct(null);
      setCatalogQuery('');
      setCatalogResults([]);
    } catch (e) {
      alert('更新に失敗しました');
    }
  };

  // Open photo edit modal
  const openPhotoEdit = (meal: PlannedMeal) => {
    setPhotoEditMeal(meal);
    setPhotoFiles([]);
    setPhotoPreviews([]);
    setActiveModal('photoEdit');
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

    setIsAnalyzingPhoto(true);

    try {
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
      
      const res = await fetch('/api/ai/analyze-meal-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: imageDataArray,
          mealId: photoEditMeal.id,
          mealType: photoEditMeal.mealType,
        })
      });
      
      if (res.ok) {
        setActiveModal(null);
        setPhotoEditMeal(null);
        setPhotoFiles([]);
        setPhotoPreviews([]);

        // 写真解析は同期的に行われるので、すぐにデータを再取得
        const targetDate = formatLocalDate(weekStart);
        const endDate = addDaysStr(targetDate, 6);
        const pollRes = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
        if (pollRes.ok) {
          const { dailyMeals, shoppingList: shoppingListData } = await pollRes.json();
          if (dailyMeals && dailyMeals.length > 0) {
            const newPlan = { days: dailyMeals };
            const newShoppingList = shoppingListData?.items || [];
            setCurrentPlan(newPlan);
            if (newShoppingList.length > 0) setShoppingList(newShoppingList);
            updateCalendarMealDatesFromDailyMeals(dailyMeals);
            // キャッシュも更新
            weekDataCache.current.set(targetDate, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
          }
        }
        setIsAnalyzingPhoto(false);
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
        setIsAnalyzingPhoto(false);
      }
    } catch (error) {
      console.error('Photo analysis error:', error);
      setSuccessMessage({
        title: '写真解析に失敗しました',
        message: 'エラーが発生しました。もう一度お試しください。',
        type: 'error',
        onRetry: () => analyzePhotoWithAI(),
      });
      setIsAnalyzingPhoto(false);
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

    try {
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

      const generateResponse = await fetch('/api/ai/image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          images: referenceImages,
        }),
      });

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
      weekDataCache.current.set(targetDate, {
        plan: updatedPlan,
        shoppingList,
        fetchedAt: Date.now(),
      });
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

      const requestRes = await fetch('/api/ai/menu/v4/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetSlots,
          resolveExistingMeals: true,
          note: userComment,
          constraints: {},
        }),
      });

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

        const finishImprove = async (status: 'completed' | 'failed', errorMessage?: string) => {
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
          const endStr = weekDates[weekDates.length - 1]?.dateStr;
          if (startStr && endStr) {
            try {
              const refreshRes = await fetch(`/api/meal-plans/weekly?startDate=${startStr}&endDate=${endStr}`);
              if (refreshRes.ok) {
                const { dailyMeals, shoppingList: shoppingListData } = await refreshRes.json();
                if (dailyMeals && dailyMeals.length > 0) {
                  const newPlan = { days: dailyMeals };
                  const newShoppingList = shoppingListData?.items || [];
                  setCurrentPlan(newPlan);
                  if (newShoppingList.length > 0) setShoppingList(newShoppingList);
                  updateCalendarMealDatesFromDailyMeals(dailyMeals);
                  weekDataCache.current.set(startStr, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
                }
              }
            } catch (e) {
              console.error('❌ Failed to fetch meal plan after improve:', e);
            }
          }
        };

        v4Generation.subscribeToProgress(
          improveRequestId,
          async (progress: any) => {
            const uiProgress = convertV4ProgressToUIFormat(progress);
            setGenerationProgress(uiProgress);

            if (progress.status === 'completed' || progress.status === 'failed') {
              await finishImprove(progress.status, progress.errorMessage);
            }
          }
        );

        // 常にポーリングも開始（Realtimeの信頼性が低いため）
        const pollImprove = async () => {
          if (improveResolvedRef.current) return;
          try {
            const statusRes = await fetch(`/api/ai/menu/weekly/status?requestId=${improveRequestId}`);
            if (!statusRes.ok) return;
            const { status, errorMessage, error_message: errorMessageSnake, progress: dbProgress } = await statusRes.json();
            if (improveResolvedRef.current) return;
            if (status === 'completed') {
              await finishImprove('completed');
            } else if (status === 'failed') {
              await finishImprove('failed', errorMessage || errorMessageSnake);
            } else if (dbProgress) {
              // Realtimeが届いていない間も進捗表示を維持（nullの場合のみ上書き）
              setGenerationProgress((prev) => prev ?? convertV4ProgressToUIFormat(dbProgress));
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
        // 献立を再取得
        const targetDate = formatLocalDate(weekStart);
        const endDate = addDaysStr(targetDate, 6);
        const refreshRes = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
        if (refreshRes.ok) {
          const { dailyMeals, shoppingList: shoppingListData } = await refreshRes.json();
          if (dailyMeals && dailyMeals.length > 0) {
            const newPlan = { days: dailyMeals };
            const newShoppingList = shoppingListData?.items || [];
            setCurrentPlan(newPlan);
            // キャッシュも更新
            weekDataCache.current.set(targetDate, { plan: newPlan, shoppingList: newShoppingList, fetchedAt: Date.now() });
          }
        }
      } else if (data.message) {
        // 移動できない場合のメッセージ（静かに無視）
        console.log(data.message);
      }
    } catch (error) {
      console.error('Reorder error:', error);
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
  
  const expiringItems = fridgeItems.filter(i => {
    const days = getDaysUntil(i.expirationDate);
    return days !== null && days <= 3;
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
                      imageUrl: dish.image_url ?? meal.imageUrl ?? null,
                      // この料理だけを配列に入れる（UIの互換性のため）
                      dishes: [normalizedDish],
                      // 全料理の材料（買い物リスト用）
                      allIngredients: dishesArray.flatMap(dd => dd.ingredients || []),
                    });
                    setActiveModal('recipe');
                  }}
                  className="text-left flex flex-col min-h-[85px] rounded-xl p-3"
                  style={{ background: config.bg }}
                >
                  <div className="flex justify-between mb-1">
                    <span style={{ fontSize: 9, fontWeight: 700, color: config.color }}>{config.label}</span>
                    <span style={{ fontSize: 9, color: colors.textMuted }}>{dish.calories_kcal ?? dish.cal ?? '-'}kcal</span>
                  </div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: colors.text, margin: 0 }}>{dish.name}</p>
                  {/* 栄養素（P/F/C）- 新旧形式両対応 */}
                  {(dish.protein_g || dish.fat_g || dish.carbs_g || dish.protein || dish.fat || dish.carbs) && (
                    <div className="flex gap-2 mt-1 text-[8px]" style={{ color: colors.textMuted }}>
                      {((dish.protein_g ?? dish.protein) ?? 0) > 0 && <span>P:{dish.protein_g ?? dish.protein}g</span>}
                      {((dish.fat_g ?? dish.fat) ?? 0) > 0 && <span>F:{dish.fat_g ?? dish.fat}g</span>}
                      {((dish.carbs_g ?? dish.carbs) ?? 0) > 0 && <span>C:{dish.carbs_g ?? dish.carbs}g</span>}
                    </div>
                  )}
                  <span className="inline-flex items-center gap-1 mt-auto text-[9px]" style={{ color: colors.blue }}>
                    <BookOpen size={9} /> レシピを見る
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
            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-[10px]" style={{ color: colors.text }}>
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
              <p style={{ fontSize: 10, color: colors.textMuted, margin: 0 }}>
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
              {expiringItems.length > 0 && (
                <div className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: colors.warning }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>{expiringItems.length}</span>
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
                <div className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: colors.accent }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>{shoppingList.filter(i => !i.isChecked).length}</span>
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
                          fontSize: 10,
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
            <span style={{ fontSize: 8, color: colors.textMuted, whiteSpace: 'nowrap' }}>前の週</span>
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
                  <span style={{ fontSize: 9, color: isSelected ? 'rgba(255,255,255,0.7)' : colors.textMuted }}>{day.date.getDate()}</span>
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
            <span style={{ fontSize: 8, color: colors.textMuted, whiteSpace: 'nowrap' }}>翌週</span>
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
            onChange={setView}
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
          onClick={() => setIsDayNutritionExpanded(!isDayNutritionExpanded)}
        >
          <div className="flex justify-between items-center">
          <div className="flex items-center gap-1.5">
            <span style={{ fontSize: 16, fontWeight: 600, color: weekDates[selectedDayIndex]?.dateStr < todayStr ? colors.textMuted : colors.text }}>
              {weekDates[selectedDayIndex]?.dateStr && formatDateJa(weekDates[selectedDayIndex].dateStr)}（{weekDates[selectedDayIndex]?.dayOfWeek}）
            </span>
            {weekDates[selectedDayIndex]?.dateStr === todayStr && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: colors.accent, color: '#fff' }}>今日</span>
            )}
            {weekDates[selectedDayIndex]?.dateStr < todayStr && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: colors.textMuted, color: '#fff' }}>過去</span>
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
                          <p className="text-center text-[9px] mt-1" style={{ color: colors.textMuted }}>
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
                              return (
                                <div key={key} className="flex items-center gap-2">
                                  <span className="text-[10px] w-16 truncate" style={{ color: colors.textMuted }}>
                                    {def?.label}
                                  </span>
                                  <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: colors.bg }}>
                                    <div
                                      className="h-full rounded-full transition-all"
                                      style={{
                                        width: `${Math.min(percentage, 100)}%`,
                                        background: isGood ? colors.success : isLow ? colors.warning : isHigh ? colors.accent : colors.textMuted,
                                      }}
                                    />
                                  </div>
                                  <span 
                                    className="text-[9px] w-8 text-right font-medium"
                                    style={{ color: isGood ? colors.success : isLow ? colors.warning : isHigh ? colors.accent : colors.textMuted }}
                                  >
                                    {percentage}%
                                  </span>
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

          if (meals.length === 0 && !isGeneratingThisType) return null;

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
                    try {
                      await fetch('/api/profile', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ servingsConfig: cfg })
                      });
                    } catch (e) {
                      console.error('Failed to save servings config:', e);
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
                onOpenPhotoEdit={() => { setActiveModal('photoEdit'); setPhotoEditMeal(manualEditMeal); }}
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
                isAnalyzingPhoto={isAnalyzingPhoto}
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
