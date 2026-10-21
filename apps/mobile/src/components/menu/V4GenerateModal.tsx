import { Ionicons } from "@expo/vector-icons";
import {
  addDaysToDate,
  isCalendarDate,
  menuGenerationRangeEndMax,
  menuGenerationRangeStartMax,
  menuGenerationSingleDayMax,
  todayLocal,
} from "@homegohan/shared";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  View,
} from "react-native";
import { Text, TextInput } from "../ui/Text";

import { ConditionPills } from "./ConditionPills";
import { UltimateModeToggle } from "./UltimateModeToggle";

import type { MenuGenerationConstraints, TargetSlot } from "../../../../../types/domain";
import {
  buildAiOnlySlots,
  buildEmptySlots,
  buildRangeSlots,
  buildSingleDaySlots,
  countAiSlots,
  countEmptySlots,
  validateSlotCount,
  type MealDay,
} from "../../../../../lib/slot-builder";
import { MOCK_MENU_RESPONSE } from "@homegohan/handson-tour-shared";
import { getApi } from "../../lib/api";
import { fetchBillingSummary } from "../../lib/billing-api";
import { colors, radius, shadows, spacing } from "../../theme";

// ============================================================
// Types
// ============================================================

type GenerateMode = "single_day" | "empty" | "ai_only" | "range";

export interface V4GenerateParams {
  targetSlots: TargetSlot[];
  resolveExistingMeals: boolean;
  constraints: MenuGenerationConstraints;
  note: string;
  /** 究極モード (AIが献立を見直して栄養バランスを改善)。全員が使える (#1142) */
  ultimateMode: boolean;
}

// ── Sandbox props (discriminated union) ──────────────────────
export interface V4GenerateModalSandboxProps {
  mode: "sandbox";
  visible: boolean;
  onClose: () => void;
  initialFlags?: {
    useFridgeFirst?: boolean;
    quickMeals?: boolean;
    japaneseStyle?: boolean;
    healthy?: boolean;
  };
  prefilled?: typeof MOCK_MENU_RESPONSE;
  loadingDurationMs?: number;
  apiOptions?: { source: "handson_tour"; sandbox: true };
  onSandboxComplete?: (result: typeof MOCK_MENU_RESPONSE) => void;
  // Normal-mode props not needed in sandbox — provide dummies for type compat
  mealPlanDays?: DayRow[];
  weekStartDate?: string;
  weekEndDate?: string;
  isGenerating?: boolean;
  onGenerate?: (params: V4GenerateParams) => Promise<void>;
}

// ── Normal props ─────────────────────────────────────────────
export interface V4GenerateModalNormalProps {
  mode?: "normal" | undefined;
  visible: boolean;
  onClose: () => void;
  onGenerate: (params: V4GenerateParams) => Promise<void>;
  mealPlanDays: DayRow[];
  weekStartDate: string;
  weekEndDate: string;
  isGenerating: boolean;
}

export type V4GenerateModalProps = V4GenerateModalSandboxProps | V4GenerateModalNormalProps;

// DayRow は weekly/index.tsx と同じ型構造に対応
interface DayRow {
  id: string;
  day_date: string;
  planned_meals: {
    id: string;
    meal_type: string;
    dish_name: string;
    mode: string | null;
    calories_kcal: number | null;
    is_completed: boolean | null;
    is_generating: boolean | null;
    display_order?: number | null;
  }[];
}

// LocalStorage key (mealPlanDays の MealDay インターフェースに変換するためのキー)
const STORAGE_KEY_RANGE_DAYS = "v4_range_days";

// ============================================================
// DayRow → MealDay 変換ヘルパー (slot-builder は MealDay を期待)
// ============================================================
function toMealDays(days: DayRow[]): MealDay[] {
  return days.map((d) => ({
    dayDate: d.day_date,
    meals: d.planned_meals.map((m) => ({
      id: m.id,
      mealType: m.meal_type as any,
      dishName: m.dish_name,
      mode: m.mode ?? undefined,
      caloriesKcal: m.calories_kcal ?? undefined,
      isCompleted: m.is_completed ?? false,
      isGenerating: m.is_generating ?? false,
      displayOrder: m.display_order ?? undefined,
    })),
  }));
}

