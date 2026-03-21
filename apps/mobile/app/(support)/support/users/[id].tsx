import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Button, Card, EmptyState, Input, LoadingState, SectionHeader, StatCard, StatusBadge } from "../../../../src/components/ui";
import { getApi } from "../../../../src/lib/api";
import { colors, spacing, radius } from "../../../../src/theme";

type SupportUserDetail = {
  user: {
    id: string;
    nickname: string | null;
    ageGroup: string | null;
    gender: string | null;
    roles: string[];
    organizationId: string | null;
    isBanned: boolean;
    bannedAt: string | null;
    bannedReason: string | null;
    lastLoginAt: string | null;
    loginCount: number | null;
    profileCompleteness: number | null;
    createdAt: string;
    updatedAt: string;
  };
  stats: { mealCount: number; aiSessionCount: number };
  inquiries: Array<{ id: string; inquiry_type: string; subject: string; status: string; created_at: string }>;
  notes: Array<{ id: string; note: string; created_at: string; admin_id: string }>;
};

export default function SupportUserDetailPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const apiPath = useMemo(() => `/api/support/users/${id}`, [id]);
  const notesPath = useMemo(() => `/api/support/users/${id}/notes`, [id]);

  const [data, setData] = useState<SupportUserDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [note, setNote] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    if (!id) return;
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<SupportUserDetail>(apiPath);
      setData(res);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function addNote() {
    const n = note.trim();
    if (!n || !id || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post(notesPath, { note: n });
      setNote("");
      await load();
    } catch (e: any) {
      Alert.alert("失敗", e?.message ?? "失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: spacing["4xl"] }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: 56 }}>
        <Pressable onPress={() => router.back()} style={{ padding: spacing.xs }}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text, flex: 1 }}>ユーザー詳細</Text>
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
      ) : !data ? (
        <EmptyState icon={<Ionicons name="person-outline" size={40} color={colors.textMuted} />} message="見つかりませんでした。" />
      ) : (
        <>
          <Card>
            <View style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: data.user.isBanned ? colors.errorLight : colors.accentLight, alignItems: "center", justifyContent: "center" }}>
                  <Ionicons name={data.user.isBanned ? "ban-outline" : "person"} size={24} color={data.user.isBanned ? colors.error : colors.accent} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                    <Text style={{ fontSize: 18, fontWeight: "800", color: colors.text }}>{data.user.nickname ?? "(no name)"}</Text>
                    {data.user.isBanned && <StatusBadge variant="alert" label="BAN" />}
                  </View>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>{data.user.id}</Text>
                </View>
              </View>

              <View style={{ backgroundColor: colors.bg, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs, marginTop: spacing.xs }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>Roles</Text>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight }}>{(data.user.roles ?? []).join(", ")}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>Organization</Text>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight }}>{data.user.organizationId ?? "-"}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>Login count</Text>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight }}>{data.user.loginCount ?? 0}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>Last login</Text>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight }}>{data.user.lastLoginAt ?? "-"}</Text>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 13, color: colors.textMuted }}>Profile</Text>
                  <Text style={{ fontSize: 13, fontWeight: "600", color: colors.textLight }}>{data.user.profileCompleteness ?? 0}%</Text>
                </View>
              </View>
            </View>
          </Card>

          <SectionHeader title="利用状況" />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <StatCard
              icon={<Ionicons name="restaurant-outline" size={22} color={colors.accent} />}
              label="食事記録"
              value={data.stats.mealCount}
              accentColor={colors.accentLight}
            />
            <StatCard
              icon={<Ionicons name="chatbox-ellipses-outline" size={22} color={colors.purple} />}
              label="AIセッション(30d)"
              value={data.stats.aiSessionCount}
              accentColor={colors.purpleLight}
            />
          </View>

          <SectionHeader title="ノート追加" />
          <Card>
            <View style={{ gap: spacing.sm }}>
              <Input
                value={note}
                onChangeText={setNote}
                placeholder="サポートメモ"
                multiline
                style={{ minHeight: 80, textAlignVertical: "top" }}
              />
              <Button onPress={addNote} loading={isSubmitting} disabled={isSubmitting}>
                {isSubmitting ? "追加中..." : "追加"}
              </Button>
            </View>
          </Card>

          <SectionHeader title="既存ノート" />
          {(data.notes ?? []).length === 0 ? (
            <EmptyState icon={<Ionicons name="document-text-outline" size={36} color={colors.textMuted} />} message="ノートがありません。" />
          ) : (
            <View style={{ gap: spacing.sm }}>
              {data.notes.map((n) => (
                <Card key={n.id}>
                  <View style={{ gap: spacing.xs }}>
                    <Text style={{ fontSize: 14, color: colors.text, lineHeight: 20 }}>{n.note}</Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted }}>{new Date(n.created_at).toLocaleString("ja-JP")}</Text>
                  </View>
                </Card>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}
