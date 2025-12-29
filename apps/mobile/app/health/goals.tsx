import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>目標</Text>
      <Link href="/health">健康トップへ</Link>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>作成</Text>
        <TextInput value={goalType} onChangeText={setGoalType} placeholder="goal_type（weight/body_fat 等）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={targetValue} onChangeText={setTargetValue} placeholder="target_value" keyboardType="decimal-pad" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={targetUnit} onChangeText={setTargetUnit} placeholder="unit（kg/% 等）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={targetDate} onChangeText={setTargetDate} placeholder="target_date（YYYY-MM-DD 任意）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <Pressable onPress={create} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "作成中..." : "作成"}</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>目標がありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((g) => (
            <View key={g.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>
                {g.goal_type}: {g.current_value ?? "-"} → {g.target_value}
                {g.target_unit}
              </Text>
              <Text style={{ color: "#666" }}>progress: {g.progress_percentage ? Math.round(g.progress_percentage) : 0}%</Text>
              <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                <Pressable
                  onPress={() => updateCurrent(g.id, (g.current_value ?? g.target_value) as number)}
                  style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}
                >
                  <Text style={{ color: "white", fontWeight: "900" }}>最新値で再計算</Text>
                </Pressable>
                <Pressable onPress={() => remove(g.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


