import { Link } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi, getApiBaseUrl } from "../../../src/lib/api";

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

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>招待</Text>

      <View style={{ gap: 8 }}>
        <Link href="/org/dashboard">ダッシュボードへ</Link>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>招待作成</Text>
        <TextInput value={email} onChangeText={setEmail} placeholder="email" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput value={role} onChangeText={setRole} placeholder="role（member/manager/admin）" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <Pressable onPress={createInvite} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "作成中..." : "作成"}</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>招待がありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((i) => {
            const inviteUrl = baseUrl ? `${baseUrl}/invite/${i.token}` : `(token) ${i.token}`;
            return (
              <View key={i.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 4 }}>
                <Text style={{ fontWeight: "900" }}>{i.email}</Text>
                <Text style={{ color: "#666" }}>
                  role: {i.role} / dept: {i.departmentName ?? "-"}
                </Text>
                <Text style={{ color: "#666" }}>
                  期限: {i.expiresAt} {i.isExpired ? "（期限切れ）" : ""} {i.isAccepted ? "（承諾済み）" : ""}
                </Text>
                <Text style={{ color: "#999" }}>{inviteUrl}</Text>
                <Pressable onPress={() => remove(i.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00", alignSelf: "flex-start", marginTop: 6 }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


