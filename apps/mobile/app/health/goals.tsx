import { Ionicons } from "@expo/vector-icons";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, Card, EmptyState, Input, LoadingState, PageHeader, ProgressBar, SectionHeader } from "../../src/components/ui";
import { colors, spacing, radius } from "../../src/theme";
import { getApi } from "../../src/lib/api";

type Goal = {
  id: string;
  goal_type: string;
  target_value: number;
  target_unit: string;
  target_date: string | null;
  current_value: number | null;
  progress_percentage: number | null;
  status: string;
  created_at: string;
};

export default function HealthGoalsPage() {
  const [items, setItems] = useState<Goal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [goalType, setGoalType] = useState("weight");
  const [targetValue, setTargetValue] = useState("");
  const [targetUnit, setTargetUnit] = useState("kg");
  const [targetDate, setTargetDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ goals: Goal[] }>("/api/health/goals?status=active");
      setItems((res.goals ?? []) as any);
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
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/health/goals", {
        goal_type: goalType,
        target_value: Number(tv),
        target_unit: targetUnit || "kg",
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

      <Card>
        <SectionHeader
          title="新しい目標を作成"
          right={<Ionicons name="add-circle-outline" size={20} color={colors.accent} />}
        />
        <View style={styles.formFields}>
          <Input
            label="タイプ"
            value={goalType}
            onChangeText={setGoalType}
            placeholder="weight / body_fat 等"
          />
          <Input
            label="目標値"
            value={targetValue}
            onChangeText={setTargetValue}
            placeholder="目標値を入力"
            keyboardType="decimal-pad"
          />
          <Input
            label="単位"
            value={targetUnit}
            onChangeText={setTargetUnit}
            placeholder="kg / % 等"
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
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Ionicons name="flag-outline" size={40} color={colors.textMuted} />}
          message="目標がありません。"
        />
      ) : (
        <View style={styles.list}>
          {items.map((g) => {
            const progress = g.progress_percentage ? Math.round(g.progress_percentage) : 0;
            return (
              <Card key={g.id}>
                <View style={styles.goalHeader}>
                  <Ionicons name="flag" size={18} color={colors.accent} />
                  <Text style={styles.goalTitle}>
                    {g.goal_type}: {g.current_value ?? "-"} → {g.target_value}
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
                <View style={styles.goalActions}>
                  <Button
                    onPress={() => updateCurrent(g.id, (g.current_value ?? g.target_value) as number)}
                    variant="secondary"
                    size="sm"
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
    marginBottom: spacing.md,
  },
  goalActions: {
    flexDirection: "row",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
});
