"use client";

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import type { DailyMeal, PlannedMeal, PantryItem, ShoppingListItem, ShoppingList, MealMode, MealDishes, DishDetail, TargetSlot, MenuGenerationConstraints, ServingsConfig, DayOfWeek, MealServings, WeekStartDay } from "@/types/domain";
import ReactMarkdown from "react-markdown";
import { V4GenerateModal } from "@/components/ai-assistant";
import { useV4MenuGeneration } from "@/hooks/useV4MenuGeneration";
import { ProfileReminderBanner } from "@/components/ProfileReminderBanner";
import { NutritionRadarChart } from "@/components/NutritionRadarChart";
import { DEFAULT_RADAR_NUTRIENTS, getNutrientDefinition, calculateDriPercentage, NUTRIENT_DEFINITIONS, NUTRIENT_BY_CATEGORY, CATEGORY_LABELS } from "@/lib/nutrition-constants";
import remarkGfm from "remark-gfm";
import {
  ChefHat, Store, UtensilsCrossed, FastForward,
  Sparkles, Zap, X, Plus, Check, Calendar,
  Flame, Refrigerator, Trash2, AlertTriangle,
  BarChart3, ShoppingCart, ChevronDown, ChevronRight, ChevronLeft, ChevronUp,
  Clock, Users, BookOpen, Heart, RefreshCw, Send, Package,
  Camera, Pencil, Image as ImageIcon, GripVertical, ArrowUp, ArrowDown
} from 'lucide-react';

// ============================================
// Types & Constants (Reference UI Style)
// ============================================

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'midnight_snack';
type ModalType = 'ai' | 'aiPreview' | 'aiMeal' | 'fridge' | 'shopping' | 'stats' | 'recipe' | 'add' | 'addFridge' | 'addShopping' | 'editMeal' | 'regenerateMeal' | 'manualEdit' | 'photoEdit' | 'addMealSlot' | 'confirmDelete' | 'shoppingRange' | null;

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

// 買い物リスト範囲選択の型
type ShoppingRangeType = 'today' | 'tomorrow' | 'dayAfterTomorrow' | 'week' | 'days' | 'custom';
interface ShoppingRangeSelection {
  type: ShoppingRangeType;
  // today選択時の食事タイプ
  todayMeals: ('breakfast' | 'lunch' | 'dinner')[];
  // days選択時の日数
  daysCount: number;
  // custom選択時の開始・終了日
  customStartDate?: string;
  customEndDate?: string;
}

// 全ての食事タイプ
const ALL_MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack', 'midnight_snack'];

// Reference UI Color Palette
const colors = {
  bg: '#F7F6F3',
  card: '#FFFFFF',
  text: '#2D2D2D',
  textLight: '#6B6B6B',
  textMuted: '#A0A0A0',
  accent: '#E07A5F',
  accentLight: '#FDF0ED',
  success: '#6B9B6B',
  successLight: '#EDF5ED',
  warning: '#E5A84B',
  warningLight: '#FEF9EE',
  purple: '#7C6BA0',
  purpleLight: '#F5F3F8',
  blue: '#5B8BC7',
  blueLight: '#EEF4FB',
  border: '#E8E8E8',
  danger: '#D64545',
  dangerLight: '#FDECEC',
};

const MODE_CONFIG: Record<string, { icon: typeof ChefHat; label: string; color: string; bg: string }> = {
  cook: { icon: ChefHat, label: '自炊', color: colors.success, bg: colors.successLight },
  quick: { icon: Zap, label: '時短', color: colors.blue, bg: colors.blueLight },
  buy: { icon: Store, label: '買う', color: colors.purple, bg: colors.purpleLight },
  out: { icon: UtensilsCrossed, label: '外食', color: colors.warning, bg: colors.warningLight },
  skip: { icon: FastForward, label: 'なし', color: colors.textMuted, bg: colors.bg },
  ai_creative: { icon: Sparkles, label: 'AI献立', color: colors.accent, bg: colors.accentLight },
};

// モード設定を安全に取得するヘルパー（未知のモードでもエラーにならない）
const getModeConfig = (mode?: string) => MODE_CONFIG[mode || 'cook'] || MODE_CONFIG.cook;

// 役割に応じた色設定（英語・日本語両方対応）
const getDishConfig = (role?: string): { label: string; color: string; bg: string } => {
  switch (role) {
    case 'main':
    case '主菜':
    case '主食':
      return { label: '主菜', color: colors.accent, bg: colors.accentLight };
    case 'side':
    case 'side1':
    case 'side2':
    case '副菜':
    case '副食':
      return { label: '副菜', color: colors.success, bg: colors.successLight };
    case 'soup':
    case '汁物':
    case '味噌汁':
      return { label: '汁物', color: colors.blue, bg: colors.blueLight };
    case 'rice':
    case 'ご飯':
    case '白飯':
      return { label: 'ご飯', color: colors.warning, bg: colors.warningLight };
    case 'salad':
    case 'サラダ':
      return { label: 'サラダ', color: colors.success, bg: colors.successLight };
    case 'dessert':
    case 'デザート':
    case 'フルーツ':
      return { label: 'デザート', color: colors.purple, bg: colors.purpleLight };
    default:
      return { label: role || 'おかず', color: colors.textLight, bg: colors.bg };
  }
};

const MEAL_LABELS: Record<MealType, string> = { 
  breakfast: '朝食', 
  lunch: '昼食', 
  dinner: '夕食',
  snack: 'おやつ',
  midnight_snack: '夜食'
};

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

// 進捗ToDoカード（タップで展開）
const PROGRESS_PHASES = [
  { phase: 'user_context', label: 'ユーザー情報を取得', threshold: 5 },
  { phase: 'search_references', label: '参考レシピを検索', threshold: 10 },
  { phase: 'generating', label: '献立をAIが作成', threshold: 15 },  // 日数は動的に設定
  { phase: 'step1_complete', label: '献立生成完了', threshold: 40 },
  { phase: 'reviewing', label: '献立のバランスをチェック', threshold: 45 },
  { phase: 'review_done', label: '改善点を発見', threshold: 55 },
  { phase: 'fixing', label: '改善点を修正', threshold: 60 },
  { phase: 'no_issues', label: '問題なし', threshold: 70 },
  { phase: 'step2_complete', label: 'レビュー完了', threshold: 75 },
  { phase: 'calculating', label: '栄養価を計算', threshold: 80 },
  { phase: 'saving', label: '献立を保存', threshold: 88 },
  { phase: 'completed', label: '完了！', threshold: 100 },
];

// 買い物リスト再生成の進捗フェーズ
const SHOPPING_LIST_PHASES = [
  { phase: 'starting', label: '開始中...', threshold: 0 },
  { phase: 'extracting', label: '献立から材料を抽出', threshold: 10 },
  { phase: 'normalizing', label: 'AIが材料を整理中', threshold: 30 },
  { phase: 'validating', label: '整合性チェック', threshold: 60 },
  { phase: 'categorizing', label: 'カテゴリ分類', threshold: 70 },
  { phase: 'saving', label: '保存中', threshold: 85 },
  { phase: 'completed', label: '完了！', threshold: 100 },
  { phase: 'failed', label: 'エラーが発生しました', threshold: 0 },
];

type PhaseDefinition = { phase: string; label: string; threshold: number };

