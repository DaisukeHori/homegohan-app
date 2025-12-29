import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { getApi } from "../../../src/lib/api";

type Dept = {
  id: string;
  name: string;
  memberCount: number;
  displayOrder: number;
};

export default function OrgDepartmentsPage() {
  const [items, setItems] = useState<Dept[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    setIsLoading(true);
    setError(null);
    try {
      const api = getApi();
      const res = await api.get<{ departments: Dept[] }>("/api/org/departments");
      setItems(res.departments ?? []);
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
      await api.post("/api/org/departments", { name: n });
      setName("");
      await load();
    } catch (e: any) {
      Alert.alert("作成失敗", e?.message ?? "作成に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function rename(id: string, current: string) {
    Alert.prompt?.(
      "部署名変更",
      "新しい部署名を入力してください",
      async (text) => {
        const n = (text ?? "").trim();
        if (!n || n === current) return;
        try {
          const api = getApi();
          await api.put("/api/org/departments", { id, name: n });
          await load();
        } catch (e: any) {
          Alert.alert("更新失敗", e?.message ?? "更新に失敗しました。");
        }
      },
      "plain-text",
      current
    );
  }

  async function remove(id: string) {
    Alert.alert("削除", "この部署を削除しますか？", [
      { text: "キャンセル", style: "cancel" },
      {
        text: "削除",
        style: "destructive",
        onPress: async () => {
          try {
            const api = getApi();
            await api.del(`/api/org/departments?id=${id}`);
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
      <Text style={{ fontSize: 20, fontWeight: "900" }}>部署</Text>

      <View style={{ gap: 8 }}>
        <Link href="/org/dashboard">ダッシュボードへ</Link>
      </View>

      <View style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 8 }}>
        <Text style={{ fontWeight: "900" }}>追加</Text>
        <TextInput value={name} onChangeText={setName} placeholder="部署名" style={{ borderWidth: 1, borderColor: "#ddd", padding: 12, borderRadius: 10 }} />
        <Pressable onPress={create} disabled={isSubmitting} style={{ padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: isSubmitting ? "#999" : "#333" }}>
          <Text style={{ color: "white", fontWeight: "900" }}>{isSubmitting ? "追加中..." : "追加"}</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={{ paddingTop: 12 }}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={{ color: "#c00" }}>{error}</Text>
      ) : items.length === 0 ? (
        <Text style={{ color: "#666" }}>部署がありません。</Text>
      ) : (
        <View style={{ gap: 10 }}>
          {items.map((d) => (
            <View key={d.id} style={{ padding: 12, borderWidth: 1, borderColor: "#eee", borderRadius: 12, backgroundColor: "white", gap: 6 }}>
              <Text style={{ fontWeight: "900" }}>
                {d.name}（{d.memberCount}人）
              </Text>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable onPress={() => rename(d.id, d.name)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#333" }}>
                  <Text style={{ color: "white", fontWeight: "900" }}>変更</Text>
                </Pressable>
                <Pressable onPress={() => remove(d.id)} style={{ paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10, backgroundColor: "#c00" }}>
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


