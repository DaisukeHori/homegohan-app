import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, LoadingState, StatusBadge } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { colors, spacing, radius } from "../../../src/theme";

export default function SuperAdminFeatureFlagsPage() {
  const [flags, setFlags] = useState<Record<string, any> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ flags: Record<string, any> }>("/api/super-admin/feature-flags");
      setFlags(res.flags ?? {});
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!flags || isSaving) return;
    setIsSaving(true);
    try {
      const api = getApi();
      await api.put("/api/super-admin/feature-flags", { flags });
      Alert.alert("保存しました", "機能フラグを更新しました。");
      await load();
    } catch (e: any) {
      Alert.alert("保存失敗", e?.message ?? "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }

  function toggle(key: string) {
    setFlags((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: !prev[key] };
    });
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 56 }}>
        <Pressable onPress={() => router.back()} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text, flex: 1 }}>機能フラグ</Text>
        <Pressable onPress={load} style={{ padding: spacing.sm }}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <Button onPress={save} loading={isSaving} disabled={isSaving || !flags}>
        {isSaving ? "保存中..." : "変更を保存"}
      </Button>

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : !flags ? (
        <EmptyState icon={<Ionicons name="flag-outline" size={40} color={colors.textMuted} />} message="データがありません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {Object.keys(flags).sort().map((k) => (
            <Card key={k}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: flags[k] ? colors.successLight : colors.bg, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: flags[k] ? "#C8E6C9" : colors.border }}>
                  <Ionicons name={flags[k] ? "checkmark" : "close"} size={20} color={flags[k] ? colors.success : colors.textMuted} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{k}</Text>
                  <StatusBadge variant={flags[k] ? "completed" : "pending"} label={flags[k] ? "ON" : "OFF"} />
                </View>
                <Pressable
                  onPress={() => toggle(k)}
                  style={{
                    paddingVertical: spacing.sm,
                    paddingHorizontal: spacing.lg,
                    borderRadius: radius.full,
                    backgroundColor: flags[k] ? colors.accent : colors.bg,
                    borderWidth: 1,
                    borderColor: flags[k] ? colors.accent : colors.border,
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "700", color: flags[k] ? "#FFFFFF" : colors.textLight }}>
                    {flags[k] ? "ON" : "OFF"}
                  </Text>
                </Pressable>
              </View>
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
