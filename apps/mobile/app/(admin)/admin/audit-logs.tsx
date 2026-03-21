import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type AuditLog = {
  id: string;
  adminName: string;
  actionType: string;
  targetId: string | null;
  severity: string | null;
  createdAt: string;
};

function severityVariant(severity: string | null): "completed" | "pending" | "alert" | "info" {
  switch (severity) {
    case "critical":
    case "high":
      return "alert";
    case "medium":
      return "pending";
    case "low":
      return "completed";
    default:
      return "info";
  }
}

export default function AdminAuditLogsPage() {
  const [items, setItems] = useState<AuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionType, setActionType] = useState("");

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const qs = actionType.trim() ? `?action_type=${encodeURIComponent(actionType.trim())}` : "";
      const res = await api.get<{ logs: AuditLog[] }>(`/api/admin/audit-logs${qs}`);
      setItems(res.logs ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: 56, paddingHorizontal: spacing.lg, paddingBottom: spacing["3xl"], gap: spacing.lg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>Audit Logs</Text>
      </View>

      {/* Filter */}
      <Card>
        <View style={{ gap: spacing.md }}>
          <SectionHeader title="フィルター" />
          <Input
            value={actionType}
            onChangeText={setActionType}
            placeholder="action_type で絞り込み（任意）"
          />
          <Button onPress={load}>
            検索
          </Button>
        </View>
      </Card>

      {/* List */}
      <SectionHeader
        title="ログ一覧"
        right={
          <Pressable onPress={load} hitSlop={8}>
            <Ionicons name="refresh" size={20} color={colors.textMuted} />
          </Pressable>
        }
      />

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
        <EmptyState icon={<Ionicons name="document-text-outline" size={40} color={colors.textMuted} />} message="ログがありません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.slice(0, 100).map((l) => (
            <Card key={l.id}>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="document-text" size={18} color={colors.textLight} />
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: "700", color: colors.text }}>{l.actionType}</Text>
                  <StatusBadge variant={severityVariant(l.severity)} label={l.severity ?? "-"} />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                  <Ionicons name="person" size={14} color={colors.textMuted} />
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>{l.adminName}</Text>
                </View>
                <Text style={{ fontSize: 12, color: colors.textMuted }}>
                  {new Date(l.createdAt).toLocaleString("ja-JP")}
                </Text>
                {l.targetId ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="link" size={14} color={colors.textMuted} />
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>target: {l.targetId}</Text>
                  </View>
                ) : null}
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
