import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Line, Polygon, Text as SvgText } from "react-native-svg";

import { NUTRIENT_DEFINITIONS, type NutrientDefinition, MODE_CONFIG as MODE_CONFIG_SHARED, MEAL_ORDER as MEAL_ORDER_SHARED, type MealType } from "@homegohan/shared";
import { Button, Card, EmptyState, LoadingState, StatusBadge } from "../../../src/components/ui";
import { AddMealModal } from "../../../src/components/menu/AddMealModal";
import { AddMealSlotModal } from "../../../src/components/menu/AddMealSlotModal";
import { EmptySlot } from "../../../src/components/menu/EmptySlot";
import { EmptySlotAIBanner } from "../../../src/components/menu/EmptySlotAIBanner";
import { ConfirmDeleteModal } from "../../../src/components/menu/ConfirmDeleteModal";
import { ImproveMealModal } from "../../../src/components/menu/ImproveMealModal";
import { ProgressTodoCard } from "../../../src/components/menu/ProgressTodoCard";
import { RoleBadge } from "../../../src/components/menu/RoleBadge";
import { RecipeModal, type RecipeModalMeal } from "../../../src/components/menu/RecipeModal";
import { ServingsModal } from "../../../src/components/menu/ServingsModal";
import { StatsModal, type NutrientValues, type WeekNutrientData } from "../../../src/components/menu/StatsModal";
import { WeeklyHeader } from "../../../src/components/menu/WeeklyHeader";
import { V4GenerateModal } from "../../../src/components/menu/V4GenerateModal";
import { NutritionDetailModal } from "../../../src/components/menu/NutritionDetailModal";
import { RegenerateMealModal } from "../../../src/components/menu/RegenerateMealModal";
import { PantryModal } from "../../../src/components/menu/PantryModal";
import { ShoppingListModal } from "../../../src/components/menu/ShoppingListModal";
import { useV4MenuGeneration } from "../../../src/hooks/useV4MenuGeneration";
import { colors, spacing, radius, shadows } from "../../../src/theme";
import { getApi, getApiBaseUrl } from "../../../src/lib/api";
import { supabase } from "../../../src/lib/supabase";
import { useProfile } from "../../../src/providers/ProfileProvider";
import type { WeekStartDay } from "../../../src/providers/ProfileProvider";
import type { V4GenerateParams } from "../../../src/components/menu/V4GenerateModal";

type PlannedMealRow = {
  id: string;
  meal_type: string;
  dish_name: string;
  mode: string | null;
  role: string | null;
  calories_kcal: number | null;
  is_completed: boolean | null;
  is_generating: boolean | null;
  display_order?: number | null;
  // nutrition fields
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  sodium_g: number | null;
  sugar_g: number | null;
  fiber_g: number | null;
  potassium_mg: number | null;
  calcium_mg: number | null;
  magnesium_mg: number | null;
  phosphorus_mg: number | null;
  iron_mg: number | null;
  zinc_mg: number | null;
  iodine_ug: number | null;
  cholesterol_mg: number | null;
  vitamin_a_ug: number | null;
  vitamin_b1_mg: number | null;
  vitamin_b2_mg: number | null;
  vitamin_b6_mg: number | null;
  vitamin_b12_ug: number | null;
  vitamin_c_mg: number | null;
  vitamin_d_ug: number | null;
  vitamin_e_mg: number | null;
  vitamin_k_ug: number | null;
  folic_acid_ug: number | null;
  saturated_fat_g: number | null;
  // recipe fields
  ingredients: string[] | null;
  recipe_steps: string[] | null;
  dishes: Array<{
    name: string;
    role?: string;
    ingredients?: string[];
    ingredientsMd?: string;
    recipeSteps?: string[];
    recipeStepsMd?: string;
  }> | null;
};

type DayRow = {
  id: string;
  day_date: string;
  planned_meals: PlannedMealRow[];
};

type MealPlanRow = {
  id: string;
  start_date: string;
  end_date: string;
  title: string;
};

type PendingProgress = {
  phase?: string;
  message: string;
  percentage?: number;
  currentStep?: number;
  totalSteps?: number;
  completedSlots?: number;
  totalSlots?: number;
};

// ============================================================
// DayNutritionTotals — 26 栄養素の集計型
// ============================================================

interface DayNutritionTotals {
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  sodiumG: number;
  sugarG: number;
  fiberG: number;
  potassiumMg: number;
  calciumMg: number;
  phosphorusMg: number;
  magnesiumMg: number;
  ironMg: number;
  zincMg: number;
  iodineUg: number;
  cholesterolMg: number;
  vitaminAUg: number;
  vitaminB1Mg: number;
  vitaminB2Mg: number;
  vitaminB6Mg: number;
  vitaminB12Ug: number;
  vitaminCMg: number;
  vitaminDUg: number;
  vitaminEMg: number;
  vitaminKUg: number;
  folicAcidUg: number;
  saturatedFatG: number;
}

// @homegohan/shared の NUTRIENT_DEFINITIONS を使用 (26 栄養素)
const NUTRIENT_DEFS: NutrientDefinition[] = NUTRIENT_DEFINITIONS;

const DEFAULT_RADAR_KEYS: (keyof DayNutritionTotals)[] = [
  "caloriesKcal", "proteinG", "fatG", "carbsG", "fiberG", "calciumMg", "vitaminCMg",
];

const EMPTY_TOTALS: DayNutritionTotals = {
  caloriesKcal: 0, proteinG: 0, fatG: 0, carbsG: 0, sodiumG: 0,
  sugarG: 0, fiberG: 0, potassiumMg: 0, calciumMg: 0, phosphorusMg: 0,
  magnesiumMg: 0, ironMg: 0, zincMg: 0, iodineUg: 0, cholesterolMg: 0,
  vitaminAUg: 0, vitaminB1Mg: 0, vitaminB2Mg: 0, vitaminB6Mg: 0,
  vitaminB12Ug: 0, vitaminCMg: 0, vitaminDUg: 0, vitaminEMg: 0,
  vitaminKUg: 0, folicAcidUg: 0, saturatedFatG: 0,
};

function calcDayTotals(meals: PlannedMealRow[]): DayNutritionTotals {
  const t = { ...EMPTY_TOTALS };
  for (const m of meals) {
    t.caloriesKcal  += m.calories_kcal  ?? 0;
    t.proteinG      += m.protein_g      ?? 0;
    t.fatG          += m.fat_g          ?? 0;
    t.carbsG        += m.carbs_g        ?? 0;
    t.sodiumG       += m.sodium_g       ?? 0;
    t.sugarG        += m.sugar_g        ?? 0;
    t.fiberG        += m.fiber_g        ?? 0;
    t.potassiumMg   += m.potassium_mg   ?? 0;
    t.calciumMg     += m.calcium_mg     ?? 0;
    t.phosphorusMg  += m.phosphorus_mg  ?? 0;
    t.magnesiumMg   += m.magnesium_mg   ?? 0;
    t.ironMg        += m.iron_mg        ?? 0;
    t.zincMg        += m.zinc_mg        ?? 0;
    t.iodineUg      += m.iodine_ug      ?? 0;
    t.cholesterolMg += m.cholesterol_mg ?? 0;
    t.vitaminAUg    += m.vitamin_a_ug   ?? 0;
    t.vitaminB1Mg   += m.vitamin_b1_mg  ?? 0;
    t.vitaminB2Mg   += m.vitamin_b2_mg  ?? 0;
    t.vitaminB6Mg   += m.vitamin_b6_mg  ?? 0;
    t.vitaminB12Ug  += m.vitamin_b12_ug ?? 0;
    t.vitaminCMg    += m.vitamin_c_mg   ?? 0;
    t.vitaminDUg    += m.vitamin_d_ug   ?? 0;
    t.vitaminEMg    += m.vitamin_e_mg   ?? 0;
    t.vitaminKUg    += m.vitamin_k_ug   ?? 0;
    t.folicAcidUg   += m.folic_acid_ug  ?? 0;
    t.saturatedFatG += m.saturated_fat_g ?? 0;
  }
  return t;
}

function driPercent(key: keyof DayNutritionTotals, value: number): number {
  const def = NUTRIENT_DEFS.find((d) => d.key === key);
  if (!def || def.dri === 0) return 0;
  return Math.round((value / def.dri) * 100);
}

function driColor(pct: number): string {
  if (pct > 150) return colors.error;
  if (pct >= 80 && pct <= 120) return colors.success;
  if (pct < 50) return colors.warning;
  return colors.accent;
}

// ============================================================
// Radar Chart (react-native-svg)
// ============================================================

interface RadarChartProps {
  totals: DayNutritionTotals;
  nutrientKeys: (keyof DayNutritionTotals)[];
  size?: number;
}

