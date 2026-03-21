import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState } from "../../../../src/components/ui";
import { Input } from "../../../../src/components/ui";
import { ChipSelector } from "../../../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../../../src/theme";
import { getApi } from "../../../../src/lib/api";

type Inquiry = {
  id: string;
  userId: string | null;
  userName: string | null;
  inquiryType: string;
  email: string;
  subject: string;
  message: string;
  status: string;
  adminNotes: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
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

export default function AdminInquiryDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const apiPath = useMemo(() => `/api/admin/inquiries/${id}`, [id]);

  const [inquiry, setInquiry] = useState<Inquiry | null>(null);
  const [adminNotes, setAdminNotes] = useState("");
  const [status, setStatus] = useState("pending");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ inquiry: Inquiry }>(apiPath);
      setInquiry(res.inquiry);
      setAdminNotes(res.inquiry.adminNotes ?? "");
      setStatus(res.inquiry.status ?? "pending");
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function save() {
    if (!id || isSaving) return;
    setIsSaving(true);
    try {
      const api = getApi();
      await api.patch(apiPath, { status, adminNotes });
      Alert.alert("保存しました", "更新しました。");
      await load();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: 56, paddingHorizontal: spacing.lg, paddingBottom: spacing["3xl"], gap: spacing.lg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ flex: 1, fontSize: 22, fontWeight: "800", color: colors.text }} numberOfLines={1}>
          Inquiry Detail
        </Text>
      </View>

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
          </View>
          <Button onPress={load} variant="outline" size="sm" style={{ marginTop: spacing.md }}>
            再試行
          </Button>
        </Card>
      ) : !inquiry ? (
        <EmptyState icon={<Ionicons name="search-outline" size={40} color={colors.textMuted} />} message="見つかりませんでした。" />
      ) : (
        <>
          {/* Inquiry Detail */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                <Ionicons name="chatbubble-ellipses" size={20} color={colors.accent} />
                <Text style={{ flex: 1, fontSize: 17, fontWeight: "800", color: colors.text }}>{inquiry.subject}</Text>
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
                <StatusBadge variant={statusVariant(inquiry.status)} label={inquiry.status} />
                <Text style={{ fontSize: 12, color: colors.textMuted }}>{inquiry.inquiryType}</Text>
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                <Ionicons name="person" size={14} color={colors.textMuted} />
                <Text style={{ fontSize: 13, color: colors.textMuted }}>{inquiry.userName ?? inquiry.email}</Text>
              </View>

              <View style={{ backgroundColor: colors.bg, borderRadius: radius.md, padding: spacing.md }}>
                <Text style={{ fontSize: 14, color: colors.textLight, lineHeight: 22 }}>{inquiry.message}</Text>
              </View>

              <Text style={{ fontSize: 12, color: colors.textMuted }}>
                {new Date(inquiry.createdAt).toLocaleString("ja-JP")}
              </Text>
            </View>
          </Card>

          {/* Update Form */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <SectionHeader title="ステータス更新" />

              <ChipSelector
                options={STATUS_OPTIONS}
                selected={status}
                onSelect={setStatus}
              />

              <Input
                label="管理メモ"
                value={adminNotes}
                onChangeText={setAdminNotes}
                placeholder="管理メモを入力..."
                multiline
                style={{ minHeight: 100, textAlignVertical: "top" }}
              />

              <Button onPress={save} loading={isSaving} disabled={isSaving}>
                {isSaving ? "保存中..." : "保存"}
              </Button>
            </View>
          </Card>
        </>
      )}
    </ScrollView>
  );
}
