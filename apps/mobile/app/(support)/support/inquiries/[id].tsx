import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, ChipSelector, EmptyState, Input, LoadingState, SectionHeader, StatusBadge } from "../../../../src/components/ui";
import { getApi } from "../../../../src/lib/api";
import { colors, spacing, radius } from "../../../../src/theme";

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

const STATUS_BADGE_MAP: Record<string, "pending" | "generating" | "completed" | "info"> = {
  pending: "pending",
  in_progress: "generating",
  resolved: "completed",
  closed: "info",
};

export default function SupportInquiryDetailPage() {
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
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 56 }}>
        <Pressable onPress={() => router.back()} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text, flex: 1 }}>問い合わせ詳細</Text>
      </View>

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : !inquiry ? (
        <EmptyState icon={<Ionicons name="document-outline" size={40} color={colors.textMuted} />} message="見つかりませんでした。" />
      ) : (
        <>
          <Card>
            <View style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ fontSize: 17, fontWeight: "800", color: colors.text, flex: 1 }}>{inquiry.subject}</Text>
                <StatusBadge variant={STATUS_BADGE_MAP[inquiry.status] ?? "pending"} label={inquiry.status} />
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                <Ionicons name="pricetag-outline" size={14} color={colors.textMuted} />
                <Text style={{ fontSize: 13, color: colors.textLight }}>{inquiry.inquiryType}</Text>
                <Text style={{ fontSize: 13, color: colors.textMuted }}>-</Text>
                <Ionicons name="person-outline" size={14} color={colors.textMuted} />
                <Text style={{ fontSize: 13, color: colors.textLight }}>{inquiry.userName ?? inquiry.email}</Text>
              </View>
              <View style={{ backgroundColor: colors.bg, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.xs }}>
                <Text style={{ fontSize: 14, color: colors.text, lineHeight: 22 }}>{inquiry.message}</Text>
              </View>
              <Text style={{ fontSize: 12, color: colors.textMuted }}>
                作成: {new Date(inquiry.createdAt).toLocaleString("ja-JP")}
                {inquiry.resolvedAt ? ` / 解決: ${new Date(inquiry.resolvedAt).toLocaleString("ja-JP")}` : ""}
              </Text>
            </View>
          </Card>

          <SectionHeader title="ステータス更新" />
          <Card>
            <View style={{ gap: spacing.md }}>
              <ChipSelector
                options={STATUS_OPTIONS}
                selected={status}
                onSelect={setStatus}
              />
              <Input
                label="管理メモ"
                value={adminNotes}
                onChangeText={setAdminNotes}
                placeholder="管理メモを入力"
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
