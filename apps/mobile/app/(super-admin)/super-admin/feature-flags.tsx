import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, EmptyState, LoadingState, StatusBadge } from "../../../src/components/ui";
import { getApi } from "../../../src/lib/api";
import { getApiErrorMessage } from "../../../src/lib/api-error";
import { parseFeatureFlagsResponse, type SuperAdminFeatureFlag } from "../../../src/lib/super-admin-flags";
import { colors, spacing, radius } from "../../../src/theme";

// #1137: Web の運営画面 (src/app/super-admin/flags) と同じ API を使う。
//   一覧: GET   /api/super-admin/flags              -> { data: [{ key, description, enabled, ... }], meta }
//   更新: PATCH /api/super-admin/flags/{key} { enabled } -> { data: { ... } } / 失敗は { error: { code, message } }
// モバイルでは ON/OFF の切り替えだけを扱う。段階公開 (rollout_strategy) と対象条件 (constraints) の編集、
// フラグの作成・削除は Web の管理画面で行う。
export default function SuperAdminFeatureFlagsPage() {
  const [flags, setFlags] = useState<SuperAdminFeatureFlag[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 更新リクエストの実行中のキー。同じフラグの二重送信を防ぎ、その間はボタンを押せなくする。
  // 二重送信の判定は、再描画を待たずに見られる ref で行う (state は表示用)
  const updatingRef = useRef<Set<string>>(new Set());
  const [updatingKeys, setUpdatingKeys] = useState<string[]>([]);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<unknown>("/api/super-admin/flags");
      setFlags(parseFeatureFlagsResponse(res));
    } catch (e) {
      setError(getApiErrorMessage(e, "取得に失敗しました。"));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function setUpdating(key: string, updating: boolean) {
    if (updating) updatingRef.current.add(key);
    else updatingRef.current.delete(key);
    setUpdatingKeys([...updatingRef.current]);
  }

  function setFlagEnabled(key: string, enabled: boolean) {
    setFlags((prev) => (prev ? prev.map((f) => (f.key === key ? { ...f, enabled } : f)) : prev));
  }

  async function toggle(flag: SuperAdminFeatureFlag) {
    if (updatingRef.current.has(flag.key)) return;
    const next = !flag.enabled;

    // 楽観更新: 先に表示を切り替え、失敗したら元に戻す
    setUpdating(flag.key, true);
    setFlagEnabled(flag.key, next);
    try {
      const api = getApi();
      const res = await api.patch<{ data?: { enabled?: unknown } } | null>(
        `/api/super-admin/flags/${encodeURIComponent(flag.key)}`,
        { enabled: next },
      );
      // サーバーが保存した値に合わせる (応答に無ければ、送った値のまま)
      const saved = res?.data?.enabled;
      if (typeof saved === "boolean" && saved !== next) setFlagEnabled(flag.key, saved);
    } catch (e) {
      setFlagEnabled(flag.key, flag.enabled);
      Alert.alert("更新失敗", getApiErrorMessage(e, "機能フラグの更新に失敗しました。"));
    } finally {
      setUpdating(flag.key, false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 56 }}>
        <Pressable onPress={() => router.back()} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text, flex: 1 }}>機能フラグ</Text>
        <Pressable testID="feature-flags-refresh" accessibilityLabel="再読み込み" onPress={load} style={{ padding: spacing.sm }}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <Text style={{ fontSize: 12, lineHeight: 18, color: colors.textMuted }}>
        ON / OFF ボタンを押すと、すぐ保存されます。段階公開や対象条件の編集、フラグの作成・削除は、Web の管理画面 (/super-admin/flags) で行ってください。
      </Text>

      {isLoading ? (
        <LoadingState message="読み込み中..." />
      ) : error ? (
        <Card variant="error">
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={{ color: colors.error, fontSize: 14, flex: 1 }}>{error}</Text>
          </View>
        </Card>
      ) : !flags || flags.length === 0 ? (
        <EmptyState icon={<Ionicons name="flag-outline" size={40} color={colors.textMuted} />} message="機能フラグがありません。" />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {flags.map((flag) => {
            const updating = updatingKeys.includes(flag.key);
            return (
              <Card key={flag.key} testID={`feature-flag-row-${flag.key}`}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                  <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: flag.enabled ? colors.successLight : colors.bg, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: flag.enabled ? "#C8E6C9" : colors.border }}>
                    <Ionicons name={flag.enabled ? "checkmark" : "close"} size={20} color={flag.enabled ? colors.success : colors.textMuted} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{flag.key}</Text>
                    {flag.description ? (
                      <Text style={{ fontSize: 12, color: colors.textMuted }}>{flag.description}</Text>
                    ) : null}
                    <StatusBadge variant={flag.enabled ? "completed" : "pending"} label={flag.enabled ? "ON" : "OFF"} />
                  </View>
                  <Pressable
                    testID={`feature-flag-toggle-${flag.key}`}
                    accessibilityRole="switch"
                    accessibilityLabel={flag.key}
                    accessibilityState={{ checked: flag.enabled, disabled: updating }}
                    disabled={updating}
                    onPress={() => toggle(flag)}
                    style={{
                      paddingVertical: spacing.sm,
                      paddingHorizontal: spacing.lg,
                      borderRadius: radius.full,
                      backgroundColor: flag.enabled ? colors.accent : colors.bg,
                      borderWidth: 1,
                      borderColor: flag.enabled ? colors.accent : colors.border,
                      opacity: updating ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "700", color: flag.enabled ? "#FFFFFF" : colors.textLight }}>
                      {flag.enabled ? "ON" : "OFF"}
                    </Text>
                  </Pressable>
                </View>
              </Card>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