// ============================================================
// Date helpers
// ============================================================
/** 日本の今日 (YYYY-MM-DD)。端末のタイムゾーンに左右されない (#1049 F7-21) */
function getTodayStr(): string {
  return todayLocal();
}

// 暦日 (YYYY-MM-DD) を days 日ずらす。暦の計算だけで行い、端末のタイムゾーンに左右されない (#1433。
// 以前の new Date(dateStr) + setDate (ローカル時刻) + toISOString (UTC) は、端末のタイムゾーンや夏時間で結果が変わった)
function addDays(dateStr: string, days: number): string {
  return addDaysToDate(dateStr, days);
}

/** 日付 value を下限 min・上限 max (無ければ上限なし) に収める。YYYY-MM-DD どうしは文字列の大小が日付の前後と同じ (Web の V4GenerateModal と同じ) */
function clampDay(value: string, min: string, max: string | undefined): string {
  if (value < min) return min;
  return max !== undefined && value > max ? max : value;
}

/** 「期間を指定」の確定した期間 (どちらも YYYY-MM-DD の実在する日付) */
export interface GenerateRange {
  start: string;
  end: string;
}

/**
 * 「期間を指定」の開始日の欄を確定する (欄を離れたとき・生成を押したとき。#1498)。
 * 打つたびには直さない (以前は打つたびに直していたので、途中の入力 2026-10-1 などが今日に戻され、手で打ちにくかった)。
 * text が日付になっていなければ、確定していた期間 current のまま (欄の文字も戻す)。
 * 日付なら、過去は今日に・上限 (今日から 1 ヶ月先) より先は上限に直し、終了日を新しい開始日から最大31日の中に収める
 */
export function commitRangeStartInput(text: string, current: GenerateRange, today: string): GenerateRange {
  const value = text.trim();
  if (!isCalendarDate(value)) return current;
  const start = clampDay(value, today, menuGenerationRangeStartMax(today));
  return { start, end: clampDay(current.end, start, menuGenerationRangeEndMax(start)) };
}

/**
 * 「期間を指定」の終了日の欄を確定する (欄を離れたとき・生成を押したとき。#1498)。
 * text が日付になっていなければ、確定していた期間 current のまま。
 * 日付なら、過去は今日に・開始日を含む最大31日より先は上限に直す。開始日より前なら開始日をそこに合わせる
 */
export function commitRangeEndInput(text: string, current: GenerateRange, today: string): GenerateRange {
  const value = text.trim();
  if (!isCalendarDate(value)) return current;
  const end = clampDay(value, today, menuGenerationRangeEndMax(current.start));
  return { start: end < current.start ? end : current.start, end };
}

/**
 * 「1日だけ」の日付の欄を確定する (欄を離れたとき・生成を押したとき。#1498)。
 * text が日付になっていなければ、確定していた日付 current のまま。日付なら、過去は今日に直し (以前と同じ下限)、
 * 上限 (今日から 1 ヶ月先。画面の説明「今日から1ヶ月先まで」。Web の日付の欄の max と同じ共有の値) より先は上限に直す (#1524)
 */
export function commitSingleDayInput(text: string, current: string, today: string): string {
  const value = text.trim();
  if (!isCalendarDate(value)) return current;
  return clampDay(value, today, menuGenerationSingleDayMax(today));
}

