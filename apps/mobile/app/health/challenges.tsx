import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../src/lib/api";

type Challenge = {
  id: string;
  challenge_type: string;
  title: string;
  description: string | null;
  start_date: string;
  end_date: string;
  target_metric: string;
  target_value: number;
  target_unit: string;
  current_value: number | null;
  status: string;
  reward_points: number | null;
  reward_badge: string | null;
  reward_description: string | null;
  created_at: string;
};

type ChallengeTemplate = {
  id: string;
  type: string;
  title: string;
  description: string;
  metric: string;
  default_target: number;
  unit: string;
  duration_days: number;
  reward_points: number;
  reward_badge: string;
  reward_description: string;
  difficulty: string;
  emoji: string;
};

export default function HealthChallengesPage() {
  const [status, setStatus] = useState<"active" | "completed" | "all">("active");
  const [items, setItems] = useState<Challenge[]>([]);
  const [templates, setTemplates] = useState<ChallengeTemplate[]>([]);
  const [customTarget, setCustomTarget] = useState("");

  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ challenges: Challenge[]; templates: ChallengeTemplate[] }>(`/api/health/challenges?status=${status}`);
      setItems(res.challenges ?? []);
      setTemplates(res.templates ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [status]);

  const targetOverride = useMemo(() => {
    const v = customTarget.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }, [customTarget]);

  async function create(templateId: string) {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/health/challenges", {
        template_id: templateId,
        custom_target: targetOverride ?? undefined,
      });
      Alert.alert("開始しました", "チャレンジを作成しました。");
      setCustomTarget("");
      await load();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>チャレンジ</Text>
      <Link href="/health">健康トップへ</Link>

      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        {(["active", "completed", "all"] as const).map((s) => (
          <Pressable
            key={s}
            onPress={() => setStatus(s)}
            style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999, backgroundColor: status === s ? "#E07A5F" : "#eee" }}
          >
            <Text style={{ fontWeight: "900", color: status === s ? "white" : "#333" }}>{s}</Text>
          </Pressable>
        ))}
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>テンプレートから開始</Text>
        <Text style={{ color: "#666" }}>任意で target を上書きできます（空ならデフォルト）。</Text>
        <TextInput
          value={customTarget}
          onChangeText={setCustomTarget}
          placeholder="custom_target（数値/任意）"
          keyboardType="decimal-pad"
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }}
        />
        {templates.length === 0 ? (
          <Text style={{ color: "#666" }}>テンプレートがありません。</Text>
        ) : (
          <View style={{ gap: 10 }}>
            {templates.map((t) => (
              <View key={t.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "#fafafa", gap: 6 }}>
                <Text style={{ fontWeight: "900" }}>
                  {t.emoji} {t.title}
                </Text>
                <Text style={{ color: "#666" }}>{t.description}</Text>
                <Text style={{ color: "#999" }}>
                  target: {t.default_target}
                  {t.unit} / {t.duration_days}日 / reward: {t.reward_points}pt
                </Text>
                <Pressable
                  onPress={() => create(t.id)}
                  disabled={isSubmitting}
                  style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: isSubmitting ? "#999" : "#333", alignSelf: "flex-start" }}
                >
                  <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "作成中..." : "開始"}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
      </View>

      <Text style={{ fontWeight: "900" }}>あなたのチャレンジ</Text>
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
              <Text style={{ fontWeight: "900" }}>
                {c.title}（{c.status}）
              </Text>
              {c.description ? <Text style={{ color: "#666" }}>{c.description}</Text> : null}
              <Text style={{ color: "#999" }}>
                {c.start_date} → {c.end_date}
              </Text>
              <Text style={{ color: "#333" }}>
                progress: {c.current_value ?? 0} / {c.target_value}
                {c.target_unit}
              </Text>
              {c.reward_description ? <Text style={{ color: "#666" }}>🎁 {c.reward_description}</Text> : null}
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


