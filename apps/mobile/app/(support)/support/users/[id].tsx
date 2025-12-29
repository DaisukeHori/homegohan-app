import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../../src/lib/api";

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
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 20, fontWeight: "900" }}>ユーザー</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={{ color: "#666" }}>戻る</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : !data ? (
        <Text style={{ color: "#666" }}>見つかりませんでした。</Text>
      ) : (
        <>
          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>{data.user.nickname ?? "(no name)"}</Text>
            <Text style={{ color: "#666" }}>roles: {(data.user.roles ?? []).join(", ")}</Text>
            <Text style={{ color: "#666" }}>
              org: {data.user.organizationId ?? "-"} / banned: {data.user.isBanned ? "YES" : "NO"}
            </Text>
            <Text style={{ color: "#666" }}>login: {data.user.loginCount ?? 0} / last: {data.user.lastLoginAt ?? "-"}</Text>
            <Text style={{ color: "#666" }}>profile: {data.user.profileCompleteness ?? 0}%</Text>
            <Text style={{ color: "#999" }}>{data.user.id}</Text>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
            <Text style={{ fontWeight: "900" }}>概要</Text>
            <Text>mealCount: {data.stats.mealCount}</Text>
            <Text>aiSessionCount(30d): {data.stats.aiSessionCount}</Text>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>ノート追加</Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="サポートメモ"
              multiline
              style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 80 }}
            />
            <Pressable onPress={addNote} disabled={isSubmitting} style={{ padding: 12, borderRadius: 12, backgroundColor: isSubmitting ? "#999" : "#333", alignItems: "center" }}>
              <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "追加中..." : "追加"}</Text>
            </Pressable>
          </View>

          <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
            <Text style={{ fontWeight: "900" }}>既存ノート</Text>
            {(data.notes ?? []).length === 0 ? (
              <Text style={{ color: "#666" }}>なし</Text>
            ) : (
              data.notes.map((n) => (
                <View key={n.id} style={{ padding: 10, borderWidth: 1, borderColor: "#eee", borderRadius: 10, gap: 4 }}>
                  <Text style={{ color: "#333" }}>{n.note}</Text>
                  <Text style={{ color: "#999" }}>{new Date(n.created_at).toLocaleString("ja-JP")}</Text>
                </View>
              ))
            )}
          </View>
        </>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}



