import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState, ChipSelector } from "../../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

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

function statusVariant(s: string): "completed" | "pending" | "generating" | "alert" | "info" {
  switch (s) {
    case "resolved":
    case "closed":
      return "completed";
    case "in_progress":
      return "generating";
    case "pending":
      return "pending";
    default:
      return "info";
  }
}

export default function AdminInquiriesPage() {
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
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: 56, paddingHorizontal: spacing.lg, paddingBottom: spacing["3xl"], gap: spacing.lg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>Inquiries</Text>
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
        scrollable
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
        <EmptyState icon={<Ionicons name="chatbubbles-outline" size={40} color={colors.textMuted} />} message="問い合わせがありません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((i) => (
            <Card key={i.id} onPress={() => router.push(`/admin/inquiries/${i.id}`)}>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <Ionicons name="chatbubble-ellipses" size={18} color={colors.accent} />
                  <Text style={{ flex: 1, fontSize: 15, fontWeight: "700", color: colors.text }} numberOfLines={1}>
                    {i.subject}
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
                  <StatusBadge variant={statusVariant(i.status)} label={i.status} />
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>{i.inquiryType}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>{i.userName ?? i.email}</Text>
                  <Text style={{ fontSize: 12, color: colors.textMuted }}>
                    {new Date(i.createdAt).toLocaleString("ja-JP")}
                  </Text>
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
