import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

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
  ultimateMode: false;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onGenerate: (params: V4GenerateParams) => Promise<void>;
  mealPlanDays: DayRow[];
  weekStartDate: string;
  weekEndDate: string;
  isGenerating: boolean;
}

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
function getTodayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
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

export function V4GenerateModal({
  visible,
  onClose,
  onGenerate,
  mealPlanDays,
  weekStartDate,
  weekEndDate,
  isGenerating,
}: Props) {
  const todayStr = useMemo(() => getTodayStr(), []);

  const [selectedMode, setSelectedMode] = useState<GenerateMode | null>(null);
  const [rangeStart, setRangeStart] = useState(weekStartDate);
  const [rangeEnd, setRangeEnd] = useState(weekEndDate);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [singleDayDate, setSingleDayDate] = useState(todayStr);

  const [constraints, setConstraints] = useState<MenuGenerationConstraints>({
    useFridgeFirst: false,
    quickMeals: false,
    japaneseStyle: false,
    healthy: false,
  });

  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // モーダルが開くたびに状態をリセット
  useEffect(() => {
    if (visible) {
      setIsSubmitting(false);
      setIncludeExisting(false); // 破壊的フラグは毎回リセット
    }
  }, [visible]);

  // AsyncStorage から range 設定を復元
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY_RANGE_DAYS);
        if (saved) {
          const { startDays, endDays } = JSON.parse(saved);
          const newStart = addDays(todayStr, startDays);
          const newEnd = addDays(todayStr, endDays);
          setRangeStart(newStart);
          setRangeEnd(newEnd);
          return;
        }
      } catch {
        // パースエラーはデフォルトにフォールバック
      }
      setRangeStart(todayStr);
      setRangeEnd(weekEndDate >= todayStr ? weekEndDate : addDays(todayStr, 6));
    })();
  }, [visible, todayStr, weekEndDate]);

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

  const handleSetRangeStart = useCallback(
    (value: string) => {
      const adjusted = value < todayStr ? todayStr : value;
      setRangeStart(adjusted);
      if (adjusted > rangeEnd) setRangeEnd(adjusted);
    },
    [todayStr, rangeEnd]
  );

  const handleSetRangeEnd = useCallback(
    (value: string) => {
      const adjusted = value < todayStr ? todayStr : value;
      setRangeEnd(adjusted);
      if (adjusted < rangeStart) setRangeStart(adjusted);
    },
    [todayStr, rangeStart]
  );

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

  const buildTargetSlots = useCallback((): TargetSlot[] => {
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
          startDate: rangeStart,
          endDate: rangeEnd,
          includeExisting,
        });
      case "single_day":
        return buildSingleDaySlots({
          date: singleDayDate,
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

    const slots = buildTargetSlots();
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
        ultimateMode: false,
      });
    } catch {
      setIsSubmitting(false);
    }
  };

  const toggleConstraint = (key: keyof MenuGenerationConstraints) => {
    setConstraints((prev: MenuGenerationConstraints) => ({ ...prev, [key]: !prev[key] }));
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

  // Constraint options
  const constraintOptions: {
    key: keyof MenuGenerationConstraints;
    iconName: keyof typeof Ionicons.glyphMap;
    label: string;
  }[] = [
    { key: "useFridgeFirst", iconName: "cube-outline", label: "冷蔵庫優先" },
    { key: "quickMeals", iconName: "flash-outline", label: "時短中心" },
    { key: "japaneseStyle", iconName: "restaurant-outline", label: "和食多め" },
    { key: "healthy", iconName: "heart-outline", label: "ヘルシー" },
  ];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      testID="v4-modal"
    >
      {/* Backdrop */}
      <Pressable
        onPress={handleClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.5)",
          justifyContent: "flex-end",
        }}
      >
        {/* Sheet */}
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: C.card,
            borderTopLeftRadius: radius["2xl"],
            borderTopRightRadius: radius["2xl"],
            maxHeight: "90%",
            ...shadows.md,
          }}
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
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="sparkles" size={20} color={C.accent} />
              <Text style={{ fontSize: 17, fontWeight: "700", color: C.text }}>
                AIアシスタント
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
                  value={singleDayDate}
                  onChangeText={(v) => {
                    const adjusted = v < todayStr ? todayStr : v;
                    setSingleDayDate(adjusted);
                  }}
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
                      value={rangeStart}
                      onChangeText={handleSetRangeStart}
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
                      value={rangeEnd}
                      onChangeText={handleSetRangeEnd}
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

            {/* 条件を指定 (PR 4-2 で詳細実装、仮 UI) */}
            <View style={{ gap: spacing.sm }}>
              <Text style={{ fontSize: 13, fontWeight: "700", color: C.textLight }}>
                条件を指定
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                {constraintOptions.map((opt) => {
                  const active = !!constraints[opt.key];
                  return (
                    <Pressable
                      key={String(opt.key)}
                      onPress={() => toggleConstraint(opt.key)}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                        paddingHorizontal: spacing.md,
                        paddingVertical: spacing.sm,
                        borderRadius: radius.full,
                        backgroundColor: active ? C.accent : C.bg,
                        opacity: pressed ? 0.8 : 1,
                      })}
                    >
                      <Ionicons
                        name={opt.iconName}
                        size={14}
                        color={active ? "#fff" : C.textLight}
                      />
                      <Text
                        style={{
                          fontSize: 13,
                          fontWeight: "700",
                          color: active ? "#fff" : C.textLight,
                        }}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* 究極モード (PR 4-3 で実装、仮 UI: disabled) */}
            <View
              style={{
                padding: spacing.md,
                borderRadius: radius.xl,
                backgroundColor: C.bg,
                opacity: 0.65,
                flexDirection: "row",
                alignItems: "center",
                gap: spacing.md,
              }}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: C.border,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ionicons name="star-outline" size={18} color={C.textMuted} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={{ fontSize: 14, fontWeight: "700", color: C.text }}>
                    究極モード
                  </Text>
                  <View
                    style={{
                      backgroundColor: "#FEF3C7",
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: radius.sm,
                    }}
                  >
                    <Text style={{ fontSize: 10, fontWeight: "700", color: "#D97706" }}>
                      Premium
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11, color: C.textMuted }}>準備中</Text>
                </View>
                <Text style={{ fontSize: 12, color: C.textLight, marginTop: 2 }}>
                  AIが献立を自動で見直し、栄養バランスを改善
                </Text>
              </View>
              <Switch
                testID="ultimate-mode-toggle"
                value={false}
                disabled
                trackColor={{ false: C.border, true: C.border }}
                thumbColor={C.card}
              />
            </View>

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
        </Pressable>
      </Pressable>
    </Modal>
  );
}