function NutritionRadarChartSvg({ totals, nutrientKeys, size = 220 }: RadarChartProps) {
  const n = nutrientKeys.length;
  if (n < 3) return null;
  const cx = size / 2;
  const cy = size / 2;
  const maxRadius = size * 0.37;
  const labelRadius = size * 0.47;
  const LEVELS = 3;
  const MAX_PCT = 150;
  const angleOf = (i: number) => ((2 * Math.PI) / n) * i - Math.PI / 2;
  const ptOnCircle = (r: number, i: number) => ({
    x: cx + r * Math.cos(angleOf(i)),
    y: cy + r * Math.sin(angleOf(i)),
  });
  const gridPolygons = Array.from({ length: LEVELS }, (_, l) => {
    const r = (maxRadius * (l + 1)) / LEVELS;
    return Array.from({ length: n }, (__, i) => ptOnCircle(r, i))
      .map((p) => `${p.x},${p.y}`).join(" ");
  });
  const spokes = Array.from({ length: n }, (_, i) => ptOnCircle(maxRadius, i));
  const dataPoints = nutrientKeys.map((key, i) => {
    const val = totals[key] as number;
    const pct = Math.min(driPercent(key, val), MAX_PCT);
    return ptOnCircle((pct / MAX_PCT) * maxRadius, i);
  });
  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(" ");
  const refPolygon = Array.from({ length: n }, (_, i) =>
    ptOnCircle((100 / MAX_PCT) * maxRadius, i)
  ).map((p) => `${p.x},${p.y}`).join(" ");
  const pcts = nutrientKeys.map((key) =>
    Math.min(driPercent(key, totals[key] as number), MAX_PCT)
  );
  const avgPct = Math.round(pcts.reduce((s, v) => s + v, 0) / pcts.length);
  const labelFontSize = Math.max(7, Math.min(9, size / 26));
  return (
    <View style={{ alignItems: "center", width: size, height: size }}>
      <Svg width={size} height={size}>
        {gridPolygons.map((pts, l) => (
          <Polygon key={`g${l}`} points={pts} fill="none" stroke="#E8E8E8" strokeWidth={1} />
        ))}
        <Polygon points={refPolygon} fill="none" stroke={colors.textMuted} strokeWidth={1} strokeDasharray="3 3" />
        {spokes.map((p, i) => (
          <Line key={`s${i}`} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#E8E8E8" strokeWidth={1} />
        ))}
        <Polygon points={dataPolygon} fill={`${colors.accent}40`} stroke={colors.accent} strokeWidth={2} />
        {dataPoints.map((p, i) => (
          <Circle key={`d${i}`} cx={p.x} cy={p.y} r={3} fill={colors.accent} />
        ))}
        {nutrientKeys.map((key, i) => {
          const lp = ptOnCircle(labelRadius, i);
          const def = NUTRIENT_DEFS.find((d) => d.key === key);
          const label = def?.label ?? String(key);
          const anchor = Math.abs(lp.x - cx) < 4 ? "middle" : lp.x < cx ? "end" : "start";
          return (
            <SvgText key={`l${i}`} x={lp.x} y={lp.y} fontSize={labelFontSize}
              fill="#9A9A9A" textAnchor={anchor} alignmentBaseline="middle">
              {label}
            </SvgText>
          );
        })}
      </Svg>
      <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "800", color: driColor(avgPct) }}>{avgPct}%</Text>
        <Text style={{ fontSize: 9, color: colors.textMuted }}>平均達成率</Text>
      </View>
    </View>
  );
}

// ============================================================
// Nutrition Bottom Sheet
// ============================================================

interface NutritionSheetProps {
  visible: boolean;
  onClose: () => void;
  day: DayRow | null;
  dateLabel: string;
  radarKeys: (keyof DayNutritionTotals)[];
  weekDays: DayRow[];
}

