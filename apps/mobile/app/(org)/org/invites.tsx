import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { Card, Button, SectionHeader, StatusBadge, LoadingState, EmptyState } from "../../../src/components/ui";
import { Input } from "../../../src/components/ui";
import { getApi, getApiBaseUrl } from "../../../src/lib/api";
import { colors, spacing } from "../../../src/theme";

type Invite = {
  id: string;
  email: string;
  role: string;
  departmentName: string | null;
  token: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  isExpired: boolean;
  isAccepted: boolean;
};

export default function OrgInvitesPage() {
  const router = useRouter();
  const [items, setItems] = useState<Invite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const baseUrl = useMemo(() => {
    try {
      return getApiBaseUrl();
    } catch {
      return "";
    }
  }, []);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ invites: Invite[] }>("/api/org/invites");
      setItems(res.invites ?? []);
    } catch (e: any) {
      setError(e?.message ?? "取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createInvite() {
    const e = email.trim();
    if (!e || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      const res = await api.post<{ success: boolean; invite: { inviteUrl: string; expiresAt: string } }>("/api/org/invites", {
        email: e,
        role,
      });
      setEmail("");
      Alert.alert("作成しました", `招待URL:\n${res.invite.inviteUrl}\n期限: ${res.invite.expiresAt}`);
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function remove(inviteId: string) {
    Alert.alert("削除", "この招待を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/org/invites?id=${inviteId}`);
            await load();
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  function getInviteStatus(invite: Invite): { variant: "completed" | "alert" | "pending"; label: string } {
    if (invite.isAccepted) return { variant: "completed", label: "承諾済み" };
    if (invite.isExpired) return { variant: "alert", label: "期限切れ" };
    return { variant: "pending", label: "未承諾" };
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: spacing["4xl"] }}>
      {/* Header */}
      <View style={{ paddingTop: 56, paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Pressable onPress={() => router.push("/org/dashboard")} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text, flex: 1 }}>招待</Text>
        <Pressable onPress={load} hitSlop={8}>
          <Ionicons name="refresh" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <View style={{ paddingHorizontal: spacing.xl, gap: spacing.lg }}>
        {/* Create Form */}
        <Card>
          <SectionHeader title="招待を作成" />
          <View style={{ gap: spacing.md, marginTop: spacing.sm }}>
            <Input value={email} onChangeText={setEmail} placeholder="example@email.com" label="メールアドレス" keyboardType="email-address" autoCapitalize="none" />
            <Input value={role} onChangeText={setRole} placeholder="member / manager / admin" label="ロール" />
            <Button onPress={createInvite} loading={isSubmitting} disabled={isSubmitting}>
              {isSubmitting ? "作成中..." : "招待を作成"}
            </Button>
          </View>
        </Card>

        {/* List */}
        <SectionHeader title="招待一覧" />

        {isLoading ? (
          <LoadingState message="招待を読み込み中..." />
        ) : error ? (
          <Card variant="error">
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={{ fontSize: 14, color: colors.error, flex: 1 }}>{error}</Text>
            </View>
          </Card>
        ) : items.length === 0 ? (
          <EmptyState icon={<Ionicons name="mail-outline" size={40} color={colors.textMuted} />} message="招待がありません。" />
        ) : (
          <View style={{ gap: spacing.md }}>
            {items.map((inv) => {
              const inviteUrl = baseUrl ? `${baseUrl}/invite/${inv.token}` : `(token) ${inv.token}`;
              const status = getInviteStatus(inv);
              return (
                <Card key={inv.id}>
                  <View style={{ gap: spacing.sm }}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1 }}>
                        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.blueLight, alignItems: "center", justifyContent: "center" }}>
                          <Ionicons name="mail" size={18} color={colors.blue} />
                        </View>
                        <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text, flex: 1 }}>{inv.email}</Text>
                      </View>
                      <StatusBadge variant={status.variant} label={status.label} />
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <Ionicons name="shield-checkmark" size={14} color={colors.textMuted} />
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>ロール: {inv.role}</Text>
                    </View>
                    {inv.departmentName ? (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                        <Ionicons name="business" size={14} color={colors.textMuted} />
                        <Text style={{ fontSize: 13, color: colors.textMuted }}>部署: {inv.departmentName}</Text>
                      </View>
                    ) : null}
                    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
                      <Ionicons name="time" size={14} color={colors.textMuted} />
                      <Text style={{ fontSize: 13, color: colors.textMuted }}>期限: {inv.expiresAt}</Text>
                    </View>
                    <Text style={{ fontSize: 11, color: colors.textMuted }} numberOfLines={1} ellipsizeMode="middle">
                      {inviteUrl}
                    </Text>
                    {!inv.isAccepted ? (
                      <View style={{ marginTop: spacing.xs }}>
                        <Button onPress={() => remove(inv.id)} variant="destructive" size="sm">
                          削除
                        </Button>
                      </View>
                    ) : null}
                  </View>
                </Card>
              );
            })}
          </View>
        )}
      </View>
    </ScrollView>
  );
}
