import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, StatusBadge, LoadingState, EmptyState, ChipSelector } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { colors, spacing, radius } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type ModerationItem = {
  id: string;
  type: "meal" | "recipe" | "ai_content";
  targetId?: string | null;
  userId?: string | null;
  reporterId?: string | null;
  flagType?: string | null;
  reason?: string | null;
  status?: string | null;
  createdAt: string;
  outputContent?: string | null;
  flagReason?: string | null;
};

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
  { value: "rejected", label: "Rejected" },
];

function typeIcon(type: string): { name: keyof typeof Ionicons.glyphMap; color: string } {
  switch (type) {
    case "meal":
      return { name: "restaurant", color: colors.accent };
    case "recipe":
      return { name: "book", color: colors.purple };
    case "ai_content":
      return { name: "sparkles", color: colors.warning };
    default:
      return { name: "flag", color: colors.textMuted };
  }
}

export default function AdminModerationPage() {
  const [status, setStatus] = useState("pending");
  const [items, setItems] = useState<ModerationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<any>(`/api/admin/moderation?status=${encodeURIComponent(status)}&limit=50`);
      const merged: ModerationItem[] = [
        ...(res.mealFlags ?? []),
        ...(res.recipeFlags ?? []),
        ...(res.aiFlags ?? []),
      ];
      setItems(merged);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [status]);

  async function act(item: ModerationItem, action: "approve" | "reject" | "delete", deleteContent?: boolean) {
    Alert.alert("実行", `${item.type}/${action} を実行しますか？`, [
      { text: "キャンセル", style: "cancel" },
      {
        text: "実行",
        onPress: async () => {
          try {
            const api = getApi();
            await api.put(`/api/admin/moderation/${item.id}`, {
              type: item.type,
              action,
              note: note.trim() || null,
              deleteContent: !!deleteContent,
            });
            await load();
          } catch (e: any) {
            Alert.alert("失敗", e?.message ?? "失敗しました。");
          }
        },
      },
    ]);
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: 56, paddingHorizontal: spacing.lg, paddingBottom: spacing["3xl"], gap: spacing.lg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>Moderation</Text>
        </View>
        <Pressable onPress={load} hitSlop={8}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      {/* Status Filter */}
      <ChipSelector
        options={STATUS_OPTIONS}
        selected={status}
        onSelect={setStatus}
      />

      {/* Note */}
      <Input
        value={note}
        onChangeText={setNote}
        placeholder="操作メモ（任意）"
      />

      {/* List */}
      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon={<Ionicons name="shield-checkmark-outline" size={40} color={colors.textMuted} />} message="対象がありません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((it) => {
            const icon = typeIcon(it.type);
            return (
              <Card key={`${it.type}-${it.id}`}>
                <View style={{ gap: spacing.sm }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <View style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
                      <Ionicons name={icon.name as any} size={18} color={icon.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{it.type}</Text>
                    </View>
                    <StatusBadge
                      variant={it.status === "pending" ? "pending" : it.status === "resolved" ? "completed" : "alert"}
                      label={it.flagType ?? it.status ?? "-"}
                    />
                  </View>

                  <Text style={{ fontSize: 13, color: colors.textMuted, lineHeight: 20 }}>
                    {it.reason ?? it.flagReason ?? it.outputContent ?? "-"}
                  </Text>

                  <Text style={{ fontSize: 12, color: colors.textMuted }}>
                    {new Date(it.createdAt).toLocaleString("ja-JP")}
                  </Text>

                  <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap", marginTop: spacing.xs }}>
                    <Button onPress={() => act(it, "approve")} variant="secondary" size="sm">
                      承認
                    </Button>
                    <Button onPress={() => act(it, "reject")} variant="secondary" size="sm">
                      却下
                    </Button>
                    {it.type !== "ai_content" ? (
                      <Button onPress={() => act(it, "delete", true)} variant="destructive" size="sm">
                        削除
                      </Button>
                    ) : null}
                  </View>
                </View>
              </Card>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
