import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card, ChipSelector, EmptyState, LoadingState, StatusBadge } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing, radius } from "../../../src/theme";

type InquiryRow = {
  id: string;
  userId: string | null;
  userName: string | null;
  inquiryType: string;
  email: string;
  subject: string;
  status: string;
  createdAt: string;
};

const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "in_progress", label: "In Progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];

const STATUS_BADGE_MAP: Record<string, "pending" | "generating" | "completed" | "info"> = {
  pending: "pending",
  in_progress: "generating",
  resolved: "completed",
  closed: "info",
};

export default function SupportInquiriesPage() {
  const [status, setStatus] = useState("pending");
  const [items, setItems] = useState<InquiryRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ inquiries: InquiryRow[] }>(`/api/admin/inquiries?limit=50&status=${encodeURIComponent(status)}`);
      setItems(res.inquiries ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [status]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 56 }}>
        <Pressable onPress={() => router.back()} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text, flex: 1 }}>問い合わせ</Text>
        <Pressable onPress={load} style={{ padding: spacing.sm }}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ChipSelector
        options={STATUS_OPTIONS}
        selected={status}
        onSelect={setStatus}
        scrollable
      />

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState icon={<Ionicons name="chatbubbles-outline" size={40} color={colors.textMuted} />} message="問い合わせがありません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((i) => (
            <Card key={i.id} onPress={() => router.push(`/support/inquiries/${i.id}`)}>
              <View style={{ gap: spacing.xs }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 }} numberOfLines={1}>
                    {i.subject}
                  </Text>
                  <StatusBadge variant={STATUS_BADGE_MAP[i.status] ?? "pending"} label={i.status} />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                  <Ionicons name="pricetag-outline" size={14} color={colors.textMuted} />
                  <Text style={{ fontSize: 13, color: colors.textLight }}>{i.inquiryType}</Text>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>-</Text>
                  <Ionicons name="person-outline" size={14} color={colors.textMuted} />
                  <Text style={{ fontSize: 13, color: colors.textLight }} numberOfLines={1}>{i.userName ?? i.email}</Text>
                </View>
                <Text style={{ fontSize: 12, color: colors.textMuted }}>{new Date(i.createdAt).toLocaleString("ja-JP")}</Text>
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
