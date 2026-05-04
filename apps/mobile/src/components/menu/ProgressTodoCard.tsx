import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import {
  PROGRESS_PHASES,
  SHOPPING_LIST_PHASES,
  ULTIMATE_PROGRESS_PHASES,
  type PhaseDefinition,
} from "@homegohan/shared";
import { colors, radius, spacing } from "../../theme";

export type ProgressTodoCardMode = "normal" | "ultimate" | "shopping";

export interface ProgressTodoCardProps {
  mode: ProgressTodoCardMode;
  currentPhase: string;
  progress: number; // 0-100
  completedSlots?: number;
  totalSlots?: number;
  message?: string;
  defaultMessage?: string;
}

export function ProgressTodoCard({
  mode,
  currentPhase,
  progress,
  completedSlots,
  totalSlots = 0,
  message,
  defaultMessage = "AIが献立を生成中...",
}: ProgressTodoCardProps) {
  const [expanded, setExpanded] = useState(true);

  const phaseList: PhaseDefinition[] =
    mode === "ultimate"
      ? ULTIMATE_PROGRESS_PHASES
      : mode === "shopping"
        ? SHOPPING_LIST_PHASES
        : PROGRESS_PHASES;

  const totalDays = totalSlots > 0 ? Math.ceil(totalSlots / 3) : 0;

  const dynamicPhases = useMemo(() => {
    return phaseList.map((p) => {
      if (p.phase === "generating" && totalDays > 0) {
        const dayLabel = totalDays === 1 ? "1日分" : `${totalDays}日分`;
        return { ...p, label: `${dayLabel}の献立をAIが作成` };
      }
      return p;
    });
  }, [phaseList, totalDays]);

  const getPhaseStatus = (
    phase: PhaseDefinition,
  ): "completed" | "in_progress" | "pending" => {
    if (progress >= phase.threshold) return "completed";
    if (
      currentPhase === phase.phase ||
      (currentPhase.startsWith(phase.phase.split("_")[0]) &&
        progress < phase.threshold)
    )
      return "in_progress";
    return "pending";
  };

  const isError = currentPhase === "failed";

  const headerMessage = isError
    ? (message ?? "エラーが発生しました")
    : totalDays > 0
      ? `献立を生成中...（${completedSlots ?? 0}/${totalSlots}食、${totalDays}日分）`
      : (message ?? defaultMessage);

  return (
    <LinearGradient
      testID="progress-todo-card"
      colors={isError ? ["#ef4444", "#dc2626"] : [colors.accent, colors.purple]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ borderRadius: radius.lg, overflow: "hidden" }}
    >
      {/* ヘッダー */}
      <Pressable
        testID="progress-todo-expand-btn"
        onPress={() => setExpanded((prev) => !prev)}
        style={{ padding: spacing.md, gap: spacing.sm }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
          }}
        >
          {isError ? (
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
              <Text
                style={{ fontSize: 10, color: "#ef4444", fontWeight: "700" }}
              >
                !
              </Text>
            </View>
          ) : (
            <ActivityIndicator size="small" color="#fff" />
          )}
          <Text
            style={{
              flex: 1,
              color: "#fff",
              fontWeight: "700",
              fontSize: 13,
            }}
          >
            {headerMessage}
          </Text>
          {progress > 0 && (
            <Text
              testID="progress-todo-percentage"
              style={{ color: "rgba(255,255,255,0.7)", fontSize: 11 }}
            >
              {progress}%
            </Text>
          )}
          <Ionicons
            name={expanded ? "chevron-up" : "chevron-down"}
            size={14}
            color="rgba(255,255,255,0.7)"
          />
        </View>

        {/* 進捗バー */}
        {progress > 0 && !isError && (
          <View
            style={{
              height: 6,
              backgroundColor: "rgba(255,255,255,0.2)",
              borderRadius: 3,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${progress}%`,
                height: "100%",
                backgroundColor: "#fff",
                borderRadius: 3,
              }}
            />
          </View>
        )}
      </Pressable>

      {/* 展開時の ToDoリスト */}
      {expanded && !isError && (
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
          {dynamicPhases
            .filter((p) => p.phase !== "failed")
            .map((phase) => {
              const status = getPhaseStatus(phase);
              return (
                <View
                  key={phase.phase}
                  testID={`progress-todo-phase-${phase.phase}`}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: spacing.sm,
                  }}
                >
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
                      <Ionicons
                        name="checkmark"
                        size={10}
                        color={colors.accent}
                      />
                    </View>
                  ) : status === "in_progress" ? (
                    <ActivityIndicator
                      size="small"
                      color="#fff"
                      style={{ width: 16, height: 16 }}
                    />
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
                      color:
                        status === "pending"
                          ? "rgba(255,255,255,0.5)"
                          : "#fff",
                      fontWeight: status === "in_progress" ? "600" : "400",
                      textDecorationLine:
                        status === "completed" ? "line-through" : "none",
                    }}
                  >
                    {phase.label}
                  </Text>
                </View>
              );
            })}

          {/* completedSlots/totalSlots 表示 */}
          {totalSlots > 0 && (
            <Text
              style={{
                fontSize: 10,
                color: "rgba(255,255,255,0.6)",
                marginTop: spacing.xs ?? 2,
              }}
            >
              進捗: {completedSlots ?? 0} / {totalSlots} スロット完了
            </Text>
          )}
        </View>
      )}
    </LinearGradient>
  );
}