const ProgressTodoCard = ({ 
  progress, 
  colors: cardColors,
  phases = PROGRESS_PHASES,
  defaultMessage = 'AIが献立を生成中...',
}: { 
  progress: { phase: string; message: string; percentage: number; totalSlots?: number; completedSlots?: number } | null;
  colors: { accent: string; purple: string };
  phases?: PhaseDefinition[];
  defaultMessage?: string;
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const currentPercentage = progress?.percentage ?? 0;
  const currentPhase = progress?.phase ?? '';
  const totalSlots = progress?.totalSlots ?? 0;
  
  // totalSlotsから日数を計算（3スロット = 1日と仮定）
  const totalDays = totalSlots > 0 ? Math.ceil(totalSlots / 3) : 0;
  
  // 動的にフェーズラベルを生成
  const dynamicPhases = useMemo(() => {
    return phases.map(p => {
      if (p.phase === 'generating') {
        // totalSlotsが設定されていれば日数を表示、なければデフォルト
        if (totalDays > 0) {
          const dayLabel = totalDays === 1 ? '1日分' : `${totalDays}日分`;
          return { ...p, label: `${dayLabel}の献立をAIが作成` };
        }
        // totalSlotsがまだ来ていない場合はデフォルトのまま
        return p;
      }
      return p;
    });
  }, [phases, totalDays]);
  
  // 各フェーズの状態を判定
  const getPhaseStatus = (phase: PhaseDefinition) => {
    if (currentPercentage >= phase.threshold) {
      return 'completed';
    }
    if (currentPhase === phase.phase || 
        (currentPhase.startsWith(phase.phase.split('_')[0]) && currentPercentage < phase.threshold)) {
      return 'in_progress';
    }
    return 'pending';
  };

  const isError = currentPhase === 'failed';

  return (
    <div
      className="mx-3 mt-2 rounded-xl overflow-hidden cursor-pointer transition-all duration-300"
      style={{ background: isError 
        ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
        : `linear-gradient(135deg, ${cardColors.accent} 0%, ${cardColors.purple} 100%)` 
      }}
      onClick={() => setIsExpanded(!isExpanded)}
    >
      {/* ヘッダー部分 */}
      <div className="px-3.5 py-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isError ? (
              <div className="w-4 h-4 rounded-full bg-white flex items-center justify-center">
                <span style={{ fontSize: 10, color: '#ef4444', fontWeight: 700 }}>!</span>
              </div>
            ) : (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            )}
            <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>
              {isError 
                ? (progress?.message || 'エラーが発生しました')
                : totalDays > 0 
                  ? `献立を生成中...（${progress?.completedSlots || 0}/${totalSlots}食、${totalDays}日分）`
                  : (progress?.message || defaultMessage)
              }
            </span>
          </div>
          <div className="flex items-center gap-1">
            {!isError && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                {progress?.percentage ? `${progress.percentage}%` : ''}
              </span>
            )}
            {isExpanded ? (
              <ChevronUp size={14} color="rgba(255,255,255,0.7)" />
            ) : (
              <ChevronDown size={14} color="rgba(255,255,255,0.7)" />
            )}
          </div>
        </div>
        {progress?.percentage !== undefined && !isError && (
          <div className="mt-2 h-1.5 bg-white/20 rounded-full overflow-hidden">
            <div 
              className="h-full bg-white rounded-full transition-all duration-500 ease-out"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>
        )}
      </div>
      
      {/* 展開時のToDoリスト（エラー時は表示しない） */}
      <AnimatePresence>
        {isExpanded && !isError && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 pt-1 border-t border-white/20">
              <div className="space-y-1.5">
                {dynamicPhases.filter(p => p.phase !== 'failed').map((phase) => {
                  const status = getPhaseStatus(phase);
                  return (
                    <div 
                      key={phase.phase}
                      className="flex items-center gap-2"
                    >
                      {status === 'completed' ? (
                        <div className="w-4 h-4 rounded-full bg-white flex items-center justify-center">
                          <Check size={10} color={isError ? '#ef4444' : cardColors.accent} strokeWidth={3} />
                        </div>
                      ) : status === 'in_progress' ? (
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border-2 border-white/40" />
                      )}
                      <span 
                        style={{ 
                          fontSize: 11, 
                          color: status === 'pending' ? 'rgba(255,255,255,0.5)' : '#fff',
                          fontWeight: status === 'in_progress' ? 600 : 400,
                        }}
                      >
                        {phase.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

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
const AI_CONDITIONS = ['冷蔵庫の食材を優先', '時短メニュー中心', '和食多め', 'ヘルシーに'];

// Helper functions
const formatLocalDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

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
  const target = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
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

// ============================================
// Main Component
// ============================================

export default function WeeklyMenuPage() {
  const router = useRouter();
  
  const [currentPlan, setCurrentPlan] = useState<WeekPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  
  // V4 AIアシスタントモーダル
  const [showV4Modal, setShowV4Modal] = useState(false);

  // 完了モーダル用
  const [successMessage, setSuccessMessage] = useState<{ title: string; message: string } | null>(null);
  
  // Week Navigation
  const [weekStart, setWeekStart] = useState<Date>(getWeekStart(new Date()));
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const weekDates = useMemo(() => getWeekDates(weekStart), [weekStart]);

  // Calendar expansion state
  const [isCalendarExpanded, setIsCalendarExpanded] = useState(false);
  const [displayMonth, setDisplayMonth] = useState<Date>(() => weekStart);

  // Week start day setting & holidays
  const [weekStartDay, setWeekStartDay] = useState<WeekStartDay>('monday');
  const [holidays, setHolidays] = useState<Record<string, string>>({});

  // Fetch user's weekStartDay setting
  useEffect(() => {
    const fetchWeekStartDay = async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('week_start_day')
        .eq('id', user.id)
        .single();
      if (profile?.week_start_day) {
        setWeekStartDay(profile.week_start_day as WeekStartDay);
        // Re-calculate week start with new setting
        setWeekStart(getWeekStart(new Date(), profile.week_start_day as WeekStartDay));
      }
    };
    fetchWeekStartDay();
  }, []);

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

  // Expanded Meal State - 食事IDで管理（同じタイプの複数食事に対応）
  const [expandedMealId, setExpandedMealId] = useState<string | null>(null);
  const [hasAutoExpanded, setHasAutoExpanded] = useState(false);
  const [isDayNutritionExpanded, setIsDayNutritionExpanded] = useState(false);
  
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
        const meal = day.meals.find(m => m.mealType === mealType && !m.isCompleted);
        if (meal) {
          setExpandedMealId(meal.id);
          setSelectedDayIndex(dayIdx);
          setHasAutoExpanded(true);
          return;
        }
      }
    }
    
    // 未完了がない場合は今日（または最初の日）の最初の食事を展開
    const fallbackDayIdx = todayIndex >= 0 ? todayIndex : 0;
    const fallbackDay = plan.days.find(d => d.dayDate === dates[fallbackDayIdx]?.dateStr);
    if (fallbackDay?.meals?.[0]) {
      setExpandedMealId(fallbackDay.meals[0].id);
      setSelectedDayIndex(fallbackDayIdx);
      setHasAutoExpanded(true);
    }
  };

  // Form States
  const [aiChatInput, setAiChatInput] = useState("");
  const [addMealKey, setAddMealKey] = useState<MealType | null>(null);
  const [addMealDayIndex, setAddMealDayIndex] = useState<number>(0);
  const [selectedConditions, setSelectedConditions] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingMeal, setGeneratingMeal] = useState<{ dayIndex: number; mealType: MealType } | null>(null);
  const [generationProgress, setGenerationProgress] = useState<{ 
    phase: string; 
    message: string; 
    percentage: number;
    totalSlots?: number;
    completedSlots?: number;
  } | null>(null);

  // Meal Plan再取得関数
  const refreshMealPlan = useCallback(async () => {
    const targetDate = formatLocalDate(weekStart);
    const endDate = addDaysStr(targetDate, 6);
    try {
      const res = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
      if (res.ok) {
        const { dailyMeals, shoppingList: shoppingListData } = await res.json();
        if (dailyMeals && dailyMeals.length > 0) {
          setCurrentPlan({ days: dailyMeals });
          if (shoppingListData?.items) setShoppingList(shoppingListData.items);
        } else {
          setCurrentPlan(null);
        }
      }
    } catch (e) {
      console.error('Failed to refresh meal plan:', e);
    }
  }, [weekStart]);

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
      setSuccessMessage({ title: '献立が完成しました！', message: 'AIが献立を作成しました。' });
    },
    onError: (error) => {
      console.error('V4 generation error:', error);
      setIsGenerating(false);
      setGenerationProgress(null);  // 進捗表示をクリア
      alert(error);
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

        // まずDBから現在の状態を取得（リロード中に完了していた場合に対応）
        const currentStatus = await v4Generation.getRequestStatus(requestId);
        console.log('[restore] Current status from DB:', currentStatus);

        // すでに完了している場合
        if (currentStatus?.status === 'completed') {
          console.log('[restore] Generation already completed');
          localStorage.removeItem('v4MenuGenerating');
          refreshMealPlan();
          setSuccessMessage({ title: '献立が完成しました！', message: 'AIが献立を作成しました。' });
          return;
        }

        // 失敗している場合
        if (currentStatus?.status === 'failed') {
          console.log('[restore] Generation failed');
          localStorage.removeItem('v4MenuGenerating');
          alert(currentStatus.errorMessage || '生成に失敗しました');
          return;
        }

        // まだ進行中の場合、UI状態を復元して進捗追跡を再開
        setIsGenerating(true);

        // 現在の進捗をDBの値から復元（メッセージベースでフェーズを判定）
        const dbProgress = currentStatus?.progress || {};
        const currentStep = dbProgress.currentStep || 1;
        const dbTotalSlots = dbProgress.totalSlots || totalSlots || 1;
        const completedSlots = dbProgress.completedSlots || 0;
        const dbMessage = dbProgress.message || '';

        // メッセージからフェーズとパーセンテージを判定（リアルタイム更新と同じロジック）
        let initialPhase = 'generating';
        let initialPercentage = 10;

        if (currentStep === 1 || currentStep === 0) {
          if (dbMessage.includes('ユーザー情報') || dbMessage.includes('コンテキスト')) {
            initialPhase = 'user_context';
            initialPercentage = 3;
          } else if (dbMessage.includes('参考レシピ') || dbMessage.includes('検索中')) {
            initialPhase = 'search_references';
            initialPercentage = 8;
          } else if (dbMessage.includes('生成中') || dbMessage.includes('献立をAIが作成')) {
            initialPhase = 'generating';
            initialPercentage = 15 + Math.round((completedSlots / dbTotalSlots) * 25);
          } else if (dbMessage.includes('生成完了')) {
            initialPhase = 'step1_complete';
            initialPercentage = 40;
          } else {
            initialPhase = 'generating';
            initialPercentage = 12;
          }
        } else if (currentStep === 2) {
          if (dbMessage.includes('バランス') || dbMessage.includes('チェック中') || dbMessage.includes('重複')) {
            initialPhase = 'reviewing';
            initialPercentage = 47;
          } else if (dbMessage.includes('改善中')) {
            initialPhase = 'fixing';
            initialPercentage = 60;
          } else if (dbMessage.includes('問題なし')) {
            initialPhase = 'no_issues';
            initialPercentage = 72;
          } else if (dbMessage.includes('レビュー完了')) {
            initialPhase = 'step2_complete';
            initialPercentage = 75;
          } else {
            initialPhase = 'reviewing';
            initialPercentage = 45;
          }
        } else if (currentStep === 3) {
          if (dbMessage.includes('栄養価') || dbMessage.includes('計算')) {
            initialPhase = 'calculating';
            initialPercentage = 80;
          } else if (dbMessage.includes('保存')) {
            initialPhase = 'saving';
            initialPercentage = 85 + Math.round((completedSlots / dbTotalSlots) * 10);
          } else {
            initialPhase = 'saving';
            initialPercentage = 85;
          }
        }

        setGenerationProgress({
          phase: initialPhase,
          message: dbMessage || '生成状況を確認中...',
          percentage: initialPercentage,
          totalSlots: dbTotalSlots,
          completedSlots,
        });

        // 進捗追跡を再開
        v4Generation.subscribeToProgress(requestId, (progress) => {
          const message = progress.message || '';
          let phase = 'generating';
          let percentage = 10;

          const progressCurrentStep = progress.currentStep || 1;
          const progressTotalSlots = progress.totalSlots || totalSlots || 1;
          const progressCompletedSlots = progress.completedSlots || 0;

          if (progressCurrentStep === 1 || progressCurrentStep === 0) {
            phase = 'generating';
            percentage = 5 + Math.round((progressCompletedSlots / progressTotalSlots) * 35);
          } else if (progressCurrentStep === 2) {
            phase = 'nutrition';
            percentage = 40 + Math.round((progressCompletedSlots / progressTotalSlots) * 40);
          } else if (progressCurrentStep === 3) {
            phase = 'saving';
            percentage = 85 + Math.round((progressCompletedSlots / progressTotalSlots) * 10);
          }

          // 完了/失敗判定
          if (progress.status === 'completed') {
            setIsGenerating(false);
            setGenerationProgress(null);
            localStorage.removeItem('v4MenuGenerating');
            refreshMealPlan();
            setSuccessMessage({ title: '献立が完成しました！', message: 'AIが献立を作成しました。' });
            return;
          }
          if (progress.status === 'failed') {
            setIsGenerating(false);
            setGenerationProgress(null);
            localStorage.removeItem('v4MenuGenerating');
            alert(progress.errorMessage || '生成に失敗しました');
            return;
          }

          setGenerationProgress({
            phase,
            message,
            percentage,
            totalSlots: progressTotalSlots,
            completedSlots: progressCompletedSlots,
          });
        });
      } catch (e) {
        console.error('[restore] Failed to restore V4 generation:', e);
        localStorage.removeItem('v4MenuGenerating');
      }
    };

    restoreGeneration();
  }, []);  // マウント時のみ実行

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
        v4Generation.subscribeToProgress(result.requestId, (progress) => {
          // Edge Functionからの progress: { currentStep, totalSteps, message, completedSlots, totalSlots }
          // フロントエンドが期待: { phase, message, percentage }
          // PROGRESS_PHASES の phase 名に合わせる
          
          const message = progress.message || '';
          let phase = 'generating';
          let percentage = 0;
          
          const currentStep = progress.currentStep || 1;
          const totalSlots = progress.totalSlots || 1;
          const completedSlots = progress.completedSlots || 0;
          
          // Step 1 (0-40%): 生成フェーズ
          if (currentStep === 1 || currentStep === 0) {
            if (message.includes('ユーザー情報') || message.includes('コンテキスト')) {
              phase = 'user_context';
              percentage = 3;
            } else if (message.includes('参考レシピ') || message.includes('検索')) {
              phase = 'search_references';
              percentage = 8;
            } else if (message.includes('献立をAIが作成') || message.includes('生成中')) {
              phase = 'generating';
              percentage = 15 + (completedSlots / totalSlots) * 25; // 15-40%
            } else if (message.includes('生成完了')) {
              phase = 'step1_complete';
              percentage = 40;
            } else {
              phase = 'generating';
              percentage = 12;
            }
          }
          // Step 2 (40-75%): レビューフェーズ
          else if (currentStep === 2) {
            if (message.includes('バランス') || message.includes('チェック中') || message.includes('重複')) {
              phase = 'reviewing';
              percentage = 47;
            } else if (message.includes('改善中')) {
              phase = 'fixing';
              // (0/2) のような部分から進捗を抽出
              const match = message.match(/(\d+)\/(\d+)/);
              if (match) {
                const current = parseInt(match[1]);
                const total = parseInt(match[2]);
                // 改善が始まったら review_done を通過済み
                percentage = 58 + Math.round((current / Math.max(total, 1)) * 12); // 58-70%
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
              // (0/16) のような部分から進捗を抽出
              const match = message.match(/(\d+)\/(\d+)/);
              if (match) {
                const current = parseInt(match[1]);
                const total = parseInt(match[2]);
                percentage = 88 + Math.round((current / Math.max(total, 1)) * 10); // 88-98%
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
          
          setGenerationProgress({
            phase,
            message: progress.message || `${completedSlots}/${totalSlots} 件完了`,
            percentage: Math.round(percentage),
            totalSlots,
            completedSlots,
          });
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
    };
  }, [cleanupRealtime]);
  
  // 生成中状態をDBから復元し、ポーリングを再開
  useEffect(() => {
    // 既にポーリング中なら何もしない
    if (realtimeChannelRef.current) return;
    // 既に生成中状態なら何もしない（重複防止）
    if (isGenerating || generatingMeal) return;
    // 既にチェック中なら何もしない（重複API呼び出し防止）
    if (isCheckingPendingRef.current) return;
    
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
          }
        } catch (e) {
          console.warn('自動クリーンアップに失敗:', e);
        }
        
        // 1. 週間献立の生成中リクエストをDBで確認
        try {
          const weeklyRes = await fetch(`/api/ai/menu/weekly/pending?date=${targetDate}`);
          console.log('🔍 weeklyRes status:', weeklyRes.status);
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
                  const { status } = await statusRes.json();
                  if (status === 'pending' || status === 'processing') {
                    console.log('📦 週間献立をlocalStorageから復元:', requestId, 'status:', status);
                    setIsGenerating(true);
                    subscribeToRequestStatus(targetDate, requestId);
                    return;
                  } else {
                    // completed または failed の場合はlocalStorageをクリア
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
  }, [weekStart, weekDates, isGenerating, generatingMeal]);
  
  
  // 復元用フラグ（購読開始時に使用）
  const [shouldRestoreSubscription, setShouldRestoreSubscription] = useState(false);

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
  
  // Edit meal state
  const [editingMeal, setEditingMeal] = useState<PlannedMeal | null>(null);
  const [editMealName, setEditMealName] = useState("");
  const [editMealMode, setEditMealMode] = useState<MealMode>('cook');
  
  // Pantry & Shopping
  const [fridgeItems, setFridgeItems] = useState<PantryItem[]>([]);
  const [shoppingList, setShoppingList] = useState<ShoppingListItem[]>([]);
  const [activeShoppingList, setActiveShoppingList] = useState<ShoppingList | null>(null);
  const [isRegeneratingShoppingList, setIsRegeneratingShoppingList] = useState(false);
  const [shoppingListProgress, setShoppingListProgress] = useState<{ phase: string; message: string; percentage: number } | null>(null);
  const [shoppingListRequestId, setShoppingListRequestId] = useState<string | null>(null);
  const [shoppingListTotalServings, setShoppingListTotalServings] = useState<number | null>(null);
  
  // 曜日別人数設定モーダル
  const [showServingsModal, setShowServingsModal] = useState(false);
  const [servingsConfig, setServingsConfig] = useState<ServingsConfig | null>(null);
  const [isLoadingServingsConfig, setIsLoadingServingsConfig] = useState(false);
  
  // レーダーチャート関連
  const [radarChartNutrients, setRadarChartNutrients] = useState<string[]>(DEFAULT_RADAR_NUTRIENTS);
  const [showNutritionDetailModal, setShowNutritionDetailModal] = useState(false);
  const [nutritionFeedback, setNutritionFeedback] = useState<string | null>(null);
  const [praiseComment, setPraiseComment] = useState<string | null>(null);
  const [nutritionTip, setNutritionTip] = useState<string | null>(null);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);
  const [isEditingRadarNutrients, setIsEditingRadarNutrients] = useState(false);
  const [tempRadarNutrients, setTempRadarNutrients] = useState<string[]>([]);
  const [isSavingRadarNutrients, setIsSavingRadarNutrients] = useState(false);
  const [lastFeedbackDate, setLastFeedbackDate] = useState<string | null>(null);
  const [feedbackCacheId, setFeedbackCacheId] = useState<string | null>(null);
  const feedbackChannelRef = useRef<RealtimeChannel | null>(null);
  
  // AI栄養士のコメントで献立改善
  const [showImproveMealModal, setShowImproveMealModal] = useState(false);
  const [improveMealTargets, setImproveMealTargets] = useState<MealType[]>([]);
  const [isImprovingMeal, setIsImprovingMeal] = useState(false);
  const [improveNextDay, setImproveNextDay] = useState(false); // 翌日1日を対象にするモード
  
  // 週間サマリーモーダル
  const [showWeeklySummaryModal, setShowWeeklySummaryModal] = useState(false);
  const [weeklySummaryTab, setWeeklySummaryTab] = useState<'today' | 'week'>('today');
  const [weeklyNutritionFeedback, setWeeklyNutritionFeedback] = useState<string | null>(null);
  const [isLoadingWeeklyFeedback, setIsLoadingWeeklyFeedback] = useState(false);
  
  // 買い物リスト範囲選択
  const [shoppingRange, setShoppingRange] = useState<ShoppingRangeSelection>({
    type: 'week',
    todayMeals: ['breakfast', 'lunch', 'dinner'],
    daysCount: 3,
  });
  const [isTodayExpanded, setIsTodayExpanded] = useState(false);
  const [shoppingRangeStep, setShoppingRangeStep] = useState<'range' | 'servings'>('range');

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
  }, [shoppingList]);
  
  // Add fridge item form
  const [newFridgeName, setNewFridgeName] = useState("");
  const [newFridgeAmount, setNewFridgeAmount] = useState("");
  const [newFridgeExpiry, setNewFridgeExpiry] = useState("");
  
  // Add shopping item form
  const [newShoppingName, setNewShoppingName] = useState("");
  const [newShoppingAmount, setNewShoppingAmount] = useState("");
  const [newShoppingCategory, setNewShoppingCategory] = useState("食材");

  // Recipe Modal
  const [selectedRecipe, setSelectedRecipe] = useState<string | null>(null);
  const [selectedRecipeData, setSelectedRecipeData] = useState<any>(null);
  
  // AI Preview
  const [aiSuggestions, setAiSuggestions] = useState<any[]>([]);
  
  // AI Hint
  const [aiHint, setAiHint] = useState<string>("");
  const [isLoadingHint, setIsLoadingHint] = useState(false);
  
  // Regenerating meal
  const [regeneratingMeal, setRegeneratingMeal] = useState<PlannedMeal | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regeneratingMealId, setRegeneratingMealId] = useState<string | null>(null);
  
  // Manual edit state
  const [manualEditMeal, setManualEditMeal] = useState<PlannedMeal | null>(null);
  const [manualDishes, setManualDishes] = useState<DishDetail[]>([]);
  const [manualMode, setManualMode] = useState<MealMode>('cook');
  
  // Delete confirmation state
  const [deletingMeal, setDeletingMeal] = useState<PlannedMeal | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Photo edit state（複数枚対応）
  const [photoEditMeal, setPhotoEditMeal] = useState<PlannedMeal | null>(null);
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([]);
  const [isAnalyzingPhoto, setIsAnalyzingPhoto] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch Plan & Check for pending generation requests
  useEffect(() => {
    const fetchPlan = async () => {
      setLoading(true);
      try {
        const targetDate = formatLocalDate(weekStart);
        const endDate = addDaysStr(targetDate, 6);
        const res = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
        if (res.ok) {
          const { dailyMeals, shoppingList: shoppingListData } = await res.json();
          if (dailyMeals && dailyMeals.length > 0) {
            const plan = { days: dailyMeals };
            setCurrentPlan(plan);
            if (shoppingListData?.items) setShoppingList(shoppingListData.items);
            // 直近の食事を自動展開
            autoExpandNextMeal(plan, weekDates);
          } else {
            setCurrentPlan(null);
          }
        } else {
          setCurrentPlan(null);
        }
        
        // DBで生成中のリクエストがあるか確認
        const pendingRes = await fetch(`/api/ai/menu/weekly/pending?date=${targetDate}`);
        if (pendingRes.ok) {
          const { hasPending, requestId } = await pendingRes.json();
          if (hasPending && requestId) {
            // 生成中状態を復元してポーリング開始
            setIsGenerating(true);
            subscribeToRequestStatus(targetDate, requestId);
          }
        }
      } catch (e) {
        console.error("Failed to fetch meal plan", e);
        setCurrentPlan(null);
      } finally {
        setLoading(false);
      }
    };
    fetchPlan();
  }, [weekStart]);
  
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
  
  // ポーリングをクリーンアップする関数
  const cleanupPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  // V4進捗をUI形式に変換するヘルパー関数
  const convertV4ProgressToUIFormat = useCallback((progress: {
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
      
      let phase = 'generating';
      let percentage = 0;
      
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
      
      return {
        phase,
        message,
        percentage: Math.round(percentage),
        totalSlots,
        completedSlots,
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
  }, []);

  // ポーリングで進捗を取得
  const startPolling = useCallback((targetDate: string, requestId: string) => {
    console.log('⏱️ Starting fallback polling for requestId:', requestId);
    cleanupPolling();
    
    const poll = async () => {
      try {
        const res = await fetch(`/api/ai/menu/weekly/status?requestId=${requestId}`);
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
              setCurrentPlan({ days: dailyMeals });
              if (shoppingListData?.items) setShoppingList(shoppingListData.items);
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
          alert('献立の生成に失敗しました。もう一度お試しください。');
        }
      } catch (e) {
        console.error('Polling error:', e);
      }
    };
    
    // 即座に1回実行
    poll();
    // 3秒ごとにポーリング
    pollingIntervalRef.current = setInterval(poll, 3000);
  }, [cleanupPolling, cleanupRealtime, convertV4ProgressToUIFormat]);

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
            // Realtimeが動作しているのでポーリングを停止
            cleanupPolling();
            
            const newData = payload.new as { 
              status: string; 
              mode?: string;
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
                    setCurrentPlan({ days: dailyMeals });
                    if (shoppingListData?.items) setShoppingList(shoppingListData.items);
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
              alert('献立の生成に失敗しました。もう一度お試しください。');
            }
            // status === 'pending' or 'processing' の場合は継続して監視
          } catch (err) {
            console.error('❌ Realtime handler error:', err);
          }
        }
      )
      .subscribe((status) => {
        console.log('📡 Realtime subscription status:', status);
        if (status === 'SUBSCRIBED') {
          realtimeConnected = true;
          // Realtimeが接続できたらポーリングを停止
          cleanupPolling();
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
  }, [cleanupRealtime, cleanupPolling, startPolling, convertV4ProgressToUIFormat]);

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
          setFridgeItems(data.items || []);
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
  }, [weekStart]);
  
  // Fetch AI hint when stats change
  useEffect(() => {
    if (currentPlan?.days && currentPlan.days.length > 0) {
      fetchAiHint();
    }
  }, [currentPlan?.days?.length]);
  
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
        (feedbackChannelRef.current as any).unsubscribe();
      } else {
        supabase.removeChannel(feedbackChannelRef.current as RealtimeChannel);
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
          } as any;
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
        (feedbackChannelRef.current as any).unsubscribe?.();
        feedbackChannelRef.current = null;
      }
    };
  }, [showNutritionDetailModal, selectedDayIndex, weekDates, lastFeedbackDate]);
  
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
  }, [activeModal, weeklySummaryTab]);
  
  // Week Navigation
  const goToPreviousWeek = () => {
    const newStart = new Date(weekStart);
    newStart.setDate(weekStart.getDate() - 7);
    setWeekStart(newStart);
    setSelectedDayIndex(0);
    setHasAutoExpanded(false); // 週が変わったらリセット
    setExpandedMealId(null);
    setIsDayNutritionExpanded(false);
  };
  
  const goToNextWeek = () => {
    const newStart = new Date(weekStart);
    newStart.setDate(weekStart.getDate() + 7);
    setWeekStart(newStart);
    setSelectedDayIndex(0);
    setHasAutoExpanded(false); // 週が変わったらリセット
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
    setWeekStart(newWeekStart);
    // Calculate day index based on week start day
    const dayOfWeekRaw = date.getDay();
    const startOffset = weekStartDay === 'sunday' ? 0 : 1;
    let dayIndex = dayOfWeekRaw - startOffset;
    if (dayIndex < 0) dayIndex += 7;
    setSelectedDayIndex(dayIndex);
    setIsCalendarExpanded(false);
    setIsDayNutritionExpanded(false);
    setExpandedMealId(null);
    setHasAutoExpanded(false);
  };

  // Calendar memos
  const calendarDays = useMemo(() => getCalendarDays(displayMonth, weekStartDay), [displayMonth, weekStartDay]);
  const dayLabels = useMemo(() => getDayLabels(weekStartDay), [weekStartDay]);

  const mealExistenceMap = useMemo(() => {
    const map = new Map<string, boolean>();
    currentPlan?.days?.forEach(day => {
      if (day.meals && day.meals.length > 0) {
        map.set(day.dayDate, true);
      }
    });
    return map;
  }, [currentPlan]);

  // --- Handlers ---
  
  const handleUpdateMeal = async (dayId: string, mealId: string | null, updates: Partial<PlannedMeal>) => {
    if (!currentPlan || !mealId) return;
    const updatedDays = currentPlan.days?.map(day => {
      if (day.id !== dayId) return day;
      return { ...day, meals: day.meals?.map(meal => meal.id === mealId ? { ...meal, ...updates } : meal) };
    });
    setCurrentPlan({ ...currentPlan, days: updatedDays });
    try {
      await fetch(`/api/meal-plans/meals/${mealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
    } catch (e) { console.error('Failed to update meal:', e); }
  };
  
  // Toggle completion (can check and uncheck)
  const toggleMealCompletion = async (dayId: string, meal: PlannedMeal) => {
    const newCompleted = !meal.isCompleted;
    handleUpdateMeal(dayId, meal.id, { isCompleted: newCompleted });
  };

  // Add pantry item
  const addPantryItem = async () => {
    if (!newFridgeName) return;
    try {
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
        setFridgeItems(prev => [...prev, item]);
        setNewFridgeName(""); 
        setNewFridgeAmount(""); 
        setNewFridgeExpiry("");
        setActiveModal('fridge');
      }
    } catch (e) { alert("追加に失敗しました"); }
  };

  const deletePantryItem = async (id: string) => {
    try {
      await fetch(`/api/pantry/${id}`, { method: 'DELETE' });
      setFridgeItems(prev => prev.filter(i => i.id !== id));
    } catch (e) { alert("削除に失敗しました"); }
  };

  // Add shopping item
  const addShoppingItem = async () => {
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
        setShoppingList(prev => [...prev, item]);
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
    setShoppingList(prev => prev.map(i => i.id === id ? { ...i, isChecked: !currentChecked } : i));
    
    // 裏でAPI呼び出し（永続化）- レスポンスを待たない
    fetch(`/api/shopping-list/${id}`, { 
        method: 'PATCH', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ isChecked: !currentChecked }) 
    }).catch(e => { 
      console.error('Failed to save check state:', e);
      // エラー時はロールバック
      setShoppingList(prev => prev.map(i => i.id === id ? { ...i, isChecked: currentChecked } : i)); 
    });
  };

  const deleteShoppingItem = async (id: string) => {
    // 楽観的UI更新
    const previousList = shoppingList;
    setShoppingList(prev => prev.filter(i => i.id !== id));
    try {
      const res = await fetch(`/api/shopping-list/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
    } catch (e) {
      // 失敗したら元に戻す
      setShoppingList(previousList);
    }
  };

  // 買い物リスト全削除
  const deleteAllShoppingItems = async () => {
    if (shoppingList.length === 0) return;

    if (!confirm(`${shoppingList.length}件のアイテムをすべて削除しますか？`)) return;

    const previousList = shoppingList;
    const itemIds = shoppingList.map(i => i.id);

    // 楽観的UI更新
    setShoppingList([]);

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
              ? `${data.result.stats.outputCount}件の材料（${data.result.stats.mergedCount}件を統合）`
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
              ? ` (合計${newData.result.stats.totalServings}食分)` 
              : '';
            setSuccessMessage({
              title: '買い物リストを更新しました ✓',
              message: newData.result?.stats 
                ? `${newData.result.stats.outputCount}件の材料（${newData.result.stats.mergedCount}件を統合）${servingsDisplay}`
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
      default:
        return {
          startDate: todayStr,
          endDate: todayStr,
          mealTypes: ['breakfast', 'lunch', 'dinner'] as const,
        };
    }
  }, [shoppingRange]);

  // Regenerate shopping list from menu (非同期版)
  const regenerateShoppingList = async () => {
    if (!currentPlan || isRegeneratingShoppingList) return;
    setIsRegeneratingShoppingList(true);
    setShoppingListProgress({ phase: 'starting', message: '開始中...', percentage: 0 });
    
    // 範囲を計算
    const dateRange = calculateDateRange();
    
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
        localStorage.setItem('shoppingListRegenerating', JSON.stringify({
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
      alert(e.message || "再生成に失敗しました"); 
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
    setShoppingList(prev => prev.map(i => 
      i.id === itemId 
        ? { ...i, selectedVariantIndex: nextIndex, quantity: newQuantity }
        : i
    ));
    
    // 裏でAPIを呼び出し（永続化）- レスポンスを待たない
    fetch(`/api/shopping-list/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedVariantIndex: nextIndex })
    }).catch(e => {
      console.error('Failed to save variant change:', e);
      // エラー時はロールバック
      setShoppingList(prev => prev.map(i => 
        i.id === itemId 
          ? { ...i, selectedVariantIndex: item.selectedVariantIndex, quantity: item.quantity }
          : i
      ));
    });
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
        setShoppingList(prev => [...prev, ...items]);
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
      localStorage.setItem('weeklyMenuGenerating', JSON.stringify({
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
    if (!addMealKey) return;
    
    const dayDate = weekDates[addMealDayIndex]?.dateStr;
    
    // 生成開始前の該当食事タイプの数を記録
    const currentDay = currentPlan?.days?.find((d: any) => d.dayDate === dayDate);
    const initialMealCount = currentDay?.meals?.filter((m: any) => m.mealType === addMealKey).length || 0;
    
    setGeneratingMeal({ dayIndex: addMealDayIndex, mealType: addMealKey });
    setActiveModal(null);
    
    try {
      const preferences: Record<string, boolean> = {};
      selectedConditions.forEach(c => {
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
        localStorage.setItem('singleMealGenerating', JSON.stringify({
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
        alert(`エラー: ${err.error || '生成に失敗しました'}`);
        setGeneratingMeal(null);
        localStorage.removeItem('singleMealGenerating');
      }
    } catch (error) {
      console.error('Meal generation error:', error);
      alert('エラーが発生しました');
      setGeneratingMeal(null);
      localStorage.removeItem('singleMealGenerating');
    }
  };

  // Add meal with specific mode
  const handleAddMealWithMode = async (mode: MealMode) => {
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
    
    try {
      const res = await fetch('/api/meal-plans/meals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dayDate,
          mealType: addMealKey,
          mode,
          dishName: defaultNames[mode],
          isSimple: true
        })
      });
      
      if (res.ok) {
        // Refresh data
        const targetDate = formatLocalDate(weekStart);
        const endDate = addDaysStr(targetDate, 6);
        const refreshRes = await fetch(`/api/meal-plans?startDate=${targetDate}&endDate=${endDate}`);
        if (refreshRes.ok) {
          const { dailyMeals } = await refreshRes.json();
          if (dailyMeals && dailyMeals.length > 0) {
            setCurrentPlan({ days: dailyMeals });
          }
        }
        setActiveModal(null);
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
      const preferences: Record<string, boolean> = {};
      selectedConditions.forEach(c => {
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
        alert(`エラー: ${err.error || '再生成に失敗しました'}`);
        setIsRegenerating(false);
        setRegeneratingMealId(null);
      }
    } catch (error) {
      console.error('Regenerate error:', error);
      alert('エラーが発生しました');
      setIsRegenerating(false);
      setRegeneratingMealId(null);
    }
  };
  
  // 再生成のRealtime監視
  const subscribeToRegenerateStatus = useCallback((requestId: string, weekStartDate: string) => {
    // 既存のサブスクリプションをクリーンアップ
    cleanupRealtime();
    
    console.log('📡 Subscribing to Realtime for regenerate requestId:', requestId);
    
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
          const newStatus = (payload.new as { status: string }).status;
          
          if (newStatus === 'completed') {
            // 完了したら献立を再取得
            console.log('✅ Regeneration completed, fetching meal plan...');
            const weekEndDate = addDaysStr(weekStartDate, 6);
            const planRes = await fetch(`/api/meal-plans?startDate=${weekStartDate}&endDate=${weekEndDate}`);
            if (planRes.ok) {
              const { dailyMeals, shoppingList: shoppingListData } = await planRes.json();
              if (dailyMeals && dailyMeals.length > 0) {
                setCurrentPlan({ days: dailyMeals });
                if (shoppingListData?.items) setShoppingList(shoppingListData.items);
              }
            }
            setIsRegenerating(false);
            setRegeneratingMealId(null);
            cleanupRealtime();
          } else if (newStatus === 'failed') {
            console.log('❌ Regeneration failed');
            setIsRegenerating(false);
            setRegeneratingMealId(null);
            cleanupRealtime();
            alert('献立の再生成に失敗しました。もう一度お試しください。');
          }
        }
      )
      .subscribe((status) => {
        console.log('📡 Realtime regenerate subscription status:', status);
      });
    
    realtimeChannelRef.current = channel;
  }, [cleanupRealtime]);
  
  // Edit meal (legacy - keep for simple edits)
  const openEditMeal = (meal: PlannedMeal) => {
    setEditingMeal(meal);
    setEditMealName(meal.dishName);
    setEditMealMode(meal.mode || 'cook');
    setActiveModal('editMeal');
  };

  const saveEditMeal = async () => {
    if (!editingMeal || !currentPlan) return;
    
    try {
      await fetch(`/api/meal-plans/meals/${editingMeal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dishName: editMealName,
          mode: editMealMode
        })
      });
      
      // Update local state
      const updatedDays = currentPlan.days?.map(day => ({
        ...day,
        meals: day.meals?.map(m => 
          m.id === editingMeal.id 
            ? { ...m, dishName: editMealName, mode: editMealMode }
            : m
        )
      }));
      setCurrentPlan({ ...currentPlan, days: updatedDays });
      setActiveModal(null);
      setEditingMeal(null);
    } catch (e) {
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
          const { dailyMeals } = await refreshRes.json();
          if (dailyMeals && dailyMeals.length > 0) {
            setCurrentPlan({ days: dailyMeals });
          } else {
            setCurrentPlan(null);
          }
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
    setManualDishes(prev => [...prev, { name: '', calories_kcal: 0, role: 'side' }]);
  };

  // Remove dish from manual edit
  const removeManualDish = (index: number) => {
    setManualDishes(prev => prev.filter((_, i) => i !== index));
  };

  // Update dish in manual edit
  const updateManualDish = (index: number, field: keyof DishDetail, value: string | number) => {
    setManualDishes(prev => prev.map((dish, i) => 
      i === index ? { ...dish, [field]: value } : dish
    ));
  };

  // Save manual edit
  const saveManualEdit = async () => {
    if (!manualEditMeal || !currentPlan) return;
    
    const validDishes = manualDishes.filter(d => d.name.trim());
    if (validDishes.length === 0) {
      alert('少なくとも1つの料理名を入力してください');
      return;
    }
    
    const totalCal = validDishes.reduce((sum, d) => sum + (d.calories_kcal ?? (d as any).cal ?? 0), 0);
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
          caloriesKcal: totalCal > 0 ? totalCal : null
        })
      });
      
      // Update local state
      const updatedDays = currentPlan.days?.map(day => ({
        ...day,
        meals: day.meals?.map(m => 
          m.id === manualEditMeal.id 
            ? { ...m, dishName, mode: manualMode, dishes: validDishes, isSimple: validDishes.length === 1, caloriesKcal: totalCal > 0 ? totalCal : null }
            : m
        )
      }));
      setCurrentPlan({ ...currentPlan, days: updatedDays });
      setActiveModal(null);
      setManualEditMeal(null);
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
      setPhotoFiles(prev => [...prev, ...newFiles]);
      
      // プレビュー画像を生成
      newFiles.forEach(file => {
        const reader = new FileReader();
        reader.onloadend = () => {
          setPhotoPreviews(prev => [...prev, reader.result as string]);
        };
        reader.readAsDataURL(file);
      });
    }
  };
  
  // 写真を削除
  const removePhoto = (index: number) => {
    setPhotoFiles(prev => prev.filter((_, i) => i !== index));
    setPhotoPreviews(prev => prev.filter((_, i) => i !== index));
  };

  // Analyze photo with AI（複数枚対応）
  const analyzePhotoWithAI = async () => {
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
            setCurrentPlan({ days: dailyMeals });
            if (shoppingListData?.items) setShoppingList(shoppingListData.items);
          }
        }
        setIsAnalyzingPhoto(false);
      } else {
        const err = await res.json();
        alert(`エラー: ${err.error || '解析に失敗しました'}`);
        setIsAnalyzingPhoto(false);
      }
    } catch (error) {
      console.error('Photo analysis error:', error);
      alert('エラーが発生しました');
      setIsAnalyzingPhoto(false);
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
          const { dailyMeals } = await refreshRes.json();
          if (dailyMeals && dailyMeals.length > 0) {
            setCurrentPlan({ days: dailyMeals });
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
    // 週間献立生成中で、この日が今日以降かどうか
    const dayDate = weekDates[dayIndex]?.dateStr;
    const isWeeklyGeneratingThis = isGenerating && dayDate && dayDate >= todayStr;
    
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
        onClick={() => { setAddMealKey(mealKey); setAddMealDayIndex(dayIndex); setActiveModal('add'); }}
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
    const dishesArray: DishDetail[] = Array.isArray(meal.dishes) 
      ? meal.dishes 
      : meal.dishes 
        ? Object.values(meal.dishes).filter(Boolean) as DishDetail[]
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
          <div className="flex flex-col gap-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); canUp && reorderMeal(meal.id, 'up'); }}
              className="w-5 h-5 rounded flex items-center justify-center transition-colors"
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
              className="w-5 h-5 rounded flex items-center justify-center transition-colors"
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
    const dishesArray: DishDetail[] = Array.isArray(meal.dishes) 
      ? meal.dishes 
      : meal.dishes 
        ? Object.values(meal.dishes).filter(Boolean) as DishDetail[]
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
              <div className="flex flex-col gap-0.5 mr-1">
                <button
                  onClick={(e) => { e.stopPropagation(); canUp && reorderMeal(meal.id, 'up'); }}
                  className="w-5 h-5 rounded flex items-center justify-center transition-colors"
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
                  className="w-5 h-5 rounded flex items-center justify-center transition-colors"
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
                    const d = dish as any;
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
                    <span style={{ fontSize: 9, color: colors.textMuted }}>{dish.calories_kcal ?? (dish as any).cal ?? '-'}kcal</span>
                  </div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: colors.text, margin: 0 }}>{dish.name}</p>
                  {/* 栄養素（P/F/C）- 新旧形式両対応 */}
                  {(dish.protein_g || dish.fat_g || dish.carbs_g || (dish as any).protein || (dish as any).fat || (dish as any).carbs) && (
                    <div className="flex gap-2 mt-1 text-[8px]" style={{ color: colors.textMuted }}>
                      {((dish.protein_g ?? (dish as any).protein) ?? 0) > 0 && <span>P:{dish.protein_g ?? (dish as any).protein}g</span>}
                      {((dish.fat_g ?? (dish as any).fat) ?? 0) > 0 && <span>F:{dish.fat_g ?? (dish as any).fat}g</span>}
                      {((dish.carbs_g ?? (dish as any).carbs) ?? 0) > 0 && <span>C:{dish.carbs_g ?? (dish as any).carbs}g</span>}
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
                onClick={() => openRegenerateMeal(meal)}
                className="flex-1 p-2.5 rounded-[10px] flex items-center justify-center gap-1.5" 
                style={{ background: colors.accentLight, border: `1px solid ${colors.accent}` }}
              >
                <Sparkles size={13} color={colors.accent} />
                <span style={{ fontSize: 12, fontWeight: 500, color: colors.accent }}>AIで変更</span>
              </button>
              <button 
                onClick={() => openManualEdit(meal)}
                className="flex-1 p-2.5 rounded-[10px] flex items-center justify-center gap-1.5"
                style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
              >
                <Pencil size={13} color={colors.textLight} />
                <span style={{ fontSize: 12, fontWeight: 500, color: colors.textLight }}>手動で修正</span>
              </button>
              {canDelete && (
                <button 
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
            <button onClick={() => setActiveModal('stats')} className="w-[34px] h-[34px] rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
              <BarChart3 size={16} color={colors.textLight} />
            </button>
            <button onClick={() => setActiveModal('fridge')} className="w-[34px] h-[34px] rounded-full flex items-center justify-center relative" style={{ background: expiringItems.some(i => getDaysUntil(i.expirationDate)! <= 1) ? colors.dangerLight : colors.bg }}>
              <Refrigerator size={16} color={expiringItems.some(i => getDaysUntil(i.expirationDate)! <= 1) ? colors.danger : colors.textLight} />
              {expiringItems.length > 0 && (
                <div className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: colors.warning }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#fff' }}>{expiringItems.length}</span>
                </div>
              )}
            </button>
            <button onClick={() => setActiveModal('shopping')} className="w-[34px] h-[34px] rounded-full flex items-center justify-center relative" style={{ background: colors.bg }}>
              <ShoppingCart size={16} color={colors.textLight} />
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
            onClick={goToPreviousWeek}
            className="flex flex-col items-center justify-center px-1.5 py-1 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <ChevronLeft size={16} color={colors.textMuted} />
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
                  key={day.dateStr}
                  onClick={() => {
                    setSelectedDayIndex(idx);
                    setIsDayNutritionExpanded(false);
                  }}
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
            onClick={goToNextWeek}
            className="flex flex-col items-center justify-center px-1.5 py-1 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <ChevronRight size={16} color={colors.textMuted} />
            <span style={{ fontSize: 8, color: colors.textMuted, whiteSpace: 'nowrap' }}>翌週</span>
          </button>
        </div>
      </div>

      {/* === Profile Reminder Banner === */}
      <ProfileReminderBanner />

      {/* === AI Banner === */}
      {isGenerating ? (
        <ProgressTodoCard
          progress={generationProgress}
          colors={colors}
        />
      ) : (
        <button
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
            <strong>早めに使い切り:</strong> {expiringItems.filter(i => getDaysUntil(i.expirationDate)! <= 2).map(i => `${i.name}(${getDaysUntil(i.expirationDate)}日)`).join(', ')}
          </span>
        </div>
      )}

      {/* === Main Content === */}
      <main className="flex-1 p-3 overflow-y-auto">
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
              {weekDates[selectedDayIndex]?.date.getMonth() + 1}/{weekDates[selectedDayIndex]?.date.getDate()}（{weekDates[selectedDayIndex]?.dayOfWeek}）
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
                              const value = (dayNutrition as any)[key] ?? 0;
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
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
                style={{ background: colors.card, maxHeight: '70vh' }}
              >
                <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Sparkles size={18} color={colors.accent} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>AIアシスタント</span>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                  <button
                    onClick={handleGenerateWeekly}
                    disabled={isGenerating}
                    className="w-full p-4 mb-3 rounded-[14px] text-left transition-opacity"
                    style={{ background: colors.accent, opacity: isGenerating ? 0.6 : 1 }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {isGenerating ? (
                        <div className="w-[18px] h-[18px] border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <Sparkles size={18} color="#fff" />
                      )}
                      <span style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>
                        {isGenerating 
                          ? '生成中...' 
                          : emptySlotCount > 0
                            ? '空欄をすべて埋める'
                            : 'AI献立アシスタント'}
                      </span>
                    </div>
                    <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', margin: 0 }}>
                      {isGenerating
                        ? 'AIが献立を作成しています...'
                        : emptySlotCount > 0
                          ? `${emptySlotCount}件の空欄にAIが献立を提案します`
                          : `期間を指定してAIに献立を作成してもらえます`}
                    </p>
                  </button>
                  <p style={{ fontSize: 11, color: colors.textMuted, margin: '12px 0 8px' }}>条件を指定（複数選択可）</p>
                  {AI_CONDITIONS.map((text, i) => {
                    const isSelected = selectedConditions.includes(text);
                    return (
                      <button 
                        key={i} 
                        onClick={() => setSelectedConditions(prev => isSelected ? prev.filter(c => c !== text) : [...prev, text])}
                        className="w-full p-3 mb-1.5 rounded-[10px] text-left text-[13px] flex items-center justify-between transition-all"
                        style={{ 
                          background: isSelected ? colors.accentLight : colors.bg, 
                          color: isSelected ? colors.accent : colors.text,
                          border: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent'
                        }}
                      >
                        <span>{text}</span>
                        {isSelected && <Check size={16} color={colors.accent} />}
                      </button>
                    );
                  })}
                </div>
                <div className="px-4 py-3 flex gap-2 flex-shrink-0 pb-4 lg:pb-6" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
                  <input 
                    type="text" 
                    value={aiChatInput}
                    onChange={(e) => setAiChatInput(e.target.value)}
                    placeholder="例: 木金は簡単に..." 
                    className="flex-1 px-3.5 py-2.5 rounded-full text-[13px] outline-none"
                    style={{ background: colors.bg }}
                  />
                  <button 
                    onClick={handleGenerateWeekly}
                    disabled={isGenerating}
                    className="w-11 h-11 rounded-full flex items-center justify-center cursor-pointer hover:opacity-90 transition-opacity" 
                    style={{ background: colors.accent }}
                  >
                    <Send size={16} color="#fff" />
                  </button>
                </div>
              </motion.div>
            )}

            {/* Stats Modal - 新デザイン: 週間サマリー + 今日/今週タブ */}
            {activeModal === 'stats' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
                style={{ background: colors.card, maxHeight: '85vh' }}
              >
                {/* ヘッダー */}
                <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <BarChart3 size={18} color={colors.purple} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>栄養分析</span>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                
                <div className="flex-1 overflow-auto pb-4 lg:pb-6">
                  {/* 週間サマリーヘッダー */}
                  <div className="px-4 pt-3 pb-2" style={{ background: `linear-gradient(135deg, ${colors.purpleLight} 0%, ${colors.accentLight} 100%)` }}>
                    <div className="flex gap-2 mb-2">
                      <div className="flex-1 rounded-xl p-2.5 text-center" style={{ background: 'rgba(255,255,255,0.8)' }}>
                        <ChefHat size={18} color={colors.success} className="mx-auto mb-0.5" />
                        <p style={{ fontSize: 20, fontWeight: 700, color: colors.success, margin: 0 }}>{stats.cookRate}%</p>
                        <p style={{ fontSize: 9, color: colors.textLight, margin: 0 }}>自炊率</p>
                    </div>
                      <div className="flex-1 rounded-xl p-2.5 text-center" style={{ background: 'rgba(255,255,255,0.8)' }}>
                        <Flame size={18} color={colors.accent} className="mx-auto mb-0.5" />
                        <p style={{ fontSize: 20, fontWeight: 700, color: colors.accent, margin: 0 }}>{stats.avgCal}</p>
                        <p style={{ fontSize: 9, color: colors.textLight, margin: 0 }}>平均kcal/日</p>
                    </div>
                      <div className="flex-1 rounded-xl p-2.5 text-center" style={{ background: 'rgba(255,255,255,0.8)' }}>
                        <div className="flex justify-center gap-1 mb-0.5">
                          <span style={{ fontSize: 9, color: colors.success }}>🍳{stats.cookCount}</span>
                          <span style={{ fontSize: 9, color: colors.purple }}>🛒{stats.buyCount}</span>
                          <span style={{ fontSize: 9, color: colors.warning }}>🍽{stats.outCount}</span>
                  </div>
                        <p style={{ fontSize: 14, fontWeight: 600, color: colors.text, margin: 0 }}>{stats.cookCount + stats.buyCount + stats.outCount}食</p>
                        <p style={{ fontSize: 9, color: colors.textLight, margin: 0 }}>今週の献立</p>
                      </div>
                  </div>
                  </div>
                  
                  {/* タブ */}
                  <div className="flex px-4 py-2 gap-2" style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <button
                      onClick={() => setWeeklySummaryTab('today')}
                      className="flex-1 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{
                        background: weeklySummaryTab === 'today' ? colors.accent : 'transparent',
                        color: weeklySummaryTab === 'today' ? '#fff' : colors.textLight,
                      }}
                    >
                      📅 今日
                    </button>
                    <button
                      onClick={() => setWeeklySummaryTab('week')}
                      className="flex-1 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{
                        background: weeklySummaryTab === 'week' ? colors.accent : 'transparent',
                        color: weeklySummaryTab === 'week' ? '#fff' : colors.textLight,
                      }}
                    >
                      📊 今週
                    </button>
                  </div>
                  
                  {/* タブコンテンツ */}
                  <div className="p-4">
                    {weeklySummaryTab === 'today' ? (
                      // 今日タブ
                      (() => {
                        const todayIndex = weekDates.findIndex(d => d.dateStr === formatLocalDate(new Date()));
                        const todayDayData = currentPlan?.days?.find(d => d.dayDate === formatLocalDate(new Date()));
                        const todayNutrition = getDayTotalNutrition(todayDayData);
                        const mealCount = todayDayData?.meals?.length || 0;
                        
                        return (
                          <>
                            {/* 今日の日付 */}
                            <div className="flex items-center justify-between mb-3">
                              <p style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
                                {new Date().getMonth() + 1}月{new Date().getDate()}日（{['日', '月', '火', '水', '木', '金', '土'][new Date().getDay()]}）の栄養
                              </p>
                              <span className="px-2 py-0.5 rounded-full text-[10px]" style={{ background: colors.accentLight, color: colors.accent }}>
                                {mealCount}食分
                              </span>
                            </div>
                            
                            {/* レーダーチャート */}
                            <div className="flex justify-center mb-3">
                              <NutritionRadarChart
                                nutrition={todayNutrition}
                                selectedNutrients={radarChartNutrients}
                                size={180}
                                showLabels={true}
                              />
                            </div>
                            
                            {/* AI栄養士コメント（褒め＋アドバイス） */}
                            <div className="mb-3 space-y-2">
                              {/* 褒めコメント */}
                              <div className="p-3 rounded-xl" style={{ background: colors.successLight }}>
                                <div className="flex items-center gap-2 mb-1">
                                  <Heart size={12} color={colors.success} fill={colors.success} />
                                  <span style={{ fontSize: 11, fontWeight: 600, color: colors.success }}>褒めポイント</span>
                                </div>
                                {isLoadingFeedback ? (
                                  <div className="flex items-center gap-2">
                                    <div className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.success, borderTopColor: 'transparent' }} />
                                    <span style={{ fontSize: 11, color: colors.textLight }}>あなたの献立を分析中...</span>
                                  </div>
                                ) : praiseComment ? (
                                  <p style={{ fontSize: 12, color: colors.text, lineHeight: 1.5 }}>{praiseComment}</p>
                                ) : (
                                  <p style={{ fontSize: 11, color: colors.textMuted }}>分析データがありません</p>
                                )}
                              </div>

                              {/* アドバイス */}
                              {(nutritionFeedback || isLoadingFeedback) && (
                                <div className="p-3 rounded-xl" style={{ background: colors.accentLight }}>
                                  <div className="flex items-center gap-2 mb-1">
                                    <Sparkles size={12} color={colors.accent} />
                                    <span style={{ fontSize: 11, fontWeight: 600, color: colors.accent }}>改善アドバイス</span>
                                  </div>
                                  {isLoadingFeedback ? (
                                    <span style={{ fontSize: 11, color: colors.textMuted }}>...</span>
                                  ) : (
                                    <p style={{ fontSize: 11, color: colors.text, lineHeight: 1.5 }}>{nutritionFeedback}</p>
                                  )}
                                </div>
                              )}

                              {/* 栄養豆知識 */}
                              {nutritionTip && (
                                <div className="p-2 rounded-lg flex items-start gap-2" style={{ background: colors.blueLight }}>
                                  <span style={{ fontSize: 10 }}>💡</span>
                                  <p style={{ fontSize: 10, color: colors.blue, lineHeight: 1.4 }}>{nutritionTip}</p>
                                </div>
                              )}
                            </div>
                            
                            {/* 献立改善ボタン */}
                            {nutritionFeedback && (
                              <button
                                onClick={() => {
                                  setActiveModal(null);
                                  // 今日の日を選択してから栄養詳細モーダルを開く
                                  const todayIdx = weekDates.findIndex(d => d.dateStr === formatLocalDate(new Date()));
                                  if (todayIdx >= 0) {
                                    setSelectedDayIndex(todayIdx);
                                  }
                                  setShowNutritionDetailModal(true);
                                }}
                                className="w-full p-2.5 rounded-lg font-medium flex items-center justify-center gap-2 transition-all hover:opacity-90"
                                style={{ background: colors.accent, color: '#fff', fontSize: 12 }}
                              >
                                <RefreshCw size={14} />
                                詳細を見る / 献立を改善
                              </button>
                            )}
                          </>
                        );
                      })()
                    ) : (
                      // 今週タブ
                      (() => {
                        const weekNutrition = getWeekTotalNutrition();
                        
                        return (
                          <>
                            {/* 週の期間 */}
                            <div className="flex items-center justify-between mb-3">
                              <p style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>
                                {weekDates[0]?.date.getMonth() + 1}/{weekDates[0]?.date.getDate()} 〜 {weekDates[6]?.date.getMonth() + 1}/{weekDates[6]?.date.getDate()} の平均栄養
                              </p>
                              <span className="px-2 py-0.5 rounded-full text-[10px]" style={{ background: colors.purpleLight, color: colors.purple }}>
                                {weekNutrition.daysWithMeals}日分
                              </span>
                            </div>
                            
                            {/* 週間レーダーチャート */}
                            <div className="flex justify-center mb-3">
                              <NutritionRadarChart
                                nutrition={weekNutrition.averages}
                                selectedNutrients={radarChartNutrients}
                                size={180}
                                showLabels={true}
                              />
                            </div>
                            
                            {/* 週間AI栄養士コメント */}
                            <div className="mb-3 p-3 rounded-xl" style={{ background: colors.purpleLight }}>
                              <div className="flex items-center gap-2 mb-1">
                      <Sparkles size={12} color={colors.purple} />
                                <span style={{ fontSize: 11, fontWeight: 600, color: colors.purple }}>週間AIヒント</span>
                    </div>
                    {isLoadingHint ? (
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                        <span style={{ fontSize: 11, color: colors.textMuted }}>ヒントを生成中...</span>
                      </div>
                    ) : (
                                <p style={{ fontSize: 11, color: colors.text, lineHeight: 1.5 }}>
                        {aiHint || `今週の自炊率は${stats.cookRate}%です。週末にまとめて作り置きすると、平日の自炊率が上がりますよ！`}
                      </p>
                              )}
                            </div>
                            
                            {/* 主要栄養素の週間平均 */}
                            <div className="grid grid-cols-3 gap-2">
                              {[
                                { label: 'カロリー', value: `${Math.round(weekNutrition.averages.caloriesKcal)}`, unit: 'kcal', color: colors.accent },
                                { label: 'タンパク質', value: `${Math.round(weekNutrition.averages.proteinG)}`, unit: 'g', color: colors.success },
                                { label: '脂質', value: `${Math.round(weekNutrition.averages.fatG)}`, unit: 'g', color: colors.warning },
                                { label: '炭水化物', value: `${Math.round(weekNutrition.averages.carbsG)}`, unit: 'g', color: colors.blue },
                                { label: '食物繊維', value: `${Math.round(weekNutrition.averages.fiberG * 10) / 10}`, unit: 'g', color: colors.purple },
                                { label: '塩分', value: `${Math.round(weekNutrition.averages.sodiumG * 10) / 10}`, unit: 'g', color: colors.danger },
                              ].map(item => (
                                <div key={item.label} className="p-2 rounded-lg text-center" style={{ background: colors.bg }}>
                                  <p style={{ fontSize: 16, fontWeight: 600, color: item.color, margin: 0 }}>{item.value}</p>
                                  <p style={{ fontSize: 9, color: colors.textLight, margin: 0 }}>{item.label}({item.unit}/日)</p>
                                </div>
                              ))}
                            </div>
                          </>
                        );
                      })()
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {/* Fridge Modal */}
            {activeModal === 'fridge' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
                style={{ background: colors.card, maxHeight: '75vh' }}
              >
                <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Refrigerator size={18} color={colors.blue} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>冷蔵庫</span>
                    <span style={{ fontSize: 11, color: colors.textMuted }}>{fridgeItems.length}品</span>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-3 overflow-auto">
                  {fridgeItems.length === 0 ? (
                    <p className="text-center py-8" style={{ color: colors.textMuted }}>冷蔵庫は空です</p>
                  ) : (
                    fridgeItems.sort((a, b) => (getDaysUntil(a.expirationDate) || 999) - (getDaysUntil(b.expirationDate) || 999)).map(item => {
                      const daysLeft = getDaysUntil(item.expirationDate);
                      return (
                        <div key={item.id} className="flex items-center justify-between px-3 py-2.5 rounded-[10px] mb-1.5" style={{ 
                          background: daysLeft !== null && daysLeft <= 1 ? colors.dangerLight : daysLeft !== null && daysLeft <= 3 ? colors.warningLight : colors.bg 
                        }}>
                          <div className="flex items-center gap-2.5">
                            <span style={{ fontSize: 14, fontWeight: 500, color: colors.text }}>{item.name}</span>
                            <span style={{ fontSize: 11, color: colors.textMuted }}>{item.amount || ''}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span style={{
                              fontSize: 10,
                              fontWeight: 600,
                              color: daysLeft !== null && daysLeft <= 1 ? colors.danger : daysLeft !== null && daysLeft <= 3 ? colors.warning : colors.textMuted,
                            }}>
                              {daysLeft === null ? '' : daysLeft === 0 ? '今日まで' : daysLeft === 1 ? '明日まで' : `${daysLeft}日`}
                            </span>
                            <button onClick={() => deletePantryItem(item.id)} className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.05)' }}>
                              <Trash2 size={12} color={colors.textMuted} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="px-4 py-2.5 pb-4 lg:pb-6" style={{ borderTop: `1px solid ${colors.border}` }}>
                  <button onClick={() => setActiveModal('addFridge')} className="w-full p-3 rounded-xl flex items-center justify-center gap-1.5" style={{ background: colors.bg, border: `1px dashed ${colors.border}` }}>
                    <Plus size={16} color={colors.textMuted} />
                    <span style={{ fontSize: 13, color: colors.textMuted }}>食材を追加</span>
                  </button>
                </div>
              </motion.div>
            )}

            {/* Add Fridge Item Modal */}
            {activeModal === 'addFridge' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl"
                style={{ background: colors.card }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-center mb-4">
                  <span style={{ fontSize: 15, fontWeight: 600 }}>食材を追加</span>
                  <button onClick={() => setActiveModal('fridge')} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="space-y-3">
                  <input
                    type="text"
                    value={newFridgeName}
                    onChange={(e) => setNewFridgeName(e.target.value)}
                    placeholder="食材名（例: 鶏もも肉）"
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <input
                    type="text"
                    value={newFridgeAmount}
                    onChange={(e) => setNewFridgeAmount(e.target.value)}
                    placeholder="量（例: 300g）"
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <input
                    type="date"
                    value={newFridgeExpiry}
                    onChange={(e) => setNewFridgeExpiry(e.target.value)}
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <button
                    onClick={addPantryItem}
                    disabled={!newFridgeName}
                    className="w-full p-3 rounded-xl font-semibold text-[14px] disabled:opacity-50"
                    style={{ background: colors.accent, color: '#fff' }}
                  >
                    追加する
                  </button>
                </div>
              </motion.div>
            )}

            {/* Shopping List Modal */}
            {activeModal === 'shopping' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
                style={{ background: colors.card, maxHeight: '75vh' }}
              >
                <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <ShoppingCart size={18} color={colors.accent} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>買い物リスト</span>
                    <span style={{ fontSize: 11, color: colors.textMuted }}>{shoppingList.filter(i => !i.isChecked).length}/{shoppingList.length}</span>
                    {shoppingListTotalServings !== null && shoppingListTotalServings > 0 && (
                      <span style={{ fontSize: 11, color: colors.accent, fontWeight: 600, background: colors.accentLight, padding: '2px 6px', borderRadius: 8 }}>
                        {shoppingListTotalServings}食分
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {shoppingList.length > 0 && (
                      <button
                        onClick={deleteAllShoppingItems}
                        className="w-7 h-7 rounded-full flex items-center justify-center"
                        style={{ background: colors.bg }}
                        title="すべて削除"
                      >
                        <Trash2 size={14} color={colors.danger || '#ef4444'} />
                      </button>
                    )}
                    <button
                      onClick={() => setShowServingsModal(true)}
                      className="w-7 h-7 rounded-full flex items-center justify-center"
                      style={{ background: colors.bg }}
                      title="人数設定"
                    >
                      <Users size={14} color={colors.textLight} />
                    </button>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                  </div>
                </div>
                <div className="flex-1 p-3 overflow-auto">
                  {shoppingList.length === 0 ? (
                    <p className="text-center py-8" style={{ color: colors.textMuted }}>買い物リストは空です</p>
                  ) : (
                    <div className="space-y-4">
                      {groupedShoppingList.map(([category, items]) => (
                        <div key={category}>
                          {/* カテゴリ見出し */}
                          <div className="flex items-center gap-2 mb-2 px-1">
                            <span className="text-[13px] font-semibold" style={{ color: colors.text }}>{category}</span>
                            <span className="text-[11px]" style={{ color: colors.textMuted }}>
                              {items.filter(i => !i.isChecked).length}/{items.length}
                            </span>
                          </div>
                          {/* カテゴリ内アイテム */}
                          {items.map(item => (
                      <div
                        key={item.id}
                        className="flex items-center gap-2.5 p-3 rounded-[10px] mb-1.5"
                        style={{ background: item.isChecked ? colors.bg : colors.card, border: item.isChecked ? 'none' : `1px solid ${colors.border}` }}
                      >
                        <button
                          onClick={() => toggleShoppingItem(item.id, item.isChecked)}
                          className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0"
                          style={{ 
                            border: item.isChecked ? 'none' : `2px solid ${colors.border}`,
                            background: item.isChecked ? colors.success : 'transparent'
                          }}
                        >
                          {item.isChecked && <Check size={12} color="#fff" />}
                        </button>
                        <span className="flex-1" style={{ fontSize: 14, color: item.isChecked ? colors.textMuted : colors.text, textDecoration: item.isChecked ? 'line-through' : 'none' }}>
                          {item.itemName}
                        </span>
                              {/* 数量（タップで切り替え） */}
                              <button
                                onClick={() => toggleShoppingVariant(item.id, item)}
                                disabled={!item.quantityVariants || item.quantityVariants.length <= 1}
                                className="px-2 py-0.5 rounded text-[12px] transition-colors"
                                style={{ 
                                  color: colors.textMuted, 
                                  background: item.quantityVariants?.length > 1 ? colors.bg : 'transparent',
                                  cursor: item.quantityVariants?.length > 1 ? 'pointer' : 'default'
                                }}
                                title={item.quantityVariants?.length > 1 ? 'タップで単位切替' : undefined}
                              >
                                {item.quantity || '適量'}
                                {item.quantityVariants?.length > 1 && <span className="ml-0.5 text-[10px]">⟳</span>}
                              </button>
                              {/* AI/手動バッジ */}
                              <span 
                                className="px-1.5 py-0.5 rounded text-[10px]" 
                                style={{ 
                                  background: item.source === 'generated' ? '#E8F5E9' : '#FFF3E0',
                                  color: item.source === 'generated' ? '#2E7D32' : '#E65100'
                                }}
                              >
                                {item.source === 'generated' ? 'AI' : '手動'}
                              </span>
                        <button
                          onClick={() => deleteShoppingItem(item.id)}
                          className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                          style={{ background: 'rgba(0,0,0,0.05)' }}
                        >
                          <Trash2 size={12} color={colors.textMuted} />
                        </button>
                      </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* 再生成中の進捗表示 */}
                {isRegeneratingShoppingList && shoppingListProgress && (
                  <div className="mx-0">
                    <ProgressTodoCard
                      progress={shoppingListProgress}
                      colors={colors}
                      phases={SHOPPING_LIST_PHASES}
                      defaultMessage="買い物リストを生成中..."
                    />
                    {/* エラー時の閉じるボタン */}
                    {shoppingListProgress.phase === 'failed' && (
                      <div className="mx-3 mt-2 flex justify-end">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsRegeneratingShoppingList(false);
                            setShoppingListProgress(null);
                            setShoppingListRequestId(null);
                          }}
                          className="px-4 py-2 rounded-lg text-sm font-medium"
                          style={{ background: colors.card, color: colors.text, border: `1px solid ${colors.border}` }}
                        >
                          閉じる
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <div className="px-4 py-2.5 pb-4 lg:pb-6 flex gap-2" style={{ borderTop: `1px solid ${colors.border}` }}>
                  <button onClick={() => setActiveModal('addShopping')} className="flex-1 p-3 rounded-xl flex items-center justify-center gap-1.5" style={{ background: colors.bg, border: `1px dashed ${colors.border}` }}>
                    <Plus size={14} color={colors.textMuted} />
                    <span style={{ fontSize: 12, color: colors.textMuted }}>追加</span>
                  </button>
                  <button 
                    onClick={() => setActiveModal('shoppingRange')} 
                    disabled={isRegeneratingShoppingList}
                    className="flex-[2] p-3 rounded-xl flex items-center justify-center gap-1.5 transition-opacity" 
                    style={{ background: colors.accent, opacity: isRegeneratingShoppingList ? 0.7 : 1 }}
                  >
                    {isRegeneratingShoppingList ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>AIが整理中...</span>
                      </>
                    ) : (
                      <>
                    <RefreshCw size={14} color="#fff" />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>献立から再生成</span>
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Add Shopping Item Modal */}
            {activeModal === 'addShopping' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl"
                style={{ background: colors.card }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-center mb-4">
                  <span style={{ fontSize: 15, fontWeight: 600 }}>買い物リストに追加</span>
                  <button onClick={() => setActiveModal('shopping')} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="space-y-3">
                  <input
                    type="text"
                    value={newShoppingName}
                    onChange={(e) => setNewShoppingName(e.target.value)}
                    placeholder="品名（例: もやし）"
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <input
                    type="text"
                    value={newShoppingAmount}
                    onChange={(e) => setNewShoppingAmount(e.target.value)}
                    placeholder="量（例: 2袋）"
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  />
                  <select
                    value={newShoppingCategory}
                    onChange={(e) => setNewShoppingCategory(e.target.value)}
                    className="w-full p-3 rounded-xl text-[14px] outline-none"
                    style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                  >
                    <option value="野菜">野菜</option>
                    <option value="肉">肉</option>
                    <option value="魚">魚</option>
                    <option value="乳製品">乳製品</option>
                    <option value="調味料">調味料</option>
                    <option value="乾物">乾物</option>
                    <option value="食材">その他</option>
                  </select>
                  <button
                    onClick={addShoppingItem}
                    disabled={!newShoppingName}
                    className="w-full p-3 rounded-xl font-semibold text-[14px] disabled:opacity-50"
                    style={{ background: colors.accent, color: '#fff' }}
                  >
                    追加する
                  </button>
                </div>
              </motion.div>
            )}

            {/* Shopping Range Selection Modal (2-step) */}
            {activeModal === 'shoppingRange' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl max-h-[75vh] overflow-y-auto"
                style={{ background: colors.card }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Step 1: 範囲選択 */}
                {shoppingRangeStep === 'range' && (
                  <>
                    <div className="flex justify-between items-center mb-4">
                      <div className="flex items-center gap-2">
                        <span style={{ fontSize: 15, fontWeight: 600 }}>買い物の範囲を選択</span>
                        <span style={{ fontSize: 11, color: colors.textMuted, background: colors.bg, padding: '2px 6px', borderRadius: 6 }}>ステップ 1/2</span>
                      </div>
                      <button onClick={() => { setActiveModal('shopping'); setShoppingRangeStep('range'); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                        <X size={14} color={colors.textLight} />
                      </button>
                    </div>
                    
                    <div className="space-y-2">
                      {/* 今日の分 */}
                      <div>
                        <button
                          onClick={() => {
                            if (shoppingRange.type === 'today') {
                              setIsTodayExpanded(!isTodayExpanded);
                            } else {
                              setShoppingRange({ ...shoppingRange, type: 'today' });
                              setIsTodayExpanded(true);
                            }
                          }}
                          className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
                          style={{ 
                            background: shoppingRange.type === 'today' ? colors.accent : colors.bg,
                            border: `1px solid ${shoppingRange.type === 'today' ? colors.accent : colors.border}`
                          }}
                        >
                          <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'today' ? '#fff' : colors.text }}>
                            今日の分
                          </span>
                          {shoppingRange.type === 'today' && (
                            <ChevronDown 
                              size={16} 
                              color="#fff" 
                              style={{ transform: isTodayExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                            />
                          )}
                        </button>
                        
                        {/* 今日の食事タイプ選択 */}
                        <AnimatePresence>
                          {shoppingRange.type === 'today' && isTodayExpanded && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="pl-4 pt-2 space-y-1">
                                {(['breakfast', 'lunch', 'dinner'] as const).map((mealType) => {
                                  const isSelected = shoppingRange.todayMeals.includes(mealType);
                                  const label = mealType === 'breakfast' ? '朝食' : mealType === 'lunch' ? '昼食' : '夕食';
                                  return (
                                    <button
                                      key={mealType}
                                      onClick={() => {
                                        const newMeals = isSelected
                                          ? shoppingRange.todayMeals.filter(m => m !== mealType)
                                          : [...shoppingRange.todayMeals, mealType];
                                        setShoppingRange({ ...shoppingRange, todayMeals: newMeals });
                                      }}
                                      className="w-full p-2.5 rounded-lg flex items-center gap-2"
                                      style={{ background: isSelected ? `${colors.accent}15` : 'transparent' }}
                                    >
                                      <div 
                                        className="w-5 h-5 rounded flex items-center justify-center"
                                        style={{ 
                                          background: isSelected ? colors.accent : 'transparent',
                                          border: `2px solid ${isSelected ? colors.accent : colors.border}`
                                        }}
                                      >
                                        {isSelected && <Check size={12} color="#fff" />}
                                      </div>
                                      <span style={{ fontSize: 13, color: colors.text }}>{label}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                      
                      {/* 明日の分 */}
                      <button
                        onClick={() => setShoppingRange({ ...shoppingRange, type: 'tomorrow' })}
                        className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
                        style={{ 
                          background: shoppingRange.type === 'tomorrow' ? colors.accent : colors.bg,
                          border: `1px solid ${shoppingRange.type === 'tomorrow' ? colors.accent : colors.border}`
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'tomorrow' ? '#fff' : colors.text }}>
                          明日の分
                        </span>
                      </button>
                      
                      {/* 明後日の分 */}
                      <button
                        onClick={() => setShoppingRange({ ...shoppingRange, type: 'dayAfterTomorrow' })}
                        className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
                        style={{ 
                          background: shoppingRange.type === 'dayAfterTomorrow' ? colors.accent : colors.bg,
                          border: `1px solid ${shoppingRange.type === 'dayAfterTomorrow' ? colors.accent : colors.border}`
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'dayAfterTomorrow' ? '#fff' : colors.text }}>
                          明後日の分
                        </span>
                      </button>
                      
                      {/* 1週間分 */}
                      <button
                        onClick={() => setShoppingRange({ ...shoppingRange, type: 'week' })}
                        className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
                        style={{ 
                          background: shoppingRange.type === 'week' ? colors.accent : colors.bg,
                          border: `1px solid ${shoppingRange.type === 'week' ? colors.accent : colors.border}`
                        }}
                      >
                        <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'week' ? '#fff' : colors.text }}>
                          1週間分
                        </span>
                      </button>
                      
                      {/* ○○日分 */}
                      <div>
                        <button
                          onClick={() => setShoppingRange({ ...shoppingRange, type: 'days' })}
                          className="w-full p-3 rounded-xl flex items-center justify-between transition-colors"
                          style={{ 
                            background: shoppingRange.type === 'days' ? colors.accent : colors.bg,
                            border: `1px solid ${shoppingRange.type === 'days' ? colors.accent : colors.border}`
                          }}
                        >
                          <span style={{ fontSize: 14, fontWeight: 500, color: shoppingRange.type === 'days' ? '#fff' : colors.text }}>
                            {shoppingRange.daysCount}日分
                          </span>
                        </button>
                        
                        {shoppingRange.type === 'days' && (
                          <div className="pl-4 pt-2 flex items-center gap-2">
                            <input
                              type="number"
                              min={1}
                              max={14}
                              value={shoppingRange.daysCount}
                              onChange={(e) => setShoppingRange({ ...shoppingRange, daysCount: parseInt(e.target.value) || 1 })}
                              className="w-20 p-2 rounded-lg text-center text-[14px] outline-none"
                              style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                            />
                            <span style={{ fontSize: 13, color: colors.textMuted }}>日分（今日から）</span>
                          </div>
                        )}
                      </div>
                    </div>
                    
                    {/* 次へボタン */}
                    <button
                      onClick={() => setShoppingRangeStep('servings')}
                      disabled={shoppingRange.type === 'today' && shoppingRange.todayMeals.length === 0}
                      className="w-full mt-4 p-3.5 rounded-xl font-semibold text-[14px] disabled:opacity-50 flex items-center justify-center gap-2"
                      style={{ background: colors.accent, color: '#fff' }}
                    >
                      次へ（人数確認）
                      <ChevronRight size={18} />
                    </button>
                  </>
                )}
                
                {/* Step 2: 人数確認・編集 */}
                {shoppingRangeStep === 'servings' && (
                  <>
                    <div className="flex justify-between items-center mb-4">
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => setShoppingRangeStep('range')}
                          className="w-7 h-7 rounded-full flex items-center justify-center"
                          style={{ background: colors.bg }}
                        >
                          <ChevronLeft size={14} color={colors.textLight} />
                        </button>
                        <span style={{ fontSize: 15, fontWeight: 600 }}>人数を確認</span>
                        <span style={{ fontSize: 11, color: colors.textMuted, background: colors.bg, padding: '2px 6px', borderRadius: 6 }}>ステップ 2/2</span>
                      </div>
                      <button onClick={() => { setActiveModal('shopping'); setShoppingRangeStep('range'); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                        <X size={14} color={colors.textLight} />
                      </button>
                    </div>
                    
                    <p style={{ fontSize: 13, color: colors.textLight, marginBottom: 12 }}>
                      各セルをクリックして人数を変更できます（0=作らない）
                    </p>
                    
                    {/* Grid Header */}
                    <div className="grid grid-cols-4 gap-2 mb-2">
                      <div />
                      {(['朝', '昼', '夜'] as const).map((label, i) => (
                        <div key={i} className="text-center font-bold" style={{ fontSize: 13, color: colors.text }}>{label}</div>
                      ))}
                    </div>
                    
                    {/* Grid Rows */}
                    {(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const).map((day) => {
                      const labels: Record<string, string> = { monday: '月', tuesday: '火', wednesday: '水', thursday: '木', friday: '金', saturday: '土', sunday: '日' };
                      const isWeekend = day === 'saturday' || day === 'sunday';
                      const defaultServings = servingsConfig?.default ?? 2;
                      
                      return (
                        <div key={day} className="grid grid-cols-4 gap-2 mb-2">
                          <div className="flex items-center justify-center font-bold" style={{ fontSize: 13, color: isWeekend ? colors.accent : colors.text }}>
                            {labels[day]}
                          </div>
                          {(['breakfast', 'lunch', 'dinner'] as const).map((meal) => {
                            const value = servingsConfig?.byDayMeal?.[day]?.[meal] ?? defaultServings;
                            
                            const updateValue = (newValue: number) => {
                              const updated: ServingsConfig = {
                                default: servingsConfig?.default ?? 2,
                                byDayMeal: { ...servingsConfig?.byDayMeal }
                              };
                              if (!updated.byDayMeal[day]) updated.byDayMeal[day] = {};
                              updated.byDayMeal[day][meal] = Math.max(0, Math.min(10, newValue));
                              setServingsConfig(updated);
                            };
                            
                            return (
                              <div
                                key={meal}
                                className="flex items-center justify-between rounded-lg px-1"
                                style={{
                                  background: value === 0 ? colors.bg : colors.successLight,
                                  border: `1px solid ${value === 0 ? colors.border : colors.success}`
                                }}
                              >
                                <button
                                  onClick={() => updateValue(value - 1)}
                                  className="w-6 h-8 flex items-center justify-center text-lg font-bold"
                                  style={{ color: value === 0 ? colors.textMuted : colors.success }}
                                >
                                  −
                                </button>
                                <span 
                                  className="font-bold text-center min-w-[16px]"
                                  style={{ 
                                    fontSize: 14,
                                    color: value === 0 ? colors.textMuted : colors.success 
                                  }}
                                >
                                  {value === 0 ? '-' : value}
                                </span>
                                <button
                                  onClick={() => updateValue(value + 1)}
                                  className="w-6 h-8 flex items-center justify-center text-lg font-bold"
                                  style={{ color: value === 0 ? colors.textMuted : colors.success }}
                                >
                                  +
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                    
                    {/* Legend */}
                    <div className="flex justify-center gap-4 mt-3 mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded" style={{ background: colors.successLight, border: `1px solid ${colors.success}` }} />
                        <span style={{ fontSize: 11, color: colors.textLight }}>作る</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 rounded" style={{ background: colors.bg, border: `1px solid ${colors.border}` }} />
                        <span style={{ fontSize: 11, color: colors.textLight }}>作らない</span>
                      </div>
                    </div>
                    
                    {/* 生成開始ボタン */}
                    <button
                      onClick={async () => {
                        // まずservingsConfigを保存
                        if (servingsConfig) {
                          try {
                            await fetch('/api/profile', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ servingsConfig })
                            });
                          } catch (e) {
                            console.error('Failed to save servings config:', e);
                          }
                        }
                        setActiveModal('shopping');
                        setShoppingRangeStep('range');
                        regenerateShoppingList();
                      }}
                      className="w-full mt-2 p-3.5 rounded-xl font-semibold text-[14px] flex items-center justify-center gap-2"
                      style={{ background: colors.accent, color: '#fff' }}
                    >
                      <Sparkles size={18} />
                      この設定で買い物リストを生成
                    </button>
                  </>
                )}
              </motion.div>
            )}

            {/* Recipe Modal */}
            {activeModal === 'recipe' && selectedRecipe && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
                style={{ background: colors.card, maxHeight: '80vh' }}
              >
                <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <BookOpen size={18} color={colors.accent} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>{selectedRecipe}</span>
                  </div>
                  <button onClick={() => { setActiveModal(null); setSelectedRecipe(null); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                  {/* 基本情報 */}
                  <div className="flex flex-wrap gap-3 mb-4">
                    {selectedRecipeData?.role && (
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{ 
                        background: selectedRecipeData.role === 'main' ? colors.accent : selectedRecipeData.role === 'rice' ? '#8B4513' : selectedRecipeData.role === 'soup' ? colors.blue : colors.success,
                        color: '#fff'
                      }}>
                        {selectedRecipeData.role === 'main' ? '主菜' : selectedRecipeData.role === 'soup' ? '汁物' : selectedRecipeData.role === 'rice' ? '主食' : '副菜'}
                      </span>
                    )}
                    <div className="flex items-center gap-1">
                      <Flame size={14} color={colors.textMuted} />
                      <span style={{ fontSize: 12, color: colors.textLight }}>{selectedRecipeData?.calories_kcal ?? selectedRecipeData?.cal ?? '-'}kcal</span>
                    </div>
                  </div>

                  {/* この料理の栄養素 */}
                  {selectedRecipeData && (selectedRecipeData.protein_g || selectedRecipeData.fat_g || selectedRecipeData.carbs_g) && (
                    <div className="rounded-xl p-3 mb-4" style={{ background: colors.bg }}>
                      <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: '0 0 8px' }}>📊 この料理の栄養素</p>
                      <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-[11px]" style={{ color: colors.text }}>
                        {/* 基本栄養素 */}
                        <NutritionItem label="エネルギー" value={selectedRecipeData.calories_kcal} unit="kcal" decimals={0} textColor={colors.textMuted} />
                        <NutritionItem label="タンパク質" value={selectedRecipeData.protein_g} unit="g" textColor={colors.textMuted} />
                        <NutritionItem label="脂質" value={selectedRecipeData.fat_g} unit="g" textColor={colors.textMuted} />
                        <NutritionItem label="炭水化物" value={selectedRecipeData.carbs_g} unit="g" textColor={colors.textMuted} />
                        <NutritionItem label="食物繊維" value={selectedRecipeData.fiber_g} unit="g" textColor={colors.textMuted} />
                        <NutritionItem label="糖質" value={selectedRecipeData.sugar_g} unit="g" textColor={colors.textMuted} />
                        {/* ミネラル */}
                        <NutritionItem label="塩分" value={selectedRecipeData.sodium_g} unit="g" textColor={colors.textMuted} />
                        <NutritionItem label="カリウム" value={selectedRecipeData.potassium_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
                        <NutritionItem label="カルシウム" value={selectedRecipeData.calcium_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
                        <NutritionItem label="リン" value={selectedRecipeData.phosphorus_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
                        <NutritionItem label="鉄分" value={selectedRecipeData.iron_mg} unit="mg" textColor={colors.textMuted} />
                        <NutritionItem label="亜鉛" value={selectedRecipeData.zinc_mg} unit="mg" textColor={colors.textMuted} />
                        <NutritionItem label="ヨウ素" value={selectedRecipeData.iodine_ug} unit="µg" decimals={0} textColor={colors.textMuted} />
                        <NutritionItem label="コレステロール" value={selectedRecipeData.cholesterol_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
                        {/* ビタミン */}
                        <NutritionItem label="ビタミンA" value={selectedRecipeData.vitamin_a_ug} unit="µg" decimals={0} textColor={colors.textMuted} />
                        <NutritionItem label="ビタミンB1" value={selectedRecipeData.vitamin_b1_mg} unit="mg" decimals={2} textColor={colors.textMuted} />
                        <NutritionItem label="ビタミンB2" value={selectedRecipeData.vitamin_b2_mg} unit="mg" decimals={2} textColor={colors.textMuted} />
                        <NutritionItem label="ビタミンB6" value={selectedRecipeData.vitamin_b6_mg} unit="mg" decimals={2} textColor={colors.textMuted} />
                        <NutritionItem label="ビタミンB12" value={selectedRecipeData.vitamin_b12_ug} unit="µg" textColor={colors.textMuted} />
                        <NutritionItem label="ビタミンC" value={selectedRecipeData.vitamin_c_mg} unit="mg" decimals={0} textColor={colors.textMuted} />
                        <NutritionItem label="ビタミンD" value={selectedRecipeData.vitamin_d_ug} unit="µg" textColor={colors.textMuted} />
                        <NutritionItem label="ビタミンE" value={selectedRecipeData.vitamin_e_mg} unit="mg" textColor={colors.textMuted} />
                        <NutritionItem label="ビタミンK" value={selectedRecipeData.vitamin_k_ug} unit="µg" decimals={0} textColor={colors.textMuted} />
                        <NutritionItem label="葉酸" value={selectedRecipeData.folic_acid_ug} unit="µg" decimals={0} textColor={colors.textMuted} />
                        {/* 脂肪酸 */}
                        <NutritionItem label="飽和脂肪酸" value={selectedRecipeData.saturated_fat_g} unit="g" textColor={colors.textMuted} />
                        <NutritionItem label="一価不飽和脂肪酸" value={selectedRecipeData.monounsaturated_fat_g} unit="g" textColor={colors.textMuted} />
                        <NutritionItem label="多価不飽和脂肪酸" value={selectedRecipeData.polyunsaturated_fat_g} unit="g" textColor={colors.textMuted} />
                      </div>
                    </div>
                  )}

                  {/* 材料 */}
                  <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: '0 0 8px' }}>🥕 材料</p>
                  <div className="rounded-xl p-3 mb-4" style={{ background: colors.bg }}>
                    {(() => {
                      const dish = selectedRecipeData?.dishes?.[0];
                      // 新方式: ingredientsMd を優先（LLMが生成したマークダウン）
                      const ingredientsMd = dish?.ingredientsMd || formatIngredientsToMarkdown(
                        dish?.ingredientsText,
                        selectedRecipeData?.ingredients
                      );
                      if (ingredientsMd) {
                        return (
                          <div className="prose prose-sm max-w-none [&_table]:w-full [&_th]:text-left [&_th]:p-2 [&_td]:p-2 [&_tr]:border-b" style={{ fontSize: 13, color: colors.text }}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{ingredientsMd}</ReactMarkdown>
                          </div>
                        );
                      }
                      return <p style={{ fontSize: 13, color: colors.textMuted }}>材料情報なし</p>;
                    })()}
                  </div>

                  {/* 作り方 */}
                  <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, margin: '0 0 8px' }}>👨‍🍳 作り方</p>
                  <div className="rounded-xl p-3" style={{ background: colors.bg }}>
                    {(() => {
                      const dish = selectedRecipeData?.dishes?.[0];
                      // 新方式: recipeStepsMd を優先（LLMが生成したマークダウン）
                      const recipeStepsMd = dish?.recipeStepsMd || formatRecipeStepsToMarkdown(
                        dish?.recipeStepsText,
                        selectedRecipeData?.recipeSteps
                      );
                      if (recipeStepsMd) {
                        return (
                          <div className="prose prose-sm max-w-none [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mb-2" style={{ fontSize: 13, color: colors.text }}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{recipeStepsMd}</ReactMarkdown>
                          </div>
                        );
                      }
                      return (
                        <p style={{ fontSize: 13, color: colors.textMuted }}>
                          レシピはAI献立を生成すると自動で作成されます。<br />
                          「AIで変更」ボタンから再生成してください。
                        </p>
                      );
                    })()}
                  </div>
                </div>
                <div className="px-4 py-2.5 pb-4 lg:pb-6 flex gap-2" style={{ borderTop: `1px solid ${colors.border}` }}>
                  <button className="w-11 h-11 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <Heart size={18} color={colors.textMuted} />
                  </button>
                  <button 
                    onClick={addRecipeToShoppingList} 
                    className="flex-1 p-3 rounded-xl font-semibold text-[14px] flex items-center justify-center gap-2 active:scale-95 transition-transform" 
                    style={{ background: colors.accent, color: '#fff' }}
                  >
                    <ShoppingCart size={18} />
                    材料を買い物リストに追加
                  </button>
                </div>
              </motion.div>
            )}

            {/* Servings Config Modal */}
            {showServingsModal && (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="fixed inset-0 z-[300] flex items-center justify-center"
                style={{ background: 'rgba(0,0,0,0.5)' }}
                onClick={() => setShowServingsModal(false)}
              >
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                  className="w-[95%] max-w-md rounded-2xl p-5"
                  style={{ background: colors.card }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex justify-between items-center mb-4">
                    <h3 style={{ fontSize: 18, fontWeight: 700 }}>曜日別人数設定</h3>
                    <button onClick={() => setShowServingsModal(false)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                      <X size={16} color={colors.textLight} />
                    </button>
                  </div>
                  
                  <p style={{ fontSize: 13, color: colors.textLight, marginBottom: 16 }}>
                    各セルをクリックして人数を変更（0=作らない/外食）
                  </p>
                  
                  {/* Grid Header */}
                  <div className="grid grid-cols-4 gap-2 mb-2">
                    <div />
                    {(['朝', '昼', '夜'] as const).map((label, i) => (
                      <div key={i} className="text-center font-bold" style={{ fontSize: 13, color: colors.text }}>{label}</div>
                    ))}
                  </div>
                  
                  {/* Grid Rows */}
                  {(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const).map((day) => {
                    const labels: Record<string, string> = { monday: '月', tuesday: '火', wednesday: '水', thursday: '木', friday: '金', saturday: '土', sunday: '日' };
                    const isWeekend = day === 'saturday' || day === 'sunday';
                    const defaultServings = servingsConfig?.default ?? 2;
                    
                    return (
                      <div key={day} className="grid grid-cols-4 gap-2 mb-2">
                        <div className="flex items-center justify-center font-bold" style={{ fontSize: 13, color: isWeekend ? colors.accent : colors.text }}>
                          {labels[day]}
                        </div>
                        {(['breakfast', 'lunch', 'dinner'] as const).map((meal) => {
                          const value = servingsConfig?.byDayMeal?.[day]?.[meal] ?? defaultServings;
                          
                          const updateValue = (newValue: number) => {
                            const updated: ServingsConfig = {
                              default: servingsConfig?.default ?? 2,
                              byDayMeal: { ...servingsConfig?.byDayMeal }
                            };
                            if (!updated.byDayMeal[day]) updated.byDayMeal[day] = {};
                            updated.byDayMeal[day][meal] = Math.max(0, Math.min(10, newValue));
                            setServingsConfig(updated);
                          };
                          
                          return (
                            <div
                              key={meal}
                              className="flex items-center justify-between rounded-lg px-1"
                              style={{
                                background: value === 0 ? colors.bg : colors.successLight,
                                border: `1px solid ${value === 0 ? colors.border : colors.success}`
                              }}
                            >
                              <button
                                onClick={() => updateValue(value - 1)}
                                className="w-7 h-9 flex items-center justify-center text-lg font-bold"
                                style={{ color: value === 0 ? colors.textMuted : colors.success }}
                              >
                                −
                              </button>
                              <span 
                                className="font-bold text-center min-w-[18px]"
                                style={{ 
                                  fontSize: 15,
                                  color: value === 0 ? colors.textMuted : colors.success 
                                }}
                              >
                                {value === 0 ? '-' : value}
                              </span>
                              <button
                                onClick={() => updateValue(value + 1)}
                                className="w-7 h-9 flex items-center justify-center text-lg font-bold"
                                style={{ color: value === 0 ? colors.textMuted : colors.success }}
                              >
                                +
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                  
                  {/* Legend */}
                  <div className="flex justify-center gap-4 mt-4 mb-4">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded" style={{ background: colors.successLight, border: `1px solid ${colors.success}` }} />
                      <span style={{ fontSize: 11, color: colors.textLight }}>作る</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded" style={{ background: colors.bg, border: `1px solid ${colors.border}` }} />
                      <span style={{ fontSize: 11, color: colors.textLight }}>作らない</span>
                    </div>
                  </div>
                  
                  {/* Save Button */}
                  <button
                    onClick={async () => {
                      if (!servingsConfig) return;
                      try {
                        const res = await fetch('/api/profile', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ servingsConfig })
                        });
                        if (res.ok) {
                          setSuccessMessage({ title: '保存しました', message: '人数設定を更新しました' });
                          setShowServingsModal(false);
                        }
                      } catch (e) {
                        console.error('Failed to save servings config:', e);
                      }
                    }}
                    className="w-full p-3.5 rounded-xl font-semibold"
                    style={{ background: colors.accent, color: '#fff' }}
                  >
                    保存する
                  </button>
                </motion.div>
              </motion.div>
            )}

            {/* Add Meal Modal */}
            {activeModal === 'add' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-3.5 pb-4 lg:pb-7 rounded-t-3xl"
                style={{ background: colors.card }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-center mb-3.5">
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{addMealKey && MEAL_LABELS[addMealKey]}を追加</span>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex flex-col gap-2">
                  {(Object.entries(MODE_CONFIG) as [MealMode, typeof MODE_CONFIG['cook']][]).filter(([k]) => k !== 'skip').map(([key, mode]) => {
                    const ModeIcon = mode.icon;
                    return (
                      <button 
                        key={key} 
                        onClick={() => handleAddMealWithMode(key)}
                        className="flex items-center gap-2.5 p-3 rounded-[10px]" 
                        style={{ background: mode.bg }}
                      >
                        <ModeIcon size={18} color={mode.color} />
                        <span style={{ fontSize: 13, fontWeight: 500, color: colors.text }}>{mode.label}で追加</span>
                      </button>
                    );
                  })}
                  <button onClick={() => setActiveModal('aiMeal')} className="flex items-center gap-2.5 p-3 rounded-[10px]" style={{ background: colors.accentLight, border: `1px solid ${colors.accent}` }}>
                    <Sparkles size={18} color={colors.accent} />
                    <span style={{ fontSize: 13, fontWeight: 500, color: colors.accent }}>AIに提案してもらう</span>
                  </button>
                </div>
              </motion.div>
            )}

            {/* Add Meal Slot Modal - 食事を追加 */}
            {activeModal === 'addMealSlot' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-3.5 pb-4 lg:pb-7 rounded-t-3xl"
                style={{ background: colors.card }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-center mb-3.5">
                  <span style={{ fontSize: 15, fontWeight: 600 }}>食事を追加</span>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <p style={{ fontSize: 12, color: colors.textMuted, marginBottom: 12 }}>
                  {weekDates[selectedDayIndex] && `${weekDates[selectedDayIndex].date.getMonth() + 1}/${weekDates[selectedDayIndex].date.getDate()}（${weekDates[selectedDayIndex].dayOfWeek}）`}に追加する食事を選んでください
                </p>
                <div className="flex flex-col gap-2">
                  {ALL_MEAL_TYPES.map(type => (
                    <button 
                      key={type}
                      onClick={() => {
                        setAddMealKey(type);
                        setAddMealDayIndex(selectedDayIndex);
                        setActiveModal('add');
                      }}
                      className="w-full flex items-center justify-between p-4 rounded-xl transition-colors"
                      style={{ background: colors.bg }}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ 
                          background: type === 'breakfast' ? colors.warningLight 
                            : type === 'lunch' ? colors.accentLight 
                            : type === 'dinner' ? colors.purpleLight 
                            : type === 'snack' ? colors.successLight 
                            : colors.blueLight 
                        }}>
                          <span style={{ fontSize: 18 }}>
                            {type === 'breakfast' ? '🌅' 
                              : type === 'lunch' ? '☀️' 
                              : type === 'dinner' ? '🌙' 
                              : type === 'snack' ? '🍪' 
                              : '🌃'}
                          </span>
                        </div>
                        <span style={{ fontSize: 15, fontWeight: 500, color: colors.text }}>{MEAL_LABELS[type]}</span>
                      </div>
                      <ChevronRight size={18} color={colors.textMuted} />
                    </button>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Delete Confirmation Modal */}
            {activeModal === 'confirmDelete' && deletingMeal && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }} 
                animate={{ opacity: 1, scale: 1 }} 
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-[202] flex items-center justify-center p-4"
                onClick={(e) => e.stopPropagation()}
              >
                <div 
                  className="w-full max-w-sm rounded-2xl p-5"
                  style={{ background: colors.card }}
                >
                  <div className="flex flex-col items-center text-center mb-5">
                    <div className="w-14 h-14 rounded-full flex items-center justify-center mb-3" style={{ background: colors.dangerLight }}>
                      <Trash2 size={24} color={colors.danger} />
                    </div>
                    <h3 style={{ fontSize: 17, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
                      この食事を削除しますか？
                    </h3>
                    <p style={{ fontSize: 13, color: colors.textMuted, margin: 0 }}>
                      「{deletingMeal.dishName || MEAL_LABELS[deletingMeal.mealType as MealType]}」を削除します。<br/>
                      この操作は取り消せません。
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setActiveModal(null); setDeletingMeal(null); }}
                      className="flex-1 py-3 rounded-xl"
                      style={{ background: colors.bg }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 500, color: colors.textLight }}>キャンセル</span>
                    </button>
                    <button
                      onClick={confirmDeleteMeal}
                      disabled={isDeleting}
                      className="flex-1 py-3 rounded-xl flex items-center justify-center gap-2 disabled:opacity-60"
                      style={{ background: colors.danger }}
                    >
                      {isDeleting ? (
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <>
                          <Trash2 size={14} color="#fff" />
                          <span style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>削除する</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {/* AI Single Meal Modal */}
            {activeModal === 'aiMeal' && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
                style={{ background: colors.card, maxHeight: '70vh' }}
              >
                <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Sparkles size={18} color={colors.accent} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>
                      {weekDates[addMealDayIndex] && `${weekDates[addMealDayIndex].date.getMonth() + 1}/${weekDates[addMealDayIndex].date.getDate()}（${weekDates[addMealDayIndex].dayOfWeek}）`}の{addMealKey && MEAL_LABELS[addMealKey]}
                    </span>
                  </div>
                  <button onClick={() => setActiveModal(null)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                  <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }}>条件を指定（複数選択可）</p>
                  {AI_CONDITIONS.map((text, i) => {
                    const isSelected = selectedConditions.includes(text);
                    return (
                      <button 
                        key={i} 
                        onClick={() => setSelectedConditions(prev => isSelected ? prev.filter(c => c !== text) : [...prev, text])}
                        className="w-full p-3 mb-1.5 rounded-[10px] text-left text-[13px] flex items-center justify-between transition-all"
                        style={{ 
                          background: isSelected ? colors.accentLight : colors.bg, 
                          color: isSelected ? colors.accent : colors.text,
                          border: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent'
                        }}
                      >
                        <span>{text}</span>
                        {isSelected && <Check size={16} color={colors.accent} />}
                      </button>
                    );
                  })}
                  <div className="mt-4">
                    <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 8 }}>リクエスト（任意）</p>
                    <textarea 
                      value={aiChatInput}
                      onChange={(e) => setAiChatInput(e.target.value)}
                      placeholder="例: 昨日カレーだったので違うものがいい、野菜多めで..."
                      className="w-full p-3 rounded-[10px] text-[13px] outline-none resize-none"
                      style={{ background: colors.bg, minHeight: 80 }}
                    />
                  </div>
                </div>
                <div className="px-4 py-4 pb-4 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
                  <button 
                    onClick={handleGenerateSingleMeal}
                    className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2"
                    style={{ background: colors.accent }}
                  >
                    <Sparkles size={16} color="#fff" />
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>この1食をAIに提案してもらう</span>
                  </button>
                </div>
              </motion.div>
            )}

            {/* Edit Meal Modal */}
            {activeModal === 'editMeal' && editingMeal && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] px-4 py-4 pb-4 lg:pb-6 rounded-t-3xl"
                style={{ background: colors.card }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex justify-between items-center mb-4">
                  <span style={{ fontSize: 15, fontWeight: 600 }}>食事を変更</span>
                  <button onClick={() => { setActiveModal(null); setEditingMeal(null); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 4 }}>料理名</label>
                    <input
                      type="text"
                      value={editMealName}
                      onChange={(e) => setEditMealName(e.target.value)}
                      className="w-full p-3 rounded-xl text-[14px] outline-none"
                      style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 4 }}>タイプ</label>
                    <div className="flex flex-wrap gap-2">
                      {(Object.entries(MODE_CONFIG) as [MealMode, typeof MODE_CONFIG['cook']][]).map(([key, mode]) => {
                        const ModeIcon = mode.icon;
                        const isSelected = editMealMode === key;
                        return (
                          <button
                            key={key}
                            onClick={() => setEditMealMode(key)}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg"
                            style={{ 
                              background: isSelected ? mode.bg : colors.bg,
                              border: isSelected ? `2px solid ${mode.color}` : '2px solid transparent'
                            }}
                          >
                            <ModeIcon size={14} color={isSelected ? mode.color : colors.textMuted} />
                            <span style={{ fontSize: 12, color: isSelected ? mode.color : colors.textMuted }}>{mode.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <button
                    onClick={saveEditMeal}
                    className="w-full p-3 rounded-xl font-semibold text-[14px]"
                    style={{ background: colors.accent, color: '#fff' }}
                  >
                    保存する
                  </button>
                </div>
              </motion.div>
            )}

            {/* AI Regenerate Meal Modal */}
            {activeModal === 'regenerateMeal' && regeneratingMeal && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
                style={{ background: colors.card, maxHeight: '70vh' }}
              >
                <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Sparkles size={18} color={colors.accent} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>
                      {MEAL_LABELS[regeneratingMeal.mealType as MealType]}をAIで変更
                    </span>
                  </div>
                  <button onClick={() => { setActiveModal(null); setRegeneratingMeal(null); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                  <div className="p-3 rounded-xl mb-4" style={{ background: colors.bg }}>
                    <p style={{ fontSize: 12, color: colors.textMuted, margin: '0 0 4px' }}>現在の献立</p>
                    <p style={{ fontSize: 14, fontWeight: 500, color: colors.text, margin: 0 }}>{regeneratingMeal.dishName}</p>
                  </div>
                  
                  <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }}>新しい条件を指定（複数選択可）</p>
                  {AI_CONDITIONS.map((text, i) => {
                    const isSelected = selectedConditions.includes(text);
                    return (
                      <button 
                        key={i} 
                        onClick={() => setSelectedConditions(prev => isSelected ? prev.filter(c => c !== text) : [...prev, text])}
                        className="w-full p-3 mb-1.5 rounded-[10px] text-left text-[13px] flex items-center justify-between transition-all"
                        style={{ 
                          background: isSelected ? colors.accentLight : colors.bg, 
                          color: isSelected ? colors.accent : colors.text,
                          border: isSelected ? `2px solid ${colors.accent}` : '2px solid transparent'
                        }}
                      >
                        <span>{text}</span>
                        {isSelected && <Check size={16} color={colors.accent} />}
                      </button>
                    );
                  })}
                  <div className="mt-4">
                    <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 8 }}>リクエスト（任意）</p>
                    <textarea 
                      value={aiChatInput}
                      onChange={(e) => setAiChatInput(e.target.value)}
                      placeholder="例: もっとヘルシーに、魚料理がいい..."
                      className="w-full p-3 rounded-[10px] text-[13px] outline-none resize-none"
                      style={{ background: colors.bg, minHeight: 80 }}
                    />
                  </div>
                </div>
                <div className="px-4 py-4 pb-4 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
                  <button 
                    onClick={handleRegenerateMeal}
                    disabled={isRegenerating}
                    className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2"
                    style={{ background: colors.accent, opacity: isRegenerating ? 0.7 : 1 }}
                  >
                    {isRegenerating ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>AIが新しい献立を考え中...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={16} color="#fff" />
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>AIで別の献立に変更</span>
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}

            {/* Manual Edit Modal */}
            {activeModal === 'manualEdit' && manualEditMeal && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
                style={{ background: colors.card, maxHeight: '75vh' }}
              >
                <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Pencil size={18} color={colors.textLight} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>手動で変更</span>
                  </div>
                  <button onClick={() => { setActiveModal(null); setManualEditMeal(null); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                  {/* Mode Selection */}
                  <div className="mb-4">
                    <label style={{ fontSize: 12, color: colors.textMuted, display: 'block', marginBottom: 8 }}>タイプ</label>
                    <div className="flex flex-wrap gap-2">
                      {(Object.entries(MODE_CONFIG) as [MealMode, typeof MODE_CONFIG['cook']][]).map(([key, mode]) => {
                        const ModeIcon = mode.icon;
                        const isSelected = manualMode === key;
                        return (
                          <button
                            key={key}
                            onClick={() => setManualMode(key)}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg"
                            style={{ 
                              background: isSelected ? mode.bg : colors.bg,
                              border: isSelected ? `2px solid ${mode.color}` : '2px solid transparent'
                            }}
                          >
                            <ModeIcon size={14} color={isSelected ? mode.color : colors.textMuted} />
                            <span style={{ fontSize: 12, color: isSelected ? mode.color : colors.textMuted }}>{mode.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  
                  {/* Dishes */}
                  <div className="mb-4">
                    <div className="flex justify-between items-center mb-2">
                      <label style={{ fontSize: 12, color: colors.textMuted }}>料理（複数可）</label>
                      <button onClick={addManualDish} className="text-[12px] flex items-center gap-1" style={{ color: colors.accent }}>
                        <Plus size={12} /> 追加
                      </button>
                    </div>
                    {manualDishes.map((dish, idx) => (
                      <div key={idx} className="flex gap-2 mb-2">
                        <select
                          value={dish.role || 'main'}
                          onChange={(e) => updateManualDish(idx, 'role', e.target.value)}
                          className="w-20 p-2 rounded-lg text-[12px] outline-none"
                          style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                        >
                          <option value="main">主菜</option>
                          <option value="side">副菜</option>
                          <option value="soup">汁物</option>
                          <option value="rice">ご飯</option>
                          <option value="salad">サラダ</option>
                          <option value="dessert">デザート</option>
                        </select>
                        <input
                          type="text"
                          value={dish.name}
                          onChange={(e) => updateManualDish(idx, 'name', e.target.value)}
                          placeholder="料理名"
                          className="flex-1 p-2 rounded-lg text-[13px] outline-none"
                          style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                        />
                        <input
                          type="number"
                          value={dish.calories_kcal || ''}
                          onChange={(e) => updateManualDish(idx, 'calories_kcal', parseInt(e.target.value) || 0)}
                          placeholder="kcal"
                          className="w-16 p-2 rounded-lg text-[13px] outline-none text-center"
                          style={{ background: colors.bg, border: `1px solid ${colors.border}` }}
                        />
                        {manualDishes.length > 1 && (
                          <button onClick={() => removeManualDish(idx)} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: colors.dangerLight }}>
                            <Trash2 size={14} color={colors.danger} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  
                  {/* Photo input option */}
                  <button
                    onClick={() => {
                      setActiveModal('photoEdit');
                      setPhotoEditMeal(manualEditMeal);
                    }}
                    className="w-full p-3 rounded-xl flex items-center justify-center gap-2 mb-3"
                    style={{ background: colors.blueLight, border: `1px solid ${colors.blue}` }}
                  >
                    <Camera size={16} color={colors.blue} />
                    <span style={{ fontSize: 13, color: colors.blue }}>写真から入力（AI解析）</span>
                  </button>
                </div>
                <div className="px-4 py-4 pb-4 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
                  <button 
                    onClick={saveManualEdit}
                    className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2"
                    style={{ background: colors.accent }}
                  >
                    <Check size={16} color="#fff" />
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>保存する</span>
                  </button>
                </div>
              </motion.div>
            )}

            {/* Photo Edit Modal（複数枚対応） */}
            {activeModal === 'photoEdit' && photoEditMeal && (
              <motion.div
                initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
                transition={{ type: "spring", damping: 25, stiffness: 300 }}
                className="fixed bottom-20 lg:bottom-0 left-0 right-0 lg:left-64 z-[201] flex flex-col rounded-t-3xl"
                style={{ background: colors.card, maxHeight: '75vh' }}
              >
                <div className="flex justify-between items-center px-4 py-3 flex-shrink-0" style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <div className="flex items-center gap-2">
                    <Camera size={18} color={colors.blue} />
                    <span style={{ fontSize: 15, fontWeight: 600 }}>写真から入力</span>
                    {photoPreviews.length > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-xs" style={{ background: colors.accentLight, color: colors.accent }}>
                        {photoPreviews.length}枚
                      </span>
                    )}
                  </div>
                  <button onClick={() => { setActiveModal(null); setPhotoEditMeal(null); setPhotoFiles([]); setPhotoPreviews([]); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: colors.bg }}>
                    <X size={14} color={colors.textLight} />
                  </button>
                </div>
                <div className="flex-1 p-4 overflow-auto">
                  <p style={{ fontSize: 13, color: colors.textMuted, marginBottom: 12 }}>
                    食事の写真を撮影またはアップロードすると、AIが料理を認識して栄養素を推定します。<br/>
                    <strong>複数枚の写真をまとめて追加できます。</strong>
                  </p>
                  
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/*"
                    capture="environment"
                    multiple
                    onChange={handlePhotoSelect}
                    className="hidden"
                  />
                  
                  {/* 選択済み写真のプレビュー */}
                  {photoPreviews.length > 0 && (
                    <div className="mb-4">
                      <div className="grid grid-cols-3 gap-2">
                        {photoPreviews.map((preview, idx) => (
                          <div key={idx} className="relative aspect-square">
                            <img src={preview} alt={`Preview ${idx + 1}`} className="w-full h-full rounded-lg object-cover" />
                            <button
                              onClick={() => removePhoto(idx)}
                              className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center"
                              style={{ background: 'rgba(0,0,0,0.6)' }}
                            >
                              <X size={12} color="#fff" />
                            </button>
                          </div>
                        ))}
                        {/* 追加ボタン */}
                        <button
                          onClick={() => {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.accept = 'image/*';
                            input.multiple = true;
                            input.onchange = (e) => handlePhotoSelect(e as any);
                            input.click();
                          }}
                          className="aspect-square rounded-lg flex flex-col items-center justify-center"
                          style={{ background: colors.bg, border: `2px dashed ${colors.border}` }}
                        >
                          <Plus size={24} color={colors.textMuted} />
                          <span style={{ fontSize: 10, color: colors.textMuted }}>追加</span>
                        </button>
                      </div>
                    </div>
                  )}
                  
                  {/* 写真未選択時のボタン */}
                  {photoPreviews.length === 0 && (
                    <div className="flex gap-3 mb-4">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="flex-1 p-6 rounded-xl flex flex-col items-center gap-2"
                        style={{ background: colors.bg, border: `2px dashed ${colors.border}` }}
                      >
                        <Camera size={32} color={colors.textMuted} />
                        <span style={{ fontSize: 13, color: colors.textMuted }}>撮影する</span>
                      </button>
                      <button
                        onClick={() => {
                          const input = document.createElement('input');
                          input.type = 'file';
                          input.accept = 'image/*';
                          input.multiple = true;
                          input.onchange = (e) => handlePhotoSelect(e as any);
                          input.click();
                        }}
                        className="flex-1 p-6 rounded-xl flex flex-col items-center gap-2"
                        style={{ background: colors.bg, border: `2px dashed ${colors.border}` }}
                      >
                        <ImageIcon size={32} color={colors.textMuted} />
                        <span style={{ fontSize: 13, color: colors.textMuted }}>選択する</span>
                      </button>
                    </div>
                  )}
                  
                  <div className="p-3 rounded-xl" style={{ background: colors.blueLight }}>
                    <p style={{ fontSize: 11, color: colors.blue, margin: 0 }}>
                      💡 AIが写真から料理名、カロリー、栄養素を自動で推定します。複数枚の場合はまとめて解析します。
                    </p>
                  </div>
                </div>
                <div className="px-4 py-4 pb-4 lg:pb-6 flex-shrink-0" style={{ borderTop: `1px solid ${colors.border}`, background: colors.card }}>
                  <button 
                    onClick={analyzePhotoWithAI}
                    disabled={photoFiles.length === 0 || isAnalyzingPhoto}
                    className="w-full py-3.5 rounded-xl flex items-center justify-center gap-2 disabled:opacity-50"
                    style={{ background: colors.blue }}
                  >
                    {isAnalyzingPhoto ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>AIが解析中...</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={16} color="#fff" />
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>
                          {photoFiles.length > 1 ? `${photoFiles.length}枚をAIで解析` : 'AIで解析する'}
                        </span>
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}
          </>
        )}
      </AnimatePresence>

      {/* 完了モーダル */}
      <AnimatePresence>
        {successMessage && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSuccessMessage(null)}
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
              <div
                className="w-full max-w-xs rounded-2xl p-6 text-center"
                style={{ background: colors.card }}
              >
                <div 
                  className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
                  style={{ background: colors.successLight || 'rgba(34, 197, 94, 0.1)' }}
                >
                  <Check size={32} color={colors.success} />
                </div>
                <h3 style={{ fontSize: 18, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
                  {successMessage.title}
                </h3>
                <p style={{ fontSize: 14, color: colors.textLight, marginBottom: 20 }}>
                  {successMessage.message}
                </p>
                <button
                  onClick={() => setSuccessMessage(null)}
                  className="w-full p-3 rounded-xl font-semibold"
                  style={{ background: colors.accent, color: '#fff' }}
                >
                  OK
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* V4 AI Generation Modal */}
      <V4GenerateModal
        isOpen={showV4Modal}
        onClose={() => setShowV4Modal(false)}
        mealPlanDays={currentPlan?.days || []}
        weekStartDate={weekDates[0]?.dateStr || formatLocalDate(weekStart)}
        weekEndDate={weekDates[6]?.dateStr || addDaysStr(formatLocalDate(weekStart), 6)}
        onGenerate={handleV4Generate}
        isGenerating={isGenerating}
      />

      {/* 栄養詳細モーダル */}
      <AnimatePresence>
        {showNutritionDetailModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
            onClick={() => setShowNutritionDetailModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-hidden shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: colors.border }}>
                <div className="flex items-center gap-2">
                  <BarChart3 size={20} style={{ color: colors.accent }} />
                  <h2 className="text-lg font-bold" style={{ color: colors.text }}>
                    {weekDates[selectedDayIndex]?.date.getMonth() + 1}/{weekDates[selectedDayIndex]?.date.getDate()} の栄養分析
                  </h2>
                </div>
                <button
                  onClick={() => setShowNutritionDetailModal(false)}
                  className="p-2 rounded-full hover:bg-gray-100 transition-colors"
                >
                  <X size={20} style={{ color: colors.textLight }} />
                </button>
              </div>

              {/* Content */}
              <div className="p-4 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 140px)' }}>
                {(() => {
                  const dayNutrition = getDayTotalNutrition(currentDay);
                  const mealCount = currentDay?.meals?.length || 0;
                  return (
                    <>
                      {/* レーダーチャート（大きく表示） */}
                      <div className="flex justify-center mb-4">
                        <NutritionRadarChart
                          nutrition={dayNutrition}
                          selectedNutrients={radarChartNutrients}
                          size={220}
                          showLabels={true}
                        />
                      </div>

                      {/* AI栄養士のコメント（褒め＋アドバイス） */}
                      <div className="mb-4 space-y-3">
                        {/* 褒めコメント */}
                        <div className="p-3 rounded-xl" style={{ background: colors.successLight }}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Heart size={14} color={colors.success} fill={colors.success} />
                              <span style={{ fontSize: 12, fontWeight: 600, color: colors.success }}>褒めポイント</span>
                            </div>
                            {(praiseComment || nutritionFeedback) && !isLoadingFeedback && (
                              <button
                                onClick={() => {
                                  const currentDateStr = weekDates[selectedDayIndex]?.dateStr;
                                  if (currentDateStr) {
                                    fetchNutritionFeedback(currentDateStr, true);
                                  }
                                }}
                                className="text-[10px] px-2 py-0.5 rounded"
                                style={{ background: colors.bg, color: colors.textMuted }}
                              >
                                再分析
                              </button>
                            )}
                          </div>
                          {isLoadingFeedback ? (
                            <div className="flex items-center gap-2">
                              <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.success, borderTopColor: 'transparent' }} />
                              <span style={{ fontSize: 11, color: colors.textLight }}>あなたの献立を分析中...</span>
                            </div>
                          ) : praiseComment ? (
                            <p style={{ fontSize: 13, color: colors.text, lineHeight: 1.6 }}>{praiseComment}</p>
                          ) : (
                            <p style={{ fontSize: 11, color: colors.textMuted }}>分析データがありません</p>
                          )}
                        </div>

                        {/* 改善アドバイス */}
                        {(nutritionFeedback || isLoadingFeedback) && (
                          <div className="p-3 rounded-xl" style={{ background: colors.accentLight }}>
                            <div className="flex items-center gap-2 mb-2">
                              <Sparkles size={14} color={colors.accent} />
                              <span style={{ fontSize: 12, fontWeight: 600, color: colors.accent }}>改善アドバイス</span>
                            </div>
                            {isLoadingFeedback ? (
                              <span style={{ fontSize: 11, color: colors.textMuted }}>...</span>
                            ) : (
                              <p style={{ fontSize: 12, color: colors.text, lineHeight: 1.6 }}>{nutritionFeedback}</p>
                            )}
                          </div>
                        )}

                        {/* 栄養豆知識 */}
                        {nutritionTip && (
                          <div className="p-3 rounded-lg flex items-start gap-2" style={{ background: colors.blueLight }}>
                            <span style={{ fontSize: 12 }}>💡</span>
                            <p style={{ fontSize: 11, color: colors.blue, lineHeight: 1.5 }}>{nutritionTip}</p>
                          </div>
                        )}
                      </div>

                      {/* この提案で献立を改善ボタン */}
                      {nutritionFeedback && !isLoadingFeedback ? (
                        <div className="mb-4">
                          <>
                            <div style={{ marginBottom: 12 }}></div>
                            {/* この提案で献立を改善ボタン */}
                            <button
                              onClick={() => {
                                setShowImproveMealModal(true);
                                setImproveNextDay(false); // リセット
                                // デフォルトで全食事を選択
                                const mealsForDay = currentDay?.meals?.map(m => m.mealType) || [];
                                const uniqueMeals = [...new Set(mealsForDay)] as MealType[];
                                setImproveMealTargets(uniqueMeals.length > 0 ? uniqueMeals : ['breakfast', 'lunch', 'dinner']);
                              }}
                              className="w-full p-2.5 rounded-lg font-medium flex items-center justify-center gap-2 transition-all hover:opacity-90"
                              style={{ background: colors.accent, color: '#fff', fontSize: 12 }}
                            >
                              <RefreshCw size={14} />
                              この提案で献立を改善
                            </button>
                          </>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 mb-4">
                          <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
                          <span style={{ fontSize: 11, color: colors.textLight }}>分析を準備中...</span>
                        </div>
                      )}

                      {/* 全栄養素一覧 */}
                      <div className="mb-4">
                        <p style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
                          📊 全栄養素（{mealCount}食分）
                        </p>
                        {Object.entries(NUTRIENT_BY_CATEGORY).map(([category, nutrients]) => (
                          <div key={category} className="mb-3">
                            <p className="text-[10px] font-bold mb-1.5" style={{ color: colors.textMuted }}>
                              {CATEGORY_LABELS[category]}
                            </p>
                            <div className="grid grid-cols-2 gap-2">
                              {nutrients.map(def => {
                                const value = (dayNutrition as any)[def.key] ?? 0;
                                const percentage = calculateDriPercentage(def.key, value);
                                const isGood = percentage >= 80 && percentage <= 120;
                                const isLow = percentage < 50;
                                const isHigh = percentage > 150;
                                return (
                                  <div key={def.key} className="flex items-center gap-2 p-1.5 rounded" style={{ background: colors.bg }}>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex justify-between items-center">
                                        <span className="text-[10px] truncate" style={{ color: colors.textLight }}>
                                          {def.label}
                                        </span>
                                        <span className="text-[9px]" style={{ color: colors.textMuted }}>
                                          {value.toFixed(def.decimals)}{def.unit}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-1 mt-0.5">
                                        <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: colors.border }}>
                                          <div
                                            className="h-full rounded-full"
                                            style={{
                                              width: `${Math.min(percentage, 100)}%`,
                                              background: isGood ? colors.success : isLow ? colors.warning : isHigh ? colors.accent : colors.textMuted,
                                            }}
                                          />
                                        </div>
                                        <span 
                                          className="text-[8px] w-7 text-right font-medium"
                                          style={{ color: isGood ? colors.success : isLow ? colors.warning : isHigh ? colors.accent : colors.textMuted }}
                                        >
                                          {percentage}%
                                        </span>
                                      </div>
                                    </div>
    </div>
  );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* レーダーチャート表示栄養素の変更 */}
                      <div className="pt-3" style={{ borderTop: `1px solid ${colors.border}` }}>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[11px]" style={{ color: colors.textMuted }}>
                            レーダーチャートに表示する栄養素（{isEditingRadarNutrients ? tempRadarNutrients.length : radarChartNutrients.length}角形）
                          </p>
                          {!isEditingRadarNutrients && (
                            <button
                              onClick={() => {
                                setTempRadarNutrients([...radarChartNutrients]);
                                setIsEditingRadarNutrients(true);
                              }}
                              className="text-[10px] px-2 py-1 rounded"
                              style={{ background: colors.bg, color: colors.accent }}
                            >
                              変更
                            </button>
                          )}
                        </div>

                        {isEditingRadarNutrients ? (
                          // 編集モード: 栄養素を選択
                          <div>
                            <p className="text-[9px] mb-2" style={{ color: colors.textMuted }}>
                              3〜8個を選択してください（選択順で表示）
                            </p>
                            {Object.entries(NUTRIENT_BY_CATEGORY).map(([category, nutrients]) => (
                              <div key={category} className="mb-2">
                                <p className="text-[9px] font-bold mb-1" style={{ color: colors.textMuted }}>
                                  {CATEGORY_LABELS[category]}
                                </p>
                                <div className="flex flex-wrap gap-1">
                                  {nutrients.map(def => {
                                    const isSelected = tempRadarNutrients.includes(def.key);
                                    const index = tempRadarNutrients.indexOf(def.key);
                                    return (
                                      <button
                                        key={def.key}
                                        onClick={() => {
                                          if (isSelected) {
                                            setTempRadarNutrients(prev => prev.filter(k => k !== def.key));
                                          } else if (tempRadarNutrients.length < 8) {
                                            setTempRadarNutrients(prev => [...prev, def.key]);
                                          }
                                        }}
                                        className="px-2 py-0.5 rounded-full text-[9px] transition-all flex items-center gap-1"
                                        style={{
                                          background: isSelected ? colors.accent : colors.bg,
                                          color: isSelected ? '#fff' : colors.textLight,
                                          opacity: !isSelected && tempRadarNutrients.length >= 8 ? 0.5 : 1,
                                        }}
                                      >
                                        {isSelected && <span className="text-[8px]">{index + 1}</span>}
                                        {def.label}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                            <div className="flex gap-2 mt-3">
                              <button
                                onClick={() => {
                                  setIsEditingRadarNutrients(false);
                                  setTempRadarNutrients([]);
                                }}
                                className="flex-1 py-2 rounded-lg text-xs"
                                style={{ background: colors.bg, color: colors.textLight }}
                              >
                                キャンセル
                              </button>
                              <button
                                onClick={async () => {
                                  if (tempRadarNutrients.length < 3) {
                                    alert('3個以上選択してください');
                                    return;
                                  }
                                  setIsSavingRadarNutrients(true);
                                  try {
                                    const res = await fetch('/api/profile', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ radarChartNutrients: tempRadarNutrients })
                                    });
                                    if (res.ok) {
                                      setRadarChartNutrients(tempRadarNutrients);
                                      setIsEditingRadarNutrients(false);
                                      setTempRadarNutrients([]);
                                    }
                                  } catch (e) {
                                    console.error('Failed to save radar chart nutrients:', e);
                                  } finally {
                                    setIsSavingRadarNutrients(false);
                                  }
                                }}
                                disabled={tempRadarNutrients.length < 3 || isSavingRadarNutrients}
                                className="flex-1 py-2 rounded-lg text-xs text-white disabled:opacity-50"
                                style={{ background: colors.accent }}
                              >
                                {isSavingRadarNutrients ? '保存中...' : `保存（${tempRadarNutrients.length}角形）`}
                              </button>
                            </div>
                          </div>
                        ) : (
                          // 表示モード: 現在の選択を表示
                          <div className="flex flex-wrap gap-1.5">
                            {radarChartNutrients.map((key, idx) => {
                              const def = getNutrientDefinition(key);
                              return (
                                <span
                                  key={key}
                                  className="px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1"
                                  style={{ background: colors.accentLight, color: colors.accent }}
                                >
                                  <span className="text-[8px] opacity-70">{idx + 1}</span>
                                  {def?.label}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 献立改善の食事選択モーダル */}
      <AnimatePresence>
        {showImproveMealModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
            onClick={() => !isImprovingMeal && setShowImproveMealModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl w-full max-w-md shadow-xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: colors.border }}>
                <div className="flex items-center gap-2">
                  <RefreshCw size={20} style={{ color: colors.accent }} />
                  <h2 className="text-lg font-bold" style={{ color: colors.text }}>
                    献立を改善
                  </h2>
                </div>
                {!isImprovingMeal && (
                  <button
                    onClick={() => setShowImproveMealModal(false)}
                    className="p-2 rounded-full hover:bg-gray-100 transition-colors"
                  >
                    <X size={20} style={{ color: colors.textLight }} />
                  </button>
                )}
              </div>

              {/* Content */}
              <div className="p-4">
                {isImprovingMeal ? (
                  // 生成中
                  <div className="py-8 text-center">
                    <div className="w-12 h-12 border-3 border-t-transparent rounded-full animate-spin mx-auto mb-4" style={{ borderColor: colors.accent, borderTopColor: 'transparent' }} />
                    <p style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>AI栄養士の提案で献立を改善中...</p>
                    <p style={{ fontSize: 12, color: colors.textLight, marginTop: 8 }}>しばらくお待ちください</p>
                  </div>
                ) : (
                  <>
                    {/* 対象日表示 */}
                    <div className="mb-4 p-3 rounded-lg" style={{ background: colors.bg }}>
                      <p style={{ fontSize: 12, color: colors.textLight }}>対象日</p>
                      <p style={{ fontSize: 16, fontWeight: 600, color: colors.text }}>
                        {weekDates[selectedDayIndex]?.date.getMonth() + 1}月{weekDates[selectedDayIndex]?.date.getDate()}日（{weekDates[selectedDayIndex]?.dayOfWeek}）
                        {weekDates[selectedDayIndex]?.dateStr === new Date().toISOString().split('T')[0] && <span className="ml-2 text-xs px-2 py-0.5 rounded-full" style={{ background: colors.accentLight, color: colors.accent }}>今日</span>}
                      </p>
                    </div>

                    {/* AI栄養士のコメント抜粋 */}
                    {nutritionFeedback && (
                      <div className="mb-4 p-3 rounded-lg" style={{ background: colors.accentLight }}>
                        <div className="flex items-center gap-1 mb-1">
                          <Sparkles size={12} color={colors.accent} />
                          <span style={{ fontSize: 10, fontWeight: 600, color: colors.accent }}>AI栄養士の提案</span>
                        </div>
                        <p style={{ fontSize: 11, color: colors.text, lineHeight: 1.5 }} className="line-clamp-3">
                          {nutritionFeedback}
                        </p>
                      </div>
                    )}

                    {/* 改善対象の選択 */}
                    <div className="mb-4">
                      <p style={{ fontSize: 12, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
                        どの食事を改善しますか？
                      </p>
                      {(() => {
                        const targetDateStr = weekDates[selectedDayIndex]?.dateStr;
                        const targetDay = currentPlan?.days?.find((d: MealPlanDay) => d.dayDate === targetDateStr);
                        const todayStr = new Date().toISOString().split('T')[0];
                        const isPast = targetDateStr && targetDateStr < todayStr;
                        
                        if (isPast) {
                          // 過去の日は翌日を対象に
                          return (
                            <div className="p-3 rounded-lg text-center" style={{ background: colors.bg }}>
                              <p style={{ fontSize: 12, color: colors.textLight, marginBottom: 8 }}>
                                この日は過去のため、翌日の献立を改善します
                              </p>
                              <button
                                onClick={() => {
                                  // 翌日へ移動して再表示
                                  const nextIndex = Math.min(selectedDayIndex + 1, weekDates.length - 1);
                                  if (nextIndex !== selectedDayIndex) {
                                    setSelectedDayIndex(nextIndex);
                                    setShowImproveMealModal(false);
                                    // 翌日のモーダルを再度開く
                                    setTimeout(() => {
                                      setImproveMealTargets(['breakfast', 'lunch', 'dinner']);
                                      setShowImproveMealModal(true);
                                    }, 100);
                                  }
                                }}
                                className="px-4 py-2 rounded-lg text-xs font-medium"
                                style={{ background: colors.accent, color: '#fff' }}
                              >
                                翌日の献立を改善
                              </button>
                            </div>
                          );
                        }
                        
                        const mealOptions: { type: MealType; label: string; icon: string }[] = [
                          { type: 'breakfast', label: '朝食', icon: '🌅' },
                          { type: 'lunch', label: '昼食', icon: '☀️' },
                          { type: 'dinner', label: '夕食', icon: '🌙' },
                        ];
                        
                        return (
                          <div className="space-y-2">
                            {mealOptions.map(opt => {
                              const isSelected = improveMealTargets.includes(opt.type);
                              const existingMeal = targetDay?.meals?.find((m: PlannedMeal) => m.mealType === opt.type);
                              
                              return (
                                <button
                                  key={opt.type}
                                  onClick={() => {
                                    if (isSelected) {
                                      setImproveMealTargets(improveMealTargets.filter(t => t !== opt.type));
                                    } else {
                                      setImproveMealTargets([...improveMealTargets, opt.type]);
                                    }
                                  }}
                                  className={`w-full p-3 rounded-lg flex items-center gap-3 transition-all ${isSelected ? 'ring-2 ring-orange-400' : ''}`}
                                  style={{
                                    background: isSelected ? colors.accentLight : colors.bg,
                                  }}
                                >
                                  <span className="text-xl">{opt.icon}</span>
                                  <div className="flex-1 text-left">
                                    <p style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{opt.label}</p>
                                    <p style={{ fontSize: 11, color: colors.textLight }}>
                                      {existingMeal?.dishes?.length 
                                        ? `現在: ${existingMeal.dishes.map((d: DishDetail) => d.name).join('、')}` 
                                        : '未設定'
                                      }
                                    </p>
                                  </div>
                                  <div 
                                    className={`w-5 h-5 rounded-full flex items-center justify-center ${isSelected ? 'bg-white' : ''}`}
                                    style={{ border: isSelected ? 'none' : `2px solid ${colors.border}` }}
                                  >
                                    {isSelected && <Check size={14} color={colors.accent} />}
                                  </div>
                                </button>
                              );
                            })}
                            
                            {/* 1日全体を選択 */}
                            <button
                              onClick={() => {
                                setImproveNextDay(false);
                                if (improveMealTargets.length === 3) {
                                  setImproveMealTargets([]);
                                } else {
                                  setImproveMealTargets(['breakfast', 'lunch', 'dinner']);
                                }
                              }}
                              className="w-full p-2 rounded-lg text-xs text-center transition-all"
                              style={{ 
                                background: !improveNextDay && improveMealTargets.length === 3 ? colors.accentLight : 'transparent',
                                color: colors.accent 
                              }}
                            >
                              {!improveNextDay && improveMealTargets.length === 3 ? '✓ この日1日を選択中' : 'この日1日全体を選択'}
                            </button>
                            
                            {/* 翌日1日を改善 */}
                            {(() => {
                              const nextDayIndex = selectedDayIndex + 1;
                              const nextDay = weekDates[nextDayIndex];
                              if (!nextDay) return null;
                              
                              return (
                                <button
                                  onClick={() => {
                                    setImproveNextDay(true);
                                    setImproveMealTargets(['breakfast', 'lunch', 'dinner']);
                                  }}
                                  className="w-full p-3 rounded-lg text-sm text-center transition-all flex items-center justify-center gap-2"
                                  style={{ 
                                    background: improveNextDay ? colors.accentLight : colors.bg,
                                    color: improveNextDay ? colors.accent : colors.textLight,
                                    border: improveNextDay ? `2px solid ${colors.accent}` : 'none'
                                  }}
                                >
                                  <span>📅</span>
                                  <span>
                                    {improveNextDay ? '✓ ' : ''}翌日（{nextDay.date.getMonth() + 1}/{nextDay.date.getDate()}）1日を改善
                                  </span>
                                </button>
                              );
                            })()}
                          </div>
                        );
                      })()}
                    </div>

                    {/* 実行ボタン */}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setShowImproveMealModal(false)}
                        className="flex-1 py-3 rounded-lg text-sm"
                        style={{ background: colors.bg, color: colors.textLight }}
                      >
                        キャンセル
                      </button>
                      <button
                        onClick={async () => {
                          if (improveMealTargets.length === 0) {
                            alert('改善する食事を選択してください');
                            return;
                          }
                          
                          setIsImprovingMeal(true);
                          
                          try {
                            // 翌日モードの場合は翌日の日付を使用
                            const targetDateStr = improveNextDay 
                              ? weekDates[selectedDayIndex + 1]?.dateStr 
                              : weekDates[selectedDayIndex]?.dateStr;
                            
                            if (!targetDateStr) {
                              alert('対象日が見つかりません');
                              setIsImprovingMeal(false);
                              return;
                            }
                            
                            // AI栄養士のコメントをユーザーコメントとして使用
                            const analysisDate = weekDates[selectedDayIndex]?.dateStr;
                            const userComment = nutritionFeedback 
                              ? `${analysisDate}の栄養分析に基づくAI栄養士の提案を参考に改善してください：\n${nutritionFeedback}`
                              : undefined;
                            
                            // V4 Generateを呼び出すためのスロットを構築
                            const targetSlots = improveMealTargets.map(mealType => ({
                              date: targetDateStr,
                              mealType,
                            }));
                            
                            // V4 APIを直接呼び出し（リクエスト作成とEdge Function呼び出しを一括で行う）
                            const requestRes = await fetch('/api/ai/menu/v4/generate', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                targetSlots,
                                note: userComment,
                                constraints: {},
                              }),
                            });
                            
                            if (!requestRes.ok) {
                              const errorData = await requestRes.json().catch(() => ({}));
                              throw new Error(errorData.error || 'リクエストの作成に失敗しました');
                            }
                            
                            const requestData = await requestRes.json();
                            
                            // モーダルを閉じてメインページで進捗を確認
                            setShowImproveMealModal(false);
                            setShowNutritionDetailModal(false);
                            
                            // 進捗表示を開始（totalSlotsを正しく設定）
                            const totalSlotsCount = targetSlots.length;
                            setIsGenerating(true);
                            setGenerationProgress({
                              phase: 'analyzing',
                              message: 'AI栄養士の提案を反映中...',
                              percentage: 5,
                              totalSlots: totalSlotsCount,
                              completedSlots: 0,
                            });
                            
                            // ポーリングで進捗を追跡（既存のV4用のRealtimeを使用）
                            if (requestData.requestId) {
                              v4Generation.subscribeToProgress(
                                requestData.requestId,
                                async (progress: any) => {
                                  // 進捗更新
                                  const uiProgress = convertV4ProgressToUIFormat(progress);
                                  setGenerationProgress(uiProgress);
                                  
                                  // 完了したらデータを再取得
                                  if (progress.status === 'completed' || progress.status === 'failed') {
                                    setIsGenerating(false);
                                    setGenerationProgress(null);
                                    // データを再取得
                                    const startStr = weekDates[0]?.dateStr;
                                    const endStr = weekDates[weekDates.length - 1]?.dateStr;
                                    if (startStr && endStr) {
                                      const refreshRes = await fetch(`/api/meal-plans/weekly?startDate=${startStr}&endDate=${endStr}`);
                                      if (refreshRes.ok) {
                                        const { dailyMeals, shoppingList: shoppingListData } = await refreshRes.json();
                                        if (dailyMeals && dailyMeals.length > 0) {
                                          setCurrentPlan({ days: dailyMeals });
                                          if (shoppingListData?.items) setShoppingList(shoppingListData.items);
                                        }
                                      }
                                    }
                                  }
                                }
                              );
                            }
                          } catch (error) {
                            console.error('Failed to improve meals:', error);
                            alert('献立の改善に失敗しました。もう一度お試しください。');
                          } finally {
                            setIsImprovingMeal(false);
                          }
                        }}
                        disabled={improveMealTargets.length === 0}
                        className="flex-1 py-3 rounded-lg text-sm font-medium text-white disabled:opacity-50 flex items-center justify-center gap-2"
                        style={{ background: colors.accent }}
                      >
                        <Sparkles size={14} />
                        {improveNextDay 
                          ? `翌日${improveMealTargets.length}食分を改善` 
                          : `${improveMealTargets.length}食分を改善`
                        }
                      </button>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// V4用の日付加算ヘルパー
function addDaysStr(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}
