import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type Challenge = {
  id: string;
  title: string;
  description: string | null;
  challengeType: string;
  startDate: string;
  endDate: string;
  status: string;
  participantCount: number;
};

export default function OrgChallengesPage() {
  const [items, setItems] = useState<Challenge[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [challengeType, setChallengeType] = useState("breakfast_rate");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ challenges: Challenge[] }>("/api/org/challenges");
      setItems(res.challenges ?? []);
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
    const t = title.trim();
    if (!t || !challengeType || !startDate || !endDate || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/org/challenges", { title: t, challengeType, startDate, endDate });
      setTitle("");
      setStartDate("");
      setEndDate("");
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function updateStatus(id: string, nextStatus: string) {
    try {
      const api = getApi();
      await api.put("/api/org/challenges", { id, status: nextStatus });
      await load();
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>チャレンジ</Text>

      <View style={{ gap: 8 }}>
        <Link href="/org/dashboard">ダッシュボードへ</Link>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>作成</Text>
        <TextInput value={title} onChangeText={setTitle} placeholder="タイトル" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput
          value={challengeType}
          onChangeText={setChallengeType}
          placeholder="challengeType（breakfast_rate/veg_score/cooking_rate/steps/weight_loss/custom）"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
        <TextInput value={startDate} onChangeText={setStartDate} placeholder="開始日 YYYY-MM-DD" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={endDate} onChangeText={setEndDate} placeholder="終了日 YYYY-MM-DD" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
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
        <Text style={{ color: "#666" }}>チャレンジがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((c) => (
            <View key={c.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>{c.title}</Text>
              <Text style={{ color: "#666" }}>
                type: {c.challengeType} / status: {c.status} / 参加: {c.participantCount}
              </Text>
              <Text style={{ color: "#666" }}>
                {c.startDate} 〜 {c.endDate}
              </Text>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable onPress={() => updateStatus(c.id, "active")} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>有効化</Text>
                </Pressable>
                <Pressable onPress={() => updateStatus(c.id, "completed")} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>完了</Text>
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


