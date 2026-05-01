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
import Svg, { Circle, Line, Polygon, Text as SvgText } from "react-native-svg";

import { Button, Card, EmptyState, LoadingState, PageHeader, StatusBadge } from "../../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";
import { supabase } from "../../../src/lib/supabase";
import { useProfile } from "../../../src/providers/ProfileProvider";
import type { WeekStartDay } from "../../../src/providers/ProfileProvider";

type PlannedMealRow = {
  id: string;
  meal_type: string;
  dish_name: string;
  mode: string | null;
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
// Nutrition Constants (DRI — mirrors lib/nutrition-constants.ts)
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

interface NutrientDef {
  key: keyof DayNutritionTotals;
  label: string;
  unit: string;
  dri: number;
  decimals: number;
}

const NUTRIENT_DEFS: NutrientDef[] = [
  { key: "caloriesKcal", label: "エネルギー",   unit: "kcal", dri: 2000, decimals: 0 },
  { key: "proteinG",     label: "タンパク質",   unit: "g",    dri: 60,    decimals: 1 },
  { key: "fatG",         label: "脂質",         unit: "g",    dri: 55,    decimals: 1 },
  { key: "carbsG",       label: "炭水化物",     unit: "g",    dri: 300,   decimals: 1 },
  { key: "fiberG",       label: "食物繊維",     unit: "g",    dri: 21,    decimals: 1 },
  { key: "sugarG",       label: "糖質",         unit: "g",    dri: 250,   decimals: 1 },
  { key: "sodiumG",      label: "塩分",         unit: "g",    dri: 7.5,   decimals: 1 },
  { key: "potassiumMg",  label: "カリウム",     unit: "mg",   dri: 2500,  decimals: 0 },
  { key: "calciumMg",    label: "カルシウム",   unit: "mg",   dri: 700,   decimals: 0 },
  { key: "magnesiumMg",  label: "マグネシウム", unit: "mg",   dri: 340,   decimals: 0 },
  { key: "ironMg",       label: "鉄分",         unit: "mg",   dri: 7.5,   decimals: 1 },
  { key: "zincMg",       label: "亜鉛",         unit: "mg",   dri: 10,    decimals: 1 },
  { key: "vitaminAUg",   label: "ビタミンA",   unit: "µg",   dri: 850,   decimals: 0 },
  { key: "vitaminB1Mg",  label: "ビタミンB1",  unit: "mg",   dri: 1.3,   decimals: 2 },
  { key: "vitaminB2Mg",  label: "ビタミンB2",  unit: "mg",   dri: 1.5,   decimals: 2 },
  { key: "vitaminCMg",   label: "ビタミンC",   unit: "mg",   dri: 100,   decimals: 0 },
  { key: "vitaminDUg",   label: "ビタミンD",   unit: "µg",   dri: 8.5,   decimals: 1 },
  { key: "vitaminEMg",   label: "ビタミンE",   unit: "mg",   dri: 6.5,   decimals: 1 },
];

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
        <Polygon points={refPolygon} fill="none" stroke="#B0B0B0" strokeWidth={1} strokeDasharray="3 3" />
        {spokes.map((p, i) => (
          <Line key={`s${i}`} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#E8E8E8" strokeWidth={1} />
        ))}
        <Polygon points={dataPolygon} fill="rgba(224,122,95,0.25)" stroke={colors.accent} strokeWidth={2} />
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
      <View style={{ backgroundColor: colors.bg, borderTopLeftRadius: radius["2xl"], borderTopRightRadius: radius["2xl"], maxHeight: "85%", ...shadows.lg }}>
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="bar-chart" size={18} color={colors.accent} />
            <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{dateLabel} の栄養分析</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={8}>
            <Ionicons name="close" size={22} color={colors.textMuted} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          {/* Radar Chart */}
          <View style={{ alignItems: "center" }}>
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
                const value = totals[def.key] as number;
                const pct = driPercent(def.key, value);
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

// AI生成進捗フェーズ定義（Webの PROGRESS_PHASES / ULTIMATE_PROGRESS_PHASES に準拠）
const PROGRESS_PHASES = [
  { phase: "user_context", label: "ユーザー情報を取得", threshold: 5 },
  { phase: "search_references", label: "参考レシピを検索", threshold: 10 },
  { phase: "generating", label: "献立をAIが作成", threshold: 15 },
  { phase: "step1_complete", label: "献立生成完了", threshold: 40 },
  { phase: "reviewing", label: "献立のバランスをチェック", threshold: 45 },
  { phase: "review_done", label: "改善点を発見", threshold: 55 },
  { phase: "fixing", label: "改善点を修正", threshold: 60 },
  { phase: "no_issues", label: "問題なし", threshold: 70 },
  { phase: "step2_complete", label: "レビュー完了", threshold: 75 },
  { phase: "calculating", label: "栄養価を計算", threshold: 80 },
  { phase: "saving", label: "献立を保存", threshold: 88 },
  { phase: "completed", label: "完了！", threshold: 100 },
];

const ULTIMATE_PROGRESS_PHASES = [
  { phase: "user_context", label: "ユーザー情報を取得", threshold: 3 },
  { phase: "search_references", label: "参考レシピを検索", threshold: 6 },
  { phase: "generating", label: "献立をAIが作成", threshold: 10 },
  { phase: "step1_complete", label: "献立生成完了", threshold: 25 },
  { phase: "reviewing", label: "献立のバランスをチェック", threshold: 28 },
  { phase: "fixing", label: "改善点を修正", threshold: 32 },
  { phase: "step2_complete", label: "レビュー完了", threshold: 38 },
  { phase: "calculating", label: "栄養価を計算", threshold: 42 },
  { phase: "step3_complete", label: "栄養計算完了", threshold: 48 },
  { phase: "nutrition_analyzing", label: "栄養バランスを詳細分析", threshold: 55 },
  { phase: "nutrition_feedback", label: "改善アドバイスを生成", threshold: 62 },
  { phase: "improving", label: "献立を改善中", threshold: 70 },
  { phase: "step5_complete", label: "改善完了", threshold: 82 },
  { phase: "final_saving", label: "最終保存中", threshold: 90 },
  { phase: "completed", label: "究極の献立が完成！", threshold: 100 },
];

type PhaseDefinition = { phase: string; label: string; threshold: number };

type ProgressTodoCardProps = {
  progress: PendingProgress | null;
  phases?: PhaseDefinition[];
  defaultMessage?: string;
};

function ProgressTodoCard({ progress, phases = PROGRESS_PHASES, defaultMessage = "AIが献立を生成中..." }: ProgressTodoCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const currentPercentage = progress?.percentage ?? 0;
  const currentPhase = progress?.phase ?? "";
  const totalSlots = progress?.totalSlots ?? 0;
  const totalDays = totalSlots > 0 ? Math.ceil(totalSlots / 3) : 0;

  const dynamicPhases = useMemo(() => {
    return phases.map((p) => {
      if (p.phase === "generating" && totalDays > 0) {
        const dayLabel = totalDays === 1 ? "1日分" : `${totalDays}日分`;
        return { ...p, label: `${dayLabel}の献立をAIが作成` };
      }
      return p;
    });
  }, [phases, totalDays]);

  const getPhaseStatus = (phase: PhaseDefinition): "completed" | "in_progress" | "pending" => {
    if (currentPercentage >= phase.threshold) return "completed";
    if (
      currentPhase === phase.phase ||
      (currentPhase.startsWith(phase.phase.split("_")[0]) && currentPercentage < phase.threshold)
    )
      return "in_progress";
    return "pending";
  };

  const isError = currentPhase === "failed";

  const headerMessage =
    totalDays > 0
      ? `献立を生成中...（${progress?.completedSlots ?? 0}/${totalSlots}食、${totalDays}日分）`
      : (progress?.message ?? defaultMessage);

  return (
    <LinearGradient
      colors={
        isError
          ? ["#ef4444", "#dc2626"]
          : [colors.accent, colors.purple]
      }
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{
        borderRadius: radius.lg,
        overflow: "hidden",
      }}
    >
      {/* ヘッダー */}
      <Pressable
        onPress={() => setIsExpanded((prev) => !prev)}
        style={{ padding: spacing.md, gap: spacing.sm }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <ActivityIndicator size="small" color="#fff" />
          <Text style={{ flex: 1, color: "#fff", fontWeight: "700", fontSize: 13 }}>
            {headerMessage}
          </Text>
          {currentPercentage > 0 && (
            <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}>{currentPercentage}%</Text>
          )}
          <Ionicons
            name={isExpanded ? "chevron-up" : "chevron-down"}
            size={14}
            color="rgba(255,255,255,0.7)"
          />
        </View>
        {currentPercentage > 0 && (
          <View style={{ height: 6, backgroundColor: "rgba(255,255,255,0.2)", borderRadius: 3, overflow: "hidden" }}>
            <View
              style={{
                width: `${currentPercentage}%`,
                height: "100%",
                backgroundColor: "#fff",
                borderRadius: 3,
              }}
            />
          </View>
        )}
      </Pressable>

      {/* 展開時のフェーズToDoリスト */}
      {isExpanded && (
        <View
          style={{
            paddingHorizontal: spacing.md,
            paddingBottom: spacing.md,
            paddingTop: spacing.sm,
            borderTopWidth: 1,
            borderTopColor: "rgba(255,255,255,0.2)",
            gap: spacing.sm,
          }}
        >
          {dynamicPhases.filter((p) => p.phase !== "failed").map((phase) => {
            const status = getPhaseStatus(phase);
            return (
              <View key={phase.phase} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                {status === "completed" ? (
                  <View
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 8,
                      backgroundColor: "#fff",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Ionicons name="checkmark" size={10} color={colors.accent} />
                  </View>
                ) : status === "in_progress" ? (
                  <ActivityIndicator size="small" color="#fff" style={{ width: 16, height: 16 }} />
                ) : (
                  <View
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 8,
                      borderWidth: 2,
                      borderColor: "rgba(255,255,255,0.4)",
                    }}
                  />
                )}
                <Text
                  style={{
                    fontSize: 11,
                    color: status === "pending" ? "rgba(255,255,255,0.5)" : "#fff",
                    fontWeight: status === "in_progress" ? "600" : "400",
                  }}
                >
                  {phase.label}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </LinearGradient>
  );
}

const DOW = ["月", "火", "水", "木", "金", "土", "日"];

const MEAL_ORDER = ["breakfast", "lunch", "snack", "dinner", "midnight_snack"] as const;

const MEAL_CONFIG: Record<string, { icon: keyof typeof Ionicons.glyphMap; label: string; color: string }> = {
  breakfast: { icon: "sunny", label: "朝食", color: "#FF9800" },
  lunch: { icon: "partly-sunny", label: "昼食", color: "#4CAF50" },
  snack: { icon: "cafe", label: "おやつ", color: "#E91E63" },
  dinner: { icon: "moon", label: "夕食", color: "#7C4DFF" },
  midnight_snack: { icon: "cloudy-night", label: "夜食", color: "#3F51B5" },
};

const MODE_CONFIG: Record<string, { icon?: string; label: string; color: string; bg: string }> = {
  cook: { label: "自炊", color: colors.success, bg: colors.successLight },
  quick: { label: "時短", color: colors.blue, bg: colors.blueLight },
  buy: { label: "買う", color: colors.purple, bg: colors.purpleLight },
  out: { label: "外食", color: colors.warning, bg: colors.warningLight },
  skip: { label: "なし", color: colors.textMuted, bg: colors.bg },
  ai_creative: { icon: "sparkles", label: "AI献立", color: colors.accent, bg: colors.accentLight },
};

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
      const { error: supaErr } = await supabase
        .from("planned_meals")
        .update({ is_completed: newCompleted })
        .eq("id", mealId);
      if (supaErr) throw supaErr;
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
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <PageHeader title="週間献立" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
      {/* ヘッダー: 週ナビゲーション */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Pressable
          onPress={() => shiftWeek(-1)}
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.md,
            backgroundColor: colors.card,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: colors.border,
            ...shadows.sm,
          }}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </Pressable>
        <View style={{ alignItems: "center" }}>
          <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>
            {weekStartStr.slice(5)} 〜 {weekEndStr.slice(5)}
          </Text>
          {plan && <Text style={{ fontSize: 12, color: colors.textMuted }}>{plan.title}</Text>}
        </View>
        <Pressable
          onPress={() => shiftWeek(1)}
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.md,
            backgroundColor: colors.card,
            alignItems: "center",
            justifyContent: "center",
            borderWidth: 1,
            borderColor: colors.border,
            ...shadows.sm,
          }}
        >
          <Ionicons name="chevron-forward" size={20} color={colors.text} />
        </Pressable>
      </View>

      {/* 月カレンダー展開バー */}
      <Pressable
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
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ flex: 1, color: colors.error, fontSize: 13 }}>{error}</Text>
          </View>
          <Button size="sm" variant="ghost" onPress={() => { setError(null); loadData(); }}>再読み込み</Button>
        </Card>
      ) : !plan ? (
        <View style={{ gap: spacing.lg, paddingTop: spacing["3xl"] }}>
          <EmptyState
            icon={<Ionicons name="restaurant-outline" size={48} color={colors.textMuted} />}
            message="この週の献立がまだありません"
          />
          <Button onPress={() => router.push("/menus/weekly/request")}>
            AIで週間献立を作成
          </Button>
        </View>
      ) : (
        <>
          {/* AI生成中プログレス */}
          {pendingRequestId && (
            <ProgressTodoCard
              progress={pendingProgress}
              phases={pendingIsUltimate ? ULTIMATE_PROGRESS_PHASES : PROGRESS_PHASES}
              defaultMessage={pendingIsUltimate ? "究極モードで献立を生成中..." : "AIが献立を生成中..."}
            />
          )}

          {/* 日付セレクタ — 横並び丸型ピル */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
            {days.map((d) => {
              const selected = d.day_date === selectedDate;
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
                  onPress={() => setSelectedDate(d.day_date)}
                  style={({ pressed }) => ({
                    alignItems: "center",
                    gap: 4,
                    paddingVertical: spacing.sm,
                    paddingHorizontal: spacing.md,
                    borderRadius: radius.lg,
                    backgroundColor: selected ? (accentColor ?? colors.accent) : colors.card,
                    borderWidth: 1,
                    borderColor: selected ? (accentColor ?? colors.accent) : (accentColor ? `${accentColor}33` : colors.border),
                    minWidth: 48,
                    ...shadows.sm,
                    ...(pressed ? { opacity: 0.9 } : {}),
                  })}
                >
                  <Text style={{ fontSize: 11, fontWeight: "600", color: selected ? "#fff" : (accentColor ?? colors.textMuted) }}>{dow}</Text>
                  <Text style={{ fontSize: 16, fontWeight: "800", color: selected ? "#fff" : (accentColor ?? colors.text) }}>{dayNum}</Text>
                  {completedAll ? (
                    <Ionicons name="checkmark-circle" size={14} color={selected ? "#fff" : colors.success} />
                  ) : hasGenerating ? (
                    <ActivityIndicator size={12} color={selected ? "#fff" : (accentColor ?? colors.accent)} />
                  ) : (
                    <Text style={{ fontSize: 10, color: selected ? "rgba(255,255,255,0.7)" : colors.textMuted }}>
                      {d.planned_meals.length}食
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>

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
                <Button size="sm" variant="ghost" onPress={() => router.push("/menus/weekly/request")}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <Ionicons name="sparkles" size={14} color={colors.accent} />
                    <Text style={{ fontSize: 12, fontWeight: "600", color: colors.accent }}>AIで再生成</Text>
                  </View>
                </Button>
              </View>
            </View>
          )}

          {/* 食事一覧 */}
          {sortedMeals.length > 0 ? (
            <View style={{ gap: spacing.md }}>
              {sortedMeals.map((m) => {
                const mealCfg = MEAL_CONFIG[m.meal_type] ?? { icon: "ellipse", label: m.meal_type, color: colors.textMuted };
                const modeCfg = MODE_CONFIG[m.mode ?? "cook"] ?? MODE_CONFIG.cook;
                const isGenerating = m.is_generating;
                return (
                  <Pressable
                    key={m.id}
                    onPress={() => toggleMealCompletion(m.id, m.is_completed)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: spacing.md,
                      padding: spacing.lg,
                      backgroundColor: m.is_completed ? colors.successLight : isGenerating ? colors.accentLight : colors.card,
                      borderRadius: radius.lg,
                      borderWidth: 1,
                      borderColor: m.is_completed ? "#C8E6C9" : isGenerating ? "#FED7AA" : colors.border,
                      ...shadows.sm,
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
                      <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }} numberOfLines={1}>
                        {isGenerating ? "生成中..." : m.dish_name || "（未設定）"}
                      </Text>
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
                          <Text style={{ fontSize: 12, color: colors.textMuted }}>{m.calories_kcal} kcal</Text>
                        ) : null}
                      </View>
                    </View>

                    {/* ステータス & アクション */}
                    <View style={{ alignItems: "center", gap: 4 }}>
                      {m.is_completed ? (
                        <StatusBadge variant="completed" label="完了" />
                      ) : isGenerating ? (
                        <StatusBadge variant="generating" label="生成中" />
                      ) : (
                        <Ionicons name="checkmark-circle-outline" size={22} color={colors.textMuted} />
                      )}
                    </View>
                  </Pressable>
                );
              })}

              {/* アクションボタン行 */}
              {selectedDay && (
                <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
                  {sortedMeals.map((m) => {
                    const mealCfg = MEAL_CONFIG[m.meal_type] ?? { label: m.meal_type };
                    return (
                      <View key={m.id} style={{ flexDirection: "row", gap: 4 }}>
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
                          <Text style={{ fontSize: 11, color: colors.textLight }}>{mealCfg.label}</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => regenerateMeal(m.id, m.meal_type)}
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
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          ) : (
            <EmptyState
              icon={<Ionicons name="restaurant-outline" size={40} color={colors.textMuted} />}
              message="この日の食事がありません"
            />
          )}
        </>
      )}
      </ScrollView>

      {/* 栄養分析ボトムシート */}
      <NutritionBottomSheet
        visible={nutritionSheetDay !== null}
        onClose={() => setNutritionSheetDay(null)}
        day={nutritionSheetDay}
        dateLabel={nutritionSheetLabel}
        radarKeys={radarChartNutrients}
        weekDays={days}
      />
    </View>
  );
}
