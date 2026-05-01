import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, ChipSelector, EmptyState, Input, LoadingState, PageHeader, ProgressBar, SectionHeader } from "../../src/components/ui";
import { colors, spacing } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type Milestone = {
  value: number;
  achieved_at: string;
};

type Goal = {
  id: string;
  goal_type: string;
  target_value: number;
  target_unit: string;
  target_date: string | null;
  current_value: number | null;
  progress_percentage: number | null;
  status: string;
  milestones?: Milestone[];
  created_at: string;
};

const GOAL_TYPES = [
  { value: "weight", label: "体重", unit: "kg" },
  { value: "body_fat", label: "体脂肪率", unit: "%" },
  { value: "steps", label: "歩数", unit: "歩" },
] as const;

type GoalTypeValue = (typeof GOAL_TYPES)[number]["value"];

function getGoalConfig(type: string) {
  return GOAL_TYPES.find((t) => t.value === type) ?? GOAL_TYPES[0];
}

export default function HealthGoalsPage() {
  const [allItems, setAllItems] = useState<Goal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [goalType, setGoalType] = useState<GoalTypeValue>("weight");
  const [targetValue, setTargetValue] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const activeItems = allItems.filter((g) => g.status === "active");
  const achievedItems = allItems.filter((g) => g.status === "achieved");

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ goals: Goal[] }>("/api/health/goals?status=all");
      setAllItems((res.goals ?? []) as any);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    if (isSubmitting) return;
    const tv = targetValue.trim();
    if (!tv) return;
    const numTv = Number(tv);
    if (!Number.isFinite(numTv) || numTv <= 0) {
      Alert.alert("入力エラー", "目標値は正の数値を入力してください。");
      return;
    }
    const config = getGoalConfig(goalType);
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/health/goals", {
        goal_type: goalType,
        target_value: numTv,
        target_unit: config.unit,
        target_date: targetDate.trim() || null,
      });
      setTargetValue("");
      setTargetDate("");
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function updateCurrent(goalId: string, currentValue: number) {
    try {
      const api = getApi();
      await api.put(`/api/health/goals/${goalId}`, { current_value: currentValue });
      await load();
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    }
  }

  async function remove(goalId: string) {
    Alert.alert("削除", "この目標を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/health/goals/${goalId}`);
            await load();
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.screen}>
      <PageHeader
        title="目標"
        right={
          <Link href="/health">
            <Text style={styles.linkText}>健康トップへ</Text>
          </Link>
        }
      />
      <ScrollView contentContainerStyle={styles.container}>

        {/* 目標作成フォーム */}
        <Card>
          <SectionHeader
            title="新しい目標を作成"
            right={<Ionicons name="add-circle-outline" size={20} color={colors.accent} />}
          />
          <View style={styles.formFields}>
            <View>
              <Text style={styles.fieldLabel}>ゴールタイプ</Text>
              <ChipSelector
                options={GOAL_TYPES.map((t) => ({ value: t.value, label: t.label }))}
                selected={goalType}
                onSelect={(v) => setGoalType(v as GoalTypeValue)}
                style={styles.chipSelector}
              />
            </View>
            <Input
              label={`目標値（${getGoalConfig(goalType).unit}）`}
              value={targetValue}
              onChangeText={setTargetValue}
              placeholder="目標値を入力"
              keyboardType="decimal-pad"
            />
            <Input
              label="期限（任意）"
              value={targetDate}
              onChangeText={setTargetDate}
              placeholder="YYYY-MM-DD"
            />
            <Button onPress={create} disabled={isSubmitting} loading={isSubmitting}>
              {isSubmitting ? "作成中..." : "作成"}
            </Button>
          </View>
        </Card>

        {/* アクティブな目標 */}
        <SectionHeader title="アクティブな目標" />

        {isLoading ? (
          <LoadingState message="目標を読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          </Card>
        ) : activeItems.length === 0 ? (
          <EmptyState
            icon={<Ionicons name="flag-outline" size={40} color={colors.textMuted} />}
            message="アクティブな目標がありません。"
          />
        ) : (
          <View style={styles.list}>
            {activeItems.map((g) => {
              const progress = g.progress_percentage ? Math.round(g.progress_percentage) : 0;
              const config = getGoalConfig(g.goal_type);
              return (
                <Card key={g.id}>
                  <View style={styles.goalHeader}>
                    <Ionicons name="flag" size={18} color={colors.accent} />
                    <Text style={styles.goalTitle}>
                      {config.label}: {g.current_value ?? "-"} → {g.target_value}
                      {g.target_unit}
                    </Text>
                  </View>
                  <ProgressBar
                    value={progress}
                    max={100}
                    label="進捗"
                    showPercentage
                    color={progress >= 100 ? colors.success : colors.accent}
                    style={styles.progressBar}
                  />
                  {g.target_date && (
                    <View style={styles.dateRow}>
                      <Ionicons name="calendar-outline" size={13} color={colors.textMuted} />
                      <Text style={styles.dateText}>
                        期限: {new Date(g.target_date).toLocaleDateString("ja-JP")}
                      </Text>
                    </View>
                  )}

                  {/* マイルストーン */}
                  {g.milestones && g.milestones.length > 0 && (
                    <View style={styles.milestonesContainer}>
                      <Text style={styles.milestonesLabel}>達成マイルストーン</Text>
                      <View style={styles.milestonesList}>
                        {g.milestones.map((m, i) => (
                          <View key={i} style={styles.milestoneChip}>
                            <Ionicons name="checkmark-circle" size={12} color={colors.success} />
                            <Text style={styles.milestoneText}>
                              {m.value}{g.target_unit}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}

                  <View style={styles.goalActions}>
                    <Button
                      onPress={() => {
                        if (g.current_value == null) {
                          Alert.alert("データなし", "現在の値がまだ記録されていません。先に健康記録を入力してください。");
                          return;
                        }
                        updateCurrent(g.id, g.current_value as number);
                      }}
                      variant="secondary"
                      size="sm"
                      disabled={g.current_value == null}
                    >
                      <Ionicons name="refresh-outline" size={14} color={colors.text} />
                      <Text style={{ fontSize: 13, fontWeight: "700", color: colors.text }}>最新値で再計算</Text>
                    </Button>
                    <Button onPress={() => remove(g.id)} variant="destructive" size="sm">
                      <Ionicons name="trash-outline" size={14} color="#FFFFFF" />
                      <Text style={{ fontSize: 13, fontWeight: "700", color: "#FFFFFF" }}>削除</Text>
                    </Button>
                  </View>
                </Card>
              );
            })}
          </View>
        )}

        {/* 達成済み目標 */}
        {!isLoading && !error && achievedItems.length > 0 && (
          <>
            <SectionHeader title="達成済みの目標" />
            <View style={styles.list}>
              {achievedItems.map((g) => {
                const config = getGoalConfig(g.goal_type);
                return (
                  <Card key={g.id} variant="success">
                    <View style={styles.achievedRow}>
                      <View style={styles.achievedIcon}>
                        <Ionicons name="trophy" size={20} color={colors.success} />
                      </View>
                      <View style={styles.achievedInfo}>
                        <Text style={styles.achievedLabel}>{config.label} 目標達成！</Text>
                        <Text style={styles.achievedSub}>
                          {g.target_value}{g.target_unit} を達成
                        </Text>
                      </View>
                    </View>
                  </Card>
                );
              })}
            </View>
          </>
        )}

        <Button onPress={load} variant="ghost" size="sm">
          <Ionicons name="refresh-outline" size={16} color={colors.textLight} />
          <Text style={{ color: colors.textLight, fontWeight: "700", fontSize: 13 }}>更新</Text>
        </Button>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing["4xl"],
  },
  linkText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.accent,
  },
  formFields: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.textLight,
    marginBottom: spacing.sm,
  },
  chipSelector: {
    flexWrap: "wrap",
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  errorText: {
    fontSize: 14,
    color: colors.error,
    fontWeight: "600",
    flex: 1,
  },
  list: {
    gap: spacing.md,
  },
  goalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  goalTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: colors.text,
    flex: 1,
  },
  progressBar: {
    marginBottom: spacing.sm,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  dateText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  milestonesContainer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  milestonesLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  milestonesList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  milestoneChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 99,
    backgroundColor: colors.successLight,
  },
  milestoneText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.success,
  },
  goalActions: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  achievedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  achievedIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.successLight,
    alignItems: "center",
    justifyContent: "center",
  },
  achievedInfo: {
    flex: 1,
  },
  achievedLabel: {
    fontSize: 14,
    fontWeight: "800",
    color: colors.success,
  },
  achievedSub: {
    fontSize: 12,
    color: colors.success,
    marginTop: 2,
  },
});