function NutritionBottomSheet({ visible, onClose, day, dateLabel, radarKeys, weekDays }: NutritionSheetProps) {
  const meals = day?.planned_meals ?? [];
  const totals = useMemo(() => calcDayTotals(meals), [meals]);
  const [praiseComment, setPraiseComment]         = useState<string | null>(null);
  const [adviceText, setAdviceText]               = useState<string | null>(null);
  const [nutritionTip, setNutritionTip]           = useState<string | null>(null);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!visible || !day) return;
    setPraiseComment(null); setAdviceText(null); setNutritionTip(null);
    setIsLoadingFeedback(true);
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    const mealCount = meals.filter((m) => m.dish_name).length;
    if (mealCount === 0) { setIsLoadingFeedback(false); return; }
    fetchFeedback(day.day_date, totals, mealCount);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [visible, day?.day_date]);

  async function fetchFeedback(dateStr: string, nutrition: DayNutritionTotals, mealCount: number, forceRefresh = false) {
    setIsLoadingFeedback(true);
    const weekData = weekDays.map((d) => ({
      date: d.day_date,
      meals: d.planned_meals.map((m) => ({
        title: m.dish_name,
        calories: m.calories_kcal,
      })),
    }));
    try {
      const api = getApi();
      const res = await api.post<any>("/api/ai/nutrition/feedback", { date: dateStr, nutrition, mealCount, forceRefresh, weekData });
      if (res.cached && (res.feedback || res.praiseComment)) {
        setPraiseComment(res.praiseComment ?? null);
        setAdviceText(res.advice ?? res.feedback ?? null);
        setNutritionTip(res.nutritionTip ?? null);
        setIsLoadingFeedback(false);
        return;
      }
      if (res.status === "generating" && res.cacheId) { startPolling(res.cacheId); }
      else { setIsLoadingFeedback(false); }
    } catch { setIsLoadingFeedback(false); }
  }

  function startPolling(cacheId: string) {
    let resolved = false; let count = 0;
    pollRef.current = setInterval(async () => {
      if (resolved || count >= 20) { if (pollRef.current) clearInterval(pollRef.current); setIsLoadingFeedback(false); return; }
      count++;
      try {
        const api = getApi();
        const res = await api.get<any>(`/api/ai/nutrition/feedback?cacheId=${cacheId}`);
        if (res.status === "completed" && (res.feedback || res.praiseComment)) {
          resolved = true;
          setPraiseComment(res.praiseComment ?? null);
          setAdviceText(res.advice ?? res.feedback ?? null);
          setNutritionTip(res.nutritionTip ?? null);
          setIsLoadingFeedback(false);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch { /* ignore */ }
    }, 2000);
  }

  const DRI_BAR_NUTRIENTS = NUTRIENT_DEFS.slice(0, 14);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)" }} onPress={onClose} />
      <View testID="weekly-nutrition-sheet" style={{ backgroundColor: colors.bg, borderTopLeftRadius: radius["2xl"], borderTopRightRadius: radius["2xl"], maxHeight: "85%", ...shadows.lg }}>
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="bar-chart" size={18} color={colors.accent} />
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{dateLabel} の栄養分析</Text>
          </View>
          <Pressable testID="weekly-nutrition-sheet-close" onPress={onClose} hitSlop={8}>
            <Ionicons name="close" size={22} color={colors.textMuted} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          {/* Radar Chart */}
          <View testID="weekly-radar-chart" style={{ alignItems: "center" }}>
            <NutritionRadarChartSvg totals={totals} nutrientKeys={radarKeys} size={220} />
          </View>
          {/* AI Feedback */}
          <View style={{ gap: spacing.md }}>
            <View style={{ backgroundColor: colors.successLight, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <Ionicons name="heart" size={14} color={colors.success} />
                <Text style={{ fontSize: 12, fontWeight: "600", color: colors.success }}>褒めポイント</Text>
                {(praiseComment || adviceText) && !isLoadingFeedback && (
                  <Pressable onPress={() => { const mc = meals.filter((m) => m.dish_name).length; if (day) fetchFeedback(day.day_date, totals, mc, true); }}
                    style={{ marginLeft: "auto", backgroundColor: colors.bg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
                    <Text style={{ fontSize: 10, color: colors.textMuted }}>再分析</Text>
                  </Pressable>
                )}
              </View>
              {isLoadingFeedback ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <ActivityIndicator size="small" color={colors.success} />
                  <Text style={{ fontSize: 11, color: colors.textLight }}>あなたの献立を分析中...</Text>
                </View>
              ) : praiseComment ? (
                <Text style={{ fontSize: 13, color: colors.text, lineHeight: 20 }}>{praiseComment}</Text>
              ) : (
                <Text style={{ fontSize: 11, color: colors.textMuted }}>分析データがありません</Text>
              )}
            </View>
            {(adviceText || isLoadingFeedback) && (
              <View style={{ backgroundColor: colors.accentLight, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="sparkles" size={14} color={colors.accent} />
                  <Text style={{ fontSize: 12, fontWeight: "600", color: colors.accent }}>改善アドバイス</Text>
                </View>
                {isLoadingFeedback ? (
                  <Text style={{ fontSize: 11, color: colors.textMuted }}>...</Text>
                ) : (
                  <Text style={{ fontSize: 12, color: colors.text, lineHeight: 18 }}>{adviceText}</Text>
                )}
              </View>
            )}
            {nutritionTip && (
              <View style={{ backgroundColor: colors.blueLight, borderRadius: radius.md, padding: spacing.md, flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
                <Text style={{ fontSize: 12 }}>💡</Text>
                <Text style={{ flex: 1, fontSize: 11, color: colors.blue, lineHeight: 17 }}>{nutritionTip}</Text>
              </View>
            )}
          </View>
          {/* DRI Bars */}
          <View>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text, marginBottom: spacing.md }}>
              📊 栄養素の達成率（{meals.length}食分）
            </Text>
            <View style={{ gap: spacing.sm }}>
              {DRI_BAR_NUTRIENTS.map((def) => {
                const value = totals[def.key as keyof DayNutritionTotals] as number;
                const pct = driPercent(def.key as keyof DayNutritionTotals, value);
                const barColor = driColor(pct);
                return (
                  <View key={String(def.key)} style={{ backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md, gap: 4 }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={{ fontSize: 12, color: colors.textLight }}>{def.label}</Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={{ fontSize: 11, color: colors.textMuted }}>{value.toFixed(def.decimals)}{def.unit}</Text>
                        <Text style={{ fontSize: 11, fontWeight: "700", color: barColor, minWidth: 36, textAlign: "right" }}>{pct}%</Text>
                      </View>
                    </View>
                    <View style={{ height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: "hidden" }}>
                      <View style={{ width: `${Math.min(pct, 100)}%`, height: "100%", backgroundColor: barColor, borderRadius: 3 }} />
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
          <View style={{ height: spacing.xl }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// Get day-of-week labels ordered by weekStartDay
const getDayLabels = (weekStartDay: WeekStartDay = 'monday'): string[] => {
  return weekStartDay === 'sunday'
    ? ['日', '月', '火', '水', '木', '金', '土']
    : ['月', '火', '水', '木', '金', '土', '日'];
};

// Build full calendar grid for a month (6-row × 7-column)
const getCalendarDays = (month: Date, weekStartDay: WeekStartDay = 'monday'): Date[] => {
  const year = month.getFullYear();
  const m = month.getMonth();
  const firstDay = new Date(year, m, 1);
  const lastDay = new Date(year, m + 1, 0);

  const firstDayOfWeek = firstDay.getDay(); // 0 = Sunday
  const startOffset = weekStartDay === 'sunday' ? 0 : 1;
  let startPadding = firstDayOfWeek - startOffset;
  if (startPadding < 0) startPadding += 7;

  const days: Date[] = [];
  for (let i = startPadding - 1; i >= 0; i--) {
    days.push(new Date(year, m, -i));
  }
  for (let i = 1; i <= lastDay.getDate(); i++) {
    days.push(new Date(year, m, i));
  }
  while (days.length % 7 !== 0) {
    days.push(new Date(year, m + 1, days.length - lastDay.getDate() - startPadding + 1));
  }
  return days;
};

// Japanese holidays cache (year -> { "YYYY-MM-DD": holidayName })
const holidaysCache = new Map<number, Record<string, string>>();

const fetchJapaneseHolidays = async (year: number): Promise<Record<string, string>> => {
  if (holidaysCache.has(year)) return holidaysCache.get(year)!;
  try {
    const response = await fetch(`https://holidays-jp.github.io/api/v1/${year}/date.json`);
    if (!response.ok) throw new Error('Failed to fetch holidays');
    const data = await response.json();
    holidaysCache.set(year, data);
    return data;
  } catch {
    return {};
  }
};

function getWeekStart(date: Date, weekStartDay: WeekStartDay = 'monday'): Date {
  const d = new Date(date);
  const currentDay = d.getDay();
  const targetDay = weekStartDay === 'sunday' ? 0 : 1;
  let diff = currentDay - targetDay;
  if (diff < 0) diff += 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

const DOW = ["月", "火", "水", "木", "金", "土", "日"];

// MEAL_ORDER は @homegohan/shared からインポート (MEAL_ORDER_SHARED)
// 表示順: breakfast / lunch / dinner / snack / midnight_snack
const MEAL_ORDER = MEAL_ORDER_SHARED;

const MEAL_CONFIG: Record<string, { icon: keyof typeof Ionicons.glyphMap; label: string; color: string }> = {
  breakfast: { icon: "sunny", label: "朝食", color: "#FF9800" },
  lunch: { icon: "partly-sunny", label: "昼食", color: "#4CAF50" },
  snack: { icon: "cafe", label: "おやつ", color: "#E91E63" },
  dinner: { icon: "moon", label: "夕食", color: "#7C4DFF" },
  midnight_snack: { icon: "cloudy-night", label: "夜食", color: "#3F51B5" },
};

// MODE_CONFIG — @homegohan/shared の抽象キーを App 用の実色値に変換
const MODE_CONFIG = Object.fromEntries(
  Object.entries(MODE_CONFIG_SHARED).map(([key, cfg]) => [
    key,
    {
      icon: cfg.iconKey === 'sparkles' ? 'sparkles' : undefined,
      label: cfg.label,
      color: colors[cfg.colorKey as keyof typeof colors],
      bg: colors[cfg.bgColorKey as keyof typeof colors],
    },
  ])
) as Record<string, { icon?: string; label: string; color: string; bg: string }>;

export default function WeeklyMenuPage() {
  const { profile } = useProfile();
  const weekStartDay = profile?.weekStartDay ?? 'monday';
  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date(), weekStartDay));
  const weekStartStr = useMemo(() => formatLocalDate(weekStart), [weekStart]);
  const weekEndStr = useMemo(() => {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    return formatLocalDate(end);
  }, [weekStart]);

  const [plan, setPlan] = useState<MealPlanRow | null>(null);
  const [days, setDays] = useState<DayRow[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(() => formatLocalDate(new Date()));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regeneratingMealId, setRegeneratingMealId] = useState<string | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [pendingProgress, setPendingProgress] = useState<PendingProgress | null>(null);
  const [pendingIsUltimate, setPendingIsUltimate] = useState(false);
  const [showV4Modal, setShowV4Modal] = useState(false);

  const { isGenerating: isV4Generating, generate: v4Generate } = useV4MenuGeneration({
    onGenerationStart: (reqId) => {
      setPendingRequestId(reqId);
      setPendingStatus("processing");
      setPendingIsUltimate(false);
    },
    onGenerationComplete: async () => {
      await loadData();
      setPendingRequestId(null);
      setPendingStatus(null);
      setPendingProgress(null);
      setPendingIsUltimate(false);
      Alert.alert("完了", "週間献立の生成が完了しました。");
    },
    onError: (msg) => {
      setPendingRequestId(null);
      setPendingStatus(null);
      setPendingProgress(null);
      setPendingIsUltimate(false);
      setError(msg);
    },
  });

  const handleV4Generate = useCallback(async (params: V4GenerateParams) => {
    setShowV4Modal(false);
    await v4Generate({
      targetSlots: params.targetSlots,
      constraints: params.constraints,
      note: params.note,
      ultimateMode: false,
      resolveExistingMeals: params.resolveExistingMeals,
    });
  }, [v4Generate]);

  // Nutrition sheet state
  const [nutritionSheetDay, setNutritionSheetDay] = useState<DayRow | null>(null);
  const [nutritionSheetLabel, setNutritionSheetLabel] = useState("");

  // Radar chart nutrient keys — fetched from profile (falls back to DEFAULT_RADAR_KEYS)
  const [radarChartNutrients, setRadarChartNutrients] = useState<(keyof DayNutritionTotals)[]>(DEFAULT_RADAR_KEYS);

  // Calendar state
  const [displayMonth, setDisplayMonth] = useState<Date>(() => new Date());
  const [holidays, setHolidays] = useState<Record<string, string>>({});
  const [isCalendarExpanded, setIsCalendarExpanded] = useState(false);
  const [calendarMealDates, setCalendarMealDates] = useState<Set<string>>(new Set());
  const fetchedRangesRef = useRef<Set<string>>(new Set());

  // Modal state (将来用 — Phase 5/6 で各モーダルを open する)
  const [activeModal, setActiveModal] = useState<'stats' | 'fridge' | 'shopping' | null>(null);
  const [showServingsModal, setShowServingsModal] = useState(false);
  const [deleteTargetMeal, setDeleteTargetMeal] = useState<{ id: string; name: string } | null>(null);
  const [showImproveMealModal, setShowImproveMealModal] = useState(false);

  // AddMealSlotModal state
  const [addMealSlotVisible, setAddMealSlotVisible] = useState(false);
  const [addMealSlotDayId, setAddMealSlotDayId] = useState<string>("");

  // AddMealModal state
  const [addMealModalVisible, setAddMealModalVisible] = useState(false);
  const [addMealModalDayId, setAddMealModalDayId] = useState<string>("");
  const [addMealModalDayDate, setAddMealModalDayDate] = useState<string>("");
  const [addMealModalMealType, setAddMealModalMealType] = useState<MealType>("dinner");

  // RecipeModal state
  const [recipeModalMeal, setRecipeModalMeal] = useState<RecipeModalMeal | null>(null);

  // 展開中の食事カード ID (WEB 仕様と同様のインライン展開)
  const [expandedMealId, setExpandedMealId] = useState<string | null>(null);

  // RegenerateMealModal state
  const [showRegenerateModal, setShowRegenerateModal] = useState(false);
  const [selectedMealForRegen, setSelectedMealForRegen] = useState<PlannedMealRow | null>(null);

  useEffect(() => {
    const fetchRadarProfile = async () => {
      try {
        const api = getApi();
        const profileData = await api.get<any>("/api/profile");
        if (
          profileData?.radar_chart_nutrients &&
          Array.isArray(profileData.radar_chart_nutrients) &&
          profileData.radar_chart_nutrients.length > 0
        ) {
          setRadarChartNutrients(profileData.radar_chart_nutrients as (keyof DayNutritionTotals)[]);
        }
      } catch (e) {
        // API エラー時は DEFAULT_RADAR_KEYS のまま
        console.error("[WeeklyMenuPage] Failed to fetch radar_chart_nutrients:", e);
      }
    };
    fetchRadarProfile();
  }, []);

  useEffect(() => {
    setWeekStart(getWeekStart(new Date(), weekStartDay));
  }, [weekStartDay]);

  // Sync displayMonth to weekStart
  useEffect(() => {
    setDisplayMonth(weekStart);
  }, [weekStart]);

  // Fetch Japanese holidays whenever displayed month changes
  useEffect(() => {
    const year = displayMonth.getFullYear();
    const month = displayMonth.getMonth();
    const fetch = async () => {
      const data = await fetchJapaneseHolidays(year);
      setHolidays(prev => ({ ...prev, ...data }));
      if (month === 0) {
        const prev = await fetchJapaneseHolidays(year - 1);
        setHolidays(h => ({ ...h, ...prev }));
      } else if (month === 11) {
        const next = await fetchJapaneseHolidays(year + 1);
        setHolidays(h => ({ ...h, ...next }));
      }
    };
    fetch();
  }, [displayMonth]);

  // Fetch and cache meal existence dates for a date range
  const fetchAndCacheMealDates = useCallback(async (startDate: Date, endDate: Date) => {
    const rangeKey = `${formatLocalDate(startDate)}_${formatLocalDate(endDate)}`;
    if (fetchedRangesRef.current.has(rangeKey)) return;
    fetchedRangesRef.current.add(rangeKey);
    try {
      const api = getApi();
      const res = await api.get<{ dailyMeals: any[] }>(
        `/api/meal-plans?startDate=${formatLocalDate(startDate)}&endDate=${formatLocalDate(endDate)}`
      );
      const newDates = new Set<string>();
      res.dailyMeals?.forEach((day: any) => {
        if (day.meals && day.meals.length > 0) newDates.add(day.dayDate);
      });
      setCalendarMealDates(prev => {
        const merged = new Set(prev);
        newDates.forEach(d => merged.add(d));
        return merged;
      });
    } catch {
      fetchedRangesRef.current.delete(rangeKey);
    }
  }, []);

  // Prefetch adjacent weeks when weekStart changes
  useEffect(() => {
    const start = new Date(weekStart);
    start.setDate(start.getDate() - 14);
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 28);
    fetchAndCacheMealDates(start, end);
  }, [weekStart, fetchAndCacheMealDates]);

  // Prefetch full month when displayMonth changes
  useEffect(() => {
    const year = displayMonth.getFullYear();
    const month = displayMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const start = new Date(firstDay);
    start.setDate(start.getDate() - 7);
    const end = new Date(lastDay);
    end.setDate(end.getDate() + 7);
    fetchAndCacheMealDates(start, end);
  }, [displayMonth, fetchAndCacheMealDates]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const api = getApi();
      const res = await api.get<{ dailyMeals: any[]; startDate: string; endDate: string }>(`/api/meal-plans?startDate=${weekStartStr}&endDate=${weekEndStr}`);
      const dailyMeals = res.dailyMeals ?? [];

      if (dailyMeals.length === 0) {
        setPlan(null);
        setDays([]);
        return;
      }

      setPlan({
        id: dailyMeals[0].id,
        start_date: res.startDate ?? weekStartStr,
        end_date: res.endDate ?? weekEndStr,
        title: "週間献立",
      });

      const mappedDays: DayRow[] = dailyMeals.map((d: any) => ({
        id: d.id,
        day_date: d.dayDate,
        planned_meals: (d.meals ?? []).map((m: any) => ({
          id: m.id,
          meal_type: m.mealType,
          dish_name: m.dishName,
          mode: m.mode,
          calories_kcal: m.caloriesKcal,
          is_completed: m.isCompleted,
          is_generating: m.isGenerating,
          display_order: m.displayOrder,
          // nutrition
          protein_g:       m.proteinG       ?? null,
          fat_g:           m.fatG           ?? null,
          carbs_g:         m.carbsG         ?? null,
          sodium_g:        m.sodiumG        ?? null,
          sugar_g:         m.sugarG         ?? null,
          fiber_g:         m.fiberG         ?? null,
          potassium_mg:    m.potassiumMg    ?? null,
          calcium_mg:      m.calciumMg      ?? null,
          magnesium_mg:    m.magnesiumMg    ?? null,
          phosphorus_mg:   m.phosphorusMg   ?? null,
          iron_mg:         m.ironMg         ?? null,
          zinc_mg:         m.zincMg         ?? null,
          iodine_ug:       m.iodineUg       ?? null,
          cholesterol_mg:  m.cholesterolMg  ?? null,
          vitamin_a_ug:    m.vitaminAUg     ?? null,
          vitamin_b1_mg:   m.vitaminB1Mg    ?? null,
          vitamin_b2_mg:   m.vitaminB2Mg    ?? null,
          vitamin_b6_mg:   m.vitaminB6Mg    ?? null,
          vitamin_b12_ug:  m.vitaminB12Ug   ?? null,
          vitamin_c_mg:    m.vitaminCMg     ?? null,
          vitamin_d_ug:    m.vitaminDUg     ?? null,
          vitamin_e_mg:    m.vitaminEMg     ?? null,
          vitamin_k_ug:    m.vitaminKUg     ?? null,
          folic_acid_ug:   m.folicAcidUg    ?? null,
          saturated_fat_g: m.saturatedFatG  ?? null,
          // recipe fields
          role:            m.role            ?? null,
          ingredients:     m.ingredients     ?? null,
          recipe_steps:    m.recipeSteps     ?? null,
          dishes:          m.dishes          ?? null,
        })),
      }));

      setDays(mappedDays);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
      setPlan(null);
      setDays([]);
    } finally {
      setIsLoading(false);
    }
  }, [weekStartStr, weekEndStr]);

  useEffect(() => {
    loadData();
  }, [weekStartStr, weekEndStr]);

  const selectedDay = useMemo(() => days.find((d) => d.day_date === selectedDate) ?? null, [days, selectedDate]);

  const emptySlotCount = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let count = 0;
    for (const day of days) {
      const dayDate = new Date(day.day_date + "T00:00:00");
      if (dayDate < today) continue;
      const filledTypes = new Set(day.planned_meals.map((m) => m.meal_type));
      for (const type of ["breakfast", "lunch", "dinner"]) {
        if (!filledTypes.has(type)) count++;
      }
    }
    return count;
  }, [days]);

  function shiftWeek(delta: number) {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + delta * 7);
    setWeekStart(getWeekStart(d, weekStartDay));
    setSelectedDate(formatLocalDate(d));
  }

  async function checkPending() {
    try {
      const api = getApi();
      const res = await api.get<{ hasPending: boolean; requestId?: string; status?: string; startDate?: string; mode?: string }>(
        `/api/ai/menu/weekly/pending?date=${weekStartStr}`
      );
      if (res.hasPending && res.requestId && res.startDate === weekStartStr) {
        setPendingRequestId(res.requestId);
        setPendingStatus(res.status ?? "processing");
        setPendingIsUltimate(res.mode === "v4" || res.mode === "v5");
        return;
      }
      setPendingRequestId(null);
      setPendingStatus(null);
      setPendingIsUltimate(false);
    } catch {
      setPendingRequestId(null);
      setPendingStatus(null);
      setPendingIsUltimate(false);
    }
  }

  function openNutritionSheet(day: DayRow) {
    const d = new Date(day.day_date + "T00:00:00");
    setNutritionSheetLabel(`${d.getMonth() + 1}/${d.getDate()}`);
    setNutritionSheetDay(day);
  }

  useEffect(() => {
    checkPending();
  }, [weekStartStr]);

  // Supabase Realtime で進捗をリアルタイム監視
  useEffect(() => {
    if (!pendingRequestId) return;

    const channel = supabase
      .channel(`weekly-menu-progress-${pendingRequestId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "weekly_menu_requests",
          filter: `id=eq.${pendingRequestId}`,
        },
        async (payload) => {
          const newRecord = payload.new as {
            status: string;
            error_message?: string | null;
            progress?: PendingProgress | null;
          };

          setPendingStatus(newRecord.status);
          if (newRecord.progress) {
            setPendingProgress(newRecord.progress);
          }

          if (newRecord.status === "completed") {
            await loadData();
            setPendingRequestId(null);
            setPendingStatus(null);
            setPendingProgress(null);
            setPendingIsUltimate(false);
            Alert.alert("完了", "週間献立の生成が完了しました。");
          }
          if (newRecord.status === "failed") {
            setPendingRequestId(null);
            setPendingStatus(null);
            setPendingProgress(null);
            setPendingIsUltimate(false);
            setError(newRecord.error_message ?? "週間献立の生成に失敗しました。");
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [pendingRequestId]);

  useEffect(() => {
    if (!pendingRequestId) return;

    const poll = async () => {
      try {
        const api = getApi();
        const res = await api.get<{
          status: string;
          errorMessage?: string | null;
          progress?: PendingProgress | null;
        }>(`/api/ai/menu/weekly/status?requestId=${pendingRequestId}`);

        setPendingStatus(res.status);
        if (res.progress) {
          setPendingProgress(res.progress);
        }

        if (res.status === "completed") {
          await loadData();
          setPendingRequestId(null);
          setPendingStatus(null);
          setPendingProgress(null);
          setPendingIsUltimate(false);
        } else if (res.status === "failed") {
          setPendingRequestId(null);
          setPendingStatus(null);
          setPendingProgress(null);
          setPendingIsUltimate(false);
          setError(res.errorMessage ?? "週間献立の生成に失敗しました。");
        }
      } catch {
        // Ignore transient polling errors
      }
    };

    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [loadData, pendingRequestId]);

  useEffect(() => {
    if (pendingRequestId) return;
    const hasGenerating = days.some((d) => d.planned_meals?.some((m) => m.is_generating));
    if (!hasGenerating) return;
    const t = setInterval(() => {
      loadData();
    }, 5000);
    return () => clearInterval(t);
  }, [days, pendingRequestId, weekStartStr, weekEndStr]);

  async function reorderMeal(mealId: string, direction: "up" | "down") {
    if (!selectedDay) return;
    try {
      const api = getApi();
      await api.post("/api/meal-plans/meals/reorder", { mealId, direction, dayId: selectedDay.id });
      await loadData();
    } catch (e: any) {
      setError(e?.message ?? "順序変更に失敗しました。");
    }
  }

  async function regenerateMeal(mealId: string, mealType: string) {
    if (regeneratingMealId) return;
    setRegeneratingMealId(mealId);
    try {
      const api = getApi();
      await api.post("/api/ai/menu/meal/regenerate", {
        mealId,
        dayDate: selectedDate,
        mealType,
      });
      await loadData();
    } catch (e: any) {
      setError(e?.message ?? "再生成に失敗しました。");
    } finally {
      setRegeneratingMealId(null);
    }
  }

  async function deleteMeal(mealId: string) {
    try {
      const base = getApiBaseUrl();
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${base}/api/meal-plans/meals/${mealId}`, {
        method: "DELETE",
        headers: {
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
      });
      if (!r.ok) throw new Error(`DELETE failed: ${r.status}`);
      await loadData();
    } catch (e: any) {
      setError(e?.message ?? "削除に失敗しました。");
    }
  }

  async function toggleMealCompletion(mealId: string, currentCompleted: boolean | null) {
    const newCompleted = !currentCompleted;
    // 楽観的 UI 更新
    setDays(prev =>
      prev.map(d => ({
        ...d,
        planned_meals: d.planned_meals.map(m =>
          m.id === mealId ? { ...m, is_completed: newCompleted } : m
        ),
      }))
    );
    try {
      const base = getApiBaseUrl();
      const { data: { session } } = await supabase.auth.getSession();
      const r = await fetch(`${base}/api/meal-plans/meals/${mealId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ isCompleted: newCompleted }),
      });
      if (!r.ok) throw new Error(`PATCH failed: ${r.status}`);
      await loadData();
    } catch (e: any) {
      // ロールバック
      setDays(prev =>
        prev.map(d => ({
          ...d,
          planned_meals: d.planned_meals.map(m =>
            m.id === mealId ? { ...m, is_completed: currentCompleted } : m
          ),
        }))
      );
      setError(e?.message ?? "更新に失敗しました。");
    }
  }

  // Day selector helpers
  const getDayOfWeek = (dateStr: string): string => {
    const d = new Date(dateStr + "T00:00:00");
    const DAY_LABELS_SUN = ["日", "月", "火", "水", "木", "金", "土"];
    return DAY_LABELS_SUN[d.getDay()] ?? "";
  };

  const sortedMeals = useMemo(() => {
    if (!selectedDay?.planned_meals) return [];
    return [...selectedDay.planned_meals].sort((a, b) => {
      const ao = a.display_order ?? 0;
      const bo = b.display_order ?? 0;
      if (ao !== bo) return ao - bo;
      const ai = MEAL_ORDER.indexOf(a.meal_type as any);
      const bi = MEAL_ORDER.indexOf(b.meal_type as any);
      return ai - bi;
    });
  }, [selectedDay]);

  const daySummary = useMemo(() => {
    if (!selectedDay?.planned_meals) return { totalCalories: 0, completed: 0, total: 0 };
    const meals = selectedDay.planned_meals;
    return {
      totalCalories: meals.reduce((s, m) => s + (m.calories_kcal ?? 0), 0),
      completed: meals.filter((m) => m.is_completed).length,
      total: meals.length,
    };
  }, [selectedDay]);

  // Calendar memos
  const calendarDays = useMemo(() => getCalendarDays(displayMonth, weekStartDay), [displayMonth, weekStartDay]);
  const dayLabels = useMemo(() => getDayLabels(weekStartDay), [weekStartDay]);
  const todayStr = useMemo(() => formatLocalDate(new Date()), []);
  const mealExistenceMap = useMemo(() => {
    const map = new Map<string, boolean>();
    days.forEach(d => {
      if (d.planned_meals && d.planned_meals.length > 0) map.set(d.day_date, true);
    });
    calendarMealDates.forEach(dateStr => map.set(dateStr, true));
    return map;
  }, [days, calendarMealDates]);

  // WeeklyHeader 用の集計値
  const weeklyStats = useMemo(() => {
    const allMeals = days.flatMap(d => d.planned_meals);
    const totalMeals = allMeals.length;
    if (totalMeals === 0) return { cookRate: 0, avgKcal: 0 };
    const cookMeals = allMeals.filter(m => m.mode === 'cook' || m.mode === null).length;
    const cookRate = Math.round((cookMeals / totalMeals) * 100);
    const totalKcal = allMeals.reduce((s, m) => s + (m.calories_kcal ?? 0), 0);
    const daysWithMeals = days.filter(d => d.planned_meals.length > 0).length;
    const avgKcal = daysWithMeals > 0 ? Math.round(totalKcal / daysWithMeals) : 0;
    return { cookRate, avgKcal };
  }, [days]);

  const weekRangeLabel = `${weekStartStr.slice(5)} - ${weekEndStr.slice(5)}`;

  // StatsModal 用: 選択日の今日栄養素
  const todayNutrientsForStats = useMemo((): NutrientValues => {
    const day = days.find((d) => d.day_date === selectedDate);
    const meals = day?.planned_meals ?? [];
    return {
      caloriesKcal: meals.reduce((s, m) => s + (m.calories_kcal ?? 0), 0),
      proteinG: meals.reduce((s, m) => s + (m.protein_g ?? 0), 0),
      fatG: meals.reduce((s, m) => s + (m.fat_g ?? 0), 0),
      carbsG: meals.reduce((s, m) => s + (m.carbs_g ?? 0), 0),
      fiberG: meals.reduce((s, m) => s + (m.fiber_g ?? 0), 0),
      sodiumG: meals.reduce((s, m) => s + (m.sodium_g ?? 0), 0),
      sugarG: meals.reduce((s, m) => s + (m.sugar_g ?? 0), 0),
      potassiumMg: meals.reduce((s, m) => s + (m.potassium_mg ?? 0), 0),
      calciumMg: meals.reduce((s, m) => s + (m.calcium_mg ?? 0), 0),
      magnesiumMg: meals.reduce((s, m) => s + (m.magnesium_mg ?? 0), 0),
      phosphorusMg: meals.reduce((s, m) => s + (m.phosphorus_mg ?? 0), 0),
      ironMg: meals.reduce((s, m) => s + (m.iron_mg ?? 0), 0),
      zincMg: meals.reduce((s, m) => s + (m.zinc_mg ?? 0), 0),
      iodineUg: meals.reduce((s, m) => s + (m.iodine_ug ?? 0), 0),
      cholesterolMg: meals.reduce((s, m) => s + (m.cholesterol_mg ?? 0), 0),
      vitaminAUg: meals.reduce((s, m) => s + (m.vitamin_a_ug ?? 0), 0),
      vitaminB1Mg: meals.reduce((s, m) => s + (m.vitamin_b1_mg ?? 0), 0),
      vitaminB2Mg: meals.reduce((s, m) => s + (m.vitamin_b2_mg ?? 0), 0),
      vitaminB6Mg: meals.reduce((s, m) => s + (m.vitamin_b6_mg ?? 0), 0),
      vitaminB12Ug: meals.reduce((s, m) => s + (m.vitamin_b12_ug ?? 0), 0),
      vitaminCMg: meals.reduce((s, m) => s + (m.vitamin_c_mg ?? 0), 0),
      vitaminDUg: meals.reduce((s, m) => s + (m.vitamin_d_ug ?? 0), 0),
      vitaminEMg: meals.reduce((s, m) => s + (m.vitamin_e_mg ?? 0), 0),
      vitaminKUg: meals.reduce((s, m) => s + (m.vitamin_k_ug ?? 0), 0),
      folicAcidUg: meals.reduce((s, m) => s + (m.folic_acid_ug ?? 0), 0),
      saturatedFatG: meals.reduce((s, m) => s + (m.saturated_fat_g ?? 0), 0),
    };
  }, [days, selectedDate]);

  // StatsModal 用: 週間栄養集計
  const weekNutrientsForStats = useMemo((): WeekNutrientData => {
    const activeDays = days.filter((d) => d.planned_meals.length > 0);
    const count = activeDays.length || 1;
    const dailyKcal = days.map((d) =>
      d.planned_meals.reduce((s, m) => s + (m.calories_kcal ?? 0), 0)
    );
    const totalProtein = days.flatMap((d) => d.planned_meals).reduce((s, m) => s + (m.protein_g ?? 0), 0);
    const totalFat = days.flatMap((d) => d.planned_meals).reduce((s, m) => s + (m.fat_g ?? 0), 0);
    const totalCarbs = days.flatMap((d) => d.planned_meals).reduce((s, m) => s + (m.carbs_g ?? 0), 0);
    const totalFiber = days.flatMap((d) => d.planned_meals).reduce((s, m) => s + (m.fiber_g ?? 0), 0);
    const totalKcal = dailyKcal.reduce((s, v) => s + v, 0);
    return {
      avgCalories: totalKcal / count,
      dailyKcal,
      avgProtein: totalProtein / count,
      avgFat: totalFat / count,
      avgCarbs: totalCarbs / count,
      avgFiber: totalFiber / count,
    };
  }, [days]);

  // StatsModal 用: 選択日の meals (AI feedback 取得用)
  const todayMealsForStats = useMemo(() => {
    const day = days.find((d) => d.day_date === selectedDate);
    return (day?.planned_meals ?? []).map((m) => ({
      dish_name: m.dish_name,
      calories_kcal: m.calories_kcal,
    }));
  }, [days, selectedDate]);

  function handleCalendarDateClick(day: Date) {
    const newWeekStart = getWeekStart(day, weekStartDay);
    const newWeekStartStr = formatLocalDate(newWeekStart);
    if (newWeekStartStr !== weekStartStr) {
      setWeekStart(newWeekStart);
    }
    setSelectedDate(formatLocalDate(day));
    setIsCalendarExpanded(false);
  }

  return (
    <SafeAreaView testID="weekly-screen" edges={["top"]} style={{ flex: 1, backgroundColor: colors.bg }}>
      <WeeklyHeader
        weekRangeLabel={weekRangeLabel}
        weeklyStats={weeklyStats}
        expiringCount={0}
        uncheckedShoppingCount={0}
        onPressStats={() => {
          console.log('stats modal placeholder');
          setActiveModal('stats');
        }}
        onPressFridge={() => {
          console.log('fridge modal placeholder');
          setActiveModal('fridge');
        }}
        onPressShopping={() => setActiveModal('shopping')}
      />

      {/* V4 AI アシスタント モーダル */}
      <V4GenerateModal
        visible={showV4Modal}
        onClose={() => setShowV4Modal(false)}
        onGenerate={handleV4Generate}
        mealPlanDays={days}
        weekStartDate={weekStartStr}
        weekEndDate={weekEndStr}
        isGenerating={isV4Generating}
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      {/* 月カレンダー展開バー */}
      <Pressable
        testID="weekly-calendar-toggle"
        onPress={() => setIsCalendarExpanded(prev => !prev)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.sm,
          borderRadius: radius.md,
          backgroundColor: colors.bg,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons
            name={isCalendarExpanded ? "chevron-up" : "chevron-down"}
            size={14}
            color={colors.textMuted}
          />
          <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>
            {displayMonth.getFullYear()}年{displayMonth.getMonth() + 1}月
          </Text>
        </View>
        {isCalendarExpanded && (
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Pressable
              onPress={e => {
                e.stopPropagation?.();
                setDisplayMonth(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
              }}
              style={{ padding: 4 }}
            >
              <Ionicons name="chevron-back" size={14} color={colors.textMuted} />
            </Pressable>
            <Pressable
              onPress={e => {
                e.stopPropagation?.();
                setDisplayMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
              }}
              style={{ padding: 4 }}
            >
              <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
            </Pressable>
          </View>
        )}
      </Pressable>

      {/* 月カレンダーグリッド */}
      {isCalendarExpanded && (
        <View style={{ paddingHorizontal: spacing.sm, paddingBottom: spacing.md }}>
          {/* 曜日ヘッダー */}
          <View style={{ flexDirection: "row", marginBottom: 4 }}>
            {dayLabels.map((label, i) => {
              const isWeekendCol = weekStartDay === 'sunday'
                ? (i === 0 || i === 6)
                : (i === 5 || i === 6);
              return (
                <View key={label} style={{ flex: 1, alignItems: "center", paddingVertical: 4 }}>
                  <Text style={{ fontSize: 10, color: isWeekendCol ? colors.accent : colors.textMuted }}>
                    {label}
                  </Text>
                </View>
              );
            })}
          </View>
          {/* 日付グリッド */}
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {calendarDays.map((day, i) => {
              const dateStr = formatLocalDate(day);
              const isCurrentMonth = day.getMonth() === displayMonth.getMonth();
              const isSelected = dateStr === selectedDate;
              const isInSelectedWeek =
                dateStr >= weekStartStr && dateStr <= weekEndStr;
              const isToday = dateStr === todayStr;
              const hasMeal = mealExistenceMap.get(dateStr);
              const isWeekend = day.getDay() === 0 || day.getDay() === 6;
              const isHoliday = !!holidays[dateStr];

              return (
                <Pressable
                  key={i}
                  testID={`weekly-day-cell-${dateStr}`}
                  onPress={() => handleCalendarDateClick(day)}
                  style={{
                    width: "14.28%",
                    alignItems: "center",
                    paddingVertical: 6,
                    borderRadius: radius.md,
                    backgroundColor: isSelected
                      ? colors.accent
                      : isInSelectedWeek
                        ? colors.accentLight
                        : "transparent",
                    opacity: isCurrentMonth ? 1 : 0.3,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: isToday ? "700" : "400",
                      color: isSelected
                        ? "#fff"
                        : isHoliday
                          ? colors.danger
                          : isToday
                            ? colors.accent
                            : isWeekend
                              ? colors.accent
                              : colors.text,
                    }}
                  >
                    {day.getDate()}
                  </Text>
                  {hasMeal ? (
                    <View
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: 2,
                        marginTop: 2,
                        backgroundColor: isSelected ? "#fff" : colors.success,
                      }}
                    />
                  ) : (
                    <View style={{ width: 4, height: 4, marginTop: 2 }} />
                  )}
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <Card testID="weekly-error-banner" variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ flex: 1, color: colors.error, fontSize: 13 }}>{error}</Text>
          </View>
          <Button size="sm" variant="ghost" onPress={() => { setError(null); loadData(); }}>再読み込み</Button>
        </Card>
      ) : (
        <>
          {/* AI生成中プログレス */}
          {pendingRequestId && (
            <View testID="weekly-generating-indicator">
              <ProgressTodoCard
                mode={pendingIsUltimate ? "ultimate" : "normal"}
                currentPhase={pendingProgress?.phase ?? ""}
                progress={pendingProgress?.percentage ?? 0}
                completedSlots={pendingProgress?.completedSlots}
                totalSlots={pendingProgress?.totalSlots}
                message={pendingProgress?.message}
                defaultMessage={pendingIsUltimate ? "究極モードで献立を生成中..." : "AIが献立を生成中..."}
              />
            </View>
          )}

          {/* 日付セレクタ — 週ナビ左右端 + 7日タブ中央 */}
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {/* 前の週ボタン */}
            <Pressable
              testID="weekly-prev-button"
              onPress={() => shiftWeek(-1)}
              style={({ pressed }) => ({
                alignItems: "center",
                justifyContent: "center",
                paddingVertical: spacing.sm,
                paddingHorizontal: 4,
                borderRadius: radius.md,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Ionicons name="chevron-back" size={16} color={colors.textMuted} />
              <Text style={{ fontSize: 8, color: colors.textMuted, marginTop: 2 }}>前の週</Text>
            </Pressable>

            {/* 7日タブ */}
            {days.map((d) => {
              const selected = d.day_date === selectedDate;
              const isToday = d.day_date === todayStr;
              const dow = getDayOfWeek(d.day_date);
              const dayNum = d.day_date.slice(8);
              const completedAll = d.planned_meals.length > 0 && d.planned_meals.every((m) => m.is_completed);
              const hasGenerating = d.planned_meals.some((m) => m.is_generating);
              const dayOfWeek = new Date(d.day_date + "T00:00:00").getDay(); // 0=日,6=土
              const isHolidayDay = !!holidays[d.day_date];
              const isSunday = dayOfWeek === 0;
              const isSaturday = dayOfWeek === 6;
              // 祝日・日曜日=danger(赤系)、土曜日=blue(青系)
              const accentColor = (isHolidayDay || isSunday) ? colors.danger : isSaturday ? colors.blue : null;

              return (
                <Pressable
                  key={d.id}
                  testID={`weekly-day-tab-${d.day_date}`}
                  onPress={() => setSelectedDate(d.day_date)}
                  style={({ pressed }) => ({
                    flex: 1,
                    alignItems: "center",
                    gap: 2,
                    paddingVertical: spacing.sm,
                    paddingHorizontal: 2,
                    borderRadius: radius.lg,
                    backgroundColor: selected ? (accentColor ?? colors.accent) : "transparent",
                    ...(pressed ? { opacity: 0.9 } : {}),
                  })}
                >
                  <Text style={{ fontSize: 9, color: selected ? "rgba(255,255,255,0.7)" : colors.textMuted }}>{dayNum}</Text>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: selected ? "#fff" : (accentColor ?? colors.text) }}>{dow}</Text>
                  {isToday && !selected ? (
                    <View style={{
                      backgroundColor: colors.accent,
                      borderRadius: radius.sm,
                      paddingHorizontal: 4,
                      paddingVertical: 1,
                    }}>
                      <Text style={{ fontSize: 8, fontWeight: "700", color: "#fff" }}>今日</Text>
                    </View>
                  ) : completedAll ? (
                    <Ionicons name="checkmark-circle" size={12} color={selected ? "#fff" : colors.success} />
                  ) : hasGenerating ? (
                    <ActivityIndicator size={10} color={selected ? "#fff" : (accentColor ?? colors.accent)} />
                  ) : (
                    <Text style={{ fontSize: 9, color: selected ? "rgba(255,255,255,0.7)" : colors.textMuted }}>
                      {d.planned_meals.length}食
                    </Text>
                  )}
                </Pressable>
              );
            })}

            {/* 翌週ボタン */}
            <Pressable
              testID="weekly-next-button"
              onPress={() => shiftWeek(1)}
              style={({ pressed }) => ({
                alignItems: "center",
                justifyContent: "center",
                paddingVertical: spacing.sm,
                paddingHorizontal: 4,
                borderRadius: radius.md,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              <Text style={{ fontSize: 8, color: colors.textMuted, marginTop: 2 }}>翌週</Text>
            </Pressable>
          </View>

          {/* AI バナー — 空欄件数表示 */}
          <EmptySlotAIBanner
            emptySlotCount={emptySlotCount}
            onPress={() => setShowV4Modal(true)}
          />

          {/* 選択日のサマリ */}
          {selectedDay && daySummary.total > 0 && (
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 13, color: colors.textMuted }}>
                {daySummary.totalCalories.toLocaleString()} kcal・{daySummary.completed}/{daySummary.total} 完了
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                {/* 栄養分析ボタン */}
                <Pressable
                  onPress={() => openNutritionSheet(selectedDay)}
                  style={{
                    flexDirection: "row", alignItems: "center", gap: 4,
                    paddingVertical: 5, paddingHorizontal: spacing.md,
                    borderRadius: radius.sm, backgroundColor: colors.accentLight,
                    borderWidth: 1, borderColor: colors.accent,
                  }}
                >
                  <Ionicons name="bar-chart" size={13} color={colors.accent} />
                  <Text style={{ fontSize: 12, fontWeight: "600", color: colors.accent }}>栄養</Text>
                </Pressable>
                <Button testID="weekly-request-button" size="sm" variant="ghost" onPress={() => router.push("/menus/weekly/request")}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <Ionicons name="sparkles" size={14} color={colors.accent} />
                    <Text style={{ fontSize: 12, fontWeight: "600", color: colors.accent }}>AIで再生成</Text>
                  </View>
                </Button>
              </View>
            </View>
          )}

          {/* 食事一覧 — 朝食/昼食/夕食スロットを常時表示 */}
          {selectedDay && (
            <View style={{ gap: spacing.md }}>
              {(["breakfast", "lunch", "dinner"] as const).map((mealType) => {
                const m = sortedMeals.find((meal) => meal.meal_type === mealType);
                if (!m) {
                  return (
                    <EmptySlot
                      key={mealType}
                      mealType={mealType}
                      dayId={selectedDay.id}
                      dayDate={selectedDay.day_date}
                      mealLabel={MEAL_CONFIG[mealType]?.label ?? mealType}
                      onPress={() => {
                        setAddMealModalDayId(selectedDay.id);
                        setAddMealModalDayDate(selectedDay.day_date);
                        setAddMealModalMealType(mealType);
                        setAddMealModalVisible(true);
                      }}
                    />
                  );
                }
                return null;
              })}
              {sortedMeals.map((m) => {
                const mealCfg = MEAL_CONFIG[m.meal_type] ?? { icon: "ellipse", label: m.meal_type, color: colors.textMuted };
                const modeCfg = MODE_CONFIG[m.mode ?? "cook"] ?? MODE_CONFIG.cook;
                const isGenerating = m.is_generating;
                const isExpanded = expandedMealId === m.id;
                const dishesArray: Array<{ name: string; role?: string; ingredients?: string[]; ingredientsMd?: string; recipeSteps?: string[]; recipeStepsMd?: string }> =
                  Array.isArray(m.dishes) ? m.dishes : [];

                return (
                  <View key={m.id}>
                    {/* 折り畳み時カード (CollapsedMealCard 相当) */}
                    {!isExpanded && (
                      <Pressable
                        testID={`weekly-meal-card-${m.id}`}
                        onPress={() => setExpandedMealId(m.id)}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          alignItems: "center",
                          gap: spacing.md,
                          padding: spacing.lg,
                          backgroundColor: m.is_completed ? colors.successLight : isGenerating ? colors.accentLight : colors.card,
                          borderRadius: radius.lg,
                          borderWidth: 1,
                          borderColor: m.is_completed ? colors.successLight : isGenerating ? colors.accentLight : colors.border,
                          ...(pressed ? { opacity: 0.9 } : {}),
                        })}
                      >
                        {/* 食事タイプアイコン */}
                        <View
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: radius.md,
                            backgroundColor: m.is_completed ? colors.success : mealCfg.color,
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {m.is_completed ? (
                            <Ionicons name="checkmark" size={24} color="#fff" />
                          ) : isGenerating ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <Ionicons name={mealCfg.icon} size={22} color="#fff" />
                          )}
                        </View>

                        {/* 情報 */}
                        <View style={{ flex: 1, gap: 3 }}>
                          <Text testID={`weekly-meal-dish-name-${m.id}`} style={{ fontSize: 15, fontWeight: "700", color: colors.text }} numberOfLines={1}>
                            {isGenerating ? "生成中..." : m.dish_name || "（未設定）"}
                          </Text>
                          {m.role ? <RoleBadge role={m.role} /> : null}
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                            <Text style={{ fontSize: 12, color: colors.textMuted }}>{mealCfg.label}</Text>
                            <View
                              style={{
                                backgroundColor: modeCfg.bg,
                                paddingHorizontal: 6,
                                paddingVertical: 2,
                                borderRadius: 4,
                              }}
                            >
                              <Text style={{ fontSize: 10, fontWeight: "700", color: modeCfg.color }}>{modeCfg.label}</Text>
                            </View>
                            {m.calories_kcal ? (
                              <Text testID={`weekly-meal-calories-${m.id}`} style={{ fontSize: 12, color: colors.textMuted }}>{m.calories_kcal} kcal</Text>
                            ) : null}
                          </View>
                        </View>

                        {/* 右端: 完了ステータス + 展開アイコン */}
                        <View style={{ alignItems: "center", gap: 4 }}>
                          {m.is_completed ? (
                            <StatusBadge variant="completed" label="完了" />
                          ) : isGenerating ? (
                            <StatusBadge variant="generating" label="生成中" />
                          ) : (
                            <Ionicons name="checkmark-circle-outline" size={22} color={colors.textMuted} />
                          )}
                          <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                        </View>
                      </Pressable>
                    )}

                    {/* 展開時カード (ExpandedMealCard 相当) */}
                    {isExpanded && (
                      <View
                        style={{
                          backgroundColor: colors.card,
                          borderRadius: radius.lg,
                          borderWidth: 1,
                          borderColor: colors.border,
                          padding: spacing.lg,
                          gap: spacing.md,
                        }}
                      >
                        {/* ヘッダー行: タップで折りたたむ */}
                        <Pressable
                          testID={`weekly-meal-card-${m.id}`}
                          onPress={() => setExpandedMealId(null)}
                          style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}
                        >
                          <View
                            style={{
                              width: 44,
                              height: 44,
                              borderRadius: radius.md,
                              backgroundColor: m.is_completed ? colors.success : mealCfg.color,
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {m.is_completed ? (
                              <Ionicons name="checkmark" size={24} color="#fff" />
                            ) : isGenerating ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <Ionicons name={mealCfg.icon} size={22} color="#fff" />
                            )}
                          </View>
                          <View style={{ flex: 1, gap: 3 }}>
                            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }} numberOfLines={1}>
                              {isGenerating ? "生成中..." : m.dish_name || "（未設定）"}
                            </Text>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                              <Text style={{ fontSize: 12, color: colors.textMuted }}>{mealCfg.label}</Text>
                              <View style={{ backgroundColor: modeCfg.bg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                                <Text style={{ fontSize: 10, fontWeight: "700", color: modeCfg.color }}>{modeCfg.label}</Text>
                              </View>
                              {m.calories_kcal ? (
                                <Text style={{ fontSize: 12, color: colors.textMuted }}>{m.calories_kcal} kcal</Text>
                              ) : null}
                            </View>
                          </View>
                          <Ionicons name="chevron-up" size={14} color={colors.textMuted} />
                        </Pressable>

                        {/* dishes 一覧: 各 dish タップで RecipeModal open */}
                        {dishesArray.length > 0 && (
                          <View style={{ gap: spacing.sm }}>
                            {dishesArray.map((dish, idx) => (
                              <Pressable
                                key={idx}
                                onPress={() => setRecipeModalMeal({
                                  id: m.id,
                                  dish_name: dish.name,
                                  calories_kcal: m.calories_kcal,
                                  protein_g: m.protein_g,
                                  fat_g: m.fat_g,
                                  carbs_g: m.carbs_g,
                                  ingredients: dish.ingredients ?? m.ingredients ?? undefined,
                                  recipe_steps: dish.recipeSteps ?? m.recipe_steps ?? undefined,
                                  dishes: [dish],
                                  role: dish.role ?? m.role ?? undefined,
                                })}
                                style={({ pressed }) => ({
                                  flexDirection: "row",
                                  alignItems: "center",
                                  gap: spacing.sm,
                                  paddingVertical: spacing.sm,
                                  paddingHorizontal: spacing.md,
                                  backgroundColor: pressed ? colors.accentLight : colors.bg,
                                  borderRadius: radius.md,
                                  borderWidth: 1,
                                  borderColor: colors.border,
                                })}
                              >
                                <Ionicons name="book-outline" size={14} color={colors.accent} />
                                <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>{dish.name}</Text>
                                {dish.role ? <RoleBadge role={dish.role} /> : null}
                                <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                              </Pressable>
                            ))}
                          </View>
                        )}

                        {/* dishes がない場合はレシピボタン */}
                        {dishesArray.length === 0 && (
                          <Pressable
                            onPress={() => setRecipeModalMeal({
                              id: m.id,
                              dish_name: m.dish_name,
                              calories_kcal: m.calories_kcal,
                              protein_g: m.protein_g,
                              fat_g: m.fat_g,
                              carbs_g: m.carbs_g,
                              ingredients: m.ingredients ?? undefined,
                              recipe_steps: m.recipe_steps ?? undefined,
                              dishes: m.dishes ?? undefined,
                              role: m.role ?? undefined,
                            })}
                            style={({ pressed }) => ({
                              flexDirection: "row",
                              alignItems: "center",
                              gap: spacing.sm,
                              paddingVertical: spacing.sm,
                              paddingHorizontal: spacing.md,
                              backgroundColor: pressed ? colors.accentLight : colors.bg,
                              borderRadius: radius.md,
                              borderWidth: 1,
                              borderColor: colors.border,
                            })}
                          >
                            <Ionicons name="book-outline" size={14} color={colors.accent} />
                            <Text style={{ flex: 1, fontSize: 13, color: colors.text }}>レシピを見る</Text>
                            <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                          </Pressable>
                        )}

                        {/* アクションボタン行 (展開時のみ) */}
                        <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
                          {/* 完了トグル */}
                          <Pressable
                            testID={`weekly-meal-toggle-${m.id}`}
                            onPress={() => toggleMealCompletion(m.id, m.is_completed)}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 4,
                              paddingVertical: 6,
                              paddingHorizontal: 10,
                              borderRadius: radius.sm,
                              backgroundColor: m.is_completed ? colors.successLight : colors.card,
                              borderWidth: 1,
                              borderColor: m.is_completed ? colors.success : colors.border,
                            }}
                          >
                            <Ionicons
                              name={m.is_completed ? "checkmark-circle" : "checkmark-circle-outline"}
                              size={14}
                              color={m.is_completed ? colors.success : colors.textLight}
                            />
                            <Text style={{ fontSize: 11, color: m.is_completed ? colors.success : colors.textLight }}>
                              {m.is_completed ? "完了済" : "完了"}
                            </Text>
                          </Pressable>
                          {/* 編集ボタン */}
                          <Pressable
                            onPress={() => router.push(`/meals/${m.id}/edit`)}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 4,
                              paddingVertical: 6,
                              paddingHorizontal: 10,
                              borderRadius: radius.sm,
                              backgroundColor: colors.card,
                              borderWidth: 1,
                              borderColor: colors.border,
                            }}
                          >
                            <Ionicons name="create-outline" size={14} color={colors.textLight} />
                            <Text style={{ fontSize: 11, color: colors.textLight }}>編集</Text>
                          </Pressable>
                          {/* AI で変更ボタン */}
                          <Pressable
                            onPress={() => {
                              setSelectedMealForRegen(m);
                              setShowRegenerateModal(true);
                            }}
                            disabled={!!regeneratingMealId}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 4,
                              paddingVertical: 6,
                              paddingHorizontal: 10,
                              borderRadius: radius.sm,
                              backgroundColor: regeneratingMealId === m.id ? colors.accentLight : colors.card,
                              borderWidth: 1,
                              borderColor: regeneratingMealId === m.id ? colors.accent : colors.border,
                            }}
                          >
                            <Ionicons name="refresh" size={14} color={regeneratingMealId === m.id ? colors.accent : colors.textLight} />
                            <Text style={{ fontSize: 11, color: regeneratingMealId === m.id ? colors.accent : colors.textLight }}>AIで変更</Text>
                          </Pressable>
                          {/* 削除ボタン */}
                          <Pressable
                            testID={`weekly-meal-delete-btn-${m.id}`}
                            onPress={() => setDeleteTargetMeal({ id: m.id, name: m.dish_name || "この食事" })}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 4,
                              paddingVertical: 6,
                              paddingHorizontal: 10,
                              borderRadius: radius.sm,
                              backgroundColor: colors.errorLight,
                              borderWidth: 1,
                              borderColor: colors.error,
                            }}
                          >
                            <Ionicons name="trash-outline" size={14} color={colors.error} />
                          </Pressable>
                        </View>
                      </View>
                    )}
                  </View>
                );
              })}

              {/* +食事タイプ追加ボタン */}
              {selectedDay && (
                <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
                  <Pressable
                    testID="weekly-add-meal-type-btn"
                    onPress={() => {
                      setAddMealSlotDayId(selectedDay.id);
                      setAddMealSlotVisible(true);
                    }}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                      paddingVertical: 6,
                      paddingHorizontal: 10,
                      borderRadius: radius.sm,
                      backgroundColor: pressed ? colors.accentLight : colors.card,
                      borderWidth: 1,
                      borderColor: colors.accent,
                    })}
                  >
                    <Ionicons name="add" size={14} color={colors.accent} />
                    <Text style={{ fontSize: 11, color: colors.accent, fontWeight: "600" }}>食事タイプ追加</Text>
                  </Pressable>
                </View>
              )}
            </View>
          )}
        </>
      )}
      </ScrollView>

      {/* 食事タイプ選択モーダル */}
      <AddMealSlotModal
        visible={addMealSlotVisible}
        onClose={() => setAddMealSlotVisible(false)}
        dayId={addMealSlotDayId}
        onSelect={(mealType: MealType) => {
          setAddMealSlotVisible(false);
          setAddMealModalDayId(addMealSlotDayId);
          setAddMealModalDayDate(selectedDate);
          setAddMealModalMealType(mealType);
          setAddMealModalVisible(true);
        }}
      />

      {/* 食事追加モーダル */}
      <AddMealModal
        visible={addMealModalVisible}
        onClose={() => setAddMealModalVisible(false)}
        dayId={addMealModalDayId}
        dayDate={addMealModalDayDate}
        mealType={addMealModalMealType}
        onSuccess={() => loadData()}
      />

      {/* 削除確認モーダル */}
      <ConfirmDeleteModal
        visible={deleteTargetMeal !== null}
        mealName={deleteTargetMeal?.name ?? ""}
        onCancel={() => setDeleteTargetMeal(null)}
        onConfirm={async () => {
          if (!deleteTargetMeal) return;
          const id = deleteTargetMeal.id;
          setDeleteTargetMeal(null);
          await deleteMeal(id);
        }}
      />

      {/* 栄養分析モーダル (StatsModal) */}
      <StatsModal
        visible={activeModal === 'stats'}
        onClose={() => setActiveModal(null)}
        onOpenImprove={() => {
          setActiveModal(null);
          setShowImproveMealModal(true);
        }}
        selectedDate={selectedDate}
        weekRange={{ start: weekStartStr, end: weekEndStr }}
        todayNutrients={todayNutrientsForStats}
        weekNutrients={weekNutrientsForStats}
        userId={profile?.id ?? ''}
        weekDayLabels={getDayLabels(weekStartDay)}
        todayMeals={todayMealsForStats}
      />

      {/* 買い物リストモーダル */}
      <ShoppingListModal
        visible={activeModal === 'shopping'}
        onClose={() => setActiveModal(null)}
        onOpenAdd={() => {}}
        onOpenRange={() => setActiveModal(null)}
        onOpenServings={() => setShowServingsModal(true)}
      />

      {/* 献立を改善モーダル */}
      <ImproveMealModal
        visible={showImproveMealModal}
        onClose={() => setShowImproveMealModal(false)}
        selectedDate={selectedDate}
      />

      {/* 栄養分析ボトムシート (旧) */}
      <NutritionBottomSheet
        visible={nutritionSheetDay !== null}
        onClose={() => setNutritionSheetDay(null)}
        day={nutritionSheetDay}
        dateLabel={nutritionSheetLabel}
        radarKeys={radarChartNutrients}
        weekDays={days}
      />

      {/* 栄養分析詳細モーダル (PR 6-2: 26 栄養素 + AI フィードバック) */}
      {nutritionSheetDay && (
        <NutritionDetailModal
          visible={nutritionSheetDay !== null}
          onClose={() => setNutritionSheetDay(null)}
          date={nutritionSheetDay.day_date}
          dateLabel={nutritionSheetLabel}
          totals={calcDayTotals(nutritionSheetDay.planned_meals)}
          mealCount={nutritionSheetDay.planned_meals.filter((m) => m.dish_name).length}
          radarKeys={radarChartNutrients as string[]}
          onRadarKeysSaved={(keys) => setRadarChartNutrients(keys as (keyof DayNutritionTotals)[])}
          weekDays={days.map((d) => ({
            date: d.day_date,
            meals: d.planned_meals.map((m) => ({
              title: m.dish_name,
              calories: m.calories_kcal,
            })),
          }))}
        />
      )}

      {/* フローティング AI アシスタントボタン */}
      <Pressable
        testID="weekly-ai-assistant-btn"
        onPress={() => setShowV4Modal(true)}
        style={({ pressed }) => ({
          position: "absolute",
          bottom: spacing["2xl"],
          right: spacing.lg,
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
          ...shadows.md,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Ionicons name="sparkles" size={24} color="#fff" />
      </Pressable>

      {/* 人数設定モーダル */}
      <ServingsModal
        visible={showServingsModal}
        onClose={() => setShowServingsModal(false)}
      />

      {/* レシピ詳細モーダル */}
      <RecipeModal
        visible={recipeModalMeal !== null}
        meal={recipeModalMeal}
        onClose={() => setRecipeModalMeal(null)}
      />
      <RegenerateMealModal
        visible={showRegenerateModal}
        meal={selectedMealForRegen}
        onClose={() => {
          setShowRegenerateModal(false);
          setSelectedMealForRegen(null);
        }}
      />

      {/* 冷蔵庫モーダル (PR 2-4) */}
      <PantryModal
        visible={activeModal === 'fridge'}
        onClose={() => setActiveModal(null)}
      />
    </SafeAreaView>
  );
}