function daysBetween(startStr: string, endStr: string): number {
  const start = new Date(startStr);
  const end = new Date(endStr);
  return Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDateJp(dateStr: string): string {
  const [, m, d] = dateStr.split("-");
  return `${parseInt(m)}月${parseInt(d)}日`;
}

// ============================================================
// Color constants aligned with WEB design
// ============================================================
const C = {
  bg: "#F7F6F3",
  card: "#FFFFFF",
  text: "#2D2D2D",
  textLight: "#6B6B6B",
  textMuted: "#A0A0A0",
  accent: "#E07A5F",
  accentLight: "#FDF0ED",
  success: "#6B9B6B",
  successLight: "#EDF5ED",
  warning: "#E5A84B",
  warningLight: "#FEF9EE",
  purple: "#7C6BA0",
  purpleLight: "#F5F3F8",
  border: "#E8E8E8",
} as const;

// ============================================================
// Component
// ============================================================

export function V4GenerateModal(props: V4GenerateModalProps) {
  // ── Sandbox mode ────────────────────────────────────────────
  if (props.mode === "sandbox") {
    return <V4GenerateModalSandbox {...props} />;
  }

  // ── Normal mode ─────────────────────────────────────────────
  return <V4GenerateModalNormal {...props} />;
}

// ============================================================
// Sandbox implementation
// ============================================================
function V4GenerateModalSandbox({
  visible,
  onClose,
  prefilled = MOCK_MENU_RESPONSE,
  loadingDurationMs = 2000,
  apiOptions = { source: "handson_tour", sandbox: true },
  onSandboxComplete,
}: V4GenerateModalSandboxProps) {
  const [isSandboxLoading, setIsSandboxLoading] = useState(false);
  const [sandboxDone, setSandboxDone] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset when modal opens
  useEffect(() => {
    if (visible) {
      setSandboxDone(false);
      setIsSandboxLoading(false);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [visible]);

  const handleSandboxGenerate = async () => {
    if (isSandboxLoading || sandboxDone) return;
    setIsSandboxLoading(true);
    timerRef.current = setTimeout(async () => {
      try {
        const api = getApi();
        await api.post("/api/menu-plans/add", {
          ...prefilled,
          ...apiOptions,
        });
      } catch {
        // sandbox errors are ignored — mock flow must complete
      }
      setSandboxDone(true);
      setIsSandboxLoading(false);
      onSandboxComplete?.(prefilled);
    }, loadingDurationMs);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      testID="v4-modal-sandbox"
    >
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: C.bg }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            backgroundColor: C.card,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="sparkles" size={20} color={C.accent} />
            <Text style={{ fontSize: 17, fontWeight: "700", color: C.text }}>
              AI献立アシスタント
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: C.bg,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="close" size={18} color={C.textLight} />
          </Pressable>
        </View>

        {/* Sandbox content */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
        >
          {/* Preview card */}
          <View
            style={{
              padding: spacing.lg,
              borderRadius: radius.xl,
              backgroundColor: C.accentLight,
              borderWidth: 1,
              borderColor: C.accent,
              gap: spacing.sm,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="restaurant" size={18} color={C.accent} />
              <Text style={{ fontSize: 15, fontWeight: "700", color: C.text }}>
                {prefilled.dish_name}
              </Text>
            </View>
            <Text style={{ fontSize: 13, color: C.textLight }}>
              {prefilled.calories} kcal · 調理時間 {prefilled.cooking_time_minutes} 分 · {prefilled.servings} 人分
            </Text>
            <Text style={{ fontSize: 12, color: C.textMuted }}>
              ※ チュートリアル用のサンプル献立です
            </Text>
          </View>

          {sandboxDone ? (
            <View style={{ alignItems: "center", gap: spacing.md, paddingVertical: spacing.xl }}>
              <Ionicons name="checkmark-circle" size={48} color={C.success} />
              <Text style={{ fontSize: 16, fontWeight: "700", color: C.success }}>
                献立を追加しました！
              </Text>
            </View>
          ) : (
            <Pressable
              testID="v4-sandbox-submit-btn"
              onPress={handleSandboxGenerate}
              disabled={isSandboxLoading}
              style={({ pressed }) => ({
                paddingVertical: spacing.lg,
                borderRadius: radius.xl,
                backgroundColor: isSandboxLoading ? C.purple : C.accent,
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "row",
                gap: spacing.sm,
                opacity: isSandboxLoading ? 0.85 : pressed ? 0.9 : 1,
              })}
            >
              {isSandboxLoading ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={{ fontSize: 16, fontWeight: "700", color: "#fff" }}>
                    献立を作成中...
                  </Text>
                </>
              ) : (
                <>
                  <Ionicons name="sparkles" size={18} color="#fff" />
                  <Text style={{ fontSize: 16, fontWeight: "700", color: "#fff" }}>
                    この献立を追加する
                  </Text>
                </>
              )}
            </Pressable>
          )}

          <View style={{ height: spacing.xl }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ============================================================
// Normal implementation (original logic, extracted)
// ============================================================
function V4GenerateModalNormal({
  visible,
  onClose,
  onGenerate,
  mealPlanDays,
  weekStartDate,
  weekEndDate,
  isGenerating,
}: V4GenerateModalNormalProps) {
  const todayStr = useMemo(() => getTodayStr(), []);

  const [selectedMode, setSelectedMode] = useState<GenerateMode | null>(null);
  // 確定した期間 (生成と保存に使う)。入力欄の文字は rangeStartText / rangeEndText に別に持ち、
  // 欄を離れたとき (onBlur・キーボードの確定) と生成を押したときに、上限・下限をかけてここへ入れる (#1498)
  const [rangeStart, setRangeStart] = useState(weekStartDate);
  const [rangeEnd, setRangeEnd] = useState(weekEndDate);
  const [rangeStartText, setRangeStartText] = useState(weekStartDate);
  const [rangeEndText, setRangeEndText] = useState(weekEndDate);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [singleDayDate, setSingleDayDate] = useState(todayStr);
  const [singleDayText, setSingleDayText] = useState(todayStr);

  /** 確定した期間を入れ、入力欄の文字もそれに合わせる */
  const applyRange = useCallback((range: GenerateRange) => {
    setRangeStart(range.start);
    setRangeEnd(range.end);
    setRangeStartText(range.start);
    setRangeEndText(range.end);
  }, []);

  /** 確定した「1日だけ」の日付を入れ、入力欄の文字もそれに合わせる */
  const applySingleDay = useCallback((date: string) => {
    setSingleDayDate(date);
    setSingleDayText(date);
  }, []);

  const [constraints, setConstraints] = useState<MenuGenerationConstraints>({
    useFridgeFirst: false,
    quickMeals: false,
    japaneseStyle: false,
    healthy: false,
  });

  const [note, setNote] = useState("");
  // 究極モード。通常より時間がかかるため既定は OFF にし、モーダルを開くたびに OFF に戻す (WEB と同じ)
  const [ultimateMode, setUltimateMode] = useState(false);
  // 究極モードの錠 (billing/03 §10.6)。いまのプランの究極モードの 1 日の上限が 0 (使えない) のとき true
  const [ultimateLocked, setUltimateLocked] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // モーダルが開くたびに状態をリセット
  useEffect(() => {
    if (visible) {
      setIsSubmitting(false);
      setIncludeExisting(false); // 破壊的フラグは毎回リセット
      setUltimateMode(false);
    }
  }, [visible]);

  // モーダルが開くたびに契約の要約を 1 回読み、究極モードを使えないプランなら錠を出す (billing/03 §10.6)。
  // 読めなければ錠を出さない (サーバの 403 AI_FEATURE_NOT_IN_PLAN が最後の砦)
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setUltimateLocked(false);
    fetchBillingSummary()
      .then((summary) => {
        if (cancelled) return;
        const locked = summary.features.ai_feature_caps.menu_generation_ultimate === 0;
        setUltimateLocked(locked);
        // 読み込みの前に ON にしていても、錠のときは OFF に戻す (使えないプランで究極モードを送らない)
        if (locked) setUltimateMode(false);
      })
      .catch(() => {
        if (!cancelled) setUltimateLocked(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  // AsyncStorage から range 設定を復元
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY_RANGE_DAYS);
        if (saved) {
          const { startDays, endDays } = JSON.parse(saved);
          // 今日を基準に日付を計算し、選べる範囲 (開始日は今日〜1ヶ月先・期間は最大31日) に収める (#1482。Web と同じ)
          const newStart = clampDay(addDays(todayStr, startDays), todayStr, menuGenerationRangeStartMax(todayStr));
          const newEnd = clampDay(addDays(todayStr, endDays), newStart, menuGenerationRangeEndMax(newStart));
          applyRange({ start: newStart, end: newEnd });
          return;
        }
      } catch {
        // パースエラーはデフォルトにフォールバック
      }
      // 表示中の週が先の週でも、期間の上限 (開始日を含む最大31日) に収める (#1482)
      applyRange({
        start: todayStr,
        end: clampDay(weekEndDate >= todayStr ? weekEndDate : addDays(todayStr, 6), todayStr, menuGenerationRangeEndMax(todayStr)),
      });
    })();
  }, [visible, todayStr, weekEndDate, applyRange]);

  // range 変更時に AsyncStorage に保存
  useEffect(() => {
    if (!rangeStart || !rangeEnd) return;
    const startDays = daysBetween(todayStr, rangeStart);
    const endDays = daysBetween(todayStr, rangeEnd);
    AsyncStorage.setItem(
      STORAGE_KEY_RANGE_DAYS,
      JSON.stringify({ startDays, endDays })
    ).catch(() => {});
  }, [rangeStart, rangeEnd, todayStr]);

  // 期間の入力欄の上限 (#1482。Web の V4GenerateModal (#1463) と同じ)。開始日は今日から 1 ヶ月先まで、
  // 終了日は開始日を含む最大31日の最後の日まで。値は @homegohan/shared の menu-generation-range でサーバーと共有する。
  // 入力欄は自由入力なので、確定したとき (欄を離れたとき・キーボードの確定・生成を押したとき) に、過去の日付は今日に、
  // 上限より先の日付は上限に直す (#1498。以前は打つたびに直していたので、途中の入力 2026-10-1 などが今日に戻された)。
  // 開始日が終了日より後になった場合は終了日を開始日に合わせ、終了日が期間の上限を超えたら上限に縮める
  const handleCommitRangeStart = useCallback(() => {
    applyRange(commitRangeStartInput(rangeStartText, { start: rangeStart, end: rangeEnd }, todayStr));
  }, [applyRange, rangeStartText, rangeStart, rangeEnd, todayStr]);

  const handleCommitRangeEnd = useCallback(() => {
    applyRange(commitRangeEndInput(rangeEndText, { start: rangeStart, end: rangeEnd }, todayStr));
  }, [applyRange, rangeEndText, rangeStart, rangeEnd, todayStr]);

  const handleCommitSingleDay = useCallback(() => {
    applySingleDay(commitSingleDayInput(singleDayText, singleDayDate, todayStr));
  }, [applySingleDay, singleDayText, singleDayDate, todayStr]);

  const mealDays = useMemo(() => toMealDays(mealPlanDays), [mealPlanDays]);

  const effectiveStartDate = useMemo(
    () => (weekStartDate >= todayStr ? weekStartDate : todayStr),
    [weekStartDate, todayStr]
  );

  const emptySlotCount = useMemo(() => {
    if (effectiveStartDate > weekEndDate) return 0;
    return countEmptySlots({
      mealPlanDays: mealDays,
      startDate: effectiveStartDate,
      endDate: weekEndDate,
    });
  }, [mealDays, effectiveStartDate, weekEndDate]);

  const aiOnlySlotCount = useMemo(() => {
    if (effectiveStartDate > weekEndDate) return 0;
    return countAiSlots({
      mealPlanDays: mealDays,
      startDate: effectiveStartDate,
      endDate: weekEndDate,
    });
  }, [mealDays, effectiveStartDate, weekEndDate]);

  // range / singleDay は、確定したばかりの値 (state への反映を待たない) を渡すときに使う
  const buildTargetSlots = useCallback((
    range: GenerateRange = { start: rangeStart, end: rangeEnd },
    singleDay: string = singleDayDate
  ): TargetSlot[] => {
    switch (selectedMode) {
      case "empty":
        if (effectiveStartDate > weekEndDate) return [];
        return buildEmptySlots({
          mealPlanDays: mealDays,
          startDate: effectiveStartDate,
          endDate: weekEndDate,
        });
      case "ai_only":
        if (effectiveStartDate > weekEndDate) return [];
        return buildAiOnlySlots({
          mealPlanDays: mealDays,
          startDate: effectiveStartDate,
          endDate: weekEndDate,
        });
      case "range":
        return buildRangeSlots({
          mealPlanDays: mealDays,
          startDate: range.start,
          endDate: range.end,
          includeExisting,
        });
      case "single_day":
        return buildSingleDaySlots({
          date: singleDay,
          mealPlanDays: mealDays,
        });
      default:
        return [];
    }
  }, [
    selectedMode,
    mealDays,
    effectiveStartDate,
    weekEndDate,
    rangeStart,
    rangeEnd,
    includeExisting,
    singleDayDate,
  ]);

  const handleGenerate = async () => {
    if (isSubmitting || isGenerating) return;

    // 欄を離れずに押したとき (keyboardShouldPersistTaps="handled" なので、押しても欄は確定しない) も、打った値を確定してから使う (#1498)
    let range: GenerateRange = { start: rangeStart, end: rangeEnd };
    let singleDay = singleDayDate;
    if (selectedMode === "range") {
      // 打ち直した欄だけを確定する (打っていない欄まで確定し直すと、開始日を確定して縮めた終了日が、
      // 終了日の欄に残る前の値で戻され、開始日まで引き戻される)
      if (rangeStartText !== rangeStart) range = commitRangeStartInput(rangeStartText, range, todayStr);
      if (rangeEndText !== rangeEnd) range = commitRangeEndInput(rangeEndText, range, todayStr);
      applyRange(range);
    } else if (selectedMode === "single_day") {
      singleDay = commitSingleDayInput(singleDayText, singleDayDate, todayStr);
      applySingleDay(singleDay);
    }

    let slots: TargetSlot[];
    try {
      slots = buildTargetSlots(range, singleDay);
    } catch (error) {
      // 期間が上限 (最大31日) を超えると slot-builder が投げる。以前は捕まえず、押しても何も起きなかった (#1482)
      Alert.alert("エラー", error instanceof Error ? error.message : "期間が正しくありません");
      return;
    }
    const validation = validateSlotCount(slots);
    if (!validation.valid) {
      Alert.alert("エラー", validation.message ?? "スロットが無効です");
      return;
    }

    setIsSubmitting(true);
    try {
      await onGenerate({
        targetSlots: slots,
        resolveExistingMeals: includeExisting,
        constraints,
        note,
        ultimateMode,
      });
    } catch {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setSelectedMode(null);
    setIsSubmitting(false);
    setNote("");
    onClose();
  };

  // ============================================================
  // Mode definitions
  // ============================================================
  const modes: {
    id: GenerateMode;
    iconName: keyof typeof Ionicons.glyphMap;
    label: string;
    description: string;
    color: string;
    bg: string;
    disabled: boolean;
    testID: string;
  }[] = [
    {
      id: "single_day",
      iconName: "calendar",
      label: "1日献立変更",
      description: "選択した日の朝・昼・夜を作り直す",
      color: C.warning,
      bg: C.warningLight,
      disabled: false,
      testID: "v4-mode-single-day",
    },
    {
      id: "empty",
      iconName: "sparkles",
      label: "空欄を埋める",
      description: `既存の献立はそのまま、空いているところだけ（${emptySlotCount}件）`,
      color: C.accent,
      bg: C.accentLight,
      disabled: emptySlotCount === 0,
      testID: "v4-mode-empty",
    },
    {
      id: "ai_only",
      iconName: "refresh",
      label: "AI献立だけ変更",
      description: `手動設定の献立はそのまま、AI生成分のみ再生成（${aiOnlySlotCount}件）`,
      color: C.success,
      bg: C.successLight,
      disabled: aiOnlySlotCount === 0,
      testID: "v4-mode-ai-only",
    },
    {
      id: "range",
      iconName: "calendar-outline",
      label: "期間を指定",
      description: "開始〜終了を選んで生成（最大31日）",
      color: C.purple,
      bg: C.purpleLight,
      disabled: false,
      testID: "v4-mode-range",
    },
  ];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
      testID="v4-modal"
    >
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: C.bg }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
      >
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            backgroundColor: C.card,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="sparkles" size={20} color={C.accent} />
            <Text style={{ fontSize: 17, fontWeight: "700", color: C.text }}>
              AI献立アシスタント
            </Text>
          </View>
          <Pressable
            onPress={handleClose}
            hitSlop={8}
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: C.bg,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="close" size={18} color={C.textLight} />
          </Pressable>
        </View>

        {/* Scrollable content */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}
          keyboardShouldPersistTaps="handled"
        >
            {/* Mode label */}
            <Text style={{ fontSize: 13, fontWeight: "700", color: C.textLight }}>
              何を生成しますか？
            </Text>

            {/* Mode buttons */}
            <View style={{ gap: spacing.sm }}>
              {modes.map((mode) => {
                const isSelected = selectedMode === mode.id;
                return (
                  <Pressable
                    key={mode.id}
                    testID={mode.testID}
                    onPress={() => !mode.disabled && setSelectedMode(mode.id)}
                    disabled={mode.disabled}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: spacing.md,
                      padding: spacing.md,
                      borderRadius: radius.xl,
                      backgroundColor: isSelected ? mode.bg : C.bg,
                      borderWidth: 2,
                      borderColor: isSelected ? mode.color : "transparent",
                      opacity: mode.disabled ? 0.45 : pressed ? 0.85 : 1,
                    })}
                  >
                    <View
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 20,
                        backgroundColor: mode.bg,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ionicons name={mode.iconName} size={20} color={mode.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: "700", color: C.text }}>
                        {mode.label}
                      </Text>
                      <Text style={{ fontSize: 12, color: C.textLight, marginTop: 2 }}>
                        {mode.description}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={C.textMuted} />
                  </Pressable>
                );
              })}
            </View>

            {/* single_day: 日付ピッカー */}
            {selectedMode === "single_day" && (
              <View
                style={{
                  padding: spacing.md,
                  borderRadius: radius.xl,
                  backgroundColor: C.warningLight,
                  gap: spacing.sm,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "700", color: C.warning }}>
                  日付を選択
                </Text>
                <TextInput
                  testID="v4-date-picker-single"
                  value={singleDayText}
                  onChangeText={setSingleDayText}
                  onBlur={handleCommitSingleDay}
                  onSubmitEditing={handleCommitSingleDay}
                  placeholder="YYYY-MM-DD"
                  style={{
                    borderWidth: 1,
                    borderColor: C.border,
                    borderRadius: radius.lg,
                    padding: spacing.md,
                    fontSize: 16,
                    textAlign: "center",
                    backgroundColor: C.card,
                    color: C.text,
                  }}
                />
                <Text style={{ fontSize: 11, color: C.textLight, textAlign: "center" }}>
                  今日から1ヶ月先まで選択できます（{formatDateJp(singleDayDate)}）
                </Text>
              </View>
            )}

            {/* range: 開始/終了日 + includeExisting */}
            {selectedMode === "range" && (
              <View
                style={{
                  padding: spacing.md,
                  borderRadius: radius.xl,
                  backgroundColor: C.purpleLight,
                  gap: spacing.md,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "700", color: C.purple }}>
                  期間を選択
                </Text>
                <View style={{ flexDirection: "row", gap: spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: C.textLight, marginBottom: 4 }}>
                      開始日
                    </Text>
                    <TextInput
                      testID="v4-range-start"
                      value={rangeStartText}
                      onChangeText={setRangeStartText}
                      onBlur={handleCommitRangeStart}
                      onSubmitEditing={handleCommitRangeStart}
                      placeholder="YYYY-MM-DD"
                      style={{
                        borderWidth: 1,
                        borderColor: C.border,
                        borderRadius: radius.md,
                        padding: spacing.sm,
                        fontSize: 14,
                        backgroundColor: C.card,
                        color: C.text,
                        textAlign: "center",
                      }}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: C.textLight, marginBottom: 4 }}>
                      終了日
                    </Text>
                    <TextInput
                      testID="v4-range-end"
                      value={rangeEndText}
                      onChangeText={setRangeEndText}
                      onBlur={handleCommitRangeEnd}
                      onSubmitEditing={handleCommitRangeEnd}
                      placeholder="YYYY-MM-DD"
                      style={{
                        borderWidth: 1,
                        borderColor: C.border,
                        borderRadius: radius.md,
                        padding: spacing.sm,
                        fontSize: 14,
                        backgroundColor: C.card,
                        color: C.text,
                        textAlign: "center",
                      }}
                    />
                  </View>
                </View>
                {/* includeExisting トグル */}
                <View
                  testID="v4-range-include-existing"
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Text style={{ fontSize: 13, color: C.textLight, flex: 1 }}>
                    既存の献立も作り直す
                  </Text>
                  <Switch
                    value={includeExisting}
                    onValueChange={setIncludeExisting}
                    trackColor={{ false: C.border, true: C.purple }}
                    thumbColor={C.card}
                  />
                </View>
              </View>
            )}

            {/* 条件を指定 */}
            <View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 13, fontWeight: "700", color: C.textLight }}>
                条件を指定
              </Text>
              <ConditionPills values={constraints} onChange={setConstraints} />
            </View>

            {/* 究極モード (#1142)。使えないプランでは錠 (billing/03 §10.6) */}
            <UltimateModeToggle
              value={ultimateMode}
              onValueChange={setUltimateMode}
              disabled={isSubmitting || isGenerating}
              locked={ultimateLocked}
            />

            {/* メモ */}
            <TextInput
              testID="v4-memo"
              value={note}
              onChangeText={setNote}
              placeholder="自由にリクエスト（例: 木金は簡単に、和食多めで）"
              multiline
              numberOfLines={3}
              style={{
                borderWidth: 1,
                borderColor: C.border,
                borderRadius: radius.xl,
                padding: spacing.md,
                fontSize: 14,
                color: C.text,
                minHeight: 72,
                textAlignVertical: "top",
              }}
            />

            {/* 生成ボタン */}
            <Pressable
              testID="v4-submit-btn"
              onPress={handleGenerate}
              disabled={!selectedMode || isGenerating || isSubmitting}
              style={({ pressed }) => ({
                paddingVertical: spacing.lg,
                borderRadius: radius.xl,
                backgroundColor:
                  isSubmitting || isGenerating ? C.purple : C.accent,
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "row",
                gap: spacing.sm,
                opacity:
                  !selectedMode
                    ? 0.45
                    : isSubmitting || isGenerating
                    ? 0.85
                    : pressed
                    ? 0.9
                    : 1,
              })}
            >
              {isSubmitting || isGenerating ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={{ fontSize: 16, fontWeight: "700", color: "#fff" }}>
                    献立を作成中...
                  </Text>
                </>
              ) : (
                <>
                  <Ionicons name="sparkles" size={18} color="#fff" />
                  <Text style={{ fontSize: 16, fontWeight: "700", color: "#fff" }}>
                    献立を生成
                  </Text>
                </>
              )}
            </Pressable>

            {/* bottom padding for safe area */}
            <View style={{ height: spacing.xl }} />
          </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
