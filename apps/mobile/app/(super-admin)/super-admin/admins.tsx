import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, EmptyState, LoadingState } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { getApiErrorMessage } from "../../../src/lib/api-error";
import { colors, spacing, radius } from "../../../src/theme";

type AdminRow = {
  id: string;
  nickname: string | null;
  roles: string[];
  organizationId: string | null;
  lastLoginAt: string | null;
  recentActionCount: number;
};

// #1235: 'org_admin' は付与しない。組織の管理者は所属組織の org_role (招待で owner / admin) で決まる
const ROLE_OPTIONS = ["admin", "support", "super_admin"] as const;

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
    } catch (e) {
      setError(getApiErrorMessage(e, "取得に失敗しました。"));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // #1137: ロールの変更は PUT /api/admin/users/{id}/role (super_admin 専用。自分自身の変更はサーバーが拒否する)。
  // 以前呼んでいた PUT /api/super-admin/admins/{id} はサーバーに無く、常に失敗していた。
  async function toggleRole(userId: string, currentRoles: string[], role: string) {
    const next = currentRoles.includes(role) ? currentRoles.filter((r) => r !== role) : [...currentRoles, role];
    const roles = Array.from(new Set([...next, "user"]));
    try {
      const api = getApi();
      await api.put(`/api/admin/users/${userId}/role`, { roles });
      await load();
    } catch (e) {
      Alert.alert("更新失敗", getApiErrorMessage(e, "更新に失敗しました。"));
    }
  }

  // ロールの付与・剥奪は権限の変更なので、押し間違いで実行されないよう確認を挟む
  function confirmToggleRole(admin: AdminRow, role: string) {
    const currentRoles = admin.roles ?? [];
    const granting = !currentRoles.includes(role);
    Alert.alert(
      granting ? "ロールを付与" : "ロールを剥奪",
      `${admin.nickname ?? admin.id} に ${role} ロールを${granting ? "付与" : "剥奪"}します。よろしいですか？`,
      [
        { text: "キャンセル", style: "cancel" },
        {
          text: granting ? "付与する" : "剥奪する",
          style: granting ? "default" : "destructive",
          onPress: () => toggleRole(admin.id, currentRoles, role),
        },
      ],
    );
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
            <Card key={a.id} testID={`admin-row-${a.id}`}>
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
                        testID={`admin-role-${a.id}-${r}`}
                        onPress={() => confirmToggleRole(a, r)}
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
