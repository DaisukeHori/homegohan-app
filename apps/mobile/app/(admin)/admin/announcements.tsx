import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type Announcement = {
  id: string;
  title: string;
  content: string;
  category: string;
  priority: number;
  targetAudience: string;
  isPublic: boolean;
  publishedAt: string | null;
  createdAt: string;
};

export default function AdminAnnouncementsPage() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ announcements: Announcement[] }>("/api/admin/announcements?include_unpublished=true");
      setItems(res.announcements ?? []);
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
    const t = title.trim();
    const c = content.trim();
    if (!t || !c || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const api = getApi();
      await api.post("/api/admin/announcements", { title: t, content: c, isPublic });
      setTitle("");
      setContent("");
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function remove(id: string) {
    Alert.alert("削除", "このお知らせを削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/admin/announcements/${id}`);
            await load();
          } catch (e: any) {
            Alert.alert("削除失敗", e?.message ?? "削除に失敗しました。");
          }
        },
      },
    ]);
  }

  async function togglePublic(a: Announcement) {
    try {
      const api = getApi();
      await api.put(`/api/admin/announcements/${a.id}`, { isPublic: !a.isPublic });
      await load();
    } catch (e: any) {
      Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "900" }}>Announcements</Text>
      <Link href="/admin">Admin Home</Link>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>作成</Text>
        <TextInput value={title} onChangeText={setTitle} placeholder="タイトル" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <TextInput
          value={content}
          onChangeText={setContent}
          placeholder="内容"
          multiline
          style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10, minHeight: 120 }}
        />
        <Pressable onPress={() => setIsPublic((v) => !v)} style={{ padding: 12, borderRadius: 12, backgroundColor: isPublic ? "#E07A5F" : "#333", alignItems: "center" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isPublic ? "公開: ON" : "公開: OFF"}</Text>
        </Pressable>
        <Pressable onPress={create} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
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
        <Text style={{ color: "#666" }}>お知らせがありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((a) => (
            <View key={a.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>
                {a.title} {a.isPublic ? "" : "（非公開）"}
              </Text>
              <Text style={{ color: "#666" }}>{a.content.substring(0, 120)}{a.content.length > 120 ? "..." : ""}</Text>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable onPress={() => togglePublic(a)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>{a.isPublic ? "非公開にする" : "公開にする"}</Text>
                </Pressable>
                <Pressable onPress={() => remove(a.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>削除</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}

      <Pressable onPress={load} style={{ alignItems: "center", marginTop: 8 }}>
        <Text style={{ color: "#666" }}>更新</Text>
      </Pressable>
    </ScrollView>
  );
}


