import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, EmptyState, LoadingState, SectionHeader, StatusBadge } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing, radius } from "../../../src/theme";

type AdminRow = {
  id: string;
  nickname: string | null;
  roles: string[];
  organizationId: string | null;
  lastLoginAt: string | null;
  recentActionCount: number;
};

const ROLE_OPTIONS = ["admin", "support", "org_admin", "super_admin"] as const;

export default function SuperAdminAdminsPage() {
  const [items, setItems] = useState<AdminRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ admins: AdminRow[] }>("/api/super-admin/admins");
      setItems(res.admins ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleRole(userId: string, currentRoles: string[], role: string) {
    const next = currentRoles.includes(role) ? currentRoles.filter((r) => r !== role) : [...currentRoles, role];
    const roles = Array.from(new Set([...next, "user"]));
    try {
      const api = getApi();
      await api.put(`/api/super-admin/admins/${userId}`, { roles });
      await load();
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 56 }}>
        <Pressable onPress={() => router.back()} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text, flex: 1 }}>管理者管理</Text>
        <Pressable onPress={load} style={{ padding: spacing.sm }}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
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
      ) : items.length === 0 ? (
        <EmptyState icon={<Ionicons name="shield-outline" size={40} color={colors.textMuted} />} message="管理者がいません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((a) => (
            <Card key={a.id}>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                  <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.purpleLight, alignItems: "center", justifyContent: "center" }}>
                    <Ionicons name="shield-checkmark-outline" size={20} color={colors.purple} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{a.nickname ?? "(no name)"}</Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>{a.id}</Text>
                  </View>
                </View>

                <View style={{ backgroundColor: colors.bg, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>Roles</Text>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight }}>{(a.roles ?? []).join(", ")}</Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ fontSize: 13, color: colors.textMuted }}>Recent actions (7d)</Text>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight }}>{a.recentActionCount}</Text>
                  </View>
                </View>

                <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
                  {ROLE_OPTIONS.map((r) => {
                    const active = (a.roles ?? []).includes(r);
                    return (
                      <Pressable
                        key={r}
                        onPress={() => toggleRole(a.id, a.roles ?? [], r)}
                        style={{
                          paddingVertical: spacing.sm,
                          paddingHorizontal: spacing.md,
                          borderRadius: radius.full,
                          backgroundColor: active ? colors.accent : colors.bg,
                          borderWidth: 1,
                          borderColor: active ? colors.accent : colors.border,
                        }}
                      >
                        <Text style={{ fontSize: 13, fontWeight: "700", color: active ? "#FFFFFF" : colors.textLight }}>{r}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
