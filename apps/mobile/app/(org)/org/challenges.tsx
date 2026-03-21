import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing } from "../../../src/theme";

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

const STATUS_MAP: Record<string, { variant: "completed" | "pending" | "generating" | "info"; label: string }> = {
  active: { variant: "generating", label: "進行中" },
  completed: { variant: "completed", label: "完了" },
  draft: { variant: "pending", label: "下書き" },
};

export default function OrgChallengesPage() {
  const router = useRouter();
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
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: spacing["4xl"] }}>
      {/* Header */}
      <View style={{ paddingTop: 56, paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Pressable onPress={() => router.push("/org/dashboard")} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text, flex: 1 }}>チャレンジ</Text>
        <Pressable onPress={load} hitSlop={8}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: spacing.xl, gap: spacing.lg }}>
        {/* Create Form */}
        <Card>
          <SectionHeader title="新規作成" />
          <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
            <Input value={title} onChangeText={setTitle} placeholder="タイトル" label="タイトル" />
            <Input
              value={challengeType}
              onChangeText={setChallengeType}
              placeholder="breakfast_rate / veg_score / cooking_rate / steps / weight_loss / custom"
              label="チャレンジタイプ"
            />
            <Input value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" label="開始日" />
            <Input value={endDate} onChangeText={setEndDate} placeholder="YYYY-MM-DD" label="終了日" />
            <Button onPress={create} loading={isSubmitting} disabled={isSubmitting}>
              {isSubmitting ? "作成中..." : "作成"}
            </Button>
          </View>
        </Card>

        {/* List */}
        <SectionHeader title="チャレンジ一覧" />

        {isLoading ? (
          <LoadingState message="チャレンジを読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
            </View>
          </Card>
        ) : items.length === 0 ? (
          <EmptyState icon={<Ionicons name="trophy-outline" size={40} color={colors.textMuted} />} message="チャレンジがありません。" />
        ) : (
          <View style={{ gap: spacing.md }}>
            {items.map((c) => {
              const statusConfig = STATUS_MAP[c.status] ?? { variant: "info" as const, label: c.status };
              return (
                <Card key={c.id}>
                  <View style={{ gap: spacing.sm }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <Text style={{ fontSize: 16, fontWeight: "700", color: colors.text, flex: 1 }}>{c.title}</Text>
                      <StatusBadge variant={statusConfig.variant} label={statusConfig.label} />
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <Ionicons name="flag" size={14} color={colors.textMuted} />
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>{c.challengeType}</Text>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <Ionicons name="people" size={14} color={colors.textMuted} />
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>参加 {c.participantCount}人</Text>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <Ionicons name="calendar" size={14} color={colors.textMuted} />
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>
                        {c.startDate} - {c.endDate}
                      </Text>
                    </View>
                    <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs }}>
                      <Button onPress={() => updateStatus(c.id, "active")} variant="outline" size="sm">
                        有効化
                      </Button>
                      <Button onPress={() => updateStatus(c.id, "completed")} variant="secondary" size="sm">
                        完了
                      </Button>
                    </View>
                  </View>
                </Card>
              );
            })}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
