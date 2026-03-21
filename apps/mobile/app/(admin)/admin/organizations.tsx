import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { colors, spacing, radius, shadows } from "../../../src/theme";
import { getApi } from "../../../src/lib/api";

type OrgRow = {
  id: string;
  name: string;
  plan: string | null;
  industry: string | null;
  employeeCount: number | null;
  subscriptionStatus: string | null;
  contactEmail: string | null;
  memberCount: number;
  createdAt: string;
};

function subscriptionVariant(s: string | null): "completed" | "pending" | "alert" | "info" {
  switch (s) {
    case "active":
      return "completed";
    case "trial":
    case "trialing":
      return "info";
    case "canceled":
    case "cancelled":
      return "alert";
    default:
      return "pending";
  }
}

export default function AdminOrganizationsPage() {
  const [items, setItems] = useState<OrgRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ organizations: OrgRow[] }>("/api/admin/organizations?limit=50");
      setItems(res.organizations ?? []);
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
    const n = name.trim();
    if (!n || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/admin/organizations", { name: n });
      setName("");
      Alert.alert("作成しました", "組織を作成しました。");
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: 56, paddingHorizontal: spacing.lg, paddingBottom: spacing["3xl"], gap: spacing.lg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text }}>Organizations</Text>
        </View>
        <Pressable onPress={load} hitSlop={8}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      {/* Create Form */}
      <Card>
        <View style={{ gap: spacing.md }}>
          <SectionHeader title="新規作成" />
          <Input value={name} onChangeText={setName} placeholder="組織名" />
          <Button onPress={create} loading={isSubmitting} disabled={isSubmitting}>
            {isSubmitting ? "作成中..." : "作成"}
          </Button>
        </View>
      </Card>

      {/* List */}
      <SectionHeader title="一覧" />

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
        <EmptyState icon={<Ionicons name="business-outline" size={40} color={colors.textMuted} />} message="組織がありません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((o) => (
            <Card key={o.id}>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                  <View style={{ width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.successLight, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="business" size={20} color={colors.success} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{o.name}</Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>{o.id}</Text>
                  </View>
                  <StatusBadge variant={subscriptionVariant(o.subscriptionStatus)} label={o.subscriptionStatus ?? "-"} />
                </View>

                <View style={{ flexDirection: "row", gap: spacing.lg, paddingLeft: 52 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="people" size={14} color={colors.textMuted} />
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>{o.memberCount}</Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                    <Ionicons name="pricetag" size={14} color={colors.textMuted} />
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>{o.plan ?? "-"}</Text>
                  </View>
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
